# @belieflang/cli-darwin-x64

This package contains the native `bel` executable of [BeliefLang](https://github.com/belieflang/belieflang) for **macOS (Intel, x86_64)** (Rust target `x86_64-apple-darwin`).

Do not install it directly. Install the [`belieflang`](https://www.npmjs.com/package/belieflang) package, which selects the correct platform package automatically:

```bash
npm install -g belieflang@next
bel --version
```

The binary in this package is byte-identical to the one in the matching GitHub release archive `bel-<version>-x86_64-apple-darwin`, and its version always equals the `belieflang` launcher version.
