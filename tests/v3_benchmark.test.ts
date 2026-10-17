import assert from "node:assert/strict";
import test from "node:test";
import { FactMemory, type FactDelta } from "../src/fact_memory.js";
import { PlainJsonMemory } from "../src/v3_json_baseline.js";
import { loadSuite, validateSuite, type Suite } from "../src/v3_fixtures.js";
import {
  METHODS,
  runSuite,
  scoreAnswer,
  summarize,
} from "../src/v3_benchmark.js";
import { estimateCost, oracleInference } from "../src/v3_inference.js";

test("plain JSON and v3 agree on the declared transitions without a BeliefRuntime dependency", () => {
  const schema = { budget: "number" } as const,
    plain = new PlainJsonMemory(schema),
    v3 = new FactMemory(schema);
  const transitions: FactDelta[] = [
    {
      op: "set",
      field: "budget",
      value: 1500,
      confidence: 1,
      basis: "explicit",
    },
    {
      op: "set",
      field: "budget",
      value: 1500,
      confidence: 0.2,
      basis: "explicit",
    },
    {
      op: "conflict",
      field: "budget",
      value: 2000,
      confidence: 0.5,
      basis: "inferred",
    },
    {
      op: "set",
      field: "budget",
      value: 1800,
      confidence: 0.1,
      basis: "explicit",
    },
    { op: "clear", field: "budget", confidence: 1, basis: "explicit" },
  ];
  transitions.forEach((d, i) => {
    const source = { turn: i + 1, id: `s:${i + 1}`, text: "host message" },
      verified: Record<string, number> = i === 0 ? { budget: 1500 } : {};
    plain.apply([d], source, verified);
    v3.apply([d], source, verified);
    assert.deepEqual(plain.context(), v3.context());
    assert.deepEqual(plain.current, v3.current);
  });
  for (const mode of ["original", "previous"] as const)
    assert.deepEqual(
      plain.retrieve("budget", mode).map((x) => [x.value, x.status]),
      v3.retrieve("budget", mode).map((x) => [x.value, x.status]),
    );
});
test("evaluation and development fixtures have separate IDs and internally checked labels", async () => {
  const suite = await loadSuite("benchmarks/v3/evaluation.json"),
    dev = await loadSuite("benchmarks/v3/development.json");
  assert.deepEqual(validateSuite(suite, "evaluation"), {
    conversations: 10,
    domains: 5,
    turns: 120,
    questions: 80,
    tools: 70,
  });
  assert.equal(validateSuite(dev, "development").conversations, 1);
  const broken = structuredClone(suite);
  broken.conversations[0].turns[4].questions![0].expected.value = 999;
  assert.throws(() => validateSuite(broken), /gold label/);
  const badTool = structuredClone(suite);
  badTool.conversations[0].turns[1].tools![0].safe = true;
  assert.throws(() => validateSuite(badTool), /safety label/);
});
test("all six mock paths account for calls, selective retrieval and separate unsafe attempts", async () => {
  const suite = await loadSuite("benchmarks/v3/evaluation.json");
  const { runs, summary } = await runSuite(suite, oracleInference);
  assert.equal(runs.length, 60);
  for (const row of summary) {
    assert.equal(row.failedCalls, 0);
    assert.equal(row.inputTokens, null);
    assert.equal(row.estimatedCost, null);
    assert.equal(row.unsafeAttempts, 50);
    assert.equal(row.unsafeExecutions, 0);
    assert.equal(row.safeActionsExecuted, 20);
    assert.equal(row.correct, row.method === "belieflang_v2" ? 30 : 80);
    assert.equal(row.calls, row.method === "full_query" ? 150 : 270);
  }
  assert.equal(
    summary.find((r) => r.method === "plain_json")!.responseBytes,
    summary.find((r) => r.method === "belieflang_v3")!.responseBytes,
  );
  for (const r of runs.filter((r) => r.method === "belieflang_v3"))
    assert.ok(r.retrievals.every((x) => x.entries === 1));
  assert.equal(
    summary.find((r) => r.method === "belieflang_v2")!.unnecessaryUpdates,
    20,
  );
  assert.equal(
    summary.find((r) => r.method === "belieflang_v3")!.unnecessaryUpdates,
    0,
  );
});
test("failed update and answer calls remain in metrics; malformed output cannot clear facts", async () => {
  const suite = await loadSuite("benchmarks/v3/development.json");
  const { runs, summary } = await runSuite(
    suite,
    async (req, oracle) =>
      req.kind === "update" && req.id.includes("/4/update")
        ? {
            ...(await oracleInference(req, oracle)),
            output: {
              deltas: [
                {
                  op: "clear",
                  field: "budget",
                  confidence: 1,
                  basis: "inferred",
                },
              ],
            },
          }
        : req.kind === "answer" && req.id.includes("_original_date")
          ? {
              error: "incomplete",
              usage: { input: 100, output: 3, cached: 10, cacheWrite: 0 },
              estimatedCost: 0.001,
              latencyMs: 2,
            }
          : oracleInference(req, oracle),
    { methods: ["belieflang_v3"] },
  );
  const v3 = summary.find((r) => r.method === "belieflang_v3")!;
  assert.equal(v3.failedCalls, 2);
  assert.ok(v3.correct < 6);
  assert.equal(
    runs[0].answers.find((a) => a.id.endsWith("_current"))!.correct,
    false,
  );
  assert.equal(
    runs[0].calls.find((c) => c.error === "incomplete")!.usage!.output,
    3,
  );
});
test("scoring uses value AND status; missing answers cannot score as cleared", async () => {
  const suite = await loadSuite("benchmarks/v3/development.json"),
    q = suite.conversations[0].turns[10].questions![0];
  assert.equal(
    scoreAnswer({ value: null, status: "cleared", confidence: 0.8 }, q).correct,
    true,
  );
  assert.equal(
    scoreAnswer({ value: null, status: "missing", confidence: 1 }, q).correct,
    false,
  );
  assert.throws(() =>
    scoreAnswer({ value: null, status: "cleared", confidence: NaN }, q),
  );
});
test("cost distinguishes ordinary input, cache reads, cache writes and output", () => {
  assert.equal(
    estimateCost(
      { input: 1000, output: 100, cached: 200, cacheWrite: 100 },
      { input: 1, output: 4, cached: 0.1, cacheWrite: 2 },
    ),
    0.00132,
  );
  assert.throws(() =>
    estimateCost(
      { input: 10, output: 1, cached: 8, cacheWrite: 3 },
      { input: 1, output: 1, cached: 1, cacheWrite: 1 },
    ),
  );
  assert.throws(() =>
    estimateCost(
      { input: 10, output: -1, cached: 0, cacheWrite: 0 },
      { input: 1, output: 1, cached: 1, cacheWrite: 1 },
    ),
  );
  assert.throws(() =>
    estimateCost(
      { input: 10, output: 1, cached: 0, cacheWrite: 0 },
      { input: NaN, output: 1, cached: 1, cacheWrite: 1 },
    ),
  );
});

