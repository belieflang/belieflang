import {
  readFile,
  rename,
  writeFile,
  mkdir,
  open,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  estimateCost,
  estimateLunaCost,
  readResponse,
  readUsage,
  type Rates,
  type Inference,
  type InferenceRequest,
  type InferenceResult,
} from "./v3_inference.js";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function atomicJson(path: string, value: unknown) {
  await atomicFile(path, JSON.stringify(value, null, 2) + "\n");
}
export async function atomicFile(path: string, value: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, value);
  await rename(`${path}.tmp`, path);
}
export type LiveConfig = {
  model: "gpt-6-luna";
  repetitions: number;
  maxOutputTokens: number;
  inputTokenCeiling: number;
  timeoutMs: number;
};
export type LedgerEntry = {
  id: string;
  requestHash: string;
  reserved: number;
  state: "pending" | "complete";
  result?: InferenceResult;
};
type Journal = {
  version: 1;
  fingerprint: string;
  config: LiveConfig;
  rates: Rates;
  cap: number;
  entries: LedgerEntry[];
};
export class BudgetExhausted extends Error {}
export function validateLiveConfig(config: LiveConfig, injectedMock = false) {
  if (
    !config ||
    config.model !== "gpt-6-luna" ||
    !Number.isSafeInteger(config.repetitions) ||
    config.repetitions < 1 ||
    config.repetitions > 20 ||
    !Number.isSafeInteger(config.maxOutputTokens) ||
    config.maxOutputTokens < 1 ||
    config.maxOutputTokens > 128_000 ||
    !Number.isSafeInteger(config.inputTokenCeiling) ||
    config.inputTokenCeiling < (injectedMock ? 8192 : 1_050_000) ||
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 1
  )
    throw new Error("invalid live configuration or Luna token ceiling");
}
export function validateLiveBudget(rates: Rates, cap: number) {
  estimateCost({ input: 0, output: 0, cached: 0, cacheWrite: 0 }, rates);
  if (
    !Number.isFinite(cap) ||
    cap <= 0 ||
    rates.input <= 0 ||
    rates.output <= 0
  )
    throw new Error("explicit positive cap and input/output prices required");
}
/** No retries, no dotenv, no key lookup. The caller must explicitly supply credentials and a frozen run identity. */
export async function createLiveInference(options: {
  apiKey: string;
  config: LiveConfig;
  rates: Rates;
  cap: number;
  fingerprint: string;
  journalPath: string;
  fetchImpl?: typeof fetch;
}) {
  const { config, rates, cap } = options;
  validateLiveConfig(config, !!options.fetchImpl);
  validateLiveBudget(rates, cap);
  if (!options.apiKey) throw new Error("explicit API credential required");
  await mkdir(dirname(options.journalPath), { recursive: true });
  // A second process must not race the budget or overwrite a pending reservation.
  const lock = await open(`${options.journalPath}.lock`, "wx");
  let journal: Journal;
  const fingerprint = hash(
    JSON.stringify({ evaluation: options.fingerprint, config, rates, cap }),
  );
  try {
    try {
      journal = JSON.parse(await readFile(options.journalPath, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      journal = { version: 1, fingerprint, config, rates, cap, entries: [] };
    }
    if (
      journal.version !== 1 ||
      journal.fingerprint !== fingerprint ||
      !Array.isArray(journal.entries)
    )
      throw new Error("checkpoint configuration/source/fixture mismatch");
    const ids = new Set<string>();
    for (const e of journal.entries) {
      if (
        !e ||
        typeof e.id !== "string" ||
        ids.has(e.id) ||
        typeof e.requestHash !== "string" ||
        !Number.isFinite(e.reserved) ||
        e.reserved < 0 ||
        !["pending", "complete"].includes(e.state) ||
        (e.state === "complete" &&
          (!e.result ||
            e.result.estimatedCost === null ||
            !Number.isFinite(e.result.estimatedCost) ||
            e.result.estimatedCost < 0))
      )
        throw new Error("invalid checkpoint ledger");
      ids.add(e.id);
      if (
        e.result?.usage &&
        (e.result.usage.input > config.inputTokenCeiling ||
          e.result.usage.output > config.maxOutputTokens)
      )
        throw new Error(
          "checkpoint contains a provider bound violation; reconcile before a new authorization",
        );
      if (e.state === "pending") {
        e.state = "complete";
        e.result = {
          error:
            "interrupted request: billing unknown; full reservation retained; not retried",
          usage: null,
          estimatedCost: e.reserved,
          latencyMs: 0,
        };
      }
    }
    await atomicJson(options.journalPath, journal);
  } catch (e) {
    await lock.close();
    await unlink(`${options.journalPath}.lock`);
    throw e;
  }
  let busy = false,
    halted = false,
    closed = false;
  const committed = () =>
    journal.entries.reduce(
      (s, e) => s + (e.result?.estimatedCost ?? e.reserved),
      0,
    );
  const infer: Inference = async (
    request: InferenceRequest,
    _oracle: unknown,
  ) => {
    if (closed || busy || halted)
      throw new Error("live runner is closed or already processing a call");
    busy = true;
    try {
      const body = JSON.stringify({
        model: config.model,
        reasoning: { effort: "none" },
        service_tier: "default",
        store: false,
        max_output_tokens: config.maxOutputTokens,
        input: request.prompt,
        text: {
          format: {
            type: "json_schema",
            name: "v3_benchmark",
            strict: true,
            schema: request.schema,
          },
        },
      });
      const requestHash = hash(body),
        previous = journal.entries.find((e) => e.id === request.id);
      if (previous) {
        if (previous.requestHash !== requestHash)
          throw new Error("checkpoint request mismatch");
        return { ...previous.result!, replayed: true };
      }
      // Reserve the entire configured input ceiling, at the highest possible input/cache rate.
      // Byte check leaves framing room; no provider-managed history, images, tools or automatic retries.
      if (
        Buffer.byteLength(body) + 8192 >
        Math.min(config.inputTokenCeiling, 272_000)
      )
        throw new Error("request exceeds conservative short-context bound");
      const longContext = config.inputTokenCeiling > 272_000;
      const reserved =
        (config.inputTokenCeiling *
          Math.max(rates.input, rates.cached, rates.cacheWrite) *
          (longContext ? 2 : 1) +
          config.maxOutputTokens * rates.output * (longContext ? 1.5 : 1)) /
        1e6;
      if (committed() + reserved > cap + 1e-12)
        throw new BudgetExhausted(
          `hard local cap: ${committed().toFixed(6)} committed + ${reserved.toFixed(6)} reserve exceeds ${cap}`,
        );
      const entry: LedgerEntry = {
        id: request.id,
        requestHash,
        reserved,
        state: "pending",
      };
      journal.entries.push(entry);
      await atomicJson(options.journalPath, journal); // Persist BEFORE dispatch; crash/timeout never frees unknown spend.
      const start = performance.now();
      let result: InferenceResult = {
        usage: null,
        estimatedCost: reserved,
        latencyMs: 0,
      };
      try {
        const response = await (options.fetchImpl ?? fetch)(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            signal: AbortSignal.timeout(config.timeoutMs),
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
            },
            body,
          },
        );
        const data = await response.json();
        // Capture usage even for HTTP errors, incomplete responses and invalid structured output.
        const usage = readUsage(data);
        if (usage) {
          result.usage = usage;
          result.estimatedCost = estimateLunaCost(usage, rates);
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!usage)
          throw new Error("missing/invalid usage: reservation retained");
        if (
          usage.input > config.inputTokenCeiling ||
          usage.output > config.maxOutputTokens
        )
          throw new Error(
            "provider exceeded configured accounting bound; stop and reconcile ledger",
          );
        result.output = readResponse(data);
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e);
      }
      result.latencyMs = performance.now() - start;
      entry.state = "complete";
      entry.result = result;
      await atomicJson(options.journalPath, journal);
      if (
        result.usage &&
        (result.usage.input > config.inputTokenCeiling ||
          result.usage.output > config.maxOutputTokens)
      ) {
        halted = true;
        throw new BudgetExhausted(
          "provider exceeded accounting bounds; ledger saved, reconcile before continuing",
        );
      }
      if (committed() > cap + 1e-12)
        throw new BudgetExhausted(
          "provider-reported spend exceeded cap assumptions; stop and reconcile ledger",
        );
      return result;
    } finally {
      busy = false;
    }
  };
  return {
    infer,
    accounting: () => ({
      entries: structuredClone(journal.entries),
      estimatedCostOrUpperBound: committed(),
      unmeteredCalls: journal.entries.filter((e) => !e.result?.usage).length,
      cap,
    }),
    close: async () => {
      closed = true;
      await lock.close();
      await unlink(`${options.journalPath}.lock`);
    },
  };
}
