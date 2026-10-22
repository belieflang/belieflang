#!/usr/bin/env node
// Publish workspace crates to crates.io in topological dependency order.
//
//   node scripts/release/publish-crates.mjs [--dry-run]
//
// Safe against retries, network hiccups, and partial publishes:
//   - Checks crates.io API first; if <crate>@<version> is already published, skips it.
//   - Publishes in strict dependency order: bel-syntax -> bel-runtime -> bel-providers -> bel-cli.
//   - After publishing an upstream crate, waits until crates.io makes it visible before
//     attempting to publish dependent crates.

import { CRATES, cargoWorkspaceVersion, fail, parseArgs, run } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { switches: ['dry-run', 'allow-dirty'] });
const dryRun = Boolean(args['dry-run']);
const allowDirty = Boolean(args['allow-dirty']);
const version = cargoWorkspaceVersion();

async function isCratePublished(name, ver) {
  try {
    const res = await fetch(`https://crates.io/api/v1/crates/${name}/${ver}`, {
      headers: { 'User-Agent': 'belieflang-release-bot (contact: team@belieflang.org)' },
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    // On unexpected registry response, log and treat as not published
    return false;
  } catch (err) {
    console.warn(`warning: failed to check crates.io for ${name}@${ver}: ${err.message}`);
    return false;
  }
}

async function waitForCrate(name, ver, maxWaitSec = 180) {
  const start = Date.now();
  process.stdout.write(`Waiting for ${name}@${ver} to be visible on crates.io index...`);
  while ((Date.now() - start) / 1000 < maxWaitSec) {
    await new Promise((r) => setTimeout(r, 6000));
    if (await isCratePublished(name, ver)) {
      console.log(' ready.');
      return true;
    }
    process.stdout.write('.');
  }
  console.log(' timeout.');
  return false;
}

async function main() {
  console.log(`Publishing BeliefLang crates for version ${version} (dryRun=${dryRun})`);
  console.log(`Publish order: ${CRATES.join(' -> ')}`);

  for (let i = 0; i < CRATES.length; i++) {
    const crate = CRATES[i];
    const isLast = i === CRATES.length - 1;

    console.log(`\n[${i + 1}/${CRATES.length}] Checking ${crate}@${version}...`);
    const alreadyPublished = await isCratePublished(crate, version);
    if (alreadyPublished) {
      console.log(`=> ${crate}@${version} is already published on crates.io; skipping.`);
      continue;
    }

    const cmdArgs = ['publish', '-p', crate];
    if (dryRun) {
      cmdArgs.push('--dry-run');
    }
    if (allowDirty) {
      cmdArgs.push('--allow-dirty');
    }

    console.log(`=> Running: cargo ${cmdArgs.join(' ')}`);
    try {
      run('cargo', cmdArgs, { capture: false });
    } catch (err) {
      if (dryRun && i > 0) {
        console.warn(
          `\nNote: ${crate} dry-run failed because upstream workspace dependencies are not yet published on crates.io.\nThis is expected during local dry-run before initial publication.\n`,
        );
      } else {
        fail(`Failed to publish crate ${crate}: ${err.message}`);
      }
    }

    if (!dryRun && !isLast) {
      const ok = await waitForCrate(crate, version);
      if (!ok) {
        console.warn(
          `Warning: ${crate}@${version} not indexed after timeout. Proceeding, but downstream publish may require retry.`,
        );
      }
    }
  }

  console.log(`\nSuccessfully processed all crates for ${version}!`);
}

main().catch((e) => fail(e.stack || e.message));
