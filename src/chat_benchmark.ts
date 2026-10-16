import { chatCases, type ChatTurn } from "./chat_cases.js";
import { CHAT_INSTRUCTIONS, fullHistoryInput, snapshotTurnInput } from "./chat_protocol.js";
import { createOpenAIInferAdapter, type OpenAIUsage } from "./openai.js";
import { BeliefRuntime, type BeliefPatch, type BeliefPatchEntry, type BeliefSnapshot } from "./runtime.js";
import type { BeliefState } from "./ast.js";

type Prediction = {
  intent: string;
  budget_sensitive: boolean;
  prefers_direct: boolean;
};

type Row = {
  conversation: string;
  turn: string;
  expected: Prediction;
  predicted: Prediction;
  exact_match: boolean;
  usage: OpenAIUsage;
  latency_ms: number;
  beliefs: BeliefState;
};

function expected(turn: ChatTurn): Prediction {
  return {
    intent: turn.intent,
    budget_sensitive: turn.budget_sensitive,
    prefers_direct: turn.prefers_direct,
  };
}

function classify(state: BeliefState): Prediction {
  const intent = state.intent;
  const user = state.user;
  if (!intent || !user) throw new Error("missing chat belief state");
  return {
    intent: Object.entries(intent).sort((a, b) => b[1] - a[1])[0][0],
    budget_sensitive: user.budget_sensitive >= 0.5,
    prefers_direct: user.prefers_direct >= 0.5,
  };
}

function patchState(patch: BeliefPatch): BeliefState {
  return {
    intent: (patch.intent as BeliefPatchEntry).values,
    user: (patch.user as BeliefPatchEntry).values,
  };
}

function row(
  conversation: string, turn: ChatTurn, predicted: Prediction,
  usage: OpenAIUsage, latencyMs: number, beliefs: BeliefState,
): Row {
  const truth = expected(turn);
  return {
    conversation,
    turn: turn.id,
    expected: truth,
    predicted,
    exact_match: predicted.intent === truth.intent &&
      predicted.budget_sensitive === truth.budget_sensitive &&
      predicted.prefers_direct === truth.prefers_direct,
    usage,
    latency_ms: latencyMs,
    beliefs,
  };
}

function summarize(name: string, rows: Row[]) {
  const total = rows.reduce((sum, result) => ({
    input_tokens: sum.input_tokens + result.usage.input_tokens,
    output_tokens: sum.output_tokens + result.usage.output_tokens,
  }), { input_tokens: 0, output_tokens: 0 });
  const latencies = rows.map((result) => result.latency_ms).sort((a, b) => a - b);
  return {
    workflow: name,
    turns: rows.length,
    exact_match_turns: rows.filter((result) => result.exact_match).length,
    intent_correct: rows.filter((result) => result.predicted.intent === result.expected.intent).length,
    preference_fields_correct: rows.reduce((count, result) => count +
      Number(result.predicted.budget_sensitive === result.expected.budget_sensitive) +
      Number(result.predicted.prefers_direct === result.expected.prefers_direct), 0),
    usage: { ...total, total_tokens: total.input_tokens + total.output_tokens },
    median_latency_ms: (latencies[9] + latencies[10]) / 2,
    results: rows,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the chat snapshot benchmark");
  const model = process.env.OPENAI_MODEL ?? "gpt-6-luna";
  let callUsage: OpenAIUsage = { input_tokens: 0, output_tokens: 0 };
  const adapter = createOpenAIInferAdapter({
    apiKey, model, instructions: CHAT_INSTRUCTIONS,
    onUsage: (usage) => { callUsage = usage; },
  });
  const fullRows: Row[] = [];
  const snapshotRows: Row[] = [];

  for (const conversation of chatCases) {
    const history: string[] = [];
    let snapshot: BeliefSnapshot = { version: 1, beliefs: {} };
    for (const turn of conversation.turns) {
      history.push(turn.message);

      callUsage = { input_tokens: 0, output_tokens: 0 };
      const fullInput = fullHistoryInput(history);
      const fullStarted = performance.now();
      const fullPatch = await adapter(fullInput, { observations: [], state: {}, vars: {} });
      const fullLatency = Math.round(performance.now() - fullStarted);
      const fullState = patchState(fullPatch);
      fullRows.push(row(conversation.id, turn, classify(fullState), callUsage, fullLatency, fullState));

      callUsage = { input_tokens: 0, output_tokens: 0 };
      const runtime = new BeliefRuntime({}, { inferBeliefs: adapter });
      runtime.loadBeliefSnapshot(JSON.parse(JSON.stringify(snapshot)) as BeliefSnapshot);
      const snapshotInput = snapshotTurnInput(snapshot, turn.message);
      await runtime.assign("turn_input", { kind: "string", value: snapshotInput });
      const snapshotStarted = performance.now();
      await runtime.infer({ kind: "identifier", name: "turn_input" });
      const snapshotLatency = Math.round(performance.now() - snapshotStarted);
      snapshot = runtime.getBeliefSnapshot();
      const state = runtime.getState();
      snapshotRows.push(row(conversation.id, turn, classify(state), callUsage, snapshotLatency, state));
    }
  }

  const fullHistory = summarize("gpt_full_history", fullRows);
  const beliefSnapshot = summarize("gpt_belieflang_snapshot", snapshotRows);
  console.log(JSON.stringify({
    benchmark: "travel-chat-snapshot-v1",
    model,
    conversations: chatCases.length,
    turns: fullRows.length,
    full_history: fullHistory,
    belief_snapshot: beliefSnapshot,
    token_reduction_percent: 100 * (1 - beliefSnapshot.usage.total_tokens / fullHistory.usage.total_tokens),
    exact_match_rate_change_points: 100 * (
      beliefSnapshot.exact_match_turns / snapshotRows.length - fullHistory.exact_match_turns / fullRows.length
    ),
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
