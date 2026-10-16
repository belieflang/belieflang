import { chatCases, type ChatTurn } from "./chat_cases.js";
import { createOpenAIInferAdapter, type OpenAIUsage } from "./openai.js";
import { BeliefRuntime, type BeliefPatch, type BeliefSnapshot } from "./runtime.js";
import type { BeliefState, RuntimeValue } from "./ast.js";

type Field = "intent" | "budget_sensitive" | "prefers_direct";
type Prediction = { intent: string; budget_sensitive: boolean; prefers_direct: boolean };
type Change = { field: Field; value: string };
const FIELDS: Field[] = ["intent", "budget_sensitive", "prefers_direct"];
const INTENTS = ["book_flight", "book_hotel", "unknown"] as const;
const probabilitySchema = { type: "number", minimum: 0, maximum: 1 };
const instructions = "Track the current request: book_flight, book_hotel, or unknown for any other request. Also track budget_sensitive (low price) and prefers_direct (nonstop flight). Input has a new_message and previous_state with settled values and uncertain scores. Return scores only for uncertain fields required by the output schema. In changes, report an explicit new value only when it differs from a settled value. Otherwise keep saved values. The latest explicit request wins. Intent scores sum to 1. Use only supplied input.";
const baselineInstructions = "Maintain current beliefs for a travel-support conversation. Each input JSON has new_message and previous_beliefs containing the saved belief values. Return probabilities for the current primary request: book_flight, book_hotel, or unknown if it is neither. These three probabilities should sum to 1. Return independent probabilities for budget_sensitive (prefers a low price) and prefers_direct (prefers a nonstop flight). The latest explicit change overrides older statements; otherwise preferences persist. Base the result only on the supplied context.";

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${name}`);
  }
  return value as Record<string, unknown>;
}

function probability(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid probability for ${name}`);
  }
  return value;
}

