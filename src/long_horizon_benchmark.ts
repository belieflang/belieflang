import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BeliefRuntime, type FactPatchEntry, type LongHorizonSnapshot } from "./runtime.js";
import { longHorizonConversations, validateLongHorizonFixtures, type LongHorizonConversation } from "./long_horizon_cases.js";

export const LONG_HORIZON_METHODS = ["full_history", "rolling_summary", "belieflang"] as const;
export type LongHorizonMethod = typeof LONG_HORIZON_METHODS[number];
export const LONG_HORIZON_BUDGET_USD = 5;
export const LUNA_PRICING = { input: 0.10, cached_input: 0.01, cache_write: 0.125, output: 0.50 } as const;
const ENDPOINT = "https://api.openai.com/v1/responses";
const MAX_OUTPUT_TOKENS = 512;

export type Usage = { input_tokens: number; output_tokens: number; cached_input_tokens: number; cache_write_tokens: number };
export type Scalar = string | number | boolean;
export type FactUpdate = { field: string; operation: "set" | "clear"; value: string | number | boolean | null; confidence: number };
export type ModelOutput = { answer: Scalar | null; updated_summary: string | null; fact_updates: FactUpdate[] };
export type ResultRow = {
  method: LongHorizonMethod; conversation: string; domain: string; turn: number;
  question: string | null; expected_answer: Scalar | null; predicted_answer: Scalar | null;
  answer_correct: boolean | null; unsupported_answer: boolean; state_correct: number | null; state_total: number | null;
  critical_failure: boolean; confidence_brier_sum: number | null; confidence_count: number;
  fact_updates: FactUpdate[]; summary_chars: number; snapshot_chars: number; context_chars: number;
  usage: Usage; estimated_usd: number; latency_ms: number; facts_snapshot: Record<string, unknown>;
};
type LedgerEntry = { conversation: string; turn: number; method: LongHorizonMethod; status: "pending" | "succeeded" | "failed";
  estimated_usd: number; usage?: Usage; error?: string; at: string };
export type LongHorizonRun = { benchmark: string; status: "running" | "completed" | "failed"; created_at: string;
  updated_at: string; model: string; model_version: string; fixture_sha256: string; configuration_sha256: string;
  fixture_validation: ReturnType<typeof validateLongHorizonFixtures>; budget_cap_usd: number; estimated_spend_usd: number;
  unmetered_failure_reserve_usd: number; attempts: number; successful_calls: number; failed_calls: number;
  methods: typeof LONG_HORIZON_METHODS; methodology: string; rows: ResultRow[]; ledger: LedgerEntry[];
  summary?: Record<string, unknown>; error?: string };

type RunOptions = { apiKey: string; output: string; fetchImpl?: typeof fetch; maxSpendUsd?: number;
  pilot?: boolean; onProgress?: (message: string) => void };

