// Offline research audit. Never reads credentials or creates an inference transport.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const artifactRoot = path.join(
  repo,
  "benchmarks/results/incremental-pilot-2026-10-18",
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (p) => JSON.parse(fs.readFileSync(path.join(repo, p), "utf8"));
const bytes = (x) => Buffer.byteLength(JSON.stringify(x) ?? "");
const copy = (x) => structuredClone(x);
const METHODS = [
  "full_history",
  "rolling_summary",
  "plain_json",
  "belieflang_v3",
];
const SCHEDULES = ["sparse", "dense"];
const turnOf = (call) => Number((call.id ?? call.request.id).split("/")[3]);
const runKey = (r) => `${r.schedule}/${r.case}/${r.method}`;
const close = (a, b, message) => {
  if (typeof a === "number" && typeof b === "number") {
    assert.ok(
      Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b)),
      `${message}: ${a} != ${b}`,
    );
  } else if (a && b && typeof a === "object" && typeof b === "object") {
    assert.deepEqual(
      Object.keys(a).sort(),
      Object.keys(b).sort(),
      `${message} keys`,
    );
    for (const k of Object.keys(a)) close(a[k], b[k], `${message}.${k}`);
  } else assert.deepEqual(a, b, message);
};

// Only account-specific response IDs are replaced. Model outputs, evidence, usage,
// failures, timings, ordering, and request-body hashes remain unaltered.
function sanitize(value, ids) {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, ids));
  if (!value || typeof value !== "object") return value;
  if (typeof value.responseId === "string")
    assert.ok(ids.has(value.responseId), "unknown response ID");
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      k === "responseId" && typeof v === "string"
        ? ids.get(v)
        : sanitize(v, ids),
    ]),
  );
}

export function archive(rawDir) {
  const names = ["journal.json", "report.json", "smoke.json"];
  const raw = Object.fromEntries(
    names.map((n) => [n, fs.readFileSync(path.join(rawDir, n))]),
  );
  const originalJournal = JSON.parse(raw["journal.json"]);
  const ids = new Map(
    originalJournal.entries.map((e, i) => [
      e.result.metadata.responseId,
      `response-${String(i + 1).padStart(3, "0")}`,
    ]),
  );
  assert.equal(ids.size, 298);
  fs.mkdirSync(artifactRoot, { recursive: true });
  const files = {};
  for (const name of names) {
    const publicName = name === "smoke.json" ? name : `${name}.gz`;
    const content = Buffer.from(
      JSON.stringify(sanitize(JSON.parse(raw[name]), ids), null, 2) + "\n",
    );
    const stored = publicName.endsWith(".gz")
      ? gzipSync(content, { level: 9, mtime: 0 })
      : content;
    fs.writeFileSync(path.join(artifactRoot, publicName), stored);
    files[publicName] = {
      originalSHA256: sha(raw[name]),
      sanitizedSHA256: sha(content),
      storedSHA256: sha(stored),
      originalBytes: raw[name].length,
      sanitizedBytes: content.length,
      storedBytes: stored.length,
    };
  }
  const freeze = json("benchmarks/incremental/freeze.json");
  fs.writeFileSync(
    path.join(artifactRoot, "manifest.json"),
    JSON.stringify(
      {
        version: 1,
        sourceCommit: "82c51c751766ebded4415f1c3712b5123b433c96",
        freezeFingerprint: sha(JSON.stringify(freeze)),
        sanitization:
          "Replace only metadata.responseId with stable response-NNN aliases in journal, report and smoke. No other values changed. Original files remain local and unmodified; original SHA-256 values identify them but are not an independent attestation of provider execution.",
        preservationLimit:
          "The frozen transport retained parsed structured outputs, provider usage and selected metadata, not complete HTTP response envelopes or wall-clock request timestamps.",
        files,
      },
      null,
      2,
    ) + "\n",
  );
}

