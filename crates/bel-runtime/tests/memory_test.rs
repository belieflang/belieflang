use bel_runtime::guard::AgentDecisionGuard;
use bel_runtime::memory::{FactDelta, FactMemory, FactSource, FactStatus, FactView};
use bel_runtime::snapshots::{BeliefSnapshot, FactDeclaration, FactSchema};
use bel_runtime::BeliefRuntime;
use bel_syntax::ast::{BeliefBlock, BeliefCardinality, BeliefDistribution, BeliefDomain};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

fn source(turn: i64) -> FactSource {
    FactSource {
        turn,
        id: format!("turn:{turn}"),
        text: format!("message {turn}"),
    }
}

fn set_delta(field: &str, value: Value, confidence: f64, basis: &str) -> FactDelta {
    FactDelta {
        op: "set".to_string(),
        field: field.to_string(),
        value: Some(value),
        confidence,
        basis: basis.to_string(),
    }
}

fn test_schema() -> FactSchema {
    let mut s = IndexMap::new();
    s.insert(
        "destination".to_string(),
        FactDeclaration::Simple("string".to_string()),
    );
    s.insert(
        "budget".to_string(),
        FactDeclaration::Simple("number".to_string()),
    );
    s.insert(
        "direct".to_string(),
        FactDeclaration::Simple("boolean".to_string()),
    );
    s
}

#[test]
fn delta_changes_only_the_named_field_replay_and_noop_preserve_provenance() {
    let schema = test_schema();
    let mut m = FactMemory::new(schema, None, None).unwrap();

    let s1 = source(1);
    let confs = IndexMap::new();
    m.apply(
        &[
            set_delta("destination", json!("Lisbon"), 0.9, "explicit"),
            set_delta("budget", json!(1500), 0.9, "explicit"),
        ],
        &s1,
        &confs,
    )
    .unwrap();

    let old = m.current();

    let s2 = source(2);
    m.apply(
        &[set_delta("budget", json!(1700), 0.9, "explicit")],
        &s2,
        &confs,
    )
    .unwrap();

    assert_eq!(m.current().get("destination"), old.get("destination"));
    assert_eq!(m.current().get("budget").unwrap().value, Some(json!(1700)));

    let snapshot = m.snapshot();
    let replay_res = m
        .apply(
            &[set_delta("budget", json!(1700), 0.9, "explicit")],
            &s2,
            &confs,
        )
        .unwrap();
    assert!(replay_res.replayed);
    assert_eq!(m.snapshot(), snapshot);

    let s3 = source(3);
    let noop_res = m
        .apply(
            &[set_delta("budget", json!(1700), 0.1, "explicit")],
            &s3,
            &confs,
        )
        .unwrap();
    assert_eq!(noop_res.unchanged, 1);
    assert_eq!(m.current().get("budget"), snapshot.current.get("budget"));
    assert_eq!(m.snapshot().history.len(), 3);

    // Replay with different patch must fail
    assert!(m
        .apply(
            &[set_delta("budget", json!(1), 0.9, "explicit")],
            &s2,
            &confs
        )
        .is_err());
}

#[test]
fn batch_validation_is_atomic_and_model_metadata_is_rejected() {
    let schema = test_schema();
    let mut m = FactMemory::new(schema, None, None).unwrap();
    let before = m.snapshot();
    let s1 = source(1);
    let confs = IndexMap::new();

    // Wrong type
    assert!(m
        .apply(
            &[set_delta("budget", json!("wrong"), 0.9, "explicit")],
            &s1,
            &confs
        )
        .is_err());
    assert_eq!(m.snapshot(), before);

    // Unknown field
    assert!(m
        .apply(
            &[set_delta("unknown", json!(2), 0.9, "explicit")],
            &s1,
            &confs
        )
        .is_err());
    assert_eq!(m.snapshot(), before);

    // Duplicate field in batch
    assert!(m
        .apply(
            &[
                set_delta("budget", json!(1), 0.9, "explicit"),
                set_delta("budget", json!(2), 0.9, "explicit")
            ],
            &s1,
            &confs
        )
        .is_err());
    assert_eq!(m.snapshot(), before);

    // Clear with inferred basis
    assert!(m
        .apply(
            &[FactDelta {
                op: "clear".to_string(),
                field: "budget".to_string(),
                value: None,
                confidence: 0.9,
                basis: "inferred".to_string()
            }],
            &s1,
            &confs
        )
        .is_err());
    assert_eq!(m.snapshot(), before);

    // Confirmation type mismatch
    let mut bad_confs = IndexMap::new();
    bad_confs.insert("destination".to_string(), json!(10));
    assert!(m
        .apply(
            &[set_delta("budget", json!(10), 0.9, "explicit")],
            &s1,
            &bad_confs
        )
        .is_err());
}

