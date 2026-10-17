export type TokenUsage = {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
};
export type Rates = {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
};
export type InferenceRequest = {
  id: string;
  kind: "update" | "answer" | "action";
  prompt: string;
  schema: Record<string, unknown>;
};
export type InferenceResult = {
  output?: unknown;
  error?: string;
  usage: TokenUsage | null;
  estimatedCost: number | null;
  latencyMs: number;
  replayed?: boolean;
};
export type Inference = (
  request: InferenceRequest,
  oracle: unknown,
) => Promise<InferenceResult>;
export function estimateCost(usage: TokenUsage, rates: Rates) {
  for (const k of ["input", "output", "cached", "cacheWrite"] as const) {
    if (!Number.isSafeInteger(usage[k]) || usage[k] < 0)
      throw new Error("invalid token usage");
    if (!Number.isFinite(rates[k]) || rates[k] < 0)
      throw new Error("invalid rate");
  }
  if (usage.cached + usage.cacheWrite > usage.input)
    throw new Error("cache tokens exceed input");
  const cost =
    ((usage.input - usage.cached - usage.cacheWrite) * rates.input +
      usage.cached * rates.cached +
      usage.cacheWrite * rates.cacheWrite +
      usage.output * rates.output) /
    1e6;
  if (!Number.isFinite(cost)) throw new Error("non-finite cost");
  return cost;
}
/** Standard Luna long-context multipliers; operator rates must include any regional premium. */
export function estimateLunaCost(usage: TokenUsage, rates: Rates) {
  return estimateCost(
    usage,
    usage.input > 272_000
      ? {
          input: rates.input * 2,
          cached: rates.cached * 2,
          cacheWrite: rates.cacheWrite * 2,
          output: rates.output * 1.5,
        }
      : rates,
  );
}
export function readUsage(data: any): TokenUsage | null {
  if (!data?.usage) return null;
  const u: TokenUsage = {
    input: data.usage.input_tokens,
    output: data.usage.output_tokens,
    cached: data.usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWrite: data.usage.input_tokens_details?.cache_write_tokens ?? 0,
  };
  estimateCost(u, { input: 0, output: 0, cached: 0, cacheWrite: 0 });
  return u;
}
/** Same final-answer phase convention as the existing OpenAI adapter. Usage is read BEFORE this parser. */
export function readResponse(data: any): unknown {
  if (data?.status !== "completed" || !Array.isArray(data.output))
    throw new Error(`response incomplete: ${String(data?.status)}`);
  const messages = data.output.filter((x: any) => x?.type === "message");
  const finals = messages.filter((x: any) => x.phase === "final_answer");
  const selected = finals.length
    ? finals
    : messages.filter((x: any) => x.phase == null);
  if (selected.length !== 1 || !Array.isArray(selected[0].content))
    throw new Error("expected one final response");
  if (selected[0].content.some((x: any) => x.type === "refusal"))
    throw new Error("model refusal");
  const text = selected[0].content
    .filter((x: any) => x.type === "output_text")
    .map((x: any) => x.text)
    .join("");
  return JSON.parse(text);
}
export const oracleInference: Inference = async (_request, oracle) => {
  const start = performance.now();
  return {
    output: structuredClone(oracle),
    usage: null,
    estimatedCost: null,
    latencyMs: performance.now() - start,
  };
};