function tokenCount(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid token count for ${name}`);
  }
  return value;
}

function prediction(state: BeliefState): Prediction {
  if (!state.intent || !state.user) throw new Error("missing beliefs");
  return {
    intent: Object.entries(state.intent).sort((a, b) => b[1] - a[1])[0][0],
    budget_sensitive: state.user.budget_sensitive >= 0.5,
    prefers_direct: state.user.prefers_direct >= 0.5,
  };
}

function fieldConfidence(state: BeliefState, field: Field): number {
  if (field === "intent") return Math.max(...Object.values(state.intent));
  const value = state.user[field];
  return Math.max(value, 1 - value);
}

function previousState(state: BeliefState, active: Field[]): Record<string, unknown> {
  const settled: Record<string, string | boolean> = {};
  const uncertain: Record<string, unknown> = {};
  const selected = prediction(state);
  for (const field of FIELDS) {
    if (active.includes(field)) {
      uncertain[field] = field === "intent" ? state.intent : state.user[field];
    } else {
      settled[field] = selected[field];
    }
  }
  return Object.keys(uncertain).length ? { settled, uncertain } : { settled };
}

function outputSchema(active: Field[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string", enum: FIELDS },
          value: { type: "string", enum: [...INTENTS, "true", "false"] },
        },
        required: ["field", "value"],
        additionalProperties: false,
      },
    },
  };
  if (active.includes("intent")) {
    properties.intent = {
      type: "object",
      properties: Object.fromEntries(INTENTS.map((label) => [label, probabilitySchema])),
      required: INTENTS,
      additionalProperties: false,
    };
  }
  if (active.includes("budget_sensitive")) properties.budget_sensitive = probabilitySchema;
  if (active.includes("prefers_direct")) properties.prefers_direct = probabilitySchema;
  return { type: "object", properties, required: ["changes", ...active], additionalProperties: false };
}

function parseChanges(value: unknown, active: Field[]): Change[] {
  if (!Array.isArray(value)) throw new Error("invalid changes array");
  const seen = new Set<Field>();
  return value.flatMap((item) => {
    const change = record(item, "change");
    const field = change.field;
    const selected = change.value;
    if (!FIELDS.includes(field as Field) || seen.has(field as Field)) {
      throw new Error(`invalid changed field ${String(field)}`);
    }
    if (field === "intent" ? !INTENTS.includes(selected as typeof INTENTS[number])
      : selected !== "true" && selected !== "false") {
      throw new Error(`invalid change value ${String(selected)} for ${String(field)}`);
    }
    seen.add(field as Field);
    return active.includes(field as Field) ? [] : [{ field: field as Field, value: selected as string }];
  });
}

function patchFromOutput(output: Record<string, unknown>, active: Field[], changes: Change[]): BeliefPatch {
  const patch: BeliefPatch = {};
  const intentChange = changes.find((change) => change.field === "intent");
  if (active.includes("intent")) {
    const intent = record(output.intent, "intent");
    patch.intent = { cardinality: "exclusive", domain: "closed", values: {
      book_flight: probability(intent.book_flight, "intent.book_flight"),
      book_hotel: probability(intent.book_hotel, "intent.book_hotel"),
      unknown: probability(intent.unknown, "intent.unknown"),
    } };
  } else if (intentChange) {
    patch.intent = { cardinality: "exclusive", domain: "closed", values:
      Object.fromEntries(INTENTS.map((label) => [label, label === intentChange.value ? 1 : 0])) };
  }
  const user: Record<string, number> = {};
  for (const field of ["budget_sensitive", "prefers_direct"] as const) {
    if (active.includes(field)) user[field] = probability(output[field], field);
    else {
      const change = changes.find((candidate) => candidate.field === field);
      if (change) user[field] = change.value === "true" ? 1 : 0;
    }
  }
  if (Object.keys(user).length) patch.user = { cardinality: "multi", domain: "closed", values: user };
  return patch;
}

async function requestSelective(apiKey: string, model: string, input: unknown, active: Field[]):
  Promise<{ patch: BeliefPatch; changes: Change[]; usage: OpenAIUsage }> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      ...(model === "gpt-6-luna" ? { reasoning: { effort: "none" } } : {}),
      store: false,
      instructions,
      input: JSON.stringify(input),
      text: { format: { type: "json_schema", name: "selective_beliefs", strict: true,
        schema: outputSchema(active) } },
    }),
  });
  if (!response.ok) throw new Error(`OpenAI API returned HTTP ${response.status}`);
  const data = record(await response.json(), "response");
  if (data.status !== "completed" || !Array.isArray(data.output)) {
    throw new Error(`OpenAI response status: ${String(data.status)}`);
  }
  const text = data.output.flatMap((item: unknown) => {
    const entry = record(item, "output item");
    if (entry.type !== "message" || !Array.isArray(entry.content)) return [];
    return entry.content.flatMap((part: unknown) => {
      const content = record(part, "output content");
      return content.type === "output_text" && typeof content.text === "string" ? [content.text] : [];
    });
  }).join("");
  if (!text) throw new Error("OpenAI response has no output text");
  const output = record(JSON.parse(text), "output text");
  const changes = parseChanges(output.changes, active);
  const usage = record(data.usage, "usage");
  return {
    patch: patchFromOutput(output, active, changes), changes,
    usage: {
      input_tokens: tokenCount(usage.input_tokens, "input_tokens"),
      output_tokens: tokenCount(usage.output_tokens, "output_tokens"),
      cached_input_tokens: tokenCount(record(usage.input_tokens_details ?? {}, "input details").cached_tokens ?? 0, "cached_tokens"),
    },
  };
}

function score(turn: ChatTurn, state: BeliefState): { predicted: Prediction; exact_match: boolean } {
  const predicted = prediction(state);
  return { predicted, exact_match: predicted.intent === turn.intent &&
    predicted.budget_sensitive === turn.budget_sensitive && predicted.prefers_direct === turn.prefers_direct };
}

async function runBaseline(apiKey: string, model: string) {
  const rows = [];
  for (const conversation of chatCases) {
    let snapshot: BeliefSnapshot = { version: 1, beliefs: {} };
    for (const turn of conversation.turns) {
      let usage: OpenAIUsage | undefined;
      const runtime = new BeliefRuntime({}, { inferBeliefs: createOpenAIInferAdapter({
        apiKey, model, instructions: baselineInstructions, onUsage: (value) => { usage = value; },
      }) });
      if (Object.keys(snapshot.beliefs).length) runtime.loadBeliefSnapshot(snapshot);
      await runtime.assign("input", { kind: "string", value: JSON.stringify({
        previous_beliefs: snapshot.beliefs, new_message: turn.message,
      }) });
      await runtime.infer({ kind: "identifier", name: "input" });
      if (!usage) throw new Error("baseline response has no usage");
      snapshot = runtime.getBeliefSnapshot();
      rows.push({ conversation: conversation.id, turn: turn.id, ...score(turn, runtime.getState()), usage });
    }
  }
  return summarize("full_snapshot", rows);
}

async function runSelective(apiKey: string, model: string, threshold: number) {
  const rows = [];
  for (const conversation of chatCases) {
    let snapshot: BeliefSnapshot = { version: 1, beliefs: {} };
    for (const turn of conversation.turns) {
      const runtime = new BeliefRuntime();
      const hasPrevious = Object.keys(snapshot.beliefs).length > 0;
      if (hasPrevious) runtime.loadBeliefSnapshot(snapshot);
      const prior = runtime.getState();
      const active = hasPrevious ? FIELDS.filter((field) => fieldConfidence(prior, field) < threshold) : FIELDS;
      let result: Awaited<ReturnType<typeof requestSelective>>;
      try {
        result = await requestSelective(apiKey, model, {
          previous_state: hasPrevious ? previousState(prior, active) : null,
          new_message: turn.message,
        }, active);
      } catch (error) {
        throw new Error(`${conversation.id}/${turn.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (Object.keys(result.patch).length) {
        runtime.mergeBeliefsFromRuntimeValue(result.patch as unknown as RuntimeValue,
          { origin: "infer", source: "selective update" });
      }
      snapshot = runtime.getBeliefSnapshot();
      rows.push({ conversation: conversation.id, turn: turn.id, ...score(turn, runtime.getState()),
        usage: result.usage, active, changes: result.changes,
        omitted_probability_updates: FIELDS.length - active.length });
    }
  }
  return summarize("settled_fields", rows);
}

