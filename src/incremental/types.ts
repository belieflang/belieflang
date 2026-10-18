import type { FactSchema } from "../runtime.js";
import type { FactValue } from "../fact_memory.js";
export const METHODS = [
  "full_history",
  "rolling_summary",
  "plain_json",
  "belieflang_v3",
] as const;
export const SCHEDULES = ["sparse", "dense"] as const;
export type Method = (typeof METHODS)[number];
export type Schedule = (typeof SCHEDULES)[number];
export type Temporal = "current" | "original";
export type Query = { field: string; temporal: Temporal };
export type Answer = {
  value: FactValue | null;
  status: "confirmed" | "uncertain" | "conflicting" | "cleared" | "missing";
  sourceTurn: number | null;
};
export type Event = { id: string } & (
  | { type: "chat"; text: string }
  | { type: "host"; facts: Record<string, FactValue> }
  | { type: "approval"; allowed: boolean; values: Record<string, FactValue> }
  | { type: "ask"; text: string }
);
export type Case = {
  id: string;
  schema: FactSchema;
  numeric: string;
  flag: string;
  auxiliary: string;
  maximum: number;
  action: string;
  sparseAfter: number[];
  events: Event[];
};
export type Request = {
  id: string;
  kind: "route" | "update" | "summary" | "read";
  prompt: string;
  schema: Record<string, unknown>;
};
export type Usage = {
  input: number;
  output: number;
  cached: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
};
export type Result = {
  output?: unknown;
  error?: string;
  usage: Usage | null;
  cost: { lower: number; upper: number } | null;
  latencyMs: number | null;
  metadata?: {
    model: string | null;
    tier: string | null;
    responseId: string | null;
  };
  replayed?: boolean;
};
export type Inference = (request: Request) => Promise<Result>;
export type Gold = Record<
  string,
  { queries: Query[]; answers: Answer[]; allowed?: boolean }
>;
export const key = (q: Query) => `${q.temporal}:${q.field}`;
export const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value) ?? "");
export const queries = (c: Case): Query[] => [
  { field: c.numeric, temporal: "current" },
  { field: c.auxiliary, temporal: "current" },
  { field: c.numeric, temporal: "original" },
  { field: c.flag, temporal: "current" },
];
export const missing = (): Answer => ({
  value: null,
  status: "missing",
  sourceTurn: null,
});
