import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../src/incremental/fixtures.js";
import {
  BudgetStop,
  bodyFor,
  costBounds,
  createTransport,
  reserve,
  usageOf,
} from "../src/incremental/live.js";
import { smokeRequest, validateSmoke } from "../src/incremental/smoke.js";
import { hash } from "../src/v3_live.js";
const usage = {
  input_tokens: 200,
  output_tokens: 50,
  input_tokens_details: { cached_tokens: 60, cache_write_tokens: 40 },
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 250,
};
function response(output: unknown, extra: object = {}) {
  return new Response(
    JSON.stringify({
      id: "resp_mock",
      model: "gpt-6-luna",
      service_tier: "default",
      status: "completed",
      usage,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(output) }],
        },
      ],
      ...extra,
    }),
  );
}
const correct = (field: string) => ({
  deltas: [{ field, op: "set", value: 10, basis: "explicit", confidence: 1 }],
});
async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "belieflang-incremental-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { cases, config } = await load();
  return { dir, c: cases[0], config, journalPath: join(dir, "journal.json") };
}
test("real wire format, usage/cache math, metadata, output validation and free replay are exercised with HTTP mocks only", async (t) => {
  const { c, config, journalPath } = await setup(t);
  let calls = 0;
  const options = {
    authorized: true,
    apiKey: "test-only",
    config,
    fingerprint: "test-freeze",
    maximumUSD: 2,
    journalPath,
    fetchImpl: (async (_u, init) => {
      calls++;
      const b = JSON.parse(String(init?.body));
      assert.equal(b.model, "gpt-6-luna");
      assert.equal(b.service_tier, "default");
      assert.equal(b.store, false);
      assert.equal(b.text.format.strict, true);
      return response(correct(c.numeric));
    }) as typeof fetch,
  };
  let tr = await createTransport(options);
  const result = await tr.infer("smoke")(smokeRequest(c));
  const verified = validateSmoke(c, result);
  assert.equal(verified.status, "passed");
  assert.deepEqual(verified.usage, {
    input: 200,
    output: 50,
    cached: 60,
    cacheWrite: 40,
    reasoning: 0,
  });
  const expected =
    ((100 * 0.1 + 60 * 0.01 + 40 * 0.125 + 50 * 0.5) * 1.1) / 1e6;
  assert.ok(Math.abs(result.cost!.upper - expected) < 1e-12);
  assert.equal(
    tr.entries()[0].providerUsage &&
      JSON.stringify(tr.entries()[0].providerUsage),
    JSON.stringify(usage),
  );
  assert.equal(result.metadata?.tier, "default");
  await tr.close();
  tr = await createTransport(options);
  const replay = await tr.infer("smoke")(smokeRequest(c));
  assert.equal(replay.replayed, true);
  validateSmoke(c, replay);
  assert.equal(calls, 1);
  await tr.close();
  assert.ok(!(await readFile(journalPath, "utf8")).includes("test-only"));
});
test("authorization guard prevents network and file work", async (t) => {
  const s = await setup(t);
  let calls = 0;
  await assert.rejects(
    createTransport({
      authorized: false,
      apiKey: "test-only",
      config: s.config,
      fingerprint: "x",
      maximumUSD: 2,
      journalPath: s.journalPath,
      fetchImpl: (async () => {
        calls++;
        throw new Error("not reached");
      }) as typeof fetch,
    }),
    /authorization/,
  );
  assert.equal(calls, 0);
  await assert.rejects(readFile(s.journalPath));
});
test("missing cache details remain unknown, produce bounds, and block pilot compatibility", async (t) => {
  const { c, config, journalPath } = await setup(t);
  const tr = await createTransport({
    authorized: true,
    apiKey: "test-only",
    config,
    fingerprint: "x",
    maximumUSD: 2,
    journalPath,
    fetchImpl: (async () =>
      response(correct(c.numeric), {
        usage: { input_tokens: 200, output_tokens: 50 },
      })) as typeof fetch,
  });
  const r = await tr.infer("smoke")(smokeRequest(c));
  assert.equal(r.usage!.cached, null);
  assert.equal(r.usage!.cacheWrite, null);
  assert.ok(r.cost!.upper > r.cost!.lower);
  assert.throws(() => validateSmoke(c, r), /accounting/);
  await tr.close();
});
test("unexpected model/tier, HTTP errors and malformed output preserve known billed usage", async (t) => {
  const { c, config, dir } = await setup(t);
  for (const [i, fetchImpl] of [
    async () => response(correct(c.numeric), { service_tier: "fast" }),
    async () => new Response(JSON.stringify({ usage }), { status: 500 }),
    async () =>
      new Response(
        JSON.stringify({
          usage,
          status: "completed",
          model: "gpt-6-luna",
          service_tier: "default",
          output: [],
        }),
      ),
  ].entries()) {
    const tr = await createTransport({
      authorized: true,
      apiKey: "test-only",
      config,
      fingerprint: "x",
      maximumUSD: 2,
      journalPath: join(dir, `j${i}.json`),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const r = await tr.infer("smoke")(smokeRequest(c));
    assert.ok(r.error);
    assert.equal(r.usage?.input, 200);
    assert.ok(r.cost!.upper > 0);
    assert.equal(tr.entries().length, 1);
    await tr.close();
  }
});
test("unknown billing reserves spend before dispatch, persists failures, and stops at the same combined cap", async (t) => {
  const { c, config, journalPath } = await setup(t);
  let calls = 0;
  const tr = await createTransport({
    authorized: true,
    apiKey: "test-only",
    config,
    fingerprint: "x",
    maximumUSD: 0.5,
    journalPath,
    fetchImpl: (async () => {
      calls++;
      const onDisk = JSON.parse(await readFile(journalPath, "utf8"));
      assert.equal(onDisk.entries.at(-1).state, "pending");
      throw new Error("connection lost");
    }) as typeof fetch,
  });
  const req = smokeRequest(c);
  const r = await tr.infer("pilot")({ ...req, id: "1" });
  assert.equal(r.usage, null);
  assert.equal(r.cost!.upper, reserve(config, config.maxOutputTokens));
  await assert.rejects(tr.infer("pilot")({ ...req, id: "2" }), BudgetStop);
  assert.equal(calls, 1);
  await tr.close();
});
test("interrupted entries retain reservations and are never automatically retried; a concurrent writer is rejected", async (t) => {
  const { c, config, journalPath } = await setup(t);
  const opt = {
    authorized: true,
    apiKey: "test-only",
    config,
    fingerprint: "x",
    maximumUSD: 2,
    journalPath,
    fetchImpl: (async () => {
      throw new Error("must not retry");
    }) as typeof fetch,
  };
  let tr = await createTransport(opt);
  await assert.rejects(createTransport(opt));
  await tr.close();
  const req = smokeRequest(c),
    j = JSON.parse(await readFile(journalPath, "utf8"));
  j.entries.push({
    request: req,
    bodyHash: hash(JSON.stringify(bodyFor(req, config, 256))),
    stage: "smoke",
    reserved: reserve(config, 256),
    state: "pending",
  });
  await writeFile(journalPath, JSON.stringify(j));
  tr = await createTransport(opt);
  const r = await tr.infer("smoke")(req);
  assert.equal(r.replayed, true);
  assert.match(r.error!, /interrupted/);
  assert.equal(r.cost!.upper, reserve(config, 256));
  await tr.close();
});
test("invalid token subdivisions are rejected, and long context rates are applied per request", async () => {
  const { config } = await load();
  assert.throws(() =>
    usageOf({
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        input_tokens_details: { cached_tokens: 11 },
      },
    }),
  );
  assert.throws(() =>
    usageOf({ usage: { input_tokens: 10, output_tokens: -1 } }),
  );
  const u = {
    input: 300000,
    output: 100,
    cached: 20000,
    cacheWrite: 10000,
    reasoning: 0,
  };
  const p = config.pricing.standardPerMillion;
  const b = costBounds(u, config);
  const expected =
    (((270000 * p.input + 20000 * p.cached + 10000 * p.cacheWrite) * 2 +
      100 * p.output * 1.5) *
      1.1) /
    1e6;
  assert.ok(Math.abs(b.upper - expected) < 1e-12);
  assert.equal(b.lower, b.upper);
});

test("resume recomputes charges from saved raw usage instead of trusting an edited cost", async (t) => {
  const { c, config, journalPath } = await setup(t);
  const options = {
    authorized: true,
    apiKey: "test-only",
    config,
    fingerprint: "x",
    maximumUSD: 2,
    journalPath,
    fetchImpl: (async () => response(correct(c.numeric))) as typeof fetch,
  };
  const tr = await createTransport(options);
  await tr.infer("smoke")(smokeRequest(c));
  await tr.close();
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.entries[0].result.cost = { lower: 0, upper: 0 };
  await writeFile(journalPath, JSON.stringify(journal));
  await assert.rejects(createTransport(options), /cost mismatch/);
});
