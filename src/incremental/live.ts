import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicJson, hash } from "../v3_live.js";
import { readResponse } from "../v3_inference.js";
import type { Inference, Request, Result, Usage } from "./types.js";
export type Config = {
  version: number;
  base: string;
  model: string;
  repetitions: number;
  methods: string[];
  schedules: string[];
  maxOutputTokens: number;
  inputTokenCeiling: number;
  timeoutMs: number;
  automaticRetries: number;
  maximumCombinedUSD: number;
  smokeCapUSD: number;
  pilotCapUSD: number;
  smokeMaxOutputTokens: number;
  pricing: {
    observedOn: string;
    source: string;
    standardPerMillion: {
      input: number;
      cached: number;
      cacheWrite: number;
      output: number;
    };
    premiumMultiplier: number;
    longContextThreshold: number;
    longInputMultiplier: number;
    longOutputMultiplier: number;
  };
};
export function usageOf(data: any): Usage | null {
  if (!data?.usage) return null;
  const u = data.usage,
    detail = u.input_tokens_details ?? {},
    out = u.output_tokens_details ?? {};
  const optional = (obj: any, k: string) =>
    Object.hasOwn(obj, k) ? obj[k] : null;
  const usage: Usage = {
    input: u.input_tokens,
    output: u.output_tokens,
    cached: optional(detail, "cached_tokens"),
    cacheWrite: optional(detail, "cache_write_tokens"),
    reasoning: optional(out, "reasoning_tokens"),
  };
  for (const [k, v] of Object.entries(usage))
    if (
      (k === "input" || k === "output" || v !== null) &&
      (!Number.isSafeInteger(v) || v! < 0)
    )
      throw new Error("invalid token accounting");
  if (
    (usage.cached ?? 0) + (usage.cacheWrite ?? 0) > usage.input ||
    (usage.reasoning ?? 0) > usage.output
  )
    throw new Error("invalid token subdivisions");
  return usage;
}
export function costBounds(u: Usage, c: Config) {
  const p = c.pricing,
    r = p.standardPerMillion,
    long = u.input > p.longContextThreshold;
  const fixed = (u.cached ?? 0) * r.cached + (u.cacheWrite ?? 0) * r.cacheWrite;
  const remaining = u.input - (u.cached ?? 0) - (u.cacheWrite ?? 0);
  const possible = [
    r.input,
    ...(u.cached === null ? [r.cached] : []),
    ...(u.cacheWrite === null ? [r.cacheWrite] : []),
  ];
  const multiplier = p.premiumMultiplier / 1e6;
  const output = u.output * r.output * (long ? p.longOutputMultiplier : 1);
  return {
    lower:
      ((fixed + remaining * Math.min(...possible)) *
        (long ? p.longInputMultiplier : 1) +
        output) *
      multiplier,
    upper:
      ((fixed + remaining * Math.max(...possible)) *
        (long ? p.longInputMultiplier : 1) +
        output) *
      multiplier,
  };
}
export function reserve(c: Config, maxOutput: number) {
  const p = c.pricing,
    r = p.standardPerMillion,
    long = c.inputTokenCeiling > p.longContextThreshold;
  return (
    ((c.inputTokenCeiling *
      Math.max(r.input, r.cached, r.cacheWrite) *
      (long ? p.longInputMultiplier : 1) +
      maxOutput * r.output * (long ? p.longOutputMultiplier : 1)) *
      p.premiumMultiplier) /
    1e6
  );
}
export function bodyFor(req: Request, c: Config, maxOutput: number) {
  return {
    model: c.model,
    service_tier: "default",
    reasoning: { effort: "none" },
    store: false,
    max_output_tokens: maxOutput,
    input: req.prompt,
    text: {
      format: {
        type: "json_schema",
        name: "incremental_pilot",
        strict: true,
        schema: req.schema,
      },
    },
  };
}
type Entry = {
  request: Request;
  bodyHash: string;
  stage: "smoke" | "pilot";
  reserved: number;
  state: "pending" | "complete";
  result?: Result;
  providerUsage?: unknown;
};
type Journal = {
  version: 1;
  fingerprint: string;
  maximumUSD: number;
  entries: Entry[];
};
export class BudgetStop extends Error {}
export async function createTransport(options: {
  authorized: boolean;
  apiKey: string;
  config: Config;
  fingerprint: string;
  maximumUSD: number;
  journalPath: string;
  fetchImpl?: typeof fetch;
}) {
  if (options.authorized !== true)
    throw new Error("separate paid-call authorization required");
  const { config: c } = options;
  for (const value of Object.values(c.pricing.standardPerMillion))
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid price");
  if (
    c.pricing.standardPerMillion.input <= 0 ||
    c.pricing.standardPerMillion.output <= 0 ||
    c.pricing.premiumMultiplier !== 1.1 ||
    c.pricing.longContextThreshold !== 272000 ||
    c.pricing.longInputMultiplier !== 2 ||
    c.pricing.longOutputMultiplier !== 1.5 ||
    !Number.isSafeInteger(c.timeoutMs) ||
    c.timeoutMs < 1 ||
    c.timeoutMs > 45000
  )
    throw new Error("invalid pricing or timeout assumptions");
  if (
    c.model !== "gpt-6-luna" ||
    c.inputTokenCeiling !== 1_050_000 ||
    c.maxOutputTokens !== 1024 ||
    c.smokeMaxOutputTokens !== 256 ||
    c.automaticRetries !== 0 ||
    c.maximumCombinedUSD !== 2 ||
    c.smokeCapUSD !== 0.3 ||
    c.pilotCapUSD !== 1.7 ||
    !Number.isFinite(options.maximumUSD) ||
    options.maximumUSD <= 0 ||
    options.maximumUSD > c.maximumCombinedUSD ||
    !options.apiKey
  )
    throw new Error("invalid authorized pilot configuration");
  await mkdir(dirname(options.journalPath), { recursive: true });
  const lock = await open(`${options.journalPath}.lock`, "wx");
  const fingerprint = hash(
    JSON.stringify({
      freeze: options.fingerprint,
      config: c,
      maximumUSD: options.maximumUSD,
    }),
  );
  let journal: Journal;
  try {
    try {
      journal = JSON.parse(await readFile(options.journalPath, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      journal = {
        version: 1,
        fingerprint,
        maximumUSD: options.maximumUSD,
        entries: [],
      };
    }
    if (
      journal.version !== 1 ||
      journal.fingerprint !== fingerprint ||
      !Array.isArray(journal.entries)
    )
      throw new Error("journal freeze/config/budget mismatch");
    const ids = new Set<string>();
    for (const e of journal.entries) {
      if (
        !e ||
        !e.request ||
        typeof e.request.id !== "string" ||
        ids.has(e.request.id) ||
        !["smoke", "pilot"].includes(e.stage) ||
        !["pending", "complete"].includes(e.state) ||
        !Number.isFinite(e.reserved) ||
        e.reserved < 0 ||
        e.bodyHash !==
          hash(
            JSON.stringify(
              bodyFor(
                e.request,
                c,
                e.stage === "smoke"
                  ? c.smokeMaxOutputTokens
                  : c.maxOutputTokens,
              ),
            ),
          )
      )
        throw new Error("invalid journal entry");
      ids.add(e.request.id);
      if (e.state === "pending") {
        e.state = "complete";
        e.result = {
          error:
            "interrupted request; billing unknown; reservation retained; no retry",
          usage: null,
          cost: { lower: 0, upper: e.reserved },
          latencyMs: null,
        };
      }
      if (
        !e.result?.cost ||
        !Number.isFinite(e.result.cost.lower) ||
        !Number.isFinite(e.result.cost.upper) ||
        e.result.cost.lower < 0 ||
        e.result.cost.upper < e.result.cost.lower ||
        (e.result.usage &&
          (e.result.usage.input > c.inputTokenCeiling ||
            e.result.usage.output >
              (e.stage === "smoke"
                ? c.smokeMaxOutputTokens
                : c.maxOutputTokens)))
      )
        throw new Error(
          "invalid journal accounting or provider bound violation",
        );
      if (e.result.error === "unexpected model or processing tier")
        throw new Error(
          "reconcile unexpected provider model/tier before continuing this journal",
        );
      const expectedReserve = reserve(
        c,
        e.stage === "smoke" ? c.smokeMaxOutputTokens : c.maxOutputTokens,
      );
      if (Math.abs(e.reserved - expectedReserve) > 1e-12)
        throw new Error("journal reservation mismatch");
      if (e.result.usage) {
        const recomputedUsage = usageOf({ usage: e.providerUsage });
        if (JSON.stringify(e.result.usage) !== JSON.stringify(recomputedUsage))
          throw new Error("journal usage mismatch");
        const recomputed = costBounds(e.result.usage, c);
        if (
          Math.abs(e.result.cost.lower - recomputed.lower) > 1e-12 ||
          Math.abs(e.result.cost.upper - recomputed.upper) > 1e-12
        )
          throw new Error("journal cost mismatch");
      } else if (
        e.result.cost.lower !== 0 ||
        Math.abs(e.result.cost.upper - e.reserved) > 1e-12
      )
        throw new Error("unknown billing reservation was reduced");
    }
    await atomicJson(options.journalPath, journal);
  } catch (e) {
    await lock.close();
    await unlink(`${options.journalPath}.lock`);
    throw e;
  }
  let busy = false,
    closed = false,
    halted = false;
  const committed = (stage?: Entry["stage"]) =>
    journal.entries
      .filter((e) => !stage || e.stage === stage)
      .reduce((s, e) => s + (e.result?.cost?.upper ?? e.reserved), 0);
  const infer =
    (stage: Entry["stage"]): Inference =>
    async (req) => {
      if (busy || closed || halted)
        throw new Error("transport is busy/closed/halted");
      busy = true;
      try {
        const maxOutput =
            stage === "smoke" ? c.smokeMaxOutputTokens : c.maxOutputTokens,
          body = JSON.stringify(bodyFor(req, c, maxOutput));
        const old = journal.entries.find((e) => e.request.id === req.id);
        if (old) {
          if (old.stage !== stage || old.bodyHash !== hash(body))
            throw new Error("replay request mismatch");
          return { ...old.result!, replayed: true };
        }
        if (Buffer.byteLength(body) + 8192 > c.pricing.longContextThreshold)
          throw new Error(
            "request exceeds conservative short-context byte bound",
          );
        const reserved = reserve(c, maxOutput),
          stageCap = stage === "smoke" ? c.smokeCapUSD : c.pilotCapUSD;
        if (
          committed() + reserved > options.maximumUSD + 1e-12 ||
          committed(stage) + reserved > stageCap + 1e-12
        )
          throw new BudgetStop(
            "local USD reservation cap reached; checkpoint retained; no retry",
          );
        const entry: Entry = {
          request: req,
          bodyHash: hash(body),
          stage,
          reserved,
          state: "pending",
        };
        journal.entries.push(entry);
        await atomicJson(options.journalPath, journal);
        const started = performance.now();
        const result: Result = {
          usage: null,
          cost: { lower: 0, upper: reserved },
          latencyMs: 0,
        };
        try {
          const response = await (options.fetchImpl ?? fetch)(
            "https://api.openai.com/v1/responses",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${options.apiKey}`,
                "Content-Type": "application/json",
              },
              body,
              signal: AbortSignal.timeout(c.timeoutMs),
            },
          );
          const data = await response.json();
          entry.providerUsage = data?.usage ?? null;
          result.usage = usageOf(data);
          if (result.usage) result.cost = costBounds(result.usage, c);
          result.metadata = {
            model: typeof data?.model === "string" ? data.model : null,
            tier:
              typeof data?.service_tier === "string" ? data.service_tier : null,
            responseId: typeof data?.id === "string" ? data.id : null,
          };
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (!result.usage)
            throw new Error("usage absent; full reservation retained");
          if (
            !/^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(
              result.metadata.model ?? "",
            ) ||
            result.metadata.tier !== "default"
          ) {
            result.cost = {
              lower: 0,
              upper: Math.max(reserved, result.cost!.upper),
            };
            halted = true;
            throw new Error("unexpected model or processing tier");
          }
          if (
            data.usage.total_tokens !== undefined &&
            data.usage.total_tokens !== result.usage.input + result.usage.output
          )
            throw new Error("provider total token mismatch");
          if (
            result.usage.input > c.inputTokenCeiling ||
            result.usage.output > maxOutput
          )
            throw new Error("provider accounting bound violation");
          result.output = readResponse(data);
        } catch (e) {
          result.error = e instanceof Error ? e.message : String(e);
        }
        result.latencyMs = performance.now() - started;
        entry.result = result;
        entry.state = "complete";
        await atomicJson(options.journalPath, journal);
        if (
          committed() > options.maximumUSD + 1e-12 ||
          committed(stage) > stageCap + 1e-12 ||
          (result.usage &&
            (result.usage.input > c.inputTokenCeiling ||
              result.usage.output > maxOutput))
        ) {
          halted = true;
          throw new BudgetStop(
            "provider exceeded accounting assumptions; ledger saved; reconcile before continuing",
          );
        }
        return result;
      } finally {
        busy = false;
      }
    };
  return {
    infer,
    entries: () => structuredClone(journal.entries),
    accounting: () => ({
      maximumUSD: options.maximumUSD,
      committedUpperUSD: committed(),
      smokeUpperUSD: committed("smoke"),
      pilotUpperUSD: committed("pilot"),
      unmeteredCalls: journal.entries.filter((e) => !e.result?.usage).length,
    }),
    close: async () => {
      closed = true;
      await lock.close();
      await unlink(`${options.journalPath}.lock`);
    },
  };
}
