# Jev integration and token benchmark

## Plan

1. Use BeliefLang's existing `inferBeliefs` adapter as the engine boundary.
2. Ask Jev one `choice` question for the exclusive `intent` distribution and two `noul` questions for independent user preferences.
3. Merge Jev's probabilities into BeliefLang, then evaluate the existing rules.
4. Record TypeSafe's reported input and output tokens for every inference call. Run a fixed labeled dataset and report token usage alongside decision quality and latency.
5. Use an OpenAI GPT model through the Responses API as a comparison engine on those same cases.

## Run with Jev

Set `TYPESAFE_API_KEY` in your environment, then run:

```bash
npm run build
node --env-file-if-exists=.env dist/src/cli.js run examples/jev_intent.bel --engine jev --usage --trace
```

`JEV_MODEL` optionally chooses a model; the default is `jev-latest`. Without `--engine jev`, the existing local heuristic remains the default. Jev inference currently accepts string sources. API failures and malformed responses stop the program with an error.

The adapter sends the source text as Jev's state. It asks for `book_flight`, `book_hotel`, or `unknown`, and for the `budget_sensitive` and `prefers_direct` probabilities. The returned distribution is normalized by the runtime's existing `exclusive closed` semantics. Rules and tools continue to execute locally.

## ChatGPT examples

Here “ChatGPT” means a GPT model called through the OpenAI API, not the ChatGPT web app. The default model is `gpt-6-luna` with reasoning effort `none`; set `OPENAI_MODEL` to change it. Other models use their default reasoning setting. The model returns the same five belief probabilities in a structured JSON response. These are model-generated estimates and should not be treated as calibrated probabilities.

```bash
node --env-file-if-exists=.env dist/src/cli.js run examples/jev_intent.bel --engine chatgpt --usage
node --env-file-if-exists=.env dist/src/cli.js run examples/chatgpt_hotel.bel --engine chatgpt --usage --trace
node --env-file-if-exists=.env dist/src/cli.js run examples/chatgpt_unknown.bel --engine chatgpt --usage
```

The examples show flight ranking, hotel search, and an out-of-scope request. You can run the same `.bel` file with `--engine jev` to compare behavior.

## Benchmark

```bash
npm run benchmark:jev
npm run benchmark:chatgpt
npm run benchmark:compare
```

The benchmark runs eight fixed travel messages through the full runtime inference path and prints JSON with per-case and total provider-reported token counts, median request latency, and exact-match accuracy for intent and both preference flags. It uses a threshold of `0.5` for the preference flags. Each selected engine makes eight live requests. The measured tokens are taken from provider API responses, not estimated from text length.

This first dataset is a smoke benchmark, not a statistically strong model evaluation. The two engines see the same source messages and answer the same questions, though their prompts and response formats differ. Compare quality alongside tokens; lower token usage alone does not establish a better engine. Provider tokenizers can also differ, so token counts are a usage measure within each API, not a universal unit of compute or cost. The local heuristic consumes no model tokens, but has different capabilities. Pin `JEV_MODEL` and `OPENAI_MODEL` when comparing runs across time.

### Live run: 2026-10-15

| Engine | Exact match | Input tokens | Output tokens | Total tokens | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Jev (`jev-latest`) | 8/8 | 3,268 | 636 | 3,904 | 329.5 ms |
| GPT (`gpt-6-luna`) | 8/8 | 1,329 | 326 | 1,655 | 1,827.5 ms |

GPT used 42.4% as many reported total tokens as Jev on these cases, while Jev had the lower median latency. This is one run of eight simple examples. The Jev model name is an alias, and the two APIs may count tokens differently.

## Before and after BeliefLang

Run `npm run benchmark:before-after` for a separate action-routing comparison. The **before** path sends each message to GPT-6 Luna and asks it to choose `search_flights`, `search_hotels`, or `ask_user` directly. The **after** paths ask GPT or Jev to infer beliefs, then use BeliefLang conditions to choose one of those actions. All paths receive the same eight messages and are scored on the same expected action. The after adapters also infer two preference values that the action rules do not use, so this measures the current integration rather than a minimal intent-only version.

Live run on 2026-10-15 ([full per-case JSON](../benchmarks/results/travel-route-2026-10-15.json)):