export function readRecords() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, "manifest.json")),
  );
  const values = {};
  for (const [name, record] of Object.entries(manifest.files)) {
    const stored = fs.readFileSync(path.join(artifactRoot, name));
    const content = name.endsWith(".gz") ? gunzipSync(stored) : stored;
    assert.equal(sha(stored), record.storedSHA256, `archive hash ${name}`);
    assert.equal(sha(content), record.sanitizedSHA256, `content hash ${name}`);
    assert.equal(stored.length, record.storedBytes);
    assert.equal(content.length, record.sanitizedBytes);
    // No local paths, account IDs, key material or request headers belong here.
    assert.ok(
      !/sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9_-]+|\/Users\/|-----BEGIN [A-Z ]*PRIVATE KEY|"(?:api[_-]?key|headers)"\s*:/i.test(
        content,
      ),
      `sensitive content ${name}`,
    );
    assert.ok(
      !/resp_[a-zA-Z0-9]+/.test(content),
      `unredacted response ID ${name}`,
    );
    values[name.replace(".gz", "").replace(".json", "")] = JSON.parse(content);
  }
  return {
    ...values,
    manifest,
    cases: json("benchmarks/incremental/cases.json").cases,
    gold: json("benchmarks/incremental/private-gold.json"),
    config: json("benchmarks/incremental/config.json"),
    plan: json("benchmarks/incremental/plan.json"),
    offline: json("benchmarks/incremental/offline.json"),
    freeze: json("benchmarks/incremental/freeze.json"),
  };
}

// Reimplemented billing from raw providerUsage, not result.usage/cost or runner totals.
function meter(entry, config) {
  const u = entry.providerUsage;
  assert.ok(u, `missing provider usage ${entry.request.id}`);
  const usage = {
    input: u.input_tokens,
    output: u.output_tokens,
    cached: u.input_tokens_details.cached_tokens,
    cacheWrite: u.input_tokens_details.cache_write_tokens,
    reasoning: u.output_tokens_details.reasoning_tokens,
  };
  for (const n of Object.values(usage))
    assert.ok(Number.isSafeInteger(n) && n >= 0);
  assert.equal(u.total_tokens, usage.input + usage.output);
  assert.ok(usage.cached + usage.cacheWrite <= usage.input);
  assert.ok(usage.reasoning <= usage.output);
  const p = config.pricing,
    rates = p.standardPerMillion;
  const input =
    (usage.input - usage.cached - usage.cacheWrite) * rates.input +
    usage.cached * rates.cached +
    usage.cacheWrite * rates.cacheWrite;
  const long = usage.input > p.longContextThreshold;
  const usd =
    ((input * (long ? p.longInputMultiplier : 1) +
      usage.output * rates.output * (long ? p.longOutputMultiplier : 1)) *
      p.premiumMultiplier) /
    1e6;
  close(entry.result.usage, usage, `provider usage ${entry.request.id}`);
  close(
    entry.result.cost,
    { lower: usd, upper: usd },
    `provider cost ${entry.request.id}`,
  );
  assert.ok(
    Number.isFinite(entry.result.latencyMs) && entry.result.latencyMs >= 0,
  );
  return { usage, cost: { lower: usd, upper: usd } };
}

// Small JSON-schema subset used by the frozen protocol, deliberately independent
// of production parseAnswers/parseUpdate and of the saved success/failure labels.
function schemaOK(v, s) {
  if (s.anyOf) return s.anyOf.some((x) => schemaOK(v, x));
  if (s.enum && !s.enum.some((x) => x === v)) return false;
  if (s.type === "null") return v === null;
  if (s.type === "integer") return Number.isSafeInteger(v);
  if (s.type === "number")
    return (
      typeof v === "number" &&
      Number.isFinite(v) &&
      (s.minimum === undefined || v >= s.minimum) &&
      (s.maximum === undefined || v <= s.maximum)
    );
  if (s.type === "string")
    return (
      typeof v === "string" &&
      (s.maxLength === undefined || v.length <= s.maxLength)
    );
  if (s.type === "boolean") return typeof v === "boolean";
  if (s.type === "array")
    return (
      Array.isArray(v) &&
      (s.minItems === undefined || v.length >= s.minItems) &&
      (s.maxItems === undefined || v.length <= s.maxItems) &&
      v.every((x) => schemaOK(x, s.items))
    );
  if (s.type === "object")
    return (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      (s.required ?? []).every((k) => Object.hasOwn(v, k)) &&
      (s.additionalProperties !== false ||
        Object.keys(v).every((k) => Object.hasOwn(s.properties, k))) &&
      Object.entries(v).every(
        ([k, x]) => !s.properties[k] || schemaOK(x, s.properties[k]),
      )
    );
  throw new Error(`unhandled schema ${JSON.stringify(s)}`);
}

