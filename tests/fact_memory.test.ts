import assert from "node:assert/strict";
import test from "node:test";
import { FactMemory, type FactDelta } from "../src/fact_memory.js";
import { BeliefRuntime } from "../src/runtime.js";
import { AgentDecisionGuard } from "../src/agent_decisions.js";
const source = (turn: number) => ({
  turn,
  id: `turn:${turn}`,
  text: `message ${turn}`,
});
const set = (
  field: string,
  value: string | number | boolean,
  confidence = 0.9,
  basis: "explicit" | "inferred" = "explicit",
): FactDelta => ({ op: "set", field, value, confidence, basis });
const schema = {
  destination: "string",
  budget: "number",
  direct: "boolean",
} as const;

test("delta changes only the named field; replay and no-op preserve provenance", () => {
  const m = new FactMemory(schema);
  m.apply([set("destination", "Lisbon"), set("budget", 1500)], source(1));
  const old = m.current;
  m.apply([set("budget", 1700)], source(2));
  assert.deepEqual(m.current.destination, old.destination);
  assert.equal(m.current.budget.value, 1700);
  const snapshot = m.snapshot();
  assert.equal(m.apply([set("budget", 1700)], source(2)).replayed, true);
  assert.deepEqual(m.snapshot(), snapshot);
  assert.equal(m.apply([set("budget", 1700, 0.1)], source(3)).unchanged, 1);
  assert.deepEqual(m.current.budget, snapshot.current.budget);
  assert.equal(m.snapshot().history.length, 3);
  assert.throws(() => m.apply([set("budget", 1)], source(2)), /replay/);
});
test("batch validation is atomic and model metadata is rejected", () => {
  const m = new FactMemory(schema),
    before = m.snapshot();
  for (const bad of [
    [set("budget", "wrong")],
    [set("unknown", 2)],
    [set("budget", 1), set("budget", 2)],
    [{ ...set("budget", 1), sourceTurn: 200 }],
    [{ op: "clear", field: "budget", confidence: 0.9, basis: "inferred" }],
    [set("budget", Infinity)],
    [set("budget", 1, NaN)],
  ]) {
    assert.throws(() => m.apply(bad as FactDelta[], source(1)));
    assert.deepEqual(m.snapshot(), before);
  }
  assert.throws(() =>
    m.apply([set("budget", 10)], source(1), { destination: 10 }),
  );
});
test("explicit negation, reversal, conflict resolution, historical retrieval", () => {
  const m = new FactMemory(schema);
  m.apply([set("budget", 1500), set("direct", true)], source(1), {
    budget: 1500,
    direct: true,
  });
  m.apply([set("direct", false)], source(2));
  assert.equal(m.current.direct.value, false);
  m.apply(
    [{ op: "clear", field: "destination", confidence: 0.9, basis: "explicit" }],
    source(3),
  );
  assert.equal(m.current.destination.status, "cleared");
  m.apply([set("budget", 2000, 1, "inferred")], source(4));
  assert.equal(m.current.budget.status, "conflicting");
  assert.deepEqual(m.current.budget.candidates, [1500, 2000]);
  m.apply([set("budget", 1600, 0.05)], source(5));
  assert.equal(m.current.budget.value, 1600);
  assert.equal(m.current.budget.status, "uncertain");
  assert.equal(m.retrieve("budget", "original")[0].value, 1500);
  assert.equal(m.retrieve("budget", "previous")[0].value, 1500);
  assert.equal(m.retrieve("budget", "changes", 2).length, 2);
  assert.equal(m.retrieve("budget", "original")[0].source.turn, 1);
  const ctx = JSON.stringify(m.context());
  assert.ok(
    !ctx.includes("message") &&
      !ctx.includes("revision") &&
      !ctx.includes("history"),
  );
});
test("confidence policy defers inferred changes but never locks explicit revisions", () => {
  const m = new FactMemory(schema, { policy: { inferredMinConfidence: 0.8 } });
  m.apply([set("budget", 1500)], source(1), { budget: 1500 });
  assert.equal(m.current.budget.status, "confirmed");
  assert.equal(
    m.apply([set("destination", "Porto", 0.7, "inferred")], source(2)).deferred,
    1,
  );
  assert.equal(m.current.budget.value, 1500);
  assert.equal(m.snapshot().history.at(-1)!.proposal!.field, "destination");
  const guard = new AgentDecisionGuard();
  guard.record(m, "book", true, ["budget"], source(2));
  m.apply([set("budget", 1600, 0.01, "inferred")], source(3));
  assert.equal(m.current.budget.status, "conflicting");
  assert.equal(guard.explain(m, "book", { budget: 1500 }, 3).allowed, false);
  assert.deepEqual(FactMemory.restore(m.snapshot()).snapshot(), m.snapshot());
  m.apply([set("budget", 1600, 0.1)], source(4));
  assert.equal(m.current.budget.value, 1600);
  assert.equal(m.current.budget.status, "uncertain");
});
test("snapshot round trip, tamper rejection, bounded history and defensive copies", () => {
  const m = new FactMemory(schema, { maxHistory: 1 });
  m.apply([set("budget", 2)], source(1));
  const saved = m.snapshot();
  assert.deepEqual(FactMemory.restore(saved).snapshot(), saved);
  const bad = structuredClone(saved);
  bad.current.budget.value = 10;
  assert.throws(() => FactMemory.restore(bad), /disagrees/);
  assert.throws(() => m.apply([set("budget", 3)], source(2)), /limit/);
  assert.deepEqual(m.snapshot(), saved);
  saved.current.budget.value = 90;
  assert.equal(m.current.budget.value, 2);
});
test("v1/v2 migrations retain beliefs, mark evidence uncertain and do not invent originals", () => {
  const rt = new BeliefRuntime();
  const v1 = rt.getBeliefSnapshot();
  const migrated = FactMemory.restore(v1);
  assert.deepEqual(
    FactMemory.restore(migrated.snapshot()).snapshot(),
    migrated.snapshot(),
  );
  rt.declareFacts(schema);
  rt.mergeFactPatch({
    budget: { operation: "set", value: 1500, confidence: 1, sourceTurn: 8 },
  });
  const v2 = FactMemory.restore(rt.getLongHorizonSnapshot());
  assert.equal(v2.current.budget.value, 1500);
  assert.equal(v2.current.budget.status, "uncertain");
  assert.deepEqual(v2.retrieve("budget", "original"), []);
  assert.equal(v2.snapshot().historyComplete, false);
  assert.deepEqual(FactMemory.restore(v2.snapshot()).snapshot(), v2.snapshot());
  assert.equal(new BeliefRuntime().memory, undefined);
  assert.ok(new BeliefRuntime({}, { memory: { schema } }).memory);
});
test("deterministic tools fail closed, reject stale/revoked approval, expose evidence", async () => {
  const m = new FactMemory(schema),
    guard = new AgentDecisionGuard();
  let calls = 0;
  const tool = () => ++calls;
  assert.equal(
    (await guard.execute(m, "book", { budget: 2 }, 1, tool)).decision.reason,
    "approval_missing",
  );
  m.apply([set("budget", 2, 1)], source(1));
  guard.record(m, "book", true, ["budget"], source(2));
  assert.match(
    guard.explain(m, "book", { budget: 2 }, 3).reason,
    /not_confirmed/,
  );
  m.apply([set("budget", 2)], source(3), { budget: 2 });
  assert.match(
    guard.explain(m, "book", { budget: 2 }, 3).reason,
    /stale_approval/,
  );
  guard.record(m, "book", true, ["budget"], source(4), 6);
  assert.equal(
    (await guard.execute(m, "book", { budget: 2 }, 4, tool)).result,
    1,
  );
  assert.equal(guard.explain(m, "book", { budget: 2 }, 7).allowed, false);
  assert.equal(guard.explain(m, "book", { budget: 3 }, 5).allowed, false);
  guard.record(m, "book", false, ["budget"], source(5));
  assert.equal(
    guard.explain(m, "book", { budget: 2 }, 6).reason,
    "approval_revoked",
  );
  assert.equal(
    guard.explain(m, "restart_prod", { budget: 2 }, 6).allowed,
    false,
  );
  assert.equal(calls, 1);
  assert.ok(guard.history()[0].source.id);
});

