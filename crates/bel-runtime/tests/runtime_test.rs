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

    assert_eq!(runtime.get_vars().get("threshold"), Some(&json!(0.7)));
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
        runtime.get_vars().get("result"),
        Some(&json!({ "count": 2 }))
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
        runtime.get_vars().get("user_message"),
        Some(&json!("book me a flight"))
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
        .merge_beliefs_from_runtime_value(&patch_json, ProvenanceOrigin::Merge, "test")
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
