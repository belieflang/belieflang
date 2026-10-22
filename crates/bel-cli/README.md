# bel-cli

The native `bel` command-line interpreter for [BeliefLang](https://github.com/belieflang/belieflang),
a probabilistic programming language for structured beliefs, uncertainty, provenance, and
deterministic decision-making in AI agents.

## Install

```bash
# Prereleases must be requested explicitly with --version.
cargo install bel-cli --version 0.2.0-alpha.0 --locked
bel --version
```

The crate is named `bel-cli`; the installed executable is `bel`.

Prebuilt binaries (no Rust toolchain required) are also available via npm
(`npm install -g belieflang@next`) and from
[GitHub Releases](https://github.com/belieflang/belieflang/releases).
See the [installation guide](https://github.com/belieflang/belieflang/blob/main/docs/installation.md).

## Usage

```bash
bel run examples/intent.bel --trace
bel run program.bel --engine heuristic|jev|chatgpt [--trace] [--usage]
bel --version
bel --help
```

## License

Apache-2.0
