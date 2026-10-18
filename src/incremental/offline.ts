/** Test-only deterministic parser. Never imported by the live CLI path. No scoring labels or oracle argument. */
import { missing, type Answer, type Inference, type Query } from "./types.js";
import type { FactDelta, FactValue } from "../fact_memory.js";
type State = {
  current: Record<string, Answer>;
  original: Record<string, Answer>;
  through: number;
};
const blank = (): State => ({ current: {}, original: {}, through: 0 });
const scalar = (s: string): FactValue =>
  s === "true" ? true : s === "false" ? false : Number(s);
export function parseControlledText(text: string): FactDelta[] {
  let m =
    /(?:Please change (\w+) to (true|false|\d+)|To repeat our existing requirement, (\w+) remains (\d+))/.exec(
      text,
    );
  if (m)
    return [
      {
        op: "set",
        field: m[1] ?? m[3],
        value: scalar(m[2] ?? m[4]),
        confidence: 1,
        basis: "explicit",
      },
    ];
  m = /An unverified colleague reports (\w+) as (\d+)/.exec(text);
  if (m)
    return [
      {
        op: "conflict",
        field: m[1],
        value: Number(m[2]),
        confidence: 1,
        basis: "inferred",
      },
    ];
  m = /Withdraw the (\w+) value/.exec(text);
  return m
    ? [{ op: "clear", field: m[1], confidence: 1, basis: "explicit" }]
    : [];
}
function apply(s: State, deltas: FactDelta[], turn: number, verified = false) {
  for (const d of deltas) {
    const old = s.current[d.field];
    if (d.op === "set" && old?.value === d.value && !verified) continue;
    const next: Answer =
      d.op === "clear"
        ? { value: null, status: "cleared", sourceTurn: turn }
        : d.op === "conflict"
          ? { value: null, status: "conflicting", sourceTurn: turn }
          : {
              value: d.value,
              status:
                verified ||
                (old?.status === "confirmed" && old.value === d.value)
                  ? "confirmed"
                  : "uncertain",
              sourceTurn: turn,
            };
    if (!old || old.value !== next.value || old.status !== next.status)
      s.current[d.field] = next;
    if (!s.original[d.field] && next.value !== null)
      s.original[d.field] = structuredClone(next);
  }
  s.through = turn;
}
function events(s: State, entries: any[]) {
  for (const e of entries) {
    if (e.turn <= s.through) continue;
    if (e.type === "host")
      apply(
        s,
        Object.entries(e.facts).map(([field, value]) => ({
          field,
          value: value as FactValue,
          op: "set",
          confidence: 1,
          basis: "explicit",
        })),
        e.turn,
        true,
      );
    else if (e.type === "chat") apply(s, parseControlledText(e.text), e.turn);
  }
}
function fromContext(context: any): State {
  const s: State = context.summary ? JSON.parse(context.summary) : blank();
  events(s, context.history ?? context.hostEvents ?? []);
  return s;
}
export const scriptedInference: Inference = async (req) => {
  const p = JSON.parse(req.prompt);
  let output: unknown;
  if (req.kind === "route") {
    const aliases: Record<string, string[]> = {
      weight_kg: ["heavy"],
      dock: ["loading bay"],
      temperature_c: ["temperature"],
      assay: ["assay"],
      capacity: ["visitors"],
      lighting: ["lighting"],
    };
    const field = Object.keys(p.schema).find(
      (f) =>
        p.question.includes(f) ||
        aliases[f]?.some((word) => p.question.includes(word)),
    );
    if (!field) throw new Error("offline grammar cannot route question");
    output = {
      field,
      temporal:
        /original|Before any revisions|start out|At the outset|first assigned|initially/.test(
          p.question,
        )
          ? "original"
          : "current",
    };
  } else if (req.kind === "update") {
    output = {
      deltas: parseControlledText(p.message.text).filter(
        (d) => !(d.op === "set" && p.context[d.field]?.value === d.value),
      ),
    };
  } else if (req.kind === "summary") {
    const s = fromContext(p.context);
    apply(s, parseControlledText(p.message.text), p.message.turn);
    output = { summary: JSON.stringify(s) };
  } else {
    const s = fromContext(p.context);
    output = {
      answers: p.queries.map(
        (q: Query) =>
          (q.temporal === "original"
            ? s.original[q.field]
            : s.current[q.field]) ?? missing(),
      ),
    };
  }
  return { output, usage: null, cost: null, latencyMs: 0 };
};
