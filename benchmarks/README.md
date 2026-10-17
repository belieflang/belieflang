# Benchmarks

Existing travel benchmarks live in `src/*benchmark.ts`; their recorded runs are in
`benchmarks/results/`, with methodology in [the Jev notes](../docs/jev.md).
The multi-domain benchmark is a separate experiment and does not replace those results.

## Multi-domain benchmark

The fixture messages, domains, and hand-authored labels were supplied in
`belieflang-multidomain-benchmark.zip`. They are preserved in
[`src/multidomain_cases.ts`](../src/multidomain_cases.ts). The archive's standalone
fetch implementation was adapted into a TypeScript runner that reuses
`createOpenAIInferAdapter` and `BeliefRuntime`. No archive instructions are executed
as setup scripts.

Requires installed repository dependencies and Node.js supporting
`--env-file-if-exists` (the recorded run used Node 25.1.0). The npm commands build the runner;
`.env` is loaded when present and existing environment values take precedence.

```bash
npm ci
npm run benchmark:multidomain:validate
npm run build
npm test

# Three repetitions, all three workflows: 900 serial model requests.
# Reads OPENAI_API_KEY and optional OPENAI_MODEL (default: gpt-6-luna).
npm run benchmark:multidomain -- --runs 3 \
  --output benchmarks/results/multidomain-local.json

# Optional smaller experiment: 200 calls, no provider-managed state.
npm run benchmark:multidomain -- --runs 1 \
  --workflows full_history,belief_snapshot \
  --output benchmarks/results/multidomain-two-workflows.json
```

`--validate` checks fixtures without any model calls or API key. The runner rejects
unknown options, duplicate workflows, missing argument values, and repetitions
outside 1–20. Without `--output`, it uses a timestamped file under
`benchmarks/results/`. Output files are atomically replaced after every successful
turn; choose a new filename for a separate experiment.

For dollar estimates, explicitly provide **all four** USD-per-million-token rates:

```bash
export MODEL_INPUT_USD_PER_M=0.10
export MODEL_CACHED_INPUT_USD_PER_M=0.01
export MODEL_CACHE_WRITE_USD_PER_M=0.125
export MODEL_OUTPUT_USD_PER_M=0.50
export MODEL_PRICING_SOURCE='OpenAI Standard short-context gpt-6-luna; checked 2026-10-17; https://developers.openai.com/api/docs/pricing'
```

These example rates apply to `gpt-6-luna` Standard short-context requests as checked
on the stated date; verify rates before using a different model, tier, or date.
No pricing configuration means `estimated_usd: null`. Partial or invalid pricing
configuration is rejected, and all rates plus their source are recorded.

See [methodology, limitations, and recorded findings](../docs/multidomain-benchmark.md).

## Rebuilding the recovered execution summary

The recorded experiment encountered malformed JSON twice. Both failed raw reports
are retained. A separate recovery restarts the entire incomplete full-history pass
and runs the remaining provider pass. To rebuild the summary without model calls:

```bash
npm run benchmark:multidomain:report -- \
  benchmarks/results/multidomain-2026-10-17-manifest.json \
  benchmarks/results/multidomain-2026-10-17-summary.json
```

The manifest selects nine complete 100-turn workflow passes. The assembler rejects
partial or duplicate passes, checks matching model/fixture/implementation/pricing,
and records source hashes. Summary workflow costs use the 900 selected calls;
`execution_accounting` additionally includes discarded successful prefixes and
explicitly flags unknown usage for failed requests. The recovered summary is
labeled `completed_with_workflow_restart`, not an uninterrupted execution.
