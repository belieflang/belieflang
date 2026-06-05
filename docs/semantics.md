# BeliefLang Semantics

BeliefLang programs operate over belief state and variables.

## Belief modes

```bel
belief intent exclusive closed {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

belief destination exclusive open {
  berlin: 0.61
  paris: 0.22
}

belief user_preferences multi closed {
  budget_sensitive: 0.91
  prefers_direct: 0.84
}
```

- `exclusive closed`: values are normalized to a full distribution.
- `exclusive open`: listed values must sum to `<= 1`; remaining mass is available through `confidence(name.other)`.
- `multi`: each value is an independent confidence in `[0, 1]`.

## Variables

```bel
let threshold = 0.7
let flights = call search_flights()
```

Variables can store literals or tool return values.

## Property access

```bel
when flights.count > 0:
  ask_user("I found flight options.")
```

## Compound conditions

```bel
when confidence(intent.book_flight) > 0.7 && (flights.count > 0 || !false):
  call rank_flights()
```

Condition operators:

- comparison: `>`, `>=`, `<`, `<=`, `==`, `!=`
- boolean: `&&`, `||`, `!`
- grouping: parentheses

## Tools

Tools return JSON-compatible values.

## Observations

```bel
let message = "I need a cheap direct flight"
observe user_message(message)
```

- An observation is appended to runtime observation history.
- The latest observed value is also assigned to a variable with the same event name (`user_message` in the example).

## Inference

```bel
infer beliefs from user_message
```

- Inference passes the source value and runtime context (observations, current state, variables) to an infer adapter.
- The inferred patch is merged into current beliefs using merge semantics.

## Merge beliefs

```bel
let extracted = call extract_patch()
merge beliefs from extracted
```

- Merge accepts an object keyed by belief name.
- Each entry can be either a direct distribution object or a structured patch:

```txt
{
  intent: {
    cardinality: "exclusive",
    domain: "closed",
    values: { book_flight: 0.9, book_hotel: 0.1 }
  },
  constraint: {
    values: { cheap: 1.2 }
  }
}
```

- Existing labels are preserved unless overwritten.
- Multi-belief merge clamps values into `[0, 1]`.

## Provenance

- Every belief load/merge/infer update records provenance with source and timestamp.
- Runtime APIs:
  - `getProvenance()` for full history
  - `explainBelief("intent.book_flight")` for filtered history

## Trace mode

Run with `--trace` to print rule evaluation details and executed actions.

```bash
bel run examples/intent.bel --trace
```
