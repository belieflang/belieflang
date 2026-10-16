import { chatCases, type ChatTurn } from "./chat_cases.js";
import { CHAT_INSTRUCTIONS, fullHistoryInput, snapshotTurnInput } from "./chat_protocol.js";
import { createOpenAIInferAdapter, type OpenAIUsage } from "./openai.js";
import { BeliefRuntime, type BeliefSnapshot } from "./runtime.js";
import type { BeliefState } from "./ast.js";

const STRONG_MODEL = "gpt-6-luna";
const WEAK_MODEL = "gpt-4.1-nano-2025-04-14";
const SEED_TURNS = 5;

type Prediction = { intent: string; budget_sensitive: boolean; prefers_direct: boolean };
type CallResult = { state: BeliefState; snapshot: BeliefSnapshot; usage: OpenAIUsage; latency_ms: number };
type Row = {
  conversation: string;
  turn: string;
  expected: Prediction;
  predicted: Prediction;
  exact_match: boolean;
  model: string;
  usage: OpenAIUsage;
  estimated_usd: number;
  latency_ms: number;
};

function classify(state: BeliefState): Prediction {
  if (!state.intent || !state.user) throw new Error("missing chat belief state");
  return {
    intent: Object.entries(state.intent).sort((a, b) => b[1] - a[1])[0][0],
    budget_sensitive: state.user.budget_sensitive >= 0.5,
    prefers_direct: state.user.prefers_direct >= 0.5,
  };
}

function expected(turn: ChatTurn): Prediction {
  return { intent: turn.intent, budget_sensitive: turn.budget_sensitive, prefers_direct: turn.prefers_direct };
}

function estimatedCost(usage: OpenAIUsage, model: string): number {
  const cached = usage.cached_input_tokens ?? 0;
  const writes = usage.cache_write_tokens ?? 0;
  const uncached = usage.input_tokens - cached - writes;
  if (uncached < 0) throw new Error("cache token counts exceed input tokens");
  if (model === WEAK_MODEL && writes > 0) throw new Error("nano cache-write price is not configured");
  const rates = model === STRONG_MODEL
    ? { input: 0.10, cached: 0.01, writes: 0.125, output: 0.50 }
    : { input: 0.10, cached: 0.025, writes: 0, output: 0.40 };
  return (uncached * rates.input + cached * rates.cached + writes * rates.writes +
    usage.output_tokens * rates.output) / 1_000_000;
}

async function infer(apiKey: string, model: string, input: string,
  snapshot?: BeliefSnapshot): Promise<CallResult> {
  let usage: OpenAIUsage | undefined;
  const runtime = new BeliefRuntime({}, { inferBeliefs: createOpenAIInferAdapter({
    apiKey, model, instructions: CHAT_INSTRUCTIONS,
    onUsage: (value) => { usage = value; },
  }) });
  if (snapshot) runtime.loadBeliefSnapshot(snapshot);
  await runtime.assign("turn_input", { kind: "string", value: input });
  const started = performance.now();
  await runtime.infer({ kind: "identifier", name: "turn_input" });
  const latencyMs = Math.round(performance.now() - started);
  if (!usage) throw new Error("OpenAI response has no token usage");
  return { state: runtime.getState(), snapshot: runtime.getBeliefSnapshot(), usage, latency_ms: latencyMs };
}

function row(conversation: string, turn: ChatTurn, result: CallResult, model: string): Row {
  const predicted = classify(result.state);
  const truth = expected(turn);
  return {
    conversation, turn: turn.id, expected: truth, predicted,
    exact_match: predicted.intent === truth.intent &&
      predicted.budget_sensitive === truth.budget_sensitive &&
      predicted.prefers_direct === truth.prefers_direct,
    model, usage: result.usage, estimated_usd: estimatedCost(result.usage, model),
    latency_ms: result.latency_ms,
  };
}

