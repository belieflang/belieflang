# BeliefLang

## Status

BeliefLang is experimental and under active development.
Breaking changes are expected before 1.0.

BeliefLang is an experimental language runtime for AI agents and uncertain systems.

Instead of treating state as fixed values, BeliefLang represents state as probability distributions and executes actions when confidence or uncertainty crosses a threshold.

```bel
belief intent exclusive closed {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

belief user multi closed {
  budget_sensitive: 0.91
  prefers_direct: 0.84
}

when confidence(intent.book_flight) > 0.7 && user.prefers_direct > 0.5:
  call search_flights()

when entropy(intent) > 0.4 || confidence(intent.other) > 0.1:
  ask_user("What exactly do you want to book?")
```

## Why

Current AI systems repeatedly pass large natural-language context into LLMs. That is expensive and brittle.

BeliefLang explores a smaller execution model:

```txt
natural language -> belief state -> rules -> tools -> observations -> updated belief state
```

The goal is to make uncertain state explicit, inspectable, and executable.

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
- trace output with `--trace`
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

- observations
- belief updates
- provenance tracking
- confidence decay
- JSON belief import/export
- browser playground
- VS Code syntax highlighting
- LLM-backed semantic extraction

## License

Apache-2.0
