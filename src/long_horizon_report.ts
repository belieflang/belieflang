import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { LONG_HORIZON_METHODS, scoreSummary, type LongHorizonRun } from "./long_horizon_benchmark.js";

type ReportOptions = { result: string; plan: string; output: string; charts: string };
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function pctDifference(a: number, b: number): number { return 100 * (a - b) / b; }
function color(method: string): string {
  return method === "full_history" ? "#2563eb" : method === "rolling_summary" ? "#d97706" : "#059669";
}
function xml(value: string): string { return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[c]!); }
function accuracyCostSvg(points: Array<{ method: string; accuracy: number; cost_usd: number }>): string {
  const w = 760, h = 470, left = 90, right = 40, top = 50, bottom = 75;
  const x = (v: number) => left + (v / 0.045) * (w - left - right);
  const y = (v: number) => h - bottom - ((v - 0.8) / 0.2) * (h - top - bottom);
  const names: Record<string, string> = { full_history: "Full history", rolling_summary: "Rolling summary", belieflang: "BeliefLang" };
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="white"/><text x="${w/2}" y="28" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="600">Exact recall accuracy vs estimated cost</text>`;
  for (let i = 0; i <= 4; i++) {
    const acc = 0.8 + i * 0.05, yy = y(acc);
    svg += `<line x1="${left}" y1="${yy}" x2="${w-right}" y2="${yy}" stroke="#e5e7eb"/><text x="${left-12}" y="${yy+4}" text-anchor="end" font-family="sans-serif" font-size="12">${(acc*100).toFixed(0)}%</text>`;
  }
  for (let i = 0; i <= 9; i++) {
    const cost = i * 0.005, xx = x(cost);
    svg += `<line x1="${xx}" y1="${top}" x2="${xx}" y2="${h-bottom}" stroke="#f1f5f9"/><text x="${xx}" y="${h-bottom+22}" text-anchor="middle" font-family="sans-serif" font-size="11">$${cost.toFixed(3)}</text>`;
  }
  svg += `<line x1="${left}" y1="${top}" x2="${left}" y2="${h-bottom}" stroke="#334155"/><line x1="${left}" y1="${h-bottom}" x2="${w-right}" y2="${h-bottom}" stroke="#334155"/><text x="${w/2}" y="${h-18}" text-anchor="middle" font-family="sans-serif" font-size="13">Estimated USD, including reserved incomplete-call cost</text><text transform="translate(22 ${h/2}) rotate(-90)" text-anchor="middle" font-family="sans-serif" font-size="13">Exact factual recall</text>`;
  for (const p of points) {
    const cx = x(p.cost_usd), cy = y(p.accuracy), c = color(p.method);
    svg += `<circle cx="${cx}" cy="${cy}" r="7" fill="${c}" stroke="white" stroke-width="2"/><text x="${cx+11}" y="${cy-10}" font-family="sans-serif" font-size="12" fill="${c}">${xml(names[p.method])}</text>`;
  }
  return svg + "</svg>\n";
}
function costLengthSvg(series: Record<string, Array<{ conversation_turn: number; cumulative_cost_usd: number }>>): string {
  const w = 760, h = 470, left = 78, right = 155, top = 48, bottom = 70, max = 0.04;
  const x = (v: number) => left + ((v - 1) / 19) * (w - left - right);
  const y = (v: number) => h - bottom - (v / max) * (h - top - bottom);
  const names: Record<string, string> = { full_history: "Full history", rolling_summary: "Rolling summary", belieflang: "BeliefLang" };
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="white"/><text x="${w/2}" y="27" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="600">Cumulative estimated cost by conversation turn</text>`;
  for (let i = 0; i <= 4; i++) {
    const value = i * 0.01, yy = y(value);
    svg += `<line x1="${left}" y1="${yy}" x2="${w-right}" y2="${yy}" stroke="#e5e7eb"/><text x="${left-10}" y="${yy+4}" text-anchor="end" font-family="sans-serif" font-size="12">$${value.toFixed(2)}</text>`;
  }
  for (const turn of [1, 5, 10, 15, 20]) {
    const xx = x(turn); svg += `<line x1="${xx}" y1="${top}" x2="${xx}" y2="${h-bottom}" stroke="#f1f5f9"/><text x="${xx}" y="${h-bottom+22}" text-anchor="middle" font-family="sans-serif" font-size="12">${turn}</text>`;
  }
  svg += `<line x1="${left}" y1="${top}" x2="${left}" y2="${h-bottom}" stroke="#334155"/><line x1="${left}" y1="${h-bottom}" x2="${w-right}" y2="${h-bottom}" stroke="#334155"/><text x="${(left+w-right)/2}" y="${h-17}" text-anchor="middle" font-family="sans-serif" font-size="13">Turn number within each conversation</text><text transform="translate(20 ${h/2}) rotate(-90)" text-anchor="middle" font-family="sans-serif" font-size="13">Cumulative USD across all 10 conversations</text>`;
  let legendY = 90;
  for (const method of LONG_HORIZON_METHODS) {
    const values = series[method]; const points = values.map(p => `${x(p.conversation_turn)},${y(p.cumulative_cost_usd)}`).join(" ");
    svg += `<polyline points="${points}" fill="none" stroke="${color(method)}" stroke-width="3"/><line x1="${w-right+15}" y1="${legendY}" x2="${w-right+40}" y2="${legendY}" stroke="${color(method)}" stroke-width="3"/><text x="${w-right+47}" y="${legendY+4}" font-family="sans-serif" font-size="12">${xml(names[method])}</text>`;
    legendY += 24;
  }
  return svg + "</svg>\n";
}

