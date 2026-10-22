#!/usr/bin/env node
// Publish staged npm tarballs to npm registry in dependency order.
//
//   node scripts/release/publish-npm.mjs --tarballs npm-dist/tarballs [--tag next] [--dry-run]
//
// Publishes platform packages first, then the launcher belieflang package.
// Safe against retries and partial publication (checks registry first).
// Enforces that prereleases are published under `next` (or explicit tag), never defaulting to `latest`.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fail, isPrerelease, parseArgs, run } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), {
  flags: ['tarballs', 'tag'],
  switches: ['dry-run'],
});

if (!args.tarballs) {
  fail('usage: publish-npm.mjs --tarballs <path-to-tarballs-dir> [--tag <tag>] [--dry-run]');
}

const tarballsDir = path.resolve(args.tarballs);
const manifestPath = path.join(tarballsDir, 'npm-manifest.json');
if (!existsSync(manifestPath)) {
  fail(`manifest not found at ${manifestPath}. Run stage-npm.mjs first.`);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
const dryRun = Boolean(args['dry-run']);

// Tag selection and safety check
let tag = args.tag;
if (!tag) {
  tag = isPrerelease(version) ? 'next' : 'latest';
}

if (isPrerelease(version) && tag === 'latest') {
  fail(
    `Safety violation: attempting to publish prerelease ${version} to dist-tag 'latest'. Use --tag next for prereleases.`,
  );
}

async function isNpmPublished(pkgName, ver) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/${ver}`, {
      headers: { 'User-Agent': 'belieflang-release-bot' },
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    return false;
  } catch (err) {
    console.warn(`warning: failed to check npm registry for ${pkgName}@${ver}: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log(`Publishing BeliefLang npm packages for ${version} to tag '${tag}' (dryRun=${dryRun})`);
  console.log(`Found ${manifest.packages.length} packages in manifest.`);

  for (let i = 0; i < manifest.packages.length; i++) {
    const item = manifest.packages[i];
    console.log(`\n[${i + 1}/${manifest.packages.length}] Checking ${item.name}@${item.version}...`);

    const alreadyPublished = await isNpmPublished(item.name, item.version);
    if (alreadyPublished) {
      console.log(`=> ${item.name}@${item.version} is already published on npm; skipping.`);
      continue;
    }

    const tarballFile = path.join(tarballsDir, item.file);
    if (!existsSync(tarballFile)) {
      fail(`Tarball missing: ${tarballFile}`);
    }

    const cmdArgs = ['publish', tarballFile, '--tag', tag, '--access', 'public'];
    if (dryRun) {
      cmdArgs.push('--dry-run');
    }

    console.log(`=> Running: npm ${cmdArgs.join(' ')}`);
    try {
      run('npm', cmdArgs, { capture: false });
    } catch (err) {
      fail(`Failed to publish ${item.name}: ${err.message}`);
    }
  }

  console.log(`\nAll npm packages processed successfully for ${version} with tag '${tag}'!`);
}

main().catch((e) => fail(e.stack || e.message));