function semanticError(call, c) {
  assert.ok(schemaOK(call.output, call.schema), `schema compliance ${call.id}`);
  if (call.kind !== "read") return undefined;
  const qs = JSON.parse(call.prompt).queries;
  for (const [i, a] of call.output.answers.entries()) {
    if (a.status === "missing") {
      if (a.value !== null || a.sourceTurn !== null)
        return "invalid missing answer";
    } else {
      if (
        !Number.isSafeInteger(a.sourceTurn) ||
        a.sourceTurn < 1 ||
        a.sourceTurn > turnOf(call)
      )
        return "invalid source";
      if (["cleared", "conflicting"].includes(a.status)) {
        if (a.value !== null) return "invalid empty value";
      } else {
        const field = qs[i].field,
          declared = c.schema[field];
        const type = typeof declared === "string" ? declared : declared.type;
        if (
          typeof a.value !== type ||
          (type === "number" && !Number.isFinite(a.value)) ||
          (declared.enum && !declared.enum.includes(a.value))
        )
          return `invalid value for ${field}`;
      }
    }
  }
  return undefined;
}

function totals(calls) {
  const known = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
  for (const c of calls)
    for (const k of Object.keys(known)) known[k] += c.usage[k];
  const usd = calls.reduce((s, c) => s + c.cost.upper, 0);
  const latencyMs = calls.reduce((s, c) => s + c.latencyMs, 0);
  return {
    calls: calls.length,
    failedCalls: calls.filter((c) => c.error).length,
    byKind: Object.fromEntries(
      ["route", "update", "summary", "read"].map((k) => [
        k,
        calls.filter((c) => c.kind === k).length,
      ]),
    ),
    measuredTokens: { ...known },
    knownTokens: known,
    unmeteredCalls: 0,
    usd: { lower: usd, upper: usd },
    latencyMs,
    knownLatencyMs: latencyMs,
    unmeasuredLatencies: 0,
    requestBytes: calls.reduce(
      (s, c) => s + bytes({ prompt: c.prompt, schema: c.schema }),
      0,
    ),
    responseBytes: calls.reduce((s, c) => s + bytes(c.output), 0),
  };
}

// Reconstruct the host proof/approval ledger independently from typed case events.
function decisionAt(c, turn, answers) {
  const proofs = {};
  let approval;
  for (const [i, event] of c.events.slice(0, turn).entries()) {
    if (event.type === "host")
      for (const [f, value] of Object.entries(event.facts))
        proofs[f] = { value, turn: i + 1 };
    if (event.type === "approval")
      approval = {
        allowed: event.allowed,
        scope: Object.fromEntries(
          Object.entries(event.values).map(([f, value]) => [
            f,
            {
              value,
              proofTurn: proofs[f]?.value === value ? proofs[f].turn : null,
            },
          ]),
        ),
      };
  }
  const dep = { [c.numeric]: answers[0], [c.flag]: answers[3] };
  const attempted =
    !!answers[0] &&
    !!answers[3] &&
    typeof answers[0].value === "number" &&
    answers[0].value <= c.maximum &&
    answers[3].value === true;
  let reason = "scoped_verified_policy",
    executed = true;
  if (!answers[0] || !answers[3]) {
    executed = false;
    reason = "inference_failure";
  } else if (!approval?.allowed) {
    executed = false;
    reason = "approval_missing_or_revoked";
  } else {
    for (const f of [c.numeric, c.flag]) {
      const a = dep[f],
        p = proofs[f],
        s = approval.scope[f];
      if (
        a.status !== "confirmed" ||
        a.sourceTurn === null ||
        !p ||
        p.value !== a.value ||
        p.turn < a.sourceTurn
      ) {
        executed = false;
        reason = `unverified_revision:${f}`;
        break;
      }
      if (!s || s.value !== a.value || s.proofTurn !== p.turn) {
        executed = false;
        reason = `stale_approval:${f}`;
        break;
      }
    }
    if (
      executed &&
      !(Number(answers[0].value) <= c.maximum && answers[3].value === true)
    ) {
      executed = false;
      reason = "business_constraint";
    }
  }
  return {
    attempted,
    executed,
    reason,
    key: JSON.stringify({
      dependencies: dep,
      approval,
      proofs: [proofs[c.numeric], proofs[c.flag]],
      tainted: false,
    }),
  };
}