function totals(rows: Row[]) {
  const sum = (key: keyof OpenAIUsage) => rows.reduce((n, result) => n + (result.usage[key] ?? 0), 0);
  return {
    calls: rows.length,
    input_tokens: sum("input_tokens"), cached_input_tokens: sum("cached_input_tokens"),
    cache_write_tokens: sum("cache_write_tokens"), output_tokens: sum("output_tokens"),
    total_tokens: sum("input_tokens") + sum("output_tokens"),
    estimated_usd: rows.reduce((n, result) => n + result.estimated_usd, 0),
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const baseline: Row[] = [];
  const strongSeeds: Row[] = [];
  const weakSeeds: Row[] = [];
  const strongHybrid: Row[] = [];
  const weakHybrid: Row[] = [];

  for (const conversation of chatCases) {
    const messages = conversation.turns.map((turn) => turn.message);
    const seedTurn = conversation.turns[SEED_TURNS - 1];
    const seed = await infer(apiKey, STRONG_MODEL, fullHistoryInput(messages.slice(0, SEED_TURNS)));
    strongSeeds.push(row(conversation.id, seedTurn, seed, STRONG_MODEL));
    let strongSnapshot = seed.snapshot;
    const weakSeed = await infer(apiKey, WEAK_MODEL, fullHistoryInput(messages.slice(0, SEED_TURNS)));
    weakSeeds.push(row(conversation.id, seedTurn, weakSeed, WEAK_MODEL));
    let weakSnapshot = weakSeed.snapshot;

    for (let index = SEED_TURNS; index < conversation.turns.length; index++) {
      const turn = conversation.turns[index];
      const full = await infer(apiKey, WEAK_MODEL, fullHistoryInput(messages.slice(0, index + 1)));
      baseline.push(row(conversation.id, turn, full, WEAK_MODEL));

      const strongUpdate = await infer(apiKey, WEAK_MODEL,
        snapshotTurnInput(strongSnapshot, turn.message), strongSnapshot);
      strongHybrid.push(row(conversation.id, turn, strongUpdate, WEAK_MODEL));
      strongSnapshot = strongUpdate.snapshot;

      const weakUpdate = await infer(apiKey, WEAK_MODEL,
        snapshotTurnInput(weakSnapshot, turn.message), weakSnapshot);
      weakHybrid.push(row(conversation.id, turn, weakUpdate, WEAK_MODEL));
      weakSnapshot = weakUpdate.snapshot;
    }
  }

  console.log(JSON.stringify({
    benchmark: "travel-chat-strong-seed-weak-update-v2",
    models: { seed: STRONG_MODEL, continuation: WEAK_MODEL },
    method: `Each chat starts with ${SEED_TURNS} prior messages. One strong-model or weak-model call turns that prefix into a BeliefLang snapshot. The weak model then updates either snapshot for each remaining turn. The full-history baseline sends all messages so far to the weak model on each remaining turn. All paths are scored on the same continuation turns.`,
    seed_turns_per_conversation: SEED_TURNS,
    scored_continuation_turns: strongHybrid.length,
    pricing_basis: "Standard text rates per 1M tokens checked 2026-10-15: GPT-6 Luna input $0.10, cached $0.01, cache writes $0.125, output $0.50; GPT-4.1 nano input $0.10, cached $0.025, output $0.40.",
    pricing_note: "Includes the seed calls and every weak-model continuation call for each snapshot path. Estimated API model charges only; excludes local snapshot storage and taxes. The full-history baseline does not make calls on the prefix because this benchmark begins with an existing five-message chat.",
    strong_seed: { exact_match_turns: strongSeeds.filter((result) => result.exact_match).length,
      ...totals(strongSeeds), rows: strongSeeds },
    weak_seed: { exact_match_turns: weakSeeds.filter((result) => result.exact_match).length,
      ...totals(weakSeeds), rows: weakSeeds },
    weak_full_history: { exact_match_turns: baseline.filter((result) => result.exact_match).length, ...totals(baseline), rows: baseline },
    strong_seed_weak_snapshot: { exact_match_turns: strongHybrid.filter((result) => result.exact_match).length,
      ...totals([...strongSeeds, ...strongHybrid]), continuation: totals(strongHybrid), rows: strongHybrid },
    weak_seed_weak_snapshot: { exact_match_turns: weakHybrid.filter((result) => result.exact_match).length,
      ...totals([...weakSeeds, ...weakHybrid]), continuation: totals(weakHybrid), rows: weakHybrid },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
