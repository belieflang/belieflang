import { chatCases, type ChatTurn } from "./chat_cases.js";
import { encodeChatBeliefs, decodeChatBeliefs } from "./chat_code.js";
import { createOpenAIInferAdapter, type OpenAIOptions, type OpenAIUsage } from "./openai.js";
import { BeliefRuntime, type BeliefSnapshot } from "./runtime.js";
import type { BeliefState } from "./ast.js";

const INSTRUCTIONS = "Maintain current beliefs for a travel-support conversation. Each input JSON has new_message. Prior context comes from one of: earlier turns in this conversation; previous_beliefs containing the prior belief values; or previous_code, a five-character base-36 code. In previous_code, positions 1-5 mean book_flight, book_hotel, unknown, budget_sensitive, prefers_direct. Each character 0-9 or a-z is an integer 0-35 divided by 35; normalize the first three as primary intent probabilities. Null code means no prior beliefs. Return current probabilities for primary intent book_flight, book_hotel, or unknown, summing to 1. Return independent probabilities for budget_sensitive (low price) and prefers_direct (nonstop flight). The latest explicit change overrides older statements; otherwise preferences persist. Base the result only on supplied context.";
const FOCUSED_INSTRUCTIONS = "Maintain current beliefs for a travel-support conversation. Each input JSON has new_message. Prior context comes from earlier turns in this conversation or previous_beliefs containing the saved belief values. Return probabilities for the current primary request: book_flight, book_hotel, or unknown if it is neither. These three probabilities should sum to 1. Return independent probabilities for budget_sensitive (prefers a low price) and prefers_direct (prefers a nonstop flight). The latest explicit change overrides older statements; otherwise preferences persist. Base the result only on the supplied context.";

type Workflow = "provider_history" | "provider_compacted" | "belief_snapshot" | "coded_snapshot";
type Prediction = { intent: string; budget_sensitive: boolean; prefers_direct: boolean };
type Row = {
  conversation: string;
  turn: string;
  expected: Prediction;
  predicted: Prediction;
  exact_match: boolean;
  usage: OpenAIUsage;
  estimated_usd: number | null;
  latency_ms: number;
  compaction_items: number;
  code?: string;
  decoded_beliefs?: BeliefState;
  max_decode_error?: number;
};

function prediction(state: BeliefState): Prediction {
  const intent = state.intent;
  const user = state.user;
  if (!intent || !user) throw new Error("missing chat beliefs");
  return {
    intent: Object.entries(intent).sort((a, b) => b[1] - a[1])[0][0],
    budget_sensitive: user.budget_sensitive >= 0.5,
    prefers_direct: user.prefers_direct >= 0.5,
  };
}

// Standard GPT-6 Luna short-context prices per million tokens, checked on 2026-10-15.
function estimatedCost(usage: OpenAIUsage, model: string): number | null {
  if (model !== "gpt-6-luna") return null;
  const cached = usage.cached_input_tokens ?? 0;
  const cacheWrite = usage.cache_write_tokens ?? 0;
  const uncached = usage.input_tokens - cached - cacheWrite;
  if (uncached < 0) throw new Error("OpenAI cache token counts exceed input tokens");
  return (uncached * 0.10 + cached * 0.01 + cacheWrite * 0.125 + usage.output_tokens * 0.50) / 1_000_000;
}

function row(conversation: string, turn: ChatTurn, state: BeliefState, usage: OpenAIUsage,
  latencyMs: number, model: string, compactionItems: number, code?: string): Row {
  const decoded = code ? decodeChatBeliefs(code) : undefined;
  const scoredState = decoded ?? state;
  const expected: Prediction = {
    intent: turn.intent,
    budget_sensitive: turn.budget_sensitive,
    prefers_direct: turn.prefers_direct,
  };
  const predicted = prediction(scoredState);
  const maxDecodeError = decoded ? Math.max(...["intent", "user"].flatMap((group) =>
    Object.keys(state[group]).map((label) => Math.abs(state[group][label] - decoded[group][label])))) : undefined;
  return {
    conversation, turn: turn.id, expected, predicted,
    exact_match: Object.keys(expected).every((key) =>
      expected[key as keyof Prediction] === predicted[key as keyof Prediction]),
    usage, estimated_usd: estimatedCost(usage, model), latency_ms: latencyMs, compaction_items: compactionItems,
    ...(code ? { code, decoded_beliefs: decoded, max_decode_error: maxDecodeError } : {}),
  };
}

function summarize(workflow: Workflow, rows: Row[]) {
  const sum = (field: keyof OpenAIUsage) => rows.reduce((total, result) => total + (result.usage[field] ?? 0), 0);
  const latencies = rows.map((result) => result.latency_ms).sort((a, b) => a - b);
  return {
    workflow,
    turns: rows.length,
    exact_match_turns: rows.filter((result) => result.exact_match).length,
    input_tokens: sum("input_tokens"),
    cached_input_tokens: sum("cached_input_tokens"),
    cache_write_tokens: sum("cache_write_tokens"),
    output_tokens: sum("output_tokens"),
    total_tokens: sum("input_tokens") + sum("output_tokens"),
    estimated_usd: rows.every((result) => result.estimated_usd !== null)
      ? rows.reduce((total, result) => total + result.estimated_usd!, 0) : null,
    median_latency_ms: (latencies[9] + latencies[10]) / 2,
    compaction_items: rows.reduce((total, result) => total + result.compaction_items, 0),
    max_decode_error: workflow === "coded_snapshot" ? Math.max(...rows.map((result) => result.max_decode_error ?? 0)) : null,
    rows,
  };
}

