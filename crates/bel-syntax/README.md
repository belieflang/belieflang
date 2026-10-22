# bel-syntax

Lexer, recursive-descent parser, and AST types for
[BeliefLang](https://github.com/belieflang/belieflang).

Exports `parse`, `tokenize`, `strip_comments`, and AST types such as `Statement`,
`BeliefBlock`, `Rule`, and `ConditionExpression`.

This crate is part of the BeliefLang workspace and is versioned in lockstep with
[`bel-runtime`](https://crates.io/crates/bel-runtime),
[`bel-providers`](https://crates.io/crates/bel-providers), and the
[`bel-cli`](https://crates.io/crates/bel-cli) executable.

## License

Apache-2.0
