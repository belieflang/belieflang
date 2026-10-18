import { readFile } from "node:fs/promises";
import {
  FactMemory,
  type FactDelta,
  type FactSource,
  type FactValue,
  type MemoryCell,
} from "../fact_memory.js";
import { AgentDecisionGuard } from "../agent_decisions.js";
import { TypeScriptState } from "./typescript_state.js";
import { workflows, type Context, type Workflow } from "./workflows.js";
import { runBeliefLangPolicy } from "./belieflang_host.js";
import { selectTypeScriptPolicy } from "./typescript_host.js";
export const APPROACHES = [
  "typescript_json",
  "v3_library",
  "belieflang_dsl",
  "full_history_oracle",
] as const;
export type Approach = (typeof APPROACHES)[number];
type Memory = TypeScriptState | FactMemory;
const apply = (
  m: Memory,
  patch: unknown,
  source: FactSource,
  verified: Record<string, FactValue> = {},
) =>
  m instanceof FactMemory
    ? m.apply(patch as FactDelta[], source, verified)
    : m.applyExtracted(patch, source, verified);
export type Trace = {
  turn: number;
  kind: "action" | "history";
  attempted?: boolean;
  executed?: boolean;
  expected?: unknown;
  actual?: unknown;
  reason?: string;
  sources?: unknown;
  passed: boolean;
};
export async function compareWorkflow(
  workflow: Workflow,
  approach: Approach,
  sourceOverride?: string,
) {
  let memory: Memory =
    approach === "v3_library" || approach === "belieflang_dsl"
      ? new FactMemory(workflow.schema)
      : new TypeScriptState(workflow.schema);
  const guard = new AgentDecisionGuard(),
    trace: Trace[] = [],
    prefix: {
      patch: FactDelta[];
      source: FactSource;
      verified?: Record<string, FactValue>;
    }[] = [];
  const source =
    approach === "belieflang_dsl"
      ? (sourceOverride ??
        (await readFile(`examples/viability/${workflow.id}.bel`, "utf8")))
      : "";
  let taskDemands = 0,
    extractions = 0,
    tools = 0;
  for (const [i, step] of workflow.steps.entries()) {
    const turn = i + 1,
      provenance = { turn, id: `${workflow.id}:${turn}`, text: step.text };
    prefix.push({
      patch: step.patch,
      source: provenance,
      verified: step.verified,
    });
    if (approach !== "full_history_oracle") {
      apply(memory, step.patch, provenance, step.verified);
      extractions++;
    } else if (step.task || step.question || step.approval) {
      // Ideal structured extraction replay at demand time. No LLM quality/cost is claimed.
      memory = new TypeScriptState(workflow.schema);
      for (const prior of prefix)
        apply(memory, prior.patch, prior.source, prior.verified);
      extractions++;
      taskDemands++;
    }
    if (step.approval)
      guard.record(
        memory,
        workflow.action,
        step.approval.allowed,
        workflow.fields,
        provenance,
        step.approval.expiresAfterTurn,
      );
    if (step.task) {
      if (
        !Number.isFinite(step.task.intentConfidence) ||
        step.task.intentConfidence < 0 ||
        step.task.intentConfidence > 1
      )
        throw new Error("invalid intent probability");
      const current = memory.current;
      const context: Context<any> = {
        intentConfidence: step.task.intentConfidence,
        facts: Object.fromEntries(
          Object.keys(workflow.schema).map((field) => [
            field,
            {
              status: current[field]?.status ?? "missing",
              value: current[field]?.value ?? null,
            },
          ]),
        ),
      };
      const parameters = Object.fromEntries(
        workflow.fields
          .filter((f) => current[f]?.value !== undefined)
          .map((f) => [f, current[f].value!]),
      ) as Record<string, FactValue>;
      let attempted = false,
        executed = false;
      const invoke = async () => {
        attempted = true;
        await guard.execute(memory, workflow.action, parameters, turn, () => {
          executed = true;
          tools++;
        });
      };
      if (approach === "belieflang_dsl")
        await runBeliefLangPolicy(
          source,
          context,
          memory as FactMemory,
          invoke,
        );
      else if (selectTypeScriptPolicy(workflow, context)) await invoke();
      const decision = guard.explain(memory, workflow.action, parameters, turn);
      trace.push({
        turn,
        kind: "action",
        attempted,
        executed,
        expected: step.task.expectedExecution,
        reason: !attempted
          ? "application_policy_not_satisfied"
          : decision.reason,
        sources: decision.sources,
        passed: executed === step.task.expectedExecution,
      });
    }
    if (step.question) {
      const actual = memory.retrieve(
        step.question.field,
        step.question.mode,
      )[0];
      trace.push({
        turn,
        kind: "history",
        expected: step.question.expected,
        actual: actual?.value ?? null,
        sources: actual?.source,
        passed: actual?.value === step.question.expected,
      });
    }
  }
  // Restore/revalidate the native representation, rather than awarding TS an unvalidated object baseline.
  const snapshot = memory.snapshot(),
    restored =
      memory instanceof FactMemory
        ? FactMemory.restore(snapshot as ReturnType<FactMemory["snapshot"]>)
        : TypeScriptState.restore(snapshot);
  if (JSON.stringify(restored.context()) !== JSON.stringify(memory.context()))
    throw new Error("snapshot roundtrip differs");
  return {
    workflow: workflow.id,
    approach,
    trace,
    passed: trace.every((t) => t.passed),
    toolsExecuted: tools,
    sourceTurns: workflow.steps.length,
    structuredExtractorDemands: extractions,
    taskDemands,
    finalState: memory.context(),
    snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
    liveCalls: 0,
  };
}
export async function compareAll() {
  const results = [];
  for (const workflow of workflows)
    for (const approach of APPROACHES)
      results.push(await compareWorkflow(workflow, approach));
  return {
    description:
      "Deterministic structured-event developer-experience replay; full-history oracle is not live LLM evidence.",
    results,
  };
}
