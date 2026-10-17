import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("experiment preserves malformed prefixes, restarts whole passes and assembles correct accounting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "belief-experiment-test-"));
  try {
    const preload = join(directory, "mock-fetch.mjs");
    await writeFile(preload, `
let calls = 0;
globalThis.fetch = async (_url, init) => {
  calls++;
  if (process.env.MOCK_HTTP_FAILURE === '1') return new Response('', {status: 429});
  const body = JSON.parse(init.body);
  const schema = body.text.format.schema;
  const output = Object.fromEntries(Object.keys(schema.properties).filter(k => k !== 'intent').map(k => [k, 0]));
  output.intent = Object.fromEntries(Object.keys(schema.properties.intent.properties).map(k => [k, Number(k === 'unknown')]));
  const invalid = calls === 2 && process.argv.some(a => a.endsWith('original-continuity-full_history-r1-a1.json'));
  return new Response(JSON.stringify({id: 'mock_' + calls, status: 'completed',
    output: [{type: 'message', content: [{type: 'output_text', text: invalid ? 'invalid JSON' : JSON.stringify(output)}]}],
    usage: {input_tokens: 10, output_tokens: 2, input_tokens_details: {cached_tokens: 0, cache_write_tokens: 0}}}));
};
`);
    const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "mock-key", OPENAI_MODEL: "mock-model",
      NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, MOCK_HTTP_FAILURE: "0" };
    for (const key of Object.keys(env)) if (key.startsWith("MODEL_")) delete env[key];
    const output = join(directory, "experiment");
    const run = spawnSync(process.execPath, ["dist/src/multidomain_experiment.js", output], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    const read = async (file: string) => JSON.parse(await readFile(join(output, file), "utf8"));
    const ledger = await read("ledger.json"), summary = await read("summary.json"), fresh = await read("holdout-summary.json");
    assert.equal(ledger.status, "completed");
    assert.equal(ledger.completed_passes, 15);
    assert.equal(ledger.attempts.length, 16);
    assert.equal(ledger.attempts[0].status, "failed");
    assert.equal(ledger.attempts[0].completed_calls, 1);
    assert.equal(ledger.attempts[1].attempt, 2);
    assert.equal(summary.prompt_variant, "continuity");
    assert.equal(summary.completed_calls, 900);
    assert.equal(summary.execution_accounting.discarded_successful_calls, 1);
    assert.equal(summary.results.belief_snapshot.intent_correct, 30); // mock always predicts unknown
    assert.equal(fresh.results.original.turns, 90);
    assert.equal(fresh.results.continuity.turns, 90);
    assert.equal(fresh.results.continuity.unrelated_correct, 15);
    assert.equal(fresh.experiment_execution_accounting.recorded_successful_calls, 1081);
    assert.equal(fresh.experiment_execution_accounting.total_attempted_calls, 1082);
    assert.equal(fresh.experiment_execution_accounting.usage.total_tokens, 1081 * 12);
    assert.equal((await read("plan.json")).planned_scored_calls, 1080);
    const stopped = join(directory, "http-stopped");
    const error = spawnSync(process.execPath, ["dist/src/multidomain_experiment.js", stopped], {
      env: { ...env, MOCK_HTTP_FAILURE: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(error.status, 1);
    const failed = JSON.parse(await readFile(join(stopped, "ledger.json"), "utf8"));
    assert.equal(failed.attempts.length, 1);
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /HTTP 429/);
    const changedModel = spawnSync(process.execPath, ["dist/src/multidomain_experiment.js", stopped, "--resume"], {
      env: { ...env, OPENAI_MODEL: "different-model" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(changedModel.status, 1);
    assert.match(changedModel.stderr, /resume source differs/);
    const resume = spawnSync(process.execPath, ["dist/src/multidomain_experiment.js", stopped, "--resume"], {
      env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(resume.status, 0, resume.stderr);
    const resumed = JSON.parse(await readFile(join(stopped, "ledger.json"), "utf8"));
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.attempts[0].error.includes("HTTP 429"), true);
    assert.equal(resumed.attempts[1].attempt, 2);
    assert.equal(resumed.resumptions.length, 1);
    const preserved = JSON.parse(await readFile(join(stopped, "ledger-before-resume-1.json"), "utf8"));
    assert.equal(preserved.status, "failed");
    assert.equal(preserved.attempts.length, 1);
    const compactOutput = join(directory, "compact");
    const compact = spawnSync(process.execPath, ["dist/src/multidomain_experiment.js", compactOutput, "--candidate", "compact"], {
      env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(compact.status, 0, compact.stderr);
    const compactRead = async (file: string) => JSON.parse(await readFile(join(compactOutput, file), "utf8"));
    const compactPlan = await compactRead("plan.json");
    assert.deepEqual(Object.keys(compactPlan.prompts_by_variant), ["continuity", "compact"]);
    assert.equal(compactPlan.model, "mock-model");
    assert.equal(compactPlan.passes.slice(0, 9).every((p: { prompt: string }) => p.prompt === "compact"), true);
    assert.deepEqual(compactPlan.passes.slice(9).map((p: { prompt: string }) => p.prompt),
      ["continuity", "compact", "compact", "continuity", "continuity", "compact"]);
    assert.equal((await compactRead("summary.json")).prompt_variant, "compact");
    const compactFresh = await compactRead("holdout-summary.json");
    assert.equal(compactFresh.results.compact.turns, 90);
    assert.equal(compactFresh.results.continuity.turns, 90);
    assert.equal(compactFresh.results.original, undefined);
    assert.equal(compactFresh.experiment_execution_accounting.total_attempted_calls, 1080);
    for (const args of [["--candidate"], ["--candidate", "bad"], ["--resume", "--resume"]]) {
      const invalid = spawnSync(process.execPath, ["dist/src/multidomain_experiment.js", join(directory, "invalid"), ...args], {
        env, encoding: "utf8", timeout: 30_000,
      });
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /invalid experiment argument|duplicate argument/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
