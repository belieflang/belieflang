import { chatCases, type ChatTurn } from "./chat_cases.js";
import { CHAT_INSTRUCTIONS, snapshotTurnInput } from "./chat_protocol.js";
import { createOpenAIInferAdapter, type OpenAIUsage } from "./openai.js";
import { createJevInferAdapter, type JevUsage } from "./jev.js";
import { BeliefRuntime, type BeliefSnapshot } from "./runtime.js";
import type { BeliefState } from "./ast.js";

const STRONG_MODEL = "gpt-6.1-sol";
const LUNA_MODEL = "gpt-6-luna";
const SMALL_MODEL = "gpt-4.1-nano-2025-04-14";
const JEV_MODEL = "jev-latest";
type Engine = "strong" | "luna" | "small" | "jev";
type Prediction = { intent: string; budget_sensitive: boolean; prefers_direct: boolean };
type Usage = { input_tokens: number; output_tokens: number; cached_input_tokens?: number; cache_write_tokens?: number };
type Row = {
  conversation: string;
  turn: string;
  seed: boolean;
  engine: Engine;
  model: string;
  expected: Prediction;
  predicted: Prediction;
  exact_match: boolean;
  usage: Usage;
  estimated_usd: number;
  latency_ms: number;
};

function prediction(state: BeliefState): Prediction {
  if (!state.intent || !state.user) throw new Error("missing chat beliefs");
  return {
    intent: Object.entries(state.intent).sort((a, b) => b[1] - a[1])[0][0],
    budget_sensitive: state.user.budget_sensitive >= 0.5,
    prefers_direct: state.user.prefers_direct >= 0.5,
  };
}

function cost(usage: Usage, engine: Engine): number {
  if (engine === "jev") return usage.input_tokens * 0.042 / 1_000_000;
  const cached = usage.cached_input_tokens ?? 0;
  const writes = usage.cache_write_tokens ?? 0;
  const plain = usage.input_tokens - cached - writes;
  if (plain < 0 || (engine === "small" && writes > 0)) throw new Error("unsupported cache usage");
  const rate = engine === "strong"
    ? { input: 2, cached: 0.1, writes: 2.5, output: 10 }
    : engine === "luna"
      ? { input: 0.1, cached: 0.01, writes: 0.125, output: 0.5 }
    : { input: 0.1, cached: 0.025, writes: 0, output: 0.4 };
  return (plain * rate.input + cached * rate.cached + writes * rate.writes +
    usage.output_tokens * rate.output) / 1_000_000;
}

async function infer(engine: Engine, snapshot: BeliefSnapshot, message: string,
  openaiKey: string, jevKey: string): Promise<{ snapshot: BeliefSnapshot; state: BeliefState; usage: Usage; latency_ms: number }> {
  let usage: Usage | undefined;
  const model = engine === "strong" ? STRONG_MODEL : engine === "luna" ? LUNA_MODEL
    : engine === "small" ? SMALL_MODEL : JEV_MODEL;
  const adapter = engine === "jev"
    ? createJevInferAdapter({ apiKey: jevKey, model, chatSnapshot: true,
      onUsage: (value: JevUsage) => { usage = value; } })
    : createOpenAIInferAdapter({ apiKey: openaiKey, model, instructions: CHAT_INSTRUCTIONS,
      onUsage: (value: OpenAIUsage) => { usage = value; } });
  const runtime = new BeliefRuntime({}, { inferBeliefs: adapter });
  runtime.loadBeliefSnapshot(snapshot);
  await runtime.assign("turn_input", { kind: "string", value: snapshotTurnInput(snapshot, message) });
  const start = performance.now();
  await runtime.infer({ kind: "identifier", name: "turn_input" });
  const latency = Math.round(performance.now() - start);
  if (!usage) throw new Error("provider returned no usage");
  return { snapshot: runtime.getBeliefSnapshot(), state: runtime.getState(), usage, latency_ms: latency };
}

