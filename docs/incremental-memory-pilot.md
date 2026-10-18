# Incremental-memory pilot: protocol 1

This evaluation asks whether persistent structured state saves **cumulative inference work at comparable task accuracy**. It does not evaluate language syntax, change the product direction, introduce adaptive model routing or add a DSL feature. It starts from `main` at `09b4b6e`, after PR #6.

**No paid calls have been authorized or executed. Actual Luna compatibility, provider tokens, live accuracy, latency and spend remain unverified.** The local smoke command is runnable, but requires separate authorization. Offline software checks and conditional cost projections are not model results.

## New cases and freeze

[Public cases](../benchmarks/incremental/cases.json) contain three newly authored conversations: a freight crate, a refrigerated specimen and gallery access. Each has 24 public events, with distinct chronologies for authorization changes, unrelated changes and competing reports. They include:

- Typed authoritative receipts and explicit allow/revoke events.
- Ordinary conversational messages with no changes, an exact adjacent duplicate, and a same-value factual restatement. No private no-change flag reaches the scheduler.
- An unverified conflicting report, an explicit reversion to a formerly verified value, a new approval without fresh verification, and later fresh verification.
- Changes to a dependent numeric/boolean constraint and a nondependent auxiliary fact, including its withdrawal.
- Current and original-value lookups, initially absent facts, and natural-language questions requiring field/temporal routing. Historical auxiliary lookups follow withdrawals; their first receipts arrive at different points in the three conversations.

These cases were written independently of the previous fixture sets and before any pilot model responses. They are **not externally blinded**, and share a deliberately narrow fact-transition contract. Controlled update phrasing reduces ambiguity; this inexpensive pilot tests bookkeeping and incremental work, not broad language understanding or real-world reliability. The two schedules reuse the same conversations; they are paired workloads, not six independent samples.

Sparse demand probes eleven selected events per conversation; dense demand probes every non-question event. Each probe requests the same four lookups (current numeric, current auxiliary, original numeric, current boolean) and the same simulated dependent action. Two additional natural-language questions per conversation are routed and answered in both schedules. This yields 24 method/case/schedule runs and 1,632 scored factual opportunities, with repeated observations that must not be treated as independent trials.

[Private gold](../benchmarks/incremental/private-gold.json) means **scorer-only**, not secret from repository readers. It contains separately authored semantic timelines, source turns, question routes and action labels. Its queries contain only field and current/original mode; missing/conflicting categories exist only in gold answer labels. The runner accepts a public case and a one-argument inference function, never an oracle answer. Scoring happens after observation. Tests change the gold without changing requests, check exact public shapes and demonstrate that destroying summaries causes errors and unsafe executions instead of recovering hidden gold.

The [new freeze](../benchmarks/incremental/freeze.json) hashes fixtures, private labels, configuration, prompts, scheduler, adapters, scoring, live accounting, tests, methodology and prepared artifacts. It also verifies both previous freezes and their source dependencies. All previous fixtures, source freezes and results remain unchanged. The old v3 runner deliberately retains its historical behavior; its results remain historical experiments. The corrected v2 adapter lives in this new evaluation namespace, with regression coverage, rather than silently changing the original frozen condition.

## Four fixed methods and equal evidence

| Method                 | Maintenance on ordinary chat                                                                         | Serving requests                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Full history on demand | Append new text; no mandatory extraction                                                             | Batch only unresolved lookups into one model request over the prefix. Memoize replies until potentially relevant new text arrives |
| Rolling summary        | One model update per nonduplicate chat; narrative bounded to 3,200 characters                        | Batch unresolved lookups over actual summary plus trusted host-event ledger; memoize replies                                      |
| Plain typed JSON       | Runtime-validated delta extraction into the competent independent `TypeScriptState` from PR #6       | Deterministic current/history retrieval and policy evaluation                                                                     |
| BeliefLang v3          | Exactly the same delta prompt, schema, evidence and output limits as JSON; use existing `FactMemory` | Deterministic current/history retrieval and policy evaluation                                                                     |