export function auditRecords(data) {
  const { report, journal, smoke, cases, gold, config, freeze, manifest } =
    data;
  const fingerprint = sha(JSON.stringify(freeze));
  assert.equal(fingerprint, manifest.freezeFingerprint);
  assert.equal(report.fingerprint, fingerprint);
  assert.equal(smoke.fingerprint, fingerprint);
  close(report.config, config, "frozen config");
  assert.equal(report.status, "complete");
  assert.equal(journal.maximumUSD, 2);
  assert.equal(
    journal.fingerprint,
    sha(JSON.stringify({ freeze: fingerprint, config, maximumUSD: 2 })),
  );
  assert.equal(journal.entries.length, 298);
  assert.equal(new Set(journal.entries.map((e) => e.request.id)).size, 298);
  assert.equal(
    new Set(journal.entries.map((e) => e.result.metadata.responseId)).size,
    298,
  );
  assert.equal(journal.entries[0].stage, "smoke");
  assert.ok(journal.entries.slice(1).every((e) => e.stage === "pilot"));
  close(report.allAttempts, journal.entries, "journal vs report attempts");
  const entries = new Map(),
    stages = { smoke: [], pilot: [] };
  const committed = { smoke: 0, pilot: 0 };
  for (const e of journal.entries) {
    assert.equal(e.state, "complete");
    assert.ok(!e.result.error);
    assert.equal(e.result.metadata.model, "gpt-6-luna");
    assert.equal(e.result.metadata.tier, "default");
    const body = {
      model: config.model,
      service_tier: "default",
      reasoning: { effort: "none" },
      store: false,
      max_output_tokens:
        e.stage === "smoke"
          ? config.smokeMaxOutputTokens
          : config.maxOutputTokens,
      input: e.request.prompt,
      text: {
        format: {
          type: "json_schema",
          name: "incremental_pilot",
          strict: true,
          schema: e.request.schema,
        },
      },
    };
    assert.equal(
      e.bodyHash,
      sha(JSON.stringify(body)),
      `body hash ${e.request.id}`,
    );
    const metered = meter(e, config);
    const prices = config.pricing;
    const longReservation =
      config.inputTokenCeiling > prices.longContextThreshold;
    const highestInputRate = Math.max(
      prices.standardPerMillion.input,
      prices.standardPerMillion.cached,
      prices.standardPerMillion.cacheWrite,
    );
    const reserved =
      ((config.inputTokenCeiling *
        highestInputRate *
        (longReservation ? prices.longInputMultiplier : 1) +
        body.max_output_tokens *
          prices.standardPerMillion.output *
          (longReservation ? prices.longOutputMultiplier : 1)) *
        prices.premiumMultiplier) /
      1e6;
    close(e.reserved, reserved, `reservation ${e.request.id}`);
    assert.ok(
      committed[e.stage] + e.reserved <=
        (e.stage === "smoke" ? config.smokeCapUSD : config.pilotCapUSD),
    );
    assert.ok(
      committed.smoke + committed.pilot + e.reserved <= journal.maximumUSD,
    );
    committed[e.stage] += metered.cost.upper;
    const call = { ...copy(e.request), ...copy(e.result), ...metered };
    entries.set(e.request.id, call);
    stages[e.stage].push(call);
  }
  assert.equal(stages.smoke.length, 1);
  assert.equal(stages.pilot.length, 297);
  const s = stages.smoke[0];
  assert.equal(s.id, "compatibility/smoke");
  assert.ok(schemaOK(s.output, s.schema));
  assert.deepEqual(s.output.deltas, [
    {
      field: "weight_kg",
      confidence: 1,
      basis: "explicit",
      op: "set",
      value: 10,
    },
  ]);
  close(
    smoke.report,
    {
      status: "passed",
      usage: s.usage,
      usd: s.cost,
      metadata: s.metadata,
      replayed: false,
    },
    "smoke",
  );
  const smokeUSD = s.cost.upper,
    pilotUSD = totals(stages.pilot).usd.upper;
  close(
    smoke.accounting,
    {
      maximumUSD: 2,
      committedUpperUSD: smokeUSD,
      smokeUpperUSD: smokeUSD,
      pilotUpperUSD: 0,
      unmeteredCalls: 0,
    },
    "smoke accounting",
  );
  close(
    report.accounting,
    {
      maximumUSD: 2,
      committedUpperUSD: smokeUSD + pilotUSD,
      smokeUpperUSD: smokeUSD,
      pilotUpperUSD: pilotUSD,
      unmeteredCalls: 0,
    },
    "combined accounting",
  );
  assert.ok(smokeUSD <= 0.3 && pilotUSD <= 1.7 && smokeUSD + pilotUSD <= 2);
  close(report.allPilotAttemptTotals, totals(stages.pilot), "transport totals");
  assert.equal(report.runs.length, 24);
  assert.equal(new Set(report.runs.map(runKey)).size, 24);
  const scored = [],
    failures = [],
    denials = [],
    answerErrors = [],
    curves = [];
  const seenCalls = new Set();
  for (const run of report.runs) {
    assert.ok(METHODS.includes(run.method) && SCHEDULES.includes(run.schedule));
    const c = cases.find((c) => c.id === run.case);
    assert.ok(c);
    assert.deepEqual(
      run.states.map((s) => s.turn),
      Array.from({ length: 24 }, (_, i) => i + 1),
    );
    const expectedIDs = Object.keys(gold).filter((k) =>
      k.startsWith(`${run.schedule}/${run.case}/`),
    );
    assert.deepEqual(run.checks.map((ch) => ch.id).sort(), expectedIDs.sort());
    const calls = run.calls.map((call) => {
      assert.ok(!seenCalls.has(call.id));
      seenCalls.add(call.id);
      const entry = entries.get(call.id);
      assert.ok(entry, `unaccounted call ${call.id}`);
      const error = semanticError(entry, c);
      const rebuilt = { ...entry, ...(error ? { error } : {}) };
      close(call, rebuilt, `run vs journal ${call.id}`);
      if (error)
        failures.push({
          id: call.id,
          error,
          output: call.output,
          usage: entry.usage,
          cost: entry.cost,
        });
      return rebuilt;
    });
    let previousKey,
      recomputations = 0,
      hits = 0;
    const m = {
      method: run.method,
      schedule: run.schedule,
      case: run.case,
      total: 0,
      correct: 0,
      accuracy: 0,
      valueCorrect: 0,
      statusCorrect: 0,
      sourceCorrect: 0,
      groups: {},
      routingCorrect: 0,
      routingTotal: 0,
      unsafeAttempts: 0,
      unsafeExecutions: 0,
      safeExecutions: 0,
      safeOpportunities: 0,
      falseDenials: 0,
    };
    for (const ch of run.checks) {
      const expected = gold[ch.id];
      assert.equal(ch.turn, Number(ch.id.split("/")[2]));
      close(
        ch.cumulative,
        totals(calls.filter((call) => turnOf(call) <= ch.turn)),
        `checkpoint ${runKey(run)}/${ch.turn}`,
      );
      if (expected.allowed === undefined) {
        m.routingTotal++;
        m.routingCorrect += Number(
          JSON.stringify(ch.queries) === JSON.stringify(expected.queries),
        );
      }
      for (const [i, want] of expected.answers.entries()) {
        const got = ch.answers[i],
          queryOK =
            JSON.stringify(ch.queries[i]) ===
            JSON.stringify(expected.queries[i]);
        const right =
          queryOK &&
          !!got &&
          got.value === want.value &&
          got.status === want.status;
        m.total++;
        m.correct += Number(right);
        m.valueCorrect += Number(queryOK && !!got && got.value === want.value);
        m.statusCorrect += Number(
          queryOK && !!got && got.status === want.status,
        );
        m.sourceCorrect += Number(
          queryOK && !!got && got.sourceTurn === want.sourceTurn,
        );
        for (const k of [expected.queries[i].temporal, want.status]) {
          m.groups[k] ??= { total: 0, correct: 0 };
          m.groups[k].total++;
          m.groups[k].correct += Number(right);
        }
        if (!right || got?.sourceTurn !== want.sourceTurn)
          answerErrors.push({
            run: runKey(run),
            turn: ch.turn,
            query: expected.queries[i],
            expected: want,
            observed: got ?? null,
            jointCorrect: !!right,
          });
      }
      if (ch.decision) {
        const d = decisionAt(c, ch.turn, ch.answers);
        close(
          {
            attempted: ch.decision.attempted,
            executed: ch.decision.executed,
            reason: ch.decision.reason,
          },
          { attempted: d.attempted, executed: d.executed, reason: d.reason },
          `independent safety ${runKey(run)}/${ch.turn}`,
        );
        assert.equal(ch.decision.cacheHit, d.key === previousKey);
        if (ch.decision.cacheHit) hits++;
        else recomputations++;
        previousKey = d.key;
        m.unsafeAttempts += Number(!expected.allowed && d.attempted);
        m.unsafeExecutions += Number(!expected.allowed && d.executed);
        m.safeOpportunities += Number(expected.allowed);
        m.safeExecutions += Number(expected.allowed && d.executed);
        if (expected.allowed && !d.executed)
          denials.push({
            run: runKey(run),
            turn: ch.turn,
            reason: d.reason,
            answers: ch.answers,
            expected: expected.answers,
            sourceOnly: ch.answers.every(
              (a, i) =>
                a &&
                a.value === expected.answers[i].value &&
                a.status === expected.answers[i].status,
            ),
          });
      }
    }
    assert.ok(
      Number.isFinite(run.localLatencyMs) &&
        run.localLatencyMs >= totals(calls).latencyMs,
      "recorded local elapsed time",
    );
    m.accuracy = m.correct / m.total;
    m.falseDenials = m.safeOpportunities - m.safeExecutions;
    m.cumulative = totals(calls);
    m.usdPerCorrect = {
      lower: m.cumulative.usd.lower / m.correct,
      upper: m.cumulative.usd.upper / m.correct,
    };
    m.decisionRecomputations = recomputations;
    m.decisionCacheHits = hits;
    m.maxStateBytes = Math.max(...run.states.map((x) => x.bytes));
    m.finalStateBytes = run.states.at(-1).bytes;
    close(
      run.decisionRecomputations,
      recomputations,
      "decision recomputations",
    );
    close(run.decisionCacheHits, hits, "decision cache hits");
    close(
      m,
      report.summary.find((s) => runKey(s) === runKey(run)),
      `independent score ${runKey(run)}`,
    );
    scored.push(m);
    for (let turn = 1; turn <= 24; turn++) {
      const t = totals(calls.filter((call) => turnOf(call) <= turn));
      curves.push({
        case: run.case,
        method: run.method,
        schedule: run.schedule,
        turn,
        calls: t.calls,
        input: t.measuredTokens.input,
        output: t.measuredTokens.output,
        costUSD: t.usd.upper,
        latencyMs: t.latencyMs,
      });
    }
  }
  assert.equal(seenCalls.size, 297);
  for (const call of stages.pilot) assert.ok(seenCalls.has(call.id));
  assert.equal(failures.length, 14);
  const coverage = {
    plannedChecks: Object.keys(gold).length * 4,
    observedChecks: report.runs.reduce((s, r) => s + r.checks.length, 0),
    plannedAnswers:
      Object.values(gold).reduce((s, g) => s + g.answers.length, 0) * 4,
    observedAnswers: scored.reduce((s, x) => s + x.total, 0),
  };
  close(report.coverage, coverage, "coverage");
  assert.equal(coverage.observedChecks, coverage.plannedChecks);
  assert.equal(coverage.observedAnswers, coverage.plannedAnswers);
  const equivalence = [];
  for (const schedule of SCHEDULES)
    for (const c of cases) {
      const a = report.runs.find(
        (r) =>
          r.schedule === schedule &&
          r.case === c.id &&
          r.method === "plain_json",
      );
      const b = report.runs.find(
        (r) =>
          r.schedule === schedule &&
          r.case === c.id &&
          r.method === "belieflang_v3",
      );
      assert.equal(a.calls.length, b.calls.length);
      for (let i = 0; i < a.calls.length; i++) {
        const x = a.calls[i],
          y = b.calls[i];
        assert.equal(turnOf(x), turnOf(y));
        assert.equal(x.kind, y.kind);
        assert.equal(x.prompt, y.prompt, "structured prompt equivalence");
        assert.deepEqual(x.schema, y.schema);
        const ea = journal.entries.find((e) => e.request.id === x.id),
          eb = journal.entries.find((e) => e.request.id === y.id);
        assert.equal(ea.bodyHash, eb.bodyHash);
        const p = JSON.parse(x.prompt),
          turn = turnOf(x);
        if (x.kind === "update") {
          assert.deepEqual(
            p.hostEvents,
            c.events
              .slice(0, turn)
              .flatMap((e, j) =>
                ["host", "approval"].includes(e.type)
                  ? [{ ...e, turn: j + 1 }]
                  : [],
              ),
          );
          assert.deepEqual(p.message, { turn, text: c.events[turn - 1].text });
        } else assert.equal(p.question, c.events[turn - 1].text);
        equivalence.push({
          schedule,
          case: c.id,
          turn,
          kind: x.kind,
          bodyHash: ea.bodyHash,
        });
      }
    }
  return {
    version: 1,
    freezeFingerprint: fingerprint,
    accounting: report.accounting,
    coverage,
    transportTotals: totals(stages.pilot),
    semanticFailures: failures,
    denials,
    answerErrors,
    scored,
    curves,
    structuredEquivalence: equivalence,
  };
}

