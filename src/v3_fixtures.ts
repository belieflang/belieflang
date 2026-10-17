import { readFile } from "node:fs/promises";
import {
  FactMemory,
  validateDeltas,
  validateFactSchema,
  type FactDelta,
  type FactSource,
  type FactValue,
  type FactStatus,
} from "./fact_memory.js";
import { AgentDecisionGuard } from "./agent_decisions.js";
import type { FactSchema } from "./runtime.js";
export type Question = {
  id: string;
  kind: "current" | "original" | "previous" | "contradiction" | "missing";
  field: string;
  text: string;
  expected: { value: FactValue | null; status: FactStatus | "missing" };
};
export type ToolTask = {
  id: string;
  action: string;
  fields: string[];
  parameters: Record<string, FactValue>;
  safe: boolean;
  text: string;
};
export type Turn = {
  text: string;
  deltas: FactDelta[];
  verified?: Record<string, FactValue>;
  approval?: { action: string; allowed: boolean; fields: string[] };
  questions?: Question[];
  tools?: ToolTask[];
};
export type Conversation = {
  id: string;
  split: "development" | "evaluation";
  domain: string;
  schema: FactSchema;
  turns: Turn[];
};
export type Suite = {
  version: 3;
  description: string;
  conversations: Conversation[];
};
export const sourceAt = (c: Conversation, turn: number): FactSource => ({
  id: `${c.id}:${turn}`,
  turn,
  text: c.turns[turn - 1].text,
});
export function expectedFromMemory(
  memory: FactMemory,
  question: Pick<Question, "field" | "kind">,
) {
  if (question.kind === "original" || question.kind === "previous") {
    const entry = memory.retrieve(question.field, question.kind)[0];
    return { value: entry?.value ?? null, status: entry?.status ?? "missing" };
  }
  const cell = memory.current[question.field];
  return { value: cell?.value ?? null, status: cell?.status ?? "missing" };
}
/** Gold labels are validated for internal consistency, not used by the live adapter. */
export function validateSuite(suite: Suite, split?: Conversation["split"]) {
  if (
    suite.version !== 3 ||
    !Array.isArray(suite.conversations) ||
    !suite.conversations.length
  )
    throw new Error("invalid v3 suite");
  const ids = new Set<string>();
  let turns = 0,
    questions = 0,
    tools = 0;
  for (const c of suite.conversations) {
    if (
      !/^[a-z0-9_-]+$/.test(c.id) ||
      ids.has(c.id) ||
      !["development", "evaluation"].includes(c.split) ||
      (split && c.split !== split) ||
      !c.domain ||
      !c.turns.length
    )
      throw new Error("invalid conversation identity/split");
    ids.add(c.id);
    validateFactSchema(c.schema);
    const memory = new FactMemory(c.schema),
      guard = new AgentDecisionGuard();
    for (const [index, t] of c.turns.entries()) {
      const turn = index + 1,
        source = sourceAt(c, turn);
      turns++;
      if (!t.text.trim()) throw new Error("empty message");
      validateDeltas(c.schema, t.deltas);
      memory.apply(t.deltas, source, t.verified);
      if (t.approval)
        guard.record(
          memory,
          t.approval.action,
          t.approval.allowed,
          t.approval.fields,
          source,
        );
      for (const q of t.questions ?? []) {
        if (
          ids.has(q.id) ||
          !Object.hasOwn(c.schema, q.field) ||
          !q.text ||
          ![
            "current",
            "original",
            "previous",
            "contradiction",
            "missing",
          ].includes(q.kind)
        )
          throw new Error("invalid question");
        ids.add(q.id);
        questions++;
        const actual = expectedFromMemory(memory, q);
        if (
          actual.value !== q.expected.value ||
          actual.status !== q.expected.status
        )
          throw new Error(
            `invalid gold label ${q.id}: ${JSON.stringify(actual)}`,
          );
      }
      for (const task of t.tools ?? []) {
        if (
          ids.has(task.id) ||
          !task.text ||
          task.fields.some((f) => !Object.hasOwn(c.schema, f))
        )
          throw new Error("invalid tool task");
        ids.add(task.id);
        tools++;
        if (
          guard.explain(memory, task.action, task.parameters, turn).allowed !==
          task.safe
        )
          throw new Error(`invalid safety label ${task.id}`);
      }
    }
  }
  return {
    conversations: suite.conversations.length,
    domains: new Set(suite.conversations.map((c) => c.domain)).size,
    turns,
    questions,
    tools,
  };
}
export async function loadSuite(path: string): Promise<Suite> {
  const suite: Suite = JSON.parse(await readFile(path, "utf8"));
  validateSuite(suite);
  return suite;
}
