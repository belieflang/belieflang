import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { loadSuite, sourceAt, validateSuite } from "../v3_fixtures.js";
import { runSuite, summarize } from "../v3_benchmark.js";
import { oracleInference, type InferenceRequest } from "../v3_inference.js";
import { validateFreeze } from "../v3_cli.js";
import { TypeScriptState } from "./typescript_state.js";
import type { FactValue } from "../fact_memory.js";
export type CapturedCall = { request: InferenceRequest; output: unknown };
export async function reviewFrozenBenchmark() {
  const fingerprint = await validateFreeze(),
    suite = await loadSuite("benchmarks/v3/evaluation.json");
  let labels = 0,
    actionLabels = 0;
  for (const conversation of suite.conversations) {
    const state = new TypeScriptState(conversation.schema);
    const approvals = new Map<
      string,
      {
        allowed: boolean;
        scope: Record<string, { revision: number; value?: FactValue }>;
      }
    >();
    for (const [i, turn] of conversation.turns.entries()) {
      state.applyExtracted(
        turn.deltas,
        sourceAt(conversation, i + 1),
        turn.verified,
      );
      if (turn.approval)
        approvals.set(turn.approval.action, {
          allowed: turn.approval.allowed,
          scope: Object.fromEntries(
            turn.approval.fields.map((f) => [
              f,
              {
                revision: state.current[f]?.revision ?? -1,
                value: state.current[f]?.value,
              },
            ]),
          ),
        });
      for (const q of turn.questions ?? []) {
        const c =
          q.kind === "original" || q.kind === "previous"
            ? state.retrieve(q.field, q.kind)[0]
            : state.current[q.field];
        assert.equal(
          c?.value ?? null,
          q.expected.value,
          `independent value label ${q.id}`,
        );
        assert.equal(
          c?.status ?? "missing",
          q.expected.status,
          `independent status label ${q.id}`,
        );
        labels++;
      }
      for (const task of turn.tools ?? []) {
        const approval = approvals.get(task.action),
          current = state.current;
        const safe =
          !!approval?.allowed &&
          Object.keys(task.parameters).length ===
            Object.keys(approval.scope).length &&
          Object.entries(approval.scope).every(
            ([field, scope]) =>
              current[field]?.status === "confirmed" &&
              current[field].revision === scope.revision &&
              current[field].value === scope.value &&
              Object.hasOwn(task.parameters, field) &&
              task.parameters[field] === current[field].value,
          );
        assert.equal(safe, task.safe, `independent action label ${task.id}`);
        actionLabels++;
      }
    }
  }
  const calls: CapturedCall[] = [];
  const replay = await runSuite(suite, async (request, oracle) => {
    calls.push({ request, output: structuredClone(oracle) });
    return oracleInference(request, oracle);
  });
  const categoryHints = calls.filter(
    (c) =>
      c.request.kind === "answer" &&
      ["missing", "contradiction"].includes(
        JSON.parse(c.request.prompt).task.kind,
      ),
  );
  const eagerDuplicateMessage = calls.filter(
    (c) =>
      c.request.kind === "update" &&
      c.request.id.split("/")[2] === "full_eager" &&
      JSON.stringify(JSON.parse(c.request.prompt).context.history.at(-1)) ===
        JSON.stringify(JSON.parse(c.request.prompt).message),
  );
  const redundantActionFactReports = calls.filter(
    (c) =>
      c.request.kind === "action" &&
      ["plain_json", "belieflang_v2", "belieflang_v3"].includes(
        c.request.id.split("/")[2],
      ),
  );
  const typedMemoryAnswerCalls = calls.filter(
    (c) =>
      c.request.kind === "answer" &&
      ["plain_json", "belieflang_v3"].includes(c.request.id.split("/")[2]),
  );
  const verifiedMaintenance = calls.filter(
    (c) =>
      c.request.kind === "update" &&
      JSON.parse(c.request.prompt).message.hostVerification,
  );
  const v2OracleVerificationNotInContext = calls.filter(
    (c) =>
      c.request.kind === "answer" &&
      c.request.id.split("/")[2] === "belieflang_v2" &&
      (c.output as any).status === "confirmed" &&
      !JSON.stringify(JSON.parse(c.request.prompt).context).includes(
        '"confirmed"',
      ),
  );
  const development = await loadSuite("benchmarks/v3/development.json");
  const emptySummary = await runSuite(
    development,
    async (request, oracle) =>
      request.kind === "update"
        ? {
            output: { summary: "" },
            usage: null,
            estimatedCost: null,
            latencyMs: 0,
          }
        : oracleInference(request, oracle),
    { methods: ["rolling_summary"] },
  );
  const summaryProbe = emptySummary.summary.find(
    (r) => r.method === "rolling_summary",
  )!;
  const approvalBeforeVerification = structuredClone(suite);
  approvalBeforeVerification.conversations =
    approvalBeforeVerification.conversations.slice(0, 1);
  approvalBeforeVerification.conversations[0].turns[7].approval = {
    action:
      approvalBeforeVerification.conversations[0].turns[7].tools![0].action,
    allowed: true,
    fields:
      approvalBeforeVerification.conversations[0].turns[7].tools![0].fields,
  };
  validateSuite(approvalBeforeVerification);
  const approvalProbe = await runSuite(
    approvalBeforeVerification,
    oracleInference,
    { methods: ["plain_json", "belieflang_v2", "belieflang_v3"] },
  );
  const unsafeOnUnverifiedApproval = approvalProbe.runs.map((r) => ({
    method: r.method,
    unsafeExecutions: r.actions.filter((a) => a.unsafeExecution).length,
  }));
  const report = JSON.parse(
    await readFile("benchmarks/results/v3-offline.json", "utf8"),
  );
  const raw = gunzipSync(
    await readFile(`benchmarks/results/${report.rawRuns}`),
  ).toString();
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    report.rawRunsSha256,
  );
  assert.deepEqual(summarize(JSON.parse(raw)), report.summary);
  return {
    fingerprint,
    labels,
    actionLabels,
    categoryHints: categoryHints.length,
    eagerDuplicateMessage: eagerDuplicateMessage.length,
    redundantActionFactReports: redundantActionFactReports.length,
    typedMemoryAnswerCalls: typedMemoryAnswerCalls.length,
    verifiedMaintenanceCalls: verifiedMaintenance.length,
    v2OracleVerificationNotInContext: v2OracleVerificationNotInContext.length,
    emptySummaryOracleProbe: {
      correct: summaryProbe.correct,
      total: summaryProbe.answers,
    },
    unsafeOnUnverifiedApproval,
    savedRawHashVerified: true,
    savedSummaryRecomputed: true,
    oneRepetition: replay.summary,
    calls,
  };
}
