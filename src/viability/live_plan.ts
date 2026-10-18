import type { InferenceRequest, Rates } from "../v3_inference.js";
import { estimateCost } from "../v3_inference.js";
import { createLiveInference, type LiveConfig } from "../v3_live.js";
import { validateDeltas } from "../fact_memory.js";
import { verifyReviewFreeze } from "./freeze.js";
import { readFile } from "node:fs/promises";
import { atomicJson } from "../v3_live.js";
import type { CapturedCall } from "./audit.js";
export const allocation = {
  smoke: 0.3,
  evaluation: 4,
  contingency: 0.7,
  total: 5,
} as const;
export const smokeConfig: LiveConfig = {
  model: "gpt-6-luna",
  repetitions: 1,
  maxOutputTokens: 256,
  inputTokenCeiling: 1_050_000,
  timeoutMs: 45_000,
};
export function smokeRequest(): InferenceRequest {
  const base = {
    field: { type: "string", enum: ["budget"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    basis: { type: "string", enum: ["explicit", "inferred"] },
  };
  const object = (properties: Record<string, unknown>) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  return {
    id: "viability-compatibility-smoke-v1",
    kind: "update",
    prompt: JSON.stringify({
      instructions:
        "Return only the changed typed fact. No host metadata. Explicit corrections supersede previous values.",
      schema: { budget: "number" },
      context: { budget: { value: 1800, status: "uncertain" } },
      message: "Actually change the budget to 2100.",
    }),
    schema: object({
      deltas: {
        type: "array",
        items: {
          anyOf: [
            object({
              ...base,
              op: { type: "string", enum: ["set", "conflict"] },
              value: {
                anyOf: [
                  { type: "string" },
                  { type: "number" },
                  { type: "boolean" },
                ],
              },
            }),
            object({ ...base, op: { type: "string", enum: ["clear"] } }),
          ],
        },
      },
    }),
  };
}
export function allInRates(standard: Rates, premium: number): Rates {
  if (!Number.isFinite(premium) || premium < 1)
    throw new Error("invalid premium");
  return Object.fromEntries(
    Object.entries(standard).map(([k, v]) => [k, v * premium]),
  ) as Rates;
}
export function reservation(config: LiveConfig, rates: Rates) {
  return (
    (config.inputTokenCeiling *
      Math.max(rates.input, rates.cached, rates.cacheWrite) *
      (config.inputTokenCeiling > 272_000 ? 2 : 1) +
      config.maxOutputTokens *
        rates.output *
        (config.inputTokenCeiling > 272_000 ? 1.5 : 1)) /
    1e6
  );
}
function wireBody(request: InferenceRequest, config: LiveConfig) {
  return {
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
  };
}
export function estimatePlan(
  calls: CapturedCall[],
  config: LiveConfig,
  rates: Rates,
) {
  // No tokenizer/provider usage is available: these are explicitly conditional planning scenarios.
  const scenarios = [
    {
      name: "optimistic",
      bytesPerToken: 5,
      stateAndOutputMultiplier: 1,
      framingTokensPerCall: 100,
    },
    {
      name: "central",
      bytesPerToken: 4,
      stateAndOutputMultiplier: 1,
      framingTokensPerCall: 100,
    },
    {
      name: "stress",
      bytesPerToken: 3,
      stateAndOutputMultiplier: 2,
      framingTokensPerCall: 1000,
    },
  ].map((assumption) => {
    let input = 0,
      output = 0;
    for (const c of calls) {
      input +=
        Math.ceil(
          ((Buffer.byteLength(c.request.prompt) +
            Buffer.byteLength(JSON.stringify(c.request.schema))) *
            assumption.stateAndOutputMultiplier) /
            assumption.bytesPerToken,
        ) + assumption.framingTokensPerCall;
      output += Math.min(
        config.maxOutputTokens,
        Math.ceil(
          (Buffer.byteLength(JSON.stringify(c.output) ?? "") *
            assumption.stateAndOutputMultiplier) /
            assumption.bytesPerToken,
        ),
      );
    }
    return {
      ...assumption,
      projectedInputTokens: input,
      projectedOutputTokens: output,
      projectedCost: estimateCost(
        { input, output, cached: 0, cacheWrite: input },
        rates,
      ),
    };
  });
  const replayConditionedCeiling = calls.reduce((sum, c) => {
    const input =
      Buffer.byteLength(JSON.stringify(wireBody(c.request, config))) + 8192;
    return (
      sum +
      estimateCost(
        { input, output: config.maxOutputTokens, cached: 0, cacheWrite: input },
        rates,
      )
    );
  }, 0);
  const counts = Object.fromEntries(
    [...new Set(calls.map((c) => c.request.id.split("/")[2]))].map((method) => [
      method,
      calls.filter((c) => c.request.id.split("/")[2] === method).length,
    ]),
  );
  return {
    description:
      "Projections, not measured model tokens or spend. Input priced entirely at the highest short-context cache-write rate; premium included. Frozen oracle traces cannot bound future model-dependent summaries or extracted state.",
    plannedCalls: calls.length,
    perMethod: counts,
    scenarios,
    replayConditionedCeiling,
    perRequestReservation: reservation(config, rates),
    allCallsAtReservation: calls.length * reservation(config, rates),
    allocation,
    completionGuaranteed: false,
    automaticRetries: 0,
    smokeRequests: 1,
    maximumSeparatelyApprovedDiagnosticRetries: 2,
    planningScenariosFitEvaluationAllocation: scenarios.every(
      (s) =>
        s.projectedCost < allocation.evaluation - reservation(config, rates),
    ),
    unknownBillingSensitivity: [0, 5, 10, 12].map((unknownCalls) => ({
      unknownCalls,
      centralProjectionPlusUnknownReservationsAndNextRequest:
        scenarios[1].projectedCost +
        (unknownCalls + 1) * reservation(config, rates),
      couldContinueWithinEvaluationCap:
        scenarios[1].projectedCost +
          (unknownCalls + 1) * reservation(config, rates) <=
        allocation.evaluation,
    })),
    reducedFallback: {
      description:
        "Separately frozen proposal, not an alteration of the original: one repetition, all ten original conversations, five primary methods, no eager-history diagnostic. Reused cases are not a new independent holdout. Unchanged engine/prompts retain category hints and redundant output. This fallback is diagnostic only; common-contract fixes and genuinely fresh cases require a different protocol before confirmatory use.",
      methods: [
        "full_query",
        "rolling_summary",
        "plain_json",
        "belieflang_v2",
        "belieflang_v3",
      ],
      repetitions: 1,
      plannedCalls:
        calls.filter((c) => c.request.id.split("/")[2] !== "full_eager")
          .length / config.repetitions,
    },
  };
}
/** Prepared compatibility test, intentionally no CLI and no environment/credential lookup. Never called by offline review. */
export async function runAuthorizedSmoke(options: {
  authorized: boolean;
  apiKey: string;
  rates: Rates;
  fingerprint: string;
  journalPath: string;
  fetchImpl?: typeof fetch;
}) {
  if (options.authorized !== true)
    throw new Error("separate explicit paid authorization required");
  if (
    !options.fetchImpl &&
    options.fingerprint !== (await verifyReviewFreeze())
  )
    throw new Error("smoke freeze fingerprint mismatch");
  type SmokeMetadata = {
    model: string | null;
    serviceTier: string | null;
    cacheReadDetailsPresent: boolean;
    cacheWriteDetailsPresent: boolean;
  };
  let metadata: SmokeMetadata | null = null;
  const capturedMetadata = (): SmokeMetadata | null => metadata;
  const metadataPath = `${options.journalPath}.metadata.json`;
  const captureMetadata: typeof fetch = async (input, init) => {
    const response = await (options.fetchImpl ?? fetch)(input, init);
    try {
      const data = await response.clone().json();
      metadata = {
        model: typeof data?.model === "string" ? data.model : null,
        serviceTier:
          typeof data?.service_tier === "string" ? data.service_tier : null,
        cacheReadDetailsPresent: Object.hasOwn(
          data?.usage?.input_tokens_details ?? {},
          "cached_tokens",
        ),
        cacheWriteDetailsPresent: Object.hasOwn(
          data?.usage?.input_tokens_details ?? {},
          "cache_write_tokens",
        ),
      };
      await atomicJson(metadataPath, {
        fingerprint: options.fingerprint,
        metadata,
      });
    } catch {
      metadata = null; // Fail compatibility without hiding the transport's usage accounting.
    }
    return response;
  };
  const runner = await createLiveInference({
    apiKey: options.apiKey,
    config: smokeConfig,
    rates: options.rates,
    cap: allocation.smoke,
    fingerprint: options.fingerprint,
    journalPath: options.journalPath,
    fetchImpl: captureMetadata,
  });
  try {
    const response = await runner.infer(smokeRequest(), null);
    if (response.replayed) {
      try {
        const saved = JSON.parse(await readFile(metadataPath, "utf8"));
        if (
          saved.fingerprint === options.fingerprint &&
          typeof saved.metadata?.cacheReadDetailsPresent === "boolean" &&
          typeof saved.metadata?.cacheWriteDetailsPresent === "boolean"
        )
          metadata = saved.metadata;
      } catch {
        /* Missing sidecar fails compatibility below without repeating a paid request. */
      }
    }
    const observed = capturedMetadata();
    let validationError: string | undefined;
    if (!response.error)
      try {
        if (
          !observed ||
          typeof observed.model !== "string" ||
          !observed.model.startsWith("gpt-6-luna") ||
          observed.serviceTier !== "default"
        )
          throw new Error(
            "smoke model/service-tier metadata is missing or unexpected",
          );
        const output = response.output as any;
        if (!output || Object.keys(output).join() !== "deltas")
          throw new Error("invalid smoke wrapper");
        validateDeltas({ budget: "number" }, output.deltas);
        if (
          output.deltas.length !== 1 ||
          output.deltas[0].op !== "set" ||
          output.deltas[0].value !== 2100 ||
          output.deltas[0].basis !== "explicit"
        )
          throw new Error(
            "smoke contract did not match the explicit correction",
          );
      } catch (e) {
        validationError = e instanceof Error ? e.message : String(e);
      }
    return {
      status: response.error || validationError ? "failed" : "passed",
      validationError,
      metadata: observed,
      response,
      accounting: runner.accounting(),
    };
  } finally {
    await runner.close();
  }
}
