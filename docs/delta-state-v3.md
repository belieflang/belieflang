# Delta state, provenance and deterministic decisions (v3)

## Finding

V3 adds useful local guarantees: validated atomic deltas, no-op suppression,
source-tracked history, explicit uncertainty/conflicts, and a deterministic action
guard. None requires a new language construct. The guard also works with an
ordinary typed object.

**Plain JSON and v3 perform equally on the offline contracts.** V3 provides a
reusable validated snapshot/history API, but adds storage and implementation
complexity. No live evaluation was authorized or executed. There is no evidence
here of better model accuracy, fewer tokens, lower inference cost, or a unique
BeliefLang safety advantage. The saved replay is a software test, not an LLM
benchmark result.

## Architecture audit

The audit uses the unchanged PR #2 head `c905fbd` as its starting point.
Recorded v1/v2 fixtures, evaluations and reports remain unchanged.

| Existing component | Problem | Smallest change in this PR |
| --- | --- | --- |
| `BeliefRuntime.mergeFactPatch` / v2 snapshots | A set replaces the only retained value, confidence and source turn. A repeated identical value still replaces provenance. Clearing removes the previous value. | An opt-in `FactMemory` component retains current cells separately from change events; identical semantic updates preserve the original cell. Existing v2 APIs keep their behavior. |
| v2 serialized inference context | Every turn includes schema, version, numeric beliefs, confidence and source metadata even when unchanged. | V3 inference context contains only current values, status and unresolved candidates. The schema remains in the stateless request for type checking; this overhead has not disappeared. |
| v2 extraction schema | Per-field set/clear variants, explicit nulls, per-update confidence, and answer/summary fields produce overhead. | A shared typed delta array with a field enum; clear omits value. Host source identifiers never appear in the model output contract. Confidence and basis still cost output tokens. |
| v1 probabilistic classification / settled-field experiments | These predict intent/preferences, not general factual memory. A threshold can reduce repeated numbers but does not verify a fact. | Factual status is independent of the model score; a host verification event is required for `confirmed`. No changes to numeric belief semantics. |
| v2 factual confidence | A high score has no evidence of external verification, conflict state or action authorization. | Explicit status plus separate host approvals and a reusable fail-closed guard. An explicit revision can replace even a confirmed value at low confidence, returning it to uncertain until verified. |
| Existing inference adapters | The classifier adapter validates completed output before invoking its usage callback; malformed/incomplete output can lose otherwise valid usage. It is a classifier rather than a general factual extractor. | The new benchmark transport follows its Responses/structured-output/final-answer convention, but meters before status/JSON validation. The old adapter's behavior and old results are not changed. |
| v1/v2 benchmark design | Full history must update state every turn; a demand-driven application need not. V2 couples answers with maintenance output. | Six separate conditions, including an on-demand full-history baseline with zero idle-turn calls. Maintenance, answer and action calls are all charged. Separating calls can itself disadvantage maintenance methods; it is visible in the totals. |
| Historical questions | V2 has no originals or previous distinct values. An LLM cannot recover evidence that the supplied context no longer contains. | Exact field/temporal retrieval from local events; only selected entries enter the answer request. Routing is supplied to every condition, not solved by an unmetered model. |
| v2 scoring/fixtures | The recorded `event_launch` owner label contradicts the message; exact dates are format-sensitive. Existing reports describe this. | New, separately authored source/transition/answer labels with an offline replay validator. No retroactive correction or reclassification of recorded results. Typed exact string scoring remains a limitation. |
| v1/v2 cost/checkpoints | V1 excludes unavailable failed-call spend; v2 successful-row aggregates need the report's failure reserve. A frozen plan alone does not enforce current inference-source equality on resume. | A source/fixture/configuration hash gate, serial reservation ledger, immutable request identity, no automatic retries, and separate all-attempt accounting. |

Ordinary TypeScript can merge fields, validate types, keep a change list and deny
a tool call. Those operations should not be delegated to an LLM, and their
benefits should not be credited to probabilistic language syntax.

## Runtime API and trust boundary

`FactMemory` and `AgentDecisionGuard` are exported from the package entry point.
`BeliefRuntime` accepts optional memory; `.bel` syntax, existing inference adapter
contracts and the v1/v2 snapshot methods are unchanged.

