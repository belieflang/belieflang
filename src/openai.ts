import type { RuntimeValue } from "./ast.js";
import type { BeliefPatch, InferBeliefsAdapter } from "./runtime.js";

export type OpenAIUsage = {
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens?: number;
  cache_write_tokens?: number;
};
export type OpenAIOptions = {
  apiKey: string;
  model?: string;
  instructions?: string;
  fetchImpl?: typeof fetch;
  onUsage?: (usage: OpenAIUsage) => void;
  onResponseId?: (id: string) => void;
  onCompactionItems?: (count: number) => void;
  store?: boolean;
  previousResponseId?: string;
  compactThreshold?: number;
  /** Override the travel fields while keeping the same belief patch format. */
  beliefFields?: { intents: readonly string[]; flags: readonly string[] };
  /** Abort a request (including reading its body); no automatic retries. */
  requestTimeoutMs?: number;
};

const ENDPOINT = "https://api.openai.com/v1/responses";
const probabilitySchema = { type: "number", minimum: 0, maximum: 1 };
function beliefSchema(intents: readonly string[], flags: readonly string[]) {
  return {
    type: "object",
    properties: {
      intent: { type: "object", properties: Object.fromEntries(intents.map(k => [k, probabilitySchema])),
        required: intents, additionalProperties: false },
      ...Object.fromEntries(flags.map(k => [k, probabilitySchema])),
    },
    required: ["intent", ...flags], additionalProperties: false,
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid OpenAI object at ${path}`);
  }
  return value as Record<string, unknown>;
}

function probability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid OpenAI probability at ${path}`);
  }
  return value;
}

function tokenCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid OpenAI token count at ${path}`);
  }
  return value;
}

export function createOpenAIInferAdapter(options: OpenAIOptions): InferBeliefsAdapter {
  if (!options.apiKey) throw new Error("OPENAI_API_KEY is required for ChatGPT inference");
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? "gpt-6-luna";
  const fields = options.beliefFields ?? {
    intents: ["book_flight", "book_hotel", "unknown"], flags: ["budget_sensitive", "prefers_direct"],
  };
  if (!fields.intents.length || !fields.flags.length ||
      new Set(fields.intents).size !== fields.intents.length ||
      new Set(fields.flags).size !== fields.flags.length || fields.flags.includes("intent") ||
      [...fields.intents, ...fields.flags].some(k => !k.trim())) {
    throw new Error("invalid OpenAI belief fields");
  }
  const schema = beliefSchema(fields.intents, fields.flags);

  return async (source: RuntimeValue): Promise<BeliefPatch> => {
    if (typeof source !== "string") {
      throw new Error("ChatGPT inference currently requires a string source");
    }

    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      ...(options.requestTimeoutMs ? { signal: AbortSignal.timeout(options.requestTimeoutMs) } : {}),
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        ...(model === "gpt-6-luna" ? { reasoning: { effort: "none" } } : {}),
        store: options.store ?? false,
        ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}),
        ...(options.compactThreshold ? { context_management: [{ type: "compaction", compact_threshold: options.compactThreshold }] } : {}),
        instructions: options.instructions ?? "Classify the user's travel request. Give probabilities for primary intent: book_flight means booking or finding a flight, book_hotel means booking or finding a hotel, and unknown means neither or unclear. The three intent probabilities should sum to 1. Give independent probabilities for budget_sensitive (low price or limited budget) and prefers_direct (a direct flight without stops). Base answers only on the supplied request.",
        input: source,
        text: { format: { type: "json_schema", name: options.beliefFields ? "multidomain_beliefs" : "travel_beliefs", strict: true, schema } },
      }),
    });

    if (!response.ok) throw new Error(`OpenAI API returned HTTP ${response.status}`);
    const data = record(await response.json(), "response");
    if (data.status !== "completed") throw new Error(`OpenAI response status: ${String(data.status)}`);
    if (!Array.isArray(data.output)) throw new Error("OpenAI response has no output array");
    options.onCompactionItems?.(data.output.filter((item) =>
      typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "compaction").length);
    const messages = data.output.map(item => record(item, "output item")).filter(item => item.type === "message");
    const finalMessages = messages.filter(item => item.phase === "final_answer");
    // Commentary is an intermediate update, not part of the structured final answer.
    // Older Responses payloads omit phase; retain that single-message format.
    const answerMessages = finalMessages.length ? finalMessages : messages.filter(item => item.phase == null);
    if (answerMessages.length !== 1) throw new Error("OpenAI response must have exactly one final answer message");
    const textParts: string[] = [];
    for (const output of answerMessages) {
      if (!Array.isArray(output.content)) throw new Error("OpenAI message has no content array");
      for (const part of output.content) {
        const content = record(part, "message content");
        if (content.type === "output_text" && typeof content.text === "string") {
          textParts.push(content.text);
        }
      }
    }
    if (textParts.length === 0) throw new Error("OpenAI response has no output text");
    let parsed: unknown;
    try {
      parsed = JSON.parse(textParts.join(""));
    } catch {
      throw new Error("OpenAI returned invalid JSON");
    }
    const result = record(parsed, "output text");
    const intent = record(result.intent, "intent");
    const usage = record(data.usage, "usage");
    const patch: BeliefPatch = {
      intent: {
        cardinality: "exclusive",
        domain: "closed",
        values: Object.fromEntries(fields.intents.map(k => [k, probability(intent[k], `intent.${k}`)])),
      },
      user: {
        cardinality: "multi",
        domain: "closed",
        values: Object.fromEntries(fields.flags.map(k => [k, probability(result[k], k)])),
      },
    };
    if (options.beliefFields) {
      const total = Object.values(intent).reduce<number>((sum, v) => sum + probability(v, "intent"), 0);
      if (Math.abs(total - 1) > 0.02) throw new Error(`intent probabilities must sum to 1 (got ${total})`);
      if (Object.keys(intent).length !== fields.intents.length ||
          Object.keys(result).length !== fields.flags.length + 1) throw new Error("unexpected OpenAI belief fields");
    }
    let cachedInputTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    if (usage.input_tokens_details !== undefined) {
      const details = record(usage.input_tokens_details, "usage.input_tokens_details");
      if (details.cached_tokens !== undefined) cachedInputTokens = tokenCount(details.cached_tokens, "usage.input_tokens_details.cached_tokens");
      if (details.cache_write_tokens !== undefined) cacheWriteTokens = tokenCount(details.cache_write_tokens, "usage.input_tokens_details.cache_write_tokens");
    }
    const inputTokens = tokenCount(usage.input_tokens, "usage.input_tokens");
    if ((cachedInputTokens ?? 0) + (cacheWriteTokens ?? 0) > inputTokens) {
      throw new Error("OpenAI cache token counts exceed input tokens");
    }
    options.onUsage?.({
      input_tokens: inputTokens,
      output_tokens: tokenCount(usage.output_tokens, "usage.output_tokens"),
      ...(cachedInputTokens !== undefined ? { cached_input_tokens: cachedInputTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cache_write_tokens: cacheWriteTokens } : {}),
    });
    if (options.onResponseId) {
      if (typeof data.id !== "string" || !data.id) throw new Error("OpenAI response has no id");
      options.onResponseId(data.id);
    }
    return patch;
  };
}
