#!/usr/bin/env node
// Package a compiled `bel` executable into a release archive.
//
//   node scripts/release/package-binary.mjs --target x86_64-unknown-linux-musl \
//     --bin target/x86_64-unknown-linux-musl/release/bel --out release-artifacts
//
// Produces, in --out:
//   bel-<version>-<target>.tar.gz|zip         archive with bel[.exe], LICENSE, README.md
//   bel-<version>-<target>.tar.gz|zip.sha256  checksum in `sha256sum` format
//   bel-<version>-<target>.json               version metadata for the artifact
//
// The binary must report the Cargo workspace version via `bel --version`.

import { spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  archiveBaseName,
  archiveExtension,
  cargoWorkspaceVersion,
  fail,
  parseArgs,
  platformForTarget,
  run,
  sha256File,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['target', 'bin', 'out'] });
if (!args.target || !args.bin || !args.out) {
  fail('usage: package-binary.mjs --target <triple> --bin <path> --out <dir>');
}

const version = cargoWorkspaceVersion();
const platform = platformForTarget(args.target);
const bin = path.resolve(args.bin);
const out = path.resolve(args.out);

// 1. The binary must run on this host and report the authoritative version.
const reported = spawnSync(bin, ['--version'], { encoding: 'utf8' });
if (reported.error) fail(`cannot execute ${bin}: ${reported.error.message}`);
if (reported.status !== 0 || reported.stdout.trim() !== `bel ${version}`) {
  fail(`${bin} reported ${JSON.stringify(reported.stdout.trim())}; expected "bel ${version}"`);
}

// 2. Stage archive contents.
const base = archiveBaseName(version, args.target);
const staging = path.join(out, '.staging');
const stageDir = path.join(staging, base);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
const stagedBin = path.join(stageDir, platform.binary);
copyFileSync(bin, stagedBin);
if (process.platform !== 'win32') chmodSync(stagedBin, 0o755);
copyFileSync(path.join(ROOT, 'LICENSE'), path.join(stageDir, 'LICENSE'));
copyFileSync(path.join(ROOT, 'README.md'), path.join(stageDir, 'README.md'));

// 3. Create the archive.
const ext = archiveExtension(args.target);
const archive = path.join(out, `${base}.${ext}`);
rmSync(archive, { force: true });
if (ext === 'zip') {
  // Use Windows' bundled bsdtar explicitly; Git for Windows' GNU tar cannot write zip files.
  const tar =
    process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  run(tar, ['-a', '-cf', archive, '-C', staging, base]);
} else {
  run('tar', ['-czf', archive, '-C', staging, base]);
}
rmSync(staging, { recursive: true, force: true });

// 4. Checksum and metadata.
const sha256 = await sha256File(archive);
const archiveName = path.basename(archive);
writeFileSync(`${archive}.sha256`, `${sha256}  ${archiveName}\n`);

let commit = process.env.GITHUB_SHA;
if (!commit) {
  try {
    commit = run('git', ['rev-parse', 'HEAD']).trim();
  } catch {
    commit = 'unknown';
  }
}
let rustc = 'unknown';
try {
  rustc = run('rustc', ['--version']).trim();
} catch {
  // rustc is optional for metadata.
}

const metadata = {
  name: 'bel',
  version,
  target: args.target,
  platform: platform.key,
  npm_package: platform.packageName,
  archive: archiveName,
  sha256,
  size: statSync(archive).size,
  binary: platform.binary,
  binary_sha256: await sha256File(bin),
  commit,
  rustc,
};
writeFileSync(path.join(out, `${base}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`packaged ${archiveName} (${sha256})`);
