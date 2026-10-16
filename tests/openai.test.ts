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
