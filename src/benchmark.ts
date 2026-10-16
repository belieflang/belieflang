import { createJevInferAdapter, type JevUsage } from "./jev.js";
import { createOpenAIInferAdapter } from "./openai.js";
import { BeliefRuntime } from "./runtime.js";
import { travelCases } from "./travel_cases.js";

type Engine = "jev" | "chatgpt";

async function runEngine(engine: Engine) {
  const apiKey = engine === "jev" ? process.env.TYPESAFE_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(`${engine === "jev" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY"} is required for the ${engine} benchmark`);
  }
  const model = engine === "jev"
    ? process.env.JEV_MODEL ?? "jev-latest"
    : process.env.OPENAI_MODEL ?? "gpt-6-luna";
  let callUsage: JevUsage = { input_tokens: 0, output_tokens: 0 };
  const onUsage = (usage: JevUsage) => { callUsage = usage; };
  const inferBeliefs = engine === "jev"
    ? createJevInferAdapter({ apiKey, model, onUsage })
    : createOpenAIInferAdapter({ apiKey, model, onUsage });

  const results = [];
  for (const item of travelCases) {
    callUsage = { input_tokens: 0, output_tokens: 0 };
    const runtime = new BeliefRuntime({}, { inferBeliefs });
    await runtime.assign("message", { kind: "string", value: item.text });
    const started = performance.now();
    await runtime.infer({ kind: "identifier", name: "message" });
    const latencyMs = Math.round(performance.now() - started);
    const state = runtime.getState();
    const predictedIntent = Object.entries(state.intent).sort((a, b) => b[1] - a[1])[0][0];
    const predictedBudget = state.user.budget_sensitive >= 0.5;
    const predictedDirect = state.user.prefers_direct >= 0.5;
    results.push({
      id: item.id,
      expected: { intent: item.intent, budget_sensitive: item.budget_sensitive, prefers_direct: item.prefers_direct },
      predicted: { intent: predictedIntent, budget_sensitive: predictedBudget, prefers_direct: predictedDirect },
      correct: predictedIntent === item.intent && predictedBudget === item.budget_sensitive && predictedDirect === item.prefers_direct,
      usage: callUsage,
      latency_ms: latencyMs,
    });
  }

  const total = results.reduce((sum, row) => ({
    input_tokens: sum.input_tokens + row.usage.input_tokens,
    output_tokens: sum.output_tokens + row.usage.output_tokens,
  }), { input_tokens: 0, output_tokens: 0 });
  const latencies = results.map((row) => row.latency_ms).sort((a, b) => a - b);
  return {
    benchmark: "travel-intent-v1",
    engine,
    model,
    cases: results.length,
    exact_match: results.filter((row) => row.correct).length,
    total_usage: { ...total, total_tokens: total.input_tokens + total.output_tokens },
    average_tokens_per_case: (total.input_tokens + total.output_tokens) / results.length,
    median_latency_ms: (latencies[3] + latencies[4]) / 2,
    results,
  };
}

async function main(): Promise<void> {
  const selection = process.argv[2] ?? "both";
  if (!["jev", "chatgpt", "both"].includes(selection)) {
    throw new Error("usage: node dist/src/benchmark.js [jev|chatgpt|both]");
  }
  const engines: Engine[] = selection === "both" ? ["jev", "chatgpt"] : [selection as Engine];
  if (engines.includes("jev") && !process.env.TYPESAFE_API_KEY) {
    throw new Error("TYPESAFE_API_KEY is required for the jev benchmark");
  }
  if (engines.includes("chatgpt") && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for the chatgpt benchmark");
  }
  const reports = [];
  for (const engine of engines) reports.push(await runEngine(engine));
  if (reports.length === 1) {
    console.log(JSON.stringify(reports[0], null, 2));
    return;
  }
  console.log(JSON.stringify({
    benchmark: "travel-intent-v1",
    reports,
    comparison: {
      input_token_ratio_chatgpt_to_jev: reports[0].total_usage.input_tokens > 0
        ? reports[1].total_usage.input_tokens / reports[0].total_usage.input_tokens : null,
      total_token_ratio_chatgpt_to_jev: reports[0].total_usage.total_tokens > 0
        ? reports[1].total_usage.total_tokens / reports[0].total_usage.total_tokens : null,
    },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
