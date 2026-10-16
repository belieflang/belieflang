import test from "node:test";
import assert from "node:assert/strict";
import { decodeChatBeliefs, encodeChatBeliefs, decodeChatCode, encodeChatCode,
  type ChatCodeVariant } from "../src/chat_code.js";

test("five-character chat code round-trips known beliefs within quantization error", () => {
  const state = {
    intent: { book_flight: 0.82, book_hotel: 0.13, unknown: 0.05 },
    user: { budget_sensitive: 0.91, prefers_direct: 0.29 },
  };
  const code = encodeChatBeliefs(state);
  assert.equal(code.length, 5);
  const decoded = decodeChatBeliefs(code);
  for (const [name, expected] of Object.entries(state.intent)) {
    assert.ok(Math.abs(decoded.intent[name] - expected) < 0.03);
  }
  for (const [name, expected] of Object.entries(state.user)) {
    assert.ok(Math.abs(decoded.user[name] - expected) < 0.015);
  }
  assert.ok(Math.abs(Object.values(decoded.intent).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
});

test("chat code rejects invalid input", () => {
  assert.throws(() => decodeChatBeliefs("xx"));
  assert.throws(() => decodeChatBeliefs("00000"));
  assert.throws(() => encodeChatBeliefs({ intent: { book_flight: 1.1 }, user: {} }));
});

test("dominant codes restore the marked intent and preference probabilities", () => {
  const state = {
    intent: { book_flight: 0.49, book_hotel: 0.48, unknown: 0.03 },
    user: { budget_sensitive: 0.78, prefers_direct: 0.22 },
  };
  for (const [variant, length] of [["dominant_4", 4], ["dominant_5", 5], ["dominant_6", 6], ["labeled_7", 7], ["labeled_8", 8], ["labeled_9", 9], ["labeled_10", 10]] as Array<[ChatCodeVariant, number]>) {
    const code = encodeChatCode(state, variant);
    assert.equal(code.length, length);
    const decoded = decodeChatCode(code, variant);
    assert.equal(Object.entries(decoded.intent).sort((a, b) => b[1] - a[1])[0][0], "book_flight");
    assert.ok(Math.abs(decoded.user.budget_sensitive - state.user.budget_sensitive) < 0.015);
    assert.ok(Math.abs(decoded.user.prefers_direct - state.user.prefers_direct) < 0.015);
  }
});

test("selected labeled code retains secondary intent probability", () => {
  const state = {
    intent: { book_flight: 0.49, book_hotel: 0.48, unknown: 0.03 },
    user: { budget_sensitive: 0.78, prefers_direct: 0.22 },
  };
  const labeled = decodeChatCode(encodeChatCode(state, "labeled_10"), "labeled_10");
  const dominant = decodeChatCode(encodeChatCode(state, "dominant_4"), "dominant_4");
  assert.ok(Math.abs(labeled.intent.book_hotel - state.intent.book_hotel) < 0.02);
  assert.ok(Math.abs(dominant.intent.book_hotel - state.intent.book_hotel) > 0.2);
});
