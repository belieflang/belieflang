# belieflang

The npm distribution of [BeliefLang](https://github.com/belieflang/belieflang), a
probabilistic programming language for structured beliefs, uncertainty, provenance,
and deterministic decision-making in AI agents.

Installing this package gives you the **native Rust `bel` interpreter**. The package is
a thin launcher: npm automatically installs a prebuilt binary for your platform as an
optional dependency, and `bel` runs that binary directly. No Rust toolchain is needed,
nothing is downloaded or compiled during installation, and no install scripts run.

## Install

```bash
npm install -g belieflang@next
bel --version
bel run example.bel --trace
```

Prereleases are published under the `next` dist-tag. Also works with `pnpm add -g`,
`yarn global add`, and `bun add -g`, or as a project dependency (`npx bel ...`).

Node.js (18+) is only used to start the launcher; the interpreter itself is a native
executable.

## Supported platforms

| `process.platform-arch` | Platform package | Rust target |
|---|---|---|
| `darwin-arm64` | `@belieflang/cli-darwin-arm64` | `aarch64-apple-darwin` |
| `darwin-x64` | `@belieflang/cli-darwin-x64` | `x86_64-apple-darwin` |
| `linux-x64` | `@belieflang/cli-linux-x64` | `x86_64-unknown-linux-musl` (static) |
| `linux-arm64` | `@belieflang/cli-linux-arm64` | `aarch64-unknown-linux-musl` (static) |
| `win32-x64` | `@belieflang/cli-win32-x64` | `x86_64-pc-windows-msvc` |

Linux binaries are statically linked and run on glibc and musl (Alpine) distributions.

## Troubleshooting

- **"native binary package ... is not installed"**: optional dependencies were skipped
  (`--omit=optional`, `--no-optional`, or a lockfile created on another OS). Reinstall
  with `npm install -g belieflang@next --include=optional`.
- **Unsupported platform**: install with `cargo install bel-cli --locked --version <version>`
  or download a binary from [GitHub Releases](https://github.com/belieflang/belieflang/releases).
- **Custom binary**: set `BELIEFLANG_BINARY=/path/to/bel` to make the launcher run a
  specific executable.

## JavaScript API and migration from 0.1.x

`belieflang@0.1.x` shipped the historical TypeScript interpreter. Starting with 0.2.0,
the npm package contains **no interpreter code**; all execution happens in the Rust
binary, so deep imports such as `belieflang/dist/src/runtime.js` no longer exist.
Projects that depend on the TypeScript modules should pin `belieflang@0.1.x`.

To drive the native CLI from JavaScript, spawn the binary:

```js
const { spawnSync } = require('node:child_process');
const { binaryPath } = require('belieflang');

const result = spawnSync(binaryPath(), ['run', 'example.bel', '--trace'], {
  encoding: 'utf8',
});
console.log(result.stdout);
```

Exports: `binaryPath()`, `platformPackageName()`, `version`, `PLATFORMS`.

## License

Apache-2.0