export async function buildLongHorizonReport(options: ReportOptions) {
  const rawResult = await readFile(options.result);
  const resultText = options.result.endsWith(".gz") ? gunzipSync(rawResult).toString("utf8") : rawResult.toString("utf8");
  const run = JSON.parse(resultText) as LongHorizonRun;
  const plan = JSON.parse(await readFile(options.plan, "utf8")) as Record<string, any>;
  if (run.status !== "completed" || run.fixture_sha256 !== plan.fixture_sha256 ||
      run.configuration_sha256 !== plan.configuration_sha256 || run.successful_calls !== plan.calls_planned) {
    throw new Error("report requires a completed run matching the frozen plan");
  }
  const successes = scoreSummary(run.rows);
  const byMethod: Record<string, any> = {};
  for (const method of LONG_HORIZON_METHODS) {
    const base = (successes as any)[method];
    const failures = run.ledger.filter(x => x.method === method && x.status === "failed");
    const failureCost = failures.reduce((n, x) => n + x.estimated_usd, 0);
    const totalCost = base.estimated_usd + failureCost;
    byMethod[method] = { ...base, attempted_calls: run.ledger.filter(x => x.method === method).length,
      successful_calls: run.ledger.filter(x => x.method === method && x.status === "succeeded").length,
      failed_calls: failures.length, failed_call_cost_reserve_usd: failureCost,
      estimated_usd_including_failures: totalCost,
      cost_per_correct_answer_including_failures: base.correct_answers ? totalCost / base.correct_answers : null };
  }
  const costByTurn: Record<string, any[]> = {};
  const contextByTurn: Record<string, any[]> = {};
  for (const method of LONG_HORIZON_METHODS) {
    costByTurn[method] = Array.from({ length: 20 }, (_, i) => {
      const turn = i + 1; const uptoRows = run.rows.filter(x => x.method === method && x.turn <= turn);
      const uptoLedger = run.ledger.filter(x => x.method === method && x.turn <= turn);
      const checks = uptoRows.filter(x => x.answer_correct !== null);
      return { conversation_turn: turn, cumulative_input_tokens_reported: uptoRows.reduce((n, x) => n + x.usage.input_tokens, 0),
        cumulative_output_tokens_reported: uptoRows.reduce((n, x) => n + x.usage.output_tokens, 0),
        cumulative_estimated_usd_including_failure_reserve: uptoLedger.reduce((n, x) => n + x.estimated_usd, 0),
        recall_accuracy: checks.length ? checks.filter(x => x.answer_correct).length / checks.length : null,
        scored_checkpoints: checks.length };
    });
    contextByTurn[method] = [5, 10, 15, 20].map(turn => {
      const rows = run.rows.filter(x => x.method === method && x.turn === turn);
      return { conversation_turn: turn, median_context_chars: median(rows.map(x => x.context_chars)),
        median_summary_chars: method === "rolling_summary" ? median(rows.map(x => x.summary_chars)) : null,
        median_snapshot_chars: method === "belieflang" ? median(rows.map(x => x.snapshot_chars)) : null };
    });
  }
  const breakEven: Record<string, number | null> = {};
  for (const baseline of ["full_history", "rolling_summary"] as const) {
    const points = Array.from({ length: 20 }, (_, i) => i + 1).map(turn => {
      const b = costByTurn[baseline][turn - 1], s = costByTurn.belieflang[turn - 1];
      return { turn, comparable_quality: b.recall_accuracy !== null && s.recall_accuracy !== null &&
        Math.abs(b.recall_accuracy - s.recall_accuracy) <= 0.05 + 1e-9,
        belieflang_cheaper: s.cumulative_estimated_usd_including_failure_reserve <= b.cumulative_estimated_usd_including_failure_reserve };
    });
    breakEven[`belieflang_vs_${baseline}`] = points.find(x => x.comparable_quality && x.belieflang_cheaper)?.turn ?? null;
  }
  const byDomain = Object.fromEntries([...new Set(run.rows.map(x => x.domain))].map(domain => [domain,
    Object.fromEntries(LONG_HORIZON_METHODS.map(method => {
      const rows = run.rows.filter(x => x.method === method && x.domain === domain && x.answer_correct !== null);
      return [method, { correct: rows.filter(x => x.answer_correct).length, checkpoints: rows.length,
        accuracy: rows.length ? rows.filter(x => x.answer_correct).length / rows.length : null }];
    }))]));
  const points = LONG_HORIZON_METHODS.map(method => ({ method, accuracy: byMethod[method].factual_recall_accuracy,
    cost_usd: byMethod[method].estimated_usd_including_failures }));
  const totalPilotCost = Number(plan.prior_pilot_estimated_spend_usd);
  const report = { benchmark: run.benchmark, evaluation_status: run.status, evaluated_at: run.updated_at,
    frozen_plan: options.plan, fixture_sha256: run.fixture_sha256, configuration_sha256: run.configuration_sha256,
    model: run.model, methods: byMethod, by_domain_recall: byDomain,
    attempts: run.attempts, successful_calls: run.successful_calls, failed_calls: run.failed_calls,
    failed_call_ledger: run.ledger.filter(x => x.status === "failed"),
    final_evaluation_estimated_usd_including_failure_reserve: run.estimated_spend_usd,
    pilot_calls: plan.prior_pilot_calls, pilot_estimated_usd: totalPilotCost,
    total_experiment_estimated_usd: run.estimated_spend_usd + totalPilotCost, budget_cap_usd: 5,
    cumulative_cost_tokens_and_accuracy_by_turn: costByTurn, context_summary_snapshot_chars_by_turn: contextByTurn,
    accuracy_cost_points: points, quality_matched_break_even_turn: breakEven,
    known_fixture_issue: "The event_launch owner checkpoint labels expect 'event organizer' at turns 10, 15, and 20, although the conversation explicitly names Nina Patel as event owner at turn 4. These frozen labels were not edited after evaluation; all three methods' Nina Patel answer is counted as incorrect at turn 15. Treat these checkpoints and the headline exact-match scores as conservatively biased by one shared label error (2.5 percentage points per method).",
    analysis_note: "Method-level costs include the conservative reserve for incomplete responses. Per-method token counts include reported usage only; incomplete response token usage was unavailable. The two incomplete attempts were each retried after persisting the failure; both original failures remain in the ledger and in attempts/cost. Confidence Brier scores apply only to fact records present at checkpoints and do not measure omitted facts. The shared event-owner label inconsistency also affects checkpoint state-retention counts.",
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2) + "\n");
  await mkdir(options.charts, { recursive: true });
  await writeFile(join(options.charts, "long-horizon-v2-accuracy-cost.svg"), accuracyCostSvg(points), "utf8");
  const chartSeries = Object.fromEntries(LONG_HORIZON_METHODS.map(method => [method, costByTurn[method].map(x => ({
    conversation_turn: x.conversation_turn, cumulative_cost_usd: x.cumulative_estimated_usd_including_failure_reserve,
  }))]));
  await writeFile(join(options.charts, "long-horizon-v2-cost-length.svg"), costLengthSvg(chartSeries), "utf8");
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const result = resolve(argv[0] ?? "benchmarks/results/long-horizon-v2-final-2026-10-17.json.gz");
  const plan = resolve(argv[1] ?? "benchmarks/plans/long-horizon-v2-plan.json");
  const output = resolve(argv[2] ?? "benchmarks/results/long-horizon-v2-summary-2026-10-17.json");
  const charts = resolve(argv[3] ?? "docs/assets");
  const report = await buildLongHorizonReport({ result, plan, output, charts });
  process.stdout.write(JSON.stringify({ methods: report.methods, attempts: report.attempts,
    failed_calls: report.failed_calls, total_experiment_estimated_usd: report.total_experiment_estimated_usd,
    quality_matched_break_even_turn: report.quality_matched_break_even_turn }, null, 2) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error instanceof Error ? `error: ${error.message}` : "error: report failed"); process.exitCode = 1; });
}
