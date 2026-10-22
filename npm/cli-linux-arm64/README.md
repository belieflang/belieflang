# @belieflang/cli-linux-arm64

This package contains the native `bel` executable of [BeliefLang](https://github.com/belieflang/belieflang) for **Linux (ARM64, static musl; runs on glibc and musl distributions)** (Rust target `aarch64-unknown-linux-musl`).

Do not install it directly. Install the [`belieflang`](https://www.npmjs.com/package/belieflang) package, which selects the correct platform package automatically:

```bash
npm install -g belieflang@next
bel --version
```

The binary in this package is byte-identical to the one in the matching GitHub release archive `bel-<version>-aarch64-unknown-linux-musl`, and its version always equals the `belieflang` launcher version.
