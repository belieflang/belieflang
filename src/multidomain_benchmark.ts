import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { conversations, domains, labelFor, validateFixtures, type Conversation, type Domain, type Prediction } from "./multidomain_cases.js";
import { holdoutConversations, validateHoldout } from "./multidomain_holdout.js";
import { createOpenAIInferAdapter, type OpenAIUsage } from "./openai.js";
import { BeliefRuntime, type BeliefSnapshot } from "./runtime.js";
import type { BeliefState } from "./ast.js";

export const WORKFLOWS = ["full_history", "provider_history", "belief_snapshot"] as const;
export type Workflow = typeof WORKFLOWS[number];
export const PROMPTS = ["original", "continuity", "compact"] as const;
export type PromptVariant = typeof PROMPTS[number];
export type Suite = "original" | "holdout";
export type Options = { prompt: PromptVariant; suite: Suite; runs: number; workflows: Workflow[]; validate: boolean; output?: string };
export type Pricing = { input: number; cached_input: number; cache_write: number; output: number; source: string };
export type Usage = Required<Pick<OpenAIUsage, "input_tokens" | "output_tokens" | "cached_input_tokens" | "cache_write_tokens">> & { total_tokens: number };
export type Row = {
  repetition: number; workflow: Workflow; conversation: string; domain: string; turn: number;
  expected: Prediction; predicted: Prediction; exact_match: boolean; flag_correct: number;
  beliefs: BeliefState; usage: Usage; estimated_usd: number | null; latency_ms: number;
};

export function parseArgs(argv: string[]): Options {
  const opts: Options = { prompt: "original", suite: "original", runs: 1, workflows: [...WORKFLOWS], validate: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--validate") opts.validate = true;
    else if (arg === "--runs") opts.runs = Number(value());
    else if (arg === "--prompt") opts.prompt = value() as PromptVariant;
    else if (arg === "--suite") opts.suite = value() as Suite;
    else if (arg === "--output") opts.output = value();
    else if (arg === "--workflows") opts.workflows = value().split(",") as Workflow[];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isSafeInteger(opts.runs) || opts.runs < 1 || opts.runs > 20) {
    throw new Error("--runs must be an integer between 1 and 20");
  }
  if (!opts.workflows.length || new Set(opts.workflows).size !== opts.workflows.length ||
      opts.workflows.some(w => !WORKFLOWS.includes(w))) {
    throw new Error(`--workflows must list unique choices of ${WORKFLOWS.join(",")}`);
  }
  if (!PROMPTS.includes(opts.prompt)) throw new Error(`--prompt must be ${PROMPTS.join(", ")}`);
  if (!["original", "holdout"].includes(opts.suite)) throw new Error("--suite must be original or holdout");
  return opts;
}

export function instructions(domain: Domain, variant: PromptVariant = "original"): string {
  if (variant === "compact") {
    return `Track intent and persistent preferences. Context is all user messages, API history plus new_message, or previous_beliefs plus new_message; treat them equivalently. Intent: ${domain.intents.map((k, i) => `${k} (${domain.descriptions[i]})`).join("; ")}. Return intent probabilities summing to 1 and independent probabilities for ${domain.flags.map((k, i) => `${k} (${domain.flagDescriptions[i]})`).join("; ")}. Keep intent across task follow-ups and preference/constraint/permission updates, even without a task verb. Switch for a new task. Use unknown for unrelated requests or explicit pause/cancellation. Preferences persist across tasks; latest explicit changes, negations and reversals win. Use supplied context only. Return schema JSON.`;
  }
  const original = `Track state for a multi-turn user conversation. You will receive EITHER JSON {messages: [all user messages in order]}, OR {new_message} with prior context stored in the API conversation, OR {previous_beliefs, new_message} with only the prior belief snapshot. Treat all formats as equivalent sources of information. Produce probabilities for the CURRENT primary request: ${domain.intents.map((k, i) => `${k} (${domain.descriptions[i]})`).join("; ")}. Those intent probabilities must sum to one. Also produce probabilities for ${domain.flags.map((k, i) => `${k} (${domain.flagDescriptions[i]})`).join("; ")}. Boolean preferences persist unless the user explicitly changes them. The latest explicit change wins, including negations and reversals. Requests that are neither of the named task categories are unknown, without clearing persistent preferences. Infer ONLY from supplied context; do not invent missing history. Return the specified JSON schema, not an explanation.`;
  if (variant === "original") return original;
  return original.replace("the CURRENT primary request", "the task active in this turn") +
    " Intent persists across follow-up questions and changes to the active task's preferences, constraints or permissions, even without a repeated task verb. Preserve the prior task intent for these continuations. Switch intent when a different task is requested. Use unknown for a standalone unrelated request or explicit pause/cancellation, even if an earlier task remains unfinished. A preference update alone does not make intent unknown.";
}