test("replay identity ignores property order, and restore rejects missing policy/bounds", () => {
  const m = new FactMemory(schema),
    s = source(1);
  m.apply([set("budget", 1500), set("destination", "Lisbon")], s, {
    budget: 1500,
    destination: "Lisbon",
  });
  assert.equal(
    m.apply([set("destination", "Lisbon"), set("budget", 1500)], s, {
      destination: "Lisbon",
      budget: 1500,
    }).replayed,
    true,
  );
  for (const key of ["policy", "maxHistory"] as const) {
    const bad = m.snapshot();
    delete (bad as any)[key];
    assert.throws(() => FactMemory.restore(bad));
  }
});
test("combined runtime snapshots capture numeric beliefs and attach restored memory", () => {
  const rt = new BeliefRuntime({}, { memory: { schema } });
  rt.loadBelief({
    kind: "belief",
    name: "intent",
    cardinality: "exclusive",
    domain: "closed",
    values: { flight: 0.7, hotel: 0.3 },
  });
  rt.memory!.apply([set("budget", 1500)], source(1));
  const saved = rt.getMemorySnapshot();
  assert.equal(saved.beliefs.intent.values.flight, 0.7);
  const restored = new BeliefRuntime({}, { memory: FactMemory.restore(saved) });
  restored.loadBeliefSnapshot({ version: 1, beliefs: saved.beliefs });
  assert.deepEqual(restored.getMemorySnapshot(), saved);
  assert.throws(() => new BeliefRuntime().getMemorySnapshot(), /not enabled/);
  const migrated = FactMemory.restore(rt.getBeliefSnapshot(), schema);
  migrated.apply([set("budget", 7)], source(1));
  assert.equal(migrated.current.budget.value, 7);
});
test("legacy migration handles insertion order different from source chronology", () => {
  const rt = new BeliefRuntime();
  rt.declareFacts(schema);
  rt.mergeFactPatch({
    destination: {
      operation: "set",
      value: "Lisbon",
      confidence: 1,
      sourceTurn: 9,
    },
    budget: { operation: "set", value: 1500, confidence: 1, sourceTurn: 2 },
  });
  const migrated = FactMemory.restore(rt.getLongHorizonSnapshot());
  assert.deepEqual(
    migrated.snapshot().history.map((e) => e.source.turn),
    [2, 9],
  );
  assert.deepEqual(
    FactMemory.restore(migrated.snapshot()).snapshot(),
    migrated.snapshot(),
  );
});
test("missing, cleared and conflicting constraints deny even a high-confidence approval scope", () => {
  for (const mode of ["missing", "clear", "conflict"] as const) {
    const m = new FactMemory(schema),
      guard = new AgentDecisionGuard();
    if (mode !== "missing")
      m.apply([set("budget", 1)], source(1), { budget: 1 });
    if (mode === "clear")
      m.apply(
        [{ op: "clear", field: "budget", basis: "explicit", confidence: 1 }],
        source(2),
      );
    if (mode === "conflict")
      m.apply(
        [
          {
            op: "conflict",
            field: "budget",
            value: 2,
            basis: "inferred",
            confidence: 1,
          },
        ],
        source(2),
      );
    guard.record(m, "book", true, ["budget"], source(3));
    assert.match(
      guard.explain(m, "book", { budget: 1 }, 3).reason,
      /not_confirmed/,
    );
  }
});

