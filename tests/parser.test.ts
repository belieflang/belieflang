import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.js";

test("parses statements in source order with belief modifiers", () => {
  const statements = parse(`
let threshold = 0.7

belief intent exclusive closed {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

belief destination exclusive open {
  berlin: 0.61
  paris: 0.22
}

when confidence(intent.book_flight) > threshold:
  call rank_flights()
`);

  assert.equal(statements.length, 4);
  assert.equal(statements[0].kind, "let");
  assert.equal(statements[1].kind, "belief");
  assert.equal(statements[2].kind, "belief");
  assert.equal(statements[3].kind, "rule");

  if (statements[1].kind !== "belief" || statements[2].kind !== "belief") {
    assert.fail("Expected belief statements");
  }

  assert.equal(statements[1].cardinality, "exclusive");
  assert.equal(statements[1].domain, "closed");
  assert.equal(statements[2].cardinality, "exclusive");
  assert.equal(statements[2].domain, "open");
});

test("parses compound conditions with precedence and grouping", () => {
  const statements = parse(`
belief intent {
  book_flight: 0.82
  book_hotel: 0.18
}

let flights = call search_flights()

when confidence(intent.book_flight) > 0.7 && (flights.count > 0 || !false):
  ask_user("I found flight options.")
`);

  const rule = statements.at(-1);
  assert.ok(rule && rule.kind === "rule");

  if (!rule || rule.kind !== "rule") {
    assert.fail("Expected rule statement");
  }

  assert.equal(rule.condition.kind, "and");
  if (rule.condition.kind !== "and") {
    assert.fail("Expected top-level and condition");
  }

  assert.equal(rule.condition.left.kind, "comparison");
  assert.equal(rule.condition.right.kind, "or");
});