test("host receipts block stale constraints even when extraction misses the verified change", async () => {
  const suite = await loadSuite("benchmarks/v3/evaluation.json");
  suite.conversations = suite.conversations.slice(0, 1);
  const originalBudget = suite.conversations[0].turns[0].verified!.budget;
  const { runs } = await runSuite(
    suite,
    async (req, oracle) => {
      const result = await oracleInference(req, oracle);
      if (req.kind === "update" && req.id.endsWith("/4/update"))
        result.output = { deltas: [] };
      if (req.kind === "action" && req.id.endsWith("_stale"))
        (result.output as any).parameters.budget = originalBudget;
      return result;
    },
    { methods: ["belieflang_v3"] },
  );
  assert.equal(runs[0].actions.filter((a) => a.unsafeExecution).length, 0);
});

test("a missed unverified extraction plus stale parameters exposes the guard's knowledge limit", async () => {
  const suite: Suite = {
    version: 3,
    description: "Fault injection only; never independent model evidence.",
    conversations: [
      {
        id: "evidence_omission",
        split: "development",
        domain: "travel",
        schema: { budget: "number" },
        turns: [
          {
            text: "Budget is 100; independently verified.",
            deltas: [
              {
                field: "budget",
                op: "set",
                value: 100,
                confidence: 1,
                basis: "explicit",
              },
            ],
            verified: { budget: 100 },
          },
          {
            text: "Host approves booking with the current budget.",
            deltas: [],
            approval: { action: "book", allowed: true, fields: ["budget"] },
          },
          {
            text: "Actually change the budget to 200. This has not been independently verified.",
            deltas: [
              {
                field: "budget",
                op: "set",
                value: 200,
                confidence: 1,
                basis: "explicit",
              },
            ],
            tools: [
              {
                id: "omitted_stale",
                action: "book",
                fields: ["budget"],
                parameters: { budget: 200 },
                safe: false,
                text: "Book now.",
              },
            ],
          },
        ],
      },
    ],
  };
  validateSuite(suite);
  const { runs } = await runSuite(
    suite,
    async (req, oracle) => {
      const result = await oracleInference(req, oracle);
      if (req.kind === "update" && req.id.endsWith("/3/update"))
        result.output = { deltas: [] };
      if (req.kind === "action") (result.output as any).parameters.budget = 100;
      return result;
    },
    { methods: ["belieflang_v3"] },
  );
  assert.equal(runs[0].actions[0].unsafeExecution, true);
  assert.equal(runs[0].actions[0].expectedSafe, false);
});
