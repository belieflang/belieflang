import assert from "node:assert/strict";
import test from "node:test";
import { load } from "../src/incremental/fixtures.js";
import {
  evaluate,
  offlineReport,
  plan,
} from "../src/incremental/evaluation.js";
import { scriptedInference } from "../src/incremental/offline.js";
import { runCase, score, totals } from "../src/incremental/runner.js";
import {
  Authority,
  StructuredMemory,
  VerifiedV2Adapter,
} from "../src/incremental/memory.js";
import { main } from "../src/incremental/cli.js";
import {
  parseAnswers,
  parseUpdate,
  updateSchema,
} from "../src/incremental/protocol.js";
import type { FactDelta } from "../src/fact_memory.js";
import type { Inference, Request } from "../src/incremental/types.js";

test("new cases and both schedules agree with privately authored labels across all four methods", async () => {
  const r = await offlineReport();
  assert.equal(r.summary.length, 24);
  assert.equal(
    r.summary.reduce((s, r) => s + r.total, 0),
    1632,
  );
  assert.ok(
    r.summary.every(
      (r) =>
        r.accuracy === 1 &&
        r.routingCorrect === r.routingTotal &&
        r.unsafeExecutions === 0 &&
        r.falseDenials === 0,
    ),
  );
  assert.ok(
    r.summary.every(
      (r) =>
        r.cumulative.usd === null && r.cumulative.measuredTokens.input === null,
    ),
  );
  assert.equal(r.liveCalls, 0);
});
test("wire requests have no expected category, case ID, method label or private annotation", async () => {
  const seen: Request[] = [];
  const result = await evaluate(async (r) => {
    seen.push(r);
    return scriptedInference(r);
  });
  assert.ok(seen.length > 200);
  for (const r of seen) {
    const p = JSON.parse(r.prompt);
    assert.deepEqual(
      Object.keys(p).filter((k) =>
        /expected|gold|category|kind|method|safe/.test(k),
      ),
      [],
    );
    assert.equal(p.task, undefined);
    assert.equal(p.questions, undefined);
    assert.ok(!r.prompt.includes("private-gold"));
    assert.ok(!r.prompt.includes("full_history"));
    assert.ok(!r.prompt.includes("belieflang_v3"));
  }
  const { gold } = await load();
  const poisoned = structuredClone(gold);
  for (const entry of Object.values(poisoned))
    for (const a of entry.answers) a.status = "missing";
  assert.ok(score(result.runs, poisoned).some((s) => s.accuracy < 1)); // scoring can change; inference has already finished and received none of it.
});
test("identical structured-state contexts and prompts are used for JSON and v3", async () => {
  const { cases } = await load();
  const captured: Record<string, Request[]> = {};
  for (const method of ["plain_json", "belieflang_v3"] as const) {
    captured[method] = [];
    await runCase(cases[0], method, "dense", async (r) => {
      captured[method].push(r);
      return scriptedInference(r);
    });
  }
  assert.deepEqual(
    captured.plain_json.map(({ id, ...r }) => r),
    captured.belieflang_v3.map(({ id, ...r }) => r),
  );
});
test("host-only facts, local lookups and repeated typed decisions require no inference", async () => {
  const { cases } = await load();
  const c = structuredClone(cases[0]);
  c.events = c.events.slice(0, 2);
  c.sparseAfter = [1, 2];
  for (const method of [
    "full_history",
    "rolling_summary",
    "plain_json",
    "belieflang_v3",
  ] as const) {
    const r = await runCase(c, method, "dense", async () => {
      throw new Error("no inference should be dispatched");
    });
    assert.equal(r.calls.length, 0);
    assert.equal(r.checks[1].decision?.executed, true);
  }
});
test("ordinary unchanged messages are charged, exact adjacent duplicates are skipped equally, and decision dependencies are cached", async () => {
  const { cases } = await load();
  for (const method of [
    "plain_json",
    "belieflang_v3",
    "rolling_summary",
    "full_history",
  ] as const) {
    const r = await runCase(cases[0], method, "dense", scriptedInference);
    assert.equal(r.states[3].duplicateSkipped, true);
    assert.ok(!r.calls.some((c) => c.id.includes("/4/")));
    if (method !== "full_history")
      assert.ok(r.calls.some((c) => c.id.includes("/13/"))); // unchanged fact restatement was NOT supplied a gold skip flag.
    assert.equal(r.checks.find((c) => c.turn === 14)?.decision?.cacheHit, true); // auxiliary host change does not affect scoped action.
    assert.ok(r.decisionCacheHits > 0);
  }
});
test("routing is paid equally, and a wrong route cannot accidentally receive answer credit", async () => {
  const { cases, gold } = await load();
  const runs = [];
  for (const method of [
    "plain_json",
    "belieflang_v3",
    "full_history",
    "rolling_summary",
  ] as const) {
    const r = await runCase(cases[0], method, "sparse", scriptedInference);
    assert.equal(r.calls.filter((c) => c.kind === "route").length, 2);
    runs.push(r);
  }
  const r = structuredClone(runs[0]);
  const ch = r.checks.find((c) => c.route)!;
  ch.queries = [{ field: cases[0].flag, temporal: "current" }];
  const s = score([r], gold)[0];
  assert.equal(s.routingCorrect, 1);
  assert.equal(s.correct, s.total - 1);
});
test("destroying summary content damages scoring rather than recovering gold from an oracle", async () => {
  const { cases, gold } = await load();
  const r = await runCase(cases[0], "rolling_summary", "dense", async (req) =>
    req.kind === "summary"
      ? { output: { summary: "" }, usage: null, cost: null, latencyMs: 0 }
      : scriptedInference(req),
  );
  const s = score([r], gold)[0];
  assert.ok(s.correct < s.total);
  assert.ok(s.unsafeExecutions > 0);
});
test("v2 adapter cannot revive an old proof after conflict and value reversion; fresh host confirmation works without model output", async () => {
  const { cases } = await load(),
    c = cases[0];
  const adapters = [
    new VerifiedV2Adapter(c.schema),
    new StructuredMemory(c.schema, false),
    new StructuredMemory(c.schema, true),
  ];
  const set = (value: number) => ({
    field: c.numeric,
    op: "set" as const,
    value,
    basis: "explicit" as const,
    confidence: 1,
  });
  for (const adapter of adapters) {
    const src = (turn: number) => ({
      turn,
      id: `s${turn}`,
      text: "regression",
    });
    adapter.apply(
      [
        set(10),
        {
          field: c.flag,
          op: "set",
          value: true,
          basis: "explicit",
          confidence: 1,
        },
      ],
      src(1),
      { [c.numeric]: 10, [c.flag]: true },
    );
    adapter.apply([{ ...set(17), op: "conflict", basis: "inferred" }], src(2));
    adapter.apply([set(10)], src(3));
    const current = () =>
      adapter instanceof StructuredMemory
        ? {
            [c.numeric]: adapter.read({
              field: c.numeric,
              temporal: "current",
            }),
            [c.flag]: adapter.read({ field: c.flag, temporal: "current" }),
          }
        : Object.fromEntries(
            Object.entries(adapter.current).map(([f, a]) => [
              f,
              {
                value: a.value ?? null,
                status: a.status,
                sourceTurn: a.source.turn,
              },
            ]),
          );
    assert.equal(current()[c.numeric].status, "uncertain");
    const auth = new Authority();
    auth.verify({ [c.numeric]: 10, [c.flag]: true }, 1);
    auth.approve(true, { [c.numeric]: 10, [c.flag]: true });
    assert.equal(auth.check(c, current()).allowed, false);
    // The host event synthesizes a deterministic set + proof, with no inference call or unchanged-field requirement.
    adapter.verify({ [c.numeric]: 10 }, src(4));
    auth.verify({ [c.numeric]: 10 }, 4);
    assert.equal(auth.check(c, current()).allowed, false);
    auth.approve(true, { [c.numeric]: 10, [c.flag]: true });
    assert.equal(auth.check(c, current()).allowed, true);
    adapter.apply(
      [{ field: c.numeric, op: "clear", basis: "explicit", confidence: 1 }],
      src(5),
    );
    assert.equal(current()[c.numeric].status, "cleared");
    assert.equal(auth.check(c, current()).allowed, false);
  }
});
test("schema validation rejects unexpected proof metadata and impossible answer sources", async () => {
  const { cases } = await load(),
    c = cases[0];
  assert.throws(() =>
    parseUpdate(
      {
        deltas: [
          {
            field: c.numeric,
            op: "set",
            value: 10,
            basis: "explicit",
            confidence: 1,
            verified: true,
          },
        ],
      },
      c,
    ),
  );
  assert.throws(() =>
    parseAnswers(
      { answers: [{ value: 10, status: "confirmed", sourceTurn: 999 }] },
      [{ field: c.numeric, temporal: "current" }],
      c,
      4,
    ),
  );
  function check(s: any) {
    if (s.type === "object") assert.equal(s.additionalProperties, false);
    for (const v of Object.values(s))
      if (v && typeof v === "object")
        Array.isArray(v)
          ? v.forEach((x) => typeof x === "object" && check(x))
          : check(v);
  }
  check(updateSchema(c.schema));
});
test("known failed calls remain in cumulative accounting and cost per correct includes maintenance and routing", async () => {
  const { cases, gold } = await load();
  const infer: Inference = async (r) =>
    r.kind === "update"
      ? {
          error: "HTTP 500",
          usage: {
            input: 100,
            output: 10,
            cached: 0,
            cacheWrite: 0,
            reasoning: 0,
          },
          cost: { lower: 0.001, upper: 0.001 },
          latencyMs: 20,
        }
      : {
          ...(await scriptedInference(r)),
          usage: {
            input: 50,
            output: 5,
            cached: 0,
            cacheWrite: 0,
            reasoning: 0,
          },
          cost: { lower: 0.001, upper: 0.001 },
          latencyMs: 10,
        };
  const r = await runCase(cases[0], "plain_json", "sparse", infer),
    s = score([r], gold)[0];
  assert.equal(s.cumulative.failedCalls, 8);
  assert.equal(s.cumulative.measuredTokens.input, 900);
  assert.ok(s.cumulative.usd!.upper > 0.009);
  assert.ok(s.cumulative.latencyMs! >= 160);
  assert.equal(s.usdPerCorrect?.upper, s.cumulative.usd!.upper / s.correct);
});
test("cost plan is a $2 proposal with assumptions and no claimed provider measurements", async () => {
  const r = await offlineReport(),
    p = await plan(r.runs);
  assert.equal(p.maximumCombinedUSD, 2);
  assert.equal(p.smokeCapUSD + p.pilotCapUSD, 2);
  assert.equal(p.automaticRetries, 0);
  assert.equal(p.completionGuaranteed, false);
  assert.ok(p.scenarios.every((s) => s.totalProjectedUSD < p.pilotCapUSD));
  assert.equal(p.plannedCalls, 284);
});
test("local smoke command rejects absent authorization before looking up credentials", async () => {
  let read = 0;
  await assert.rejects(
    main(["--smoke"], () => {
      read++;
      throw new Error("must not inspect key");
    }),
    /authorization/,
  );
  assert.equal(read, 0);
});

test("a new typed receipt invalidates a previously missing historical lookup for every method", async () => {
  const { cases } = await load(),
    c = structuredClone(cases[0]);
  c.events = [
    c.events[0],
    c.events[2],
    {
      id: "ask_before",
      type: "ask",
      text: "Which loading bay were we first assigned, before it was withdrawn?",
    },
    { id: "new_host", type: "host", facts: { [c.auxiliary]: "D9" } },
    {
      id: "ask_after",
      type: "ask",
      text: "Which loading bay were we first assigned, before it was withdrawn?",
    },
  ];
  c.sparseAfter = [];
  for (const method of [
    "full_history",
    "rolling_summary",
    "plain_json",
    "belieflang_v3",
  ] as const) {
    const r = await runCase(c, method, "sparse", scriptedInference);
    assert.equal(r.checks[0].answers[0]?.status, "missing");
    assert.deepEqual(r.checks[1].answers[0], {
      value: "D9",
      status: "confirmed",
      sourceTurn: 4,
    });
  }
});
