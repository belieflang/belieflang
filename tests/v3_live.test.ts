import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLiveInference,
  BudgetExhausted,
  type LiveConfig,
} from "../src/v3_live.js";
import { readResponse, type InferenceRequest } from "../src/v3_inference.js";
const config: LiveConfig = {
  model: "gpt-6-luna",
  repetitions: 1,
  maxOutputTokens: 100,
  inputTokenCeiling: 32768,
  timeoutMs: 1000,
};
const rates = { input: 1, output: 2, cached: 0.1, cacheWrite: 1.2 };
const request: InferenceRequest = {
  id: "r/turn1",
  kind: "answer",
  prompt: "public data",
  schema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};
const usage = {
  input_tokens: 100,
  output_tokens: 5,
  input_tokens_details: { cached_tokens: 20 },
};
const payload = (text = "{}", status = "completed") => ({
  status,
  usage: structuredClone(usage),
  output: [
    {
      type: "message",
      phase: "commentary",
      content: [{ type: "output_text", text: "intermediate" }],
    },
    {
      type: "message",
      phase: "final_answer",
      content: [{ type: "output_text", text }],
    },
  ],
});
async function temp(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "belieflang-v3-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "journal.json");
}

test("no request runs without sufficient pre-reserved budget", async (t) => {
  const path = await temp(t);
  let calls = 0;
  const runner = await createLiveInference({
    apiKey: "test-only",
    config,
    rates,
    cap: 0.001,
    fingerprint: "fixture-hash",
    journalPath: path,
    fetchImpl: (async () => {
      calls++;
      throw new Error("must not call");
    }) as typeof fetch,
  });
  await assert.rejects(runner.infer(request, null), BudgetExhausted);
  assert.equal(calls, 0);
  assert.equal(runner.accounting().entries.length, 0);
  await runner.close();
});
test("pending journal precedes dispatch; only prompt/schema are sent; successful replay is free", async (t) => {
  const path = await temp(t);
  let calls = 0;
  const runner = await createLiveInference({
    apiKey: "test-only",
    config,
    rates,
    cap: 0.1,
    fingerprint: "fixture-hash",
    journalPath: path,
    fetchImpl: (async (_url, init) => {
      calls++;
      const journal = JSON.parse(await readFile(path, "utf8"));
      assert.equal(journal.entries[0].state, "pending");
      const body = String(init?.body);
      assert.ok(!body.includes("privateGold"));
      assert.equal(JSON.parse(body).model, "gpt-6-luna");
      return new Response(JSON.stringify(payload()));
    }) as typeof fetch,
  });
  const a = await runner.infer(request, { privateGold: "not for live" });
  assert.deepEqual(a.output, {});
  assert.equal(a.usage!.cached, 20);
  assert.equal(a.estimatedCost, 0.000092);
  assert.equal((await runner.infer(request, null)).replayed, true);
  assert.equal(calls, 1);
  await assert.rejects(
    runner.infer({ ...request, prompt: "different" }, null),
    /request mismatch/,
  );
  await runner.close();
  const resume = await createLiveInference({
    apiKey: "test-only",
    config,
    rates,
    cap: 0.1,
    fingerprint: "fixture-hash",
    journalPath: path,
    fetchImpl: (async () => {
      throw new Error("must not retry");
    }) as typeof fetch,
  });
  assert.equal((await resume.infer(request, null)).replayed, true);
  await resume.close();
});
test("usage survives incomplete, malformed final JSON, and HTTP error responses", async (t) => {
  const path = await temp(t);
  let calls = 0;
  const cases = [
    new Response(JSON.stringify(payload("{}", "incomplete"))),
    new Response(JSON.stringify(payload("bad JSON"))),
    new Response(JSON.stringify(payload()), { status: 429 }),
  ];
  const runner = await createLiveInference({
    apiKey: "test-only",
    config,
    rates,
    cap: 0.1,
    fingerprint: "fixture-hash",
    journalPath: path,
    fetchImpl: (async () => cases[calls++]) as typeof fetch,
  });
  for (let i = 0; i < 3; i++) {
    const result = await runner.infer({ ...request, id: `r/${i}` }, null);
    assert.ok(result.error);
    assert.equal(result.usage!.input, 100);
    assert.equal(result.estimatedCost, 0.000092);
  }
  assert.equal(runner.accounting().entries.length, 3);
  assert.equal(runner.accounting().unmeteredCalls, 0);
  await runner.close();
});
test("network/unknown billing retains full reservation and prevents overspend", async (t) => {
  const path = await temp(t);
  let calls = 0;
  const runner = await createLiveInference({
    apiKey: "test-only",
    config,
    rates,
    cap: 0.04,
    fingerprint: "fixture-hash",
    journalPath: path,
    fetchImpl: (async () => {
      calls++;
      throw new Error("timeout");
    }) as typeof fetch,
  });
  const failed = await runner.infer(request, null);
  assert.equal(failed.error, "timeout");
  assert.equal(failed.usage, null);
  assert.ok(failed.estimatedCost! > 0.039);
  await assert.rejects(
    runner.infer({ ...request, id: "next" }, null),
    BudgetExhausted,
  );
  assert.equal(calls, 1);
  await runner.close();
});
test("interrupted pending request is charged its reserve on resume and never retried", async (t) => {
  const path = await temp(t);
  const runner = await createLiveInference({
    apiKey: "test-only",
    config,
    rates,
    cap: 0.1,
    fingerprint: "fixture-hash",
    journalPath: path,
    fetchImpl: (async () =>
      new Response(JSON.stringify(payload()))) as typeof fetch,
  });
  await runner.infer(request, null);
  await runner.close();
  const journal = JSON.parse(await readFile(path, "utf8"));
  journal.entries[0].state = "pending";
  delete journal.entries[0].result;
  await writeFile(path, JSON.stringify(journal));
  const resume = await createLiveInference({
    apiKey: "test-only",
    config,
    rates,
    cap: 0.1,
    fingerprint: "fixture-hash",
    journalPath: path,
    fetchImpl: (async () => {
      throw new Error("must not retry");
    }) as typeof fetch,
  });
  const result = await resume.infer(request, null);
  assert.match(result.error!, /interrupted/);
  assert.ok(result.estimatedCost! > 0.039);
  await resume.close();
});
test("resuming different fixtures or sources is rejected; simultaneous writers are rejected", async (t) => {
  const path = await temp(t),
    options = {
      apiKey: "test-only",
      config,
      rates,
      cap: 0.1,
      fingerprint: "fixture-hash",
      journalPath: path,
      fetchImpl: (async () => {
        throw new Error("no network in tests");
      }) as typeof fetch,
    };
  const a = await createLiveInference(options);
  await assert.rejects(createLiveInference(options), /EEXIST/);
  await a.close();
  await assert.rejects(
    createLiveInference({ ...options, fingerprint: "changed" }),
    /mismatch/,
  );
  const b = await createLiveInference(options);
  await b.close();
});
test("invalid token usage is conservatively reserved; refusal and ambiguous finals fail", async (t) => {
  const path = await temp(t);
  const p = payload();
  p.usage.input_tokens_details.cached_tokens = 1000;
  const runner = await createLiveInference({
    apiKey: "test-only",
    config,
    rates,
    cap: 0.1,
    fingerprint: "fixture-hash",
    journalPath: path,
    fetchImpl: (async () => new Response(JSON.stringify(p))) as typeof fetch,
  });
  const result = await runner.infer(request, null);
  assert.ok(result.error);
  assert.equal(result.usage, null);
  assert.ok(result.estimatedCost! > 0.039);
  await runner.close();
  const refused = payload();
  (refused.output[1].content as any[]) = [{ type: "refusal", refusal: "no" }];
  assert.throws(() => readResponse(refused), /refusal/);
  const duplicate = payload();
  duplicate.output.push(duplicate.output[1]);
  assert.throws(() => readResponse(duplicate), /one final/);
});

test("provider bound violations save usage and halt even when the dollar cap is not reached", async (t) => {
  const path = await temp(t),
    data = payload();
  data.usage.output_tokens = 101;
  const runner = await createLiveInference({
    apiKey: "test-only",
    config,
    rates,
    cap: 0.1,
    fingerprint: "fixture-hash",
    journalPath: path,
    fetchImpl: (async () => new Response(JSON.stringify(data))) as typeof fetch,
  });
  await assert.rejects(
    runner.infer(request, null),
    /exceeded accounting bounds/,
  );
  assert.equal(runner.accounting().entries[0].result!.usage!.output, 101);
  await runner.close();
});
