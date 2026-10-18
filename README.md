# BeliefLang

BeliefLang turns model-estimated beliefs into decisions and tool calls. It saves the scores a workflow needs, then applies the same rules each time.

## When it helps

A chatbot may need the same few labels across many turns: current intent, budget preference, or whether a direct flight matters. BeliefLang saves their scores as a belief snapshot. The next model call starts from that snapshot and the new message.

Rules use the scores to decide what to do. For example, when flight intent passes a chosen threshold, the app can call `search_flights()`.

### Settled labels

A tested prototype sets a confidence threshold for each decision field. Once a field is sufficiently certain, it saves the value and asks only for explicit changes to that field; uncertain fields keep getting probability updates. With a 0.90 threshold, it omitted 54 of 60 numeric field updates across the 20-turn test. It is available as a benchmark, not yet as an interactive chatbot mode.

## What we measured

| Test | Result |
| --- | --- |
| 20-turn chat with `gpt-6-luna` | Full history and saved beliefs both scored 20/20. Saved beliefs used 8,136 instead of 15,668 tokens (48% fewer), with about 29% lower estimated model cost. |
| Settled fields with `gpt-6-luna` | 20/20 in two runs. Selective updates used 5,828 vs 6,494 tokens, then 5,809 vs 6,458 tokens, compared with updating every field. |
| Jev context and tool choices (`jev-latest`) | An ordinary snapshot missed preference changes (19/20, then 18/20 actions on fresh chats). A change-only snapshot reached 20/20 on both runs of new held-out chats, using 2.7% less Jev input than full history; earlier longer chats saved 17.5%. |
| One-step routing | Direct GPT was cheaper than GPT plus BeliefLang. Both scored 8/8. |
| Smaller model (`gpt-4.1-nano-2025-04-14`) | Snapshot updates often used fewer tokens, but accuracy varied between runs. |

These are small scripted tests of decisions and tool routing. See the [full method, hybrid-model runs, and codec results](docs/jev.md).

The token and model-cost totals include the model call that creates the first belief snapshot, every update call, its output, and the saved beliefs sent back as input. Local snapshot serialization and storage are outside the dollar estimate. The main chat comparisons start fresh; a separate backfill from an existing conversation is also recorded in the method notes.

## Tiny example

```bel
belief intent exclusive closed {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

when confidence(intent.book_flight) > 0.7:
  call search_flights()
```

## Install

```bash
npm install -g belieflang
```

## Run

```bash
npm run build
bel run examples/intent.bel
```

Trace rule evaluation and actions:

```bash
bel run examples/intent.bel --trace
```

During local development:

```bash
npm run dev
```

## Jev and ChatGPT inference

BeliefLang can use TypeSafe's Jev model to infer beliefs from text. Set `TYPESAFE_API_KEY`, then run:

```bash
npm run build
node --env-file-if-exists=.env dist/src/cli.js run examples/jev_intent.bel --engine jev --usage
npm run benchmark:jev
```

You can also use an OpenAI GPT model with `OPENAI_API_KEY`:

```bash
node --env-file-if-exists=.env dist/src/cli.js run examples/chatgpt_hotel.bel --engine chatgpt --usage --trace
node --env-file-if-exists=.env dist/src/cli.js run examples/chatgpt_unknown.bel --engine chatgpt --usage
npm run benchmark:chatgpt
```

Set both API keys and run `npm run benchmark:compare` to measure Jev and GPT on the same cases. The benchmark reports provider token usage and decision accuracy. See [the integration plan and benchmark method](docs/jev.md).

For a direct GPT routing baseline versus the current BeliefLang workflow, run `npm run benchmark:before-after`. On the eight-case one-step routing test, direct GPT used fewer reported tokens than either BeliefLang path; see [the recorded results](benchmarks/results/travel-route-2026-10-15.json). This benchmark does not test whether reusing beliefs across multiple decisions saves tokens.

