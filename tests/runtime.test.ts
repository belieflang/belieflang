import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.js";
import { BeliefRuntime } from "../src/runtime.js";

test("normalizes belief distributions", () => {
  const runtime = new BeliefRuntime();

  runtime.loadBelief({
    kind: "belief",
    name: "intent",
    cardinality: "exclusive",
    domain: "closed",
    values: {
      flight: 2,
      hotel: 1,
    },
  });

  assert.equal(runtime.confidence("intent.flight"), 2 / 3);
  assert.equal(runtime.confidence("intent.hotel"), 1 / 3);
});

test("keeps unlisted mass for open exclusive beliefs", () => {
  const runtime = new BeliefRuntime();

  runtime.loadBelief({
    kind: "belief",
    name: "destination",
    cardinality: "exclusive",
    domain: "open",
    values: {
      berlin: 0.7,
      paris: 0.1,
    },
  });

  assert.equal(runtime.confidence("destination.berlin"), 0.7);
  assert.ok(Math.abs(runtime.confidence("destination.other") - 0.2) < 1e-9);
});

test("supports multi beliefs without normalization", () => {
  const runtime = new BeliefRuntime();

  runtime.loadBelief({
    kind: "belief",
    name: "constraint",
    cardinality: "multi",
    domain: "closed",
    values: {
      cheap: 0.84,
      direct: 0.71,
    },
  });

  assert.equal(runtime.confidence("constraint.cheap"), 0.84);
  assert.equal(runtime.confidence("constraint.direct"), 0.71);
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

test("evaluates compound rule conditions", async () => {
  let callCount = 0;

  const runtime = new BeliefRuntime({
    search_flights: () => ({ count: 2 }),
    rank_flights: () => {
      callCount += 1;
      return null;
    },
  });

  const statements = parse(`
let threshold = 0.7

belief intent exclusive closed {
  book_flight: 0.82
  book_hotel: 0.18
}

let flights = call search_flights()

when confidence(intent.book_flight) > threshold && (flights.count > 0 || entropy(intent) < 0.2):
  call rank_flights()
`);

  await runtime.run(statements);
  assert.equal(callCount, 1);
});

test("emits trace output when enabled", async () => {
  const logs: string[] = [];
  const originalLog = console.log;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  try {
    const runtime = new BeliefRuntime(
      {
        rank_flights: () => null,
      },
      { trace: true },
    );

    const statements = parse(`
belief intent {
  book_flight: 0.9
  book_hotel: 0.1
}

when confidence(intent.book_flight) > 0.7:
  call rank_flights()
`);

    await runtime.run(statements);
  } finally {
    console.log = originalLog;
  }

  assert.ok(logs.some((line) => line.includes("[trace] rule 1")));
  assert.ok(logs.some((line) => line.includes("action call rank_flights()")));
});
