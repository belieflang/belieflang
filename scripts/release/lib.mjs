// Shared helpers for BeliefLang release tooling. Node.js built-ins only.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Platform table shared with the npm launcher (single definition). */
export const { PLATFORMS } = require(path.join(ROOT, 'npm', 'belieflang', 'lib', 'platforms.js'));

/** Crates in publication (dependency) order. Verified against `cargo metadata` by version.mjs. */
export const CRATES = ['bel-syntax', 'bel-runtime', 'bel-providers', 'bel-cli'];

export const LAUNCHER_DIR = path.join(ROOT, 'npm', 'belieflang');

// Semantic Versioning 2.0.0 (as accepted by both Cargo and npm).
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isPrerelease(version) {
  const match = SEMVER_RE.exec(version);
  if (!match) throw new Error(`invalid semver: ${version}`);
  return Boolean(match[4]);
}

/** Read the authoritative version from `[workspace.package]` in the root Cargo.toml. */
export function cargoWorkspaceVersion(root = ROOT) {
  const toml = readFileSync(path.join(root, 'Cargo.toml'), 'utf8');
  const section = /^\[workspace\.package\]\s*$([\s\S]*?)(?=^\[)/m.exec(toml);
  if (!section) throw new Error('Cargo.toml has no [workspace.package] section');
  const version = /^version\s*=\s*"([^"]+)"/m.exec(section[1]);
  if (!version) throw new Error('[workspace.package] has no version');
  return version[1];
}

export function archiveBaseName(version, target) {
  return `bel-${version}-${target}`;
}

export function archiveExtension(target) {
  return target.includes('windows') ? 'zip' : 'tar.gz';
}

export function platformForTarget(target) {
  const entry = Object.entries(PLATFORMS).find(([, info]) => info.target === target);
  if (!entry) throw new Error(`unknown release target: ${target}`);
  return { key: entry[0], ...entry[1] };
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Run a command without a shell; throw on failure. Returns stdout. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...options.env },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = options.capture === false ? '' : `\n${result.stdout || ''}${result.stderr || ''}`;
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}${detail}`);
  }
  return options.allowFailure ? result : result.stdout;
}

/** Minimal `--flag value` / `--switch` argument parser. */
export function parseArgs(argv, { flags = [], switches = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (switches.includes(name)) out[name] = true;
      else if (flags.includes(name)) {
        const value = argv[++i];
        if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
        out[name] = value;
      } else throw new Error(`unknown option ${arg}`);
    } else out._.push(arg);
  }
  return out;
}

export function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}
