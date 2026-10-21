use crate::values::RuntimeValue;
use bel_syntax::ast::{BeliefCardinality, BeliefDomain};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProvenanceOrigin {
    Load,
    Merge,
    Infer,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceRecord {
    pub id: u64,
    pub timestamp: u64,
    pub belief_name: String,
    pub label: String,
    pub value: f64,
    pub cardinality: BeliefCardinality,
    pub domain: BeliefDomain,
    pub source: String,
    pub origin: ProvenanceOrigin,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObservationRecord {
    pub id: u64,
    pub event_name: String,
    pub value: RuntimeValue,
    pub timestamp: u64,
}