For a multi-turn chat that reuses saved beliefs, run `npm run chatbot` with GPT or `CHAT_ENGINE=jev npm run chatbot` with Jev. Each new message is sent with the prior belief snapshot, and the updated snapshot is saved locally. For a live GPT baseline with your own messages, run `CHAT_MODE=full-history npm run chatbot`. It makes a real API call on each turn and resends the complete conversation so far. Each mode saves its state in a separate ignored file and prints provider token usage per turn. Run `npm run benchmark:chat-snapshot` to compare the two GPT context strategies on labeled scripted conversations, or `npm run benchmark:chat-jev` to test Jev snapshot updates. In the [20-turn GPT comparison](benchmarks/results/travel-chat-snapshot-2026-10-15.json), the snapshot path used 29.5% fewer reported tokens with the same 20/20 exact matches on the labeled fields. See [the limits of that result](docs/jev.md).

To create the first snapshot with GPT-6 Luna and continue with Jev, set both API keys and run `CHAT_ENGINE=jev CHAT_SEED_MODEL=gpt-6-luna npm run chatbot`. For GPT-4.1 nano updates, run `OPENAI_MODEL=gpt-4.1-nano-2025-04-14 CHAT_SEED_MODEL=gpt-6-luna npm run chatbot`. The first message uses the seed model; later messages use the chosen update engine. Run `npm run benchmark:seed-continuation` to compare these paths with single-engine baselines. In [two 20-turn runs](docs/jev.md#strong-seed-then-cheap-updates), Jev alone scored 20/20 twice at about $0.000504 estimated model cost per run. GPT-6 Luna then Jev scored 20/20 and 18/20 at about $0.000556 and $0.000557, including the seed calls. The stronger seed did not reliably improve this small test.

Run `npm run benchmark:multidomain:validate` to validate the supplied 100-turn, 10-conversation, five-domain fixtures offline. Run `npm run benchmark:multidomain -- --runs 3 --output benchmarks/results/multidomain-local.json` to compare full user history, provider-managed history, and BeliefLang snapshots over 900 model calls. The runner records accuracy, input/output tokens, cache reads/writes, latency, and estimated cost when explicit pricing is configured. See [commands](benchmarks/README.md) and [methodology, limitations, and findings](docs/multidomain-benchmark.md).

The separate [long-horizon v2 benchmark](docs/long-horizon-v2.md) compares full history, Luna-maintained rolling summaries, and typed BeliefLang runtime snapshots on ten 20-turn conversations. Validate fixtures offline with `npm run benchmark:long-horizon:validate`; regenerate the saved analysis and charts with `npm run benchmark:long-horizon:report`. The frozen run, compressed raw evaluation data, cost accounting, and fixture limitations are documented in the report.

The opt-in [v3 factual memory and decision guard](docs/delta-state-v3.md) add typed deltas, source-tracked original/previous values, explicit uncertainty and deterministic permission checks. Run `npm run benchmark:v3:validate` and `npm run benchmark:v3:offline` without credentials. The offline comparison includes plain typed JSON and full history on demand; JSON matches v3 on these deterministic contracts. No live v3 accuracy, token or cost advantage has been measured.


The [task-continuity follow-up](docs/multidomain-continuity.md) tests `--prompt continuity` on the same workflows and on fresh synthetic conversations. It preserves task intent across preference-only updates while keeping explicit unrelated questions separate. The shared OpenAI adapter also distinguishes intermediate commentary from final structured output. The original prompt remains selectable with `--prompt original`.

The [prompt-compression experiment](docs/multidomain-compression.md) tests `--prompt compact` across all three history methods and reruns the existing synthetic cases as regression data. Compact snapshots cost 17.99% less than the longer continuity snapshot, but scored 299/300 instead of 300/300 on the original suite. They scored 90/90 on the reused synthetic suite. This opt-in experimental variant failed the strict no-regression acceptance rule.

The [accuracy and cost tradeoff analysis](docs/multidomain-tradeoffs.md) allows both full history and BeliefLang to select their cheapest tested configuration above a minimum observed accuracy target. At a 99.5% target, compact BeliefLang scored 99.67% with 12.76% lower cost and 17.17% fewer total tokens than the cheapest qualifying tested full-history configuration. These are historical development results; the larger independent evaluation is planned, not yet run.

Run `npm run benchmark:chat-market` for a second live comparison: provider-managed history with prompt caching, forced provider compaction, a BeliefLang JSON snapshot, and a five-character encoded snapshot. It records provider cache usage, labeled accuracy, latency, and estimated GPT-6 Luna model charges. The [recorded run](benchmarks/results/travel-chat-market-2026-10-15.json) and [method notes](docs/jev.md) show the accuracy tradeoff of the encoded state.

Run `npm run benchmark:chat-settled` to compare a fresh full-snapshot baseline with the 0.90 settled-field policy. The [two recorded runs](docs/jev.md#settling-confident-fields) include the first model call that creates the snapshot and report every turn's provider tokens and label match.

Run `npm run benchmark:jev-context` to compare direct Jev routing, full-history Jev with BeliefLang rules, ordinary saved beliefs, and change-only saved beliefs. Add `-- --fresh` or `-- --holdout` for separate 20-turn sets. Every path makes real Jev calls and dispatches local mock tools. The [Jev results and limits](docs/jev.md#jev-direct-action-full-history-or-saved-beliefs) show both the ordinary snapshot misses and the compact change-only improvement.
Run `CHAT_ENGINE=jev JEV_UPDATE_MODE=delta npm run chatbot` to try the compact change-only Jev updater interactively. It saves a separate `.belieflang-chat-jev-delta.json` file. Explicit preference changes become hard 0/1 values; use the mode as an experimental demo.

To repeat the older-model test with provider-held history and saved beliefs, run `OPENAI_MODEL=gpt-4.1-nano-2025-04-14 CHAT_BENCHMARK_PROMPT=focused npm run benchmark:chat-market -- provider_history belief_snapshot`. Run `npm run benchmark:weak-delta` to try a separate design in which the model reports only changes and BeliefLang preserves the other fields. See the [older-model results and limits](docs/jev.md#older-model-accuracy-check).

Run `npm run benchmark:hybrid-seed` to compare a GPT-6 Luna seed, a GPT-4.1 nano seed, and nano reading full history from an existing five-message chat. The [hybrid results](docs/jev.md#strong-model-snapshot-weak-model-updates) include the seed calls in the token and cost totals.

Run `CHAT_MODE=coded npm run chatbot` to try the selected ten-character encoded snapshot interactively. It persists only the five quantized belief values in `.belieflang-chat-chatgpt-coded.json`. Run `npm run benchmark:chat-code` to compare all codec candidates, or `npm run benchmark:chat-code -- labeled_10` for the selected format. The [codec sweep](docs/jev.md) retains the shorter one-error result alongside the passing format.

## Current features

- `belief` blocks
- belief modes: `exclusive` or `multi`
- belief domains: `open` or `closed`
- normalized distributions for `exclusive closed`
- retained `other` mass for `exclusive open`
- `let` variables
- tool return values
- property access like `flights.count`
- `confidence(...)`
- normalized `entropy(...)`
- `when` rules
- compound conditions with `&&`, `||`, `!`, and parentheses
- `call tool()`
- `ask_user("...")`
- `observe event(value)`
- `infer beliefs from value`
- `merge beliefs from value`
- trace output with `--trace`
- provenance history with `getProvenance()` and `explainBelief("belief.label")`
- tiny Node.js CLI

## Non-goals

BeliefLang is not trying to replace Python, JavaScript, or SQL.

It is not a general-purpose language.

It is a small experimental runtime for belief-state execution, AI agents, and uncertainty-aware orchestration.

## Example output

```txt
[state]
  intent [exclusive/closed]: book_flight=0.820, book_hotel=0.120, unknown=0.060
  user [multi/closed]: budget_sensitive=0.910, prefers_direct=0.840
[trace] rule 1 when confidence(intent.book_flight) > 0.7 => true
[trace]   confidence(intent.book_flight)=0.820 > 0.7=0.700 -> true
[trace] action call search_flights()
```

## Roadmap

- provenance tracking
- confidence decay
- JSON belief import/export
- browser playground
- VS Code syntax highlighting
- LLM-backed semantic extraction

## Product viability review

The [independent product-viability review](docs/product-viability.md) compares TypeScript, the v3 library and actual `.bel` policies on travel, support and operations workflows. Its provisional recommendation is a TypeScript library rather than a dedicated DSL. Run `node dist/src/viability/review.js --validate` after building for read-only offline checks; paid evaluation remains separately authorized.

## License

Apache-2.0
