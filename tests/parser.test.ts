import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.js";

test("parses belief blocks and rules", () => {
  const statements = parse(`
belief intent {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

when confidence(intent.book_flight) > 0.7:
  call search_flights()
`);

  assert.equal(statements.length, 2);
  assert.equal(statements[0].kind, "belief");
  assert.equal(statements[1].kind, "rule");
});
