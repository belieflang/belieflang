# Task continuity experiment

The original snapshot benchmark scored 266/300 exact matches. All 34 errors
predicted `unknown` instead of the annotated active task; all 600 preference
fields were correct. Twenty-three errors overwrote a correct preceding intent,
and eleven followed a preceding erroneous `unknown`. There were thirteen distinct
conversation/turn positions among those errors.

The original prompt explicitly preserves preferences but does not explicitly
preserve task intent. This experiment tests that diagnosis without changing the
snapshot format, merge rules or model. A separately diagnosed adapter bug was
fixed before the completed experiment, as described below. Both prompt variants
use that same corrected adapter.

## Frozen candidate

`--prompt original` reproduces the exact recorded v1 prompt. `--prompt continuity`
replaces "the CURRENT primary request" with "the task active in this turn" and
appends this rule:

> Intent persists across follow-up questions and changes to the active task's
> preferences, constraints or permissions, even without a repeated task verb.
> Preserve the prior task intent for these continuations. Switch intent when a
> different task is requested. Use unknown for a standalone unrelated request or
> explicit pause/cancellation, even if an earlier task remains unfinished. A
> preference update alone does not make intent unknown.

All three workflows receive the same candidate prompt. Inference still receives
only its original context strategy. The snapshot carries no additional history,
no gold labels, no hand-coded turn exceptions, and no changed probability threshold.
The default remains `original` to keep historical commands reproducible.

## Fresh synthetic cases and evaluation plan

`src/multidomain_holdout.ts` contains five new conversations, six turns each,
covering the same five domains. They include task continuations, explicit switches,
preference reversals, unrelated questions before the final turn, and explicit task
resumption. They share no exact messages with the supplied dataset. Each has one
unrelated question, so three passes provide fifteen unrelated-request checks per
prompt. This specifically tests whether intent persistence becomes too sticky.

These cases were authored by the implementing agent after examining the original
failures. They are a fresh synthetic evaluation set, **not an independently authored
or blinded holdout**. The prompt and cases were frozen before any follow-up model
calls; the plan stores exact prompts and fixture hashes. No tuning based on the
fresh set is planned. Repetitions reuse these same five conversations: 90
predictions per prompt are five clustered conversation cases, not 90 independent
examples.

The predeclared experiment includes:

- Three complete passes per workflow on the original 100 turns with `continuity`:
  900 scored calls. Workflow order rotates across repetitions.
- Three snapshot passes per prompt on the fresh 30 turns: 180 scored calls.
  Prompt order alternates across repetitions.
- Serial requests and serial passes; same model, reasoning setting, schema and
  explicit pricing as the earlier experiment.
- No turn-level retries. Invalid model output may restart an entire pass, at most
  three attempts, preserving every failed report and its successful prefix.
  HTTP, transport or configuration errors stop the experiment.
- Comparisons select complete passes only and separately account for discarded
  prefixes and failed calls with unavailable usage. Results are conditional on
  valid complete passes, as in the earlier recovered experiment.

The plan's decision rule keeps the prompt-only approach if original-suite snapshot
accuracy reaches at least 98%, preference accuracy remains 100%, and accuracy on
unrelated questions is unchanged. Otherwise, remaining errors must be documented
before testing change-only state updates. Passing this rule does not establish
population-level equivalence or eliminate the need for an independent evaluation.

These fresh cases explicitly name the task when resuming after an unrelated
question. Implicit resumption of an earlier task, multiple concurrent tasks,
and factual details omitted from the three-field snapshot remain unmeasured.
The proposed separation of active task and current-turn intent is not implemented
by this prompt-only candidate.

Prompt overhead counts toward token/cost totals. Compare context strategies under
the same new prompt; comparing a longer candidate snapshot prompt only against a
shorter original full-history prompt mixes two changes. Historical prompt results
are useful development references, not contemporaneous randomized controls.

