#!/usr/bin/env node
// Version management for BeliefLang releases.
//
// The Cargo workspace version (`[workspace.package] version` in Cargo.toml) is
// the single source of truth. This tool verifies, or rewrites, every other
// place that must carry the same version:
//
//   node scripts/release/version.mjs print
//   node scripts/release/version.mjs check [--expect 0.2.0-alpha.0] [--tag v0.2.0-alpha.0]
//   node scripts/release/version.mjs set 0.2.0-alpha.1
//
// The historical TypeScript package.json at the repository root is deliberately
// NOT managed here: its contents are hashed by the frozen v3 benchmark inputs,
// and keeping its already-published version (0.1.1-alpha) means an accidental
// `npm publish` from the repository root is rejected by the registry.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  CRATES,
  LAUNCHER_DIR,
  PLATFORMS,
  ROOT,
  SEMVER_RE,
  cargoWorkspaceVersion,
  fail,
  parseArgs,
  readJson,
  run,
} from './lib.mjs';

// Documentation files that contain pinned `cargo install bel-cli --version X` commands.
const DOC_FILES = [
  'README.md',
  'docs/installation.md',
  'docs/releasing.md',
  'crates/bel-cli/README.md',
  'npm/belieflang/README.md',
];
const DOC_PIN_RE = /(cargo install bel-cli\b[^\n`]*?--version[ =])([0-9A-Za-z.+-]+)/g;

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function platformDir(key) {
  return path.join(ROOT, 'npm', `cli-${key}`);
}

function checkAll(version, errors) {
  const expectEq = (label, actual) => {
    if (actual !== version) errors.push(`${label}: expected ${version}, found ${actual}`);
  };

  // 1. Cargo workspace members, internal dependency pins, binary name, publish order.
  let metadata;
  try {
    metadata = JSON.parse(run('cargo', ['metadata', '--no-deps', '--format-version', '1', '--offline']));
  } catch (error) {
    errors.push(`cargo metadata failed: ${error.message}`);
  }
  if (metadata) {
    const members = metadata.packages.map((p) => p.name).sort();
    if (JSON.stringify(members) !== JSON.stringify([...CRATES].sort())) {
      errors.push(`workspace members ${members.join(', ')} do not match publish list ${CRATES.join(', ')}`);
    }
    for (const pkg of metadata.packages) {
      expectEq(`crate ${pkg.name} version`, pkg.version);
      if (pkg.publish !== null && pkg.publish !== undefined && pkg.publish.length === 0) {
        errors.push(`crate ${pkg.name} has publish = false`);
      }
      for (const field of ['description', 'license', 'repository', 'readme']) {
        if (!pkg[field]) errors.push(`crate ${pkg.name} is missing package.${field}`);
      }
      for (const dep of pkg.dependencies) {
        if (!CRATES.includes(dep.name)) continue;
        if (dep.req !== `=${version}`) {
          errors.push(`crate ${pkg.name} depends on ${dep.name} with "${dep.req}", expected "=${version}"`);
        }
        if (CRATES.indexOf(dep.name) >= CRATES.indexOf(pkg.name)) {
          errors.push(`publish order: ${dep.name} must be published before ${pkg.name}`);
        }
      }
    }
    const cli = metadata.packages.find((p) => p.name === 'bel-cli');
    const bins = cli ? cli.targets.filter((t) => t.kind.includes('bin')).map((t) => t.name) : [];
    if (JSON.stringify(bins) !== JSON.stringify(['bel'])) {
      errors.push(`bel-cli must build exactly one binary named "bel" (found: ${bins.join(', ') || 'none'})`);
    }
  }

  // 2. Cargo.lock entries for workspace crates.
  const lock = readFileSync(path.join(ROOT, 'Cargo.lock'), 'utf8');
  for (const name of CRATES) {
    const match = new RegExp(`\\[\\[package\\]\\]\\nname = "${name}"\\nversion = "([^"]+)"`).exec(lock);
    if (!match) errors.push(`Cargo.lock has no entry for ${name}`);
    else expectEq(`Cargo.lock ${name}`, match[1]);
  }

  // 3. npm launcher.
  const launcher = readJson(path.join(LAUNCHER_DIR, 'package.json'));
  if (launcher.name !== 'belieflang') errors.push(`npm launcher name is ${launcher.name}`);
  expectEq('npm/belieflang/package.json version', launcher.version);
  const expectedDeps = Object.values(PLATFORMS).map((p) => p.packageName).sort();
  const actualDeps = Object.keys(launcher.optionalDependencies || {}).sort();
  if (JSON.stringify(expectedDeps) !== JSON.stringify(actualDeps)) {
    errors.push(`launcher optionalDependencies ${actualDeps.join(', ')} != ${expectedDeps.join(', ')}`);
  }
  for (const [name, spec] of Object.entries(launcher.optionalDependencies || {})) {
    expectEq(`launcher optionalDependencies["${name}"]`, spec);
  }
  if (launcher.dependencies && Object.keys(launcher.dependencies).length) {
    errors.push('launcher must not have runtime dependencies');
  }
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (launcher.scripts && launcher.scripts[script]) errors.push(`launcher must not define a "${script}" script`);
  }

  // 4. npm platform packages.
  for (const [key, info] of Object.entries(PLATFORMS)) {
    const file = path.join(platformDir(key), 'package.json');
    if (!existsSync(file)) {
      errors.push(`missing ${rel(file)}`);
      continue;
    }
    const pkg = readJson(file);
    if (pkg.name !== info.packageName) errors.push(`${rel(file)} name ${pkg.name} != ${info.packageName}`);
    expectEq(`${rel(file)} version`, pkg.version);
    if (JSON.stringify(pkg.os) !== JSON.stringify([info.os])) errors.push(`${rel(file)} os != ["${info.os}"]`);
    if (JSON.stringify(pkg.cpu) !== JSON.stringify([info.cpu])) errors.push(`${rel(file)} cpu != ["${info.cpu}"]`);
    if (!(pkg.files || []).includes(`bin/${info.binary}`)) errors.push(`${rel(file)} files must include bin/${info.binary}`);
    if (pkg.scripts && Object.keys(pkg.scripts).length) errors.push(`${rel(file)} must not define scripts`);
  }
  for (const entry of readdirSync(path.join(ROOT, 'npm'))) {
    if (entry.startsWith('cli-') && !PLATFORMS[entry.slice(4)]) errors.push(`npm/${entry} is not a supported platform`);
  }

  // 5. Pinned documentation commands.
  for (const doc of DOC_FILES) {
    const file = path.join(ROOT, doc);
    if (!existsSync(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(DOC_PIN_RE)) {
      if (match[2] !== version) errors.push(`${doc}: "${match[0]}" should pin ${version}`);
    }
  }

  // 6. License files packaged with each crate must match the root license.
  const license = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  for (const name of CRATES) {
    const file = path.join(ROOT, 'crates', name, 'LICENSE');
    if (!existsSync(file) || readFileSync(file, 'utf8') !== license) {
      errors.push(`crates/${name}/LICENSE is missing or differs from the root LICENSE`);
    }
  }

  // 7. Guard against publishing the historical TypeScript package by accident.
  const legacy = readJson(path.join(ROOT, 'package.json'));
  if (legacy.version === version) {
    errors.push('root package.json (historical TypeScript) must not carry the release version');
  }
  if (legacy.bin && legacy.bin.bel && !String(legacy.bin.bel).includes('dist/')) {
    errors.push('unexpected root package.json bin entry');
  }
}