async function run(workflow: Workflow, apiKey: string, model: string,
  instructions: string): Promise<ReturnType<typeof summarize>> {
  const rows: Row[] = [];
  for (const conversation of chatCases) {
    let previousResponseId: string | undefined;
    let snapshot: BeliefSnapshot = { version: 1, beliefs: {} };
    let code: string | null = null;
    for (const turn of conversation.turns) {
      let usage: OpenAIUsage | undefined;
      let responseId: string | undefined;
      let compactionItems = 0;
      const options: OpenAIOptions = {
        apiKey, model, instructions,
        store: workflow === "provider_history" || workflow === "provider_compacted",
        ...(previousResponseId ? { previousResponseId } : {}),
        ...(workflow === "provider_compacted" ? { compactThreshold: 1000 } : {}),
        onUsage: (value) => { usage = value; },
        onResponseId: (id) => { responseId = id; },
        onCompactionItems: (count) => { compactionItems = count; },
      };
      const runtime = new BeliefRuntime({}, { inferBeliefs: createOpenAIInferAdapter(options) });
      if (workflow === "belief_snapshot") runtime.loadBeliefSnapshot(snapshot);
      if (workflow === "coded_snapshot" && code) {
        const beliefs = decodeChatBeliefs(code);
        runtime.loadBeliefSnapshot({ version: 1, beliefs: {
          intent: { cardinality: "exclusive", domain: "closed", values: beliefs.intent },
          user: { cardinality: "multi", domain: "closed", values: beliefs.user },
        } });
      }
      const input = workflow === "belief_snapshot"
        ? { previous_beliefs: snapshot.beliefs, new_message: turn.message }
        : workflow === "coded_snapshot"
          ? { previous_code: code, new_message: turn.message }
          : { new_message: turn.message };
      await runtime.assign("turn_input", { kind: "string", value: JSON.stringify(input) });
      const start = performance.now();
      await runtime.infer({ kind: "identifier", name: "turn_input" });
      const latencyMs = Math.round(performance.now() - start);
      if (!usage) throw new Error("OpenAI response has no token usage");
      const state = runtime.getState();
      if (workflow === "provider_history" || workflow === "provider_compacted") {
        if (!responseId) throw new Error("OpenAI response has no id for conversation continuation");
        previousResponseId = responseId;
      } else if (workflow === "belief_snapshot") {
        snapshot = runtime.getBeliefSnapshot();
      } else {
        code = encodeChatBeliefs(state);
      }
      rows.push(row(conversation.id, turn, state, usage, latencyMs, model, compactionItems, code ?? undefined));
    }
  }
  return summarize(workflow, rows);
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the market chat benchmark");
  const model = process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const promptVariant = process.env.CHAT_BENCHMARK_PROMPT ?? "all";
  if (promptVariant !== "all" && promptVariant !== "focused") {
    throw new Error("CHAT_BENCHMARK_PROMPT must be all or focused");
  }
  const allWorkflows: Workflow[] = ["provider_history", "provider_compacted", "belief_snapshot", "coded_snapshot"];
  const requested = process.argv.slice(2);
  if (requested.some((value) => !allWorkflows.includes(value as Workflow)) ||
      new Set(requested).size !== requested.length) {
    throw new Error(`workflows must be unique choices from: ${allWorkflows.join(", ")}`);
  }
  const workflows = requested.length ? requested as Workflow[] : allWorkflows;
  if (promptVariant === "focused" && workflows.some((workflow) =>
    workflow !== "provider_history" && workflow !== "belief_snapshot")) {
    throw new Error("focused prompt supports provider_history and belief_snapshot only");
  }
  const results = [];
  for (const workflow of workflows) {
    console.error(`Running ${workflow}...`);
    results.push(await run(workflow, apiKey, model,
      promptVariant === "focused" ? FOCUSED_INSTRUCTIONS : INSTRUCTIONS));
  }
  console.log(JSON.stringify({
    benchmark: "travel-chat-market-v1",
    model,
    prompt_variant: promptVariant,
    instructions: promptVariant === "focused" ? FOCUSED_INSTRUCTIONS : INSTRUCTIONS,
    price_basis: model === "gpt-6-luna" ? "GPT-6 Luna Standard short-context USD per 1M tokens, 2026-10-15" : null,
    pricing_note: "Includes every inference call that creates or updates the beliefs, its output tokens, and later snapshot input tokens. Chats start fresh; backfilling an existing conversation is not measured. Estimated model token charges only; excludes local snapshot serialization/storage, taxes, service tiers, and any separate compaction charge not reported in response usage. Reported request latency excludes local snapshot loading and saving.",
    code_format: "five base-36 characters: flight, hotel, unknown, budget, direct; each quantized to 1/35",
    results,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
