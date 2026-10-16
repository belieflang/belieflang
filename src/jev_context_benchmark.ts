import { chatCases } from "./chat_cases.js";
import { jevContextCases } from "./jev_context_cases.js";
import { jevContextHoldoutCases } from "./jev_context_holdout_cases.js";
import { fullHistoryInput, snapshotTurnInput } from "./chat_protocol.js";
import { createJevInferAdapter, type JevUsage } from "./jev.js";
import { createJevDeltaAdapter } from "./jev_delta.js";
import { directJevRoute, type JevRouteAction } from "./jev_route.js";
import { parse } from "./parser.js";
import { BeliefRuntime, type BeliefSnapshot, type ToolRegistry } from "./runtime.js";
import type { BeliefState, Rule } from "./ast.js";

type BeliefLabels = { intent: string; budget_sensitive: boolean; prefers_direct: boolean };
type Flow = "direct_action" | "full_history_beliefs" | "belief_snapshot" | "belief_delta";
type Row = {
  conversation: string;
  turn: string;
  expected_action: JevRouteAction;
  action: JevRouteAction;
  action_correct: boolean;
  expected_beliefs: BeliefLabels;
  predicted_beliefs?: BeliefLabels;
  beliefs_exact?: boolean;
  tool_calls: JevRouteAction[];
  usage: JevUsage;
  estimated_usd: number;
  latency_ms: number;
};

const rules = parse(`
when confidence(intent.book_flight) > 0.7 && user.budget_sensitive >= 0.5 && user.prefers_direct >= 0.5:
  call search_budget_direct_flights()
when confidence(intent.book_flight) > 0.7 && user.budget_sensitive >= 0.5:
  call search_budget_flights()
when confidence(intent.book_flight) > 0.7 && user.prefers_direct >= 0.5:
  call search_direct_flights()
when confidence(intent.book_flight) > 0.7:
  call search_flights()
when confidence(intent.book_hotel) > 0.7 && user.budget_sensitive >= 0.5:
  call search_budget_hotels()
when confidence(intent.book_hotel) > 0.7:
  call search_hotels()
when true:
  call ask_user()
`).filter((statement): statement is Rule => statement.kind === "rule");

function expectedAction(value: BeliefLabels): JevRouteAction {
  if (value.intent === "book_flight") {
    if (value.budget_sensitive && value.prefers_direct) return "search_budget_direct_flights";
    if (value.budget_sensitive) return "search_budget_flights";
    return value.prefers_direct ? "search_direct_flights" : "search_flights";
  }
  if (value.intent === "book_hotel") {
    return value.budget_sensitive ? "search_budget_hotels" : "search_hotels";
  }
  return "ask_user";
}

function labels(state: BeliefState): BeliefLabels {
  if (!state.intent || !state.user) throw new Error("missing Jev chat beliefs");
  return {
    intent: Object.entries(state.intent).sort((a, b) => b[1] - a[1])[0][0],
    budget_sensitive: state.user.budget_sensitive >= 0.5,
    prefers_direct: state.user.prefers_direct >= 0.5,
  };
}

function mockTools(calls: JevRouteAction[]): ToolRegistry {
  return {
    search_budget_direct_flights: () => { calls.push("search_budget_direct_flights"); return null; },
    search_budget_flights: () => { calls.push("search_budget_flights"); return null; },
    search_direct_flights: () => { calls.push("search_direct_flights"); return null; },
    search_flights: () => { calls.push("search_flights"); return null; },
    search_budget_hotels: () => { calls.push("search_budget_hotels"); return null; },
    search_hotels: () => { calls.push("search_hotels"); return null; },
    ask_user: () => { calls.push("ask_user"); return null; },
  };
}

async function dispatchBeliefRules(runtime: BeliefRuntime): Promise<JevRouteAction> {
  for (const [index, rule] of rules.entries()) {
    if (await runtime.evalCondition(rule, index)) {
      if (rule.action.kind !== "call") throw new Error("benchmark route rule is not a tool call");
      await runtime.executeAction(rule.action);
      return rule.action.toolName as JevRouteAction;
    }
  }
  throw new Error("no benchmark route rule matched");
}

function summarize(flow: Flow, rows: Row[]) {
  const input = rows.reduce((total, row) => total + row.usage.input_tokens, 0);
  const output = rows.reduce((total, row) => total + row.usage.output_tokens, 0);
  const latencies = rows.map((row) => row.latency_ms).sort((a, b) => a - b);
  return {
    flow,
    turns: rows.length,
    correct_actions: rows.filter((row) => row.action_correct).length,
    exact_belief_turns: flow === "direct_action" ? null : rows.filter((row) => row.beliefs_exact).length,
    one_mock_tool_per_turn: rows.every((row) => row.tool_calls.length === 1 && row.tool_calls[0] === row.action),
    usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    estimated_usd: rows.reduce((total, row) => total + row.estimated_usd, 0),
    median_latency_ms: (latencies[9] + latencies[10]) / 2,
    rows,
  };
}

