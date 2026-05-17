# BeliefLang Semantics

BeliefLang programs operate over belief state and variables.

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

## Tools

Tools return JSON-compatible values.
