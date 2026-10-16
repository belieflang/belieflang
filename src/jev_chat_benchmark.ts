import { chatCases } from "./chat_cases.js";
import { snapshotTurnInput } from "./chat_protocol.js";
import { createJevInferAdapter, type JevUsage } from "./jev.js";
import { BeliefRuntime, type BeliefSnapshot } from "./runtime.js";

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for the Jev chat benchmark");
  const model = process.env.JEV_MODEL ?? "jev-latest";
  let callUsage: JevUsage = { input_tokens: 0, output_tokens: 0 };
  const inferBeliefs = createJevInferAdapter({
    apiKey, model, chatSnapshot: true,
    onUsage: (usage) => { callUsage = usage; },
  });
  const results = [];
  for (const conversation of chatCases) {
    let snapshot: BeliefSnapshot = { version: 1, beliefs: {} };
    for (const turn of conversation.turns) {
      callUsage = { input_tokens: 0, output_tokens: 0 };
      const runtime = new BeliefRuntime({}, { inferBeliefs });
      runtime.loadBeliefSnapshot(JSON.parse(JSON.stringify(snapshot)) as BeliefSnapshot);
      await runtime.assign("turn_input", {
        kind: "string", value: snapshotTurnInput(snapshot, turn.message),
      });
      const started = performance.now();
      await runtime.infer({ kind: "identifier", name: "turn_input" });
      const latencyMs = Math.round(performance.now() - started);
      snapshot = runtime.getBeliefSnapshot();
      const state = runtime.getState();
      const predicted = {
        intent: Object.entries(state.intent).sort((a, b) => b[1] - a[1])[0][0],
        budget_sensitive: state.user.budget_sensitive >= 0.5,
        prefers_direct: state.user.prefers_direct >= 0.5,
      };
      const expected = {
        intent: turn.intent,
        budget_sensitive: turn.budget_sensitive,
        prefers_direct: turn.prefers_direct,
      };
      results.push({
        conversation: conversation.id,
        turn: turn.id,
        expected,
        predicted,
        exact_match: predicted.intent === expected.intent &&
          predicted.budget_sensitive === expected.budget_sensitive &&
          predicted.prefers_direct === expected.prefers_direct,
        usage: callUsage,
        latency_ms: latencyMs,
        beliefs: state,
      });
    }
  }
  const usage = results.reduce((sum, row) => ({
    input_tokens: sum.input_tokens + row.usage.input_tokens,
    output_tokens: sum.output_tokens + row.usage.output_tokens,
  }), { input_tokens: 0, output_tokens: 0 });
  const latencies = results.map((row) => row.latency_ms).sort((a, b) => a - b);
  console.log(JSON.stringify({
    benchmark: "travel-chat-jev-snapshot-v1",
    model,
    conversations: chatCases.length,
    turns: results.length,
    exact_match_turns: results.filter((row) => row.exact_match).length,
    intent_correct: results.filter((row) => row.predicted.intent === row.expected.intent).length,
    preference_fields_correct: results.reduce((count, row) => count +
      Number(row.predicted.budget_sensitive === row.expected.budget_sensitive) +
      Number(row.predicted.prefers_direct === row.expected.prefers_direct), 0),
    usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens },
    median_latency_ms: (latencies[9] + latencies[10]) / 2,
    results,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
