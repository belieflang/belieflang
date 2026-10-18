import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewFrozenBenchmark } from "../src/viability/audit.js";
import { loadSuite } from "../src/v3_fixtures.js";
import { scoreAnswer } from "../src/v3_benchmark.js";
import {
  runAuthorizedSmoke,
  smokeRequest,
  smokeConfig,
  estimatePlan,
  allocation,
  reservation,
} from "../src/viability/live_plan.js";
const rates = {
  input: 0.1375,
  cached: 0.1375,
  cacheWrite: 0.1375,
  output: 0.55,
};

test("independent replay checks all frozen labels and detects information/overhead defects without changing the benchmark", async () => {
  const audit = await reviewFrozenBenchmark();
  assert.equal(audit.labels, 80);
  assert.equal(audit.actionLabels, 70);
  assert.equal(audit.categoryHints, 120);
  assert.equal(audit.eagerDuplicateMessage, 120);
  assert.equal(audit.redundantActionFactReports, 210);
  assert.equal(audit.typedMemoryAnswerCalls, 160);
  assert.equal(audit.verifiedMaintenanceCalls, 150);
  assert.equal(audit.savedRawHashVerified, true);
  assert.equal(audit.savedSummaryRecomputed, true);
  for (const call of audit.calls)
    assert.ok(
      !Object.hasOwn(JSON.parse(call.request.prompt).task ?? {}, "expected"),
    );
});
test("a tag-only answer construction passes 20 of 80 frozen questions without reading any evidence", async () => {
  const suite = await loadSuite("benchmarks/v3/evaluation.json");
  let correct = 0;
  for (const c of suite.conversations)
    for (const turn of c.turns)
      for (const q of turn.questions ?? []) {
        if (q.kind === "missing" || q.kind === "contradiction") {
          const answer = {
            value: null,
            status: q.kind === "missing" ? "missing" : "conflicting",
            confidence: 1,
          };
          assert.equal(scoreAnswer(answer, q).correct, true);
          correct++;
        }
      }
  assert.equal(correct, 20);
});
test("proposed combined budget stays at $5 and explicitly distinguishes projections from measurements", async () => {
  assert.equal(
    allocation.smoke + allocation.evaluation + allocation.contingency,
    allocation.total,
  );
  assert.equal(allocation.total, 5);
  assert.ok(reservation(smokeConfig, rates) < allocation.smoke);
  const a = smokeRequest();
  const p = estimatePlan(
    [{ request: a, output: { deltas: [] } }],
    { ...smokeConfig, repetitions: 1 },
    rates,
  );
  assert.equal(p.completionGuaranteed, false);
  assert.equal(p.automaticRetries, 0);
  assert.ok(p.scenarios.every((s) => s.projectedCost > 0));
});
test("compatibility helper requires explicit authorization and does not look up credentials", async () => {
  let fetched = 0;
  await assert.rejects(
    runAuthorizedSmoke({
      authorized: false,
      apiKey: "test-only",
      rates,
      fingerprint: "mock",
      journalPath: "must-not-exist",
      fetchImpl: (async () => {
        fetched++;
        throw new Error("must not dispatch");
      }) as typeof fetch,
    }),
    /authorization/,
  );
  assert.equal(fetched, 0);
});
test("prepared compatibility request uses the real transport with injected HTTP mocks only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "belieflang-viability-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let fetched = 0;
  const result = await runAuthorizedSmoke({
    authorized: true,
    apiKey: "test-only",
    rates,
    fingerprint: "mock",
    journalPath: join(dir, "smoke.json"),
    fetchImpl: (async (_url, init) => {
      fetched++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "gpt-6-luna");
      assert.equal(body.max_output_tokens, 256);
      assert.equal(body.service_tier, "default");
      assert.equal(body.store, false);
      return new Response(
        JSON.stringify({
          status: "completed",
          model: "gpt-6-luna",
          service_tier: "default",
          usage: { input_tokens: 200, output_tokens: 45 },
          output: [
            {
              type: "message",
              phase: "final_answer",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    deltas: [
                      {
                        field: "budget",
                        op: "set",
                        value: 2100,
                        confidence: 0.9,
                        basis: "explicit",
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
      );
    }) as typeof fetch,
  });
  assert.equal(fetched, 1);
  assert.equal(result.status, "passed");
  assert.equal(result.metadata!.serviceTier, "default");
  assert.equal(result.response.usage!.input, 200);
  assert.ok(result.accounting.estimatedCostOrUpperBound < allocation.smoke);
  const replay = await runAuthorizedSmoke({
    authorized: true,
    apiKey: "test-only",
    rates,
    fingerprint: "mock",
    journalPath: join(dir, "smoke.json"),
    fetchImpl: (async () => {
      fetched++;
      throw new Error("must not retry");
    }) as typeof fetch,
  });
  assert.equal(replay.status, "passed");
  assert.equal(replay.response.replayed, true);
  assert.equal(fetched, 1);
});

test("the oracle's answer path can hide lost summaries and uses verification not present in v2 answer context", async () => {
  const audit = await reviewFrozenBenchmark();
  assert.deepEqual(audit.emptySummaryOracleProbe, { correct: 6, total: 6 });
  assert.equal(audit.v2OracleVerificationNotInContext, 20);
});
test("matching scalar-free host verification is not applied independently of model deltas", async () => {
  const { FactMemory } = await import("../src/fact_memory.js");
  const { TypeScriptState } = await import(
    "../src/viability/typescript_state.js"
  );
  for (const state of [
    new FactMemory({ budget: "number" }),
    new TypeScriptState({ budget: "number" }),
  ]) {
    const delta = {
      field: "budget",
      op: "set",
      value: 100,
      confidence: 0.9,
      basis: "explicit",
    } as const;
    const source = { turn: 1, id: "proof:1", text: "budget 100" };
    if (state instanceof FactMemory) {
      state.apply([delta], source);
      state.apply([], { ...source, turn: 2, id: "proof:2" }, { budget: 100 });
    } else {
      state.applyExtracted([delta], source);
      state.applyExtracted(
        [],
        { ...source, turn: 2, id: "proof:2" },
        { budget: 100 },
      );
    }
    assert.equal(state.current.budget.status, "uncertain");
  }
});

test("a newly scoped approval exposes the v2 adapter's reuse of stale verification after an unverified revision", async () => {
  const audit = await reviewFrozenBenchmark();
  assert.deepEqual(
    Object.fromEntries(
      audit.unsafeOnUnverifiedApproval.map((r) => [
        r.method,
        r.unsafeExecutions,
      ]),
    ),
    { plain_json: 0, belieflang_v2: 1, belieflang_v3: 0 },
  );
});

test("compatibility rejects an unexpected processing tier without discarding billed usage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "belieflang-smoke-tier-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = await runAuthorizedSmoke({
    authorized: true,
    apiKey: "test-only",
    rates,
    fingerprint: "mock",
    journalPath: join(dir, "smoke.json"),
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          model: "gpt-6-luna",
          service_tier: "priority",
          usage: { input_tokens: 200, output_tokens: 45 },
          output: [
            {
              type: "message",
              phase: "final_answer",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    deltas: [
                      {
                        field: "budget",
                        op: "set",
                        value: 2100,
                        confidence: 1,
                        basis: "explicit",
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        }),
      )) as typeof fetch,
  });
  assert.equal(result.status, "failed");
  assert.match(result.validationError!, /service-tier/);
  assert.equal(result.response.usage!.input, 200);
  assert.ok(result.accounting.estimatedCostOrUpperBound > 0);
});
