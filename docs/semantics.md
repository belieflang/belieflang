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

## Trace mode

Run with `--trace` to print rule evaluation details and executed actions.

```bash
bel run examples/intent.bel --trace
```