```ts
const runtime = new BeliefRuntime({}, {
  memory: { schema: { budget: "number", destination: "string", departure_date: "string" } }
});
const memory = runtime.memory!;
memory.apply([
  { op: "set", field: "budget", value: 1500, confidence: 0.95, basis: "explicit" },
  { op: "set", field: "destination", value: "Lisbon", confidence: 0.95, basis: "explicit" },
  { op: "set", field: "departure_date", value: "2030-06-10", confidence: 0.95, basis: "explicit" }
], { turn: 1, id: "chat:1", text: "Original trip request" });

// Extracted from: "Actually change the departure to June 12."
memory.apply([
  { op: "set", field: "departure_date", value: "2030-06-12", confidence: 0.8, basis: "explicit" }
], { turn: 2, id: "chat:2", text: "Actually change the departure to June 12." });

memory.context(); // Current compact facts only, never the entire log.
memory.retrieve("departure_date", "original"); // June 10 with host source reference.
const saved = runtime.getMemorySnapshot(); // Includes current numeric beliefs too.
const restored = new BeliefRuntime({}, { memory: FactMemory.restore(saved) });
restored.loadBeliefSnapshot({ version: 1, beliefs: saved.beliefs });
```

A delta is `set`, `clear`, or `conflict`; set/conflict carry a typed scalar,
confidence and explicit/inferred basis. Fields must be declared (lowercase snake-case identifiers; `constructor` and `prototype` are reserved); enum values,
finite numbers and probability bounds are checked. Duplicate fields, unknown
metadata (including model-supplied source turns), implicit clears and malformed
batches are rejected before mutation. The adapter interprets natural language;
the runtime does not claim to parse negation itself. Tests supply explicit
extracted negations, reversals and corrections.

The host supplies a monotonically increasing turn and stable source ID. Replaying
the same source/patch is idempotent; reuse for a different patch is rejected.
Reordering fields or confirmation keys does not change replay identity. Semantic
no-ops do not change confidence, revision, source or history. In particular, a
new confidence estimate alone cannot rewrite a fact's evidence.

Statuses have distinct meanings:

- `confirmed`: the host independently verified this exact value. Verification is
  the third `apply` argument, paired with a matching set delta and separate from model output. Ordinary user text or an
  LLM's confidence is not independent verification.
- `uncertain`: a current explicit/extracted value without host verification.
- `conflicting`: unresolved competing evidence; there is no canonical value.
- `cleared`: explicit withdrawal/cancellation; unrelated fields remain intact.

The optional `inferredMinConfidence` policy can defer a weak new inference.
Deferred proposals are retained for audit. Contradictory evidence is **never
silently suppressed by that threshold**: it marks the field conflicting and
blocks dependent actions. Explicit revisions always remain eligible, even at a
low score. They resolve a conflict to an uncertain value until the host verifies
it. Missing means no cell; it is different from an explicit clear.

History is append-only per change, with before/after cells and a shared source
excerpt (up to 512 characters). `original`, `previous` (previous distinct scalar)
and bounded `changes` retrieval are local, deterministic operations. Conflicting
candidates are not treated as a historical settled value. The default 256-event
limit rejects a batch atomically rather than pruning evidence. To extend it,
persist a snapshot, explicitly raise `maxHistory`, validate with `restore`, and
replace the component. Automatic archival/compaction is not implemented. Replay
receipts grow with turns, including no-op turns; total durable storage is not
constant, and snapshots are cloned during updates.

V3 restore validates schema, cell types, history linkage, sources, event/status
consistency and receipts. V1 migration retains numeric beliefs and has no invented
facts (`restore(v1, optionalNewFactSchema)`). V2 migration retains current values,
clears and numeric beliefs, marks active values uncertain regardless of score,
and marks history incomplete. `original` retrieval then returns no evidence;
migration cannot recover overwritten facts. Legacy reserved field names require an explicit rename before migration. Reconstructed legacy entries are
ordered by source turn. Numeric beliefs and memory are separate components;
`getMemorySnapshot()` combines them, while `memory.snapshot()` alone does not
read subsequent changes to the runtime's numeric beliefs.

## Deterministic actions

Only the host records approvals, including scope, source and optional expiry.
`guard.execute(view, action, parameters, turn, tool)` calls the simulated tool only
if the latest approval permits that action, every scoped fact is confirmed, each
revision/value still matches the approved scope, and parameters match current
facts. Missing, uncertain, conflicting, cleared, expired, future, revoked or stale
state denies with a reason and evidence references. Reapproval is required after
any semantic change, even a change away and back to the same value.

