import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { TypeScriptState } from "../src/viability/typescript_state.js";
import { FactMemory, type FactDelta } from "../src/fact_memory.js";
import { workflows, type TravelFacts } from "../src/viability/workflows.js";
import {
  APPROACHES,
  compareAll,
  compareWorkflow,
} from "../src/viability/compare.js";
import { QuietRuntime } from "../src/viability/belieflang_host.js";
import { parse } from "../src/parser.js";
const schema = {
  budget: "number",
  target: "string",
  active: "boolean",
} as const;
const source = (turn: number) => ({
  turn,
  id: `test:${turn}`,
  text: `message ${turn}`,
});
const set = (
  field: string,
  value: string | number | boolean,
  basis: "explicit" | "inferred" = "explicit",
  confidence = 0.9,
): FactDelta => ({ op: "set", field, value, basis, confidence });

test("three complete workflows agree across TS JSON, v3 library, actual DSL and demand-only oracle", async () => {
  const report = await compareAll();
  assert.equal(report.results.length, 12);
  for (const w of workflows) {
    const selected = report.results.filter((r) => r.workflow === w.id),
      reference = selected[0];
    for (const result of selected) {
      assert.equal(result.passed, true);
      assert.deepEqual(result.trace, reference.trace);
      assert.deepEqual(result.finalState, reference.finalState);
      assert.equal(result.liveCalls, 0);
    }
    assert.equal(reference.toolsExecuted, 3);
  }
});
test("unconditional DSL tool calls still cannot grant absent, revoked, expired or stale authority", async () => {
  for (const w of workflows) {
    const result = await compareWorkflow(
      w,
      "belieflang_dsl",
      "when true:\n  call execute_guarded()\n",
    );
    for (const event of result.trace.filter((t) => t.kind === "action")) {
      if (event.executed)
        assert.equal(event.reason, "verified_approval_and_current_constraints");
      if (
        [
          "approval_missing",
          "approval_revoked",
          "approval_expired_or_future",
        ].includes(event.reason ?? "") ||
        event.reason?.startsWith("stale_") ||
        event.reason?.startsWith("fact_not_confirmed")
      )
        assert.equal(event.executed, false);
    }
  }
});
test("plain TS validation is atomic, typed, enum-aware and rejects model source metadata", () => {
  const m = new TypeScriptState({
    ...schema,
    environment: { type: "string", enum: ["production", "staging"] },
  });
  m.applyExtracted([set("budget", 100)], source(1), { budget: 100 });
  const saved = m.snapshot();
  for (const patch of [
    [set("budget", "wrong")],
    [set("other", 4)],
    [set("budget", 3), set("budget", 4)],
    [{ ...set("budget", 4), sourceTurn: 999 }],
    [set("environment", "unknown")],
    [{ op: "clear", field: "budget", confidence: 1, basis: "inferred" }],
  ]) {
    assert.throws(() => m.applyExtracted(patch, source(2)));
    assert.deepEqual(m.snapshot(), saved);
  }
  const frozen = m.current;
  frozen.budget.value = 999;
  assert.equal(m.current.budget.value, 100);
});
test("ordinary JSON snapshot replays through validation and rejects invalid or duplicate journals", () => {
  const m = new TypeScriptState(schema);
  m.applyExtracted([set("budget", 100), set("target", "A")], source(1), {
    budget: 100,
    target: "A",
  });
  m.applyExtracted([set("budget", 200)], source(2));
  assert.deepEqual(TypeScriptState.restore(m.snapshot()).current, m.current);
  assert.equal(
    m.applyExtracted([set("target", "A"), set("budget", 100)], source(1), {
      target: "A",
      budget: 100,
    }).replayed,
    true,
  );
  const bad = m.snapshot();
  bad.inputs[0].patch[0] = { ...set("budget", "bad") };
  assert.throws(() => TypeScriptState.restore(bad));
  const duplicate = m.snapshot();
  duplicate.inputs.push(duplicate.inputs[0]);
  assert.throws(() => TypeScriptState.restore(duplicate));
});
test("100 deterministic updates agree with v3 on current state, provenance, history, no-ops and confidence policy", () => {
  const plain = new TypeScriptState(schema, {
      minConfidence: 0.8,
      maxHistory: 512,
    }),
    v3 = new FactMemory(schema, {
      policy: { inferredMinConfidence: 0.8 },
      maxHistory: 512,
    });
  for (let turn = 1; turn <= 100; turn++) {
    const field = ["budget", "target", "active"][turn % 3],
      value =
        field === "budget"
          ? turn % 5
          : field === "target"
            ? `T${turn % 4}`
            : turn % 2 === 0;
    const patch: FactDelta[] =
      turn % 7 === 0
        ? [{ op: "clear", field, confidence: 0.9, basis: "explicit" }]
        : [
            set(
              field,
              value,
              turn % 2 ? "inferred" : "explicit",
              turn % 4 ? 0.95 : 0.1,
            ),
          ];
    const verified: Record<string, string | number | boolean> =
      turn % 6 === 0 && patch[0].op === "set" ? { [field]: value } : {};
    assert.deepEqual(
      plain.applyExtracted(patch, source(turn), verified),
      v3.apply(patch, source(turn), verified),
    );
    assert.deepEqual(plain.current, v3.current);
    for (const mode of ["original", "previous", "changes"] as const)
      assert.deepEqual(plain.retrieve(field, mode), v3.retrieve(field, mode));
  }
  assert.deepEqual(
    TypeScriptState.restore(plain.snapshot()).current,
    plain.current,
  );
});
test("bounded history fails atomically and weak contradictory evidence invalidates a confirmed value", () => {
  const m = new TypeScriptState(schema, { maxHistory: 2, minConfidence: 0.8 });
  m.applyExtracted([set("budget", 100)], source(1), { budget: 100 });
  m.applyExtracted([set("budget", 200, "inferred", 0.01)], source(2));
  assert.equal(m.current.budget.status, "conflicting");
  const saved = m.snapshot();
  assert.throws(
    () => m.applyExtracted([set("budget", 300)], source(3)),
    /limit/,
  );
  assert.deepEqual(m.snapshot(), saved);
});
test("interpreter confidence typos silently read zero; property typos fail only at execution", async () => {
  const w = workflows[0],
    sourceText = await readFile("examples/viability/travel.bel", "utf8");
  const misspelled = sourceText.replace("intent.execute", "intent.exectue");
  const result = await compareWorkflow(w, "belieflang_dsl", misspelled);
  assert.equal(result.toolsExecuted, 0);
  assert.equal(result.passed, false);
  assert.doesNotThrow(() =>
    parse(sourceText.replace("ctx.facts.budget", "ctx.facts.budegt")),
  );
  await assert.rejects(
    compareWorkflow(
      w,
      "belieflang_dsl",
      sourceText.replace("ctx.facts.budget", "ctx.facts.budegt"),
    ),
    /unknown property/,
  );
});
// Compile-time contract evidence, not executed: wrong field/value pairs fail TypeScript.
function compileOnlyContracts() {
  const store = new TypeScriptState<TravelFacts>({
    destination: "string",
    budget: "number",
    departure_date: "string",
    direct: "boolean",
  });
  store.applyTyped(
    [
      {
        field: "budget",
        op: "set",
        // @ts-expect-error budget is a number, not a string
        value: "wrong",
        confidence: 1,
        basis: "explicit",
      },
    ],
    source(1),
  );
  // @ts-expect-error misspelled field
  store.get("budegt");
}

