# BeliefLang Release and Distribution Process

This document describes the architecture, automation, credential management, and step-by-step procedures for releasing BeliefLang.

---

## Architecture Overview

BeliefLang releases are built from the **canonical Rust workspace**:

```text
Cargo Workspace Version (authoritative)
     │
     ├── Cargo Crate Distribution (crates.io)
     │     ├── bel-syntax
     │     ├── bel-runtime
     │     ├── bel-providers
     │     └── bel-cli (binary target: bel)
     │
     ├── Standalone Native Binaries (GitHub Releases)
     │     ├── bel-<version>-aarch64-apple-darwin.tar.gz
     │     ├── bel-<version>-x86_64-apple-darwin.tar.gz
     │     ├── bel-<version>-x86_64-unknown-linux-musl.tar.gz
     │     ├── bel-<version>-aarch64-unknown-linux-musl.tar.gz
     │     └── bel-<version>-x86_64-pc-windows-msvc.zip
     │
     └── npm Distribution
           ├── @belieflang/cli-darwin-arm64
           ├── @belieflang/cli-darwin-x64
           ├── @belieflang/cli-linux-x64
           ├── @belieflang/cli-linux-arm64
           ├── @belieflang/cli-win32-x64
           └── belieflang (lightweight native launcher)
```

### Key Principles

1. **Rust is Canonical**: All execution occurs inside the native Rust binary. The npm package contains zero TypeScript/JavaScript interpreter code.
2. **Single Source of Truth**: The `[workspace.package] version` in the root `Cargo.toml` is authoritative.
3. **No Automatic Publish on Merge**: Standard CI on PRs and merges to `main` runs tests and checks only. It never publishes or exposes release tokens.
4. **Guarded Multi-Stage Release Workflow**: The `.github/workflows/release.yml` workflow separates **Build**, **Validate**, and **Publish** stages. The `publish` stage is protected by a GitHub Environment requiring explicit approval.

---

## Supported Release Targets

| Target Triple | Platform | Format | Runner / Build Method |
|---|---|---|---|
| `aarch64-apple-darwin` | macOS ARM64 (Apple Silicon) | `.tar.gz` | `macos-14` runner |
| `x86_64-apple-darwin` | macOS x86_64 (Intel) | `.tar.gz` | `macos-14` runner (cross-compile / Rosetta) |
| `x86_64-unknown-linux-musl` | Linux x86_64 (static musl) | `.tar.gz` | `ubuntu-latest` with `musl-tools` |
| `aarch64-unknown-linux-musl` | Linux ARM64 (static musl) | `.tar.gz` | `ubuntu-24.04-arm` with `musl-tools` |
| `x86_64-pc-windows-msvc` | Windows x86_64 | `.zip` | `windows-latest` |

---

## Security & Publishing Credentials

### GitHub Actions Environment Protection

All publishing jobs run within the GitHub Environment named:

```text
release
```

**Recommended GitHub Repository Settings:**
1. Navigate to **Settings → Environments → release**.
2. Enable **Required reviewers** (specify project maintainers).
3. Restrict deployment branches to `main` and `refs/tags/v*`.

### Secret Requirements

The following repository secrets must be configured (or scoped to the `release` environment):

| Secret Name | Purpose | Configuration Notes |
|---|---|---|
| `CARGO_REGISTRY_TOKEN` | Publishing crates to crates.io | Standard crates.io token with `publish-new` and `publish-update` scopes for the crates. Alternatively, OIDC trusted publishing via `rust-lang/crates-io-auth-action@v1`. |
| `NPM_TOKEN` | Publishing to npmjs.com | Granular access token with write permission for `@belieflang` scope and `belieflang` package. |
| `GITHUB_TOKEN` | Creating GitHub Release and uploading assets | Provided automatically by GitHub Actions (`contents: write`). |

---

## Release Tooling CLI Reference

The repository provides automated release scripts under `scripts/release/`:

### 1. Version Manager (`version.mjs`)

```bash
# Print the current authoritative workspace version
node scripts/release/version.mjs print

# Validate consistency across Cargo.toml, Cargo.lock, crates, npm packages, and docs
node scripts/release/version.mjs check [--expect <version>] [--tag <v-version>]

# Bump/set a new version across all packages and documentation
node scripts/release/version.mjs set <new-semver>
```

### 2. Smoke Tester (`smoke-test.mjs`)

```bash
# Verify a compiled native bel binary or npm launcher
node scripts/release/smoke-test.mjs --bin path/to/bel
```

### 3. Binary Packager (`package-binary.mjs`)

```bash
# Package a compiled bel executable into a release archive with SHA-256 and metadata
node scripts/release/package-binary.mjs --target <triple> --bin <path> --out <dir>
```

### 4. npm Package Stager (`stage-npm.mjs`)

```bash
# Assemble platform packages and belieflang launcher from release archives
node scripts/release/stage-npm.mjs --artifacts <artifacts-dir> --out <npm-dist-dir>
```

### 5. Crate Publisher (`publish-crates.mjs`)

```bash
# Dry run publication in topological dependency order
node scripts/release/publish-crates.mjs --dry-run

# Publish crates to crates.io (safe against retries and already-published versions)
node scripts/release/publish-crates.mjs
```

### 6. npm Publisher (`publish-npm.mjs`)

```bash
# Publish staged packages to npm under dist-tag (default: next for prereleases)
node scripts/release/publish-npm.mjs --tarballs npm-dist/tarballs --tag next [--dry-run]
```

---

## Step-by-Step Instructions: Publishing `0.2.0-alpha.0`

### Step 1: Verify Local Workspace Consistency

Ensure the repository is clean and passes all validation:

```bash
# Verify formatting, linter, tests, and release build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --workspace --release

# Run smoke test on the release binary
node scripts/release/smoke-test.mjs --bin target/release/bel

# Check version consistency
node scripts/release/version.mjs check --expect 0.2.0-alpha.0

# Verify historical legacy benchmarks
npm run benchmark:multidomain:validate
npm run benchmark:long-horizon:validate
npm run benchmark:v3:validate
```

### Step 2: Merge Pull Request to `main`

Create and merge the PR for the native distribution branch into `main`.
Standard CI will run and verify the build. It will **not** trigger any release publishing.

### Step 3: Trigger the Release Workflow

#### Option A: Manual Trigger via GitHub Actions UI / CLI

Run the release workflow with `workflow_dispatch`:

```bash
gh workflow run release.yml -f npm_tag=next -f dry_run=false
```

#### Option B: Push a Git Release Tag

```bash
git tag -a v0.2.0-alpha.0 -m "BeliefLang v0.2.0-alpha.0"
git push origin v0.2.0-alpha.0
```

### Step 4: Approve the Deployment

1. The `build` and `validate` jobs will compile and verify all 5 platform binaries, test the npm packages, and generate release checksums and notes.
2. The `publish` job will pause with an environment approval prompt in the GitHub Actions UI.
3. Maintainers review the build summary and approve the deployment.
4. The workflow will:
   - Publish `bel-syntax`, `bel-runtime`, `bel-providers`, and `bel-cli` to crates.io.
   - Publish `@belieflang/cli-*` platform packages and `belieflang` to npm under the `next` tag.
   - Create GitHub Release `v0.2.0-alpha.0` with native binary archives and SHA-256 checksums.

### Step 5: Post-Release Verification

Test the published release from a clean machine:

```bash
# Test npm installation
npx belieflang@next --version
npx belieflang@next run examples/intent.bel --trace

# Test Cargo installation
cargo install bel-cli --version 0.2.0-alpha.0 --locked
bel --version
```