export function predict(state: BeliefState, domain: Domain): Prediction {
  const sorted = [...domain.intents].sort((a, b) => state.intent[b] - state.intent[a]);
  return { intent: sorted[0], ...Object.fromEntries(domain.flags.map(k => [k, state.user[k] >= 0.5])) };
}

export function pricingFromEnv(env: NodeJS.ProcessEnv): Pricing | null {
  const keys = ["MODEL_INPUT_USD_PER_M", "MODEL_CACHED_INPUT_USD_PER_M", "MODEL_CACHE_WRITE_USD_PER_M", "MODEL_OUTPUT_USD_PER_M"];
  if (keys.every(k => env[k] === undefined)) return null;
  const rates = keys.map(k => env[k]?.trim() ? Number(env[k]) : NaN);
  if (!rates.every(x => Number.isFinite(x) && x >= 0)) {
    throw new Error(`pricing requires four nonnegative rates: ${keys.join(", ")}`);
  }
  return { input: rates[0], cached_input: rates[1], cache_write: rates[2], output: rates[3],
    source: env.MODEL_PRICING_SOURCE ?? "Explicit environment rates; USD per million tokens" };
}

export function estimateCost(usage: Usage, pricing: Pricing | null): number | null {
  if (!pricing) return null;
  const uncached = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_tokens;
  if (uncached < 0) throw new Error("cache token counts exceed input tokens");
  return (uncached * pricing.input + usage.cached_input_tokens * pricing.cached_input +
    usage.cache_write_tokens * pricing.cache_write + usage.output_tokens * pricing.output) / 1e6;
}

export function summarize(rows: Row[]) {
  const usage: Usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total_tokens: 0 };
  for (const row of rows) for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += row.usage[k];
  const latencies = rows.map(r => r.latency_ms).sort((a, b) => a - b);
  const n = rows.length;
  const exact = rows.filter(x => x.exact_match).length;
  const intent = rows.filter(x => x.predicted.intent === x.expected.intent).length;
  const flags = rows.reduce((sum, x) => sum + x.flag_correct, 0);
  return {
    turns: n, exact_match_turns: exact, exact_match_rate: n ? exact / n : null,
    intent_correct: intent, intent_accuracy: n ? intent / n : null,
    preference_fields_correct: flags, preference_fields_total: n * 2,
    preference_accuracy: n ? flags / (n * 2) : null, usage,
    median_latency_ms: n ? (latencies[Math.floor((n - 1) / 2)] + latencies[Math.floor(n / 2)]) / 2 : null,
    p95_latency_ms: n ? latencies[Math.ceil(0.95 * n) - 1] : null,
    estimated_usd: n && rows.every(x => x.estimated_usd !== null)
      ? rows.reduce((sum, x) => sum + x.estimated_usd!, 0) : null,
  };
}

// Rotation reduces systematic order bias. Calls remain serial, including across conversations.
export function workflowOrder(workflows: Workflow[], repetition: number): Workflow[] {
  const offset = (repetition - 1) % workflows.length;
  return [...workflows.slice(offset), ...workflows.slice(0, offset)];
}