function setVersion(version) {
  // Cargo.toml: workspace version and exact internal pins.
  const cargoPath = path.join(ROOT, 'Cargo.toml');
  let cargo = readFileSync(cargoPath, 'utf8');
  cargo = cargo.replace(
    /(\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
    `$1${version}$2`,
  );
  for (const name of CRATES.filter((c) => c !== 'bel-cli')) {
    cargo = cargo.replace(
      new RegExp(`^(${name}\\s*=\\s*\\{[^}\\n]*version\\s*=\\s*"=)[^"]+(")`, 'm'),
      `$1${version}$2`,
    );
  }
  writeFileSync(cargoPath, cargo);

  // npm packages.
  const launcherPath = path.join(LAUNCHER_DIR, 'package.json');
  const launcher = readJson(launcherPath);
  launcher.version = version;
  for (const name of Object.keys(launcher.optionalDependencies)) launcher.optionalDependencies[name] = version;
  writeFileSync(launcherPath, `${JSON.stringify(launcher, null, 2)}\n`);
  for (const key of Object.keys(PLATFORMS)) {
    const file = path.join(platformDir(key), 'package.json');
    const pkg = readJson(file);
    pkg.version = version;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  // Documentation pins.
  for (const doc of DOC_FILES) {
    const file = path.join(ROOT, doc);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = before.replace(DOC_PIN_RE, `$1${version}`);
    if (after !== before) writeFileSync(file, after);
  }

  // Refresh Cargo.lock entries for workspace members.
  run('cargo', ['update', '--workspace', '--offline'], { capture: false });
}

function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['expect', 'tag'] });
  const [command = 'check', value] = args._;

  if (command === 'print') {
    process.stdout.write(`${cargoWorkspaceVersion()}\n`);
    return;
  }

  if (command === 'set') {
    if (!value || !SEMVER_RE.test(value)) fail('usage: version.mjs set <semver>');
    setVersion(value);
  } else if (command !== 'check') {
    fail(`unknown command "${command}" (expected print, check, or set)`);
  }

  const version = cargoWorkspaceVersion();
  const errors = [];
  if (!SEMVER_RE.test(version)) errors.push(`workspace version "${version}" is not valid semver`);
  if (args.expect && args.expect !== version) {
    errors.push(`expected version ${args.expect}, but the Cargo workspace version is ${version}`);
  }
  if (args.tag && args.tag !== `v${version}`) {
    errors.push(`tag ${args.tag} does not match workspace version (expected v${version})`);
  }
  checkAll(version, errors);

  if (errors.length) {
    console.error(`Version consistency check failed for ${version}:`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`All release versions are consistent: ${version}`);
}

main();
