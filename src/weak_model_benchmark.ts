import { chatCases, type ChatTurn } from "./chat_cases.js";
import { BeliefRuntime, type BeliefPatch, type BeliefSnapshot, type InferBeliefsAdapter } from "./runtime.js";
import type { BeliefState } from "./ast.js";
import type { OpenAIUsage } from "./openai.js";

type IntentChange = "keep" | "book_flight" | "book_hotel" | "unknown";
type FlagChange = "keep" | "yes" | "no";
type Changes = { intent: IntentChange; budget_sensitive: FlagChange; prefers_direct: FlagChange };
type Prediction = { intent: string; budget_sensitive: boolean; prefers_direct: boolean };

const INSTRUCTIONS = "Read only the latest user message in a travel-support chat. Report changes to three facts: the task requested now, whether the user prefers a low price, and whether the user prefers a nonstop flight. For intent, a request to find or keep working on a flight, airfare, or air ticket is book_flight; a request for a hotel, room, or lodging is book_hotel; a request for train tickets or another task is unknown. Report that task even when the user says switch, go back, keep working, or continue. Ignore side mentions of a task the user says to postpone or stop. Use keep only when the message does not identify the current task. For budget_sensitive, yes means a low price, spending cap, savings, or willingness to drop amenities to stay within a cap; no means the user explicitly lifts the price limit or says a higher price is fine. For prefers_direct, yes means nonstop or no stops; no means stops or connections are acceptable. For each preference, use keep if this message gives no change. Do not infer no from giving up an amenity while staying within a spending cap. Do not guess from missing information. Return only the required JSON fields.";
const SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["keep", "book_flight", "book_hotel", "unknown"] },
    budget_sensitive: { type: "string", enum: ["keep", "yes", "no"] },
    prefers_direct: { type: "string", enum: ["keep", "yes", "no"] },
  },
  required: ["intent", "budget_sensitive", "prefers_direct"],
  additionalProperties: false,
};

function initialSnapshot(): BeliefSnapshot {
  return { version: 1, beliefs: {
    intent: { cardinality: "exclusive", domain: "closed", values: { book_flight: 0, book_hotel: 0, unknown: 1 } },
    user: { cardinality: "multi", domain: "closed", values: { budget_sensitive: 0, prefers_direct: 0 } },
  } };
}

function toPatch(changes: Changes): BeliefPatch {
  const patch: BeliefPatch = {};
  if (changes.intent !== "keep") {
    patch.intent = { cardinality: "exclusive", domain: "closed", values: {
      book_flight: Number(changes.intent === "book_flight"),
      book_hotel: Number(changes.intent === "book_hotel"),
      unknown: Number(changes.intent === "unknown"),
    } };
  }
  const user: Record<string, number> = {};
  for (const key of ["budget_sensitive", "prefers_direct"] as const) {
    if (changes[key] !== "keep") user[key] = Number(changes[key] === "yes");
  }
  if (Object.keys(user).length) {
    patch.user = { cardinality: "multi", domain: "closed", values: user };
  }
  return patch;
}

function classify(state: BeliefState): Prediction {
  return {
    intent: Object.entries(state.intent).sort((a, b) => b[1] - a[1])[0][0],
    budget_sensitive: state.user.budget_sensitive >= 0.5,
    prefers_direct: state.user.prefers_direct >= 0.5,
  };
}

function expected(turn: ChatTurn): Prediction {
  return { intent: turn.intent, budget_sensitive: turn.budget_sensitive, prefers_direct: turn.prefers_direct };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-nano-2025-04-14";
  let latest: { usage?: OpenAIUsage; changes?: Changes } = {};
  const inferBeliefs: InferBeliefsAdapter = async (source) => {
    if (typeof source !== "string") throw new Error("expected latest message text");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, store: false, instructions: INSTRUCTIONS, input: source,
        text: { format: { type: "json_schema", name: "travel_changes", strict: true, schema: SCHEMA } },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI API returned HTTP ${response.status}`);
    const data = await response.json() as {
      status: string;
      output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
      usage: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };
    };
    if (data.status !== "completed") throw new Error(`OpenAI response status: ${data.status}`);
    const output = data.output.flatMap((item) => item.type === "message" ? item.content ?? [] : [])
      .filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
    const changes = JSON.parse(output) as Changes;
    latest.changes = changes;
    latest.usage = {
      input_tokens: data.usage.input_tokens,
      output_tokens: data.usage.output_tokens,
      cached_input_tokens: data.usage.input_tokens_details?.cached_tokens ?? 0,
    };
    return toPatch(changes);
  };

  const rows = [];
  for (const conversation of chatCases) {
    let snapshot = initialSnapshot();
    for (const turn of conversation.turns) {
      latest = {};
      const runtime = new BeliefRuntime({}, { inferBeliefs });
      runtime.loadBeliefSnapshot(snapshot);
      await runtime.assign("message", { kind: "string", value: turn.message });
      const started = performance.now();
      await runtime.infer({ kind: "identifier", name: "message" });
      const latencyMs = Math.round(performance.now() - started);
      if (!latest.usage || !latest.changes) throw new Error("missing model output");
      snapshot = runtime.getBeliefSnapshot();
      const predicted = classify(runtime.getState());
      const truth = expected(turn);
      rows.push({ conversation: conversation.id, turn: turn.id, expected: truth, predicted,
        exact_match: predicted.intent === truth.intent &&
          predicted.budget_sensitive === truth.budget_sensitive &&
          predicted.prefers_direct === truth.prefers_direct,
        changes: latest.changes, usage: latest.usage, latency_ms: latencyMs });
    }
  }
  const inputTokens = rows.reduce((sum, row) => sum + row.usage.input_tokens, 0);
  const outputTokens = rows.reduce((sum, row) => sum + row.usage.output_tokens, 0);
  console.log(JSON.stringify({
    benchmark: "travel-chat-weak-model-delta-v1", model,
    method: "The model reads only the latest message and reports changes; BeliefLang applies each patch to its saved belief snapshot.",
    instructions: INSTRUCTIONS,
    turns: rows.length, exact_match_turns: rows.filter((row) => row.exact_match).length,
    intent_correct: rows.filter((row) => row.predicted.intent === row.expected.intent).length,
    preference_fields_correct: rows.reduce((n, row) => n +
      Number(row.predicted.budget_sensitive === row.expected.budget_sensitive) +
      Number(row.predicted.prefers_direct === row.expected.prefers_direct), 0),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    rows,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
