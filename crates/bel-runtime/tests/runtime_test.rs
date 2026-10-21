use bel_runtime::*;
use bel_syntax::ast::{
    BeliefBlock, BeliefCardinality, BeliefDistribution, BeliefDomain, ValueExpression,
};
use bel_syntax::parser::parse;
use indexmap::IndexMap;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[test]
fn normalizes_belief_distributions() {
    let mut runtime = BeliefRuntime::new(ToolRegistry::new(), RuntimeOptions::default());

    let mut values = BeliefDistribution::new();
    values.insert("flight".to_string(), 2.0);
    values.insert("hotel".to_string(), 1.0);

    runtime
        .load_belief(&BeliefBlock {
            name: "intent".to_string(),
            cardinality: BeliefCardinality::Exclusive,
            domain: BeliefDomain::Closed,
            values,
        })
        .unwrap();

    assert_eq!(runtime.confidence("intent.flight"), 2.0 / 3.0);
    assert_eq!(runtime.confidence("intent.hotel"), 1.0 / 3.0);
}

#[test]
fn keeps_unlisted_mass_for_open_exclusive_beliefs() {
    let mut runtime = BeliefRuntime::new(ToolRegistry::new(), RuntimeOptions::default());

    let mut values = BeliefDistribution::new();
    values.insert("berlin".to_string(), 0.7);
    values.insert("paris".to_string(), 0.1);

    runtime
        .load_belief(&BeliefBlock {
            name: "destination".to_string(),
            cardinality: BeliefCardinality::Exclusive,
            domain: BeliefDomain::Open,
            values,
        })
        .unwrap();

    assert_eq!(runtime.confidence("destination.berlin"), 0.7);
    assert!((runtime.confidence("destination.other") - 0.2).abs() < 1e-9);
}

#[test]
fn supports_multi_beliefs_without_normalization() {
    let mut runtime = BeliefRuntime::new(ToolRegistry::new(), RuntimeOptions::default());

    let mut values = BeliefDistribution::new();
    values.insert("cheap".to_string(), 0.84);
    values.insert("direct".to_string(), 0.71);

    runtime
        .load_belief(&BeliefBlock {
            name: "constraint".to_string(),
            cardinality: BeliefCardinality::Multi,
            domain: BeliefDomain::Closed,
            values,
        })
        .unwrap();

    assert_eq!(runtime.confidence("constraint.cheap"), 0.84);
    assert_eq!(runtime.confidence("constraint.direct"), 0.71);
}

#[tokio::test]
async fn stores_literal_variables() {
    let mut runtime = BeliefRuntime::new(ToolRegistry::new(), RuntimeOptions::default());

    runtime
        .assign("threshold", &ValueExpression::Number { value: 0.7 })
        .await
        .unwrap();

    assert_eq!(runtime.get_vars().get("threshold").unwrap(), &json!(0.7));
}

#[tokio::test]
async fn stores_tool_return_values() {
    let mut tools = ToolRegistry::new();
    tools.insert_sync("custom_tool", || json!({ "count": 2 }));

    let mut runtime = BeliefRuntime::new(tools, RuntimeOptions::default());

    runtime
        .assign(
            "result",
            &ValueExpression::Call {
                tool_name: "custom_tool".to_string(),
            },
        )
        .await
        .unwrap();

    assert_eq!(
        runtime.get_vars().get("result").unwrap(),
        &json!({ "count": 2 })
    );
    assert_eq!(runtime.resolve_path("result.count").unwrap(), json!(2));
}