type RunOptions = {
  apiKey: string; model: string; pricing: Pricing | null; rows: Row[];
  prompt?: PromptVariant; cases?: Conversation[];
  fetchImpl?: typeof fetch; onRow?: (row: Row) => Promise<void>;
  progress?: (message: string) => void;
};
export async function runWorkflow(workflow: Workflow, repetition: number, options: RunOptions): Promise<void> {
  for (const conversation of options.cases ?? conversations) {
    const domain = domains[conversation.domain];
    const history: string[] = [];
    let previousResponseId: string | undefined;
    let snapshot: BeliefSnapshot = { version: 1, beliefs: {} };
    for (let index = 0; index < conversation.turns.length; index++) {
      const message = conversation.turns[index][0];
      history.push(message);
      const input = workflow === "full_history" ? { messages: history }
        : workflow === "belief_snapshot" ? { previous_beliefs: snapshot.beliefs, new_message: message }
          : { new_message: message };
      let usage: OpenAIUsage | undefined;
      let responseId: string | undefined;
      const adapter = createOpenAIInferAdapter({
        apiKey: options.apiKey, model: options.model, instructions: instructions(domain, options.prompt),
        beliefFields: domain, store: workflow === "provider_history",
        ...(workflow === "provider_history" ? { previousResponseId, onResponseId: (id: string) => { responseId = id; } } : {}),
        onUsage: value => { usage = value; }, fetchImpl: options.fetchImpl, requestTimeoutMs: 120_000,
      });
      const runtime = new BeliefRuntime({}, { inferBeliefs: adapter });
      if (workflow === "belief_snapshot") runtime.loadBeliefSnapshot(snapshot);
      await runtime.assign("turn_input", { kind: "string", value: JSON.stringify(input) });
      const start = performance.now();
      try {
        await runtime.infer({ kind: "identifier", name: "turn_input" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown inference failure";
        throw new Error(`${workflow} repetition ${repetition} ${conversation.id} turn ${index + 1}: ${detail}`);
      }
      const latency = Math.round(performance.now() - start);
      if (!usage) throw new Error("missing token usage");
      const state = runtime.getState();
      const predicted = predict(state, domain);
      const expected = labelFor(conversation, index);
      const flagCorrect = domain.flags.filter(f => predicted[f] === expected[f]).length;
      if (workflow === "provider_history") previousResponseId = responseId;
      if (workflow === "belief_snapshot") snapshot = runtime.getBeliefSnapshot();
      const tokens: Usage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        cached_input_tokens: usage.cached_input_tokens ?? 0, cache_write_tokens: usage.cache_write_tokens ?? 0,
        total_tokens: usage.input_tokens + usage.output_tokens };
      const row: Row = { repetition, workflow, conversation: conversation.id, domain: conversation.domain,
        turn: index + 1, expected, predicted, exact_match: predicted.intent === expected.intent && flagCorrect === 2,
        flag_correct: flagCorrect, beliefs: state, usage: tokens,
        estimated_usd: estimateCost(tokens, options.pricing), latency_ms: latency };
      options.rows.push(row);
      await options.onRow?.(row);
    }
    const matches = options.rows.filter(r => r.repetition === repetition && r.workflow === workflow &&
      r.conversation === conversation.id && r.exact_match).length;
    options.progress?.(`${workflow} repetition ${repetition} ${conversation.id}: ${matches}/${conversation.turns.length} exact`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const cases = args.suite === "original" ? conversations : holdoutConversations;
  const fixture = args.suite === "original" ? validateFixtures() : validateHoldout();
  if (args.validate) {
    console.log(JSON.stringify({ validated: true, suite: args.suite, prompt_variant: args.prompt, ...fixture }, null, 2));
    return;
  }
  const model = process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const pricing = pricingFromEnv(process.env);
  const output = args.output ?? `benchmarks/results/multidomain-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const createdAt = new Date().toISOString();
  const rows: Row[] = [];
  const fixtureHash = createHash("sha256").update(JSON.stringify({ domains, conversations: cases })).digest("hex");
  // Identify the implementation used even before the eventual commit is created.
  const implementationHash = createHash("sha256");
  for (const file of ["multidomain_benchmark.js", "multidomain_cases.js", "multidomain_holdout.js", "openai.js", "runtime.js"]) {
    implementationHash.update(await readFile(new URL(file, import.meta.url)));
  }
  const implementationSha256 = implementationHash.digest("hex");
  type Status = "running" | "completed" | "failed";
  const report = (status: Status, error?: string) => {
    const group = (subset: Row[]) => Object.fromEntries(args.workflows.map(w => [w, summarize(subset.filter(r => r.workflow === w))]));
    const results = group(rows);
    const comparisons: Record<string, number> = {};
    if (status === "completed" && results.belief_snapshot) {
      const snapshot = results.belief_snapshot;
      for (const baseline of ["full_history", "provider_history"] as const) {
        const base = results[baseline];
        if (!base) continue;
        comparisons[`snapshot_vs_${baseline}_token_reduction_percent`] = 100 * (1 - snapshot.usage.total_tokens / base.usage.total_tokens);
        comparisons[`snapshot_vs_${baseline}_accuracy_change_percentage_points`] = 100 * (snapshot.exact_match_rate! - base.exact_match_rate!);
        if (base.estimated_usd && snapshot.estimated_usd !== null) {
          comparisons[`snapshot_vs_${baseline}_cost_reduction_percent`] = 100 * (1 - snapshot.estimated_usd / base.estimated_usd);
        }
      }
    }
    return {
      benchmark: "multidomain-beliefs-v1", status, created_at: createdAt, updated_at: new Date().toISOString(),
      model, prompt_variant: args.prompt, suite: args.suite, reasoning_effort: model === "gpt-6-luna" ? "none" : "provider default", node_version: process.version,
      fixtures: fixture, fixture_sha256: fixtureHash, implementation_sha256: implementationSha256,
      runs: args.runs, workflows: args.workflows,
      workflow_order_by_repetition: Array.from({ length: args.runs }, (_, i) => workflowOrder(args.workflows, i + 1)),
      expected_calls: fixture.turns * args.runs * args.workflows.length, completed_calls: rows.length,
      pricing_usd_per_million: pricing,
      instructions_by_domain: Object.fromEntries(Object.entries(domains).map(([k, d]) => [k, instructions(d, args.prompt)])),
      methodology: "Synthetic labeled conversations; identical domain instructions/schema across paths. Full history resends user messages only; provider history retains model outputs too. Snapshot sends only BeliefRuntime state and latest message. Every creation/update call counted. Latency includes response body, parsing and runtime infer merge, excludes local snapshot load/save and report writes. Serial calls, rotating workflow order, no retries, 120s request timeout. Cache reads/writes are disjoint subsets of input; absent cache fields treated as zero. Cost uses explicit supplied rates only; excludes storage, serialization, taxes and failed/unreported calls. Partial reports must not be used for workflow comparisons.",
      results, by_domain: Object.fromEntries(Object.keys(domains).map(d => [d, group(rows.filter(r => r.domain === d))])),
      by_repetition: Object.fromEntries(Array.from({ length: args.runs }, (_, i) => [String(i + 1), group(rows.filter(r => r.repetition === i + 1))])),
      comparisons, ...(error ? { error, failure_note: "Failed request may have incurred charges absent from reported usage; remaining calls were not attempted." } : {}), rows,
    };
  };
  await mkdir(dirname(output), { recursive: true });
  const save = async (status: Status, error?: string) => {
    await writeFile(`${output}.tmp`, JSON.stringify(report(status, error), null, 2) + "\n", "utf8");
    await rename(`${output}.tmp`, output);
  };
  await save("running");
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing; use --validate for offline fixture validation");
    for (let repetition = 1; repetition <= args.runs; repetition++) {
      for (const workflow of workflowOrder(args.workflows, repetition)) {
        await runWorkflow(workflow, repetition, { apiKey, model, pricing, rows, prompt: args.prompt, cases,
          onRow: async () => { await save("running"); }, progress: message => console.error(message) });
      }
    }
    await save("completed");
    console.log(JSON.stringify({ ...report("completed"), rows: undefined }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown benchmark failure";
    await save("failed", message);
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? `error: ${error.message}` : "error: benchmark failed");
    process.exitCode = 1;
  });
}
