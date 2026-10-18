import assert from "node:assert/strict";
import test from "node:test";
import { auditRecords, readRecords } from "./audit-incremental-pilot.mjs";

test("saved pilot independently reconciles without network access", () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("network forbidden");
  };
  try {
    const result = auditRecords(readRecords());
    assert.equal(result.semanticFailures.length, 14);
    assert.equal(result.transportTotals.calls, 297);
    assert.equal(result.coverage.observedAnswers, 1632);
    assert.equal(result.structuredEquivalence.length, 60);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("changed raw usage cannot hide behind saved cost/usage totals", () => {
  const data = readRecords();
  for (const records of [data.journal.entries, data.report.allAttempts]) {
    records[1].providerUsage.input_tokens++;
    records[1].providerUsage.total_tokens++;
  }
  assert.throws(() => auditRecords(data), /provider usage/);
});

test("a missing attempt and an altered accuracy summary are rejected", () => {
  const missing = readRecords();
  missing.journal.entries.pop();
  assert.throws(() => auditRecords(missing));
  const inaccurate = readRecords();
  inaccurate.report.summary[0].correct++;
  assert.throws(() => auditRecords(inaccurate), /independent score/);
});

test("unsafe recorded decisions cannot be accepted as ground truth", () => {
  const data = readRecords();
  const check = data.report.runs[0].checks.find(
    (c) => c.decision && !c.decision.executed,
  );
  check.decision.executed = true;
  assert.throws(() => auditRecords(data), /independent safety/);
});

test("a missing semantic-validation failure is detected", () => {
  const data = readRecords();
  const call = data.report.runs.flatMap((r) => r.calls).find((c) => c.error);
  delete call.error;
  assert.throws(() => auditRecords(data), /run vs journal/);
});
