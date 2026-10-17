import assert from "node:assert/strict";
import test from "node:test";
import { conversations, domains, labelFor } from "../src/multidomain_cases.js";
import { WORKFLOWS, type Row, type Workflow } from "../src/multidomain_benchmark.js";
import { assembleReport, type Manifest, type SourceReport } from "../src/multidomain_report.js";

function mockPass(repetition: number, workflow: Workflow): Row[] {
  return conversations.flatMap(c => c.turns.map((_, index) => {
    const expected = labelFor(c, index), d = domains[c.domain];
    return { repetition, workflow, conversation: c.id, domain: c.domain, turn: index + 1,
      expected, predicted: expected, exact_match: true, flag_correct: 2,
      beliefs: { intent: Object.fromEntries(d.intents.map(k => [k, Number(k === expected.intent)])),
        user: Object.fromEntries(d.flags.map(k => [k, Number(expected[k])])) },
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, cached_input_tokens: 3, cache_write_tokens: 1 },
      latency_ms: 100, estimated_usd: null };
  }));
}
function mockExperiment(): { sources: SourceReport[]; manifest: Manifest } {
  const source = (rows: Row[], status: string): SourceReport => ({ benchmark: "multidomain-beliefs-v1", status,
    model: "mock-model", fixture_sha256: "mock-fixture", implementation_sha256: "mock-code",
    pricing_usd_per_million: null, completed_calls: rows.length, rows });
  const sources = [
    source(mockPass(1, "full_history").slice(0, 27), "failed"),
    source([...WORKFLOWS.flatMap(w => mockPass(1, w)), ...WORKFLOWS.flatMap(w => mockPass(2, w)),
      ...mockPass(3, "belief_snapshot"), ...mockPass(3, "full_history").slice(0, 14)], "failed"),
    source([...mockPass(1, "full_history"), ...mockPass(1, "provider_history")], "completed"),
  ];
  const manifest: Manifest = {
    sources: sources.map((s, i) => ({ file: `mock-${i}.json`, failed_requests_with_unreported_usage: s.status === "failed" ? 1 : 0 })),
    selections: [1, 2, 3].flatMap(rep => WORKFLOWS.map(workflow => ({
      source: rep === 3 && workflow !== "belief_snapshot" ? 2 : 1,
      repetition: rep === 3 && workflow !== "belief_snapshot" ? 1 : rep,
      as_repetition: rep, workflow,
    }))),
  };
  return { sources, manifest };
}

test("recovered reports select complete passes and include every discarded prefix in overhead", () => {
  const { sources, manifest } = mockExperiment();
  const report = assembleReport(manifest, sources);
  assert.equal(report.status, "completed_with_workflow_restart");
  assert.equal(report.completed_calls, 900);
  assert.equal(report.execution_accounting.recorded_successful_calls, 941);
  assert.equal(report.execution_accounting.discarded_successful_calls, 41);
  assert.equal(report.execution_accounting.failed_requests_with_unreported_usage, 2);
  assert.equal(report.execution_accounting.total_attempted_calls, 943);
  assert.equal(report.execution_accounting.all_recorded_calls.usage.total_tokens, 941 * 12);
  assert.equal(report.execution_accounting.discarded_recorded_calls.usage.total_tokens, 41 * 12);
  for (const w of WORKFLOWS) assert.equal(report.results[w].turns, 300);
  assert.equal(report.comparisons.snapshot_vs_full_history_token_reduction_percent, 0);
});

test("recovered reports reject partial, duplicate, unfinished and inconsistent selections", () => {
  const { sources, manifest } = mockExperiment();
  const partial = structuredClone(manifest);
  partial.selections[0].source = 0;
  assert.throws(() => assembleReport(partial, sources), /incomplete workflow/);
  const duplicate = structuredClone(manifest);
  duplicate.selections[1] = duplicate.selections[0];
  assert.throws(() => assembleReport(duplicate, sources), /duplicate/);
  const inconsistent = structuredClone(sources);
  inconsistent[2].model = "different-model";
  assert.throws(() => assembleReport(manifest, inconsistent), /inconsistent source model/);
  const running = structuredClone(sources);
  running[2].status = "running";
  assert.throws(() => assembleReport(manifest, running), /unfinished/);
  assert.throws(() => assembleReport({ ...manifest, selections: manifest.selections.slice(0, 8) }, sources), /exactly three complete/);
});