test("all approaches validate intent probability rather than advantaging interpreter normalization", async () => {
  const w = structuredClone(workflows[0]);
  w.steps[0].task!.intentConfidence = 1.5;
  for (const approach of APPROACHES)
    await assert.rejects(
      compareWorkflow(w, approach),
      /invalid intent probability/,
    );
});
test("long DSL predicates cannot simply wrap at a newline and need no new syntax to run these cases", async () => {
  const sourceText = await readFile("examples/viability/travel.bel", "utf8");
  assert.doesNotThrow(() => parse(sourceText));
  assert.throws(
    () =>
      parse(
        sourceText.replace(" && ctx.facts.budget", " &&\nctx.facts.budget"),
      ),
    SyntaxError,
  );
});

test("the shared guard grants standing permission, not single-use tool idempotency", async () => {
  const { AgentDecisionGuard } = await import("../src/agent_decisions.js");
  const memory = new FactMemory({ budget: "number" }),
    guard = new AgentDecisionGuard();
  memory.apply([set("budget", 100)], source(1), { budget: 100 });
  guard.record(memory, "book", true, ["budget"], source(2));
  let executed = 0;
  await guard.execute(memory, "book", { budget: 100 }, 2, () => {
    executed++;
  });
  await guard.execute(memory, "book", { budget: 100 }, 3, () => {
    executed++;
  });
  assert.equal(executed, 2);
});
