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
};

const ENDPOINT = "https://api.openai.com/v1/responses";
const probabilitySchema = { type: "number", minimum: 0, maximum: 1 };
const schema = {
  type: "object",
  properties: {
    intent: {
      type: "object",
      properties: {
        book_flight: probabilitySchema,
        book_hotel: probabilitySchema,
        unknown: probabilitySchema,
      },
      required: ["book_flight", "book_hotel", "unknown"],
      additionalProperties: false,
    },
    budget_sensitive: probabilitySchema,
    prefers_direct: probabilitySchema,
  },
  required: ["intent", "budget_sensitive", "prefers_direct"],
  additionalProperties: false,
};

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

  return async (source: RuntimeValue): Promise<BeliefPatch> => {
    if (typeof source !== "string") {
      throw new Error("ChatGPT inference currently requires a string source");
    }

    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
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
        text: { format: { type: "json_schema", name: "travel_beliefs", strict: true, schema } },
      }),
    });

    if (!response.ok) throw new Error(`OpenAI API returned HTTP ${response.status}`);
    const data = record(await response.json(), "response");
    if (data.status !== "completed") throw new Error(`OpenAI response status: ${String(data.status)}`);
    if (!Array.isArray(data.output)) throw new Error("OpenAI response has no output array");
    options.onCompactionItems?.(data.output.filter((item) =>
      typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "compaction").length);
    const textParts: string[] = [];
    for (const item of data.output) {
      const output = record(item, "output item");
      if (output.type !== "message") continue;
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
        values: {
          book_flight: probability(intent.book_flight, "intent.book_flight"),
          book_hotel: probability(intent.book_hotel, "intent.book_hotel"),
          unknown: probability(intent.unknown, "intent.unknown"),
        },
      },
      user: {
        cardinality: "multi",
        domain: "closed",
        values: {
          budget_sensitive: probability(result.budget_sensitive, "budget_sensitive"),
          prefers_direct: probability(result.prefers_direct, "prefers_direct"),
        },
      },
    };
    let cachedInputTokens: number | undefined;
    let cacheWriteTokens: number | undefined;
    if (usage.input_tokens_details !== undefined) {
      const details = record(usage.input_tokens_details, "usage.input_tokens_details");
      if (details.cached_tokens !== undefined) cachedInputTokens = tokenCount(details.cached_tokens, "usage.input_tokens_details.cached_tokens");
      if (details.cache_write_tokens !== undefined) cacheWriteTokens = tokenCount(details.cache_write_tokens, "usage.input_tokens_details.cache_write_tokens");
    }
    options.onUsage?.({
      input_tokens: tokenCount(usage.input_tokens, "usage.input_tokens"),
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