test("host IDs cannot alter prototypes; no-op replay handles ordinary prototype names", () => {
  const m = new FactMemory(schema);
  assert.throws(
    () => m.apply([], { turn: 1, id: "__proto__", text: "bad" }),
    /host source/,
  );
  const s = { turn: 1, id: "toString", text: "no change" };
  m.apply([], s);
  assert.equal(m.apply([], s).replayed, true);
  m.apply([set("budget", 1500)], source(2));
  const bad = m.snapshot();
  bad.receipts = [];
  assert.throws(() => FactMemory.restore(bad), /receipt/);
});
test("guard rejects malformed confirmed facts and future evidence, without leaking mutable approvals", () => {
  const g = new AgentDecisionGuard(),
    m = new FactMemory(schema);
  m.apply([set("budget", 1500)], source(1), { budget: 1500 });
  g.record(m, "book", true, ["budget"], source(2));
  const decision = g.explain(m, "book", { budget: 1500 }, 2);
  decision.sources[0].turn = 999;
  assert.equal(g.explain(m, "book", { budget: 1500 }, 2).allowed, true);
  for (const mutation of [
    { value: null },
    { source: { turn: 10, id: "future" } },
    { revision: NaN },
  ]) {
    const current = m.current;
    Object.assign(current.budget, mutation);
    assert.match(
      g.explain({ current }, "book", { budget: 1500 }, 2).reason,
      /invalid_or_future/,
    );
  }
});