#[tokio::test]
async fn evaluates_compound_rule_conditions() {
    let call_count = Arc::new(AtomicUsize::new(0));
    let call_count_clone = call_count.clone();

    let mut tools = ToolRegistry::new();
    tools.insert_sync("search_flights", || json!({ "count": 2 }));
    tools.insert_sync("rank_flights", move || {
        call_count_clone.fetch_add(1, Ordering::SeqCst);
        serde_json::Value::Null
    });

    let mut runtime = BeliefRuntime::new(tools, RuntimeOptions::default());

    let source = r#"
let threshold = 0.7

belief intent exclusive closed {
  book_flight: 0.82
  book_hotel: 0.18
}

let flights = call search_flights()

when confidence(intent.book_flight) > threshold && (flights.count > 0 || entropy(intent) < 0.2):
  call rank_flights()
"#;

    let statements = parse(source).unwrap();
    runtime.run(&statements).await.unwrap();

    assert_eq!(call_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stores_observations_and_exposes_latest_observed_value_as_variable() {
    let mut runtime = BeliefRuntime::new(ToolRegistry::new(), RuntimeOptions::default());

    runtime
        .observe(
            "user_message",
            Some(&ValueExpression::String {
                value: "book me a flight".to_string(),
            }),
        )
        .await
        .unwrap();

    let obs = runtime.get_observations();
    assert_eq!(obs.len(), 1);
    assert_eq!(obs[0].event_name, "user_message");
    assert_eq!(obs[0].value, json!("book me a flight"));
    assert_eq!(
        runtime.get_vars().get("user_message").unwrap(),
        &json!("book me a flight")
    );
}

#[tokio::test]
async fn infers_beliefs_with_adapter_and_records_provenance() {
    let adapter = ClosureInferAdapter(|_source, _ctx| {
        let mut patch = IndexMap::new();
        let mut intent_vals = BeliefDistribution::new();
        intent_vals.insert("book_flight".to_string(), 0.9);
        intent_vals.insert("book_hotel".to_string(), 0.1);

        patch.insert(
            "intent".to_string(),
            BeliefPatchEntry {
                values: intent_vals,
                cardinality: Some(BeliefCardinality::Exclusive),
                domain: Some(BeliefDomain::Closed),
            },
        );
        Ok(patch)
    });

    let options = RuntimeOptions {
        infer_beliefs: Some(Arc::new(adapter)),
        ..Default::default()
    };

    let mut runtime = BeliefRuntime::new(ToolRegistry::new(), options);

    runtime
        .assign(
            "message",
            &ValueExpression::String {
                value: "book a flight".to_string(),
            },
        )
        .await
        .unwrap();

    runtime
        .infer(&ValueExpression::Identifier {
            name: "message".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(runtime.confidence("intent.book_flight"), 0.9);
    let evidence = runtime.explain_belief("intent.book_flight").unwrap();
    assert!(evidence.iter().any(|r| r.origin == ProvenanceOrigin::Infer));
}

#[test]
fn merges_belief_patches_with_multi_value_clamping() {
    let mut runtime = BeliefRuntime::new(ToolRegistry::new(), RuntimeOptions::default());

    let mut values = BeliefDistribution::new();
    values.insert("cheap".to_string(), 0.2);
    values.insert("direct".to_string(), 0.3);

    runtime
        .load_belief(&BeliefBlock {
            name: "constraint".to_string(),
            cardinality: BeliefCardinality::Multi,
            domain: BeliefDomain::Closed,
            values,
        })
        .unwrap();

    let patch_json = json!({
        "constraint": {
            "cardinality": "multi",
            "domain": "closed",
            "values": {
                "cheap": 1.4,
                "direct": -0.2
            }
        }
    });

    runtime
        .merge_beliefs_from_runtime_value(
            &RuntimeValue::from(patch_json),
            ProvenanceOrigin::Merge,
            "test",
        )
        .unwrap();

    assert_eq!(runtime.confidence("constraint.cheap"), 1.0);
    assert_eq!(runtime.confidence("constraint.direct"), 0.0);

    let evidence = runtime.explain_belief("constraint.cheap").unwrap();
    assert!(evidence.iter().any(|r| r.origin == ProvenanceOrigin::Merge));
}

#[tokio::test]
async fn runs_observe_infer_merge_pipeline_before_rule_evaluation() {
    let rank_calls = Arc::new(AtomicUsize::new(0));
    let rank_calls_clone = rank_calls.clone();

    let mut tools = ToolRegistry::new();
    tools.insert_sync("extract_patch", || {
        json!({
            "intent": {
                "cardinality": "exclusive",
                "domain": "closed",
                "values": {
                    "book_flight": 0.95,
                    "book_hotel": 0.05
                }
            }
        })
    });
    tools.insert_sync("rank_flights", move || {
        rank_calls_clone.fetch_add(1, Ordering::SeqCst);
        serde_json::Value::Null
    });

    let adapter = ClosureInferAdapter(|_source, _ctx| {
        let mut patch = IndexMap::new();
        let mut intent_vals = BeliefDistribution::new();
        intent_vals.insert("book_flight".to_string(), 0.6);
        intent_vals.insert("book_hotel".to_string(), 0.4);

        patch.insert(
            "intent".to_string(),
            BeliefPatchEntry {
                values: intent_vals,
                cardinality: Some(BeliefCardinality::Exclusive),
                domain: Some(BeliefDomain::Closed),
            },
        );
        Ok(patch)
    });

    let options = RuntimeOptions {
        infer_beliefs: Some(Arc::new(adapter)),
        ..Default::default()
    };

    let mut runtime = BeliefRuntime::new(tools, options);

    let source = r#"
let message = "book me a flight"
observe user_message(message)
infer beliefs from user_message

let extracted = call extract_patch()
merge beliefs from extracted

when confidence(intent.book_flight) > 0.7:
  call rank_flights()
"#;

    let statements = parse(source).unwrap();
    runtime.run(&statements).await.unwrap();

    assert_eq!(runtime.get_observations().len(), 1);
    assert_eq!(rank_calls.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.confidence("intent.book_flight"), 0.95);
}

#[test]
fn belief_snapshots_restore_distributions_and_open_mass_without_sharing_mutable_state() {
    let mut original = BeliefRuntime::new(ToolRegistry::new(), RuntimeOptions::default());

    let mut dest_vals = BeliefDistribution::new();
    dest_vals.insert("berlin".to_string(), 0.6);
    dest_vals.insert("paris".to_string(), 0.2);

    original
        .load_belief(&BeliefBlock {
            name: "destination".to_string(),
            cardinality: BeliefCardinality::Exclusive,
            domain: BeliefDomain::Open,
            values: dest_vals,
        })
        .unwrap();

    let mut user_vals = BeliefDistribution::new();
    user_vals.insert("budget_sensitive".to_string(), 0.8);

    original
        .load_belief(&BeliefBlock {
            name: "user".to_string(),
            cardinality: BeliefCardinality::Multi,
            domain: BeliefDomain::Closed,
            values: user_vals,
        })
        .unwrap();

    let snapshot = original.get_belief_snapshot();
    let mut restored = BeliefRuntime::new(ToolRegistry::new(), RuntimeOptions::default());
    restored.load_belief_snapshot(&snapshot).unwrap();

    assert_eq!(restored.confidence("destination.berlin"), 0.6);
    assert!((restored.confidence("destination.other") - 0.2).abs() < 1e-9);
    assert_eq!(restored.confidence("user.budget_sensitive"), 0.8);

    assert_eq!(original.confidence("destination.berlin"), 0.6);
}

#[tokio::test]
async fn sync_and_async_tool_failures_propagate_and_halt_execution() {
    let mut tools = ToolRegistry::new();
    tools.insert_sync(
        "failing_sync",
        || -> Result<serde_json::Value, &'static str> {
            Err("sync tool database connection failed")
        },
    );
    tools.insert_async("failing_async", || async {
        Result::<serde_json::Value, String>::Err("async tool timed out".to_string())
    });

    let mut runtime = BeliefRuntime::new(tools, RuntimeOptions::default());

    // Statement assignment tool failure
    let assign_result = runtime
        .assign(
            "x",
            &ValueExpression::Call {
                tool_name: "failing_sync".to_string(),
            },
        )
        .await;
    assert!(assign_result.is_err());
    assert!(assign_result
        .unwrap_err()
        .contains("sync tool database connection failed"));

    // Action tool failure
    let action_result = runtime
        .execute_action(&bel_syntax::ast::Action::Call {
            tool_name: "failing_async".to_string(),
        })
        .await;
    assert!(action_result.is_err());
    assert!(action_result.unwrap_err().contains("async tool timed out"));

    // Rule condition tool failure
    let rule = bel_syntax::ast::Rule {
        condition: bel_syntax::ast::ConditionExpression::Comparison {
            left: Box::new(ValueExpression::Call {
                tool_name: "failing_sync".to_string(),
            }),
            op: bel_syntax::ast::Operator::Gt,
            right: Box::new(ValueExpression::Number { value: 0.0 }),
        },
        action: bel_syntax::ast::Action::Call {
            tool_name: "rank_flights".to_string(),
        },
    };
    let eval_res = runtime.eval_condition(&rule, 0).await;
    assert!(eval_res.is_err());
    assert!(eval_res
        .unwrap_err()
        .contains("sync tool database connection failed"));
}

#[tokio::test]
async fn comparison_identity_semantics_match_javascript() {
    let mut tools = ToolRegistry::new();
    tools.insert_sync("make_obj", || json!({ "count": 42 }));
    tools.insert_sync("make_arr", || json!([1, 2, 3]));

    let mut runtime = BeliefRuntime::new(tools, RuntimeOptions::default());

    // Create two distinct objects with identical content
    runtime
        .assign(
            "a",
            &ValueExpression::Call {
                tool_name: "make_obj".to_string(),
            },
        )
        .await
        .unwrap();
    runtime
        .assign(
            "b",
            &ValueExpression::Call {
                tool_name: "make_obj".to_string(),
            },
        )
        .await
        .unwrap();
    // Assign c = a (shares the same Arc reference)
    runtime
        .assign(
            "c",
            &ValueExpression::Identifier {
                name: "a".to_string(),
            },
        )
        .await
        .unwrap();

    let val_a = runtime.resolve_path("a").unwrap();
    let val_b = runtime.resolve_path("b").unwrap();
    let val_c = runtime.resolve_path("c").unwrap();

    // In JS: a === b is false, a === c is true, a !== b is true, a !== c is false
    assert!(!compare_values(&val_a, bel_syntax::ast::Operator::Eq, &val_b).unwrap());
    assert!(compare_values(&val_a, bel_syntax::ast::Operator::Eq, &val_c).unwrap());
    assert!(compare_values(&val_a, bel_syntax::ast::Operator::Neq, &val_b).unwrap());
    assert!(!compare_values(&val_a, bel_syntax::ast::Operator::Neq, &val_c).unwrap());

    // Arrays: arr1 === arr2 is false, arr1 === arr3 is true
    runtime
        .assign(
            "arr1",
            &ValueExpression::Call {
                tool_name: "make_arr".to_string(),
            },
        )
        .await
        .unwrap();
    runtime
        .assign(
            "arr2",
            &ValueExpression::Call {
                tool_name: "make_arr".to_string(),
            },
        )
        .await
        .unwrap();
    runtime
        .assign(
            "arr3",
            &ValueExpression::Identifier {
                name: "arr1".to_string(),
            },
        )
        .await
        .unwrap();

    let arr1 = runtime.resolve_path("arr1").unwrap();
    let arr2 = runtime.resolve_path("arr2").unwrap();
    let arr3 = runtime.resolve_path("arr3").unwrap();

    assert!(!compare_values(&arr1, bel_syntax::ast::Operator::Eq, &arr2).unwrap());
    assert!(compare_values(&arr1, bel_syntax::ast::Operator::Eq, &arr3).unwrap());
}

#[test]
fn numeric_coercion_semantics_match_javascript() {
    let empty_str = RuntimeValue::from("");
    let spaces_str = RuntimeValue::from("   ");
    let zero = RuntimeValue::from(0.0);
    let one = RuntimeValue::from(1.0);
    let null_val = RuntimeValue::Null;
    let false_val = RuntimeValue::from(false);
    let true_val = RuntimeValue::from(true);
    let empty_arr = RuntimeValue::from(json!([]));
    let num_arr = RuntimeValue::from(json!(["42"]));
    let multi_arr = RuntimeValue::from(json!([1, 2]));
    let obj = RuntimeValue::from(json!({}));
    let nan_str = RuntimeValue::from("abc");

    // JS strict equality (===): different types are not equal
    assert!(!compare_values(&empty_str, bel_syntax::ast::Operator::Eq, &zero).unwrap());
    assert!(!compare_values(&null_val, bel_syntax::ast::Operator::Eq, &zero).unwrap());
    assert!(!compare_values(&false_val, bel_syntax::ast::Operator::Eq, &zero).unwrap());
    assert!(!compare_values(&true_val, bel_syntax::ast::Operator::Eq, &one).unwrap());

    // Relational comparisons coerce operands like Number(val) in JavaScript
    // Number("") === 0, so "" < 1 is true, "" <= 0 is true
    assert!(compare_values(&empty_str, bel_syntax::ast::Operator::Lt, &one).unwrap());
    assert!(compare_values(&empty_str, bel_syntax::ast::Operator::Lte, &zero).unwrap());
    assert!(compare_values(&spaces_str, bel_syntax::ast::Operator::Lt, &one).unwrap());

    // Number(null) === 0
    assert!(compare_values(&null_val, bel_syntax::ast::Operator::Lt, &one).unwrap());
    assert!(compare_values(&null_val, bel_syntax::ast::Operator::Lte, &zero).unwrap());

    // Number(false) === 0, Number(true) === 1
    assert!(compare_values(&false_val, bel_syntax::ast::Operator::Lt, &one).unwrap());
    assert!(compare_values(&true_val, bel_syntax::ast::Operator::Lte, &one).unwrap());

    // Number([]) === 0
    assert!(compare_values(&empty_arr, bel_syntax::ast::Operator::Lt, &one).unwrap());

    // Number(["42"]) === 42
    let forty = RuntimeValue::from(40.0);
    assert!(compare_values(&num_arr, bel_syntax::ast::Operator::Gt, &forty).unwrap());

    // Coercion resulting in NaN errors out with "Operator <op> requires numeric operands"
    assert!(
        compare_values(&multi_arr, bel_syntax::ast::Operator::Gt, &zero)
            .unwrap_err()
            .contains("requires numeric operands")
    );
    assert!(compare_values(&obj, bel_syntax::ast::Operator::Gt, &zero)
        .unwrap_err()
        .contains("requires numeric operands"));
    assert!(
        compare_values(&nan_str, bel_syntax::ast::Operator::Lt, &one)
            .unwrap_err()
            .contains("requires numeric operands")
    );
}