| Workflow | Correct actions | Input tokens | Output tokens | Total tokens | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Direct GPT | 8/8 | 913 | 118 | 1,031 | 1,318.5 ms |
| GPT + BeliefLang | 8/8 | 1,329 | 326 | 1,655 | 1,214.5 ms |
| Jev + BeliefLang | 8/8 | 3,268 | 636 | 3,904 | 233.5 ms |

On this one-step task, GPT + BeliefLang used 1.61 times as many reported tokens as direct GPT. Jev + BeliefLang used 3.79 times as many. The after paths produce reusable belief state and the direct path only produces an action, so their output contracts differ. This run does **not** establish token savings from BeliefLang. A longer workflow that reuses beliefs over multiple decisions is needed to test that claim. Latency is sensitive to network conditions and call order; eight sequential calls per workflow are not enough to establish a stable speed difference.

## Multi-turn chat with a belief snapshot

The [chat benchmark](../src/chat_benchmark.ts) runs two 10-turn travel conversations. On every turn, both paths use `gpt-6-luna`, the same instructions, and the same output schema for intent and two preferences:

- **Full history:** send every message so far.
- **Belief snapshot:** restore a serialized BeliefLang belief snapshot, send only its probabilities and the new message, then save the updated snapshot.

Both paths are scored against intent, budget sensitivity, and direct-flight preference labels on every turn. The latest explicit change overrides old preferences; otherwise preferences persist. Run it with `npm run benchmark:chat-snapshot`.

Live run on 2026-10-15 ([full per-turn JSON](../benchmarks/results/travel-chat-snapshot-2026-10-15.json)):

| Context sent | Exact turns | Intent correct | Preference fields correct | Input tokens | Output tokens | Total tokens | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full history | 20/20 | 20/20 | 40/40 | 8,858 | 888 | 9,746 | 1,361 ms |
| Belief snapshot + new message | 20/20 | 20/20 | 40/40 | 6,020 | 852 | 6,872 | 1,277.5 ms |

The snapshot path used **29.5% fewer reported total tokens** in this run. It used slightly more tokens on turns 1–2, then fewer from turn 3 onward as full history grew. For example, its `intent.book_flight` probability was 0.99 at turn `a1`, changed to `intent.book_hotel = 0.99` at `a4`, and returned to `intent.book_flight = 1.0` at `a6`; its direct-flight preference fell to 0 when the user accepted a connection.

This is evidence for this specific context-reuse pattern, not a general precision or cost guarantee. The conversations are synthetic and small. The snapshot stores only the defined beliefs; it does not retain dates, destinations, explanations, observations, or provenance across turns unless those are modeled separately. Important details can be lost in longer or more ambiguous chats. The observed 20/20 exact-match rate is not a production acceptance estimate.

The same snapshot sequence was also run through Jev with `npm run benchmark:chat-jev` ([per-turn JSON](../benchmarks/results/travel-chat-jev-snapshot-2026-10-15.json)). It matched 20/20 turns and 40/40 preference fields, using 11,997 input and 1,598 output tokens (13,595 total) with a 296 ms median latency. Jev and GPT count tokens differently; this result verifies the Jev snapshot path and should not be read as a direct token-cost comparison to GPT. The run used the moving `jev-latest` alias.

### Jev: direct action, full history, or saved beliefs

Run `npm run benchmark:jev-context`, add `-- --fresh`, or add `-- --holdout` to compare four live Jev paths. Direct Jev reads all user messages and chooses one of seven actions. Full-history Jev reads the same messages and estimates intent and two preferences; BeliefLang then chooses the action. Ordinary snapshot Jev estimates the same beliefs from saved scores plus the latest message. Change-only snapshot Jev reads the latest message and prior intent, identifies explicit preference changes, and lets BeliefLang preserve other preferences. The seven actions include separate tools for budget flights, nonstop flights, both together, budget hotels, ordinary flight or hotel search, and clarification. Every action invokes one local mock tool, with no travel service or external tool called. All 20 model calls per path, including the first snapshot call, are counted. The full-history and ordinary-snapshot paths use the same three Jev questions; direct action and change-only updates use different questions. The rule threshold is 0.7 for intent and 0.5 for preferences.