The guard accepts a structural `FactView`, so JSON receives exactly the same
policy. It is not automatically inserted into existing `.bel` tool dispatch;
applications must route protected actions through it. Approval storage is separate
from memory snapshots; a fresh guard defaults to deny until host approvals are
replayed or renewed. These are in-process checks, not signed permissions,
authentication, a transaction spanning an external service, or protection against
bypassing the guard. A missed unverified extraction can leave stale state looking confirmed;
real irreversible actions still need authoritative host constraint/version
verification. The fault-injection tests explicitly demonstrate that limit.

## Comparative method

The new evaluation has ten 12-turn conversations, two each in travel, operations,
events, projects and commerce: 120 messages, 80 answer tasks and 70 action tasks
per condition/repetition. Separate development fixtures exercise the user's
Lisbon/date-change example, boolean negation and cancellation. Evaluation uses new
values and scenarios rather than the recorded v1/v2 cases or tuned development
cases. Evaluation conversations share a controlled template with different fields
and values; they are not ten independent natural-conversation samples. All cases
are synthetic, authored and visible to the implementer, not externally blinded.

| Condition | Maintenance calls | Evidence supplied for answers |
| --- | --- | --- |
| Full eager | Extract each turn (diagnostic overhead baseline) | All user messages and host events |
| Full query | None on idle turns | All user messages and host events |
| Rolling summary | Replace an LLM summary each turn | Latest summary |
| Plain JSON | Delta extraction each turn, ordinary objects and rules | Compact current state and selective original/previous entries |
| BeliefLang v2 | Set/clear extraction each turn, unchanged v2 runtime | Existing typed v2 snapshot; no added history |
| BeliefLang v3 | Delta extraction each turn | Compact current state and selective original/previous entries |

The JSON implementation is independent merge/history code with no use of `BeliefRuntime`
or `FactMemory`. It shares schema/delta validation and the action guard
so neither baseline is disadvantaged by intentionally unsafe TypeScript. It
supports the default-policy transitions used here. Unlike v3 it is not a
production snapshot migration/restore implementation or configurable policy
component. Those additional guarantees have an implementation cost.

All six conditions use the same model, tasks, host verification and approval
stream, and typed answer/action contracts. No source oracle, expected answer,
gold delta or safety label is serialized by the live transport. New messages are
provided once with preceding context for maintenance; full history includes the
current message in its history as well. This redundancy affects the diagnostic
eager path, not the on-demand baseline.

For full-history/summary tool decisions, the model reports scoped current facts;
only values that match a host verification receipt can be confirmed. Host-derived
verification turns supply revisions; model source identifiers are not accepted.
The memory methods use their stored current cells, with any known mismatch against a newer authoritative host receipt demoted to uncertain for the guard. Approval snapshots for the
non-maintained full-history methods use the same trusted verification stream,
requiring no hidden paid extraction call. They can still fail if inferred current
facts omit a later unverified change, just as a missed delta can affect memory.

Every answer and action proposal is a separate call. Maintenance callers pay for
extraction/summary even on task turns. Extraction is not fused with answering;
fusion could favor some conditions and requires a separately frozen experiment.
Historical routing (field and original/previous kind) is explicit in each task
for every method. V3/JSON select local entries and record their count, bytes and
latency; there is no uncounted retrieval-model call, embedding service or database.
The retrieved entries' bytes are included in the subsequent inference payload.

Metrics include value-only factual accuracy, verification-status accuracy,
combined exact accuracy, current/historical/conflict/missing groups, Brier score
for confidence in the complete answer, input/output/cache-read/cache-write tokens,
estimated total cost and cost per correct answer, call latency, local harness
latency, context/durable bytes per turn, history growth, suppressed no-ops and
actual unnecessary rewrites. Failed answers count as incorrect and receive Brier
loss 1. Call failures remain in usage/cost totals. State-byte totals exclude the
shared guard, fixture definitions and result files for every condition; they
include each method's own required history/receipts. Byte counts are serialized
benchmark prompt/schema payloads, not HTTP framing or token estimates.

An unsafe attempt is a proposed tool execution when the gold policy says deny;
an unsafe execution is one that passes the guard anyway. Safe actions incorrectly
denied are visible separately. Scoring these separately prevents a guarded but
reckless proposer from appearing to make safe decisions.