async function runDirect(apiKey: string, model: string, cases: typeof chatCases) {
  const rows: Row[] = [];
  for (const conversation of cases) {
    const history: string[] = [];
    for (const turn of conversation.turns) {
      history.push(turn.message);
      const started = performance.now();
      const result = await directJevRoute(history, { apiKey, model });
      const toolCalls: JevRouteAction[] = [];
      const runtime = new BeliefRuntime(mockTools(toolCalls));
      await runtime.callTool(result.action);
      const expectedBeliefs = { intent: turn.intent,
        budget_sensitive: turn.budget_sensitive, prefers_direct: turn.prefers_direct };
      const expected = expectedAction(expectedBeliefs);
      rows.push({
        conversation: conversation.id, turn: turn.id,
        expected_action: expected, action: result.action, action_correct: result.action === expected,
        expected_beliefs: expectedBeliefs,
        tool_calls: toolCalls, usage: result.usage,
        estimated_usd: result.usage.input_tokens * 0.042 / 1_000_000,
        latency_ms: Math.round(performance.now() - started),
      });
    }
  }
  return summarize("direct_action", rows);
}

async function runBeliefs(flow: "full_history_beliefs" | "belief_snapshot" | "belief_delta", apiKey: string,
  model: string, cases: typeof chatCases) {
  const rows: Row[] = [];
  let callUsage: JevUsage | undefined;
  const inferBeliefs = flow === "belief_delta"
    ? createJevDeltaAdapter({ apiKey, model,
        onUsage: (value) => { callUsage = value; } })
    : createJevInferAdapter({ apiKey, model,
        chatHistory: flow === "full_history_beliefs",
        chatSnapshot: flow === "belief_snapshot",
        onUsage: (value) => { callUsage = value; } });
  for (const conversation of cases) {
    const history: string[] = [];
    let snapshot: BeliefSnapshot = { version: 1, beliefs: {} };
    for (const turn of conversation.turns) {
      history.push(turn.message);
      const toolCalls: JevRouteAction[] = [];
      const runtime = new BeliefRuntime(mockTools(toolCalls), { inferBeliefs });
      if (flow !== "full_history_beliefs") runtime.loadBeliefSnapshot(snapshot);
      await runtime.assign("turn_input", { kind: "string",
        value: flow !== "full_history_beliefs" ? snapshotTurnInput(snapshot, turn.message)
          : fullHistoryInput(history) });
      callUsage = undefined;
      const started = performance.now();
      await runtime.infer({ kind: "identifier", name: "turn_input" });
      const action = await dispatchBeliefRules(runtime);
      const latency = Math.round(performance.now() - started);
      const usage = callUsage as JevUsage | undefined;
      if (!usage) throw new Error("Jev did not report usage");
      if (flow !== "full_history_beliefs") snapshot = runtime.getBeliefSnapshot();
      const predicted = labels(runtime.getState());
      const expected: BeliefLabels = { intent: turn.intent,
        budget_sensitive: turn.budget_sensitive, prefers_direct: turn.prefers_direct };
      rows.push({
        conversation: conversation.id, turn: turn.id,
        expected_action: expectedAction(expected), action,
        action_correct: action === expectedAction(expected),
        expected_beliefs: expected, predicted_beliefs: predicted,
        beliefs_exact: predicted.intent === expected.intent &&
          predicted.budget_sensitive === expected.budget_sensitive &&
          predicted.prefers_direct === expected.prefers_direct,
        tool_calls: toolCalls, usage,
        estimated_usd: usage.input_tokens * 0.042 / 1_000_000,
        latency_ms: latency,
      });
    }
  }
  return summarize(flow, rows);
}

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for the Jev context benchmark");
  const model = process.env.JEV_MODEL ?? "jev-latest";
  const flows: Flow[] = ["direct_action", "full_history_beliefs", "belief_snapshot", "belief_delta"];
  const args = process.argv.slice(2);
  if (args.includes("--fresh") && args.includes("--holdout")) {
    throw new Error("choose one dataset: --fresh or --holdout");
  }
  const dataset = args.includes("--holdout") ? "holdout"
    : args.includes("--fresh") ? "fresh" : "development";
  const cases = dataset === "holdout" ? jevContextHoldoutCases
    : dataset === "fresh" ? jevContextCases : chatCases;
  const requested = args.filter((arg) => arg !== "--fresh" && arg !== "--holdout");
  if (requested.some((flow) => !flows.includes(flow as Flow)) || new Set(requested).size !== requested.length) {
    throw new Error(`choose unique flows from: ${flows.join(", ")}`);
  }
  const selected = requested.length ? flows.filter((flow) => requested.includes(flow)) : flows;
  const results = [];
  for (const flow of selected) {
    console.error(`Running ${flow}...`);
    results.push(flow === "direct_action" ? await runDirect(apiKey, model, cases)
      : await runBeliefs(flow, apiKey, model, cases));
  }
  console.log(JSON.stringify({
    benchmark: "travel-chat-jev-context-v5",
    dataset,
    model,
    method: "Two scripted 10-turn travel chats. All paths make one live Jev call per turn and include every call in usage and cost. Direct action sees all user messages and asks one of seven preference-sensitive actions. Full-history beliefs sees all user messages and asks three belief questions before BeliefLang rules dispatch a mock tool. Belief snapshot asks the same three questions from saved beliefs plus the new message. Belief delta sends previous intent plus the new message to Jev; it asks for intent and explicit changes to budget and nonstop preferences, then BeliefLang merges those changes into the saved snapshot and dispatches a mock tool. The last three paths use the same seven deterministic action rules. No travel service is contacted. The fixed intent threshold is 0.7 and preference threshold is 0.5. There are no assistant messages in this dataset. Preference labels are scored for the three belief paths only.",
    price_basis: "Jev published price checked 2026-10-16: $0.042 per 1M input tokens, output free. Estimates exclude local storage and taxes. jev-latest is a moving alias.",
    results,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