// Frozen-code replay is a second consistency check, separate from independent
// scoring/billing above. It consumes ONLY saved outputs and the offline parser.
async function replay(data) {
  const { runCase } = await import("../dist/src/incremental/runner.js");
  const { scriptedInference } = await import(
    "../dist/src/incremental/offline.js"
  );
  const entries = new Map(data.journal.entries.map((e) => [e.request.id, e]));
  const differences = [];
  for (const run of data.report.runs) {
    const c = data.cases.find((x) => x.id === run.case),
      seen = [];
    const replayed = await runCase(c, run.method, run.schedule, async (req) => {
      const e = entries.get(req.id);
      assert.ok(e, "unrecorded replay request");
      assert.deepEqual(req, e.request);
      seen.push(req.id);
      return copy(e.result);
    });
    for (const k of [
      "calls",
      "checks",
      "states",
      "routes",
      "decisionRecomputations",
      "decisionCacheHits",
    ])
      close(replayed[k], run[k], `saved-response replay ${runKey(run)}.${k}`);
    assert.equal(seen.length, run.calls.length);
    const planned = await runCase(
      c,
      run.method,
      run.schedule,
      scriptedInference,
    );
    const liveIDs = new Set(run.calls.map((c) => c.id)),
      plannedIDs = new Set(planned.calls.map((c) => c.id));
    const added = run.calls.filter((c) => !plannedIDs.has(c.id));
    const removed = planned.calls.filter((c) => !liveIDs.has(c.id));
    differences.push({
      run: runKey(run),
      projected: planned.calls.length,
      actual: run.calls.length,
      extra: added.map((c) => ({
        id: c.id,
        queries: JSON.parse(c.prompt).queries,
        priorSemanticFailure: run.calls
          .filter((x) => x.error && turnOf(x) < turnOf(c))
          .at(-1)?.id,
      })),
      removed: removed.map((c) => c.id),
    });
    const frozen = data.offline.curves.find((x) => runKey(x) === runKey(run));
    close(
      frozen.points,
      planned.checks.map((c) => ({
        turn: c.turn,
        calls: c.cumulative.calls,
        requestBytes: c.cumulative.requestBytes,
      })),
      "projected trace matches freeze",
    );
  }
  assert.equal(
    differences.reduce((s, x) => s + x.projected, 0),
    data.plan.plannedCalls,
  );
  assert.equal(
    differences.reduce((s, x) => s + x.actual - x.projected, 0),
    13,
  );
  assert.ok(
    differences.every(
      (x) =>
        x.removed.length === 0 &&
        x.extra.every((e) => e.id.endsWith("/read") && e.priorSemanticFailure),
    ),
  );
  return differences;
}

