import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIInferAdapter, type OpenAIUsage } from "../src/openai.js";
import { BeliefRuntime } from "../src/runtime.js";

test("OpenAI structured response feeds beliefs and reports token usage", async () => {
  let request: Record<string, unknown> | undefined;
  let usage: OpenAIUsage | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    return new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({
        intent: { book_flight: 0.8, book_hotel: 0.1, unknown: 0.1 },
        budget_sensitive: 0.9,
        prefers_direct: 0.85,
      }) }] }],
      usage: { input_tokens: 140, output_tokens: 35, total_tokens: 175 },
    }), { status: 200 });
  };

  const runtime = new BeliefRuntime({}, {
    inferBeliefs: createOpenAIInferAdapter({ apiKey: "test-key", fetchImpl, onUsage: (value) => { usage = value; } }),
  });
  await runtime.assign("message", { kind: "string", value: "cheap direct flight" });
  await runtime.infer({ kind: "identifier", name: "message" });

  assert.equal(request?.model, "gpt-6-luna");
  assert.equal(request?.input, "cheap direct flight");
  assert.equal(runtime.confidence("intent.book_flight"), 0.8);
  assert.equal(runtime.confidence("user.budget_sensitive"), 0.9);
  assert.equal(runtime.confidence("user.prefers_direct"), 0.85);
  assert.deepEqual(usage, { input_tokens: 140, output_tokens: 35 });
});

test("OpenAI HTTP errors do not expose the API key", async () => {
  const infer = createOpenAIInferAdapter({
    apiKey: "private-key",
    fetchImpl: async () => new Response("invalid key", { status: 401 }),
  });
  await assert.rejects(Promise.resolve(infer("flight", { observations: [], state: {}, vars: {} })), /HTTP 401/);
});

test("OpenAI rejects malformed belief values", async () => {
  const infer = createOpenAIInferAdapter({
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
        intent: { book_flight: 2, book_hotel: 0, unknown: 0 },
        budget_sensitive: 0.5,
        prefers_direct: 0.5,
      }) }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  });
  await assert.rejects(Promise.resolve(infer("flight", { observations: [], state: {}, vars: {} })), /invalid OpenAI probability/);
});

test("OpenAI reports cache usage and compaction when continuing a stored response", async () => {
  let request: Record<string, unknown> | undefined;
  let usage: OpenAIUsage | undefined;
  let responseId: string | undefined;
  let compactionItems = -1;
  const infer = createOpenAIInferAdapter({
    apiKey: "test-key",
    store: true,
    previousResponseId: "resp_previous",
    compactThreshold: 1000,
    onUsage: (value) => { usage = value; },
    onResponseId: (value) => { responseId = value; },
    onCompactionItems: (value) => { compactionItems = value; },
    fetchImpl: async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        id: "resp_current", status: "completed",
        output: [{ type: "compaction" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({
          intent: { book_flight: 1, book_hotel: 0, unknown: 0 },
          budget_sensitive: 0.5, prefers_direct: 0.5,
        }) }] }],
        usage: { input_tokens: 1400, output_tokens: 80,
          input_tokens_details: { cached_tokens: 500, cache_write_tokens: 200 } },
      }));
    },
  });
  await infer("new turn", { observations: [], state: {}, vars: {} });
  assert.equal(request?.store, true);
  assert.equal(request?.previous_response_id, "resp_previous");
  assert.deepEqual(request?.context_management, [{ type: "compaction", compact_threshold: 1000 }]);
  assert.deepEqual(usage, { input_tokens: 1400, output_tokens: 80, cached_input_tokens: 500, cache_write_tokens: 200 });
  assert.equal(responseId, "resp_current");
  assert.equal(compactionItems, 1);
});

test("OpenAI custom domain rejects invalid distributions, fields and cache accounting", async () => {
  for (const [output, details, pattern] of [
    [{ intent: { api: 0.9, database: 0.9, unknown: 0 }, urgent: 1, restart: 0 }, {}, /sum to 1/],
    [{ intent: { api: 1, database: 0, unknown: 0 }, urgent: 1, restart: 0, extra: 1 }, {}, /unexpected/],
    [{ intent: { api: 1, database: 0, unknown: 0 }, urgent: 1, restart: 0 }, { cached_tokens: 9, cache_write_tokens: 9 }, /exceed input/],
    [{ intent: { api: 1, database: 0, unknown: 0 }, urgent: 1, restart: 0 }, { cached_tokens: -1 }, /token count/],
  ] as const) {
    const infer = createOpenAIInferAdapter({ apiKey: "test", beliefFields: { intents: ["api", "database", "unknown"], flags: ["urgent", "restart"] },
      fetchImpl: async () => new Response(JSON.stringify({ status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
        usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: details },
      })),
    });
    await assert.rejects(Promise.resolve(infer("test", { observations: [], state: {}, vars: {} })), pattern);
  }
});

test("OpenAI parses only the final answer and still charges commentary output tokens", async () => {
  let usage: OpenAIUsage | undefined;
  const final = { intent: { book_flight: 1, book_hotel: 0, unknown: 0 }, budget_sensitive: 1, prefers_direct: 0 };
  const infer = createOpenAIInferAdapter({ apiKey: "test", onUsage: u => { usage = u; },
    fetchImpl: async () => new Response(JSON.stringify({ status: "completed", output: [
      { type: "message", phase: "commentary", content: [{ type: "output_text", text: JSON.stringify(final) + " Vega." }] },
      { type: "message", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify(final) }] },
    ], usage: { input_tokens: 468, output_tokens: 81 } })),
  });
  const runtime = new BeliefRuntime({}, { inferBeliefs: infer });
  await runtime.assign("message", { kind: "string", value: "continue task" });
  await runtime.infer({ kind: "identifier", name: "message" });
  assert.equal(runtime.confidence("intent.book_flight"), 1);
  assert.deepEqual(usage, { input_tokens: 468, output_tokens: 81 });
});

test("OpenAI rejects commentary-only, ambiguous final and malformed final responses", async () => {
  const valid = JSON.stringify({ intent: { book_flight: 1, book_hotel: 0, unknown: 0 }, budget_sensitive: 0, prefers_direct: 0 });
  const message = (phase: string, text: string) => ({ type: "message", phase, content: [{ type: "output_text", text }] });
  for (const [output, error] of [
    [[message("commentary", valid)], /exactly one final/],
    [[message("final_answer", valid), message("final_answer", valid)], /exactly one final/],
    [[message("commentary", valid), message("final_answer", "invalid")], /invalid JSON/],
  ] as const) {
    const infer = createOpenAIInferAdapter({ apiKey: "test", fetchImpl: async () => new Response(JSON.stringify({
      status: "completed", output, usage: { input_tokens: 10, output_tokens: 5 },
    })) });
    await assert.rejects(Promise.resolve(infer("test", { state: {}, observations: [], vars: {} })), error);
  }
});
