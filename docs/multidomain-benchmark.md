# Multi-domain state tracking benchmark

This experiment integrates the supplied 100-turn benchmark as a separate evaluation
alongside the existing 20-turn travel studies. It measures classification and
preference tracking, rather than generated response quality or task completion.

## Fixture and scoring

There are ten independent synthetic conversations of ten turns each: two each in
travel, shopping, technical support, task planning, and writing. Each domain has
three intent classes (including `unknown`) and two persistent binary preferences.
The hand-authored labels and conversation text are preserved from the supplied
archive, with TypeScript types and validation added. Label codes `A`, `B`, and `U`
map to the domain's first, second, and unknown intents; the final two digits encode
the two preferences in domain order.

Fixture validation checks five domains, ten unique conversation IDs, ten nonempty
turns per conversation, legal label codes, three distinct intents, two distinct
flags, and exactly two conversations per domain. These checks establish structural
validity; they do not independently establish that the labels are correct. For
example, the travel baggage-allowance question is labeled as a continuation of the
flight task, while each final general-information question is labeled `unknown`.
That interpretation is part of this benchmark's annotation policy.

Exact match requires the intent and both preferences to match. Intent uses argmax
with fixture intent order breaking ties; each preference uses a probability
threshold of `>= 0.5`. Intent probabilities must sum to one within a tolerance of
0.02; BeliefRuntime then normalizes the exclusive intent distribution. Probabilities
must be finite and in [0, 1]. Raw normalized beliefs, predictions, labels, and
per-turn usage are saved for inspection. Intent and preference accuracy are also
reported separately, by domain and by repetition.

## Compared context strategies

All workflows use the same domain-specific instructions, structured output schema,
model, reasoning setting, inference adapter, and BeliefRuntime merge path. Inputs
contain no gold labels. Each conversation starts with empty history, an empty
snapshot, and no previous response ID. Every repetition starts fresh as well.

| Workflow | Context sent on each turn | Provider storage |
| --- | --- | --- |
| `full_history` | All user messages so far in `{messages}` | `store: false` |
| `provider_history` | Latest `{new_message}` and prior `previous_response_id` | `store: true`; new chain per conversation |
| `belief_snapshot` | Latest message plus prior `{previous_beliefs}` | `store: false` |

The snapshot contains only intent and preference probabilities, with the runtime's
cardinality/domain metadata. It is loaded into a fresh runtime on each turn, then
updated through `runtime.infer()` using the shared OpenAI adapter. It has no raw
message history. No gold labels or corrections are fed back into any workflow.
Provider-managed history retains earlier model outputs as well as user inputs,
whereas full history resends only user messages. This is a practical comparison of
these implementations, with that context difference acknowledged.

With three repetitions, the order rotates: full/provider/snapshot, then
provider/snapshot/full, then snapshot/full/provider. Conversations and turns remain
serial and in fixture order. This balances each workflow's position, but does not
randomize all cache, timing, or provider-load effects. No model calls are retried;
a refusal, timeout, incomplete response, malformed output, or API error stops the
experiment. A 120-second timeout applies to each request including body reading.

## Metrics and cost accounting

Every one of the 900 planned calls counts, including the first snapshot creation,
every update, output, and re-sent snapshot. Input, output, cached input, and cache
write counts come from provider usage. Total tokens equal input plus output; cache
reads and writes are already subsets of input and are not added again. Missing
cache fields are treated as zero. The adapter rejects negative counts and cache
subsets exceeding total input. No local token estimates replace provider usage.

Estimated USD is:

```text
((input - cached_input - cache_write) * input_rate
 + cached_input * cached_rate
 + cache_write * cache_write_rate
 + output * output_rate) / 1,000,000
```

