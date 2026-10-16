import assert from "node:assert/strict";
import test from "node:test";
import { createJevInferAdapter, type JevUsage } from "../src/jev.js";
import { directJevRoute } from "../src/jev_route.js";
import { createJevDeltaAdapter } from "../src/jev_delta.js";
import { BeliefRuntime } from "../src/runtime.js";

test("Jev response feeds the runtime and reports provider token usage", async () => {
  let request: Record<string, unknown> | undefined;
  let usage: JevUsage | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-key");
    return new Response(JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        intent: { type: "choice", choice: "book_flight", confidence: 0.9, probabilities: { book_flight: 0.8, book_hotel: 0.1, unknown: 0.1 } },
        budget_sensitive: { type: "noul", noul: 0.9 },
        prefers_direct: { type: "noul", noul: 0.85 },
      },
      usage: { input_tokens: 120, output_tokens: 12 },
    }), { status: 200 });
  };

  const runtime = new BeliefRuntime({}, {
    inferBeliefs: createJevInferAdapter({ apiKey: "test-key", fetchImpl, onUsage: (value) => { usage = value; } }),
  });
  await runtime.assign("message", { kind: "string", value: "cheap direct flight" });
  await runtime.infer({ kind: "identifier", name: "message" });

  assert.equal(request?.state, "cheap direct flight");
  assert.equal(request?.model, "jev-latest");
  assert.equal(runtime.confidence("intent.book_flight"), 0.8);
  assert.equal(runtime.confidence("user.budget_sensitive"), 0.9);
  assert.equal(runtime.confidence("user.prefers_direct"), 0.85);
  assert.deepEqual(usage, { input_tokens: 120, output_tokens: 12 });
});

test("Jev HTTP errors do not expose the API key", async () => {
  const infer = createJevInferAdapter({
    apiKey: "private-key",
    fetchImpl: async () => new Response("invalid key", { status: 401 }),
  });
  await assert.rejects(Promise.resolve(infer("flight", { observations: [], state: {}, vars: {} })), /HTTP 401/);
});

test("Jev rejects malformed probabilities", async () => {
  const infer = createJevInferAdapter({
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      answers: {
        intent: { type: "choice", probabilities: { book_flight: 2, book_hotel: 0, unknown: 0 } },
        budget_sensitive: { type: "noul", noul: 0.5 },
        prefers_direct: { type: "noul", noul: 0.5 },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  });
  await assert.rejects(Promise.resolve(infer("flight", { observations: [], state: {}, vars: {} })), /invalid Jev probability/);
});

test("Jev chat mode sends previous beliefs and only the new message", async () => {
  let request: Record<string, unknown> | undefined;
  const infer = createJevInferAdapter({
    apiKey: "test-key",
    chatSnapshot: true,
    fetchImpl: async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        answers: {
          intent: { type: "choice", choice: "book_hotel", confidence: 0.9,
            probabilities: { book_flight: 0.1, book_hotel: 0.9, unknown: 0 } },
          budget_sensitive: { type: "noul", noul: 0.8 },
          prefers_direct: { type: "noul", noul: 0.2 },
        },
        usage: { input_tokens: 140, output_tokens: 40 },
      }));
    },
  });
  await infer(JSON.stringify({ previous_beliefs: { intent: { values: { book_flight: 1 } } }, new_message: "Hotel instead" }),
    { observations: [], state: {}, vars: {} });
  assert.equal((request?.state as Record<string, unknown>).new_message, "Hotel instead");
  assert.ok((request?.state as Record<string, unknown>).previous_beliefs);
});

test("Jev full-history mode sends the ordered messages", async () => {
  let request: Record<string, unknown> | undefined;
  const infer = createJevInferAdapter({ apiKey: "test-key", chatHistory: true,
    fetchImpl: async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        answers: {
          intent: { type: "choice", probabilities: { book_flight: 0, book_hotel: 1, unknown: 0 } },
          budget_sensitive: { type: "noul", noul: 0.2 },
          prefers_direct: { type: "noul", noul: 0.1 },
        },
        usage: { input_tokens: 240, output_tokens: 35 },
      }));
    } });
  await infer(JSON.stringify({ messages: ["Find a flight", "Switch to a hotel"] }),
    { observations: [], state: {}, vars: {} });
  assert.deepEqual((request?.state as Record<string, unknown>).messages,
    ["Find a flight", "Switch to a hotel"]);
});

test("direct Jev routing chooses one action and reports usage", async () => {
  let request: Record<string, unknown> | undefined;
  const result = await directJevRoute(["Find a flight", "Find a train instead"], {
    apiKey: "test-key", fetchImpl: async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        answers: { next_action: { type: "choice", probabilities: {
          search_budget_direct_flights: 0.02, search_budget_flights: 0.02,
          search_direct_flights: 0.02, search_flights: 0.02,
          search_budget_hotels: 0.02, search_hotels: 0.02, ask_user: 0.88,
        } } },
        usage: { input_tokens: 100, output_tokens: 10 },
      }));
    },
  });
  assert.equal(result.action, "ask_user");
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 10 });
  assert.deepEqual((request?.state as Record<string, unknown>).messages,
    ["Find a flight", "Find a train instead"]);
});

test("Jev change-only update applies explicit preferences and preserves the rest", async () => {
  let request: Record<string, unknown> | undefined;
  const infer = createJevDeltaAdapter({ apiKey: "test-key", fetchImpl: async (_input, init) => {
    request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      answers: {
        intent: { type: "choice", probabilities: { book_flight: 0.9, book_hotel: 0.05, unknown: 0.05 } },
        budget_change: { type: "choice", probabilities: { set_yes: 0.1, set_no: 0.1, keep: 0.8 } },
        direct_change: { type: "choice", probabilities: { set_yes: 0.8, set_no: 0.1, keep: 0.1 } },
      },
      usage: { input_tokens: 120, output_tokens: 20 },
    }));
  } });
  const patch = await infer(JSON.stringify({
    previous_beliefs: {
      intent: { values: { book_flight: 0.1, book_hotel: 0.9, unknown: 0 } },
      user: { values: { budget_sensitive: 0.8, prefers_direct: 0 } },
    },
    new_message: "Switch to a nonstop flight",
  }), { observations: [], state: {}, vars: {} });
  assert.deepEqual(request?.state, {
    previous_intent: "book_hotel",
    new_message: "Switch to a nonstop flight",
  });
  assert.deepEqual((patch.user as { values: Record<string, number> }).values,
    { budget_sensitive: 0.8, prefers_direct: 1 });
});
