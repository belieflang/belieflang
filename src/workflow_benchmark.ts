import { directRoute, type RouteAction } from "./direct_route.js";
import { createJevInferAdapter, type JevUsage } from "./jev.js";
import { createOpenAIInferAdapter } from "./openai.js";
import { parse } from "./parser.js";
import { BeliefRuntime, type InferBeliefsAdapter } from "./runtime.js";
import type { Rule } from "./ast.js";
import { travelCases } from "./travel_cases.js";

type Row = {
  id: string;
  expected_action: RouteAction;
  action: RouteAction;
  correct: boolean;
  usage: JevUsage;
  latency_ms: number;
};

const rules = parse(`
when confidence(intent.book_flight) > 0.7:
  call search_flights()
when confidence(intent.book_hotel) > 0.7:
  call search_hotels()
when true:
  ask_user("Which travel booking do you need?")
`).filter((statement): statement is Rule => statement.kind === "rule");

function expectedAction(intent: string): RouteAction {
  if (intent === "book_flight") return "search_flights";
  if (intent === "book_hotel") return "search_hotels";
  return "ask_user";
}

function summarize(name: string, model: string, rows: Row[]) {
  const total = rows.reduce((sum, row) => ({
    input_tokens: sum.input_tokens + row.usage.input_tokens,
    output_tokens: sum.output_tokens + row.usage.output_tokens,
  }), { input_tokens: 0, output_tokens: 0 });
  const latencies = rows.map((row) => row.latency_ms).sort((a, b) => a - b);
  return {
    workflow: name,
    model,
    cases: rows.length,
    correct_actions: rows.filter((row) => row.correct).length,
    usage: { ...total, total_tokens: total.input_tokens + total.output_tokens },
    median_latency_ms: (latencies[3] + latencies[4]) / 2,
    results: rows,
  };
}

async function runDirect(apiKey: string, model: string) {
  const rows: Row[] = [];
  for (const item of travelCases) {
    const started = performance.now();
    const result = await directRoute(item.text, { apiKey, model });
    const expected = expectedAction(item.intent);
    rows.push({
      id: item.id,
      expected_action: expected,
      action: result.action,
      correct: result.action === expected,
      usage: result.usage,
      latency_ms: Math.round(performance.now() - started),
    });
  }
  return summarize("direct_gpt", model, rows);
}

async function routeWithBeliefLang(runtime: BeliefRuntime): Promise<RouteAction> {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (await runtime.evalCondition(rule, index)) {
      return rule.action.kind === "call" ? rule.action.toolName as RouteAction : "ask_user";
    }
  }
  throw new Error("BeliefLang route rules did not match");
}

async function runBeliefLang(
  name: string,
  model: string,
  createAdapter: (onUsage: (usage: JevUsage) => void) => InferBeliefsAdapter,
) {
  let callUsage: JevUsage = { input_tokens: 0, output_tokens: 0 };
  const inferBeliefs = createAdapter((usage) => { callUsage = usage; });
  const rows: Row[] = [];
  for (const item of travelCases) {
    callUsage = { input_tokens: 0, output_tokens: 0 };
    const runtime = new BeliefRuntime({}, { inferBeliefs });
    await runtime.assign("message", { kind: "string", value: item.text });
    const started = performance.now();
    await runtime.infer({ kind: "identifier", name: "message" });
    const action = await routeWithBeliefLang(runtime);
    const expected = expectedAction(item.intent);
    rows.push({
      id: item.id,
      expected_action: expected,
      action,
      correct: action === expected,
      usage: callUsage,
      latency_ms: Math.round(performance.now() - started),
    });
  }
  return summarize(name, model, rows);
}

async function main(): Promise<void> {
  const openaiKey = process.env.OPENAI_API_KEY;
  const typesafeKey = process.env.TYPESAFE_API_KEY;
  if (!openaiKey || !typesafeKey) {
    throw new Error("OPENAI_API_KEY and TYPESAFE_API_KEY are required for the before/after benchmark");
  }
  const openaiModel = process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const jevModel = process.env.JEV_MODEL ?? "jev-latest";
  const before = await runDirect(openaiKey, openaiModel);
  const afterGpt = await runBeliefLang("gpt_plus_belieflang", openaiModel,
    (onUsage) => createOpenAIInferAdapter({ apiKey: openaiKey, model: openaiModel, onUsage }));
  const afterJev = await runBeliefLang("jev_plus_belieflang", jevModel,
    (onUsage) => createJevInferAdapter({ apiKey: typesafeKey, model: jevModel, onUsage }));
  console.log(JSON.stringify({
    benchmark: "travel-route-before-after-v1",
    before,
    after: [afterGpt, afterJev],
    token_ratio_to_direct: {
      gpt_plus_belieflang: afterGpt.usage.total_tokens / before.usage.total_tokens,
      jev_plus_belieflang: afterJev.usage.total_tokens / before.usage.total_tokens,
    },
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
