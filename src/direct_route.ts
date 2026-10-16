import type { OpenAIUsage } from "./openai.js";

export type RouteAction = "search_flights" | "search_hotels" | "ask_user";
export type DirectRouteResult = { action: RouteAction; usage: OpenAIUsage };
export type DirectRouteOptions = {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
};

const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["search_flights", "search_hotels", "ask_user"] },
  },
  required: ["action"],
  additionalProperties: false,
};

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid direct-route API response");
  }
  return value as Record<string, unknown>;
}

function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid direct-route token count");
  }
  return value;
}

export async function directRoute(text: string, options: DirectRouteOptions): Promise<DirectRouteResult> {
  if (!options.apiKey) throw new Error("OPENAI_API_KEY is required for direct routing");
  const model = options.model ?? "gpt-6-luna";
  const response = await (options.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...(model === "gpt-6-luna" ? { reasoning: { effort: "none" } } : {}),
      store: false,
      instructions: "Choose the next action for this travel request. Use search_flights if the user wants to book or find a flight, search_hotels if the user wants to book or find a hotel, room, or suite, and ask_user if neither applies or the request is unclear. Return only the action.",
      input: text,
      text: { format: { type: "json_schema", name: "travel_route", strict: true, schema: ROUTE_SCHEMA } },
    }),
  });

  if (!response.ok) throw new Error(`OpenAI direct-route API returned HTTP ${response.status}`);
  const data = record(await response.json());
  if (data.status !== "completed" || !Array.isArray(data.output)) {
    throw new Error("OpenAI direct-route response did not complete");
  }
  const parts: string[] = [];
  for (const item of data.output) {
    const output = record(item);
    if (output.type !== "message") continue;
    if (!Array.isArray(output.content)) throw new Error("OpenAI direct-route message has no content");
    for (const part of output.content) {
      const content = record(part);
      if (content.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  if (parts.length === 0) throw new Error("OpenAI direct-route response has no output text");
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(parts.join("")));
  } catch {
    throw new Error("OpenAI direct-route response has invalid JSON");
  }
  if (!["search_flights", "search_hotels", "ask_user"].includes(String(parsed.action))) {
    throw new Error("OpenAI direct-route response has invalid action");
  }
  const usage = record(data.usage);
  return {
    action: parsed.action as RouteAction,
    usage: {
      input_tokens: tokenCount(usage.input_tokens),
      output_tokens: tokenCount(usage.output_tokens),
    },
  };
}
