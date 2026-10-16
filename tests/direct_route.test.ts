import assert from "node:assert/strict";
import test from "node:test";
import { directRoute } from "../src/direct_route.js";

test("direct GPT baseline returns action and provider token usage", async () => {
  let request: Record<string, unknown> | undefined;
  const result = await directRoute("Book a flight", {
    apiKey: "test-key",
    fetchImpl: async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: '{"action":"search_flights"}' }] }],
        usage: { input_tokens: 110, output_tokens: 15 },
      }));
    },
  });
  assert.equal(request?.model, "gpt-6-luna");
  assert.equal(request?.input, "Book a flight");
  assert.deepEqual(result, { action: "search_flights", usage: { input_tokens: 110, output_tokens: 15 } });
});

test("direct GPT baseline rejects actions outside the route contract", async () => {
  await assert.rejects(directRoute("Book a flight", {
    apiKey: "test-key",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: '{"action":"delete_all"}' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })),
  }), /invalid action/);
});