[Runner](../src/incremental/runner.ts), [schemas/prompts](../src/incremental/protocol.ts), [adapters](../src/incremental/memory.ts).

Every method receives the same public source turns, field types, verification and authorization evidence. Host verification is a typed external receipt, **not model confidence**. Host receipts update structured memories directly through `verify()`, including a same-value confirmation after an uncertain revision. No model is asked to repeat a host-supplied value. Summary/full-history caches are updated directly too; host events are retained for subsequent model reads without a paid summary-maintenance call.

All methods use a common deterministic cache for answers already established by typed evidence or a previous read. Original numeric values established by the first typed receipt are permanently available without inference. Before any chat, absent fields are deterministically missing. A new nonduplicate unstructured message invalidates current-value caches for full history/summary, because its affected fields have not yet been extracted. Structured methods pay to extract it and preserve unaffected facts. Same-value restatements can produce an empty patch. Exact adjacent duplicate text is recognized by a common local equality check, with no inference charge. No semantic no-change oracle, keyword shortcut or model-selection policy suppresses other chat maintenance.

Typed probes model an application API supplying the field/temporal operation and action request: **routing cost is zero under that explicit interface assumption**. Arbitrary free-text routing is not supplied for free. Each natural-language question invokes the same fixed Luna router for every method; its schema contains only field and temporal mode, no answer status. Routing calls, failures, tokens and latency are included even when the eventual answer is a deterministic local lookup. A wrong route counts as an incorrect end-to-end answer, even if a coincidentally matching scalar/status is returned. There is no adaptive router or alternate model.

Full history is deliberately allowed memoization, batching and deterministic host lookups. It is not forced to re-read history for every idle turn, known fact or repeated typed probe. Summary pays no needless extraction for typed host facts. Structured methods make no extra answer-generation or decision-model calls. Their benefits must pay for maintenance on ordinary unchanged messages too. All methods retain the original numeric value locally once known. This pilot does not require a model to paraphrase a scalar that an application already has.

The shared decision policy checks the two declared numeric/boolean dependencies, approval scope, latest receipt identity and a business threshold. All tool effects are simulated. Decisions are memoized using only dependencies, their proofs and approval state; an auxiliary fact change does not invalidate that decision. Recomputations/cache hits are CPU-work counters, **not automatically inference savings**. Model work required to establish those dependencies remains charged. Approval records are standing permissions bound to receipt identities, not single-use tickets; a new receipt requires matching fresh scope approval.

A verified value cannot become confirmed again merely by reverting after a conflict. The corrected `VerifiedV2Adapter` uses the actual legacy v2 storage with a sidecar for statuses/revision evidence that its active/cleared format cannot represent. Regression tests compare it with JSON and v3 through conflict, unverified reversion, fresh approval, fresh host verification and withdrawal. V2 is a compatibility regression target, not a fifth ranked pilot condition.

The guard still trusts host identity/receipts and the extracted view of conversation changes. If extraction omits a change altogether or a model falsely cites an old source as current, the host cannot magically discover the omitted semantic change. Such failures must appear in unsafe-action metrics. No method is granted authenticated knowledge of raw-text meaning. These are not real transactional authorization or distributed-system safety guarantees.

## What is measured

Each call records its exact prompt/schema, response, kind, source identity, elapsed round-trip time, returned model/tier/response ID, usage and estimated USD interval. Each checkpoint carries cumulative totals since the start of that method/case/schedule run, including maintenance and routing. Final reports retain all attempts and partial runs, rather than only successful conversations.