| Dataset and run | Direct action: correct / input / USD | Full history + rules: correct / input / USD | Saved beliefs + rules: correct / input / USD |
| --- | ---: | ---: | ---: |
| [Earlier long messages](../benchmarks/results/travel-chat-jev-policy-v3-development-2026-10-16.json) | 20/20 · 16,786 · $0.000705 | 20/20 · 14,386 · $0.000604 | 20/20 · 11,997 · $0.000504 |
| [Fresh short messages](../benchmarks/results/travel-chat-jev-policy-v3-fresh-2026-10-16.json) | 20/20 · 14,256 · $0.000599 | 20/20 · 11,856 · $0.000498 | 19/20 · 11,579 · $0.000486 |
| [Fresh repeat](../benchmarks/results/travel-chat-jev-policy-v3-fresh-repeat-2026-10-16.json) | 20/20 · 14,256 · $0.000599 | 20/20 · 11,856 · $0.000498 | 18/20 · 11,586 · $0.000487 |

The table scores the **dispatched action**. Full-history Jev also matched all three belief labels on 20/20 turns in every run. Snapshot Jev matched those labels on 20/20 earlier turns, then 19/20 and 18/20 on the fresh runs. On the earlier, longer messages, the snapshot saved 16.6% of Jev input tokens and estimated model cost versus full history with equal action accuracy. On the fresh, shorter messages, it saved only 2.3% and missed preference-sensitive actions. It missed a new nonstop preference, then carried that error into the next turn on the repeat. This does **not** meet the 19/20 target consistently. Full history is the more accurate Jev path on these fresh chats.

