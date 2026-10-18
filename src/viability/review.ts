import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareAll } from "./compare.js";
import { reviewFrozenBenchmark } from "./audit.js";
import {
  estimatePlan,
  allInRates,
  smokeRequest,
  smokeConfig,
  reservation,
  allocation,
} from "./live_plan.js";
import { freezeReview, verifyReviewFreeze } from "./freeze.js";
import type { LiveConfig } from "../v3_live.js";
export async function sourceMetrics(path: string) {
  const text = await readFile(path, "utf8"),
    lines = text.split(/\r?\n/);
  const code = lines.filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*|#)/.test(l));
  return {
    path,
    nonblankNoncommentLines: code.length,
    bytes: Buffer.byteLength(text),
    maximumLineLength: Math.max(0, ...code.map((l) => l.length)),
  };
}
export async function buildReview() {
  const audit = await reviewFrozenBenchmark(),
    comparison = await compareAll();
  assert.ok(comparison.results.every((r) => r.passed));
  const pricing = JSON.parse(
      await readFile("benchmarks/viability/pricing.json", "utf8"),
    ),
    config: LiveConfig = JSON.parse(
      await readFile("benchmarks/v3/config.json", "utf8"),
    );
  const rates = allInRates(pricing.standard, pricing.planningPremium);
  const maxInputRate = Math.max(rates.input, rates.cached, rates.cacheWrite);
  const budgetRates = {
    input: maxInputRate,
    cached: maxInputRate,
    cacheWrite: maxInputRate,
    output: rates.output,
  };
  const plannedCalls = Array.from({ length: config.repetitions }, (_, i) =>
    audit.calls.map((c) => ({
      ...c,
      request: { ...c.request, id: c.request.id.replace(/^1\//, `${i + 1}/`) },
    })),
  ).flat();
  const plan = {
    version: 1,
    authorization: "NOT AUTHORIZED / NOT EXECUTED",
    sourceBase: "85a7114e5dc19df0ab1a22a11b769bb6d96e38ce",
    originalV3Fingerprint: audit.fingerprint,
    pricing,
    ratesWithPlanningPremium: rates,
    budgetRates,
    budgetRateMeaning:
      "Conservative accounting envelope: all input categories use the highest applicable short-context input/cache price. Missing cache-write telemetry cannot silently lower the cap estimate; reported cost is an upper bound, not an invoice.",
    model: "gpt-6-luna",
    ...estimatePlan(plannedCalls, config, rates),
    smoke: {
      requests: 1,
      config: smokeConfig,
      reservation: reservation(smokeConfig, rates),
      cap: allocation.smoke,
      credentialStatus:
        "Not inspected. API entitlement, actual usage metadata and compatibility unverified.",
    },
    primaryMethods: [
      "full_query",
      "rolling_summary",
      "plain_json",
      "belieflang_v2",
      "belieflang_v3",
    ],
    originalAdditionalDiagnostic: "full_eager",
    maximumTotalAuthorizedProposal: 5,
    gate: "No paid calls until separate human authorization. Frozen category hints make the original run diagnostic, not independent confirmatory evidence.",
  };
  const paths = [
    "src/viability/travel.ts",
    "src/viability/support.ts",
    "src/viability/operations.ts",
    "src/viability/typescript_host.ts",
    "examples/viability/travel.bel",
    "examples/viability/support.bel",
    "examples/viability/operations.bel",
    "src/viability/belieflang_host.ts",
    "src/viability/typescript_state.ts",
    "src/fact_memory.ts",
    "src/agent_decisions.ts",
    "src/parser.ts",
    "src/runtime.ts",
    "src/viability/workflows.ts",
    "src/viability/compare.ts",
  ];
  const metrics = await Promise.all(paths.map(sourceMetrics));
  return {
    report: {
      version: 1,
      kind: "offline-product-review",
      base: plan.sourceBase,
      liveCalls: 0,
      providerTokens: null,
      providerCost: null,
      provisionalRecommendation:
        "B: extract a TypeScript library; retain DSL only as an explicitly experimental compatibility surface until distinctive demand is demonstrated.",
      methodology:
        "Single-author desk review and deterministic structured-event examples. Not an externally blinded study or a developer-productivity trial. LOC excludes fixture data/shared helpers from application rows and reports approach-specific support separately.",
      comparison,
      sourceMetrics: metrics,
      benchmarkAudit: {
        originalFingerprint: audit.fingerprint,
        independentValueAndStatusLabels: audit.labels,
        independentActionLabels: audit.actionLabels,
        leakingCategoryHintsPerRepetition: audit.categoryHints,
        duplicateEagerMessagesPerRepetition: audit.eagerDuplicateMessage,
        redundantActionFactReportsPerRepetition:
          audit.redundantActionFactReports,
        typedMemoryAnswerCallsPerRepetition: audit.typedMemoryAnswerCalls,
        verifiedMaintenanceCallsPerRepetition: audit.verifiedMaintenanceCalls,
        v2OracleVerifiedAnswersWithoutContextProof:
          audit.v2OracleVerificationNotInContext,
        emptySummaryOracleProbe: audit.emptySummaryOracleProbe,
        derivedUnverifiedApprovalProbe: audit.unsafeOnUnverifiedApproval,
        savedRawHashVerified: audit.savedRawHashVerified,
        savedSummaryRecomputed: audit.savedSummaryRecomputed,
      },
    },
    plan,
  };
}
export async function main(args = process.argv.slice(2)) {
  if (
    args.length !== 1 ||
    !["--validate", "--write", "--freeze"].includes(args[0])
  )
    throw new Error(
      "choose --validate, --write or --freeze (all offline; no paid CLI)",
    );
  if (args[0] === "--freeze") {
    await freezeReview();
    console.log(
      "Separate product-review plan frozen; original v3 artifacts untouched.",
    );
    return;
  }
  const { report, plan } = await buildReview();
  if (args[0] === "--write") {
    await writeFile(
      "benchmarks/viability/offline-review.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    await writeFile(
      "benchmarks/viability/live-plan.json",
      JSON.stringify(plan, null, 2) + "\n",
    );
    await writeFile(
      "benchmarks/viability/budget-rates.json",
      JSON.stringify(plan.budgetRates, null, 2) + "\n",
    );
    await writeFile(
      "benchmarks/viability/smoke-request.json",
      JSON.stringify(smokeRequest(), null, 2) + "\n",
    );
  } else {
    await verifyReviewFreeze();
    assert.deepEqual(
      JSON.parse(
        await readFile("benchmarks/viability/offline-review.json", "utf8"),
      ),
      report,
      "saved product review differs",
    );
    assert.deepEqual(
      JSON.parse(await readFile("benchmarks/viability/live-plan.json", "utf8")),
      plan,
      "saved live plan differs",
    );
  }
  console.log(
    JSON.stringify(
      {
        mode: args[0],
        workflows: 3,
        approaches: 4,
        checks: report.comparison.results.reduce(
          (sum, r) => sum + r.trace.length,
          0,
        ),
        passed: true,
        liveCalls: 0,
        audit: report.benchmarkAudit,
        plannedCalls: plan.plannedCalls,
        projectedCosts: plan.scenarios.map((s) => ({
          scenario: s.name,
          cost: s.projectedCost,
        })),
        replayConditionedCeiling: plan.replayConditionedCeiling,
        maxBudgetProposal: 5,
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
