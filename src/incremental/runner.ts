import type { FactDelta, FactValue } from "../fact_memory.js";
import { Authority, StructuredMemory } from "./memory.js";
import {
  exact,
  objectSchema,
  parseAnswers,
  parseRoute,
  parseUpdate,
  readRequest,
  request,
  routeRequest,
  updateSchema,
} from "./protocol.js";
import {
  bytes,
  key,
  missing,
  queries,
  type Answer,
  type Case,
  type Event,
  type Gold,
  type Inference,
  type Method,
  type Query,
  type Request,
  type Result,
  type Schedule,
} from "./types.js";
export type Call = Request & Result;
export type Check = {
  id: string;
  turn: number;
  queries: Query[];
  answers: (Answer | null)[];
  route?: Query;
  decision?: {
    attempted: boolean;
    executed: boolean;
    reason: string;
    cacheHit: boolean;
  };
  cumulative: ReturnType<typeof totals>;
};
export type Run = {
  case: string;
  method: Method;
  schedule: Schedule;
  calls: Call[];
  checks: Check[];
  states: {
    turn: number;
    bytes: number;
    changedFields: number;
    duplicateSkipped: boolean;
  }[];
  routes: number;
  decisionRecomputations: number;
  decisionCacheHits: number;
  localLatencyMs: number;
};
export function totals(calls: Call[]) {
  const metered = calls.filter((c) => c.usage !== null),
    all = metered.length === calls.length;
  const known = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
  for (const c of metered)
    for (const k of Object.keys(known) as (keyof typeof known)[])
      known[k] += c.usage![k] ?? 0;
  const costs = calls.every((c) => c.cost !== null);
  return {
    calls: calls.length,
    failedCalls: calls.filter((c) => c.error).length,
    byKind: Object.fromEntries(
      ["route", "update", "summary", "read"].map((k) => [
        k,
        calls.filter((c) => c.kind === k).length,
      ]),
    ),
    measuredTokens: {
      input: all ? known.input : null,
      output: all ? known.output : null,
      cached:
        all && metered.every((c) => c.usage!.cached !== null)
          ? known.cached
          : null,
      cacheWrite:
        all && metered.every((c) => c.usage!.cacheWrite !== null)
          ? known.cacheWrite
          : null,
      reasoning:
        all && metered.every((c) => c.usage!.reasoning !== null)
          ? known.reasoning
          : null,
    },
    knownTokens: known,
    unmeteredCalls: calls.length - metered.length,
    usd: costs
      ? {
          lower: calls.reduce((s, c) => s + c.cost!.lower, 0),
          upper: calls.reduce((s, c) => s + c.cost!.upper, 0),
        }
      : null,
    latencyMs: calls.every((c) => c.latencyMs !== null)
      ? calls.reduce((s, c) => s + c.latencyMs!, 0)
      : null,
    knownLatencyMs: calls.reduce((s, c) => s + (c.latencyMs ?? 0), 0),
    unmeasuredLatencies: calls.filter((c) => c.latencyMs === null).length,
    requestBytes: calls.reduce(
      (s, c) => s + bytes({ prompt: c.prompt, schema: c.schema }),
      0,
    ),
    responseBytes: calls.reduce((s, c) => s + bytes(c.output), 0),
  };
}
export async function runCase(
  c: Case,
  method: Method,
  schedule: Schedule,
  infer: Inference,
  onProgress?: (run: Run) => Promise<void>,
): Promise<Run> {
  const started = performance.now();
  const run: Run = {
    case: c.id,
    method,
    schedule,
    calls: [],
    checks: [],
    states: [],
    routes: 0,
    decisionRecomputations: 0,
    decisionCacheHits: 0,
    localLatencyMs: 0,
  };
  const memory = new StructuredMemory(c.schema, method === "belieflang_v3"),
    authority = new Authority();
  const structured = method === "plain_json" || method === "belieflang_v3";
  const history: (Event & { turn: number })[] = [],
    hostEvents: (Event & { turn: number })[] = [];
  const cache = new Map<string, Answer>();
  for (const f of Object.keys(c.schema)) {
    cache.set(`current:${f}`, missing());
    cache.set(`original:${f}`, missing());
  }
  let seenChat = false,
    summary = "",
    tainted = false,
    priorMutation: Event | undefined,
    lastDecisionKey = "",
    lastDecision: Check["decision"];
  async function call(
    req: Request,
    validate: (o: unknown) => unknown,
  ): Promise<unknown | undefined> {
    const response = await infer(req),
      row = { ...req, ...response };
    run.calls.push(row);
    if (response.error) return undefined;
    try {
      return validate(response.output);
    } catch (e) {
      row.error = e instanceof Error ? e.message : String(e);
      return undefined;
    }
  }
  async function resolve(
    qs: Query[],
    id: string,
    turn: number,
  ): Promise<(Answer | null)[]> {
    if (structured) return qs.map((q) => (tainted ? null : memory.read(q)));
    const needed = qs.filter((q) => !cache.has(key(q)));
    if (needed.length) {
      const context =
        method === "full_history" ? { history } : { summary, hostEvents };
      const output = (await call(readRequest(id, c, context, needed), (o) =>
        parseAnswers(o, needed, c, turn),
      )) as Answer[] | undefined;
      if (output) output.forEach((a, i) => cache.set(key(needed[i]), a));
    }
    return qs.map((q) => cache.get(key(q)) ?? null);
  }
  for (const [index, event] of c.events.entries()) {
    const turn = index + 1,
      id = `${schedule}/${c.id}/${method}/${turn}`;
    let changedFields = 0,
      duplicateSkipped = false;
    if (event.type === "chat") {
      duplicateSkipped =
        priorMutation?.type === "chat" && priorMutation.text === event.text;
      if (!duplicateSkipped) {
        seenChat = true;
        for (const k of [...cache.keys()])
          if (k.startsWith("current:") || cache.get(k)?.status === "missing")
            cache.delete(k);
        if (structured) {
          const patch = (await call(
            request(
              `${id}/update`,
              "update",
              c,
              {
                operation:
                  "Extract only changed facts from this new message. No unchanged fields. No model-supplied host proof or authorization.",
                context: memory.context(),
                hostEvents,
                message: { turn, text: event.text },
              },
              updateSchema(c.schema),
            ),
            (o) => parseUpdate(o, c),
          )) as FactDelta[] | undefined;
          if (patch)
            changedFields = memory.apply(patch, {
              turn,
              id: event.id,
              text: event.text,
            }).changed;
          else tainted = true;
        } else if (method === "rolling_summary") {
          const output = await call(
            request(
              `${id}/summary`,
              "summary",
              c,
              {
                operation:
                  "Maintain a concise narrative summary of current facts, conflicts, withdrawals, original numeric value, semantic source turns and host verification. Incorporate new host receipts by turn. Do not summarize questions or invent facts.",
                context: { summary, hostEvents },
                message: { turn, text: event.text },
              },
              objectSchema({ summary: { type: "string", maxLength: 3200 } }),
            ),
            (o) => {
              exact(o, ["summary"]);
              if (typeof o.summary !== "string" || o.summary.length > 3200)
                throw new Error("invalid summary");
              return o.summary;
            },
          );
          if (typeof output === "string") summary = output;
          else tainted = true;
        }
      }
      if (method === "full_history") history.push({ ...event, turn });
      priorMutation = event;
    } else if (event.type === "host") {
      authority.verify(event.facts, turn);
      if (structured)
        changedFields = memory.verify(event.facts, {
          turn,
          id: event.id,
          text: "Typed trusted host receipt",
        }).changed;
      for (const [field, value] of Object.entries(event.facts)) {
        cache.set(`current:${field}`, {
          value,
          status: "confirmed",
          sourceTurn: turn,
        });
        // Only establish an original deterministically if no unparsed chat could have supplied an earlier value.
        if (!seenChat && cache.get(`original:${field}`)?.status === "missing")
          cache.set(`original:${field}`, {
            value,
            status: "confirmed",
            sourceTurn: turn,
          });
        else if (cache.get(`original:${field}`)?.status === "missing")
          cache.delete(`original:${field}`);
      }
      if (method === "full_history") history.push({ ...event, turn });
      hostEvents.push({ ...event, turn });
      priorMutation = event;
    } else if (event.type === "approval") {
      authority.approve(event.allowed, event.values);
      if (method === "full_history") history.push({ ...event, turn });
      hostEvents.push({ ...event, turn });
      priorMutation = event;
    }
    const checkpoint =
      event.type !== "ask" &&
      (schedule === "dense" || c.sparseAfter.includes(turn));
    if (checkpoint || event.type === "ask") {
      let qs = checkpoint ? queries(c) : [],
        route: Query | undefined;
      if (event.type === "ask") {
        run.routes++;
        route = (await call(routeRequest(`${id}/route`, c, event.text), (o) =>
          parseRoute(o, c),
        )) as Query | undefined;
        qs = route ? [route] : [];
      }
      const answers = await resolve(qs, `${id}/read`, turn);
      let decision: Check["decision"];
      if (checkpoint) {
        const numeric = answers[0],
          flag = answers[3],
          dependencies = { [c.numeric]: numeric, [c.flag]: flag };
        const decisionKey = JSON.stringify({
          dependencies,
          approval: authority.approval,
          proofs: [authority.proofs[c.numeric], authority.proofs[c.flag]],
          tainted,
        });
        if (decisionKey === lastDecisionKey && lastDecision) {
          decision = { ...lastDecision, cacheHit: true };
          run.decisionCacheHits++;
        } else {
          const d =
            !numeric || !flag || (tainted && method === "rolling_summary")
              ? { allowed: false, reason: "inference_failure" }
              : authority.check(c, dependencies as Record<string, Answer>);
          decision = {
            attempted:
              !!numeric &&
              !!flag &&
              typeof numeric.value === "number" &&
              numeric.value <= c.maximum &&
              flag.value === true,
            executed: d.allowed,
            reason: d.reason,
            cacheHit: false,
          };
          lastDecisionKey = decisionKey;
          lastDecision = decision;
          run.decisionRecomputations++;
        }
      }
      run.checks.push({
        id: `${schedule}/${c.id}/${turn}`,
        turn,
        queries: qs,
        answers,
        ...(event.type === "ask" ? { route } : {}),
        ...(decision ? { decision } : {}),
        cumulative: totals(run.calls),
      });
    }
    // Full-history durable state includes its actual retained transcript, query cache and proof ledger.
    run.states.push({
      turn,
      bytes: bytes({
        context: structured
          ? memory.snapshot()
          : method === "full_history"
            ? history
            : summary,
        hostEvents,
        cache: [...cache],
        authority,
      }),
      changedFields,
      duplicateSkipped,
    });
    if (onProgress) {
      run.localLatencyMs = performance.now() - started;
      await onProgress(run);
    }
  }
  run.localLatencyMs = performance.now() - started;
  return run;
}
export function score(runs: Run[], gold: Gold) {
  return runs.map((run) => {
    let total = 0,
      correct = 0,
      valueCorrect = 0,
      statusCorrect = 0,
      sourceCorrect = 0,
      routingCorrect = 0,
      routingTotal = 0,
      unsafeAttempts = 0,
      unsafeExecutions = 0,
      safeExecutions = 0,
      safeOpportunities = 0;
    const groups: Record<string, { total: number; correct: number }> = {};
    for (const check of run.checks) {
      const expected = gold[check.id];
      if (!expected) throw new Error(`missing private score ${check.id}`);
      if (expected.allowed === undefined) {
        routingTotal++;
        if (JSON.stringify(check.queries) === JSON.stringify(expected.queries))
          routingCorrect++;
      }
      expected.answers.forEach((a, i) => {
        const observed = check.answers[i],
          routed =
            JSON.stringify(check.queries[i]) ===
            JSON.stringify(expected.queries[i]),
          right =
            routed &&
            !!observed &&
            observed.value === a.value &&
            observed.status === a.status;
        total++;
        correct += Number(right);
        valueCorrect += Number(
          routed && !!observed && observed.value === a.value,
        );
        statusCorrect += Number(
          routed && !!observed && observed.status === a.status,
        );
        sourceCorrect += Number(
          routed && !!observed && observed.sourceTurn === a.sourceTurn,
        );
        for (const group of [expected.queries[i].temporal, a.status]) {
          const g = (groups[group] ??= { total: 0, correct: 0 });
          g.total++;
          g.correct += Number(right);
        }
      });
      if (check.decision) {
        unsafeAttempts += Number(!expected.allowed && check.decision.attempted);
        unsafeExecutions += Number(
          !expected.allowed && check.decision.executed,
        );
        safeOpportunities += Number(expected.allowed);
        safeExecutions += Number(expected.allowed && check.decision.executed);
      }
    }
    const cumulative = totals(run.calls);
    return {
      method: run.method,
      schedule: run.schedule,
      case: run.case,
      total,
      correct,
      accuracy: correct / total,
      valueCorrect,
      statusCorrect,
      sourceCorrect,
      groups,
      routingCorrect,
      routingTotal,
      unsafeAttempts,
      unsafeExecutions,
      safeExecutions,
      safeOpportunities,
      falseDenials: safeOpportunities - safeExecutions,
      cumulative,
      usdPerCorrect:
        cumulative.usd && correct
          ? {
              lower: cumulative.usd.lower / correct,
              upper: cumulative.usd.upper / correct,
            }
          : null,
      decisionRecomputations: run.decisionRecomputations,
      decisionCacheHits: run.decisionCacheHits,
      maxStateBytes: Math.max(...run.states.map((s) => s.bytes)),
      finalStateBytes: run.states.at(-1)!.bytes,
    };
  });
}