This approach follows [OpenAI's evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices):
retain regression cases, define the evaluation before changing the system again,
and evaluate beyond the cases used to develop the change.

## Reproduction

```bash
npm run build
npm test
npm run benchmark:multidomain -- --validate --prompt continuity
npm run benchmark:multidomain -- --validate --suite holdout

# Same pricing environment as documented in benchmarks/README.md.
# Choose a NEW directory; an existing directory is rejected.
npm run benchmark:multidomain:experiment -- \
  benchmarks/results/multidomain-continuity-local

# Or run one explicitly selected condition:
npm run benchmark:multidomain -- --prompt continuity --suite original --runs 3 \
  --output benchmarks/results/multidomain-continuity-local.json
```

A stopped experiment can be explicitly resumed after inspecting the failure:

```bash
npm run benchmark:multidomain:experiment -- \
  benchmarks/results/multidomain-continuity-local --resume
```

Resume requires a failed ledger and unchanged frozen prompts, cases, pass order,
model, pricing, and inference implementation hash. It reuses complete passes,
restarts an incomplete pass from turn one, and preserves the pre-resume ledger
and all raw attempts. The three-attempt limit remains in force for each pass.
It does not automatically retry HTTP/transport failures inside a running pass.

Each pass is a fresh one-run process, so raw rows use repetition `1`. The
manifest and ledger explicitly map each whole pass to experiment repetition
1, 2 or 3; no turn-level resampling is performed.

The experiment writes `plan.json` before API calls, an updating `ledger.json`,
immutable reports for every pass attempt, the original-suite manifest/summary,
and a fresh-set summary with per-prompt, per-repetition and per-domain metrics.
The assembler rejects mixed prompt variants and restricts recovery summaries to
the original 100-turn suite. The fresh-set summary reports its separate size.

## Execution observations

The first follow-up execution stopped before completing a pass: all three
full-history attempts reported invalid JSON, after 14, 5 and 8 completed turns.
Those prefixes were preserved. This is an execution failure, not evidence about
snapshot accuracy. [Diagnostic responses](../benchmarks/results/multidomain-continuity-2026-10-17/diagnostics-direct-body.json)
were captured separately. One showed two assistant messages: intermediate
`phase: commentary` text (a JSON object followed by "Vega.") and a valid JSON
`phase: final_answer`. The existing adapter concatenated both, causing a false
invalid-JSON failure. This is an adapter defect for that captured response, not
malformed final structured output.

The corrected adapter selects one final-answer message, retains compatibility
with older single messages without a phase, and rejects commentary-only or
ambiguous final responses. It does not repair malformed final JSON or replace it
with commentary. All provider-reported output tokens, including commentary,
continue to count toward usage and cost. This follows the
[documented distinction between commentary and final answers](https://developers.openai.com/api/docs/guides/deployment-checklist).

An [offline replay](../benchmarks/results/multidomain-continuity-2026-10-17/diagnostic-replay.json)
of the same captured payload fails with the adapter at `c0a9120` and succeeds with
the corrected adapter, reporting 468 input and 81 output tokens. Regression tests
cover this exact message pattern, malformed finals, commentary-only output,
ambiguous finals, and legacy responses. There is no basis to retroactively repair
earlier failure records whose raw payloads were not captured.

A separate diagnostic request timed out. All diagnostics remain separate from
scored turns, and their reported usage plus any unavailable usage is included in
the follow-up's execution accounting. The complete experiment restarts in
`multidomain-continuity-phase-aware-2026-10-17/` with identical frozen prompts and
fixtures. Historical v1 results are development references; the fresh-set prompt
comparison uses the same corrected parser on both sides.


The corrected experiment later stopped on a 120-second API timeout in the final
full-history pass, at `travel_osaka` turn 5. Seven complete passes and the
14-turn partial prefix were preserved. An explicit resume keeps those completed
passes, restarts only the incomplete pass, and records the stopped ledger and
resumption event. This is disclosed recovery overhead, not an uninterrupted run.
The inference hash and frozen plan are checked before resume makes model calls.

## Completed results

The [phase-aware experiment](../benchmarks/results/multidomain-continuity-phase-aware-2026-10-17/summary.json)
and [fresh-set comparison](../benchmarks/results/multidomain-continuity-phase-aware-2026-10-17/holdout-summary.json)
retain all scored rows in their raw source reports. The
[frozen plan and execution ledger](../benchmarks/results/multidomain-continuity-phase-aware-2026-10-17/plan.json)
record pass order and any restarts. The
[comparison and complete follow-up accounting](../benchmarks/results/multidomain-continuity-phase-aware-2026-10-17/comparison.json)
include the pre-fix failed attempts and diagnostics as well.

| Clarified prompt, original suite | Exact matches | Preference fields | Input / output tokens | Cached reads / writes | Estimated USD | Median / p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| full_history | 293/300 | 594/600 | 137,436 / 13,152 | 0 / 0 | $0.0203196 | 1317.5 / 1944 |
| provider_history | 298/300 | 598/600 | 199,708 / 12,028 | 0 / 0 | $0.0259848 | 1327 / 1923 |
| belief_snapshot | 300/300 | 600/600 | 127,411 / 12,056 | 0 / 0 | $0.0187691 | 1215 / 1664 |

| Repetition | Full history | Provider history | Snapshot |
| --- | ---: | ---: | ---: |
| 1 | 98/100 | 99/100 | 100/100 |
| 2 | 98/100 | 100/100 | 100/100 |
| 3 | 97/100 | 99/100 | 100/100 |

Snapshot accuracy increased from 266/300 to 300/300, an 11.33 percentage-point improvement on the original development scripts. Of the 34 previously failed repeated-turn positions, 34 now match; there are 0 new regressions among previously correct snapshot turns. Explicit unrelated questions scored 30/30, versus 30/30 historically.

Snapshot estimated cost rises from $0.0164289 in v1 to $0.0187691 with clarification (14.24% higher). The original full-history baseline already scored 300/300 at $0.0176431, making the clarified snapshot 6.38% more expensive than that historical matched-accuracy baseline. This experiment therefore establishes an accuracy improvement for snapshots, not a cost win over the best recorded full-history condition. Full-history accuracy itself changes from 300/300 historically to 293/300 under the clarification; the prompt is not a universal improvement across workflows.

This historical comparison includes the parser correction and later independent
model calls. It is not a randomized estimate of the prompt change alone. The fresh
comparison below holds the parser fixed and changes the prompt.

| Fresh synthetic snapshot condition | Exact matches | Preference fields | Unrelated questions | Total tokens | Estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| original | 77/90 | 180/180 | 15/15 | 34,557 | $0.0049357 |
| continuity | 90/90 | 180/180 | 15/15 | 41,507 | $0.0056019 |

Under the same clarified prompt, snapshots use 7.39% fewer total tokens and 7.63% lower estimated cost than full history. Extra instruction tokens and all commentary output tokens are counted. These savings compare the same prompt across context strategies; the longer candidate costs must not be presented as an unchanged-cost improvement over v1.

All follow-up activity, including the pre-fix attempts and diagnostic calls, made **1129 requests**: 1124 with captured usage and 5 with unavailable usage. Recorded usage totals 599,869 tokens and **$0.0785953 estimated charges**, a lower bound because the unreported requests cannot be priced. The 27 pre-fix successful-prefix turns were excluded from accuracy comparisons and remain preserved.

Latency summaries include only selected successful calls. The stopped 120-second request and discarded prefixes are disclosed separately; these summaries are not an all-attempt latency guarantee.

The predeclared rule for retaining the prompt-only approach was met: the original
snapshot suite exceeded 98% exact accuracy, retained 100% preference accuracy,
and preserved all unrelated-question labels. No change-only patch format or
separate active-task field was needed for these particular failures. The candidate
is available through `npm run benchmark:multidomain:continuity`; the historical
prompt remains the default for reproducibility. These results justify that tested
option, not a general claim of perfect conversational memory.

Validation: strict TypeScript build, 46 tests, both fixture suites, exact preservation
of original prompt text, and independent checks of all 1,094 phase-aware raw rows
(including the discarded 14-turn prefix), scoring, token/cost totals, latency
summaries, and fixture/implementation hashes. The tests also verify commentary
handling, failed-prefix preservation, explicit resume, refusal to change models
on resume, and rejection of mixed prompt/suite summaries.
