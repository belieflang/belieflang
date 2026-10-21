use bel_syntax::ast::{BeliefCardinality, BeliefDistribution, BeliefDomain};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeliefSnapshotEntry {
    pub cardinality: BeliefCardinality,
    pub domain: BeliefDomain,
    pub values: BeliefDistribution,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeliefSnapshot {
    pub version: u32,
    pub beliefs: IndexMap<String, BeliefSnapshotEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FactDeclaration {
    Simple(String),
    Detailed {
        #[serde(rename = "type")]
        fact_type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[serde(rename = "enum")]
        variants: Option<Vec<String>>,
    },
}

impl FactDeclaration {
    pub fn fact_type(&self) -> &str {
        match self {
            FactDeclaration::Simple(t) => t,
            FactDeclaration::Detailed { fact_type, .. } => fact_type,
        }
    }

    pub fn variants(&self) -> Option<&[String]> {
        match self {
            FactDeclaration::Simple(_) => None,
            FactDeclaration::Detailed { variants, .. } => variants.as_deref(),
        }
    }
}

pub type FactSchema = IndexMap<String, FactDeclaration>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactRecord {
    #[serde(rename = "type")]
    pub fact_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    pub confidence: f64,
    pub source_turn: i64,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactPatchEntry {
    pub operation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    pub confidence: f64,
    pub source_turn: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongHorizonSnapshot {
    pub version: u32,
    pub beliefs: IndexMap<String, BeliefSnapshotEntry>,
    pub fact_schema: FactSchema,
    pub facts: IndexMap<String, FactRecord>,
}
