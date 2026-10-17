import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { conversations, domains, validateFixtures } from "../src/multidomain_cases.js";
import { holdoutConversations, validateHoldout } from "../src/multidomain_holdout.js";
import { estimateCost, instructions, parseArgs, pricingFromEnv, runWorkflow, summarize, workflowOrder, WORKFLOWS, type Row } from "../src/multidomain_benchmark.js";

test("attached fixtures contain 100 turns, 10 independent conversations and 5 domains", () => {
  assert.deepEqual(validateFixtures(), { conversations: 10, turns: 100, domains: ["travel", "shopping", "support", "planning", "writing"] });
  const corrupt = structuredClone(conversations);
  corrupt[1].id = corrupt[0].id;
  assert.throws(() => validateFixtures(corrupt), /duplicate/);
  corrupt[1].id = "unique";
  corrupt[0].turns[0][1] = "A12";
  assert.throws(() => validateFixtures(corrupt), /invalid turn/);
  corrupt[0].turns[0][1] = "A11";
  corrupt[0].domain = "missing";
  assert.throws(() => validateFixtures(corrupt), /invalid conversation/);
});

test("CLI rejects incomplete arguments and rotates each strategy through each position", () => {
  for (const args of [["--runs"], ["--output"], ["--output", "--validate"], ["--runs", "0"], ["--runs", "1.5"],
    ["--prompt", "bad"], ["--suite", "bad"], ["--prompt"], ["--suite"], ["--workflows", "full_history,full_history"], ["--workflows", "nope"], ["--unknown"]]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(["--runs", "3"]).runs, 3);
  for (let position = 0; position < 3; position++) {
    assert.equal(new Set([1, 2, 3].map(r => workflowOrder([...WORKFLOWS], r)[position])).size, 3);
  }
});

test("pricing separates uncached input, cache reads, cache writes and output", () => {
  const usage = { input_tokens: 1000, cached_input_tokens: 400, cache_write_tokens: 100, output_tokens: 200, total_tokens: 1200 };
  assert.equal(estimateCost(usage, null), null);
  assert.equal(estimateCost(usage, { input: 2, cached_input: 0.5, cache_write: 2.5, output: 8, source: "test" }), 0.00305);
  assert.equal(pricingFromEnv({}), null);
  assert.throws(() => pricingFromEnv({ MODEL_INPUT_USD_PER_M: "2" }), /four nonnegative rates/);
  assert.throws(() => pricingFromEnv({ MODEL_INPUT_USD_PER_M: "NaN" }), /four nonnegative rates/);
  assert.deepEqual(pricingFromEnv({ MODEL_INPUT_USD_PER_M: "0", MODEL_CACHED_INPUT_USD_PER_M: "0",
    MODEL_CACHE_WRITE_USD_PER_M: "0", MODEL_OUTPUT_USD_PER_M: "0" }),
    { input: 0, cached_input: 0, cache_write: 0, output: 0, source: "Explicit environment rates; USD per million tokens" });
});

test("all strategies use common schemas, isolate conversations and avoid leaking labels/history into snapshots", async () => {
  for (const cases of [conversations, holdoutConversations]) for (const prompt of ["original", "continuity"] as const) for (const workflow of WORKFLOWS) {
    const turnsPerConversation = cases[0].turns.length;
    const totalTurns = cases.length * turnsPerConversation;
    let call = 0;
    let lastIntent = "";
    let previousId = "";
    const rows: Row[] = [];
    await runWorkflow(workflow, 1, { apiKey: "test", model: "test-model", pricing: null, rows, prompt, cases,
      fetchImpl: async (_url, init) => {
        const conversation = cases[Math.floor(call / turnsPerConversation)];
        const domain = domains[conversation.domain];
        const turn = call % turnsPerConversation;
        const body = JSON.parse(String(init?.body));
        const input = JSON.parse(body.input);
        assert.equal(body.instructions, instructions(domain, prompt));
        assert.deepEqual(Object.keys(body.text.format.schema.properties.intent.properties), domain.intents);
        assert.deepEqual(body.text.format.schema.required, ["intent", ...domain.flags]);
        assert.equal(body.store, workflow === "provider_history");
        assert.equal(init?.signal instanceof AbortSignal, true);
        if (workflow === "full_history") {
          assert.deepEqual(input, { messages: conversation.turns.slice(0, turn + 1).map(t => t[0]) });
          assert.equal(body.previous_response_id, undefined);
        } else {
          assert.equal(input.new_message, conversation.turns[turn][0]);
          assert.equal(input.messages, undefined);
          if (workflow === "provider_history") {
            assert.equal(body.previous_response_id, turn ? previousId : undefined);
            assert.equal(input.previous_beliefs, undefined);
          } else {
            assert.equal(body.previous_response_id, undefined);
            if (!turn) assert.deepEqual(input.previous_beliefs, {});
            else {
              assert.equal(input.previous_beliefs.intent.values[lastIntent], 1);
              assert.equal(input.previous_beliefs.user.values[domain.flags[0]], 0.7);
            }
          }
        }
        // Deliberately unrelated to fixture labels: exercises real scoring rather than echoing gold.
        lastIntent = domain.intents[turn % 3];
        previousId = `response_${++call}`;
        return new Response(JSON.stringify({ id: previousId, status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            intent: Object.fromEntries(domain.intents.map(k => [k, Number(k === lastIntent)])),
            [domain.flags[0]]: 0.7, [domain.flags[1]]: 0.2,
          }) }] }], usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30, cache_write_tokens: 10 } },
        }));
      },
    });
    assert.equal(call, totalTurns);
    assert.equal(rows.length, totalTurns);
    assert.equal(rows[0].predicted.intent, "book_flight");
    assert.equal(rows[1].predicted.intent, "book_hotel");
    assert.equal(rows[0].flag_correct, Number(rows[0].expected.budget_sensitive === true) + Number(rows[0].expected.prefers_direct === false));
    assert.equal(rows[0].exact_match, false);
    assert.equal(rows[0].beliefs.user.budget_sensitive, 0.7);
    const summary = summarize(rows);
    assert.equal(summary.usage.total_tokens, totalTurns * 120);
    assert.equal(summary.usage.cached_input_tokens, totalTurns * 30);
    assert.equal(summary.usage.cache_write_tokens, totalTurns * 10);
    assert.equal(summary.estimated_usd, null);
    assert.equal(summary.exact_match_turns, rows.filter(r => r.exact_match).length);
  }
});

