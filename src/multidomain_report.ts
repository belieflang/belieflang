// Assemble explicitly selected, complete workflow passes after an interrupted experiment.
// Raw failed reports remain immutable and their discarded usage is included as overhead.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { conversations, domains } from "./multidomain_cases.js";
import { summarize, WORKFLOWS, type Row, type Workflow, type Pricing } from "./multidomain_benchmark.js";

export type SourceReport = {
  benchmark: string; status: string; model: string; prompt_variant?: string; suite?: string; fixture_sha256: string; implementation_sha256: string;
  pricing_usd_per_million: Pricing | null; completed_calls: number; rows: Row[]; error?: string;
};
export type Selection = { source: number; repetition: number; as_repetition: number; workflow: Workflow };
export type Manifest = {
  sources: { file: string; failed_requests_with_unreported_usage: number }[];
  selections: Selection[];
};

export function assembleReport(manifest: Manifest, sources: SourceReport[]) {
  if (sources.length !== manifest.sources.length || !sources.length) throw new Error("source count mismatch");
  const first = sources[0];
  const knownFailures = manifest.sources.reduce((sum, source, i) => {
    const n = source.failed_requests_with_unreported_usage;
    if (!Number.isSafeInteger(n) || n < 0 || (sources[i].status === "completed" && n !== 0)) {
      throw new Error("invalid failed request accounting");
    }
    return sum + n;
  }, 0);
  for (const source of sources) {
    if ((source.suite ?? "original") !== "original") throw new Error("recovery assembler supports the original suite only");
    if ((source.prompt_variant ?? "original") !== (first.prompt_variant ?? "original")) throw new Error("inconsistent source prompt_variant");
    if (!["completed", "failed"].includes(source.status) || source.benchmark !== "multidomain-beliefs-v1" ||
        source.completed_calls !== source.rows.length) throw new Error("invalid or unfinished source report");
    for (const key of ["model", "fixture_sha256", "implementation_sha256", "pricing_usd_per_million"] as const) {
      if (JSON.stringify(source[key]) !== JSON.stringify(first[key])) throw new Error(`inconsistent source ${key}`);
    }
  }
  const selected: Row[] = [];
  const seenSources = new Set<string>();
  const destinations = new Set<string>();
  for (const selection of manifest.selections) {
    const { source, repetition, as_repetition: rep, workflow } = selection;
    if (!Number.isSafeInteger(source) || !sources[source] || ![1, 2, 3].includes(rep) ||
        !Number.isSafeInteger(repetition) || repetition < 1 || !WORKFLOWS.includes(workflow)) {
      throw new Error("invalid selection");
    }
    const origin = `${source}:${repetition}:${workflow}`, destination = `${rep}:${workflow}`;
    if (seenSources.has(origin) || destinations.has(destination)) throw new Error("duplicate selected workflow");
    seenSources.add(origin); destinations.add(destination);
    const rows = sources[source].rows.filter(r => r.repetition === repetition && r.workflow === workflow);
    if (rows.length !== 100) throw new Error(`incomplete workflow: ${origin}`);
    for (const [i, row] of rows.entries()) {
      const conversation = conversations[Math.floor(i / 10)];
      if (row.conversation !== conversation.id || row.domain !== conversation.domain || row.turn !== i % 10 + 1) {
        throw new Error(`invalid workflow ordering: ${origin}`);
      }
      selected.push({ ...row, repetition: rep });
    }
  }
  if (destinations.size !== 9) throw new Error("select exactly three complete passes of all three workflows");
  const allRows = sources.flatMap(s => s.rows);
  const discardedRows = sources.flatMap((s, index) => s.rows.filter(r =>
    !seenSources.has(`${index}:${r.repetition}:${r.workflow}`)));
  const group = (rows: Row[]) => Object.fromEntries(WORKFLOWS.map(w => [w, summarize(rows.filter(r => r.workflow === w))]));
  const accounting = (rows: Row[]) => {
    const { turns, usage, estimated_usd } = summarize(rows);
    return { turns, usage, estimated_usd };
  };
  const results = group(selected);
  const comparisons: Record<string, number> = {};
  for (const baseline of ["full_history", "provider_history"] as const) {
    const base = results[baseline], snapshot = results.belief_snapshot;
    comparisons[`snapshot_vs_${baseline}_token_reduction_percent`] = 100 * (1 - snapshot.usage.total_tokens / base.usage.total_tokens);
    comparisons[`snapshot_vs_${baseline}_accuracy_change_percentage_points`] = 100 * (snapshot.exact_match_rate! - base.exact_match_rate!);
    if (base.estimated_usd && snapshot.estimated_usd !== null) {
      comparisons[`snapshot_vs_${baseline}_cost_reduction_percent`] = 100 * (1 - snapshot.estimated_usd / base.estimated_usd);
    }
  }
  return {
    benchmark: "multidomain-beliefs-v1", status: sources.some(s => s.status === "failed") ? "completed_with_workflow_restart" : "completed", created_at: new Date().toISOString(),
    model: first.model, prompt_variant: first.prompt_variant ?? "original", suite: "original", fixture_sha256: first.fixture_sha256, implementation_sha256: first.implementation_sha256,
    pricing_usd_per_million: first.pricing_usd_per_million, runs: 3, workflows: WORKFLOWS,
    completed_calls: selected.length, expected_calls: 900,
    methodology: "Three complete passes per workflow, selected by the explicit provenance manifest. Failed workflow prefixes discarded from scored comparisons; their usage remains in execution_accounting. No turn-level cherry-picking or imputation. Source statuses and the execution ledger disclose any workflow restarts. Failed request usage may be unavailable, so execution cost can be a lower bound. See raw reports for prompts, timing, order, and per-turn data.",
    provenance: manifest,
    source_statuses: sources.map((source, index) => ({ file: manifest.sources[index].file, status: source.status,
      completed_calls: source.completed_calls, ...(source.error ? { error: source.error } : {}) })),
    execution_accounting: {
      scored_calls: selected.length, recorded_successful_calls: allRows.length,
      discarded_successful_calls: discardedRows.length, failed_requests_with_unreported_usage: knownFailures,
      total_attempted_calls: allRows.length + knownFailures,
      all_recorded_calls: accounting(allRows), discarded_recorded_calls: accounting(discardedRows),
      cost_note: "All-attempt cost includes discarded successful calls; excludes unknown charges for failed requests. Workflow comparison costs use only complete selected passes.",
    },
    results, by_domain: Object.fromEntries(Object.keys(domains).map(d => [d, group(selected.filter(r => r.domain === d))])),
    by_repetition: Object.fromEntries([1, 2, 3].map(rep => [rep, group(selected.filter(r => r.repetition === rep))])),
    comparisons,
  };
}

async function main(): Promise<void> {
  const [manifestPath, outputPath, ...extra] = process.argv.slice(2);
  if (!manifestPath || !outputPath || extra.length) throw new Error("usage: multidomain_report.js <manifest.json> <output.json>");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const raw = await Promise.all(manifest.sources.map(s => readFile(resolve(dirname(manifestPath), s.file), "utf8")));
  const report = assembleReport(manifest, raw.map(s => JSON.parse(s) as SourceReport));
  const sourceHashes = raw.map((s, i) => ({ file: manifest.sources[i].file, sha256: createHash("sha256").update(s).digest("hex") }));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify({ ...report, source_sha256: sourceHashes }, null, 2) + "\n");
  console.log(JSON.stringify({ status: report.status, completed_calls: report.completed_calls, output: outputPath }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `error: ${error.message}` : "error: report assembly failed");
    process.exitCode = 1;
  });
}
