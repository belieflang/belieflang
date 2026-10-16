import { chatCases } from "./chat_cases.js";
import { CHAT_CODE_BASE_INSTRUCTIONS, CHAT_CODE_INSTRUCTIONS, decodeChatCode, encodeChatCode, type ChatCodeVariant } from "./chat_code.js";
import { createOpenAIInferAdapter, type OpenAIUsage } from "./openai.js";
import { BeliefRuntime } from "./runtime.js";
import type { BeliefState } from "./ast.js";

const variants: ChatCodeVariant[] = ["base36_5", "dominant_4", "dominant_5", "dominant_6", "labeled_7", "labeled_8", "labeled_9", "labeled_10"];
type Prediction = { intent: string; budget_sensitive: boolean; prefers_direct: boolean };
type BenchRow = {
  conversation: string;
  turn: string;
  code: string;
  expected: Prediction;
  predicted: Prediction;
  exact_match: boolean;
  max_decode_error: number;
  usage: OpenAIUsage;
  estimated_usd: number | null;
  latency_ms: number;
};

const fidelityProbes: BeliefState[] = [
  { intent: { book_flight: 0.49, book_hotel: 0.48, unknown: 0.03 }, user: { budget_sensitive: 0.78, prefers_direct: 0.22 } },
  { intent: { book_flight: 0.7, book_hotel: 0.2, unknown: 0.1 }, user: { budget_sensitive: 0.51, prefers_direct: 0.49 } },
  { intent: { book_flight: 0.34, book_hotel: 0.33, unknown: 0.33 }, user: { budget_sensitive: 0.1, prefers_direct: 0.9 } },
  { intent: { book_flight: 0.15, book_hotel: 0.1, unknown: 0.75 }, user: { budget_sensitive: 0.8, prefers_direct: 0.2 } },
];

function maxError(original: BeliefState, decoded: BeliefState): number {
  return Math.max(...["intent", "user"].flatMap((group) =>
    Object.keys(original[group]).map((label) => Math.abs(original[group][label] - decoded[group][label]))));
}

function prediction(state: BeliefState) {
  return {
    intent: Object.entries(state.intent).sort((a, b) => b[1] - a[1])[0][0],
    budget_sensitive: state.user.budget_sensitive >= 0.5,
    prefers_direct: state.user.prefers_direct >= 0.5,
  };
}

function cost(usage: OpenAIUsage, model: string): number | null {
  if (model !== "gpt-6-luna") return null;
  const cached = usage.cached_input_tokens ?? 0;
  const writes = usage.cache_write_tokens ?? 0;
  return ((usage.input_tokens - cached - writes) * 0.10 + cached * 0.01 + writes * 0.125 + usage.output_tokens * 0.50) / 1_000_000;
}

async function run(variant: ChatCodeVariant, apiKey: string, model: string) {
  const rows: BenchRow[] = [];
  for (const conversation of chatCases) {
    let code: string | null = null;
    for (const turn of conversation.turns) {
      let usage: OpenAIUsage | undefined;
      const inferBeliefs = createOpenAIInferAdapter({
        apiKey, model, instructions: `${CHAT_CODE_BASE_INSTRUCTIONS} ${CHAT_CODE_INSTRUCTIONS[variant]}`,
        onUsage: (value) => { usage = value; },
      });
      const runtime = new BeliefRuntime({}, { inferBeliefs });
      if (code) {
        const beliefs = decodeChatCode(code, variant);
        runtime.loadBeliefSnapshot({ version: 1, beliefs: {
          intent: { cardinality: "exclusive", domain: "closed", values: beliefs.intent },
          user: { cardinality: "multi", domain: "closed", values: beliefs.user },
        } });
      }
      const input = JSON.stringify({ previous_code: code, new_message: turn.message });
      await runtime.assign("turn_input", { kind: "string", value: input });
      const start = performance.now();
      await runtime.infer({ kind: "identifier", name: "turn_input" });
      const latency_ms = Math.round(performance.now() - start);
      if (!usage) throw new Error("OpenAI response has no usage");
      const raw = runtime.getState();
      code = encodeChatCode(raw, variant);
      const decoded = decodeChatCode(code, variant);
      const expected = { intent: turn.intent, budget_sensitive: turn.budget_sensitive, prefers_direct: turn.prefers_direct };
      const predicted = prediction(decoded);
      const max_decode_error = maxError(raw, decoded);
      rows.push({ conversation: conversation.id, turn: turn.id, code, expected, predicted,
        exact_match: Object.keys(expected).every((key) => expected[key as keyof typeof expected] === predicted[key as keyof typeof predicted]),
        max_decode_error, usage, estimated_usd: cost(usage, model), latency_ms });
    }
  }
  const sum = (field: keyof OpenAIUsage) => rows.reduce((total, row) => total + (row.usage[field] ?? 0), 0);
  return {
    variant,
    code_characters: variant === "dominant_4" ? 4 : variant === "dominant_5" || variant === "base36_5" ? 5 : variant === "dominant_6" ? 6 : variant === "labeled_7" ? 7 : variant === "labeled_8" ? 8 : variant === "labeled_9" ? 9 : 10,
    exact_match_turns: rows.filter((row) => row.exact_match).length,
    turns: rows.length,
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    total_tokens: sum("input_tokens") + sum("output_tokens"),
    estimated_usd: rows.every((row) => row.estimated_usd !== null)
      ? rows.reduce((total, row) => total + row.estimated_usd!, 0) : null,
    max_decode_error: Math.max(...rows.map((row) => row.max_decode_error)),
    probe_max_decode_error: Math.max(...fidelityProbes.map((state) =>
      maxError(state, decodeChatCode(encodeChatCode(state, variant), variant)))),
    wrong_turns: rows.filter((row) => !row.exact_match).map((row) => row.turn),
    rows,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the chat code benchmark");
  const model = process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const selected = process.argv.slice(2);
  if (selected.some((variant) => !variants.includes(variant as ChatCodeVariant))) {
    throw new Error(`variants must be one of ${variants.join(", ")}`);
  }
  const results = [];
  for (const variant of (selected.length ? selected : variants) as ChatCodeVariant[]) {
    console.error(`Running ${variant}...`);
    results.push(await run(variant, apiKey, model));
  }
  console.log(JSON.stringify({ benchmark: "travel-chat-code-v1", model, results }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