#[test]
fn explicit_negation_reversal_conflict_resolution_historical_retrieval() {
    let schema = test_schema();
    let mut m = FactMemory::new(schema, None, None).unwrap();

    let mut c1 = IndexMap::new();
    c1.insert("budget".to_string(), json!(1500));
    c1.insert("direct".to_string(), json!(true));

    m.apply(
        &[
            set_delta("budget", json!(1500), 0.9, "explicit"),
            set_delta("direct", json!(true), 0.9, "explicit"),
        ],
        &source(1),
        &c1,
    )
    .unwrap();

    let empty = IndexMap::new();
    m.apply(
        &[set_delta("direct", json!(false), 0.9, "explicit")],
        &source(2),
        &empty,
    )
    .unwrap();
    assert_eq!(m.current().get("direct").unwrap().value, Some(json!(false)));

    m.apply(
        &[FactDelta {
            op: "clear".to_string(),
            field: "destination".to_string(),
            value: None,
            confidence: 0.9,
            basis: "explicit".to_string(),
        }],
        &source(3),
        &empty,
    )
    .unwrap();
    assert_eq!(
        m.current().get("destination").unwrap().status,
        FactStatus::Cleared
    );

    m.apply(
        &[set_delta("budget", json!(2000), 1.0, "inferred")],
        &source(4),
        &empty,
    )
    .unwrap();
    assert_eq!(
        m.current().get("budget").unwrap().status,
        FactStatus::Conflicting
    );
    assert_eq!(
        m.current().get("budget").unwrap().candidates,
        Some(vec![json!(1500), json!(2000)])
    );

    m.apply(
        &[set_delta("budget", json!(1600), 0.05, "explicit")],
        &source(5),
        &empty,
    )
    .unwrap();
    assert_eq!(m.current().get("budget").unwrap().value, Some(json!(1600)));
    assert_eq!(
        m.current().get("budget").unwrap().status,
        FactStatus::Uncertain
    );

    let original = m.retrieve("budget", "original", None).unwrap();
    assert_eq!(original[0].value, Some(json!(1500)));
    assert_eq!(original[0].source.turn, 1);

    let previous = m.retrieve("budget", "previous", None).unwrap();
    assert_eq!(previous[0].value, Some(json!(1500)));

    let changes = m.retrieve("budget", "changes", Some(2)).unwrap();
    assert_eq!(changes.len(), 2);

    let ctx = serde_json::to_string(&m.context()).unwrap();
    assert!(!ctx.contains("message"));
    assert!(!ctx.contains("revision"));
    assert!(!ctx.contains("history"));
}

#[tokio::test]
async fn deterministic_tools_fail_closed_reject_stale_or_revoked_approval() {
    let schema = test_schema();
    let mut m = FactMemory::new(schema, None, None).unwrap();
    let mut guard = AgentDecisionGuard::new();

    let calls = Arc::new(AtomicUsize::new(0));

    let mut params = IndexMap::new();
    params.insert("budget".to_string(), json!(2));

    let calls1 = calls.clone();
    let (dec, res) = guard
        .execute(
            &FactView {
                current: m.current(),
            },
            "book",
            &params,
            1,
            move || {
                let c = calls1.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    c.load(Ordering::SeqCst)
                }
            },
        )
        .await
        .unwrap();
    assert_eq!(dec.reason, "approval_missing");
    assert_eq!(res, None);

    let empty = IndexMap::new();
    m.apply(
        &[set_delta("budget", json!(2), 1.0, "explicit")],
        &source(1),
        &empty,
    )
    .unwrap();

    guard
        .record(
            &FactView {
                current: m.current(),
            },
            "book",
            true,
            &["budget".to_string()],
            &source(2),
            None,
        )
        .unwrap();

    let dec = guard
        .explain(
            &FactView {
                current: m.current(),
            },
            "book",
            &params,
            3,
        )
        .unwrap();
    assert!(dec.reason.contains("not_confirmed"));

    let mut confs = IndexMap::new();
    confs.insert("budget".to_string(), json!(2));
    m.apply(
        &[set_delta("budget", json!(2), 0.9, "explicit")],
        &source(3),
        &confs,
    )
    .unwrap();

    let dec = guard
        .explain(
            &FactView {
                current: m.current(),
            },
            "book",
            &params,
            3,
        )
        .unwrap();
    assert!(dec.reason.contains("stale_approval"));

    guard
        .record(
            &FactView {
                current: m.current(),
            },
            "book",
            true,
            &["budget".to_string()],
            &source(4),
            Some(6),
        )
        .unwrap();

    let calls2 = calls.clone();
    let (dec, res) = guard
        .execute(
            &FactView {
                current: m.current(),
            },
            "book",
            &params,
            4,
            move || {
                let c = calls2.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    c.load(Ordering::SeqCst)
                }
            },
        )
        .await
        .unwrap();
    assert_eq!(res, Some(1));
    assert!(dec.allowed);

    let dec_expired = guard
        .explain(
            &FactView {
                current: m.current(),
            },
            "book",
            &params,
            7,
        )
        .unwrap();
    assert!(!dec_expired.allowed);

    let mut bad_params = IndexMap::new();
    bad_params.insert("budget".to_string(), json!(3));
    let dec_bad_param = guard
        .explain(
            &FactView {
                current: m.current(),
            },
            "book",
            &bad_params,
            5,
        )
        .unwrap();
    assert!(!dec_bad_param.allowed);

    guard
        .record(
            &FactView {
                current: m.current(),
            },
            "book",
            false,
            &["budget".to_string()],
            &source(5),
            None,
        )
        .unwrap();
    let dec_revoked = guard
        .explain(
            &FactView {
                current: m.current(),
            },
            "book",
            &params,
            6,
        )
        .unwrap();
    assert_eq!(dec_revoked.reason, "approval_revoked");
}

