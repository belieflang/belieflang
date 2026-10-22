# bel-runtime

Interpreter runtime for [BeliefLang](https://github.com/belieflang/belieflang): belief
state, provenance, snapshots, opt-in typed factual memory (`FactMemory`), and the
deterministic fail-closed `AgentDecisionGuard`.

Main entry points: `BeliefRuntime`, `RuntimeOptions`, `ToolRegistry`, and the
`InferBeliefsAdapter` trait for custom inference providers.

This crate is part of the BeliefLang workspace and is versioned in lockstep with
[`bel-syntax`](https://crates.io/crates/bel-syntax),
[`bel-providers`](https://crates.io/crates/bel-providers), and the
[`bel-cli`](https://crates.io/crates/bel-cli) executable.

## License

Apache-2.0