function schemaFor(conversation: LongHorizonConversation, method: LongHorizonMethod, answerField?: string) {
  const updateCases = Object.entries(conversation.schema).flatMap(([field, declaration]) => {
    const type = typeof declaration === "string" ? declaration : declaration.type;
    const valueType = type === "string" && typeof declaration !== "string" && declaration.enum
      ? { type, enum: declaration.enum } : { type };
    return (["set", "clear"] as const).map(operation => ({ type: "object", properties: {
      field: { type: "string", enum: [field] }, operation: { type: "string", enum: [operation] },
      value: operation === "set" ? valueType : { type: "null" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    }, required: ["field", "operation", "value", "confidence"], additionalProperties: false }));
  });
  const update = { anyOf: updateCases };
  const answerDeclaration = answerField ? conversation.schema[answerField] : undefined;
  const answerType = typeof answerDeclaration === "string" ? answerDeclaration : answerDeclaration?.type;
  const answerSchema = !answerType ? { type: "null" } : answerType === "string" &&
    answerDeclaration !== undefined && typeof answerDeclaration !== "string" && answerDeclaration.enum
      ? { anyOf: [{ type: "string", enum: answerDeclaration.enum }, { type: "null" }] }
      : { anyOf: [{ type: answerType }, { type: "null" }] };
  return { type: "object", properties: {
    answer: answerSchema,
    fact_updates: { type: "array", items: update },
    ...(method === "rolling_summary" ? { updated_summary: { type: "string" } } : { updated_summary: { type: "null" } }),
  }, required: ["answer", "fact_updates", "updated_summary"], additionalProperties: false,
  };
}

function instructions(conversation: LongHorizonConversation, method: LongHorizonMethod): string {
  const methodText = method === "full_history"
    ? "You receive all user messages up to this turn. Use only those messages."
    : method === "rolling_summary"
      ? "You receive the prior rolling summary and only the newest user message. Replace the summary with a concise, updated factual summary. Resolve contradictions using the latest explicit statement; preserve unresolved or canceled status accurately. Do not assume you can access discarded messages."
      : "You receive a typed BeliefLang runtime snapshot and only the newest user message. Treat the snapshot as the full retained state, update it only when the message adds, revises, or clears a fact, and never rely on discarded messages.";
  return `You are maintaining long-horizon conversation state for ${conversation.domain}. ${methodText} The declared fact fields and exact types are: ${JSON.stringify(conversation.schema)}. Extract only explicit, useful user facts into fact_updates. task_status must be exactly active, paused, or canceled. Use clear only when a prior fact is explicitly withdrawn and no replacement is supplied. Use confidence from 0 to 1. If the current turn has no question, answer must be null. If it asks a question, answer with only the requested fact, using its canonical spelling or number; use null if the supplied context does not establish it. Never invent details. updated_summary is used only in the rolling_summary condition and must retain corrected current facts, decisions, exclusions, pauses/cancellations, and unresolved status in at most 100 words.`;
}

function contextFor(method: LongHorizonMethod, history: string[], summary: string, snapshot: LongHorizonSnapshot,
  message: string, question: string | null): unknown {
  if (method === "full_history") return { messages: history, question };
  if (method === "rolling_summary") return { prior_summary: summary, new_message: message, question };
  return { previous_belieflang_snapshot: snapshot, new_message: message, question };
}

function parseUsage(raw: unknown): Usage {
  if (!raw || typeof raw !== "object") throw new Error("response omitted usage");
  const data = raw as Record<string, unknown>;
  const integer = (n: unknown, name: string) => {
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${name}`);
    return n;
  };
  const details = (data.input_tokens_details && typeof data.input_tokens_details === "object")
    ? data.input_tokens_details as Record<string, unknown> : {};
  const result = { input_tokens: integer(data.input_tokens, "input token count"),
    output_tokens: integer(data.output_tokens, "output token count"),
    cached_input_tokens: integer(details.cached_tokens ?? 0, "cached token count"),
    cache_write_tokens: integer(details.cache_write_tokens ?? 0, "cache-write token count") };
  if (result.cached_input_tokens + result.cache_write_tokens > result.input_tokens) throw new Error("cache tokens exceed input tokens");
  return result;
}

function cost(usage: Usage): number {
  const uncached = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_tokens;
  return (uncached * LUNA_PRICING.input + usage.cached_input_tokens * LUNA_PRICING.cached_input +
    usage.cache_write_tokens * LUNA_PRICING.cache_write + usage.output_tokens * LUNA_PRICING.output) / 1e6;
}

function conservativeFailureCost(input: string): number {
  // Reserve two tokens per UTF-8 byte plus the full requested output at the highest input rate.
  const bytes = Buffer.byteLength(input, "utf8");
  return (bytes * 2 * LUNA_PRICING.cache_write + MAX_OUTPUT_TOKENS * LUNA_PRICING.output) / 1e6;
}

function parseOutput(data: unknown): ModelOutput {
  if (!data || typeof data !== "object" || !Array.isArray((data as any).output)) throw new Error("response has no output");
  const outputs = (data as any).output as unknown[];
  const messages = outputs.filter((x: any) => x?.type === "message" && (x.phase === "final_answer" || x.phase == null));
  if (messages.length !== 1) throw new Error("response must contain one final answer message");
  const text = (messages[0] as any).content?.find((x: any) => x?.type === "output_text")?.text;
  if (typeof text !== "string") throw new Error("response omitted structured output text");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("response output was invalid JSON"); }
  if (!parsed || typeof parsed !== "object") throw new Error("invalid structured output");
  const result = parsed as Record<string, unknown>;
  if (!(result.answer === null || ["string", "number", "boolean"].includes(typeof result.answer)) ||
      !(result.updated_summary === null || typeof result.updated_summary === "string") || !Array.isArray(result.fact_updates)) {
    throw new Error("structured output fields are invalid");
  }
  const fact_updates = result.fact_updates.map((raw: any) => {
    if (!raw || typeof raw !== "object" || typeof raw.field !== "string" ||
        !["set", "clear"].includes(raw.operation) ||
        !(raw.value === null || ["string", "number", "boolean"].includes(typeof raw.value)) ||
        typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
      throw new Error("invalid fact update");
    }
    if ((raw.operation === "set" && raw.value === null) || (raw.operation === "clear" && raw.value !== null)) {
      throw new Error("fact update operation and value disagree");
    }
    return raw as FactUpdate;
  });
  return { answer: result.answer as Scalar | null, updated_summary: result.updated_summary as string | null, fact_updates };
}

async function callModel(args: { apiKey: string; model: string; instruction: string; input: string; schema: object;
  fetchImpl: typeof fetch }): Promise<{ output: ModelOutput; usage: Usage }> {
  const response = await args.fetchImpl(ENDPOINT, { method: "POST", signal: AbortSignal.timeout(90_000),
    headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: args.model, reasoning: { effort: "none" }, store: false, max_output_tokens: MAX_OUTPUT_TOKENS,
      instructions: args.instruction, input: args.input,
      text: { format: { type: "json_schema", name: "long_horizon_state", strict: true, schema: args.schema } } }) });
  if (!response.ok) throw new Error(`OpenAI API returned HTTP ${response.status}`);
  const data: unknown = await response.json();
  if ((data as any)?.status !== "completed") throw new Error(`OpenAI response status: ${String((data as any)?.status)}`);
  return { output: parseOutput(data), usage: parseUsage((data as any).usage) };
}

export function exactAnswerMatches(a: unknown, b: unknown): boolean {
  if (typeof b === "string") return typeof a === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
  if (typeof b === "number") return a === b || (typeof a === "string" && a.trim() !== "" && Number(a) === b);
  if (typeof b === "boolean") return a === b || (typeof a === "string" && a.trim().toLowerCase() === String(b));
  return a === b;
}

const exact = exactAnswerMatches;

export function scoreSummary(rows: ResultRow[]) {
  return Object.fromEntries(LONG_HORIZON_METHODS.map(method => {
    const subset = rows.filter(x => x.method === method);
    const checkpoints = subset.filter(x => x.answer_correct !== null);
    const exactAnswers = checkpoints.filter(x => x.answer_correct).length;
    const stateCompared = subset.filter(x => x.state_total !== null);
    const stateCorrect = stateCompared.reduce((n, r) => n + (r.state_correct ?? 0), 0);
    const stateTotal = stateCompared.reduce((n, r) => n + (r.state_total ?? 0), 0);
    const confidenceRows = subset.filter(x => x.confidence_brier_sum !== null);
    const confidenceBrier = confidenceRows.reduce((n, x) => n + (x.confidence_brier_sum ?? 0), 0);
    const confidenceCount = confidenceRows.reduce((n, x) => n + x.confidence_count, 0);
    const usage = subset.reduce((a, r) => ({ input_tokens: a.input_tokens + r.usage.input_tokens,
      output_tokens: a.output_tokens + r.usage.output_tokens, cached_input_tokens: a.cached_input_tokens + r.usage.cached_input_tokens,
      cache_write_tokens: a.cache_write_tokens + r.usage.cache_write_tokens }),
      { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0 });
    const latency = subset.map(x => x.latency_ms).sort((a, b) => a - b);
    const p = (q: number) => latency.length ? latency[Math.ceil(q * latency.length) - 1] : null;
    return [method, { turns: subset.length, checkpoints: checkpoints.length, correct_answers: exactAnswers,
      factual_recall_accuracy: checkpoints.length ? exactAnswers / checkpoints.length : null,
      facts_correct: stateCorrect, facts_scored: stateTotal, fact_retention_accuracy: stateTotal ? stateCorrect / stateTotal : null,
      critical_failures: subset.filter(x => x.critical_failure).length,
      unsupported_answers: subset.filter(x => x.unsupported_answer).length,
      confidence_brier_score: confidenceCount ? confidenceBrier / confidenceCount : null,
      confidence_predictions_scored: confidenceCount, usage, total_tokens: usage.input_tokens + usage.output_tokens,
      estimated_usd: subset.reduce((n, x) => n + x.estimated_usd, 0), cost_per_correct_answer: exactAnswers ? subset.reduce((n, x) => n + x.estimated_usd, 0) / exactAnswers : null,
      median_latency_ms: p(0.5), p95_latency_ms: p(0.95), median_context_chars: latency.length ? subset.map(x => x.context_chars).sort((a,b)=>a-b)[Math.floor(subset.length/2)] : null,
      max_snapshot_chars: subset.reduce((n, x) => Math.max(n, x.snapshot_chars), 0) }];
  }));
}

function byLength(rows: ResultRow[]) {
  return Object.fromEntries(LONG_HORIZON_METHODS.map(method => [method, Array.from({ length: 20 }, (_, i) => {
    const length = i + 1;
    const subset = rows.filter(x => x.method === method && x.turn <= length);
    return { conversation_turn: length, cumulative_input_tokens: subset.reduce((n,x)=>n+x.usage.input_tokens,0),
      cumulative_output_tokens: subset.reduce((n,x)=>n+x.usage.output_tokens,0), cumulative_cost_usd: subset.reduce((n,x)=>n+x.estimated_usd,0) };
  })]));
}

export async function runLongHorizon(options: RunOptions): Promise<LongHorizonRun> {
  const cap = options.maxSpendUsd ?? LONG_HORIZON_BUDGET_USD;
  if (!(cap > 0 && cap <= LONG_HORIZON_BUDGET_USD)) throw new Error("spend cap must be in (0, $5]");
  const model = "gpt-6-luna";
  const fixtureValidation = validateLongHorizonFixtures();
  const fixtureHash = createHash("sha256").update(JSON.stringify(longHorizonConversations)).digest("hex");
  const configuration = { model, methods: LONG_HORIZON_METHODS, max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning_effort: "none", pricing: LUNA_PRICING, budget_cap_usd: cap, pilot: options.pilot ?? false, version: 1 };
  const configurationHash = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
  const createdAt = new Date().toISOString();
  let rows: ResultRow[] = [];
  let ledger: LedgerEntry[] = [];
  let failureReserve = 0;
  try {
    const saved = JSON.parse(await readFile(options.output, "utf8")) as LongHorizonRun;
    if (saved.fixture_sha256 !== fixtureHash || saved.configuration_sha256 !== configurationHash) throw new Error("resume refused: fixture or configuration hash changed");
    rows = saved.rows ?? []; ledger = saved.ledger ?? [];
    failureReserve = ledger.filter(x => x.status === "pending" || x.status === "failed").reduce((n, x) => n + x.estimated_usd, 0);
    for (const entry of ledger) if (entry.status === "pending") {
      entry.status = "failed";
      entry.error = "process stopped after request was checkpointed; usage is unknown and conservatively reserved";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const run: LongHorizonRun = { benchmark: "belieflang-long-horizon-v2", status: "running", created_at: createdAt,
    updated_at: new Date().toISOString(), model, model_version: "gpt-6-luna; provider alias (no immutable model revision exposed)",
    fixture_sha256: fixtureHash, configuration_sha256: configurationHash, fixture_validation: fixtureValidation,
    budget_cap_usd: cap, estimated_spend_usd: 0, unmetered_failure_reserve_usd: failureReserve,
    attempts: ledger.length, successful_calls: rows.length, failed_calls: ledger.filter(x => x.status === "failed").length,
    methods: LONG_HORIZON_METHODS, methodology: "One Luna Responses API request per user turn per method. Full history resends all user messages; rolling summary replaces its memory each turn and includes the newest message; BeliefLang sends only the typed BeliefRuntime v2 snapshot and newest message. Every method emits the same answer and fact-update schema; summary text is produced only for the rolling-summary condition. No retry after a failed request. Usage is counted for every successful call; failed requests reserve a conservative upper-bound estimate of 2 tokens per UTF-8 input byte plus max output. Calls are serial, max_output_tokens=512, reasoning=none, and the hard budget is $5 including exploratory calls. Latency covers request, response parse, and runtime update. Critical failures are wrong or unanswered checkpoints for labeled dates, budgets, exclusions, cancellation or permission status, incident identifiers, and safety limits. Confidence Brier scores use present fact records at checkpoints; missing facts are counted separately in retention accuracy. Break-even requires observed recall within five percentage points. Raw output omits provider identifiers and credentials.", rows, ledger };
  const currentSpend = () => rows.reduce((n,x)=>n+x.estimated_usd,0) + failureReserve;
  const save = async () => {
    run.updated_at = new Date().toISOString(); run.estimated_spend_usd = currentSpend();
    run.attempts = ledger.length; run.successful_calls = rows.length;
    run.failed_calls = ledger.filter(x => x.status === "failed").length;
    run.rows = rows; run.ledger = ledger;
    run.unmetered_failure_reserve_usd = ledger.filter(x => x.status === "pending" || (x.status === "failed" && !x.usage))
      .reduce((n, x) => n + x.estimated_usd, 0);
    run.summary = makeSummary(rows);
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(`${options.output}.tmp`, JSON.stringify(run, null, 2) + "\n", "utf8");
    await rename(`${options.output}.tmp`, options.output);
  };
  const completed = new Set(rows.map(r => `${r.method}/${r.conversation}/${r.turn}`));
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const selectedConversations = options.pilot ? [longHorizonConversations[7]] : longHorizonConversations;
    const turnLimit = options.pilot ? 10 : 20;
    for (let ci = 0; ci < selectedConversations.length; ci++) {
      const conversation = selectedConversations[ci];
      for (const method of LONG_HORIZON_METHODS) {
        // Replay the successful prefix so resumption reconstructs each strategy's state deterministically.
        let runtime = new BeliefRuntime(); runtime.declareFacts(conversation.schema);
        let summary = ""; const history: string[] = [];
        const previous = rows.filter(x => x.method === method && x.conversation === conversation.id).sort((a,b)=>a.turn-b.turn);
        let priorByTurn = new Map(previous.map(x => [x.turn, x]));
        let snapshot: LongHorizonSnapshot = runtime.getLongHorizonSnapshot();
        for (let ti = 0; ti < Math.min(turnLimit, conversation.turns.length); ti++) {
          const turn = ti + 1; const message = conversation.turns[ti]; history.push(message);
          const key = `${method}/${conversation.id}/${turn}`;
          const savedRow = priorByTurn.get(turn);
          if (savedRow) {
            // Persisted row state is the checkpoint after this turn, including any facts merged by BeliefRuntime.
            if (method === "belieflang" && savedRow.facts_snapshot && Object.keys(savedRow.facts_snapshot).length) {
              runtime = new BeliefRuntime();
              runtime.loadLongHorizonSnapshot(savedRow.facts_snapshot as unknown as LongHorizonSnapshot);
              snapshot = runtime.getLongHorizonSnapshot();
            } else if (method !== "belieflang") {
              runtime.mergeFactPatch(savedRow.fact_updates.map(x => ({ [x.field]: { operation: x.operation,
                ...(x.value !== null ? { value: x.value } : {}), confidence: x.confidence, sourceTurn: turn } })).reduce((a,b)=>Object.assign(a,b), {}) as Record<string, FactPatchEntry>);
            }
            if (method === "rolling_summary" && savedRow.facts_snapshot && typeof (savedRow.facts_snapshot as any).__summary === "string") summary = (savedRow.facts_snapshot as any).__summary;
            continue;
          }
          // If this is a partial run with a gap, don't make downstream context ambiguous.
          if (completed.has(key)) continue;
          const checkpoint = conversation.checkpoints.find(x => x.turn === turn);
          const question = checkpoint?.question ?? null;
          const context = contextFor(method, history, summary, snapshot, message, question);
          const input = JSON.stringify(context);
          const shape = schemaFor(conversation, method, checkpoint?.field);
          delete (shape as any)._factShape;
          const requestBody = { model, reasoning: { effort: "none" }, store: false, max_output_tokens: MAX_OUTPUT_TOKENS,
            instructions: instructions(conversation, method), input, text: { format: { type: "json_schema", name: "long_horizon_state", strict: true, schema: shape } } };
          const requestString = JSON.stringify(requestBody);
          const measuredContextChars = Buffer.byteLength(`${requestBody.instructions}\n${input}\n${JSON.stringify(shape)}`, "utf8");
          const reserve = conservativeFailureCost(requestString);
          if (currentSpend() + reserve > cap) throw new Error(`budget guard stopped before call ${method}/${conversation.id}/${turn}; projected upper bound $${(currentSpend()+reserve).toFixed(4)} exceeds $${cap.toFixed(2)}`);
          const start = performance.now();
          const ledgerIndex = ledger.length;
          ledger.push({ conversation: conversation.id, turn, method, status: "pending", estimated_usd: reserve,
            error: "request checkpointed; result pending", at: new Date().toISOString() });
          failureReserve += reserve;
          await save();
          let reportedUsage: Usage | undefined;
          try {
            const result = await callModel({ apiKey: options.apiKey, model, instruction: instructions(conversation, method),
              input, schema: shape, fetchImpl });
            reportedUsage = result.usage;
            if (result.output.fact_updates.some(x => !Object.hasOwn(conversation.schema, x.field))) throw new Error("model updated undeclared fact");
            const patch = Object.fromEntries(result.output.fact_updates.map(x => [x.field, { operation: x.operation,
              ...(x.value !== null ? { value: x.value } : {}), confidence: x.confidence, sourceTurn: turn }])) as Record<string, FactPatchEntry>;
            runtime.mergeFactPatch(patch);
            snapshot = runtime.getLongHorizonSnapshot();
            if (method === "rolling_summary" && result.output.updated_summary !== null) summary = result.output.updated_summary;
            const elapsed = Math.round(performance.now() - start);
            const summaryContext = method === "rolling_summary" ? summary : "";
            const facts = runtime.getFacts();
            const stateCorrect = checkpoint ? Object.entries(checkpoint.expectedState).filter(([field, value]) => {
              const actual = facts[field]; return actual?.status === "active" && exact(actual.value, value);
            }).length : null;
            const stateTotal = checkpoint ? Object.keys(checkpoint.expectedState).length : null;
            const scoredFacts = checkpoint ? Object.entries(checkpoint.expectedState).flatMap(([field, value]) => {
              const actual = facts[field];
              return actual?.status === "active" ? [Math.pow(actual.confidence - (exact(actual.value, value) ? 1 : 0), 2)] : [];
            }) : [];
            const predicted = checkpoint ? result.output.answer : null;
            const answerCorrect = checkpoint ? exact(predicted, checkpoint.expected) : null;
            const row: ResultRow = { method, conversation: conversation.id, domain: conversation.domain, turn,
              question, expected_answer: checkpoint?.expected ?? null, predicted_answer: predicted,
              answer_correct: answerCorrect, unsupported_answer: Boolean(checkpoint && predicted !== null && !answerCorrect),
              state_correct: stateCorrect, state_total: stateTotal,
              critical_failure: Boolean(checkpoint?.critical && !answerCorrect),
              confidence_brier_sum: checkpoint ? scoredFacts.reduce((n, x) => n + x, 0) : null,
              confidence_count: scoredFacts.length, fact_updates: result.output.fact_updates,
              summary_chars: summaryContext.length, snapshot_chars: method === "belieflang" ? JSON.stringify(snapshot).length : 0,
              context_chars: measuredContextChars, usage: result.usage, estimated_usd: cost(result.usage), latency_ms: elapsed,
              facts_snapshot: method === "belieflang" ? snapshot as unknown as Record<string, unknown>
                : { facts, ...(method === "rolling_summary" ? { __summary: summary } : {}) } };
            rows.push(row); completed.add(key);
            ledger[ledgerIndex] = { conversation: conversation.id, turn, method, status: "succeeded",
              estimated_usd: row.estimated_usd, usage: result.usage, at: new Date().toISOString() };
            failureReserve -= reserve;
            await save();
            options.onProgress?.(`${method} ${conversation.id} turn ${turn}/20; estimated spend $${currentSpend().toFixed(4)}`);
          } catch (error) {
            if (completed.has(key)) throw error;
            const messageText = error instanceof Error ? error.message : "unknown error";
            const actualCost = reportedUsage ? cost(reportedUsage) : undefined;
            if (reportedUsage) failureReserve = Math.max(0, failureReserve - reserve) + actualCost!;
            ledger[ledgerIndex] = { conversation: conversation.id, turn, method, status: "failed",
              estimated_usd: actualCost ?? reserve, ...(reportedUsage ? { usage: reportedUsage } : {}),
              error: messageText, at: new Date().toISOString() };
            run.status = "failed"; run.error = messageText; await save();
            throw new Error(`${method} ${conversation.id} turn ${turn} failed (conservative reserve $${reserve.toFixed(4)}): ${messageText}`);
          }
        }
      }
    }
    run.status = "completed"; delete run.error; await save();
    return run;
  } catch (error) {
    run.status = "failed"; run.error = error instanceof Error ? error.message : "unknown benchmark error";
    await save(); throw error;
  }
}

function makeSummary(rows: ResultRow[]) {
  const byMethod = scoreSummary(rows);
  const lengths = byLength(rows);
  const qualityCost = LONG_HORIZON_METHODS.map(method => ({ method,
    accuracy: (byMethod[method] as any).factual_recall_accuracy, cost: (byMethod[method] as any).estimated_usd }));
  const baselineBreakEven: Record<string, number | null> = {};
  for (const baseline of ["full_history", "rolling_summary"] as const) {
    const base = rows.filter(x => x.method === baseline);
    const belief = rows.filter(x => x.method === "belieflang");
    const points = Array.from({ length: 20 }, (_, i) => i + 1).map(length => {
      const a = base.filter(x => x.turn <= length).reduce((n,x)=>n+x.estimated_usd,0);
      const b = belief.filter(x => x.turn <= length).reduce((n,x)=>n+x.estimated_usd,0);
      const baseChecks = base.filter(x => x.turn <= length && x.answer_correct !== null);
      const beliefChecks = belief.filter(x => x.turn <= length && x.answer_correct !== null);
      const baseAccuracy = baseChecks.length ? baseChecks.filter(x => x.answer_correct).length / baseChecks.length : null;
      const beliefAccuracy = beliefChecks.length ? beliefChecks.filter(x => x.answer_correct).length / beliefChecks.length : null;
      return { length, delta: b-a, baseAccuracy, beliefAccuracy,
        comparableQuality: baseAccuracy !== null && beliefAccuracy !== null && Math.abs(baseAccuracy - beliefAccuracy) <= 0.05 };
    });
    baselineBreakEven[`belieflang_vs_${baseline}`] = points.find(x => x.comparableQuality && x.delta <= 0)?.length ?? null;
  }
  return { by_method: byMethod, cumulative_cost_tokens_by_turn: lengths, accuracy_cost_points: qualityCost, break_even_conversation_turn: baselineBreakEven };
}

export async function validateOffline() {
  const fixtures = validateLongHorizonFixtures();
  const runtime = new BeliefRuntime(); runtime.declareFacts({ budget: "number", destination: "string", canceled: "boolean" });
  runtime.mergeFactPatch({ budget: { operation: "set", value: 900, confidence: 0.95, sourceTurn: 1 },
    destination: { operation: "set", value: "Lisbon", confidence: 0.9, sourceTurn: 2 } });
  const snapshot = runtime.getLongHorizonSnapshot();
  const restored = new BeliefRuntime(); restored.loadLongHorizonSnapshot(JSON.parse(JSON.stringify(snapshot)) as LongHorizonSnapshot);
  restored.mergeFactPatch({ budget: { operation: "set", value: 1100, confidence: 0.99, sourceTurn: 3 },
    canceled: { operation: "set", value: true, confidence: 1, sourceTurn: 4 } });
  if (restored.getFacts().budget?.value !== 1100 || restored.getFacts().destination?.value !== "Lisbon" || restored.getFacts().canceled?.value !== true) {
    throw new Error("offline runtime snapshot and revision check failed");
  }
  let rejected = false;
  try { restored.mergeFactPatch({ budget: { operation: "set", value: "high", confidence: 0.9, sourceTurn: 5 } }); } catch { rejected = true; }
  if (!rejected) throw new Error("offline runtime accepted a wrongly typed fact");
  return { ...fixtures, runtime_snapshot_round_trip: true, typed_fact_validation: true };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--validate")) { console.log(JSON.stringify(await validateOffline(), null, 2)); return; }
  const pilot = argv.includes("--pilot");
  const output = argv.find((x, i) => argv[i - 1] === "--output") ??
    (pilot ? "benchmarks/results/long-horizon-v2-pilot-2026-10-17.json" : "benchmarks/results/long-horizon-v2-2026-10-17.json");
  const capArg = argv.find((x, i) => argv[i - 1] === "--max-spend");
  const cap = capArg === undefined ? LONG_HORIZON_BUDGET_USD : Number(capArg);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is unavailable; offline --validate requires no credentials");
  const run = await runLongHorizon({ apiKey, output, maxSpendUsd: cap, pilot, onProgress: m => console.error(m) });
  console.log(JSON.stringify({ status: run.status, summary: run.summary, attempts: run.attempts,
    successful_calls: run.successful_calls, failed_calls: run.failed_calls, estimated_spend_usd: run.estimated_spend_usd }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(error instanceof Error ? `error: ${error.message}` : "error: benchmark failed"); process.exitCode = 1; });
}