#[test]
fn snapshot_round_trip_tamper_rejection_and_bounds() {
    let schema = test_schema();
    let mut m = FactMemory::new(schema, None, Some(1)).unwrap();

    let empty = IndexMap::new();
    m.apply(
        &[set_delta("budget", json!(2), 0.9, "explicit")],
        &source(1),
        &empty,
    )
    .unwrap();

    let saved = m.snapshot();
    let restored = FactMemory::restore_from_snapshot(&saved).unwrap();
    assert_eq!(restored.snapshot(), saved);

    let mut tampered = saved.clone();
    if let Some(cell) = tampered.current.get_mut("budget") {
        cell.value = Some(json!(10));
    }
    assert!(FactMemory::restore_from_snapshot(&tampered).is_err());

    // History limit exceeded
    assert!(m
        .apply(
            &[set_delta("budget", json!(3), 0.9, "explicit")],
            &source(2),
            &empty
        )
        .is_err());
}

#[test]
fn v1_and_v2_migrations_retain_beliefs_and_uncertain_evidence() {
    let mut rt = BeliefRuntime::new(
        bel_runtime::ToolRegistry::new(),
        bel_runtime::RuntimeOptions::default(),
    );
    let v1 = rt.get_belief_snapshot();
    let migrated = FactMemory::restore_from_v1(&v1, test_schema()).unwrap();
    assert!(!migrated.snapshot().history_complete);

    rt.declare_facts(test_schema()).unwrap();
    let mut patch = IndexMap::new();
    patch.insert(
        "budget".to_string(),
        bel_runtime::snapshots::FactPatchEntry {
            operation: "set".to_string(),
            value: Some(json!(1500)),
            confidence: 1.0,
            source_turn: 8,
        },
    );
    rt.merge_fact_patch(&patch).unwrap();

    let v2_snap = rt.get_long_horizon_snapshot();
    let v2 = FactMemory::restore_from_v2(&v2_snap).unwrap();
    assert_eq!(v2.current().get("budget").unwrap().value, Some(json!(1500)));
    assert_eq!(
        v2.current().get("budget").unwrap().status,
        FactStatus::Uncertain
    );
    assert_eq!(v2.retrieve("budget", "original", None).unwrap(), Vec::new());
    assert!(!v2.snapshot().history_complete);
}

#[test]
fn combined_runtime_snapshots_capture_numeric_beliefs_and_attach_restored_memory() {
    let schema = test_schema();
    let memory = FactMemory::new(schema, None, None).unwrap();
    let rt_options = bel_runtime::RuntimeOptions {
        memory: Some(memory),
        ..Default::default()
    };

    let mut rt = BeliefRuntime::new(bel_runtime::ToolRegistry::new(), rt_options);

    let mut intent_vals = BeliefDistribution::new();
    intent_vals.insert("flight".to_string(), 0.7);
    intent_vals.insert("hotel".to_string(), 0.3);

    rt.load_belief(&BeliefBlock {
        name: "intent".to_string(),
        cardinality: BeliefCardinality::Exclusive,
        domain: BeliefDomain::Closed,
        values: intent_vals,
    })
    .unwrap();

    rt.memory
        .as_mut()
        .unwrap()
        .apply(
            &[set_delta("budget", json!(1500), 0.9, "explicit")],
            &source(1),
            &IndexMap::new(),
        )
        .unwrap();

    let saved = rt.get_memory_snapshot().unwrap();
    assert_eq!(
        saved.beliefs.get("intent").unwrap().values.get("flight"),
        Some(&0.7)
    );

    let restored_mem = FactMemory::restore_from_snapshot(&saved).unwrap();
    let rt2_options = bel_runtime::RuntimeOptions {
        memory: Some(restored_mem),
        ..Default::default()
    };

    let mut restored_rt = BeliefRuntime::new(bel_runtime::ToolRegistry::new(), rt2_options);
    restored_rt
        .load_belief_snapshot(&BeliefSnapshot {
            version: 1,
            beliefs: saved.beliefs.clone(),
        })
        .unwrap();

    assert_eq!(restored_rt.get_memory_snapshot().unwrap(), saved);
}
