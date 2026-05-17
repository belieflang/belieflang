import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.js";

test("parses belief blocks, variables, and rules", () => {
  const statements = parse(`
let threshold = 0.7

belief intent {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

let flights = call search_flights()

when confidence(intent.book_flight) > threshold:
  call rank_flights()

when flights.count > 0:
  ask_user("I found flight options.")
`);

  assert.equal(statements.length, 5);
  assert.equal(statements[0].kind, "belief");
  assert.equal(statements[1].kind, "let");
});
