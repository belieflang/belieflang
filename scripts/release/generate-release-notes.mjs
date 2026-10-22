#!/usr/bin/env node
// Generate release notes in Markdown for GitHub Releases.
//
//   node scripts/release/generate-release-notes.mjs --artifacts release-artifacts --out RELEASE_NOTES.md
//
// Reads metadata JSON files and SHA-256 checksums from the artifacts directory to generate
// a complete, verified release description with checksum tables and installation instructions.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { cargoWorkspaceVersion, fail, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['artifacts', 'out'] });
if (!args.artifacts || !args.out) {
  fail('usage: generate-release-notes.mjs --artifacts <dir> --out <file>');
}

const artifactsDir = path.resolve(args.artifacts);
const outFile = path.resolve(args.out);
const version = cargoWorkspaceVersion();

const metadataFiles = readdirSync(artifactsDir).filter((f) => f.endsWith('.json') && !f.includes('manifest'));
const artifacts = metadataFiles
  .map((f) => {
    try {
      return JSON.parse(readFileSync(path.join(artifactsDir, f), 'utf8'));
    } catch {
      return null;
    }
  })
  .filter(Boolean);

let tableRows = '';
for (const a of artifacts) {
  tableRows += `| \`${a.target}\` | ${a.platform} | \`${a.archive}\` | \`${a.sha256}\` |\n`;
}

const notes = `## BeliefLang ${version}

BeliefLang ${version} is the first release powered by the **canonical native Rust interpreter** (\`bel\`).
All execution is handled directly by high-performance native binaries with zero Node.js runtime required once installed.

### Installation

#### 1. via npm (recommended for Node.js developers)

\`\`\`bash
npm install -g belieflang@next
bel --version
bel run examples/intent.bel --trace
\`\`\`

The \`belieflang\` npm package contains a lightweight native launcher that automatically invokes the precompiled Rust binary for your OS and architecture.

#### 2. via Cargo (crates.io)

\`\`\`bash
cargo install bel-cli --version ${version} --locked
bel --version
\`\`\`

The crate name is \`bel-cli\`; the installed executable is \`bel\`.

#### 3. Precompiled Native Binaries (GitHub Releases)

Download the archive for your platform from the table below, extract it, and place \`bel\` (or \`bel.exe\`) in your \`PATH\`:

| Target Triple | Platform | Archive File | SHA-256 Checksum |
|---|---|---|---|
${tableRows || '| _Pending build_ | _Pending build_ | _Pending build_ | _Pending build_ |\n'}

#### Linux glibc / musl Compatibility

Linux release binaries are statically linked against **musl libc** (\`x86_64-unknown-linux-musl\` and \`aarch64-unknown-linux-musl\`).
A single binary per architecture runs on all major Linux distributions:
- **glibc-based**: Ubuntu, Debian, Fedora, CentOS, RHEL, Arch Linux, openSUSE
- **musl-based**: Alpine Linux, Void Linux (musl)

No external shared C library or OpenSSL dependency is required (cryptography uses statically compiled \`ring\` with rustls).

### Checksum Verification

To verify the integrity of a downloaded release archive:

\`\`\`bash
# macOS / Linux
sha256sum -c bel-${version}-<target>.tar.gz.sha256

# Windows (PowerShell)
Get-FileHash bel-${version}-x86_64-pc-windows-msvc.zip -Algorithm SHA256
\`\`\`
`;

writeFileSync(outFile, notes);
console.log(`Generated release notes for ${version} at ${outFile}`);