The [fresh cases](../src/jev_context_cases.ts) were written before these calls, but they are still only two synthetic conversations. The direct action path uses a different, longer seven-option question and does not produce reusable beliefs; its higher cost cannot be attributed to BeliefLang alone. Jev output is free at the [published $0.042 per million input-token rate](https://typesafe.ai/blog/introducing-system-one-models-and-jev) checked 2026-10-16, so the input-token and estimated-cost percentages match. Local storage and taxes are excluded. `jev-latest` is a moving alias. The tools are mocks, so this checks routing decisions, not real booking success. The ordinary snapshot path did not establish a reliable improvement over full history; its value depends on how much history it replaces and whether it retains the fields needed for later decisions.

#### Change-only Jev snapshot

To address the missed nonstop change, the [change-only adapter](../src/jev_delta.ts) asks Jev whether each new message explicitly sets, removes, or leaves unchanged the budget and nonstop preferences. BeliefLang applies that patch to its saved snapshot. Jev sees the prior intent and latest message, but the saved preference values stay local. The first, longer prompt scored [20/20 on the fresh chats](../benchmarks/results/travel-chat-jev-delta-fresh-2026-10-16.json) but used 14,249 input tokens, more than full history's 11,856. We shortened the question before validation; the results below use that fixed compact prompt.

| Dataset | Full history: actions / beliefs / input | Compact change-only: actions / beliefs / input | Input and estimated-cost saving |
| --- | ---: | ---: | ---: |
| [Earlier chats](../benchmarks/results/travel-chat-jev-delta-compact-development-2026-10-16.json) | 20/20 · 20/20 · 14,386 | 20/20 · 20/20 · 11,862 | 17.5% |
| [Fresh chats](../benchmarks/results/travel-chat-jev-delta-compact-fresh-2026-10-16.json) | 20/20 · 20/20 · 11,856 | 20/20 · 20/20 · 11,423 | 3.7% |
| [Fresh repeat](../benchmarks/results/travel-chat-jev-delta-compact-fresh-repeat-2026-10-16.json) | 20/20 · 20/20 · 11,856 | 20/20 · 20/20 · 11,423 | 3.7% |
| [New held-out chats](../benchmarks/results/travel-chat-jev-policy-v5-holdout-2026-10-16.json) | 20/20 · 17/20 · 11,693 | 20/20 · 20/20 · 11,380 | 2.7% |
| [Held-out repeat](../benchmarks/results/travel-chat-jev-policy-v5-holdout-repeat-2026-10-16.json) | 20/20 · 17/20 · 11,693 | 20/20 · 20/20 · 11,380 | 2.7% |

The [held-out cases](../src/jev_context_holdout_cases.ts) were written after the compact prompt was fixed and before running it. In those chats, the ordinary snapshot path chose 17/20 and 18/20 actions, while the change-only path chose 20/20 twice. Estimated Jev model cost on the held-out chats was $0.000491 for full history and $0.000478 for change-only, including every call. This meets the one-error target in these small synthetic runs, but is not a general reliability estimate. Explicit changes become hard 0/1 preference values, so the method gives up calibrated uncertainty for those fields. The prompt and the dataset are still narrow; ambiguous changes, longer chats, and real tool outcomes need separate validation.

Try it interactively with `CHAT_ENGINE=jev JEV_UPDATE_MODE=delta npm run chatbot`. It writes a separate `.belieflang-chat-jev-delta.json` snapshot. The ordinary Jev snapshot mode remains the default.

### Settling confident fields

Run `npm run benchmark:chat-settled` to compare two live `gpt-6-luna` paths on the same 20 labeled turns. The baseline sends all five saved probabilities and requests five new probabilities each turn. The selective path groups those scores into three decision fields: intent (three exclusive scores), budget sensitivity, and direct-flight preference. It settles a field when its most likely value reaches 0.90. Later requests send settled fields as categorical values and ask for new probabilities only for uncertain fields. The model may report an explicit categorical change to a settled field, which BeliefLang merges into its snapshot. Both paths include the first model call that creates the snapshot. No model call is skipped; the possible saving is a smaller input and output on later calls.

| Run | Full snapshot: exact / tokens | Settled fields: exact / tokens | Numeric field updates omitted |
| --- | ---: | ---: | ---: |
| [Short prompt](../benchmarks/results/travel-chat-settled-2026-10-16-v3.json) | 20/20 · 6,494 | 20/20 · 5,828 | 54/60 |
| [Repeat](../benchmarks/results/travel-chat-settled-2026-10-16-v3-repeat.json) | 20/20 · 6,458 | 20/20 · 5,809 | 54/60 |

The selective path used 10.3% and 10.0% fewer provider-reported tokens in these runs. An earlier, longer change-check prompt also scored [20/20](../benchmarks/results/travel-chat-settled-2026-10-16.json), but used **6,725 vs 6,494** tokens, so skipping scores alone did not save tokens. A shorter prompt before clarifying `unknown` used [5,709 tokens but scored 19/20](../benchmarks/results/travel-chat-settled-2026-10-16-v2.json); it missed the switch to a train request. All versions remain recorded.

This is a small scripted classification test, not a tool-call accuracy test. The prompts were adjusted against these same 20 turns, so the two 20/20 runs are not held-out validation. The categorical changes replace settled probabilities with hard 0/1 values; they preserve these discrete labels but discard probability calibration. A more ambiguous new message might fail to reopen a settled field. Test on new conversations before using this policy in the interactive chatbot.

The two paths use different instructions and output schemas because the selective path asks for changes instead of full probabilities. The observed token difference measures the whole request design; it cannot isolate the contribution of settling fields from prompt wording and response shape.

### Provider context and five-character belief code

Run `npm run benchmark:chat-market` for a second live benchmark using the same two scripted conversations and GPT-6 Luna across four paths. The provider-history path uses `previous_response_id` and `store: true`, so the provider carries earlier user inputs and structured model outputs; the API reports cache usage and still bills prior context. The compaction path adds `context_management` with a **1,000-token threshold** to force compaction on these short chats. The two local-state paths use `store: false` and send either JSON beliefs or a five-character code with the new message. All four use the same model, instructions, and output schema.

The code uses five base-36 characters in a fixed order: flight intent, hotel intent, unknown intent, budget sensitivity, direct-flight preference. Each character represents a probability rounded to increments of 1/35. A local decoder restores those five approximate values; it cannot recover the original messages, dates, destinations, reasons, or other unmodeled facts. The code's mapping is included in the shared instructions, so its instruction-token cost is included in every path. The encoded path is scored **after decoding**.

Live run on 2026-10-15 ([per-turn JSON](../benchmarks/results/travel-chat-market-2026-10-15.json)):

| Path | Exact turns | Input tokens | Cached input | Cache writes | Output tokens | Estimated USD | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Provider-held history | 20/20 | 14,768 | 3,268 | 1,227 | 900 | $0.001663 | 1,599.5 ms |
| Forced provider compaction | 20/20 | 17,871 | 0 | 1,885 | 4,333 | $0.004001 | 2,034 ms |
| BeliefLang JSON snapshot | 20/20 | 7,232 | 0 | 0 | 904 | $0.001175 | 1,290.5 ms |
| Five-character snapshot | 19/20 | 6,164 | 0 | 0 | 848 | $0.001040 | 1,201.5 ms |

The provider reported **15 compaction items** in the forced run. Its extra output made it more expensive here; a normal high threshold would likely avoid compaction on such short chats. The coded path was about 11.5% cheaper than the JSON snapshot in this run, but it mislabeled the intent on turn `a3`. The decoder's maximum probability change from quantization was 0.02; the missed label arose in the coded-context inference. These are single, small synthetic runs, not reliability estimates.

USD is an estimate from reported usage using [GPT-6 Luna Standard short-context prices](https://developers.openai.com/api/docs/models/gpt-6-luna): $0.10 per million uncached input tokens, $0.01 cached input, $0.125 cache writes, and $0.50 output. The snapshot path makes 20 model calls, including the first call that creates its beliefs. Its 904 output tokens and 7,232 input tokens include creating, updating, and sending back the snapshot; there is no separate model call to create it. The chats start from turn one; creating a snapshot from an existing conversation would be an extra backfill not measured here. The cost estimate excludes local snapshot loading, serialization, and storage, as well as taxes, other service tiers, and any charge not included in response usage. The reported request latency starts after local snapshot loading and stops before saving the new snapshot. Cache hits vary between runs. The previous-response baseline includes prior model outputs; the snapshot paths retain only the five defined beliefs. This benchmark measures belief classification, not a full conversational assistant with natural-language replies or tools. Longer and more ambiguous conversations need a separate quality test before using the code as memory.

### Finding a code length that keeps the labeled result

The [codec benchmark](../src/chat_code_benchmark.ts) explores eight encodings with the same 20 labeled turns and GPT-6 Luna. Every row is scored from the **decoded saved code**. The per-turn live outputs are preserved in the [initial sweep](../benchmarks/results/travel-chat-code-2026-10-15.json), [follow-up](../benchmarks/results/travel-chat-code-followup-2026-10-15.json), [intermediate formats](../benchmarks/results/travel-chat-code-intermediate-2026-10-15.json), and [final repeat](../benchmarks/results/travel-chat-code-validation-2026-10-15.json).

| Format | Code characters | Exact turns across runs | Mean tokens per 20 turns | Mean estimated USD | Probe maximum probability error |
| --- | ---: | --- | ---: | ---: | ---: |
| Positional base-36 | 5 | 19/20, 20/20 | 6,091 | $0.000932 | 0.014 |
| Dominant intent + three values | 4 | 20/20, 20/20, 20/20 | 6,643 | $0.001055 | 0.227 |
| Fully labeled values | 10 | 20/20, 20/20, 20/20 | 6,600 | $0.001006 | 0.014 |

The other variants scored 19/20 (five-character dominant and eight-character labeled), 18/20 (seven- and nine-character labeled), and 12/20 (six-character dominant) in their single exploratory runs. The original five-character code also scored 19/20 in the earlier market benchmark. These one-error results remain in the JSON artifacts; the final passing run does not erase them.

The four-character code stores the most likely intent, its probability, and two preference probabilities; its decoder splits the remaining intent probability equally. That is why it can pass the discrete labels while changing a probability by 0.227 on a fixed fidelity probe. The ten-character `F#H#U#B#D#` format stores all five probabilities at 1/35 resolution and was the smallest tested format that kept both the fidelity probe below 0.02 and 20/20 across three runs. It is the selected interactive mode: `CHAT_MODE=coded npm run chatbot`. Each turn saves an ignored `.belieflang-chat-chatgpt-coded.json` state file and prints the code plus decoded beliefs.

This is an **observed sweet spot for these scripted turns**, not a proven optimum for arbitrary chats. The same 20 turns were used to choose the format, model outputs vary between runs, and these codes still omit unmodeled details such as destination and dates. A held-out conversation set is needed before treating the format as reliable memory.

### Older-model accuracy check

We ran the same 20 labeled turns with the pinned older [GPT-4.1 nano model](https://developers.openai.com/api/docs/models/gpt-4.1-nano), **`gpt-4.1-nano-2025-04-14`**, using the same model and output fields for both paths within each comparison. The provider-held history path uses `previous_response_id`; the saved-beliefs path restores a BeliefLang snapshot and sends it with the latest message. A focused instruction mentions only these two paths. The broader instruction also describes a compact code format. Both are real API calls on every turn.

| Prompt and run | Provider-held history | Saved beliefs | Provider tokens: history / beliefs |
| --- | ---: | ---: | ---: |
| Focused, [first run](../benchmarks/results/travel-chat-nano-market-focused-2026-10-15.json) | 18/20 | 20/20 | 13,782 / 6,822 |
| Focused, [repeat](../benchmarks/results/travel-chat-nano-market-focused-repeat-2026-10-15.json) | 18/20 | 18/20 | 14,148 / 6,882 |
| Broader, [first run](../benchmarks/results/travel-chat-nano-market-2026-10-15.json) | 16/20 | 11/20 | 15,446 / 8,118 |

The focused prompt improved the saved-belief score in one run and tied in the repeat. With the broader prompt it was worse. A simpler full-history resend comparison also scored [13/20 versus 20/20](../benchmarks/results/travel-chat-nano-snapshot-2026-10-15.json), then [12/20 versus 18/20](../benchmarks/results/travel-chat-nano-snapshot-repeat-2026-10-15.json). These show that shorter, explicit state can help this small model, but **a dependable quality improvement or 19/20 acceptance rate has not been demonstrated**.

We also tried a change-only interface: GPT-4.1 nano reads just the latest message and returns `keep`, `yes`, or `no` for each field; BeliefLang applies the patch and preserves other values. Three exploratory prompt versions scored [18/20](../benchmarks/results/travel-chat-nano-delta-2026-10-15.json), [18/20](../benchmarks/results/travel-chat-nano-delta-tuned-2026-10-15.json), and [18/20](../benchmarks/results/travel-chat-nano-delta-final-2026-10-15.json). This path used 4,918–7,730 reported tokens. The prompt was revised after inspecting these same cases, so they are development runs, not held-out validation. Its state uses hard 0/1 values for this task; the model can still misread an explicit change.

Repeat the focused provider comparison with:

```bash
OPENAI_MODEL=gpt-4.1-nano-2025-04-14 CHAT_BENCHMARK_PROMPT=focused npm run benchmark:chat-market -- provider_history belief_snapshot
```

Run `npm run benchmark:weak-delta` for the change-only path. All accuracy figures score intent and both preference flags together on each turn. The dataset has only two scripted conversations, and every prompt revision was evaluated on the same cases. A new, held-out set of chats and repeated runs are needed before claiming that BeliefLang upgrades a weaker model. The improvement, where observed, may come from narrowing the model's context and task; saving state alone does not correct a wrong inference.

### Strong-model snapshot, weak-model updates

The [hybrid benchmark](../src/chat_hybrid_benchmark.ts) tests a one-time backfill from an existing five-message chat. For each of the two conversations, one model call reads the first five messages and creates a BeliefLang snapshot. The pinned weak model, `gpt-4.1-nano-2025-04-14`, then updates it from each new message on turns 6–10. We compare a seed made by `gpt-6-luna`, a seed made by nano, and nano rereading the full chat on each continuation turn. All paths use the same belief schema and instructions; each is scored on the same 10 continuation turns. The full-history path needs no separate seed call at this checkpoint. Both snapshot paths include their two seed calls in total usage and cost.

| Run | Nano full history | Nano seed + nano updates | GPT-6 seed + nano updates | Estimated cost: full / nano seed / GPT-6 seed |
| --- | ---: | ---: | ---: | ---: |
| [Initial strong-seed run](../benchmarks/results/travel-chat-hybrid-seed-2026-10-15.json) | 4/10 | — | 8/10 | $0.000716 / — / $0.000606 |
| [Initial repeat](../benchmarks/results/travel-chat-hybrid-seed-repeat-2026-10-15.json) | 5/10 | — | 8/10 | $0.000709 / — / $0.000612 |
| [Controlled run](../benchmarks/results/travel-chat-hybrid-seed-control-2026-10-15.json) | 5/10 | 7/10 | 10/10 | $0.000712 / $0.000577 / $0.000586 |
| [Controlled repeat](../benchmarks/results/travel-chat-hybrid-seed-control-repeat-2026-10-15.json) | 5/10 | 10/10 | 10/10 | $0.000712 / $0.000581 / $0.000592 |

The strong-seeded path used 4,406–4,511 reported tokens including the seed, versus 5,932–5,950 for full-history nano. This is evidence that a saved snapshot can make this narrow continuation task cheaper and more accurate than this weak full-history baseline. The extra value of **using a stronger model to create the snapshot** is less certain: it beat the nano seed in one controlled run and tied in the repeat. The 10/10 result also did not hold in the earlier strong-seed runs. These are the same two scripted chats used in prior tests, not held-out validation; the 19/20 quality target cannot be inferred from ten scored continuation turns.

Estimated model charges use the published Standard text rates for [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) and [GPT-4.1 nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano), checked 2026-10-15. They include the stronger seed call where used and each nano update, and exclude local snapshot storage and taxes. This is a checkpoint scenario: the first five messages already exist, and no path is charged for generating prior assistant replies. Run `npm run benchmark:hybrid-seed` to repeat the three-way comparison.

### Strong seed, then cheap updates

The [seed-continuation benchmark](../src/chat_seed_benchmark.ts) starts each of the same two 10-message chats from an empty BeliefLang snapshot. One live model call creates the first snapshot from message one; the update engine then sees that snapshot plus each new message. Every path makes 20 calls and is scored on all 20 turns for intent and both preference flags. The first call of each chat, including a strong-model seed, is included in cost. This experiment does not use the 0.90 settled-field policy. Run `npm run benchmark:seed-continuation` to repeat all six paths, or pass flow names such as `jev_only luna_seed_jev_updates` to run selected paths.

| Seed → updates | First run: exact / estimated USD | Repeat: exact / estimated USD |
| --- | ---: | ---: |
| GPT-4.1 nano → GPT-4.1 nano | 20/20 · $0.000918 | 18/20 · $0.000945 |
| GPT-6 Luna → GPT-4.1 nano | 20/20 · $0.000937 | 18/20 · $0.000933 |
| Jev → Jev | 20/20 · $0.000504 | 20/20 · $0.000504 |
| GPT-6 Luna → Jev | 20/20 · $0.000556 | 18/20 · $0.000557 |
| GPT-6.1 Sol → GPT-4.1 nano | 16/20 · $0.002864 | — |
| GPT-6.1 Sol → Jev | 18/20 · $0.002462 | — |

The [first four paths](../benchmarks/results/travel-chat-seed-continuation-2026-10-16.json), [Luna hybrids](../benchmarks/results/travel-chat-seed-continuation-luna-2026-10-16.json), and [repeat](../benchmarks/results/travel-chat-seed-continuation-repeat-2026-10-16.json) include provider usage, estimated cost, latency, and each turn's expected and predicted labels. Both Sol hybrids used $0.002 of their displayed total on the two seed calls alone. In the first Sol run, the seed incorrectly set a preference on the first message of one chat; that error persisted into the next turn. A Luna seed made a similar first-turn error in the Jev repeat. Jev alone was cheapest and scored 20/20 in both runs. None of these results shows a reliable accuracy gain from a stronger seed on this simple task.

Exact models: `gpt-6.1-sol`, `gpt-6-luna`, `gpt-4.1-nano-2025-04-14`, and `jev-latest`. USD estimates use published Standard text prices checked 2026-10-16: [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-4.1 nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano), and [TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev). They include all seed and update calls and exclude local storage and taxes. `jev-latest` is a moving alias. GPT and Jev provider token totals are recorded for audit but are not compared directly because accounting differs. The paths also use different model interfaces: GPT returns structured JSON; Jev answers its native `choice` and `noul` questions. The cases are scripted label checks, not real tool-call outcomes or held-out validation.

Try the interactive snapshot demo with `npm run chatbot` for GPT or `CHAT_ENGINE=jev npm run chatbot` for Jev. To seed with GPT-6 Luna and continue with Jev, set both API keys and run `CHAT_ENGINE=jev CHAT_SEED_MODEL=gpt-6-luna npm run chatbot`. For nano updates, run `OPENAI_MODEL=gpt-4.1-nano-2025-04-14 CHAT_SEED_MODEL=gpt-6-luna npm run chatbot`. The seed model handles the first message only. To test a live GPT full-history baseline with your own messages, run `CHAT_MODE=full-history npm run chatbot`. That mode calls the GPT API with all messages so far on every turn and saves the transcript in `.belieflang-chat-chatgpt-full-history.json`. Snapshot mode saves `.belieflang-chat-<engine>.json`, or a model-pair-specific file when seeded; the Jev delta mode uses its own `-delta` suffix. These files are ignored by Git. The printed `usage` comes from the provider, and full-history mode also prints `context_messages`. Enter `/exit` to quit. The printed action is a routing decision and does not book travel.

API schema: [TypeSafe OpenAPI](https://api.typesafe.ai/openapi.json). See also [TypeSafe's Jev introduction](https://docs.typesafe.ai/introduction).

OpenAI API references: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [token usage](https://developers.openai.com/api/docs/guides/token-counting).
