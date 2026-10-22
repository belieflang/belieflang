# Installing BeliefLang

BeliefLang provides a native **Rust interpreter** executable named `bel`.

You can install `bel` using any of three channels:

1. [npm (`belieflang@next`)](#1-npm-recommended-for-nodejs-developers) — Precompiled native binaries via a thin launcher
2. [Cargo (`cargo install bel-cli`)](#2-cargo-recommended-for-rust-developers) — Built from source via crates.io
3. [GitHub Releases](#3-github-releases-precompiled-binaries) — Standalone precompiled native archives

---

## 1. npm (Recommended for Node.js developers)

Install the global `belieflang` package:

```bash
npm install -g belieflang@next
```

Verify the installation:

```bash
bel --version
bel run examples/intent.bel --trace
```

### How the npm package works

- The `belieflang` npm package is a **thin native launcher**. It contains **no JavaScript or TypeScript interpreter**.
- npm automatically installs a platform-specific optional dependency matching your OS and architecture (e.g. `@belieflang/cli-darwin-arm64` or `@belieflang/cli-linux-x64`).
- When you invoke `bel`, the launcher forwards CLI arguments, standard I/O streams, exit codes, and signals directly to the native Rust executable.
- **Node.js is not required** to run the interpreter once the binary is located.
- Works seamlessly with alternative package managers:
  ```bash
  pnpm add -g belieflang@next
  yarn global add belieflang@next
  bun add -g belieflang@next
  ```
- Or run without global installation via `npx`:
  ```bash
  npx belieflang@next run examples/intent.bel --trace
  ```

### npm Troubleshooting

- **`optional dependency skipped / platform binary not installed`**:
  If optional dependencies were disabled during installation (`--omit=optional` or `--no-optional`), reinstall with:
  ```bash
  npm install -g belieflang@next --include=optional
  ```
- **`Unsupported platform`**:
  If your platform is not in the precompiled list, install via Cargo or download a release archive.
- **`Custom binary override`**:
  You can point the launcher to any custom `bel` executable by setting:
  ```bash
  export BELIEFLANG_BINARY=/path/to/custom/bel
  ```

---

## 2. Cargo (Recommended for Rust developers)

Install directly from crates.io using Cargo (Rust 1.80+):

```bash
cargo install bel-cli --version 0.2.0-alpha.0 --locked
```

The published crate name is **`bel-cli`**; the installed binary command is **`bel`**.

Verify the installation:

```bash
bel --version
bel run examples/intent.bel --trace
```

To update to the latest release:

```bash
cargo install bel-cli --version 0.2.0-alpha.0 --locked --force
```

---

## 3. GitHub Releases (Precompiled Binaries)

Download precompiled standalone archives from [GitHub Releases](https://github.com/belieflang/belieflang/releases).

### Supported Platforms and Targets

| Operating System | Architecture | Rust Target Triple | Archive Format |
|---|---|---|---|
| **macOS** | Apple Silicon (ARM64) | `aarch64-apple-darwin` | `.tar.gz` |
| **macOS** | Intel (x86_64) | `x86_64-apple-darwin` | `.tar.gz` |
| **Linux** | 64-bit x86 (`x86_64`) | `x86_64-unknown-linux-musl` | `.tar.gz` |
| **Linux** | 64-bit ARM (`aarch64`) | `aarch64-unknown-linux-musl` | `.tar.gz` |
| **Windows** | 64-bit x86 (`x86_64`) | `x86_64-pc-windows-msvc` | `.zip` |

### Linux glibc / musl Compatibility

Linux release binaries are statically linked using **musl libc** (`x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`).
Because they are fully static and contain no dynamic glibc dependencies:
- They run on **any Linux distribution** regardless of glibc version (Ubuntu 18.04+, Debian, Fedora, RHEL, CentOS, Arch, openSUSE).
- They run directly on **musl-based distributions** such as Alpine Linux and Void Linux.
- Cryptography uses static `ring` / rustls; no system OpenSSL library is required.

### Manual Installation Steps

#### macOS / Linux:

```bash
# 1. Download release archive and checksum
VERSION="0.2.0-alpha.0"
TARGET="aarch64-apple-darwin" # choose target from table above
curl -LO "https://github.com/belieflang/belieflang/releases/download/v${VERSION}/bel-${VERSION}-${TARGET}.tar.gz"
curl -LO "https://github.com/belieflang/belieflang/releases/download/v${VERSION}/bel-${VERSION}-${TARGET}.tar.gz.sha256"

# 2. Verify SHA-256 checksum
sha256sum -c "bel-${VERSION}-${TARGET}.tar.gz.sha256"

# 3. Extract and install into PATH
tar -xzf "bel-${VERSION}-${TARGET}.tar.gz"
sudo install -m 755 "bel-${VERSION}-${TARGET}/bel" /usr/local/bin/bel

# 4. Verify
bel --version
```

#### Windows:

1. Download `bel-0.2.0-alpha.0-x86_64-pc-windows-msvc.zip` from GitHub Releases.
2. In PowerShell, verify the SHA-256 hash:
   ```powershell
   Get-FileHash bel-0.2.0-alpha.0-x86_64-pc-windows-msvc.zip -Algorithm SHA256
   ```
3. Extract `bel.exe` and place it in a directory in your system `Path` (such as `C:\Program Files\belieflang\` or `%LOCALAPPDATA%\Programs\belieflang\`).
4. Test in PowerShell or Command Prompt:
   ```powershell
   bel --version
   ```

---

## Verifying Your Installation

Once installed, verify that BeliefLang executes and runs the example program:

```bash
bel run examples/intent.bel --trace
```

Expected output:
```text
[trace] call search_flights()
[state]
  intent [exclusive/closed]: book_flight=0.820, book_hotel=0.120, unknown=0.060
  user [multi/closed]: budget_sensitive=0.910, prefers_direct=0.840
...
[ask_user] I found flight options.
```