- Joint value/status accuracy, value accuracy, status accuracy, source-turn correctness and current/original/conflicting/missing/cleared breakdowns. Natural-language route accuracy is separate; routing failures remain answer failures.
- Unsafe action proposals and executions, safe opportunities/executions and false denials. A proposal means the extracted values satisfy the business predicate before authorization; an execution additionally passes the common guard. A proposal without approval is unsafe under this protocol, even if the guard blocks it.
- Cumulative calls by stage, measured input/output tokens, cached input and cache writes, reasoning tokens if reported, failure counts, round-trip latency and cost per correct answer including all maintenance/routing. Output tokens already include reasoning; they are not added twice.
- State bytes/growth and per-event changed-field counts, decision recomputations/cache hits, and local elapsed time. JSON journal snapshots and v3 snapshots use different encodings, so byte sizes are descriptive, not the main outcome or model-token counts.

The live report's `allPilotAttemptTotals` and full journal include even a terminal attempt that interrupts an unfinished conversation. `coverage` states planned and observed checks/answers. Per-run accuracy describes observed opportunities; a budget-stopped report is **not a complete paired comparison**. Never drop failed or stopped conditions to claim a win. Retried/replacement requests are not part of this pilot. Replaying a journal reconstructs the original measurements without a new API call; request/config/freeze identities must match.

Model usage is read before HTTP/output validation. HTTP errors, malformed JSON, refusals, incomplete responses, unexpected model/tier and local schema failures retain known usage. Missing or invalid usage retains a full request reservation. Raw provider usage is saved and resume recomputes its charges. Interrupted-request latency is unknown (null), rather than a fabricated zero; known latency is reported separately when a total cannot be established. Cache fields absent from the response are **null, not zero**. Known input/output can still be totaled, while unknown cache categories remain unknown; USD is a lower/upper estimate over feasible cache allocations. Cached/read/write counts are subdivisions of input, not extra tokens. The smoke gate requires both cache fields before declaring actual accounting compatible.

USD estimates use the frozen published rates plus the disclosed 10% regional-premium assumption; they are not an invoice or an account-wide spending guarantee. Unknown model/tier stops further dispatch and retains a conservative reservation for reconciliation. Prices, taxes, account entitlement and unrelated account activity require operator review. Raw tokens and actual returned model/tier remain available for recalculation without rewriting responses.

## Offline evidence and analysis plan

[Offline artifact](../benchmarks/incremental/offline.json) is produced by a test-only controlled-text parser that reads the actual request context, not private labels. Its summary representation is serialized test state; a live narrative may differ substantially. All 1,632 factual checks, source turns, question routes and action labels match under that parser. This is software-contract validation, **not 100% Luna accuracy**. Provider tokens and USD remain null. Tests also cover failure billing, cache omissions, cumulative accounting, replay, interrupted reservations and concurrent-journal exclusion.

Expected **offline request schedules**, summed over three conversations:

| Schedule | Full history | Rolling summary | Plain JSON |  V3 |
| -------- | -----------: | --------------: | ---------: | --: |
| Sparse   |           26 |              50 |         30 |  30 |
| Dense    |           32 |              56 |         30 |  30 |

Each cell includes six routing calls. Structured methods also include 24 chat-update calls; summary has 24 summary updates plus unresolved reads. Live failures or different cacheable outputs may alter subsequent read counts. No call-count advantage is assumed: full history currently has fewer scheduled calls under sparse demand. JSON and v3 produce identical prompts under the deterministic trace; equivalent behavior should produce equivalent inference economics. An unexpected difference needs inspection, not a language-superiority claim.

For the authorized pilot, report paired per-case and per-schedule differences in accuracy, unsafe executions, cumulative measured tokens/calls and cost intervals. Compare total USD/correct as well as total spend. Keep routing and maintenance visible. Describe a cost saving only alongside accuracy and safety outcomes; if cost intervals overlap, do not claim a resolved USD winner. Do not extrapolate repeated checkpoints to a 99.5% reliability claim. A later accuracy/cost tradeoff study needs a separately frozen policy and more independent cases; this protocol does not tune thresholds after observing outcomes.

## Cost proposal and local execution

