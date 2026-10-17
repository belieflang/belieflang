# Prompt compression experiment

The continuity prompt improved snapshot exact accuracy from 266/300 to 300/300,
but increased input usage by about 78 tokens per call. On these ten short
ten-turn conversations, that overhead outweighed the history savings relative
to the earlier full-history run. The continuity snapshot cost $0.0187691 for
300 predictions; the earlier full-history baseline cost $0.0176431 at the same
recorded accuracy. These are historical development references, not randomized
contemporaneous controls.

This experiment tests one shorter prompt, `--prompt compact`. It retains domain
descriptions, probability output, task continuity, explicit task changes,
unrelated/pause handling, preference persistence, negations and reversals. It
removes repeated prose. The snapshot representation, inference adapter, runtime,
schema, model and fixture messages/labels are unchanged. All three workflows
receive identical compact instructions. Original and continuity prompts remain
selectable, and the default stays original for reproduction.

## Predeclared evaluation

Before the first model call, the runner writes `plan.json` with exact prompts,
fixture hashes, model, explicit pricing, pass order and this acceptance rule:

- Three complete original-suite passes for each workflow: 900 scored calls.
- Three snapshot passes each for continuity and compact on the existing 30-turn
  synthetic suite, alternating prompt order: 180 scored calls.
- Accept the candidate only if snapshots score 300/300 on the original suite and
  90/90 on the reused synthetic suite, keep all preferences and unrelated requests
  correct, and cost less than both historical references above.
- Evaluate this one frozen candidate without tuning after results. Keep failures
  and discarded usage visible. The existing whole-pass restart policy applies;
  no individual-turn retries or replacement.

The 30-turn suite was already evaluated in the continuity experiment. It is now
a **known regression suite, not a fresh or independently blinded holdout**. Three
repetitions reuse the same conversations. No general accuracy guarantee follows
from passing these small, correlated synthetic tests. Longer conversations,
implicit task resumption, concurrent tasks and omitted factual details remain
outside this experiment. Savings from those cases are not assumed.

The direct synthetic comparison uses the same current implementation, model and
pricing for both prompts. Historical original-suite comparisons can be affected
by model variability and different execution times. Cost includes every selected
call's provider-reported input/output/cache usage, including initial snapshot
creation. Separate execution accounting includes failed/discarded attempts where
usage is available. Local storage/serialization and unknown failed-request usage
are outside the estimate. Latency uses the existing runner's timing boundaries.

