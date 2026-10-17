import { readFile } from "node:fs/promises";
import { resolve, relative, basename } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { loadSuite, validateSuite } from "./v3_fixtures.js";
import { runSuite, summarize, type Run } from "./v3_benchmark.js";
import { oracleInference, type Rates } from "./v3_inference.js";
import {
  atomicJson,
  atomicFile,
  hash,
  createLiveInference,
  BudgetExhausted,
  validateLiveConfig,
  validateLiveBudget,
  type LiveConfig,
} from "./v3_live.js";
const fixturePath = "benchmarks/v3/evaluation.json",
  configPath = "benchmarks/v3/config.json",
  freezePath = "benchmarks/v3/freeze.json";
const frozenPaths = [
  fixturePath,
  configPath,
  "src/v3_cli.ts",
  "src/v3_fixtures.ts",
  "src/v3_benchmark.ts",
  "src/v3_json_baseline.ts",
  "src/v3_inference.ts",
  "src/v3_live.ts",
  "src/fact_memory.ts",
  "src/agent_decisions.ts",
  "src/runtime.ts",
  "package.json",
  "package-lock.json",
];
export async function frozenInputs() {
  return Object.fromEntries(
    await Promise.all(
      frozenPaths.map(async (path) => [
        path,
        hash(await readFile(path, "utf8")),
      ]),
    ),
  );
}
export async function validateFreeze() {
  const frozen = JSON.parse(await readFile(freezePath, "utf8")),
    actual = await frozenInputs();
  if (
    frozen.version !== 1 ||
    JSON.stringify(frozen.sha256) !== JSON.stringify(actual)
  )
    throw new Error(
      "frozen evaluation inputs changed; review and explicitly refreeze BEFORE any live run",
    );
  return hash(JSON.stringify(frozen));
}
export async function main(args = process.argv.slice(2)) {
  const allowed = new Set([
    "--validate",
    "--freeze",
    "--offline",
    "--live",
    "--authorize-paid",
    "--out",
    "--cap-usd",
    "--rates",
  ]);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`unknown argument ${args[i]}`);
    if (["--out", "--cap-usd", "--rates"].includes(args[i])) {
      if (!args[++i] || args[i].startsWith("--"))
        throw new Error("missing option value");
    }
  }
  const suite = await loadSuite(fixturePath),
    development = await loadSuite("benchmarks/v3/development.json");
  const evaluationCounts = validateSuite(suite, "evaluation"),
    developmentCounts = validateSuite(development, "development");
  const config: LiveConfig = JSON.parse(await readFile(configPath, "utf8"));
  validateLiveConfig(config);
  const devIds = new Set(development.conversations.map((c) => c.id));
  if (suite.conversations.some((c) => devIds.has(c.id)))
    throw new Error("overlapping fixture splits");
  if (args.includes("--freeze")) {
    if (
      args.some((a) => ["--live", "--offline", "--authorize-paid"].includes(a))
    )
      throw new Error("freeze is a separate offline action");
    await atomicJson(freezePath, {
      version: 1,
      description:
        "Freeze of authored independent evaluation fixtures/configuration/prompts/scoring/runtime before any live inference. Not external blinding. Refreezing after evaluation invalidates confirmatory claims.",
      sha256: await frozenInputs(),
    });
    console.log("Frozen evaluation inputs", evaluationCounts);
    return;
  }
  const fingerprint = await validateFreeze();
  if (args.includes("--validate")) {
    console.log(
      JSON.stringify(
        {
          evaluation: evaluationCounts,
          development: developmentCounts,
          frozen: true,
          liveCalls: 0,
        },
        null,
        2,
      ),
    );
    return;
  }
  const live = args.includes("--live"),
    offline = args.includes("--offline");
  if (live === offline)
    throw new Error("choose exactly one of --offline or --live");
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const out =
    value("--out") ??
    (live
      ? "benchmarks/results/v3-live.json"
      : "benchmarks/results/v3-offline.json");
  const outputRelative = relative(resolve("benchmarks/results"), resolve(out));
  if (
    outputRelative.includes("/") ||
    !/^v3-[a-zA-Z0-9_-]+\.json$/.test(outputRelative)
  )
    throw new Error(
      "output must be a v3-*.json file directly under benchmarks/results; recorded v1/v2 files cannot be overwritten",
    );
  const completed: Run[] = [];
  let runner: Awaited<ReturnType<typeof createLiveInference>> | undefined;
  let status = "complete",
    blocker: string | undefined;
  if (live) {
    if (
      !args.includes("--authorize-paid") ||
      !value("--cap-usd") ||
      !value("--rates")
    )
      throw new Error(
        "live requires explicit --authorize-paid, --cap-usd and --rates; no credentials have been accessed",
      );
    const cap = Number(value("--cap-usd")),
      rates: Rates = JSON.parse(await readFile(value("--rates")!, "utf8"));
    validateLiveBudget(rates, cap);
    // The only environment credential lookup in this module. Offline, validation and freeze never reach it.
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("live blocked: OPENAI_API_KEY not supplied");
    runner = await createLiveInference({
      apiKey,
      config,
      rates,
      cap,
      fingerprint,
      journalPath: `${out}.journal.json`,
    });
  } else if (
    args.includes("--authorize-paid") ||
    value("--rates") ||
    value("--cap-usd")
  )
    throw new Error("paid settings are invalid in offline mode");
  const save = async () => {
    const raw = JSON.stringify(completed),
      rawPath = `${out}.runs.json.gz`;
    await atomicFile(rawPath, gzipSync(raw));
    await atomicJson(out, {
      version: 3,
      mode: live ? "live" : "offline-oracle-mock",
      status,
      blocker,
      fingerprint,
      fixtureCounts: evaluationCounts,
      config,
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      limitations: live
        ? [
            "Estimated rates supplied by operator; local cap assumes declared provider input/output billing bounds.",
          ]
        : [
            "Oracle extraction and adversarial always-attempt tool proposals; not model accuracy or calibration.",
            "Bytes are measured serialized benchmark payloads, not tokens; token/cost metrics are null.",
            "Local timing includes mock/harness work, not provider inference latency.",
          ],
      completedRuns: completed.length,
      rawRuns: basename(rawPath),
      rawRunsSha256: hash(raw),
      summaryScope:
        "Completed runs only; the live accounting ledger also includes any interrupted partial run.",
      summary: summarize(completed),
      ...(runner ? { accounting: runner.accounting() } : { liveCalls: 0 }),
    });
  };
  try {
    await runSuite(suite, runner?.infer ?? oracleInference, {
      repetitions: config.repetitions,
      onRun: async (run) => {
        completed.push(run);
        await save();
      },
    });
  } catch (e) {
    status = e instanceof BudgetExhausted ? "budget_exhausted" : "blocked";
    blocker = e instanceof Error ? e.message : String(e);
    process.exitCode = 1;
  } finally {
    await save();
    await runner?.close();
  }
  console.log(
    JSON.stringify(
      {
        status,
        blocker,
        path: resolve(out),
        completedRuns: completed.length,
        liveCalls: runner?.accounting().entries.length ?? 0,
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
