import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exactAnswerMatches, runLongHorizon, validateOffline, scoreSummary, type ResultRow } from "../src/long_horizon_benchmark.js";
import { longHorizonConversations, validateLongHorizonFixtures } from "../src/long_horizon_cases.js";

test("long-horizon fixtures are ten 20-turn conversations across five domains", () => {
  assert.deepEqual(validateLongHorizonFixtures(), { conversations: 10, domains: 5, turns: 200, checkpoints: 40 });
  assert.equal(longHorizonConversations.every(c => c.turns.length === 20), true);
});

test("typed BeliefRuntime memory round-trips, revises, and rejects wrong types offline", async () => {
  const result = await validateOffline();
  assert.equal(result.runtime_snapshot_round_trip, true);
  assert.equal(result.typed_fact_validation, true);
});

test("summary counts all calls and scores exact recall separately from state retention", () => {
  const row: ResultRow = { method: "full_history", conversation: "x", domain: "travel", turn: 5,
    question: "date?", expected_answer: "2027-01-02", predicted_answer: "2027-01-02", answer_correct: true,
    unsupported_answer: false, state_correct: 2, state_total: 3, critical_failure: false,
    confidence_brier_sum: 0.1, confidence_count: 2, fact_updates: [], summary_chars: 0,
    snapshot_chars: 0, context_chars: 100, usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 4, cache_write_tokens: 0 },
    estimated_usd: 0.00002, latency_ms: 100, facts_snapshot: {} };
  const summary = scoreSummary([row]);
  assert.equal((summary.full_history as any).correct_answers, 1);
  assert.equal((summary.full_history as any).facts_correct, 2);
  assert.equal((summary.rolling_summary as any).turns, 0);
});

test("exact factual scoring accepts canonical numeric and boolean strings", () => {
  assert.equal(exactAnswerMatches("180", 180), true);
  assert.equal(exactAnswerMatches("false", false), true);
  assert.equal(exactAnswerMatches("181", 180), false);
});

test("mocked pilot executes each method, persists resumable rows, and keeps secrets out of artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "belieflang-long-horizon-"));
  try {
    const output = join(dir, "pilot.json");
    const requests: any[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      return new Response(JSON.stringify({ status: "completed", usage: { input_tokens: 100, output_tokens: 20,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, output: [{ type: "message", phase: "final_answer",
        content: [{ type: "output_text", text: JSON.stringify({ answer: null, fact_updates: [],
          updated_summary: request.instructions.includes("rolling_summary") ? "state" : null }) }] }] }), { status: 200 });
    };
    const result = await runLongHorizon({ apiKey: "do-not-persist-this", output, fetchImpl, maxSpendUsd: 1, pilot: true });
    assert.equal(result.status, "completed");
    assert.equal(result.attempts, 30);
    assert.equal(result.successful_calls, 30);
    assert.equal(requests.length, 30);
    assert.equal(requests[0].input.includes("expected_answer"), false);
    assert.equal(requests.some((x: any) => x.instructions.includes("BeliefLang runtime snapshot")), true);
    assert.equal(result.ledger.every(x => x.status === "succeeded"), true);
    assert.equal((await readFile(output, "utf8")).includes("do-not-persist-this"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
