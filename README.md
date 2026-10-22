# BeliefLang

A probabilistic programming language and native runtime for structured beliefs, uncertainty, provenance, and deterministic decision-making in AI agents.

AI agents already support memory and state. BeliefLang makes beliefs, uncertainty, provenance (where information came from), and decision rules explicit. The goal is to maintain structured belief snapshots, update them as new observations arrive, and use deterministic code for facts and decisions that do not need another LLM call.

BeliefLang is implemented as a native **Rust** interpreter and workspace with reusable library crates, an executable CLI (`bel`), and integrations for local heuristic inference, TypeSafe Jev, and OpenAI.

## A small `.bel` example

```bel
belief intent exclusive closed {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

when confidence(intent.book_flight) > 0.7:
  call search_flights()
```

The rule calls a tool when the stored flight-intent score exceeds 0.7. It needs no model call to evaluate that condition. The CLI's built-in `search_flights()` is a local demo tool that returns sample data; it does not book travel. See [language semantics](docs/semantics.md) and [runnable examples](examples/).

## Quick start

Requires a standard Rust toolchain (Rust 1.80+ or latest stable):

```bash
git clone https://github.com/belieflang/belieflang.git
cd belieflang

# Build and run with cargo
cargo run -p bel-cli -- run examples/intent.bel --trace
```

To install the native `bel` CLI globally:

```bash
cargo install --path crates/bel-cli
bel run examples/intent.bel --trace
```

Run test suite and linter:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Try model inference

The local heuristic engine is the default. Built-in adapters support OpenAI and TypeSafe Jev. Live provider calls may incur costs.

### Local Heuristic (Default)

Runs offline with deterministic heuristic extraction:

```bash
bel run examples/intent.bel --trace
```

### OpenAI

Set `OPENAI_API_KEY` in your environment (and optionally `OPENAI_MODEL`):

```bash
OPENAI_API_KEY="your-key" bel run examples/chatgpt_hotel.bel --engine chatgpt --trace --usage
```

### TypeSafe Jev

Set `TYPESAFE_API_KEY` in your environment (and optionally `JEV_MODEL`):

```bash
TYPESAFE_API_KEY="your-key" bel run examples/jev_intent.bel --engine jev --trace --usage
```

For custom providers, implement the `InferBeliefsAdapter` trait when constructing `BeliefRuntime` in Rust.

## Architecture

BeliefLang is organized as a Cargo workspace with four focused crates:

```text
belieflang/
├── Cargo.toml
├── crates/
│   ├── bel-syntax/      # Lexer, recursive-descent parser, AST
│   ├── bel-runtime/     # Belief interpreter, provenance, snapshots, factual memory, decision guard
│   ├── bel-providers/   # Heuristic, TypeSafe Jev, and OpenAI inference adapters
│   └── bel-cli/         # Native `bel` CLI executable
├── examples/            # Runnable .bel programs
└── docs/                # Language semantics and research reports
```

### Crate APIs

- **`bel-syntax`**: exports `parse`, `tokenize`, `strip_comments`, and AST types (`Statement`, `BeliefBlock`, `Rule`, `ConditionExpression`).
- **`bel-runtime`**: exports `BeliefRuntime`, `ToolRegistry`, `FactMemory` (opt-in typed factual delta memory), `AgentDecisionGuard` (deterministic fail-closed decision policy), snapshot types, and provenance models.
- **`bel-providers`**: exports `JevInferAdapter`, `OpenAIInferAdapter`, `HttpTransport`, and mockable transport abstractions for deterministic contract tests.
- **`bel-cli`**: provides the `bel run <file.bel>` command with `--trace`, `--engine`, and `--usage` flags.

## Latest benchmark: completed incremental-memory pilot

The pilot compared full history on demand, rolling summaries, plain typed JSON, and BeliefLang v3 with GPT-6 Luna. The table totals all cases and both demand schedules. Costs include state updates, question routing, and retrieval.

| Strategy | Accuracy | Estimated LLM cost |
|---|---:|---:|
| Full history | 89.22% | $0.00598334 |
| Rolling summary | 91.18% | $0.01089550 |
| Plain JSON | 100% | $0.00440132 |
| BeliefLang v3 | 100% | $0.00440352 |

BeliefLang v3's structured state reduced estimated LLM costs by **26.4% compared with full history** and **59.6% compared with rolling summaries** in this pilot. **JSON performed essentially identically to BeliefLang.** The measured gains came from structured state and deterministic processing, not the language itself.

This was **one repetition across three scripted 24-turn conversations**, each tested under sparse and dense demand. The 100% scores describe these cases, not general reliability. Cost estimates use frozen rates with a 10% premium assumption; they are not invoice charges.

See the [full findings and limitations](docs/incremental-memory-pilot-results.md), [frozen methodology](docs/incremental-memory-pilot.md), and [reproducible results and offline audit](benchmarks/results/incremental-pilot-2026-10-18/README.md).

## Current features and limitations

- **Language and CLI:** belief blocks with exclusive/multi and open/closed modes; `confidence()` and `entropy()`; variables, compound conditions, tool return values, observations, inference/merge statements, and execution traces.
- **Runtime APIs:** save/restore belief snapshots and inspect provenance with `get_provenance()` and `explain_belief("intent.book_flight")`.
- **Opt-in v3 components:** typed atomic deltas, explicit uncertain/conflicting/cleared states, source-tracked history, original/previous-value retrieval, snapshot validation, and a deterministic decision guard. These are [runtime APIs](docs/delta-state-v3.md), not additional `.bel` syntax.
- **Inference adapters:** local heuristic, OpenAI, Jev, or custom `InferBeliefsAdapter` implementations.

Model confidence does not verify a fact or authorize an action. Guards depend on trusted host evidence and approvals. V3 change history is bounded, durable state can grow, and automatic archival is not implemented. The runtime does not provide general automatic dependency tracking or selective rule recomputation; the benchmark's fixed dependency cache is a narrower experiment. See the [design and product-viability review](docs/product-viability.md).

## Documentation and additional experiments

- [Language semantics](docs/semantics.md) and [v3 factual memory and decision guards](docs/delta-state-v3.md).
- [Latest pilot findings](docs/incremental-memory-pilot-results.md) and [artifact hashes and reproduction](benchmarks/results/incremental-pilot-2026-10-18/README.md).
- [Historical experiments, provider demos, and commands](docs/experiments.md), with [detailed Jev/GPT methods](docs/jev.md).
- [Multi-domain benchmark commands](benchmarks/README.md), [methodology](docs/multidomain-benchmark.md), and [long-horizon v2 results](docs/long-horizon-v2.md).
- [Product-viability review](docs/product-viability.md), including the comparison with ordinary TypeScript.

## Legacy TypeScript Reference

The original TypeScript implementation is preserved in Git history and under `src/` for historical benchmark replay and reference. Rust is the canonical, maintained implementation of BeliefLang.

## License

[Apache-2.0](LICENSE)