async function run(name: string, seedEngine: Engine, continuationEngine: Engine,
  openaiKey: string, jevKey: string) {
  const rows: Row[] = [];
  for (const conversation of chatCases) {
    let snapshot: BeliefSnapshot = { version: 1, beliefs: {} };
    for (const [index, turn] of conversation.turns.entries()) {
      const engine = index === 0 ? seedEngine : continuationEngine;
      const result = await infer(engine, snapshot, turn.message, openaiKey, jevKey);
      snapshot = result.snapshot;
      const expected: Prediction = { intent: turn.intent,
        budget_sensitive: turn.budget_sensitive, prefers_direct: turn.prefers_direct };
      const predicted = prediction(result.state);
      rows.push({ conversation: conversation.id, turn: turn.id, seed: index === 0,
        engine, model: engine === "strong" ? STRONG_MODEL : engine === "luna" ? LUNA_MODEL
          : engine === "small" ? SMALL_MODEL : JEV_MODEL,
        expected, predicted,
        exact_match: predicted.intent === expected.intent &&
          predicted.budget_sensitive === expected.budget_sensitive &&
          predicted.prefers_direct === expected.prefers_direct,
        usage: result.usage, estimated_usd: cost(result.usage, engine), latency_ms: result.latency_ms });
    }
  }
  const sum = (field: keyof Usage) => rows.reduce((total, row) => total + (row.usage[field] ?? 0), 0);
  const latencies = rows.map((row) => row.latency_ms).sort((a, b) => a - b);
  return { name, seed_engine: seedEngine, continuation_engine: continuationEngine,
    turns: rows.length, exact_match_turns: rows.filter((row) => row.exact_match).length,
    input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"),
    total_provider_tokens: sum("input_tokens") + sum("output_tokens"),
    estimated_usd: rows.reduce((total, row) => total + row.estimated_usd, 0),
    median_latency_ms: (latencies[9] + latencies[10]) / 2,
    rows };
}

async function main(): Promise<void> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const jevKey = process.env.TYPESAFE_API_KEY;
  if (!openaiKey || !jevKey) throw new Error("OPENAI_API_KEY and TYPESAFE_API_KEY are required");
  const flows: Array<[string, Engine, Engine]> = [
    ["nano_only", "small", "small"],
    ["sol_seed_nano_updates", "strong", "small"],
    ["jev_only", "jev", "jev"],
    ["sol_seed_jev_updates", "strong", "jev"],
    ["luna_seed_nano_updates", "luna", "small"],
    ["luna_seed_jev_updates", "luna", "jev"],
  ];
  const requested = process.argv.slice(2);
  if (requested.some((name) => !flows.some(([flowName]) => flowName === name)) ||
    new Set(requested).size !== requested.length) {
    throw new Error(`choose unique flow names from: ${flows.map(([name]) => name).join(", ")}`);
  }
  const selected = requested.length ? flows.filter(([name]) => requested.includes(name)) : flows;
  const results = [];
  for (const [name, seed, continuation] of selected) {
    console.error(`Running ${name}...`);
    results.push(await run(name, seed, continuation, openaiKey, jevKey));
  }
  console.log(JSON.stringify({ benchmark: "travel-chat-seed-continuation-v1",
    models: { strong: STRONG_MODEL, luna: LUNA_MODEL, small: SMALL_MODEL, jev: JEV_MODEL },
    method: "Two 10-turn chats. Each path makes one seed call on turn one and one update call per later turn. Hybrid paths use GPT-6.1 Sol or GPT-6 Luna for turn one, then GPT-4.1 nano or Jev for turns two through ten. Each path is scored on all 20 turns. Belief snapshots and the new message are sent on every update. Costs include all calls, including the two seed calls where applicable. No settled-field omission is used in this test.",
    price_basis: "Published Standard text list rates on 2026-10-16: GPT-6.1 Sol $2 input, $0.10 cached, $2.50 writes, $10 output per 1M; GPT-6 Luna $0.10 input, $0.01 cached, $0.125 writes, $0.50 output; GPT-4.1 nano $0.10 input, $0.025 cached, $0.40 output; Jev $0.042 input, output free. USD estimates exclude local storage, taxes, and service-tier variation.",
    token_note: "Provider token counts are included for audit, but Jev and OpenAI use different token accounting and should not be compared as a common unit.",
    results }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