The v2 condition tests its existing storage/extraction contract, not a rerun of
old v2 prompts, fixture labels or numbers. It cannot represent unresolved
contradictions or original values. A differently augmented v2 application could
add ordinary history/rules and should then be compared with the JSON condition.

## Offline execution and findings

The v3 commands never load `.env` or inspect inference credentials. The direct v1 validator below avoids its legacy npm wrapper’s optional dotenv loader:

```sh
npm ci
npm run build
npm test
node dist/src/multidomain_benchmark.js --validate
npm run benchmark:long-horizon:validate
npm run benchmark:v3:validate
npm run benchmark:v3:offline
```

See the saved [summary](../benchmarks/results/v3-offline.json) and
[gzip raw runs](../benchmarks/results/v3-offline.json.runs.json.gz). The summary
includes the uncompressed raw SHA-256, frozen-input fingerprint, Node version,
configuration and scope of its aggregates. Decompress the raw file to inspect
individual calls, answers, attempts, state growth and retrieval rows.

Three oracle-mock repetitions produce 180 condition/conversation runs. Extraction
returns the fixture delta; full-history answers use the source oracle; the mock
summary is an ideal JSON-encoded summary. This does not test real summary loss or
LLM extraction. Tool proposals deliberately always attempt the requested action,
testing the guard with adversarial proposals rather than claiming model judgment.
All oracle confidences are 1, so Brier values are test arithmetic, not observed
calibration. Offline token and monetary metrics are null, never inferred from
bytes. Local timings include oracle/harness work and are not provider latency.
Repeated deterministic replays are not independent accuracy observations.

| Condition | Mock calls (3 repetitions) | Combined contract matches | Value-only matches | Unsafe attempts / executions | Authorized actions executed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full eager | 810 | 240/240 | 240/240 | 150 / 0 | 60/60 |
| Full query | 450 | 240/240 | 240/240 | 150 / 0 | 60/60 |
| Rolling summary | 810 | 240/240 | 240/240 | 150 / 0 | 60/60 |
| Plain JSON | 810 | 240/240 | 240/240 | 150 / 0 | 60/60 |
| BeliefLang v2 | 810 | 90/240 | 120/240 | 150 / 0 | 60/60 |
| BeliefLang v3 | 810 | 240/240 | 240/240 | 150 / 0 | 60/60 |

V2's missing historical/conflict statuses are deliberately exposed by these new
tasks. This is not a claim that a live v2 model scores 37.5%, or that a live v3
model scores 100%. JSON and v3 have the same calls and mock responses. V3 has
slightly more retrieved metadata and greater durable storage. V2 performs 60
same-value rewrites across the repetitions; JSON and v3 suppress 30 no-op deltas
each. The other repeated scalar update changes host verification status and is
therefore meaningful for their state.

The full-query baseline needs 360 fewer calls than either memory method in this
short, task-heavy fixture. No cost or token conclusion follows from call count
alone, but it is an important competitor. All methods deny 150 unsafe proposals
with the shared guard, so safety is not a unique v3 win. The useful v3 improvement
is a tested, reusable history/provenance and validation API over v2. Whether that
API's overhead is acceptable depends on the application. For this task, ordinary
typed JSON plus rules is simpler and equally capable on the evaluated semantics.

Validation passed: TypeScript build, all 80 tests, v1/v2/v3 fixture checks and the frozen-input check. The compressed raw replay hash and its recomputed aggregates also match the saved summary.

Across 30 runs per condition, average final durable state is 5,359.1 bytes for JSON and 5,787.1 bytes for v3 (about 8% larger), excluding the shared guard in both cases. This is local storage overhead, not a token or cost estimate.

Unit/integration coverage includes atomic patch rejection, semantic replay,
confidence policies, conflicts and explicit resolution, negation/reversal,
original/previous retrieval, defensive copies, snapshot migration and tampering,
revoked/expired/stale/missing approvals, guarded execution, all six replay paths,
corrupt gold labels, malformed extraction, answer scoring, cache/cost arithmetic,
persist-before-dispatch reservations, response-phase handling, incomplete and
malformed failed responses, unknown billing, resume identity, interruption and
concurrent journal locks. CI executes tests and fixture/freeze validation only;
it has no live-inference command or credentials.

## Separately authorized live evaluation plan

