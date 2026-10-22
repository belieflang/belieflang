use crate::snapshots::{BeliefSnapshot, FactSchema, LongHorizonSnapshot};
use bel_syntax::ast::{BeliefCardinality, BeliefDomain};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FactStatus {
    Confirmed,
    Uncertain,
    Conflicting,
    Cleared,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FactDelta {
    pub op: String,
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    pub confidence: f64,
    pub basis: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FactSource {
    pub turn: i64,
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SourceRef {
    pub turn: i64,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryCell {
    pub status: FactStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<Value>>,
    pub confidence: f64,
    pub revision: i64,
    pub source: SourceRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeEvent {
    pub id: i64,
    pub field: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<MemoryCell>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<MemoryCell>,
    pub source: SourceRef,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal: Option<FactDelta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePolicy {
    pub inferred_min_confidence: f64,
}

impl Default for UpdatePolicy {
    fn default() -> Self {
        Self {
            inferred_min_confidence: 0.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Receipt {
    pub turn: i64,
    pub id: String,
    pub patch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub version: u32,
    pub schema: FactSchema,
    pub current: IndexMap<String, MemoryCell>,
    pub history: Vec<ChangeEvent>,
    pub sources: IndexMap<String, FactSource>,
    pub receipts: Vec<Receipt>,
    pub last_turn: i64,
    pub history_complete: bool,
    pub policy: UpdatePolicy,
    pub max_history: usize,
    pub beliefs: IndexMap<String, crate::snapshots::BeliefSnapshotEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FactView {
    pub current: IndexMap<String, MemoryCell>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApplyResult {
    pub changed: usize,
    pub unchanged: usize,
    pub deferred: usize,
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoricalEntry {
    pub event: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<FactStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<Value>>,
    pub source: SourceRef,
    pub text: String,
}

fn canonical_json(val: &Value) -> Value {
    match val {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut sorted = serde_json::Map::new();
            for k in keys {
                sorted.insert(k.clone(), canonical_json(&map[k]));
            }
            Value::Object(sorted)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(canonical_json).collect()),
        _ => val.clone(),
    }
}

pub fn same_value(a: &Value, b: &Value) -> bool {
    let a_canon = canonical_json(a);
    let b_canon = canonical_json(b);
    a_canon == b_canon
}

pub fn validate_fact_schema(schema: &FactSchema) -> Result<(), String> {
    for (field, decl) in schema {
        let field_regex_valid = !field.is_empty()
            && field.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && field
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');

        if !field_regex_valid || field == "constructor" || field == "prototype" {
            return Err(format!("invalid field {field}"));
        }

        let fact_type = decl.fact_type();
        if fact_type != "string" && fact_type != "number" && fact_type != "boolean" {
            return Err(format!("invalid field {field}"));
        }

        if let Some(variants) = decl.variants() {
            if fact_type != "string" || variants.is_empty() {
                return Err(format!("invalid enum {field}"));
            }
            let mut set = std::collections::HashSet::new();
            for v in variants {
                if v.is_empty() || !set.insert(v) {
                    return Err(format!("invalid enum {field}"));
                }
            }
        }
    }
    Ok(())
}

pub fn validate_fact_value(
    schema: &FactSchema,
    field: &str,
    val: Option<&Value>,
) -> Result<(), String> {
    let decl = schema
        .get(field)
        .ok_or_else(|| format!("undeclared fact {field}"))?;
    let val = val.ok_or_else(|| format!("invalid value for {field}"))?;

    let expected_type = decl.fact_type();
    match expected_type {
        "string" => {
            if let Value::String(s) = val {
                if let Some(variants) = decl.variants() {
                    if !variants.iter().any(|v| v == s) {
                        return Err(format!("invalid value for {field}"));
                    }
                }
            } else {
                return Err(format!("invalid value for {field}"));
            }
        }
        "number" => {
            if let Value::Number(n) = val {
                if let Some(f) = n.as_f64() {
                    if !f.is_finite() {
                        return Err(format!("invalid value for {field}"));
                    }
                } else {
                    return Err(format!("invalid value for {field}"));
                }
            } else {
                return Err(format!("invalid value for {field}"));
            }
        }
        "boolean" => {
            if !val.is_boolean() {
                return Err(format!("invalid value for {field}"));
            }
        }
        _ => return Err(format!("invalid value for {field}")),
    }

    Ok(())
}

pub fn validate_deltas(schema: &FactSchema, deltas: &[FactDelta]) -> Result<(), String> {
    let mut fields = std::collections::HashSet::new();

    for item in deltas {
        if !schema.contains_key(&item.field) || !fields.insert(&item.field) {
            return Err("invalid or duplicate delta".to_string());
        }

        if item.op != "set" && item.op != "clear" && item.op != "conflict" {
            return Err("invalid or duplicate delta".to_string());
        }

        if item.basis != "explicit" && item.basis != "inferred" {
            return Err("invalid or duplicate delta".to_string());
        }

        if !item.confidence.is_finite() || item.confidence < 0.0 || item.confidence > 1.0 {
            return Err("invalid or duplicate delta".to_string());
        }

        if item.op == "clear" {
            if item.value.is_some() {
                return Err("clear must not supply a value".to_string());
            }
            if item.basis != "explicit" {
                return Err("clearing requires an explicit withdrawal".to_string());
            }
        } else {
            validate_fact_value(schema, &item.field, item.value.as_ref())?;
        }
    }

    Ok(())
}

pub fn validate_source(source: &FactSource) -> Result<(), String> {
    if source.turn < 1 {
        return Err("invalid host source".to_string());
    }

    let id = &source.id;
    if id.is_empty()
        || id.len() > 128
        || id == "__proto__"
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '_' || c == '-')
    {
        return Err("invalid host source".to_string());
    }

    Ok(())
}

type SemanticTuple<'a> = (String, Option<&'a Value>, Option<&'a Vec<Value>>);

fn semantic_tuple(cell: Option<&MemoryCell>) -> Option<SemanticTuple<'_>> {
    cell.map(|c| {
        (
            serde_json::to_string(&c.status).unwrap_or_default(),
            c.value.as_ref(),
            c.candidates.as_ref(),
        )
    })
}

#[derive(Debug, Clone)]
pub struct FactMemory {
    data: MemorySnapshot,
}

impl FactMemory {
    pub fn new(
        schema: FactSchema,
        policy: Option<UpdatePolicy>,
        max_history: Option<usize>,
    ) -> Result<Self, String> {
        validate_fact_schema(&schema)?;
        let policy = policy.unwrap_or_default();
        if !policy.inferred_min_confidence.is_finite()
            || policy.inferred_min_confidence < 0.0
            || policy.inferred_min_confidence > 1.0
        {
            return Err("invalid update policy".to_string());
        }

        let max_history = max_history.unwrap_or(256);
        if max_history < 1 {
            return Err("invalid history limit".to_string());
        }

        Ok(Self {
            data: MemorySnapshot {
                version: 3,
                schema,
                current: IndexMap::new(),
                history: Vec::new(),
                sources: IndexMap::new(),
                receipts: Vec::new(),
                last_turn: 0,
                history_complete: true,
                policy,
                max_history,
                beliefs: IndexMap::new(),
            },
        })
    }

    pub fn current(&self) -> IndexMap<String, MemoryCell> {
        self.data.current.clone()
    }

    pub fn snapshot(&self) -> MemorySnapshot {
        self.data.clone()
    }

    pub fn context(&self) -> IndexMap<String, Value> {
        let mut ctx = IndexMap::new();
        for (k, cell) in &self.data.current {
            let mut obj = serde_json::Map::new();
            obj.insert(
                "status".to_string(),
                serde_json::to_value(&cell.status).unwrap_or(Value::Null),
            );
            if let Some(v) = &cell.value {
                obj.insert("value".to_string(), v.clone());
            }
            if let Some(c) = &cell.candidates {
                obj.insert("candidates".to_string(), Value::Array(c.clone()));
            }
            ctx.insert(k.clone(), Value::Object(obj));
        }
        ctx
    }

    pub fn apply(
        &mut self,
        deltas: &[FactDelta],
        source: &FactSource,
        confirmations: &IndexMap<String, Value>,
    ) -> Result<ApplyResult, String> {
        validate_deltas(&self.data.schema, deltas)?;
        validate_source(source)?;

        for (field, val) in confirmations {
            validate_fact_value(&self.data.schema, field, Some(val))?;
        }

        // Canonical JSON patch for replay check
        let mut sorted_deltas = deltas.to_vec();
        sorted_deltas.sort_by(|a, b| a.field.cmp(&b.field));

        let deltas_json: Vec<Value> = sorted_deltas
            .iter()
            .map(|d| {
                let mut map = serde_json::Map::new();
                map.insert("field".to_string(), Value::String(d.field.clone()));
                map.insert("op".to_string(), Value::String(d.op.clone()));
                if d.op != "clear" {
                    if let Some(v) = &d.value {
                        map.insert("value".to_string(), v.clone());
                    }
                }
                map.insert("confidence".to_string(), serde_json::json!(d.confidence));
                map.insert("basis".to_string(), Value::String(d.basis.clone()));
                Value::Object(map)
            })
            .collect();

        let mut sorted_conf_keys: Vec<&String> = confirmations.keys().collect();
        sorted_conf_keys.sort();
        let mut sorted_confs = serde_json::Map::new();
        for k in sorted_conf_keys {
            sorted_confs.insert(k.clone(), confirmations[k].clone());
        }

        let mut patch_obj = serde_json::Map::new();
        patch_obj.insert("deltas".to_string(), Value::Array(deltas_json));
        patch_obj.insert("confirmations".to_string(), Value::Object(sorted_confs));
        let patch_str =
            serde_json::to_string(&canonical_json(&Value::Object(patch_obj))).unwrap_or_default();

        let prev_receipt = self
            .data
            .receipts
            .iter()
            .find(|r| r.id == source.id || r.turn == source.turn);

        if let Some(pr) = prev_receipt {
            let text_slice = if source.text.len() > 512 {
                &source.text[..512]
            } else {
                &source.text
            };

            let stored_text = self.data.sources.get(&source.id).map(|s| s.text.as_str());

            if pr.id != source.id
                || pr.turn != source.turn
                || pr.patch != patch_str
                || (self.data.sources.contains_key(&source.id) && stored_text != Some(text_slice))
            {
                return Err("source replay differs from original patch".to_string());
            }

            return Ok(ApplyResult {
                changed: 0,
                unchanged: 0,
                deferred: 0,
                replayed: true,
            });
        }

        if source.turn <= self.data.last_turn {
            return Err("source turns must increase".to_string());
        }

        let mut next = self.data.clone();
        let mut changed = 0;
        let mut unchanged = 0;
        let mut deferred = 0;
        let ref_source = SourceRef {
            turn: source.turn,
            id: source.id.clone(),
        };

        for delta in deltas {
            let old = next.current.get(&delta.field).cloned();

            let verified = delta.op == "set"
                && confirmations.get(&delta.field).is_some()
                && confirmations.get(&delta.field) == delta.value.as_ref();

            if delta.op == "set"
                && old.as_ref().and_then(|o| o.value.as_ref()) == delta.value.as_ref()
                && !verified
            {
                unchanged += 1;
                continue;
            }

            let contradictory = delta.op != "clear"
                && old.is_some()
                && old.as_ref().unwrap().status != FactStatus::Cleared
                && (old.as_ref().unwrap().status == FactStatus::Conflicting
                    || old.as_ref().unwrap().value.as_ref() != delta.value.as_ref());

            let mut cell: Option<MemoryCell> = None;
            let mut reason = delta.op.clone();

            if delta.op == "set"
                && delta.basis == "inferred"
                && delta.confidence < next.policy.inferred_min_confidence
                && !contradictory
            {
                deferred += 1;
                reason = "deferred".to_string();
            } else if delta.op == "clear" {
                cell = Some(MemoryCell {
                    status: FactStatus::Cleared,
                    value: None,
                    candidates: None,
                    confidence: delta.confidence,
                    revision: 0,
                    source: ref_source.clone(),
                });
            } else {
                let is_conflict = delta.op == "conflict"
                    || (delta.basis == "inferred"
                        && old.is_some()
                        && old.as_ref().unwrap().status != FactStatus::Cleared
                        && (old.as_ref().unwrap().status == FactStatus::Conflicting
                            || old.as_ref().unwrap().value.as_ref() != delta.value.as_ref()));

                if is_conflict {
                    let mut candidates = Vec::new();
                    if let Some(o) = &old {
                        if let Some(cands) = &o.candidates {
                            for c in cands {
                                if !candidates.contains(c) {
                                    candidates.push(c.clone());
                                }
                            }
                        }
                        if let Some(v) = &o.value {
                            if !candidates.contains(v) {
                                candidates.push(v.clone());
                            }
                        }
                    }
                    if let Some(v) = &delta.value {
                        if !candidates.contains(v) {
                            candidates.push(v.clone());
                        }
                    }

                    cell = Some(MemoryCell {
                        status: FactStatus::Conflicting,
                        value: None,
                        candidates: Some(candidates),
                        confidence: delta.confidence,
                        revision: 0,
                        source: ref_source.clone(),
                    });
                    reason = "conflict".to_string();
                } else {
                    let status = if verified
                        || (old
                            .as_ref()
                            .is_some_and(|o| o.status == FactStatus::Confirmed)
                            && old.as_ref().and_then(|o| o.value.as_ref()) == delta.value.as_ref())
                    {
                        FactStatus::Confirmed
                    } else {
                        FactStatus::Uncertain
                    };

                    cell = Some(MemoryCell {
                        status,
                        value: delta.value.clone(),
                        candidates: None,
                        confidence: delta.confidence,
                        revision: 0,
                        source: ref_source.clone(),
                    });
                }
            }

            if reason != "deferred" && semantic_tuple(old.as_ref()) == semantic_tuple(cell.as_ref())
            {
                unchanged += 1;
                continue;
            }

            let id = (next.history.len() + 1) as i64;
            if next.history.len() >= next.max_history {
                return Err("history limit reached; persist the snapshot and explicitly raise maxHistory before accepting more changes".to_string());
            }

            if let Some(mut c) = cell.clone() {
                c.revision = id;
                next.current.insert(delta.field.clone(), c.clone());
                changed += 1;
                cell = Some(c);
            }

            let proposal = if reason == "deferred" {
                Some(delta.clone())
            } else {
                None
            };

            next.history.push(ChangeEvent {
                id,
                field: delta.field.clone(),
                before: old,
                after: cell,
                source: ref_source.clone(),
                reason,
                proposal,
            });

            let text_slice = if source.text.len() > 512 {
                source.text[..512].to_string()
            } else {
                source.text.clone()
            };

            next.sources.insert(
                source.id.clone(),
                FactSource {
                    turn: source.turn,
                    id: source.id.clone(),
                    text: text_slice,
                },
            );
        }

        next.last_turn = source.turn;
        next.receipts.push(Receipt {
            turn: source.turn,
            id: source.id.clone(),
            patch: patch_str,
        });

        self.data = next;

        Ok(ApplyResult {
            changed,
            unchanged,
            deferred,
            replayed: false,
        })
    }

    pub fn retrieve(
        &self,
        field: &str,
        mode: &str,
        limit: Option<usize>,
    ) -> Result<Vec<HistoricalEntry>, String> {
        if !self.data.schema.contains_key(field) {
            return Err("invalid historical retrieval".to_string());
        }
        let limit = limit.unwrap_or(3);
        if !(1..=20).contains(&limit) {
            return Err("invalid historical retrieval".to_string());
        }

        let events: Vec<&ChangeEvent> = self
            .data
            .history
            .iter()
            .filter(|e| e.field == field && e.reason != "deferred")
            .collect();

        if mode == "original" && !self.data.history_complete {
            return Ok(Vec::new());
        }

        let selected: Vec<&ChangeEvent> = if mode == "original" {
            events
                .into_iter()
                .filter(|e| e.after.as_ref().is_some_and(|a| a.value.is_some()))
                .take(1)
                .collect()
        } else if mode == "previous" {
            let current_val = self.data.current.get(field).and_then(|c| c.value.as_ref());
            let prev = events.into_iter().rfind(|e| {
                if let Some(a) = &e.after {
                    if let Some(v) = &a.value {
                        return Some(v) != current_val;
                    }
                }
                false
            });
            prev.into_iter().collect()
        } else if mode == "changes" {
            events
                .into_iter()
                .rev()
                .take(limit)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        } else {
            return Err("invalid historical retrieval".to_string());
        };

        let result = selected
            .into_iter()
            .map(|e| {
                let text = self
                    .data
                    .sources
                    .get(&e.source.id)
                    .map(|s| s.text.clone())
                    .unwrap_or_else(|| "source unavailable".to_string());
                HistoricalEntry {
                    event: e.id,
                    status: e.after.as_ref().map(|a| a.status.clone()),
                    value: e.after.as_ref().and_then(|a| a.value.clone()),
                    candidates: e.after.as_ref().and_then(|a| a.candidates.clone()),
                    source: e.source.clone(),
                    text,
                }
            })
            .collect();

        Ok(result)
    }

    pub fn restore_from_snapshot(snapshot: &MemorySnapshot) -> Result<Self, String> {
        if snapshot.version != 3 {
            return Err("invalid v3 snapshot".to_string());
        }
        if snapshot.max_history < 1 || snapshot.last_turn < 0 {
            return Err("invalid v3 snapshot".to_string());
        }

        validate_fact_schema(&snapshot.schema)?;

        let mut memory = FactMemory::new(
            snapshot.schema.clone(),
            Some(snapshot.policy.clone()),
            Some(snapshot.max_history),
        )?;

        validate_snapshot_beliefs(&snapshot.beliefs)?;

        let mut reconstructed: IndexMap<String, MemoryCell> = IndexMap::new();
        let mut last_event_turn = 0;

        for (i, event) in snapshot.history.iter().enumerate() {
            if event.id != (i + 1) as i64 || !snapshot.schema.contains_key(&event.field) {
                return Err("invalid history chain".to_string());
            }

            let prev_cell = reconstructed.get(&event.field);
            if event.before.as_ref() != prev_cell {
                return Err("invalid history chain".to_string());
            }

            if !["set", "clear", "conflict", "deferred", "migration"]
                .contains(&event.reason.as_str())
            {
                return Err("invalid history chain".to_string());
            }

            let source = snapshot
                .sources
                .get(&event.source.id)
                .ok_or_else(|| "invalid history source".to_string())?;

            validate_source(source)?;

            if source.id != event.source.id
                || source.turn != event.source.turn
                || source.turn > snapshot.last_turn
                || source.turn < last_event_turn
            {
                return Err("invalid history source".to_string());
            }
            last_event_turn = source.turn;

            if event.reason == "deferred" {
                let proposal = event
                    .proposal
                    .as_ref()
                    .ok_or_else(|| "invalid deferred proposal".to_string())?;
                validate_deltas(&snapshot.schema, std::slice::from_ref(proposal))?;
                if proposal.field != event.field {
                    return Err("invalid deferred proposal".to_string());
                }
            } else if event.proposal.is_some() {
                return Err("unexpected proposal".to_string());
            }

            if let Some(cell) = &event.after {
                if event.reason == "deferred" {
                    return Err("deferred event must not change state".to_string());
                }

                if cell.source != event.source
                    || cell.revision != event.id
                    || !cell.confidence.is_finite()
                    || cell.confidence < 0.0
                    || cell.confidence > 1.0
                {
                    return Err("invalid memory cell".to_string());
                }

                if cell.status == FactStatus::Confirmed || cell.status == FactStatus::Uncertain {
                    validate_fact_value(&snapshot.schema, &event.field, cell.value.as_ref())?;
                }

                if cell.status == FactStatus::Conflicting {
                    match &cell.candidates {
                        Some(cands) if !cands.is_empty() && cell.value.is_none() => {
                            for v in cands {
                                validate_fact_value(&snapshot.schema, &event.field, Some(v))?;
                            }
                        }
                        _ => return Err("invalid conflict candidates".to_string()),
                    }
                }

                if cell.status != FactStatus::Conflicting && cell.candidates.is_some() {
                    return Err("unexpected candidates".to_string());
                }

                if cell.status == FactStatus::Cleared && cell.value.is_some() {
                    return Err("cleared fact has value".to_string());
                }

                if (event.reason == "clear" && cell.status != FactStatus::Cleared)
                    || (event.reason == "conflict" && cell.status != FactStatus::Conflicting)
                    || (event.reason == "set"
                        && cell.status != FactStatus::Confirmed
                        && cell.status != FactStatus::Uncertain)
                    || (event.reason == "migration"
                        && (snapshot.history_complete
                            || (cell.status != FactStatus::Uncertain
                                && cell.status != FactStatus::Cleared)))
                {
                    return Err("event reason disagrees with state".to_string());
                }

                reconstructed.insert(event.field.clone(), cell.clone());
            } else if event.reason != "deferred" {
                return Err("event has no resulting cell".to_string());
            }
        }

        if reconstructed != snapshot.current || snapshot.history.len() > snapshot.max_history {
            return Err("snapshot current state disagrees with history".to_string());
        }

        let mut turns = std::collections::HashSet::new();
        let mut ids = std::collections::HashSet::new();

        for receipt in &snapshot.receipts {
            validate_source(&FactSource {
                turn: receipt.turn,
                id: receipt.id.clone(),
                text: String::new(),
            })?;

            if receipt.turn < 1
                || receipt.turn > snapshot.last_turn
                || !turns.insert(receipt.turn)
                || !ids.insert(receipt.id.clone())
            {
                return Err("invalid receipts".to_string());
            }
        }

        for event in &snapshot.history {
            if event.reason != "migration"
                && !snapshot
                    .receipts
                    .iter()
                    .any(|r| r.id == event.source.id && r.turn == event.source.turn)
            {
                return Err("history event has no replay receipt".to_string());
            }
        }

        memory.data = snapshot.clone();
        Ok(memory)
    }

    pub fn restore_from_v1(
        snapshot: &BeliefSnapshot,
        schema_for_v1: FactSchema,
    ) -> Result<Self, String> {
        let mut memory = FactMemory::new(schema_for_v1, None, None)?;
        validate_snapshot_beliefs(&snapshot.beliefs)?;
        memory.data.beliefs = snapshot.beliefs.clone();
        memory.data.history_complete = false;
        Ok(memory)
    }

    pub fn restore_from_v2(snapshot: &LongHorizonSnapshot) -> Result<Self, String> {
        validate_snapshot_beliefs(&snapshot.beliefs)?;
        validate_fact_schema(&snapshot.fact_schema)?;

        let max_history = 256.max(snapshot.fact_schema.len());
        let mut memory = FactMemory::new(snapshot.fact_schema.clone(), None, Some(max_history))?;

        let mut sorted_facts: Vec<(&String, &crate::snapshots::FactRecord)> =
            snapshot.facts.iter().collect();
        sorted_facts.sort_by_key(|(_, f)| f.source_turn);

        for (field, fact) in sorted_facts {
            if fact.source_turn < 1
                || (fact.status != "active" && fact.status != "cleared")
                || !fact.confidence.is_finite()
                || fact.confidence < 0.0
                || fact.confidence > 1.0
            {
                return Err("invalid legacy fact".to_string());
            }

            if fact.status == "active" {
                validate_fact_value(&snapshot.fact_schema, field, fact.value.as_ref())?;
            }

            let decl = snapshot
                .fact_schema
                .get(field.as_str())
                .ok_or_else(|| "invalid legacy field type".to_string())?;

            if fact.fact_type != decl.fact_type() {
                return Err("invalid legacy field type".to_string());
            }

            let source = SourceRef {
                turn: fact.source_turn,
                id: format!("legacy:{}", fact.source_turn),
            };

            let cell = MemoryCell {
                status: if fact.status == "cleared" {
                    FactStatus::Cleared
                } else {
                    FactStatus::Uncertain
                },
                confidence: fact.confidence,
                value: if fact.status == "active" {
                    fact.value.clone()
                } else {
                    None
                },
                candidates: None,
                revision: (memory.data.history.len() + 1) as i64,
                source: source.clone(),
            };

            memory.data.history.push(ChangeEvent {
                id: cell.revision,
                field: field.clone(),
                before: None,
                after: Some(cell.clone()),
                source: source.clone(),
                reason: "migration".to_string(),
                proposal: None,
            });

            memory.data.sources.insert(
                source.id.clone(),
                FactSource {
                    turn: source.turn,
                    id: source.id.clone(),
                    text: "Migrated v2 fact; original evidence unavailable".to_string(),
                },
            );

            memory.data.current.insert(field.clone(), cell);
            memory.data.last_turn = memory.data.last_turn.max(fact.source_turn);
        }

        memory.data.history_complete = false;
        memory.data.beliefs = snapshot.beliefs.clone();
        Ok(memory)
    }
}

fn validate_snapshot_beliefs(
    beliefs: &IndexMap<String, crate::snapshots::BeliefSnapshotEntry>,
) -> Result<(), String> {
    for belief in beliefs.values() {
        if belief.cardinality != BeliefCardinality::Exclusive
            && belief.cardinality != BeliefCardinality::Multi
        {
            return Err("invalid snapshot beliefs".to_string());
        }
        if belief.domain != BeliefDomain::Open && belief.domain != BeliefDomain::Closed {
            return Err("invalid snapshot beliefs".to_string());
        }
        for v in belief.values.values() {
            if !v.is_finite() || *v < 0.0 || *v > 1.0 {
                return Err("invalid snapshot beliefs".to_string());
            }
        }
    }
    Ok(())
}