test("failure stops workflow without skipping or fabricating turns", async () => {
  const rows: Row[] = [];
  let calls = 0;
  await assert.rejects(runWorkflow("full_history", 2, { apiKey: "secret", model: "test-model", pricing: null, rows,
    fetchImpl: async () => { calls++; return new Response("", { status: 429 }); },
  }), /full_history repetition 2 travel_milan turn 1:.*HTTP 429/);
  assert.equal(calls, 1);
  assert.equal(rows.length, 0);
  assert.equal(summarize(rows).exact_match_rate, null);
});

test("offline CLI works without a key and a missing key writes an explicit failed report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "belieflang-multidomain-"));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "" };
    for (const key of Object.keys(env)) if (key.startsWith("MODEL_")) delete env[key];
    const validate = spawnSync(process.execPath, ["dist/src/multidomain_benchmark.js", "--validate"], { env, encoding: "utf8" });
    assert.equal(validate.status, 0, validate.stderr);
    assert.equal(JSON.parse(validate.stdout).turns, 100);
    const output = join(directory, "nested", "result.json");
    const failed = spawnSync(process.execPath, ["dist/src/multidomain_benchmark.js", "--runs", "3", "--output", output], { env, encoding: "utf8" });
    assert.equal(failed.status, 1);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.completed_calls, 0);
    assert.equal(report.expected_calls, 900);
    assert.match(report.error, /OPENAI_API_KEY missing/);
    assert.deepEqual(report.comparisons, {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("continuity prompt preserves the recorded original variant and selects explicit experiment conditions", async () => {
  const original = instructions(domains.writing, "original");
  const continuity = instructions(domains.writing, "continuity");
  assert.equal(instructions(domains.writing), original);
  const baseline = JSON.parse(await readFile("benchmarks/results/multidomain-2026-10-17-attempt-1-failed.json", "utf8"));
  for (const [key, domain] of Object.entries(domains)) {
    assert.equal(instructions(domain, "original"), baseline.instructions_by_domain[key]);
  }
  assert.match(continuity, /Intent persists across follow-up/);
  assert.match(continuity, /standalone unrelated request or explicit pause/);
  assert.equal(continuity.includes("CURRENT primary request"), false);
  assert.equal(parseArgs(["--prompt", "continuity", "--suite", "holdout"]).suite, "holdout");
});

test("fresh synthetic suite has new messages, nonterminal unrelated questions and task switches", () => {
  assert.equal(validateHoldout().turns, 30);
  const originalMessages = new Set(conversations.flatMap(c => c.turns.map(t => t[0])));
  for (const c of holdoutConversations) {
    assert.equal(c.turns.length, 6);
    assert.ok(c.turns.every(t => !originalMessages.has(t[0])));
    const unknown = c.turns.findIndex(t => t[1][0] === "U");
    assert.ok(unknown > 0 && unknown < 5);
    assert.ok(c.turns.some(t => t[1][0] === "A") && c.turns.some(t => t[1][0] === "B"));
  }
});