This follows [OpenAI's evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices):
measure changes against defined criteria and keep regression evidence separate
from independent evaluation.

## Reproduction

Configure the API key and four explicit rates as in [the benchmark commands](../benchmarks/README.md).

```bash
npm run build
npm test
npm run benchmark:multidomain -- --validate --prompt compact
npm run benchmark:multidomain -- --validate --prompt compact --suite holdout
npm run benchmark:multidomain:experiment -- \
  benchmarks/results/multidomain-compression-local --candidate compact
```

Choose a new output directory. If a transport failure stops the run, inspect its
ledger and rerun the same command with `--resume`. Complete passes are reused;
the incomplete pass starts from turn one, retaining the previous prefix. Frozen
inputs, model, pricing and inference implementation must match.

For a single condition, use `npm run benchmark:multidomain:compact -- --runs 3`.
The historical `holdout` CLI suite name is retained, but this experiment labels
its reused cases as regression data.

## Recorded results, 2026-10-17

The experiment completed with `gpt-6-luna`, reasoning `none`, and the same
explicit historical rates: input $0.10, cached input $0.01, cache writes $0.125,
output $0.50 per million tokens. The saved plan records the prompts, fixture and
implementation hashes, orchestrator hash, model, rates and pass order before calls.

Each original-suite condition has 300 predictions (three complete 100-turn passes):

| Compact prompt workflow | Exact accuracy | Input | Output | Total tokens | Estimated USD | Median / p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full user history | 295/300 (98.33%) | 102,336 | 12,938 | 115,274 | $0.0167026 | 1,191 / 1,596 |
| Provider-managed history | 300/300 (100%) | 165,928 | 12,336 | 178,264 | $0.0227608 | 1,163 / 1,636 |
| BeliefLang snapshot | 299/300 (99.67%) | 92,505 | 12,284 | 104,789 | $0.0153925 | 1,072.5 / 1,436 |

Cache reads and writes were zero throughout. Snapshot preferences were 600/600;
full-history preferences were 596/600 and provider preferences 600/600. Intent
accuracy was 299/300, 300/300 and 299/300 respectively. Snapshot per-pass accuracy
was 100/100, 99/100 and 100/100; full history was 98/100, 98/100 and 99/100;
provider history was 100/100 in each pass.

Snapshots cost **17.99% less** than the historical longer continuity snapshot
($0.0187691), and **12.76% less** than the earliest full-history run ($0.0176431).
Those historical conditions both scored 300/300, whereas compact snapshots
scored 299/300. Under the same compact prompt, snapshots cost 7.84% less than
full history and scored four more exact matches. These are observed development
results, not proof of general superiority or matched-accuracy cost savings.

The direct comparison on the reused synthetic regression suite produced:

| Snapshot prompt | Exact accuracy | Input | Output | Total tokens | Estimated USD | Median / p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Continuity | 90/90 | 37,863 | 3,616 | 41,479 | $0.0055943 | 1,234.5 / 1,611 |
| Compact | 90/90 | 27,327 | 3,600 | 30,927 | $0.0045327 | 1,106.5 / 1,526 |

Both prompts preserved all 180 preference fields and correctly classified all
15 unrelated questions in that suite. These known cases do not erase the
original-suite regression or serve as an independent estimate of generalization.

### Decision and observed failure

**The compact candidate is rejected under the predeclared no-regression rule.**
It remains available as an explicitly selected experimental variant; it does not
replace the continuity alias or change the default prompt. No further candidate
was tuned after inspecting these outcomes.

The single snapshot miss was `shopping_cameras`, turn 10, in repetition 2:

> Please explain what OLED burn-in means, not a purchase recommendation. Don't revise my buying preferences.

The snapshot predicted `shop_phone` instead of `unknown`; both preferences stayed
correct. The other two repetitions classified this turn correctly. The compact
prompt retained the task when the user requested an explanation outside the named
shopping actions. That is the observed behavior; this experiment cannot isolate
which wording change caused it or distinguish a stable prompt effect from model
variability on this single position.

The earlier continuity-development misses remain corrected in these runs, but
the unrelated-request regression means we have not demonstrated retaining every
accuracy gain at lower cost. Future candidates should preserve the explicit
boundary between named task actions and explanatory requests, with a separate
frozen evaluation. Lossless state serialization could also be tested while
retaining the longer proven prompt. Neither improvement is claimed as measured
here.

### Failure accounting and validation

The first attempt at the third full-history pass timed out after 13 successful
turns, at `travel_osaka` turn 4. The run stopped; explicit resume validated the
unchanged frozen inputs, preserved seven completed passes and the failed prefix,
and restarted only that incomplete pass from turn one. The pre-resume ledger is
retained. No individual turn was retried or cherry-picked into a scored pass.

There were **1,094 attempted requests**, comprising 1,080 selected predictions,
13 discarded successful predictions and one timed-out request without reported
usage. The 1,093 metered calls used 475,790 tokens (430,426 input; 45,364 output),
at an estimated **$0.0657246**, a lower bound excluding unknown timeout charges.
Latency tables describe selected successful requests and exclude the timeout and
discarded prefix, whose occurrence remains disclosed here and in the ledger.

TypeScript, 46 tests and both fixture validations passed. Offline tests use mock
responses to verify execution and accounting only; they are not model accuracy
evidence. A separate audit recomputed every recorded row's fixture label,
state-derived prediction, exact/flag scoring, usage/cost and latency summaries;
checked 900 selected original-suite and 180 regression predictions; and verified
fixture, frozen implementation, orchestrator and report source hashes. The
original and continuity prompt texts and all earlier result artifacts remain
unchanged.

Artifacts: [frozen plan](../benchmarks/results/multidomain-compression-2026-10-17/plan.json),
[original-suite summary](../benchmarks/results/multidomain-compression-2026-10-17/summary.json),
[regression summary](../benchmarks/results/multidomain-compression-2026-10-17/holdout-summary.json),
[comparison, errors and source hashes](../benchmarks/results/multidomain-compression-2026-10-17/comparison.json),
and [attempt ledger](../benchmarks/results/multidomain-compression-2026-10-17/ledger.json).