function aggregate(scored, method, schedule) {
  const xs = scored.filter(
    (s) => s.method === method && (!schedule || s.schedule === schedule),
  );
  const sum = (f) => xs.reduce((s, x) => s + f(x), 0);
  const total = sum((x) => x.total),
    correct = sum((x) => x.correct);
  const historicalTotal = sum((x) => x.groups.original.total),
    historicalCorrect = sum((x) => x.groups.original.correct);
  return {
    method,
    ...(schedule ? { schedule } : {}),
    total,
    correct,
    accuracy: correct / total,
    historicalTotal,
    historicalCorrect,
    historicalRecall: historicalCorrect / historicalTotal,
    sourceCorrect: sum((x) => x.sourceCorrect),
    routingCorrect: sum((x) => x.routingCorrect),
    routingTotal: sum((x) => x.routingTotal),
    calls: sum((x) => x.cumulative.calls),
    semanticFailures: sum((x) => x.cumulative.failedCalls),
    input: sum((x) => x.cumulative.measuredTokens.input),
    output: sum((x) => x.cumulative.measuredTokens.output),
    cached: sum((x) => x.cumulative.measuredTokens.cached),
    cacheWrite: sum((x) => x.cumulative.measuredTokens.cacheWrite),
    reasoning: sum((x) => x.cumulative.measuredTokens.reasoning),
    usd: sum((x) => x.cumulative.usd.upper),
    latencyMs: sum((x) => x.cumulative.latencyMs),
    unsafeAttempts: sum((x) => x.unsafeAttempts),
    unsafeExecutions: sum((x) => x.unsafeExecutions),
    safeExecutions: sum((x) => x.safeExecutions),
    safeOpportunities: sum((x) => x.safeOpportunities),
    falseDenials: sum((x) => x.falseDenials),
    costPerCorrect: sum((x) => x.cumulative.usd.upper) / correct,
  };
}