The rates and source are saved with the report. These are model token charge
estimates, excluding taxes, discounts, local serialization/storage, and separately
billed services. Provider-managed history does not make historical input free:
[OpenAI documents billing for previous inputs in the chain](https://developers.openai.com/api/docs/guides/conversation-state).
Cache reads/writes use the
[documented input accounting](https://developers.openai.com/api/docs/guides/prompt-caching).
The recorded execution uses
[OpenAI Standard short-context prices](https://developers.openai.com/api/docs/pricing),
checked 2026-10-17: $0.10 input, $0.01 cached input, $0.125 cache writes, and $0.50
output per million tokens for `gpt-6-luna`.

Latency uses a monotonic clock around `runtime.infer()`: request transport, complete
response body reading, parsing/validation, and runtime belief merge. It excludes
snapshot load/save and report file writes. Median is the middle latency (or mean
of the two middle values); p95 uses the nearest-rank definition. These are serial
request latencies, not throughput measurements or full application response times.

Reports include timestamps, model, Node version, fixture SHA-256, compiled
implementation SHA-256, exact prompts, order, rates, aggregate/domain/repetition
summaries, comparisons, and every scored turn. The implementation hash combines the
compiled runner, fixture, adapter, and runtime files in that order. A checkpoint
is atomically saved after every completed turn. `status: completed` and 900 completed
calls are required for a complete three-repetition comparison. `running` or `failed`
reports are partial and omit comparative claims; failed requests can incur charges
that are absent from the successful-turn totals. There is no automatic resume or
silent skipping. Keys are never included in reports.

## Limitations

- Ten conversations are the experimental units; adjacent turns are correlated.
  Repeating the same fixtures three times measures variability on those scripts,
  not a 300-example independent sample. No statistical equivalence is claimed.
- The scripts were supplied for this integration; they are not an independently
  held-out or blinded evaluation. Labels are not independently adjudicated.
- Only three fields are scored. The snapshot discards destinations, dates, device
  requirements, incident details, and other facts needed for realistic actions.
- Ten-turn conversations may be too short for snapshot savings to offset metadata.
  These results cannot establish long-chat performance, factual memory, tool choice,
  or generated-answer quality.
- API prompt caching is left at provider defaults. The benchmark neither flushes
  caches nor enforces a cold start. Repetitions and earlier experiments can warm
  shared prefixes. No explicit cache breakpoints or compaction are configured.
- Model aliases and provider infrastructure can change. Request order, geography,
  network overhead, and provider load affect latency; rate estimates are not invoices.
- Extending the existing travel adapter preserves its default travel schema and
  behavior. This benchmark does not evaluate Jev, encoded snapshots, settled-field
  policies, stronger seed models, or other previous prototype strategies.

## Implementation validation

The implementation passed `npm run build` (strict TypeScript checks), `npm test`
(41 passing tests), and `npm run benchmark:multidomain:validate` (100 turns,
10 conversations, five domains, no API calls). Mocked adapter tests exercise all
300 workflow/turn combinations, conversation isolation, request schemas, response
chaining, snapshot contents, scoring, token accounting, invalid responses, and
fail-fast behavior. Offline CLI tests verify validation without credentials and
explicit failed-report persistence when credentials are missing. Report assembly
tests reject incomplete/duplicate passes and mismatched models, and check discarded
usage accounting. A separate
comparison against the archive confirmed unchanged messages, labels, domain
definitions, and ordering.

## Recorded execution and findings

Raw execution reports, recovery provenance, and observed findings are recorded
below. See [reproduction commands](../benchmarks/README.md).

The first attempt stopped at `full_history`, repetition 1,
`shopping_cameras` turn 8 because the model response could not be parsed as JSON.
The [failed report](../benchmarks/results/multidomain-2026-10-17-attempt-1-failed.json)
contains 27 completed turns out of 900 planned calls. All 27 matched their labels;
that prefix is not representative evidence for accuracy or for comparisons, and
neither other workflow ran in that attempt. Successful calls reported 10,520 input
and 1,187 output tokens, no cache reads/writes, and $0.0016455 estimated model
charges. The failed response's usage is unavailable in this report, so that cost
is a lower bound for the attempt. The invalid output was rejected, not repaired
or scored as a successful turn.

A second, fresh three-repetition attempt uses the same fixture, prompts, model,
rates, and scoring. It is a separate experiment rather than a resume or selective
retry of the failed turn. Both attempts are retained to disclose the execution
failure and avoid presenting only favorable outcomes.

The [second attempt](../benchmarks/results/multidomain-2026-10-17-attempt-2-failed.json)
also stopped on an adapter-reported invalid-JSON error: `full_history`, repetition 3, `travel_osaka`
turn 5. It preserved 714 completed calls: two complete passes of every workflow,
a third complete snapshot pass, and an incomplete 14-turn full-history prefix.
The failed 15th call was not scored. Neither failed output was retained by the
adapter before JSON parsing failed, so its usage and exact text are unavailable.
No claim about the root cause of the malformed JSON is made.

The [recovery execution](../benchmarks/results/multidomain-2026-10-17-recovery.json)
starts the entire final full-history pass from fresh conversations and then runs
the final provider-history pass. It uses unchanged fixture, prompts, schema,
model, reasoning setting, pricing, and inference implementation. There are no
turn-level retries or substitutions inside any selected pass. The original final
snapshot pass is already complete and is retained.

The [selection manifest](../benchmarks/results/multidomain-2026-10-17-manifest.json)
explicitly identifies each complete 100-turn source pass and its destination
repetition. `benchmark:multidomain:report` validates complete passes, uniqueness,
fixture order, and matching model/fixture/implementation/pricing, then assembles
a separate report with `status: completed_with_workflow_restart`. It also hashes
the raw reports and accounts for all discarded successful calls and both requests
with unknown usage. It never relabels a failed raw report as completed.

This recovery differs from an uninterrupted experiment. Its results are
conditional on complete, valid-output workflow passes, and the observed execution
failures must be considered alongside scored accuracy. The planned third order
(snapshot/full/provider) is preserved, with an additional failed full-history
prefix between snapshot and its restarted full pass. The first failed attempt
also preceded the selected experiment and could have warmed caches. Selection is
by workflow completion, not by accuracy: all mistakes in a selected pass remain.

## Findings from three completed passes per workflow

The [recovered summary](../benchmarks/results/multidomain-2026-10-17-summary.json)
contains 900 scored calls (300 per workflow) with the explicit source mapping above.
These are exploratory results on the supplied scripts, conditional on complete
valid-output passes. Counts below exclude discarded prefixes; their charges are
accounted for separately.

| Workflow | Exact / intent match | Preference fields | Input tokens | Output tokens | Total tokens | Median / p95 ms | Estimated USD |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| full_history | 300/300 (100.00%) | 600/600 | 114,036 | 12,479 | 126,515 | 1200.5 / 1678 | $0.0176431 |
| provider_history | 286/300 (95.33%) | 595/600 | 176,442 | 12,064 | 188,506 | 1225 / 1791 | $0.0236762 |
| belief_snapshot | 266/300 (88.67%) | 600/600 | 104,049 | 12,048 | 116,097 | 1092 / 1639 | $0.0164289 |

All three workflows recorded zero cache reads and zero cache writes. No measured
prompt-cache saving is claimed.

| Repetition | Full history exact | Provider history exact | Snapshot exact |
| --- | ---: | ---: | ---: |
| 1 | 100/100 | 96/100 | 88/100 |
| 2 | 100/100 | 99/100 | 90/100 |
| 3 | 100/100 | 91/100 | 88/100 |

| Domain (60 scored turns per workflow) | Full history exact | Provider history exact | Snapshot exact |
| --- | ---: | ---: | ---: |
| travel | 60/60 | 57/60 | 57/60 |
| shopping | 60/60 | 58/60 | 57/60 |
| support | 60/60 | 60/60 | 53/60 |
| planning | 60/60 | 59/60 | 54/60 |
| writing | 60/60 | 52/60 | 45/60 |

Snapshots used **8.23% fewer total tokens and 6.88% lower estimated model cost**
than full history, with **11.33 percentage points lower exact-match accuracy**.
Against provider-managed history, snapshots used 38.41% fewer total tokens and
30.61% lower estimated cost, with 6.67 points lower accuracy. Their observed median
latency was 1,092 ms versus 1,200.5 ms for full history and 1,225 ms for provider
history. These timing differences are descriptive, not statistically established
latency advantages.

The snapshot path retained all 600 preference labels but missed 34 intents.
Writing was its weakest domain (45/60 exact matches). Preference-only turns such
as changing formality or granting delegation were often classified as `unknown`
rather than retaining the annotated active task. The prompt asks for the current
primary request and persistence of preferences, while the labels also expect
active intent to continue across many updates. That interpretation should be
clarified in a future held-out study; the supplied prompt and labels were not
changed after inspecting these results. Provider history also varied across
repetitions (96, 99, and 91 exact matches), including five incorrect preference
fields overall. Full history matched all selected labels, but both malformed JSON
failures also occurred on that workflow and are not included in its 300 scored
turns. These outcomes do not support an accuracy-equivalence claim for snapshots.

**Execution overhead and blockers:** there were 943 actual requests: 941 with
recorded successful-turn usage and two adapter-reported invalid-JSON failures with unavailable
usage. Of those successful turns, 41 belong to discarded prefixes (27 from the
first attempt and 14 from the incomplete final full-history pass). They add
17,664 reported tokens and $0.0024876 estimated charges. All recorded successful
calls together used 448,782 tokens and cost an estimated **$0.0602358**, a lower
bound on the experiment cost because the two failed requests may have incurred
additional charges. The 900 selected calls alone cost $0.0577482. No failed request
was repaired, imputed, or silently counted as a completed prediction.

The [task-continuity follow-up](multidomain-continuity.md) investigates these
incorrect `unknown` predictions with an explicit prompt variant and fresh
synthetic conversations. Original data and recorded results are preserved.
