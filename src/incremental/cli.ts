import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { atomicJson } from "../v3_live.js";
import { load } from "./fixtures.js";
import { evaluate, offlineReport, plan } from "./evaluation.js";
import { assertNoLiveEvidence, freeze, verifyFreeze } from "./freeze.js";
import { createTransport } from "./live.js";
import { score, totals, type Run } from "./runner.js";
import { smokeRequest, validateSmoke } from "./smoke.js";
export async function main(
  args = process.argv.slice(2),
  getCredential = () => process.env.OPENAI_API_KEY,
) {
  const mode = args[0];
  if (
    !["--validate", "--prepare", "--freeze", "--smoke", "--live"].includes(mode)
  )
    throw new Error(
      "choose --validate, --prepare, --freeze, --smoke or --live",
    );
  if (["--validate", "--prepare", "--freeze"].includes(mode)) {
    if (args.length !== 1)
      throw new Error("offline commands take no other arguments");
    if (mode === "--freeze") {
      await freeze();
      console.log("New pilot frozen. Historical experiments unchanged.");
      return;
    }
    const { runs, ...report } = await offlineReport(),
      costPlan = await plan(runs);
    if (mode === "--prepare") {
      await assertNoLiveEvidence();
      await atomicJson("benchmarks/incremental/offline.json", report);
      await atomicJson("benchmarks/incremental/plan.json", costPlan);
    } else {
      await verifyFreeze();
      assert.deepEqual(
        JSON.parse(
          await readFile("benchmarks/incremental/offline.json", "utf8"),
        ),
        report,
      );
      assert.deepEqual(
        JSON.parse(await readFile("benchmarks/incremental/plan.json", "utf8")),
        costPlan,
      );
    }
    console.log(
      JSON.stringify(
        {
          mode,
          liveCalls: 0,
          runs: runs.length,
          checks: report.summary.reduce((s, r) => s + r.total, 0),
          plannedCalls: costPlan.plannedCalls,
          projectedUSD: costPlan.scenarios.map((s) => ({
            scenario: s.name,
            usd: s.totalProjectedUSD,
          })),
          maximumProposedUSD: 2,
          passed: true,
        },
        null,
        2,
      ),
    );
    return;
  }
  // Reject before credential access, journal creation or network setup. This is deliberately local-only.
  if (
    args.length !== 4 ||
    args[1] !== "--authorize-paid" ||
    args[2] !== "--max-usd"
  )
    throw new Error(
      "separate authorization required: --authorize-paid --max-usd <explicit maximum <= 2>",
    );
  if (process.env.CI)
    throw new Error("paid pilot is local-only; CI execution prohibited");
  const maximumUSD = Number(args[3]);
  if (!Number.isFinite(maximumUSD) || maximumUSD <= 0 || maximumUSD > 2)
    throw new Error("explicit maximum must be > 0 and <= $2");
  const fingerprint = await verifyFreeze(),
    { cases, config, gold } = await load(),
    apiKey = getCredential();
  if (!apiKey)
    throw new Error(
      "OPENAI_API_KEY must be explicitly exported locally after authorization; no dotenv/key discovery",
    );
  const root = "benchmarks/results/incremental-pilot";
  const transport = await createTransport({
    authorized: true,
    apiKey,
    config,
    fingerprint,
    maximumUSD,
    journalPath: `${root}/journal.json`,
  });
  let completed: Run[] = [],
    active: Run | undefined;
  const save = async (status: string, error?: string) => {
    const runs = active ? [...completed, active] : completed;
    const entries = transport.entries();
    await atomicJson(`${root}/report.json`, {
      version: 1,
      status,
      error,
      fingerprint,
      config,
      accounting: transport.accounting(),
      allPilotAttemptTotals: totals(
        entries
          .filter((e) => e.stage === "pilot")
          .map((e) => ({
            ...e.request,
            ...(e.result ?? {
              usage: null,
              cost: { lower: 0, upper: e.reserved },
              latencyMs: null,
              error: "pending: billing unknown",
            }),
          })),
      ),
      allAttempts: entries,
      runs,
      summary: score(runs, gold),
      coverage: {
        plannedChecks: Object.keys(gold).length * 4,
        observedChecks: runs.reduce((s, r) => s + r.checks.length, 0),
        plannedAnswers:
          Object.values(gold).reduce((s, g) => s + g.answers.length, 0) * 4,
        observedAnswers: runs.reduce(
          (s, r) =>
            s + r.checks.reduce((t, ch) => t + gold[ch.id].answers.length, 0),
          0,
        ),
      },
      limitations:
        "USD estimates use published rates plus a 10% premium assumption; absent cache telemetry produces intervals. Partial runs are not a complete paired comparison. No real tools execute.",
    });
  };
  try {
    if (mode === "--smoke") {
      const result = await transport.infer("smoke")(smokeRequest(cases[0]));
      let report: unknown;
      try {
        report = validateSmoke(cases[0], result);
      } catch (e) {
        report = {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
          result,
        };
      }
      await atomicJson(`${root}/smoke.json`, {
        fingerprint,
        report,
        accounting: transport.accounting(),
      });
      console.log(JSON.stringify(report, null, 2));
      if ((report as any).status !== "passed") process.exitCode = 1;
    } else {
      const smoke = transport
        .entries()
        .find(
          (e) => e.stage === "smoke" && e.request.id === "compatibility/smoke",
        );
      if (!smoke?.result)
        throw new Error(
          "run the separately authorized smoke test first, using this same journal/budget",
        );
      validateSmoke(cases[0], smoke.result);
      const result = await evaluate(
        transport.infer("pilot"),
        async (done, current) => {
          completed = done;
          active = current;
          await save("in_progress");
        },
      );
      completed = result.runs;
      active = undefined;
      await save("complete");
      console.log(
        JSON.stringify(
          {
            status: "complete",
            accounting: transport.accounting(),
            summary: result.summary,
          },
          null,
          2,
        ),
      );
    }
  } catch (e) {
    if (mode === "--live")
      await save("incomplete", e instanceof Error ? e.message : String(e));
    throw e;
  } finally {
    await transport.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