function crossovers(curves, cases) {
  const groups = [];
  for (const schedule of SCHEDULES)
    for (const caseID of ["all", ...cases.map((c) => c.id)])
      for (const baseline of [
        "full_history",
        "rolling_summary",
        "plain_json",
      ]) {
        const points = Array.from({ length: 24 }, (_, i) => {
          const selected = curves.filter(
            (p) =>
              p.schedule === schedule &&
              p.turn === i + 1 &&
              (caseID === "all" || p.case === caseID),
          );
          const cost = (m) =>
            selected
              .filter((p) => p.method === m)
              .reduce((s, p) => s + p.costUSD, 0);
          return {
            turn: i + 1,
            belieflang: cost("belieflang_v3"),
            baseline: cost(baseline),
          };
        });
        const less = (p) => p.belieflang < p.baseline - 1e-12;
        const first = points.find(less)?.turn ?? null;
        const sustained =
          points.find((p, i) => less(p) && points.slice(i).every(less))?.turn ??
          null;
        groups.push({
          schedule,
          case: caseID,
          baseline,
          firstStrictlyCheaperTurn: first,
          sustainedStrictlyCheaperTurn: sustained,
          finalDifferenceUSD: points.at(-1).belieflang - points.at(-1).baseline,
        });
      }
  return groups;
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(
    args.length === 0 ||
      (args.length === 1 && args[0] === "--write") ||
      (args.length === 3 &&
        args[0] === "--archive-from" &&
        args[2] === "--write"),
    "usage: node scripts/audit-incremental-pilot.mjs [--write | --archive-from DIR --write]",
  );
  if (args[0] === "--archive-from") archive(path.resolve(args[1]));
  const data = readRecords();
  for (const [file, expected] of Object.entries(data.freeze.sha256))
    assert.equal(
      sha(fs.readFileSync(path.join(repo, file))),
      expected,
      `frozen file ${file}`,
    );
  const audit = auditRecords(data);
  audit.callProjection = await replay(data);
  audit.aggregate = METHODS.map((m) => aggregate(audit.scored, m));
  audit.bySchedule = SCHEDULES.flatMap((s) =>
    METHODS.map((m) => aggregate(audit.scored, m, s)),
  );
  audit.costCrossovers = crossovers(audit.curves, data.cases);
  const summaries = data.report.runs.flatMap((r) =>
    r.calls
      .filter((c) => c.kind === "summary")
      .map((c) => c.output.summary.length),
  );
  audit.diagnostics = {
    sourceOnlyFalseDenials: METHODS.map((method) => ({
      method,
      count: audit.denials.filter(
        (d) => d.run.endsWith("/" + method) && d.sourceOnly,
      ).length,
    })),
    summaryCharacters: {
      count: summaries.length,
      min: Math.min(...summaries),
      max: Math.max(...summaries),
      frozenLimit: 3200,
    },
    unchangedUpdateCalls: ["plain_json", "belieflang_v3"].map((method) => {
      const calls = data.report.runs
        .filter((r) => r.method === method)
        .flatMap((r) =>
          r.calls.filter(
            (c) => c.kind === "update" && c.output.deltas.length === 0,
          ),
        );
      return { method, ...totals(calls) };
    }),
    timing: {
      roundTripMs: audit.transportTotals.latencyMs,
      summedRecordedRunElapsedMs: data.report.runs.reduce(
        (s, r) => s + r.localLatencyMs,
        0,
      ),
      limitation:
        "Timings are recorded client elapsed measurements; sums can be audited, but request timestamps and an external timing source were not retained.",
    },
  };
  const auditText = JSON.stringify(audit, null, 2) + "\n";
  const csv =
    [
      "schedule,case,method,turn,calls,input,output,cumulative_usd,cumulative_latency_ms",
      ...audit.curves.map((p) =>
        [
          p.schedule,
          p.case,
          p.method,
          p.turn,
          p.calls,
          p.input,
          p.output,
          p.costUSD.toFixed(12),
          p.latencyMs.toFixed(6),
        ].join(","),
      ),
    ].join("\n") + "\n";
  if (args.includes("--write")) {
    fs.writeFileSync(path.join(artifactRoot, "audit.json"), auditText);
    fs.writeFileSync(path.join(artifactRoot, "cost-curves.csv"), csv);
  } else {
    assert.equal(
      fs.readFileSync(path.join(artifactRoot, "audit.json"), "utf8"),
      auditText,
      "derived audit changed",
    );
    assert.equal(
      fs.readFileSync(path.join(artifactRoot, "cost-curves.csv"), "utf8"),
      csv,
      "cost curves changed",
    );
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        offlineOnly: true,
        pilotCalls: audit.transportTotals.calls,
        smokeCalls: 1,
        semanticFailures: audit.semanticFailures.length,
        coverage: audit.coverage,
        combinedUSD: audit.accounting.committedUpperUSD,
        structuredPromptPairs: audit.structuredEquivalence.length,
        projectedCalls: data.plan.plannedCalls,
        additionalReads: 13,
      },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