**Not executed. Do not interpret the following as authorization to run it.**
The implementation is tested with injected HTTP mocks only; real API compatibility,
model extraction quality, caching, prices and actual latency remain unverified.

1. Independently review source messages, gold transitions, answer spelling and
   safety labels. Keep development tuning separate. `freeze.json` already hashes
   evaluation fixtures, configuration, prompts/scorer, runtime, transport and
   dependency manifests. `--validate` checks it; `--freeze` is a separate offline
   operation. Any refreeze after inspecting live outcomes requires new evaluation
   cases and must be disclosed; never overwrite a prior confirmatory run.
2. Obtain a separate explicit spend authorization. Use only `gpt-6-luna`, default
   service tier, `reasoning.effort=none`, no tools/images/provider-managed state,
   serial calls and the frozen three repetitions with rotated condition order.
   Recheck current [Luna limits and pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)
   and [structured-output behavior](https://developers.openai.com/api/docs/guides/structured-outputs)
   before authorizing. No price table is assumed to be permanently correct.
3. Supply a JSON rate file containing `input`, `output`, `cached`, `cacheWrite`
   prices in USD per million tokens, including any account/regional premium.
   There is no default monetary rate or default spend cap. Example **syntax only**:

   ```sh
   npm run benchmark:v3:live -- --authorize-paid --cap-usd 5 \
     --rates /absolute/path/to/reviewed-luna-rates.json \
     --out benchmarks/results/v3-live-authorized.json
   ```

   An explicitly provided environment credential is read only after the frozen
   inputs, authorization flag, cap and rate file validate. No dotenv loading or
   credential discovery is performed. The offline task has not checked whether a
   credential exists.
4. The runner persists a pending maximum reservation before every network request.
   It reserves the full documented 1,050,000-token context ceiling at the most
   expensive input/cache rate and the output ceiling, including Luna's published
   long-context multipliers. Requests are additionally constrained to a conservative
   short-context byte bound; there is no silently truncated history. This deliberately
   over-reserves. A cap smaller than one reservation issues zero requests.
   Valid reported usage releases unused reserve. Cache read/write counts are
   disjoint subsets of input; absent detail fields are assumed zero and this
   convention must be checked against provider billing. Long-context usage, if
   unexpectedly reported, receives the higher published rates. Taxes and unrelated
   account activity are outside the local inference-cost cap.
5. The local hard cap is on committed metered estimates plus reservations. It
   assumes the provider respects its documented token ceiling and supplied prices.
   A provider billing/price change cannot be prevented by client code; bound
   violations are journaled and halt execution. Use the provider's own project
   budget controls as an additional external safeguard if needed.
6. Usage is read before HTTP status, response status and output parsing. Network
   failures or missing/invalid usage retain the full reservation. There are no
   automatic retries. Resume reuses recorded outputs/failures without another
   request, verifies body/source/config/fixture/rate/cap identity, and treats an
   interrupted pending call as unknown billing. A lock prevents simultaneous
   writers. After a crashed process, confirm it is gone before removing its stale
   `.lock`; never delete its journal to obtain a fresh budget. Journal persistence
   is atomic on a normal local filesystem, not a distributed transaction or
   protection against deliberate local edits/power-loss filesystem corruption.
7. Summary statistics describe completed conversation runs; the all-attempt
   accounting ledger also includes calls from an interrupted partial conversation.
   Read both before reporting spend or failure counts. Do not cherry-pick successful
   rows or present a capped partial experiment as a full comparison. A failed call
   remains a failed task on resume. Paid retries require a new authorized, disclosed
   protocol and retain prior spend.
8. Report each repetition and domain, current and historical value/status metrics,
   attempted/executed actions, all tokens and failed-call costs, local retrieval
   overhead, latency and storage growth. Analyze paired conversation outcomes,
   avoiding false precision from shared templates. A later cost/accuracy sweep
   must apply the same reduced reasoning/output budgets to full query, JSON and v3,
   freeze those settings and new cases first, and include all update/answer costs.
   The current fixture is far too small to substantiate a 99.5% reliability claim.

Promotion criteria are measured cost at comparable accuracy, accuracy at
comparable cost, reusable deterministic enforcement, or auditability worth its
storage/CPU burden. Current evidence supports the local enforcement/audit API,
shared safety policy and v2 representation fixes. It does not establish a v3
inference advantage over JSON or on-demand full history.
