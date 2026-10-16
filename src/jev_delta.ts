import type { RuntimeValue } from "./ast.js";
import type { BeliefPatch, InferBeliefsAdapter } from "./runtime.js";
import type { JevUsage } from "./jev.js";

export type JevDeltaOptions = {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
  onUsage?: (usage: JevUsage) => void;
};

type Change = "set_yes" | "set_no" | "keep";

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid Jev delta ${path}`);
  }
  return value as Record<string, unknown>;
}

function probability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid Jev delta probability at ${path}`);
  }
  return value;
}

function tokenCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid Jev delta token count at ${path}`);
  }
  return value;
}

function chooseChange(answer: unknown, path: string): Change {
  const choice = record(answer, path);
  if (choice.type !== "choice") throw new Error(`unexpected Jev delta answer type at ${path}`);
  const values = record(choice.probabilities, `${path}.probabilities`);
  const probabilities = {
    set_yes: probability(values.set_yes, `${path}.set_yes`),
    set_no: probability(values.set_no, `${path}.set_no`),
    keep: probability(values.keep, `${path}.keep`),
  };
  if (Object.values(probabilities).every((value) => value === 0)) {
    throw new Error(`Jev delta returned no change probability at ${path}`);
  }
  return (Object.keys(probabilities) as Change[]).reduce((best, key) =>
    probabilities[key] > probabilities[best] ? key : best);
}

export function createJevDeltaAdapter(options: JevDeltaOptions): InferBeliefsAdapter {
  if (!options.apiKey) throw new Error("TYPESAFE_API_KEY is required for Jev delta inference");
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (source: RuntimeValue): Promise<BeliefPatch> => {
    if (typeof source !== "string") throw new Error("Jev delta inference needs JSON string input");
    const input = record(JSON.parse(source) as unknown, "input");
    if (typeof input.new_message !== "string") throw new Error("Jev delta input needs new_message");
    const previous = record(input.previous_beliefs, "previous_beliefs");
    const priorIntentValues = previous.intent
      ? record(record(previous.intent, "previous.intent").values, "previous.intent.values")
      : null;
    const priorIntent = priorIntentValues
      ? Object.entries(priorIntentValues).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] ?? null
      : null;
    const priorUser = previous.user
      ? record(record(previous.user, "previous.user").values, "previous.user.values")
      : {};
    const priorBudget = priorUser.budget_sensitive === undefined ? 0
      : probability(priorUser.budget_sensitive, "previous.user.budget_sensitive");
    const priorDirect = priorUser.prefers_direct === undefined ? 0
      : probability(priorUser.prefers_direct, "previous.user.prefers_direct");
    const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model ?? "jev-latest",
        state: { previous_intent: priorIntent, new_message: input.new_message },
        questions: {
          intent: {
            type: "choice",
            instructions: "Current booking request after new_message; if unchanged, use previous_intent.",
            criteria: {
              book_flight: "Find or book a flight.",
              book_hotel: "Find or book a hotel or room.",
              unknown: "Neither, or unclear.",
            },
          },
          budget_change: {
            type: "choice",
            instructions: "In new_message, is a low-price preference explicitly set, removed, or unchanged?",
            criteria: {
              set_yes: "Low price or spending cap requested.",
              set_no: "Budget limit lifted; price flexible.",
              keep: "No explicit change to price preference.",
            },
          },
          direct_change: {
            type: "choice",
            instructions: "In new_message, is a nonstop-flight preference explicitly set, removed, or unchanged?",
            criteria: {
              set_yes: "Direct flight required; avoid stops.",
              set_no: "Connections allowed; nonstop requirement lifted.",
              keep: "No explicit change to nonstop preference.",
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`Jev delta API returned HTTP ${response.status}`);
    const data = record(await response.json(), "response");
    const answers = record(data.answers, "answers");
    const intent = record(answers.intent, "answers.intent");
    if (intent.type !== "choice") throw new Error("unexpected Jev delta intent answer type");
    const rawIntent = record(intent.probabilities, "answers.intent.probabilities");
    const intentValues = {
      book_flight: probability(rawIntent.book_flight, "intent.book_flight"),
      book_hotel: probability(rawIntent.book_hotel, "intent.book_hotel"),
      unknown: probability(rawIntent.unknown, "intent.unknown"),
    };
    const budgetChange = chooseChange(answers.budget_change, "budget_change");
    const directChange = chooseChange(answers.direct_change, "direct_change");
    const apply = (change: Change, previousValue: number) =>
      change === "set_yes" ? 1 : change === "set_no" ? 0 : previousValue;
    const usage = record(data.usage, "usage");
    options.onUsage?.({
      input_tokens: tokenCount(usage.input_tokens, "usage.input_tokens"),
      output_tokens: tokenCount(usage.output_tokens, "usage.output_tokens"),
    });
    return {
      intent: { cardinality: "exclusive", domain: "closed", values: intentValues },
      user: { cardinality: "multi", domain: "closed", values: {
        budget_sensitive: apply(budgetChange, priorBudget),
        prefers_direct: apply(directChange, priorDirect),
      } },
    };
  };
}
