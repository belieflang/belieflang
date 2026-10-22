#!/usr/bin/env node
// Smoke-test a `bel` executable (native binary or npm-installed launcher).
//
//   node scripts/release/smoke-test.mjs --bin path/to/bel [--expect-version 0.2.0-alpha.0]
//
// Verifies:
//   - `bel --version` prints exactly `bel <version>`
//   - `bel run examples/intent.bel --trace` matches the golden output
//   - usage errors exit with code 2 and a missing file exits with code 1
//
// `--bin` may point at a Windows `.cmd` shim created by npm; it is then run
// through cmd.exe because Node refuses to spawn batch files directly.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, cargoWorkspaceVersion, fail, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['bin', 'expect-version'] });
if (!args.bin) fail('usage: smoke-test.mjs --bin <path-to-bel> [--expect-version <version>]');

const expectedVersion = args['expect-version'] || cargoWorkspaceVersion();
const bin = path.resolve(args.bin);
const isBatch = /\.(cmd|bat)$/i.test(bin);

function bel(belArgs) {
  const command = isBatch ? process.env.ComSpec || 'cmd.exe' : bin;
  const commandArgs = isBatch ? ['/d', '/s', '/c', `"${bin}" ${belArgs.join(' ')}`] : belArgs;
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsVerbatimArguments: isBatch,
    env: { ...process.env, OPENAI_API_KEY: '', TYPESAFE_API_KEY: '' },
  });
  if (result.error) fail(`could not execute ${bin}: ${result.error.message}`);
  return result;
}

const normalize = (text) => text.replace(/\r\n/g, '\n');
let failures = 0;
function check(name, condition, detail) {
  if (condition) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? `\n${detail}` : ''}`);
  }
}

const version = bel(['--version']);
check(
  `bel --version reports ${expectedVersion}`,
  version.status === 0 && normalize(version.stdout) === `bel ${expectedVersion}\n`,
  `status=${version.status} stdout=${JSON.stringify(version.stdout)} stderr=${JSON.stringify(version.stderr)}`,
);

const golden = readFileSync(path.join(ROOT, 'scripts', 'release', 'fixtures', 'intent.trace.txt'), 'utf8');
const trace = bel(['run', 'examples/intent.bel', '--trace']);
check(
  'bel run examples/intent.bel --trace matches golden output',
  trace.status === 0 && normalize(trace.stdout) === normalize(golden),
  `status=${trace.status}\n--- expected\n${golden}\n--- actual\n${trace.stdout}\n--- stderr\n${trace.stderr}`,
);

const usage = bel(['run', 'examples/intent.bel', '--unknown-flag']);
check('usage errors exit with code 2', usage.status === 2 && usage.stderr.includes('usage: bel run'));

const missing = bel(['run', 'does-not-exist.bel']);
check('missing input file exits with code 1', missing.status === 1 && missing.stderr.includes('error:'));

if (failures) fail(`${failures} smoke test(s) failed for ${bin}`);
console.log(`All smoke tests passed for ${bin}`);
