pub mod ast;
pub mod lexer;
pub mod parser;

pub use ast::*;
pub use lexer::{strip_comments, tokenize, SyntaxError, Token, TokenKind};
pub use parser::{parse, Parser};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_statements_in_source_order_with_belief_modifiers() {
        let source = r#"
let threshold = 0.7

belief intent exclusive closed {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

belief destination exclusive open {
  berlin: 0.61
  paris: 0.22
}

when confidence(intent.book_flight) > threshold:
  call rank_flights()
"#;
        let statements = parse(source).unwrap();
        assert_eq!(statements.len(), 4);

        match &statements[0] {
            Statement::Let(l) => {
                assert_eq!(l.name, "threshold");
                assert_eq!(l.value, ValueExpression::Number { value: 0.7 });
            }
            _ => panic!("Expected let statement"),
        }

        match &statements[1] {
            Statement::Belief(b) => {
                assert_eq!(b.name, "intent");
                assert_eq!(b.cardinality, BeliefCardinality::Exclusive);
                assert_eq!(b.domain, BeliefDomain::Closed);
                assert_eq!(b.values.get("book_flight"), Some(&0.82));
                assert_eq!(b.values.get("book_hotel"), Some(&0.12));
                assert_eq!(b.values.get("unknown"), Some(&0.06));
            }
            _ => panic!("Expected belief statement"),
        }

        match &statements[2] {
            Statement::Belief(b) => {
                assert_eq!(b.name, "destination");
                assert_eq!(b.cardinality, BeliefCardinality::Exclusive);
                assert_eq!(b.domain, BeliefDomain::Open);
                assert_eq!(b.values.get("berlin"), Some(&0.61));
                assert_eq!(b.values.get("paris"), Some(&0.22));
            }
            _ => panic!("Expected belief statement"),
        }

        match &statements[3] {
            Statement::Rule(r) => {
                assert!(matches!(
                    r.condition,
                    ConditionExpression::Comparison { .. }
                ));
                assert_eq!(
                    r.action,
                    Action::Call {
                        tool_name: "rank_flights".to_string()
                    }
                );
            }
            _ => panic!("Expected rule statement"),
        }
    }

    #[test]
    fn parses_compound_conditions_with_precedence_and_grouping() {
        let source = r#"
belief intent {
  book_flight: 0.82
  book_hotel: 0.18
}

let flights = call search_flights()

when confidence(intent.book_flight) > 0.7 && (flights.count > 0 || !false):
  ask_user("I found flight options.")
"#;
        let statements = parse(source).unwrap();
        let rule = match statements.last().unwrap() {
            Statement::Rule(r) => r,
            _ => panic!("Expected rule statement"),
        };

        match &rule.condition {
            ConditionExpression::And { left, right } => {
                assert!(matches!(**left, ConditionExpression::Comparison { .. }));
                match &**right {
                    ConditionExpression::Or { left, right } => {
                        assert!(matches!(**left, ConditionExpression::Comparison { .. }));
                        assert!(matches!(**right, ConditionExpression::Not { .. }));
                    }
                    _ => panic!("Expected or condition on the right"),
                }
            }
            _ => panic!("Expected and condition at top-level"),
        }
    }

    #[test]
    fn parses_observe_infer_and_merge_statements() {
        let source = r#"
let message = "I need a cheap direct flight"

observe user_message(message)
infer beliefs from message

let extracted = call extract_beliefs()
merge beliefs from extracted

when confidence(intent.book_flight) > 0.7:
  call rank_flights()
"#;
        let statements = parse(source).unwrap();
        assert_eq!(statements.len(), 6);

        assert!(matches!(statements[1], Statement::Observe(_)));
        assert!(matches!(statements[2], Statement::Infer(_)));
        assert!(matches!(statements[4], Statement::MergeBeliefs(_)));

        if let Statement::Observe(obs) = &statements[1] {
            assert_eq!(obs.event_name, "user_message");
            assert_eq!(
                obs.value,
                Some(ValueExpression::Identifier {
                    name: "message".to_string()
                })
            );
        }

        if let Statement::Infer(inf) = &statements[2] {
            assert_eq!(
                inf.source,
                ValueExpression::Identifier {
                    name: "message".to_string()
                }
            );
        }

        if let Statement::MergeBeliefs(m) = &statements[4] {
            assert_eq!(
                m.source,
                ValueExpression::Identifier {
                    name: "extracted".to_string()
                }
            );
        }
    }

    #[test]
    fn parses_all_existing_examples() {
        let example_paths = [
            "../../examples/chatgpt_hotel.bel",
            "../../examples/chatgpt_unknown.bel",
            "../../examples/intent.bel",
            "../../examples/intent_no_flight.bel",
            "../../examples/jev_intent.bel",
            "../../examples/observe_infer_merge.bel",
            "../../examples/viability/operations.bel",
            "../../examples/viability/support.bel",
            "../../examples/viability/travel.bel",
        ];

        for path in example_paths {
            let content = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("Failed to read {path}: {e}"));
            let parsed = parse(&content).unwrap_or_else(|e| panic!("Failed to parse {path}: {e}"));
            assert!(
                !parsed.is_empty(),
                "Parsed program {path} should not be empty"
            );
        }
    }
}
