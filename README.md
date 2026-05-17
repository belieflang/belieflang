# BeliefLang

## Status

BeliefLang is experimental and under active development.
Breaking changes are expected before 1.0.

BeliefLang is an experimental language runtime for AI agents and uncertain systems.

Instead of treating state as fixed values, BeliefLang represents state as probability distributions and executes actions when confidence or uncertainty crosses a threshold.

```bel
belief intent {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

when confidence(intent.book_flight) > 0.7:
  call search_flights()

when entropy(intent) > 0.4:
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

During local development:

```bash
npm run dev
```

## Current features

- `belief` blocks
- normalized probability distributions
- `let` variables
- tool return values
- property access like `flights.count`
- `confidence(...)`
- normalized `entropy(...)`
- `when` rules
- `call tool()`
- `ask_user("...")`
- tiny Node.js CLI

## Non-goals

BeliefLang is not trying to replace Python, JavaScript, or SQL.

It is not a general-purpose language.

It is a small experimental runtime for belief-state execution, AI agents, and uncertainty-aware orchestration.

## Example output

```txt
[state]
  intent: book_flight=0.820, book_hotel=0.120, unknown=0.060
[tool] search_flights()
[ask_user] What exactly do you want to book?
```

## Roadmap

- observations
- belief updates
- tool return values
- provenance tracking
- confidence decay
- JSON belief import/export
- browser playground
- VS Code syntax highlighting
- LLM-backed semantic extraction

## License

Apache-2.0
