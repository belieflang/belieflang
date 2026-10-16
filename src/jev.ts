import type { RuntimeValue } from "./ast.js";
import type { BeliefPatch, InferBeliefsAdapter } from "./runtime.js";

export type JevUsage = { input_tokens: number; output_tokens: number };
export type JevOptions = {
  apiKey: string;
  model?: string;
  chatSnapshot?: boolean;
  chatHistory?: boolean;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  onUsage?: (usage: JevUsage) => void;
};

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

function probability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid Jev probability at ${path}`);
  }
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid Jev object at ${path}`);
  }
  return value as Record<string, unknown>;
}

function tokenCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid Jev token count at ${path}`);
  }
  return value;
}

export function createJevInferAdapter(options: JevOptions): InferBeliefsAdapter {
  if (!options.apiKey) throw new Error("TYPESAFE_API_KEY is required for Jev inference");
  if (options.chatSnapshot && options.chatHistory) {
    throw new Error("choose either chatSnapshot or chatHistory for Jev inference");
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (source: RuntimeValue): Promise<BeliefPatch> => {
    if (typeof source !== "string") {
      throw new Error("Jev inference currently requires a string source");
    }

    let state: string | Record<string, unknown> = source;
    if (options.chatSnapshot) {
      try {
        const parsed = JSON.parse(source) as unknown;
        const object = record(parsed, "chat snapshot input");
        if (typeof object.new_message !== "string") throw new Error("invalid new_message");
        record(object.previous_beliefs, "previous_beliefs");
        state = object;
      } catch {
        throw new Error("Jev chat inference requires a snapshot and new_message JSON input");
      }
    } else if (options.chatHistory) {
      try {
        const parsed = JSON.parse(source) as unknown;
        const object = record(parsed, "chat history input");
        if (!Array.isArray(object.messages) || object.messages.length === 0 ||
            !object.messages.every((message) => typeof message === "string")) {
          throw new Error("invalid messages");
        }
        state = object;
      } catch {
        throw new Error("Jev chat-history inference requires a messages JSON array");
      }
    }

    const response = await fetchImpl(options.endpoint ?? DEFAULT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model ?? "jev-latest",
        state,
        questions: {
          intent: {
            type: "choice",
            instructions: options.chatSnapshot
              ? "Given previous beliefs and the new message, what is the user's current primary booking intent? The latest explicit change overrides earlier intent."
              : options.chatHistory
              ? "Given the messages in order, what is the user's current primary booking intent? The latest explicit change overrides earlier intent."
              : "What is the user's primary booking intent?",
            criteria: {
              book_flight: "The user wants to book or find a flight.",
              book_hotel: "The user wants to book or find a hotel.",
              unknown: "Neither flight nor hotel booking is the primary intent, or the intent is unclear.",
            },
          },
          budget_sensitive: {
            type: "noul",
            instructions: options.chatSnapshot
              ? "Considering previous beliefs and the new message, does the user currently prefer a low price or have a limited budget? Preserve the previous preference unless explicitly changed."
              : options.chatHistory
              ? "Considering all messages in order, does the user currently prefer a low price or have a limited budget? The latest explicit change overrides older statements; otherwise preserve the preference."
              : "Does the user express a preference for a low price or a limited budget?",
          },
          prefers_direct: {
            type: "noul",
            instructions: options.chatSnapshot
              ? "Considering previous beliefs and the new message, does the user currently prefer a direct flight without stops? Preserve the previous preference unless explicitly changed."
              : options.chatHistory
              ? "Considering all messages in order, does the user currently prefer a direct flight without stops? The latest explicit change overrides older statements; otherwise preserve the preference."
              : "Does the user express a preference for a direct flight without stops?",
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Jev API returned HTTP ${response.status}`);
    }

    const data = record(await response.json(), "response");
    const answers = record(data.answers, "answers");
    const intent = record(answers.intent, "answers.intent");
    const budget = record(answers.budget_sensitive, "answers.budget_sensitive");
    const direct = record(answers.prefers_direct, "answers.prefers_direct");
    if (intent.type !== "choice" || budget.type !== "noul" || direct.type !== "noul") {
      throw new Error("Jev returned an unexpected answer type");
    }
    const probabilities = record(intent.probabilities, "answers.intent.probabilities");
    const values = {
      book_flight: probability(probabilities.book_flight, "intent.book_flight"),
      book_hotel: probability(probabilities.book_hotel, "intent.book_hotel"),
      unknown: probability(probabilities.unknown, "intent.unknown"),
    };
    const usage = record(data.usage, "usage");
    options.onUsage?.({
      input_tokens: tokenCount(usage.input_tokens, "usage.input_tokens"),
      output_tokens: tokenCount(usage.output_tokens, "usage.output_tokens"),
    });

    return {
      intent: { cardinality: "exclusive", domain: "closed", values },
      user: {
        cardinality: "multi",
        domain: "closed",
        values: {
          budget_sensitive: probability(budget.noul, "budget_sensitive.noul"),
          prefers_direct: probability(direct.noul, "prefers_direct.noul"),
        },
      },
    };
  };
}
