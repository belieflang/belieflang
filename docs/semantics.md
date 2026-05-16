# BeliefLang Semantics

BeliefLang programs operate over belief state.

A belief state is a named probability distribution:

```bel
belief intent {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}
```

The runtime normalizes distributions automatically.

## Confidence

```bel
confidence(intent.book_flight)
```

Returns the probability assigned to a single belief value.

## Entropy

```bel
entropy(intent)
```

Returns normalized Shannon entropy in `[0, 1]`.

- `0` means certain
- `1` means maximally uncertain

## Rules

```bel
when confidence(intent.book_flight) > 0.7:
  call search_flights()
```

Rules are reactive. They fire when their condition evaluates to true.

## Tools

Tools are external capabilities exposed to the runtime.

They may call APIs, models, databases, browsers, or other systems.