function summarize(name: string, rows: Array<{ exact_match: boolean; usage: OpenAIUsage; omitted_probability_updates?: number }>) {
  const input = rows.reduce((sum, row) => sum + row.usage.input_tokens, 0);
  const output = rows.reduce((sum, row) => sum + row.usage.output_tokens, 0);
  return { name, turns: rows.length, exact_match_turns: rows.filter((row) => row.exact_match).length,
    input_tokens: input, output_tokens: output, total_tokens: input + output,
    omitted_probability_updates: rows.reduce((sum, row) => sum + (row.omitted_probability_updates ?? 0), 0), rows };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const model = process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const threshold = Number(process.env.SETTLE_THRESHOLD ?? "0.9");
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) {
    throw new Error("SETTLE_THRESHOLD must be between 0.5 and 1");
  }
  console.error("Running full snapshot baseline...");
  const baseline = await runBaseline(apiKey, model);
  console.error("Running settled-field updates...");
  const selective = await runSelective(apiKey, model, threshold);
  console.log(JSON.stringify({ benchmark: "travel-chat-settled-v3", model, threshold,
    method: "Fresh 20-turn API runs. Baseline updates five scores each turn. Selective updates uncertain fields and accepts explicit categorical changes to settled fields; each field is settled when its most likely value reaches the threshold. Both include the first snapshot-creation call. Model reported tokens only; no tool calls or local storage costs measured.",
    instructions: { baseline: baselineInstructions, selective: instructions },
    results: [baseline, selective] }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
