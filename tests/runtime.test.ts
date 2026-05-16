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

test("computes normalized entropy", () => {
  const runtime = new BeliefRuntime();

  runtime.loadBelief({
    kind: "belief",
    name: "intent",
    values: {
      a: 0.5,
      b: 0.5,
    },
  });

  assert.equal(runtime.entropy("intent"), 1);
});
