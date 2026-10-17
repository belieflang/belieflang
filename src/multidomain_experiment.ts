import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { domains, conversations } from "./multidomain_cases.js";
import { holdoutConversations, validateHoldout } from "./multidomain_holdout.js";
import { instructions, pricingFromEnv, summarize, workflowOrder, WORKFLOWS, type PromptVariant, type Row, type Suite, type Workflow } from "./multidomain_benchmark.js";
import { assembleReport, type Manifest, type SourceReport } from "./multidomain_report.js";

type Pass = { suite: Suite; prompt: PromptVariant; workflow: Workflow; repetition: number };
type RawReport = SourceReport & { expected_calls: number; instructions_by_domain: Record<string, string> };
type Attempt = Pass & { file: string; attempt: number; status: string; completed_calls: number; error?: string };

async function main(): Promise<void> {
  const [directoryArg, ...args] = process.argv.slice(2);
  let resume = false;
  let candidate: "continuity" | "compact" = "continuity";
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`duplicate argument: ${arg}`);
    seen.add(arg);
    if (arg === "--resume") resume = true;
    else if (arg === "--candidate" && ["continuity", "compact"].includes(args[i + 1])) {
      candidate = args[++i] as "continuity" | "compact";
    } else throw new Error(`invalid experiment argument: ${arg}`);
  }
  if (!directoryArg || directoryArg.startsWith("--")) {
    throw new Error("usage: multidomain_experiment.js <output-directory> [--candidate continuity|compact] [--resume]");
  }
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
  const directory = resolve(directoryArg);
  // A new directory prevents accidentally overwriting a prior experiment or its frozen plan.
  if (!resume) await mkdir(directory);
  validateHoldout();
  const variants: PromptVariant[] = candidate === "compact" ? ["continuity", "compact"] : ["original", "continuity"];
  const plan: Pass[] = [];
  for (let rep = 1; rep <= 3; rep++) {
    for (const workflow of workflowOrder([...WORKFLOWS], rep)) plan.push({ suite: "original", prompt: candidate, workflow, repetition: rep });
  }
  for (let rep = 1; rep <= 3; rep++) {
    for (const prompt of rep === 2 ? [...variants].reverse() : variants) {
      plan.push({ suite: "holdout", prompt, workflow: "belief_snapshot", repetition: rep });
    }
  }
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const frozenImplementation = createHash("sha256");
  for (const file of ["multidomain_benchmark.js", "multidomain_cases.js", "multidomain_holdout.js", "openai.js", "runtime.js"]) {
    frozenImplementation.update(await readFile(new URL(file, import.meta.url)));
  }
  const frozenPlan = {
    created_at: new Date().toISOString(), planned_scored_calls: 1080, passes: plan,
    original_fixture_sha256: sha256(JSON.stringify({ domains, conversations })),
    holdout_fixture_sha256: sha256(JSON.stringify({ domains, conversations: holdoutConversations })),
    prompts_by_variant: Object.fromEntries(variants.map(p => [p,
      Object.fromEntries(Object.entries(domains).map(([k, d]) => [k, instructions(d, p)]))])),
    hypothesis: candidate === "compact"
      ? "Shorter instructions retain task continuity accuracy while reducing snapshot token usage and estimated cost. No state, schema or adapter changes."
      : "Clarifying task continuity reduces incorrect unknown intent predictions while retaining preference and unrelated-request accuracy.",
    decision_rule: candidate === "compact"
      ? "Evaluate one frozen candidate without post-result tuning. Accept only if snapshot exact accuracy is 100% on both the original 300 predictions and the reused synthetic 90 predictions, preferences and unrelated requests remain correct, and original-suite snapshot estimated cost is lower than both the recorded continuity snapshot and the earlier full-history baseline at matched recorded accuracy. These are known regression cases, not an independent holdout; repetitions are correlated. All three workflows receive the compact prompt."
      : "Evaluate this single frozen prompt before any further tuning. If original-suite snapshot exact accuracy is at least 98%, preference accuracy remains 100%, and unrelated-question accuracy is unchanged, retain the prompt-only approach. Otherwise document remaining failures before changing state representation. Fresh synthetic cases are authored by the implementing agent after v1 diagnosis and are not an independent blinded holdout.",
    execution: "Serial requests and serial passes. Original suite order rotates by repetition; fresh snapshot prompt order alternates by repetition. No turn retries. Up to three whole-pass attempts on malformed/invalid model output only, preserving all prefixes. HTTP/transport/configuration failures stop the experiment. Never mix prompt variants in original-suite summary.",
    baseline_report: "../multidomain-2026-10-17-summary.json",
    ...(candidate === "compact" ? { continuity_baseline_report: "../multidomain-continuity-phase-aware-2026-10-17/summary.json",
      model: process.env.OPENAI_MODEL ?? "gpt-6-luna", pricing_usd_per_million: pricingFromEnv(process.env),
      implementation_sha256: frozenImplementation.digest("hex"),
      orchestrator_sha256: sha256(await readFile(new URL("multidomain_experiment.js", import.meta.url), "utf8")),
      reused_evaluation_note: "The holdout suite was already evaluated during continuity development. Here it is a regression suite, not fresh or blinded. Only the two prompt variants differ in the contemporaneous synthetic snapshot comparison." } : {}),
  };
  if (resume) {
    const stored = JSON.parse(await readFile(resolve(directory, "plan.json"), "utf8"));
    for (const key of Object.keys(frozenPlan).filter(k => k !== "created_at")) {
      if (JSON.stringify(stored[key]) !== JSON.stringify(frozenPlan[key as keyof typeof frozenPlan])) {
        throw new Error(`resume would change frozen plan: ${key}`);
      }
    }
  } else await writeFile(resolve(directory, "plan.json"), JSON.stringify(frozenPlan, null, 2) + "\n");
  const attempts: Attempt[] = [];
  const reports: RawReport[] = [];
  const manifest: Manifest = { sources: [], selections: [] };
  const originalReports: SourceReport[] = [];
  const heldout: { pass: Pass; report: RawReport; file: string }[] = [];
  type Resumption = { created_at: string; previous_error?: string; policy: string };
  let resumptions: Resumption[] = [];
  const passKey = (p: Pass) => `${p.suite}:${p.prompt}:${p.workflow}:${p.repetition}`;
  if (resume) {
    const previous = JSON.parse(await readFile(resolve(directory, "ledger.json"), "utf8")) as {
      status: string; error?: string; attempts: Attempt[]; resumptions?: Resumption[];
    };
    if (previous.status !== "failed") throw new Error("resume requires a stopped, failed experiment");
    const impl = createHash("sha256");
    for (const file of ["multidomain_benchmark.js", "multidomain_cases.js", "multidomain_holdout.js", "openai.js", "runtime.js"]) {
      impl.update(await readFile(new URL(file, import.meta.url)));
    }
    const implementationHash = impl.digest("hex");
    for (const prior of previous.attempts) {
      if (!plan.some(p => passKey(p) === passKey(prior)) || ![1, 2, 3].includes(prior.attempt) ||
          prior.file !== `${prior.suite}-${prior.prompt}-${prior.workflow}-r${prior.repetition}-a${prior.attempt}.json`) {
        throw new Error("invalid resume ledger attempt");
      }
      const raw = JSON.parse(await readFile(resolve(directory, prior.file), "utf8")) as RawReport;
      if (raw.implementation_sha256 !== implementationHash || raw.model !== (process.env.OPENAI_MODEL ?? "gpt-6-luna") ||
          JSON.stringify(raw.pricing_usd_per_million) !== JSON.stringify(pricingFromEnv(process.env)) ||
          raw.prompt_variant !== prior.prompt || raw.suite !== prior.suite || raw.status !== prior.status ||
          raw.rows.length !== prior.completed_calls || !["completed", "failed"].includes(raw.status)) {
        throw new Error("resume source differs from frozen implementation/model/pricing/ledger");
      }
      const expected = prior.suite === "original" ? 100 : 30;
      if (raw.status === "completed" && raw.rows.length !== expected) throw new Error("incomplete successful resume pass");
      const source = originalReports.length;
      attempts.push(prior); reports.push(raw);
      if (prior.suite === "original") {
        originalReports.push(raw);
        manifest.sources.push({ file: prior.file, failed_requests_with_unreported_usage: raw.status === "failed" ? 1 : 0 });
        if (raw.status === "completed") manifest.selections.push({ source, repetition: 1, as_repetition: prior.repetition, workflow: prior.workflow });
      } else if (raw.status === "completed") heldout.push({ pass: prior, report: raw, file: prior.file });
    }
    resumptions = previous.resumptions ?? [];
    await writeFile(resolve(directory, `ledger-before-resume-${resumptions.length + 1}.json`), JSON.stringify(previous, null, 2) + "\n", { flag: "wx" });
    resumptions.push({ created_at: new Date().toISOString(), previous_error: previous.error,
      policy: "Explicit resume after a stopped experiment. Reuse complete whole passes; restart incomplete passes from their first turn. Frozen inputs and inference implementation unchanged. Prior attempts preserved." });
  }
  const saveLedger = async (status: string, error?: string) => writeFile(resolve(directory, "ledger.json"),
    JSON.stringify({ status, updated_at: new Date().toISOString(), completed_passes: manifest.selections.length + heldout.length,
      expected_passes: plan.length, resumptions, attempts, ...(error ? { error } : {}) }, null, 2) + "\n");
  await saveLedger("running");
  try {
    for (const pass of plan) {
      if (attempts.some(a => passKey(a) === passKey(pass) && a.status === "completed")) continue;
      const next = attempts.filter(a => passKey(a) === passKey(pass)).length + 1;
      if (next > 3) throw new Error(`whole-pass attempt limit exhausted: ${passKey(pass)}`);
      for (let attempt = next; attempt <= 3; attempt++) {
        const file = `${pass.suite}-${pass.prompt}-${pass.workflow}-r${pass.repetition}-a${attempt}.json`;
        console.error(`Starting ${file}`);
        const exitCode = await new Promise<number | null>((done, reject) => {
          const child = spawn(process.execPath, [fileURLToPath(new URL("multidomain_benchmark.js", import.meta.url)),
            "--runs", "1", "--suite", pass.suite, "--prompt", pass.prompt, "--workflows", pass.workflow,
            "--output", resolve(directory, file)], { stdio: ["ignore", "ignore", "inherit"], env: process.env });
          child.on("error", reject); child.on("exit", done);
        });
        const raw = JSON.parse(await readFile(resolve(directory, file), "utf8")) as RawReport;
        reports.push(raw);
        attempts.push({ ...pass, file, attempt, status: raw.status, completed_calls: raw.completed_calls,
          ...(raw.error ? { error: raw.error } : {}) });
        const expected = pass.suite === "original" ? 100 : 30;
        let sourceIndex = -1;
        if (pass.suite === "original") {
          sourceIndex = originalReports.length;
          originalReports.push(raw);
          manifest.sources.push({ file, failed_requests_with_unreported_usage: raw.status === "failed" ? 1 : 0 });
        }
        if (raw.status === "completed" && exitCode === 0 && raw.rows.length === expected) {
          if (raw.prompt_variant !== pass.prompt || raw.suite !== pass.suite ||
              Object.entries(domains).some(([key, d]) => raw.instructions_by_domain[key] !== instructions(d, pass.prompt))) {
            throw new Error("live report differs from frozen prompt/suite");
          }
          if (pass.suite === "original") manifest.selections.push({ source: sourceIndex, repetition: 1,
            as_repetition: pass.repetition, workflow: pass.workflow });
          else heldout.push({ pass, report: raw, file });
          await saveLedger("running");
          break;
        }
        await saveLedger("running");
        if (attempt === 3 || !/invalid JSON|invalid OpenAI probability|sum to 1|unexpected OpenAI belief fields/.test(raw.error ?? "")) {
          throw new Error(raw.error ?? `incomplete pass ${file}`);
        }
        console.error(`Preserved failed prefix; restarting complete pass: ${file}`);
      }
    }
    await writeFile(resolve(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    const original = assembleReport(manifest, originalReports);
    await writeFile(resolve(directory, "summary.json"), JSON.stringify({ ...original,
      source_sha256: await Promise.all(manifest.sources.map(async source => ({ file: source.file,
        sha256: sha256(await readFile(resolve(directory, source.file), "utf8")) }))),
    }, null, 2) + "\n");
    const snapshotRows = heldout.flatMap(({ pass, report }) => report.rows.map(row => ({ ...row, repetition: pass.repetition, prompt: pass.prompt })));
    const variantResults = Object.fromEntries(variants.map(prompt => {
      const rows = snapshotRows.filter(r => r.prompt === prompt);
      const unrelated = rows.filter(r => r.expected.intent === "unknown");
      return [prompt, { ...summarize(rows), unrelated_turns: unrelated.length,
        unrelated_correct: unrelated.filter(r => r.predicted.intent === "unknown").length,
        by_repetition: Object.fromEntries([1, 2, 3].map(rep => [rep, summarize(rows.filter(r => r.repetition === rep))])),
        by_domain: Object.fromEntries(Object.keys(domains).map(d => [d, summarize(rows.filter(r => r.domain === d))])),
      }];
    }));
    const allRows = reports.flatMap(r => r.rows);
    const failed = reports.filter(r => r.status === "failed").length;
    await writeFile(resolve(directory, "holdout-summary.json"), JSON.stringify({
      benchmark: candidate === "compact" ? "multidomain-compression-regression-v1" : "multidomain-continuity-fresh-v1", status: "completed", created_at: new Date().toISOString(),
      model: reports[0].model, pricing_usd_per_million: reports[0].pricing_usd_per_million,
      fixture_sha256: heldout[0].report.fixture_sha256,
      implementation_sha256: heldout[0].report.implementation_sha256,
      methodology: candidate === "compact"
        ? "Five reused synthetic conversations, six turns each; continuity and compact frozen prompts, three snapshot passes each with alternating pass order. These are known regression cases from the earlier continuity experiment, not a fresh or blinded holdout. No post-result prompt tuning. All errors counted within complete passes; see plan and ledger for failed prefixes and restarts."
        : "Five new synthetic conversations, six turns each; both frozen prompts, three snapshot passes each. Authored after v1 failure analysis, frozen before model calls, not independently authored or blinded. No post-result prompt tuning. All errors counted within complete passes. See plan and ledger for serial order, failed prefixes and any whole-pass restarts.",
      source_passes: heldout.map(({ pass, file }) => ({ ...pass, file })), results: variantResults,
      experiment_execution_accounting: { planned_scored_calls: 1080, scored_calls: 900 + snapshotRows.length,
        recorded_successful_calls: allRows.length, discarded_successful_calls: allRows.length - 900 - snapshotRows.length,
        failed_requests_with_unreported_usage: failed, total_attempted_calls: allRows.length + failed,
        usage: summarize(allRows).usage, estimated_usd_lower_bound: summarize(allRows).estimated_usd },
    }, null, 2) + "\n");
    await saveLedger("completed");
    console.log(`Completed experiment: ${directory}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown experiment failure";
    await writeFile(resolve(directory, "manifest-partial.json"), JSON.stringify(manifest, null, 2) + "\n");
    await saveLedger("failed", message);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `error: ${error.message}` : "error: experiment failed");
    process.exitCode = 1;
  });
}
