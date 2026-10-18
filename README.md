# BeliefLang

An experimental language and runtime for structured beliefs, uncertainty, and decision-making in AI agents.

AI agents already support memory and state. BeliefLang explores making beliefs, uncertainty, provenance (where information came from), and decision rules explicit. The goal is to maintain structured belief snapshots, update them as new information arrives, and use deterministic code for facts and decisions that do not need another LLM call.

Simplifying information has trade-offs: a snapshot or summary can lose details that become important later. BeliefLang is an experimental TypeScript implementation, and whether it needs a dedicated language rather than a TypeScript library remains an open design question.

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

Use Node.js 22 or later:

```bash
git clone https://github.com/belieflang/belieflang.git
cd belieflang
npm ci
npm run build
node dist/src/cli.js run examples/intent.bel --trace
```

This runs the larger intent example with local demo tools and requires no API key. To run the snippet above, save it as `example.bel` and use `node dist/src/cli.js run example.bel --trace`.

After building, run `npm test` for offline tests or `node scripts/audit-incremental-pilot.mjs` to verify the archived pilot without inference.

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
- **Runtime APIs:** save/restore belief snapshots and inspect provenance with `getProvenance()` and `explainBelief("intent.book_flight")`.
- **Opt-in v3 TypeScript components:** typed atomic deltas, explicit uncertain/conflicting/cleared states, source-tracked history, original/previous-value retrieval, snapshot validation, and a deterministic decision guard. These are [runtime APIs](docs/delta-state-v3.md), not additional `.bel` syntax.
- **Inference adapters:** local heuristic demonstrations plus OpenAI and Jev integrations. Provider inference requires credentials and incurs API costs; the quick start above runs locally.

Model confidence does not verify a fact or authorize an action. Guards depend on trusted host evidence and approvals. V3 change history is bounded, durable state can grow, and automatic archival is not implemented. The runtime does not provide general automatic dependency tracking or selective rule recomputation; the benchmark's fixed dependency cache is a narrower experiment. See the [design and product-viability review](docs/product-viability.md).

## Documentation and additional experiments

- [Language semantics](docs/semantics.md) and [v3 factual memory and decision guards](docs/delta-state-v3.md).
- [Latest pilot findings](docs/incremental-memory-pilot-results.md) and [artifact hashes and reproduction](benchmarks/results/incremental-pilot-2026-10-18/README.md).
- [Historical experiments, provider demos, and commands](docs/experiments.md), with [detailed Jev/GPT methods](docs/jev.md).
- [Multi-domain benchmark commands](benchmarks/README.md), [methodology](docs/multidomain-benchmark.md), and [long-horizon v2 results](docs/long-horizon-v2.md).
- [Product-viability review](docs/product-viability.md), including the comparison with ordinary TypeScript.

## Roadmap

- Evaluate longer conversations and cheaper-model updates against optimized JSON and full-history baselines, as [proposed in the research report](docs/incremental-memory-pilot-results.md#one-proposed-next-experiment-not-authorized-or-implemented).
- Investigate general dependency tracking and selective recomputation; these are proposed work.
- Use evidence from those comparisons to decide whether to maintain a dedicated language or focus on TypeScript components.

## License

[Apache-2.0](LICENSE)
