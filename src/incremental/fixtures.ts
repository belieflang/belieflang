import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateFactSchema, validateFactValue } from "../fact_memory.js";
import { exact, parseAnswers } from "./protocol.js";
import { queries, SCHEDULES, type Case, type Gold } from "./types.js";
import type { Config } from "./live.js";
export async function load() {
  const suite = JSON.parse(
    await readFile("benchmarks/incremental/cases.json", "utf8"),
  );
  const gold: Gold = JSON.parse(
    await readFile("benchmarks/incremental/private-gold.json", "utf8"),
  );
  const config: Config = JSON.parse(
    await readFile("benchmarks/incremental/config.json", "utf8"),
  );
  assert.equal(suite.version, 1);
  assert.equal(suite.cases.length, 3);
  const ids = new Set();
  for (const c of suite.cases as Case[]) {
    assert.ok(!ids.has(c.id));
    ids.add(c.id);
    validateFactSchema(c.schema);
    assert.equal(c.schema[c.numeric], "number");
    assert.equal(c.schema[c.flag], "boolean");
    assert.equal(c.schema[c.auxiliary], "string");
    assert.ok(Number.isFinite(c.maximum));
    assert.ok(c.events.length >= 20);
    assert.ok(c.sparseAfter.length > 0);
    assert.ok(
      c.sparseAfter.every(
        (t) => Number.isSafeInteger(t) && t >= 1 && t <= c.events.length,
      ),
    );
    const events = new Set<string>();
    for (const e of c.events) {
      assert.ok(!events.has(e.id));
      events.add(e.id);
      if (e.type === "chat" || e.type === "ask") {
        exact(e, ["id", "type", "text"]);
        assert.ok(e.text.length > 0);
      } else if (e.type === "host") {
        exact(e, ["id", "type", "facts"]);
        for (const [f, v] of Object.entries(e.facts))
          validateFactValue(c.schema, f, v);
      } else {
        exact(e, ["id", "type", "allowed", "values"]);
        assert.equal(e.type, "approval");
        assert.equal(typeof e.allowed, "boolean");
        assert.deepEqual(
          Object.keys(e.values).sort(),
          [c.numeric, c.flag].sort(),
        );
        for (const [f, v] of Object.entries(e.values))
          validateFactValue(c.schema, f, v);
      }
    }
  }
  assert.deepEqual(config.methods, [
    "full_history",
    "rolling_summary",
    "plain_json",
    "belieflang_v3",
  ]);
  assert.deepEqual(config.schedules, ["sparse", "dense"]);
  assert.equal(config.repetitions, 1);
  const expectedKeys: string[] = [];
  for (const c of suite.cases as Case[])
    for (const schedule of SCHEDULES)
      for (const [index, event] of c.events.entries()) {
        const turn = index + 1,
          checkpoint =
            event.type !== "ask" &&
            (schedule === "dense" || c.sparseAfter.includes(turn));
        if (!checkpoint && event.type !== "ask") continue;
        const id = `${schedule}/${c.id}/${turn}`,
          g = gold[id];
        expectedKeys.push(id);
        assert.ok(g, `missing label ${id}`);
        exact(
          g,
          checkpoint
            ? ["queries", "answers", "allowed"]
            : ["queries", "answers"],
        );
        if (checkpoint) {
          assert.deepEqual(g.queries, queries(c));
          assert.equal(typeof g.allowed, "boolean");
        } else {
          assert.equal(g.queries.length, 1);
          assert.ok(Object.hasOwn(c.schema, g.queries[0].field));
          assert.ok(["current", "original"].includes(g.queries[0].temporal));
        }
        parseAnswers({ answers: g.answers }, g.queries, c, turn);
      }
  assert.deepEqual(
    Object.keys(gold).sort(),
    expectedKeys.sort(),
    "unused or missing private labels",
  );
  return { cases: suite.cases as Case[], gold, config };
}
