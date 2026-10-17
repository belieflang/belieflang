# Accuracy and cost tradeoffs

The user clarified that perfect accuracy is not required for every application.
The next evaluation should ask how cheaply each method can meet an application's
accuracy target. Both BeliefLang and full history may choose cheaper, lower-accuracy
configurations. A lost correct prediction is an observed tradeoff, not an automatic
reason to discard a configuration under every application's requirements.

The compression experiment's original no-regression verdict remains part of its
record. It does not decide whether the compact prompt is useful at a lower quality
target. New acceptance rules should be declared before further experiments; the
earlier experiment is not retroactively relabeled as passing its original rule.

## Descriptive comparison of existing runs

For each minimum observed exact-accuracy target, select the cheapest recorded
configuration of each workflow that meets it. Selection considers all three
recorded prompts for both methods, including the cheaper compact full-history
configuration. Do not force full history to stay at its most accurate setting.

All costs cover 300 selected predictions. Token savings use total reported input
plus output tokens; cost uses the recorded input/output/cache prices.

| Minimum observed accuracy | Cheapest tested full history: accuracy / USD | Cheapest tested BeliefLang: accuracy / USD | BeliefLang cost savings | BeliefLang total-token savings |
| --- | ---: | ---: | ---: | ---: |
| 100% | 100% / $0.0176431 | 100% / $0.0187691 | -6.38% | -10.24% |
| 99.5% | 100% / $0.0176431 | 99.67% / $0.0153925 | 12.76% | 17.17% |
| 99% | 100% / $0.0176431 | 99.67% / $0.0153925 | 12.76% | 17.17% |
| 98% | 98.33% / $0.0167026 | 99.67% / $0.0153925 | 7.84% | 9.10% |
| 95% | 98.33% / $0.0167026 | 99.67% / $0.0153925 | 7.84% | 9.10% |

Negative savings mean BeliefLang used more tokens or cost more. Full history's
selected prompt is original at targets of 99% and above, and compact at 98% and
95%. BeliefLang selects continuity at 100% and compact at all lower listed targets.
The same configuration can qualify at several targets; a target is a minimum,
not a claim that a model was made to output exactly that accuracy.

Thus the current data already show two useful operating points: full history
at 100% observed accuracy and compact BeliefLang at 99.67%, costing 12.76% less
and using 17.17% fewer total tokens. When both methods can use their compact
prompts, BeliefLang scored higher (99.67% versus 98.33%) while costing 7.84% less.
These statements describe this limited set of tested configurations. They do not
establish that a cheaper full-history configuration cannot match or beat them.

The [machine-readable analysis](../benchmarks/results/multidomain-accuracy-cost-frontier-2026-10-17.json)
records all six workflow/prompt conditions, source hashes, target selections,
cost/token savings and the two conditions not beaten on both accuracy and cost
by another recorded condition. This is a deterministic analysis of existing
results with **zero new API calls**, not another benchmark execution.

The comparisons use historical development runs, with different execution times
and the previously documented adapter fix. They reuse only 100 unique annotated
turns across three repetitions. With 300 scored predictions, one error changes
accuracy by about 0.33 percentage points; meeting a 99.5% observed target permits
one error. This small, correlated dataset cannot validate true 99.5% accuracy or
establish that an observed 100% rate generalizes.

## Next live evaluation

Before any new calls, freeze the configurations, datasets, target accuracies,
selection rule, pricing and execution order. The intended evaluation is:

1. Use separate development and independent evaluation conversations, with more
   unique conversations and varied lengths/domains. Preserve critical preference
   reversals and unrelated-request cases, and specify any per-field requirements.
2. Give both methods the same development search budget and access to the same
   model choices, prompt-length choices and lossless output encodings. BeliefLang
   may additionally vary snapshot representation. Full history retains all user
   messages; any windowed-history variant is labeled as its own baseline.
3. Explore configurations on development data. For each quality target, select
   the cheapest eligible configuration per method, and freeze those selections
   before independent evaluation. Do not pick winners using the final test set.
4. Evaluate the selections on the same independent conversations, with repeated
   requests and interleaved execution. Report achieved accuracy and uncertainty
   accounting for conversation/repetition dependence. A configuration below its
   target on final evaluation is reported as a miss, not replaced using that set.
5. Compare cost and total tokens at the same minimum quality target, as well as
   accuracy at equal spend. Report each measured operating point instead of
   interpolating an untested 99.5% result or deliberately corrupting predictions.
6. Count initial snapshot creation, every update, schema/instruction overhead,
   output tokens, cache reads/writes, retries and failures. Keep scored cost and
   full execution cost separate, disclose unknown charges, and include latency
   and per-domain/per-field errors alongside aggregate accuracy.

The targets 100%, 99.5%, 99%, 98% and 95% are proposed reporting bands. Actual
application requirements may impose stronger constraints on specific errors than
on aggregate accuracy. This is an evaluation plan; the larger two-sided sweep
has not been run, and no savings from untested configurations are claimed.
