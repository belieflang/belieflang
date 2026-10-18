import assert from "node:assert/strict";
import { load } from "./fixtures.js";
import { METHODS, SCHEDULES, type Inference } from "./types.js";
import { runCase, score, type Run } from "./runner.js";
import { bodyFor, costBounds, reserve } from "./live.js";
export async function evaluate(
  infer: Inference,
  onProgress?: (completed: Run[], active: Run) => Promise<void>,
) {
  const { cases, gold } = await load();
  const runs: Run[] = [];
  for (const schedule of SCHEDULES)
    for (const [ci, c] of cases.entries()) {
      // Fixed rotation counterbalances method order. No model selection or adaptive routing.
      const order = [...METHODS];
      order.push(
        ...order.splice(
          0,
          (ci + (schedule === "dense" ? 1 : 0)) % order.length,
        ),
      );
      for (const method of order) {
        const run = await runCase(
          c,
          method,
          schedule,
          infer,
          (active) => onProgress?.(runs, active) ?? Promise.resolve(),
        );
        runs.push(run);
      }
    }
  return { runs, summary: score(runs, gold) };
}
export async function offlineReport() {
  const { scriptedInference } = await import("./offline.js");
  const result = await evaluate(scriptedInference);
  assert.ok(
    result.summary.every(
      (s) =>
        s.correct === s.total &&
        s.sourceCorrect === s.total &&
        s.unsafeExecutions === 0 &&
        s.falseDenials === 0 &&
        s.routingCorrect === s.routingTotal,
    ),
  );
  return {
    version: 1,
    description:
      "Offline controlled-text parser and deterministic contracts, not measured model accuracy/tokens/cost/latency. No gold is passed into inference. No paid calls.",
    liveCalls: 0,
    summary: result.summary,
    curves: result.runs.map((r) => ({
      case: r.case,
      method: r.method,
      schedule: r.schedule,
      points: r.checks.map((c) => ({
        turn: c.turn,
        calls: c.cumulative.calls,
        requestBytes: c.cumulative.requestBytes,
      })),
    })),
    runs: result.runs,
  };
}
export async function plan(runs: Run[]) {
  const { config } = await load(),
    calls = runs.flatMap((r) => r.calls);
  const scenarios = [
    { name: "central", bytesPerToken: 4, stateMultiplier: 1, framing: 200 },
    { name: "stress", bytesPerToken: 3, stateMultiplier: 2, framing: 1000 },
  ].map((a) => {
    const byCondition = [];
    for (const schedule of SCHEDULES)
      for (const method of METHODS) {
        const selected = runs
          .filter((r) => r.schedule === schedule && r.method === method)
          .flatMap((r) => r.calls);
        const input = selected.reduce(
          (s, r) =>
            s +
            Math.ceil(
              (Buffer.byteLength(
                JSON.stringify(bodyFor(r, config, config.maxOutputTokens)),
              ) *
                a.stateMultiplier) /
                a.bytesPerToken,
            ) +
            a.framing,
          0,
        );
        const output = selected.reduce(
          (s, r) =>
            s +
            Math.min(
              config.maxOutputTokens,
              Math.ceil(
                (Buffer.byteLength(JSON.stringify(r.output) ?? "") *
                  a.stateMultiplier) /
                  a.bytesPerToken,
              ),
            ),
          0,
        );
        const projected = costBounds(
          { input, output, cached: 0, cacheWrite: input, reasoning: 0 },
          {
            ...config,
            pricing: { ...config.pricing, longContextThreshold: Infinity },
          },
        ).upper;
        byCondition.push({
          schedule,
          method,
          calls: selected.length,
          projectedInputTokens: input,
          projectedOutputTokens: output,
          projectedUSD: projected,
        });
      }
    return {
      ...a,
      byCondition,
      totalProjectedUSD: byCondition.reduce((s, x) => s + x.projectedUSD, 0),
    };
  });
  return {
    version: 1,
    authorization: "NOT AUTHORIZED / NOT EXECUTED",
    model: config.model,
    caseCount: 3,
    conditions: METHODS,
    schedules: SCHEDULES,
    repetitions: 1,
    plannedCalls: calls.length,
    scenarios,
    assumptions:
      "Serialized request/output bytes and offline parser traces, not measured tokens. All projected input charged at cache-write rate, 10% premium included, no cache savings assumed. Future model summaries/patches may change sizes. Token distribution is aggregated for planning, not provider billing.",
    maximumCombinedUSD: config.maximumCombinedUSD,
    smokeCapUSD: config.smokeCapUSD,
    pilotCapUSD: config.pilotCapUSD,
    automaticRetries: 0,
    smokeReservationUSD: reserve(config, config.smokeMaxOutputTokens),
    pilotPerCallReservationUSD: reserve(config, config.maxOutputTokens),
    allCallsAtReservationUSD:
      calls.length * reserve(config, config.maxOutputTokens),
    completionGuaranteed: false,
    unknownBilling:
      "Each failed/interrupted request with unknown usage retains the entire reservation. All failures consume the same caps. No replacement calls or automatic retries. Stop and report partial paired coverage at the cap.",
  };
}
