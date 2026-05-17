import assert from "node:assert/strict";
import test from "node:test";
import { BeliefRuntime } from "../src/runtime.js";

test("normalizes belief distributions", () => {
  const runtime = new BeliefRuntime();

  runtime.loadBelief({
    kind: "belief",
    name: "intent",
    values: {
      flight: 2,
      hotel: 1,
    },
  });

  assert.equal(runtime.confidence("intent.flight"), 2 / 3);
  assert.equal(runtime.confidence("intent.hotel"), 1 / 3);
});

test("stores literal variables", async () => {
  const runtime = new BeliefRuntime();

  await runtime.assign("threshold", {
    kind: "number",
    value: 0.7,
  });

  assert.equal(runtime.getVars().threshold, 0.7);
});

test("stores tool return values", async () => {
  const runtime = new BeliefRuntime({
    custom_tool: () => ({ count: 2 }),
  });

  await runtime.assign("result", {
    kind: "call_expr",
    toolName: "custom_tool",
  });

  assert.deepEqual(runtime.getVars().result, { count: 2 });
  assert.equal(runtime.resolvePath("result.count"), 2);
});
