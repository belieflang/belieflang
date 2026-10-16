import type { JevUsage } from "./jev.js";

export type JevRouteAction = "search_budget_direct_flights" | "search_budget_flights" |
  "search_direct_flights" | "search_flights" | "search_budget_hotels" |
  "search_hotels" | "ask_user";
export type JevRouteResult = {
  action: JevRouteAction;
  probabilities: Record<JevRouteAction, number>;
  usage: JevUsage;
};

const ACTIONS: JevRouteAction[] = [
  "search_budget_direct_flights", "search_budget_flights", "search_direct_flights",
  "search_flights", "search_budget_hotels", "search_hotels", "ask_user",
];

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid Jev route ${path}`);
  }
  return value as Record<string, unknown>;
}

function probability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`invalid Jev route probability at ${path}`);
  }
  return value;
}

function tokenCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid Jev route token count at ${path}`);
  }
  return value;
}

export async function directJevRoute(messages: string[], options: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<JevRouteResult> {
  if (!options.apiKey) throw new Error("TYPESAFE_API_KEY is required for direct Jev routing");
  if (messages.length === 0 || !messages.every((message) => typeof message === "string")) {
    throw new Error("direct Jev routing needs at least one message");
  }
  const response = await (options.fetchImpl ?? fetch)("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: options.model ?? "jev-latest",
      state: { messages },
      questions: {
        next_action: {
          type: "choice",
          instructions: "Choose the next action for the current request in these messages, ordered oldest to newest. Track the current low-price and nonstop-flight preferences: the latest explicit change overrides older statements, otherwise a preference persists. Choose one action for the latest message.",
          criteria: {
            search_budget_direct_flights: "Current request is for a flight; the user currently wants both a low price and a nonstop flight.",
            search_budget_flights: "Current request is for a flight; the user currently wants a low price but does not require a nonstop flight.",
            search_direct_flights: "Current request is for a flight; the user currently wants a nonstop flight but does not prioritize a low price.",
            search_flights: "Current request is for a flight; the user currently prioritizes neither a low price nor a nonstop flight.",
            search_budget_hotels: "Current request is for a hotel, room, or suite; the user currently wants a low price.",
            search_hotels: "Current request is for a hotel, room, or suite; the user currently does not prioritize a low price.",
            ask_user: "The current request is neither a flight nor hotel booking, or it is unclear.",
          },
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`Jev route API returned HTTP ${response.status}`);
  const data = record(await response.json(), "response");
  const answer = record(record(data.answers, "answers").next_action, "next_action");
  if (answer.type !== "choice") throw new Error("Jev route returned an unexpected answer type");
  const raw = record(answer.probabilities, "probabilities");
  const probabilities = Object.fromEntries(ACTIONS.map((action) =>
    [action, probability(raw[action], action)])) as Record<JevRouteAction, number>;
  if (Object.values(probabilities).every((value) => value === 0)) {
    throw new Error("Jev route returned no action probability");
  }
  const usage = record(data.usage, "usage");
  return {
    action: ACTIONS.reduce((best, action) =>
      probabilities[action] > probabilities[best] ? action : best),
    probabilities,
    usage: {
      input_tokens: tokenCount(usage.input_tokens, "usage.input_tokens"),
      output_tokens: tokenCount(usage.output_tokens, "usage.output_tokens"),
    },
  };
}