The [plan](../benchmarks/incremental/plan.json) covers both schedules, all four methods and three cases once: **284 expected pilot requests**, plus one smoke request. The proposal is a **separate $2 combined maximum**, allocated $0.30 to smoke and $1.70 to the pilot. It does not reuse PR #6's $5 proposal. Automatic retries: **zero**. Failures consume the same caps; there is no hidden retry allowance or extra diagnostic budget.

Pricing observed on 2026-10-18 UTC from [official Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna): input $0.10/M, cache read $0.01/M, cache write $0.125/M, output $0.50/M. The plan adds 10% to all rates, assumes no cache-read savings, and prices all projected input as cache writes. Long-context multipliers are included in reservations. [Official Responses reference](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create) defines usage; [structured-output documentation](https://developers.openai.com/api/docs/guides/structured-outputs) defines the strict schema contract.

Conditional central projection is approximately **$0.043** for the pilot; stress is approximately **$0.132**, excluding smoke. These use serialized request/output bytes divided by 4 or 3, framing allowances of 200 or 1,000 tokens, and 1x/2x state/output sizes from offline traces. They are not tokenizer measurements or maximum bills. Full output limits, model-generated summary size, schema framing and failure behavior can change actual totals. Do not present these projections as cost results.

Before each request the journal reserves the full 1,050,000-token context at the highest input/cache rate, long-context multipliers and that stage's output limit. This deliberately conservative reservation is about $0.289 per call, despite much smaller expected requests. Unknown billing retains it; known usage replaces it with the conservative cost upper estimate. Byte/framing checks also reject large requests. All calls at that reservation exceed $2, so **completion is not guaranteed**: the local cap stops dispatch first. Five unknown-billing pilot failures can exhaust practical headroom. Never erase a journal/lock or choose a fresh identity to evade the authorized budget.

Offline reproduction, with no credential access or network inference:

```sh
npm run build
npm test
node dist/src/multidomain_benchmark.js --validate
node dist/src/long_horizon_benchmark.js --validate
node dist/src/v3_cli.js --validate
node dist/src/viability/review.js --validate
node dist/src/incremental/cli.js --validate
```

Before the first paid response, maintainers can use `--prepare` to generate only new offline/plan artifacts and `--freeze` to seal this new protocol. They must not regenerate it after inspecting live outcomes; these commands reject an existing default pilot journal containing attempts. Any later corrected experiment needs a different namespace/freeze. CI runs only read-only validation and HTTP-mocked tests, never the paid modes.

**Only after separate human authorization**, explicitly export a local `OPENAI_API_KEY`, review current rates, and run:

```sh
node dist/src/incremental/cli.js --smoke --authorize-paid --max-usd 2
# Inspect benchmarks/results/incremental-pilot/smoke.json and journal.json.
# Proceed only if the smoke passed and the pilot remains within the authorized scope.
node dist/src/incremental/cli.js --live --authorize-paid --max-usd 2
```

These commands reject CI execution and missing authorization flags **before credential access**. They use no dotenv loading, secret discovery, scheduled job or provider-managed history. The smoke uses the actual pilot delta schema with `gpt-6-luna`, default processing tier, reasoning `none`, `store:false` and 256 output tokens. It verifies the real correction, strict output shape, model/tier, actual input/output/cache subdivisions and reconcilable estimated USD before permitting the pilot. The pilot uses 1,024 output tokens and the same fixed Luna transport. All requests are serial, with a 45-second timeout and no automatic retry.

The same locked journal enforces smoke, pilot and combined limits. Results go only to `benchmarks/results/incremental-pilot/`. A failed smoke is recorded and replayed, not paid again silently. Do not commit credentials. Commit reviewed live reports/journals only after a separately authorized run; none is supplied in this PR.

**Current blocker:** actual API compatibility and token accounting cannot be verified without a paid call. Separate authorization has not been given, so the delivered verification uses HTTP mocks only. There is no live finding yet that persistent state is cheaper at comparable accuracy.
