#!/usr/bin/env node
// Assemble and pack the npm packages from verified release archives.
//
//   node scripts/release/stage-npm.mjs --artifacts release-artifacts --out npm-dist \
//     [--platforms darwin-arm64,linux-x64]
//
// For every platform, the binary is extracted from the GitHub release archive
// (after verifying its SHA-256), so npm and GitHub Releases ship byte-identical
// executables. The launcher package is copied from npm/belieflang without tests.
//
// Output (in --out):
//   cli-<platform>/, belieflang/     staged package directories
//   tarballs/*.tgz                   `npm pack` output
//   tarballs/npm-manifest.json       publish order, sha256, integrity, file lists
//
// Fails if any package contains files outside its allowlist; in particular the
// launcher can never contain the historical TypeScript interpreter.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LAUNCHER_DIR,
  PLATFORMS,
  ROOT,
  archiveBaseName,
  archiveExtension,
  cargoWorkspaceVersion,
  fail,
  parseArgs,
  readJson,
  run,
  sha256File,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['artifacts', 'out', 'platforms'] });
if (!args.artifacts || !args.out) fail('usage: stage-npm.mjs --artifacts <dir> --out <dir> [--platforms a,b]');

const version = cargoWorkspaceVersion();
const artifacts = path.resolve(args.artifacts);
const out = path.resolve(args.out);
const tarballs = path.join(out, 'tarballs');
const selected = args.platforms ? args.platforms.split(',') : Object.keys(PLATFORMS);
for (const key of selected) if (!PLATFORMS[key]) fail(`unknown platform ${key}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(tarballs, { recursive: true });

const LAUNCHER_FILES = [
  'LICENSE',
  'README.md',
  'bin/bel.js',
  'lib/index.d.ts',
  'lib/index.js',
  'lib/platforms.js',
  'package.json',
];
const MAX_LAUNCHER_UNPACKED_BYTES = 64 * 1024;

function extract(archive, dest) {
  mkdirSync(dest, { recursive: true });
  if (archive.endsWith('.zip') && process.platform === 'linux') run('unzip', ['-q', archive, '-d', dest]);
  else run('tar', ['-xf', archive, '-C', dest]);
}

function pack(dir) {
  const json = run('npm', ['pack', '--json', '--pack-destination', tarballs], { cwd: dir });
  const [result] = JSON.parse(json);
  return result;
}

function assertFiles(label, result, expected) {
  const actual = result.files.map((f) => f.path).sort();
  const want = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    fail(`${label} contents ${JSON.stringify(actual)} differ from allowlist ${JSON.stringify(want)}`);
  }
}

const manifest = { version, packages: [] };

async function record(result, extra = {}) {
  const file = path.join(tarballs, result.filename);
  manifest.packages.push({
    name: result.name,
    version: result.version,
    file: result.filename,
    sha256: await sha256File(file),
    integrity: result.integrity,
    unpackedSize: result.unpackedSize,
    files: result.files.map((f) => f.path).sort(),
    ...extra,
  });
}

// Platform packages first: they must be published before the launcher that depends on them.
const tmp = path.join(os.tmpdir(), `belieflang-stage-${process.pid}`);
for (const key of selected) {
  const info = PLATFORMS[key];
  const base = archiveBaseName(version, info.target);
  const archive = path.join(artifacts, `${base}.${archiveExtension(info.target)}`);
  if (!existsSync(archive)) fail(`missing release archive ${archive}`);

  const expectedSha = readFileSync(`${archive}.sha256`, 'utf8').split(/\s+/)[0];
  const actualSha = await sha256File(archive);
  if (expectedSha !== actualSha) fail(`checksum mismatch for ${path.basename(archive)}`);

  const extracted = path.join(tmp, key);
  extract(archive, extracted);
  const binary = path.join(extracted, base, info.binary);
  if (!existsSync(binary)) fail(`${path.basename(archive)} does not contain ${base}/${info.binary}`);

  const template = path.join(ROOT, 'npm', `cli-${key}`);
  const dir = path.join(out, `cli-${key}`);
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const pkg = readJson(path.join(template, 'package.json'));
  if (pkg.version !== version || pkg.name !== info.packageName) {
    fail(`npm/cli-${key}/package.json is ${pkg.name}@${pkg.version}; expected ${info.packageName}@${version}`);
  }
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  copyFileSync(path.join(template, 'README.md'), path.join(dir, 'README.md'));
  copyFileSync(path.join(ROOT, 'LICENSE'), path.join(dir, 'LICENSE'));
  copyFileSync(binary, path.join(dir, 'bin', info.binary));
  chmodSync(path.join(dir, 'bin', info.binary), 0o755);

  const result = pack(dir);
  assertFiles(info.packageName, result, ['LICENSE', 'README.md', `bin/${info.binary}`, 'package.json']);
  const binEntry = result.files.find((f) => f.path === `bin/${info.binary}`);
  if (process.platform !== 'win32' && binEntry.mode !== undefined && (binEntry.mode & 0o111) === 0) {
    fail(`${info.packageName}: bin/${info.binary} is not executable in the tarball (mode ${binEntry.mode.toString(8)})`);
  }
  await record(result, { platform: key, target: info.target, binary_sha256: await sha256File(binary) });
  console.log(`packed ${result.filename}`);
}
rmSync(tmp, { recursive: true, force: true });

// Launcher.
{
  const dir = path.join(out, 'belieflang');
  mkdirSync(path.join(dir, 'bin'), { recursive: true });
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const pkg = readJson(path.join(LAUNCHER_DIR, 'package.json'));
  if (pkg.version !== version) fail(`npm/belieflang/package.json version ${pkg.version} != ${version}`);
  delete pkg.scripts; // test scripts are development-only; the package defines no lifecycle scripts
  delete pkg.devDependencies;
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  copyFileSync(path.join(LAUNCHER_DIR, 'README.md'), path.join(dir, 'README.md'));
  copyFileSync(path.join(ROOT, 'LICENSE'), path.join(dir, 'LICENSE'));
  for (const file of LAUNCHER_FILES.filter((f) => f.includes('/'))) {
    copyFileSync(path.join(LAUNCHER_DIR, file), path.join(dir, file));
  }
  chmodSync(path.join(dir, 'bin', 'bel.js'), 0o755);

  const result = pack(dir);
  assertFiles('belieflang', result, LAUNCHER_FILES);
  if (result.unpackedSize > MAX_LAUNCHER_UNPACKED_BYTES) {
    fail(`belieflang launcher is unexpectedly large (${result.unpackedSize} bytes)`);
  }
  await record(result);
  console.log(`packed ${result.filename}`);
}

writeFileSync(path.join(tarballs, 'npm-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`staged ${manifest.packages.length} npm packages for ${version} in ${tarballs}`);
