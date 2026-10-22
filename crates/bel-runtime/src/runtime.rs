use crate::beliefs::{confidence, entropy, normalize_belief, BeliefMeta};
use crate::memory::FactMemory;
use crate::provenance::{ObservationRecord, ProvenanceOrigin, ProvenanceRecord};
use crate::snapshots::{
    BeliefSnapshot, BeliefSnapshotEntry, FactPatchEntry, FactRecord, FactSchema,
    LongHorizonSnapshot,
};
use crate::values::{
    compare_values, describe_condition, describe_value_expression, format_value, to_boolean,
    RuntimeValue,
};
use async_trait::async_trait;
use bel_syntax::ast::{
    Action, BeliefBlock, BeliefCardinality, BeliefDistribution, BeliefDomain, BeliefState,
    ConditionExpression, InferStatement, MergeBeliefsStatement, ObserveStatement, Rule, Statement,
    ValueExpression,
};
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub trait IntoToolResult: Send {
    fn into_tool_result(self) -> Result<RuntimeValue, String>;
}

impl IntoToolResult for RuntimeValue {
    fn into_tool_result(self) -> Result<RuntimeValue, String> {
        Ok(self)
    }
}

impl IntoToolResult for Value {
    fn into_tool_result(self) -> Result<RuntimeValue, String> {
        Ok(RuntimeValue::from(self))
    }
}

impl<E: std::fmt::Display + Send> IntoToolResult for Result<RuntimeValue, E> {
    fn into_tool_result(self) -> Result<RuntimeValue, String> {
        self.map_err(|e| e.to_string())
    }
}

impl<E: std::fmt::Display + Send> IntoToolResult for Result<Value, E> {
    fn into_tool_result(self) -> Result<RuntimeValue, String> {
        self.map(RuntimeValue::from).map_err(|e| e.to_string())
    }
}

pub type ToolFn = Arc<
    dyn Fn() -> Pin<Box<dyn Future<Output = Result<RuntimeValue, String>> + Send>> + Send + Sync,
>;

#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: HashMap<String, ToolFn>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
        }
    }

    pub fn insert_sync<F, R>(&mut self, name: &str, f: F)
    where
        F: Fn() -> R + Send + Sync + 'static,
        R: IntoToolResult + 'static,
    {
        self.tools.insert(
            name.to_string(),
            Arc::new(move || {
                let res = f().into_tool_result();
                Box::pin(async move { res })
            }),
        );
    }

    pub fn insert_async<F, Fut, R>(&mut self, name: &str, f: F)
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = R> + Send + 'static,
        R: IntoToolResult + 'static,
    {
        self.tools.insert(
            name.to_string(),
            Arc::new(move || {
                let fut = f();
                Box::pin(async move { fut.await.into_tool_result() })
            }),
        );
    }

    pub fn get(&self, name: &str) -> Option<&ToolFn> {
        self.tools.get(name)
    }

    pub fn contains_key(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }
}

#[derive(Debug, Clone)]
pub struct BeliefPatchEntry {
    pub values: BeliefDistribution,
    pub cardinality: Option<BeliefCardinality>,
    pub domain: Option<BeliefDomain>,
}

pub type BeliefPatch = IndexMap<String, BeliefPatchEntry>;

#[derive(Debug, Clone)]
pub struct InferContext {
    pub observations: Vec<ObservationRecord>,
    pub state: BeliefState,
    pub vars: IndexMap<String, RuntimeValue>,
}

#[async_trait]
pub trait InferBeliefsAdapter: Send + Sync {
    async fn infer(
        &self,
        source: &RuntimeValue,
        context: &InferContext,
    ) -> Result<BeliefPatch, String>;
}

pub struct HeuristicInferAdapter;

#[async_trait]
impl InferBeliefsAdapter for HeuristicInferAdapter {
    async fn infer(
        &self,
        source: &RuntimeValue,
        _context: &InferContext,
    ) -> Result<BeliefPatch, String> {
        let text = match source.as_str() {
            Some(s) => s.to_lowercase(),
            _ => return Ok(IndexMap::new()),
        };

        let mut intent_values = BeliefDistribution::new();
        if text.contains("flight") {
            intent_values.insert("book_flight".to_string(), 0.85);
        }
        if text.contains("hotel") {
            intent_values.insert("book_hotel".to_string(), 0.85);
        }
        if intent_values.is_empty() {
            intent_values.insert("unknown".to_string(), 1.0);
        }

        let mut patch = IndexMap::new();
        patch.insert(
            "intent".to_string(),
            BeliefPatchEntry {
                values: intent_values,
                cardinality: Some(BeliefCardinality::Exclusive),
                domain: Some(BeliefDomain::Closed),
            },
        );

        let mut user_values = BeliefDistribution::new();
        if text.contains("cheap") {
            user_values.insert("budget_sensitive".to_string(), 0.9);
        }
        if text.contains("direct") {
            user_values.insert("prefers_direct".to_string(), 0.85);
        }

        if !user_values.is_empty() {
            patch.insert(
                "user".to_string(),
                BeliefPatchEntry {
                    values: user_values,
                    cardinality: Some(BeliefCardinality::Multi),
                    domain: Some(BeliefDomain::Closed),
                },
            );
        }

        Ok(patch)
    }
}

pub struct ClosureInferAdapter<F>(pub F)
where
    F: Fn(&RuntimeValue, &InferContext) -> Result<BeliefPatch, String> + Send + Sync;

#[async_trait]
impl<F> InferBeliefsAdapter for ClosureInferAdapter<F>
where
    F: Fn(&RuntimeValue, &InferContext) -> Result<BeliefPatch, String> + Send + Sync,
{
    async fn infer(
        &self,
        source: &RuntimeValue,
        context: &InferContext,
    ) -> Result<BeliefPatch, String> {
        (self.0)(source, context)
    }
}

#[derive(Clone, Default)]
pub struct RuntimeOptions {
    pub trace: bool,
    pub infer_beliefs: Option<Arc<dyn InferBeliefsAdapter>>,
    pub now: Option<Arc<dyn Fn() -> u64 + Send + Sync>>,
    pub memory: Option<FactMemory>,
}

pub struct BeliefRuntime {
    pub memory: Option<FactMemory>,
    state: BeliefState,
    fact_schema: FactSchema,
    facts: IndexMap<String, FactRecord>,
    vars: IndexMap<String, RuntimeValue>,
    belief_meta: IndexMap<String, BeliefMeta>,
    observations: Vec<ObservationRecord>,
    provenance: Vec<ProvenanceRecord>,
    tools: ToolRegistry,
    trace: bool,
    infer_beliefs: Arc<dyn InferBeliefsAdapter>,
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    next_observation_id: u64,
    next_provenance_id: u64,
}

impl BeliefRuntime {
    pub fn new(tools: ToolRegistry, options: RuntimeOptions) -> Self {
        let trace = options.trace;
        let now = options.now.unwrap_or_else(|| {
            Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
            })
        });

        let infer_beliefs = options
            .infer_beliefs
            .unwrap_or_else(|| Arc::new(HeuristicInferAdapter));

        let mut final_tools = ToolRegistry::new();

        // Register default tools
        final_tools.insert_sync(
            "search_flights",
            || serde_json::json!({ "count": 3, "best_price": 214, "currency": "EUR" }),
        );
        final_tools.insert_sync(
            "search_hotels",
            || serde_json::json!({ "count": 5, "best_price": 88, "currency": "EUR" }),
        );
        final_tools.insert_sync("extract_patch", || {
            serde_json::json!({
                "intent": {
                    "cardinality": "exclusive",
                    "domain": "closed",
                    "values": {
                        "book_flight": 0.92,
                        "book_hotel": 0.08,
                    }
                },
                "user": {
                    "cardinality": "multi",
                    "domain": "closed",
                    "values": {
                        "budget_sensitive": 0.86,
                        "prefers_direct": 0.88,
                    }
                }
            })
        });
        final_tools.insert_sync("rank_flights", || {
            println!("[tool] rank_flights()");
            RuntimeValue::Null
        });

        // Merge user tools over defaults
        for (name, tool) in tools.tools {
            final_tools.tools.insert(name, tool);
        }

        Self {
            memory: options.memory,
            state: IndexMap::new(),
            fact_schema: IndexMap::new(),
            facts: IndexMap::new(),
            vars: IndexMap::new(),
            belief_meta: IndexMap::new(),
            observations: Vec::new(),
            provenance: Vec::new(),
            tools: final_tools,
            trace,
            infer_beliefs,
            now,
            next_observation_id: 1,
            next_provenance_id: 1,
        }
    }

    pub fn get_state(&self) -> BeliefState {
        self.state.clone()
    }

    pub fn get_vars(&self) -> IndexMap<String, RuntimeValue> {
        self.vars.clone()
    }

    pub fn get_observations(&self) -> Vec<ObservationRecord> {
        self.observations.clone()
    }

    pub fn get_provenance(&self) -> Vec<ProvenanceRecord> {
        self.provenance.clone()
    }

    pub fn get_facts(&self) -> IndexMap<String, FactRecord> {
        self.facts.clone()
    }

    pub fn explain_belief(&self, path: &str) -> Result<Vec<ProvenanceRecord>, String> {
        let parts: Vec<&str> = path.split('.').collect();
        if parts.is_empty() || parts[0].is_empty() || parts.len() > 2 {
            return Err(format!(
                "explainBelief() expects belief or belief.label, got {path}"
            ));
        }

        let belief_name = parts[0];
        let label = parts.get(1).copied();

        Ok(self
            .provenance
            .iter()
            .filter(|record| {
                if record.belief_name != belief_name {
                    return false;
                }
                match label {
                    Some(l) => record.label == l,
                    None => true,
                }
            })
            .cloned()
            .collect())
    }

    pub fn confidence(&self, path: &str) -> f64 {
        confidence(&self.state, &self.belief_meta, path).unwrap_or(0.0)
    }

    pub fn entropy(&self, belief_name: &str) -> Result<f64, String> {
        entropy(&self.state, &self.belief_meta, belief_name)
    }

    pub fn get_belief_snapshot(&self) -> BeliefSnapshot {
        let mut beliefs = IndexMap::new();
        for (name, values) in &self.state {
            if let Some(meta) = self.belief_meta.get(name) {
                beliefs.insert(
                    name.clone(),
                    BeliefSnapshotEntry {
                        cardinality: meta.cardinality,
                        domain: meta.domain,
                        values: values.clone(),
                    },
                );
            }
        }
        BeliefSnapshot {
            version: 1,
            beliefs,
        }
    }

    pub fn load_belief_snapshot(&mut self, snapshot: &BeliefSnapshot) -> Result<(), String> {
        if !self.state.is_empty() {
            return Err("loadBeliefSnapshot() requires a fresh runtime".to_string());
        }
        if snapshot.version != 1 {
            return Err("invalid belief snapshot".to_string());
        }

        let mut staged_state = self.state.clone();
        let mut staged_meta = self.belief_meta.clone();
        let mut staged_provenance = self.provenance.clone();
        let mut staged_next_prov_id = self.next_provenance_id;
        let mut trace_logs = Vec::new();
        let timestamp = (self.now)();

        for (name, entry) in &snapshot.beliefs {
            let mut trace_msgs = Vec::new();
            let normalized = normalize_belief(
                name,
                &entry.values,
                entry.cardinality,
                entry.domain,
                false,
                |msg| trace_msgs.push(msg),
            )?;

            staged_state.insert(name.clone(), normalized.values.clone());
            let meta = BeliefMeta {
                cardinality: entry.cardinality,
                domain: entry.domain,
                open_mass: normalized.open_mass,
            };
            staged_meta.insert(name.clone(), meta.clone());

            let source = format!("belief {name}");
            for (label, &value) in &normalized.values {
                staged_provenance.push(ProvenanceRecord {
                    id: staged_next_prov_id,
                    timestamp,
                    belief_name: name.clone(),
                    label: label.clone(),
                    value,
                    cardinality: meta.cardinality,
                    domain: meta.domain,
                    source: source.clone(),
                    origin: ProvenanceOrigin::Load,
                });
                staged_next_prov_id += 1;
            }

            if meta.cardinality == BeliefCardinality::Exclusive && meta.domain == BeliefDomain::Open
            {
                staged_provenance.push(ProvenanceRecord {
                    id: staged_next_prov_id,
                    timestamp,
                    belief_name: name.clone(),
                    label: "other".to_string(),
                    value: meta.open_mass,
                    cardinality: meta.cardinality,
                    domain: meta.domain,
                    source: source.clone(),
                    origin: ProvenanceOrigin::Load,
                });
                staged_next_prov_id += 1;
            }

            trace_logs.extend(trace_msgs);
        }

        // Commit all staged state atomically
        for msg in trace_logs {
            self.log_trace(&msg);
        }
        self.state = staged_state;
        self.belief_meta = staged_meta;
        self.provenance = staged_provenance;
        self.next_provenance_id = staged_next_prov_id;

        Ok(())
    }

    pub fn get_memory_snapshot(&self) -> Result<crate::memory::MemorySnapshot, String> {
        let memory = self
            .memory
            .as_ref()
            .ok_or_else(|| "factual memory is not enabled".to_string())?;
        let mut snap = memory.snapshot();
        snap.beliefs = self.get_belief_snapshot().beliefs;
        Ok(snap)
    }

    pub fn declare_facts(&mut self, schema: FactSchema) -> Result<(), String> {
        if !self.fact_schema.is_empty() || !self.facts.is_empty() {
            return Err("declareFacts() requires an undeclared fact store".to_string());
        }
        if schema.is_empty() {
            return Err("fact schema must be a nonempty object".to_string());
        }
        crate::memory::validate_fact_schema(&schema)?;
        self.fact_schema = schema;
        Ok(())
    }

    pub fn get_long_horizon_snapshot(&self) -> LongHorizonSnapshot {
        LongHorizonSnapshot {
            version: 2,
            beliefs: self.get_belief_snapshot().beliefs,
            fact_schema: self.fact_schema.clone(),
            facts: self.facts.clone(),
        }
    }

    pub fn load_long_horizon_snapshot(
        &mut self,
        snapshot: &LongHorizonSnapshot,
    ) -> Result<(), String> {
        if !self.state.is_empty() || !self.fact_schema.is_empty() || !self.facts.is_empty() {
            return Err("loadLongHorizonSnapshot() requires a fresh runtime".to_string());
        }
        if snapshot.version != 2 {
            return Err("invalid long-horizon snapshot".to_string());
        }

        self.declare_facts(snapshot.fact_schema.clone())?;
        self.load_belief_snapshot(&BeliefSnapshot {
            version: 1,
            beliefs: snapshot.beliefs.clone(),
        })?;

        let mut patch = IndexMap::new();
        for (name, record) in &snapshot.facts {
            patch.insert(
                name.clone(),
                FactPatchEntry {
                    operation: if record.status == "cleared" {
                        "clear".to_string()
                    } else {
                        "set".to_string()
                    },
                    value: record.value.clone(),
                    confidence: record.confidence,
                    source_turn: record.source_turn,
                },
            );
        }
        self.merge_fact_patch(&patch)?;

        Ok(())
    }

    pub fn merge_fact_patch(
        &mut self,
        patch: &IndexMap<String, FactPatchEntry>,
    ) -> Result<(), String> {
        let mut staged = self.facts.clone();

        for (name, entry) in patch {
            let decl = self
                .fact_schema
                .get(name)
                .ok_or_else(|| format!("invalid fact patch for {name}"))?;

            if entry.operation != "set" && entry.operation != "clear" {
                return Err(format!("invalid fact patch for {name}"));
            }
            if !entry.confidence.is_finite() || entry.confidence < 0.0 || entry.confidence > 1.0 {
                return Err(format!("invalid fact patch for {name}"));
            }
            if entry.source_turn < 1 {
                return Err(format!("invalid fact patch for {name}"));
            }

            let fact_type = decl.fact_type();
            if entry.operation == "set" {
                let val = entry
                    .value
                    .as_ref()
                    .ok_or_else(|| format!("fact {name} must have type {fact_type}"))?;

                match fact_type {
                    "string" => {
                        if let Value::String(s) = val {
                            if let Some(variants) = decl.variants() {
                                if !variants.iter().any(|v| v == s) {
                                    return Err(format!(
                                        "fact {name} must be one of {}",
                                        variants.join(", ")
                                    ));
                                }
                            }
                        } else {
                            return Err(format!("fact {name} must have type {fact_type}"));
                        }
                    }
                    "number" => {
                        if let Value::Number(n) = val {
                            if let Some(f) = n.as_f64() {
                                if !f.is_finite() {
                                    return Err(format!("fact {name} must have type {fact_type}"));
                                }
                            } else {
                                return Err(format!("fact {name} must have type {fact_type}"));
                            }
                        } else {
                            return Err(format!("fact {name} must have type {fact_type}"));
                        }
                    }
                    "boolean" => {
                        if !val.is_boolean() {
                            return Err(format!("fact {name} must have type {fact_type}"));
                        }
                    }
                    _ => return Err(format!("fact {name} must have type {fact_type}")),
                }

                staged.insert(
                    name.clone(),
                    FactRecord {
                        fact_type: fact_type.to_string(),
                        value: Some(val.clone()),
                        confidence: entry.confidence,
                        source_turn: entry.source_turn,
                        status: "active".to_string(),
                    },
                );
            } else {
                staged.insert(
                    name.clone(),
                    FactRecord {
                        fact_type: fact_type.to_string(),
                        value: None,
                        confidence: entry.confidence,
                        source_turn: entry.source_turn,
                        status: "cleared".to_string(),
                    },
                );
            }
        }

        self.facts = staged;
        Ok(())
    }

    pub fn load_belief(&mut self, block: &BeliefBlock) -> Result<(), String> {
        self.set_belief(
            &block.name,
            &block.values,
            block.cardinality,
            block.domain,
            (ProvenanceOrigin::Load, &format!("belief {}", block.name)),
            false,
        )
    }

    pub async fn assign(&mut self, name: &str, expr: &ValueExpression) -> Result<(), String> {
        let val = self.eval_value(expr).await?;
        self.vars.insert(name.to_string(), val);
        Ok(())
    }

    pub async fn observe(
        &mut self,
        event_name: &str,
        value: Option<&ValueExpression>,
    ) -> Result<(), String> {
        self.execute_observe(&ObserveStatement {
            event_name: event_name.to_string(),
            value: value.cloned(),
        })
        .await
    }

    pub async fn infer(&mut self, source: &ValueExpression) -> Result<(), String> {
        self.execute_infer(&InferStatement {
            source: source.clone(),
        })
        .await
    }

    pub fn merge_beliefs_from_runtime_value(
        &mut self,
        value: &RuntimeValue,
        origin: ProvenanceOrigin,
        source: &str,
    ) -> Result<(), String> {
        let patch = self.as_belief_patch(value)?;
        self.merge_belief_patch(&patch, origin, source)
    }

    pub fn resolve_path(&self, path: &str) -> Result<RuntimeValue, String> {
        let parts: Vec<&str> = path.split('.').collect();
        let root = parts[0];

        let mut current = match self.vars.get(root) {
            Some(v) => v.clone(),
            None => {
                if let Some(dist) = self.state.get(root) {
                    let mut map = IndexMap::new();
                    for (k, v) in dist {
                        map.insert(k.clone(), RuntimeValue::Number(*v));
                    }
                    RuntimeValue::Object(Arc::new(map))
                } else {
                    return Err(format!("unknown reference {path}"));
                }
            }
        };

        for part in &parts[1..] {
            match current {
                RuntimeValue::Object(map) => {
                    if let Some(v) = map.get(*part) {
                        current = v.clone();
                    } else {
                        return Err(format!("unknown property {part} in reference {path}"));
                    }
                }
                _ => {
                    return Err(format!(
                        "cannot access {part} on non-object reference {path}"
                    ));
                }
            }
        }

        Ok(current)
    }

    pub async fn eval_value(&self, expr: &ValueExpression) -> Result<RuntimeValue, String> {
        match expr {
            ValueExpression::Number { value } => Ok(RuntimeValue::Number(*value)),
            ValueExpression::String { value } => Ok(RuntimeValue::String(value.clone())),
            ValueExpression::Boolean { value } => Ok(RuntimeValue::Bool(*value)),
            ValueExpression::Identifier { name } => self.resolve_path(name),
            ValueExpression::Metric { function, arg } => match function {
                bel_syntax::ast::ConditionFunction::Confidence => {
                    Ok(RuntimeValue::Number(self.confidence(arg)))
                }
                bel_syntax::ast::ConditionFunction::Entropy => {
                    let ent = self.entropy(arg)?;
                    Ok(RuntimeValue::Number(ent))
                }
            },
            ValueExpression::Call { tool_name } => self.call_tool(tool_name).await,
        }
    }

    pub async fn call_tool(&self, tool_name: &str) -> Result<RuntimeValue, String> {
        self.log_trace(&format!("call {tool_name}()"));

        if let Some(tool) = self.tools.get(tool_name) {
            tool().await
        } else {
            println!("[call] {tool_name}()");
            Ok(RuntimeValue::Null)
        }
    }

    pub async fn execute_action(&mut self, action: &Action) -> Result<(), String> {
        self.log_trace(&format!("action {}", self.describe_action(action)));

        match action {
            Action::AskUser { message } => {
                println!("[ask_user] {message}");
                Ok(())
            }
            Action::AssignCall {
                variable_name,
                tool_name,
            } => {
                let res = self.call_tool(tool_name).await?;
                self.log_trace(&format!("assigned {variable_name}={}", format_value(&res)));
                self.vars.insert(variable_name.clone(), res);
                Ok(())
            }
            Action::Call { tool_name } => {
                self.call_tool(tool_name).await?;
                Ok(())
            }
        }
    }

    fn describe_action(&self, action: &Action) -> String {
        match action {
            Action::Call { tool_name } => format!("call {tool_name}()"),
            Action::AskUser { message } => {
                let s = serde_json::to_string(message).unwrap_or_else(|_| format!("\"{message}\""));
                format!("ask_user({s})")
            }
            Action::AssignCall {
                variable_name,
                tool_name,
            } => format!("let {variable_name} = call {tool_name}()"),
        }
    }

    pub async fn eval_condition(&self, rule: &Rule, index: usize) -> Result<bool, String> {
        let mut trace_lines = Vec::new();
        let result = self
            .eval_condition_expression(&rule.condition, &mut trace_lines)
            .await?;

        self.log_trace(&format!(
            "rule {} when {} => {result}",
            index + 1,
            describe_condition(&rule.condition)
        ));
        for line in trace_lines {
            self.log_trace(&format!("  {line}"));
        }

        Ok(result)
    }

    fn eval_condition_expression<'a>(
        &'a self,
        expr: &'a ConditionExpression,
        trace_lines: &'a mut Vec<String>,
    ) -> Pin<Box<dyn Future<Output = Result<bool, String>> + Send + 'a>> {
        Box::pin(async move {
            match expr {
                ConditionExpression::Comparison { left, op, right } => {
                    let left_val = self.eval_value(left).await?;
                    let right_val = self.eval_value(right).await?;
                    let result = compare_values(&left_val, *op, &right_val)?;

                    trace_lines.push(format!(
                        "{}={} {} {}={} -> {result}",
                        describe_value_expression(left),
                        format_value(&left_val),
                        op.as_str(),
                        describe_value_expression(right),
                        format_value(&right_val)
                    ));

                    Ok(result)
                }
                ConditionExpression::Truthy { expr } => {
                    let val = self.eval_value(expr).await?;
                    let result = to_boolean(&val);
                    trace_lines.push(format!(
                        "{}={} -> {result}",
                        describe_value_expression(expr),
                        format_value(&val)
                    ));
                    Ok(result)
                }
                ConditionExpression::Not { expr } => {
                    let inner = self.eval_condition_expression(expr, trace_lines).await?;
                    let result = !inner;
                    trace_lines.push(format!("not -> {result}"));
                    Ok(result)
                }
                ConditionExpression::And { left, right } => {
                    let l = self.eval_condition_expression(left, trace_lines).await?;
                    if !l {
                        trace_lines.push("and short-circuit -> false".to_string());
                        return Ok(false);
                    }
                    let r = self.eval_condition_expression(right, trace_lines).await?;
                    let result = l && r;
                    trace_lines.push(format!("and -> {result}"));
                    Ok(result)
                }
                ConditionExpression::Or { left, right } => {
                    let l = self.eval_condition_expression(left, trace_lines).await?;
                    if l {
                        trace_lines.push("or short-circuit -> true".to_string());
                        return Ok(true);
                    }
                    let r = self.eval_condition_expression(right, trace_lines).await?;
                    let result = l || r;
                    trace_lines.push(format!("or -> {result}"));
                    Ok(result)
                }
            }
        })
    }

    pub async fn run(&mut self, statements: &[Statement]) -> Result<(), String> {
        let mut rules = Vec::new();

        for statement in statements {
            match statement {
                Statement::Belief(block) => self.load_belief(block)?,
                Statement::Let(let_stmt) => self.assign(&let_stmt.name, &let_stmt.value).await?,
                Statement::Observe(obs) => self.execute_observe(obs).await?,
                Statement::Infer(inf) => self.execute_infer(inf).await?,
                Statement::MergeBeliefs(m) => self.execute_merge_beliefs(m).await?,
                Statement::Rule(rule) => rules.push(rule.clone()),
            }
        }

        self.print_state();
        self.print_vars();
        self.print_observations();

        for (i, rule) in rules.iter().enumerate() {
            if self.eval_condition(rule, i).await? {
                self.execute_action(&rule.action).await?;
            }
        }

        Ok(())
    }

    pub fn print_state(&self) {
        println!("[state]");
        for (name, dist) in &self.state {
            let meta = self.belief_meta.get(name);
            let values: Vec<String> = dist
                .iter()
                .map(|(key, value)| format!("{key}={:.3}", value))
                .collect();
            let values_str = values.join(", ");

            let open_other = if let Some(m) = meta {
                if m.cardinality == BeliefCardinality::Exclusive
                    && m.domain == BeliefDomain::Open
                    && m.open_mass > 0.0
                {
                    format!(", other={:.3}", m.open_mass)
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            let label = if let Some(m) = meta {
                format!("{name} [{}/{}]", m.cardinality, m.domain)
            } else {
                name.clone()
            };

            println!("  {label}: {values_str}{open_other}");
        }
    }

    pub fn print_vars(&self) {
        if self.vars.is_empty() {
            return;
        }

        println!("[vars]");
        for (name, value) in &self.vars {
            let json_str = serde_json::to_string(value).unwrap_or_default();
            println!("  {name}: {json_str}");
        }
    }

    pub fn print_observations(&self) {
        if self.observations.is_empty() {
            return;
        }

        println!("[observations]");
        for obs in &self.observations {
            println!(
                "  {} {}: {}",
                obs.id,
                obs.event_name,
                format_value(&obs.value)
            );
        }
    }

    fn set_belief(
        &mut self,
        belief_name: &str,
        values: &BeliefDistribution,
        cardinality: BeliefCardinality,
        domain: BeliefDomain,
        provenance: (ProvenanceOrigin, &str),
        clamp_multi: bool,
    ) -> Result<(), String> {
        let mut trace_msgs = Vec::new();
        let normalized = normalize_belief(
            belief_name,
            values,
            cardinality,
            domain,
            clamp_multi,
            |msg| trace_msgs.push(msg),
        )?;

        for msg in trace_msgs {
            self.log_trace(&msg);
        }

        self.state
            .insert(belief_name.to_string(), normalized.values.clone());
        let meta = BeliefMeta {
            cardinality,
            domain,
            open_mass: normalized.open_mass,
        };
        self.belief_meta
            .insert(belief_name.to_string(), meta.clone());

        self.record_provenance(
            belief_name,
            &normalized.values,
            &meta,
            provenance.0,
            provenance.1,
        );

        Ok(())
    }

    fn record_provenance(
        &mut self,
        belief_name: &str,
        values: &BeliefDistribution,
        meta: &BeliefMeta,
        origin: ProvenanceOrigin,
        source: &str,
    ) {
        let timestamp = (self.now)();

        for (label, &value) in values {
            self.provenance.push(ProvenanceRecord {
                id: self.next_provenance_id,
                timestamp,
                belief_name: belief_name.to_string(),
                label: label.clone(),
                value,
                cardinality: meta.cardinality,
                domain: meta.domain,
                source: source.to_string(),
                origin,
            });
            self.next_provenance_id += 1;
        }

        if meta.cardinality == BeliefCardinality::Exclusive && meta.domain == BeliefDomain::Open {
            self.provenance.push(ProvenanceRecord {
                id: self.next_provenance_id,
                timestamp,
                belief_name: belief_name.to_string(),
                label: "other".to_string(),
                value: meta.open_mass,
                cardinality: meta.cardinality,
                domain: meta.domain,
                source: source.to_string(),
                origin,
            });
            self.next_provenance_id += 1;
        }
    }

    async fn execute_observe(&mut self, statement: &ObserveStatement) -> Result<(), String> {
        let observed_val = match &statement.value {
            Some(expr) => self.eval_value(expr).await?,
            None => RuntimeValue::Null,
        };

        let obs = ObservationRecord {
            id: self.next_observation_id,
            event_name: statement.event_name.clone(),
            value: observed_val.clone(),
            timestamp: (self.now)(),
        };
        self.next_observation_id += 1;

        self.observations.push(obs);

        if statement.value.is_some() {
            self.vars
                .insert(statement.event_name.clone(), observed_val.clone());
        }

        self.log_trace(&format!(
            "observe {}={}",
            statement.event_name,
            format_value(&observed_val)
        ));

        Ok(())
    }

    async fn execute_infer(&mut self, statement: &InferStatement) -> Result<(), String> {
        let source_val = self.eval_value(&statement.source).await?;
        let context = InferContext {
            observations: self.get_observations(),
            state: self.get_state(),
            vars: self.get_vars(),
        };

        let patch = self.infer_beliefs.infer(&source_val, &context).await?;

        self.log_trace(&format!(
            "infer beliefs from {}",
            describe_value_expression(&statement.source)
        ));

        self.merge_belief_patch(
            &patch,
            ProvenanceOrigin::Infer,
            &format!("infer {}", describe_value_expression(&statement.source)),
        )
    }

    async fn execute_merge_beliefs(
        &mut self,
        statement: &MergeBeliefsStatement,
    ) -> Result<(), String> {
        let source_val = self.eval_value(&statement.source).await?;
        let patch = self.as_belief_patch(&source_val)?;

        self.log_trace(&format!(
            "merge beliefs from {}",
            describe_value_expression(&statement.source)
        ));

        self.merge_belief_patch(
            &patch,
            ProvenanceOrigin::Merge,
            &format!("merge {}", describe_value_expression(&statement.source)),
        )
    }

    fn as_belief_patch(&self, val: &RuntimeValue) -> Result<BeliefPatch, String> {
        let obj = val
            .as_object()
            .ok_or_else(|| "merge/infer source must evaluate to an object".to_string())?;

        let mut patch = IndexMap::new();

        for (belief_name, raw_entry) in obj {
            let entry_obj = raw_entry
                .as_object()
                .ok_or_else(|| format!("belief patch entry '{belief_name}' must be an object"))?;

            let patch_entry = self.coerce_patch_entry(belief_name, entry_obj)?;
            patch.insert(belief_name.clone(), patch_entry);
        }

        Ok(patch)
    }

    fn coerce_patch_entry(
        &self,
        belief_name: &str,
        raw: &IndexMap<String, RuntimeValue>,
    ) -> Result<BeliefPatchEntry, String> {
        if let Some(values_val) = raw.get("values") {
            let values_obj = values_val.as_object().ok_or_else(|| {
                format!("belief patch entry '{belief_name}' values must be an object")
            })?;
            let values = self.as_belief_distribution(values_obj, belief_name)?;

            let cardinality = match raw.get("cardinality") {
                Some(RuntimeValue::String(s)) => {
                    if s == "exclusive" {
                        Some(BeliefCardinality::Exclusive)
                    } else if s == "multi" {
                        Some(BeliefCardinality::Multi)
                    } else {
                        return Err(format!(
                            "invalid cardinality '{s}' for belief {belief_name}"
                        ));
                    }
                }
                Some(other) => {
                    return Err(format!(
                        "invalid cardinality '{}' for belief {belief_name}",
                        format_value(other)
                    ))
                }
                None => None,
            };

            let domain = match raw.get("domain") {
                Some(RuntimeValue::String(s)) => {
                    if s == "open" {
                        Some(BeliefDomain::Open)
                    } else if s == "closed" {
                        Some(BeliefDomain::Closed)
                    } else {
                        return Err(format!("invalid domain '{s}' for belief {belief_name}"));
                    }
                }
                Some(other) => {
                    return Err(format!(
                        "invalid domain '{}' for belief {belief_name}",
                        format_value(other)
                    ))
                }
                None => None,
            };

            return Ok(BeliefPatchEntry {
                values,
                cardinality,
                domain,
            });
        }

        let values = self.as_belief_distribution(raw, belief_name)?;
        Ok(BeliefPatchEntry {
            values,
            cardinality: None,
            domain: None,
        })
    }

    fn as_belief_distribution(
        &self,
        source: &IndexMap<String, RuntimeValue>,
        belief_name: &str,
    ) -> Result<BeliefDistribution, String> {
        if source.is_empty() {
            return Err(format!("belief patch for {belief_name} has no values"));
        }

        let mut values = IndexMap::new();
        for (label, raw_val) in source {
            let num = match raw_val {
                RuntimeValue::Number(n) => {
                    if !n.is_finite() {
                        return Err(format!(
                            "belief patch {belief_name}.{label} must be a finite number"
                        ));
                    }
                    *n
                }
                _ => {
                    return Err(format!(
                        "belief patch {belief_name}.{label} must be a finite number"
                    ))
                }
            };

            values.insert(label.clone(), num);
        }

        Ok(values)
    }

    fn merge_belief_patch(
        &mut self,
        patch: &BeliefPatch,
        origin: ProvenanceOrigin,
        source: &str,
    ) -> Result<(), String> {
        for (belief_name, patch_entry) in patch {
            let current_meta = self
                .belief_meta
                .get(belief_name)
                .cloned()
                .unwrap_or(BeliefMeta {
                    cardinality: BeliefCardinality::Exclusive,
                    domain: BeliefDomain::Closed,
                    open_mass: 0.0,
                });

            let cardinality = patch_entry.cardinality.unwrap_or(current_meta.cardinality);
            let domain = patch_entry.domain.unwrap_or(current_meta.domain);

            let mut merged_values = self
                .state
                .get(belief_name)
                .cloned()
                .unwrap_or_else(IndexMap::new);

            for (k, v) in &patch_entry.values {
                merged_values.insert(k.clone(), *v);
            }

            self.set_belief(
                belief_name,
                &merged_values,
                cardinality,
                domain,
                (origin, source),
                true,
            )?;
        }

        Ok(())
    }

    fn log_trace(&self, msg: &str) {
        if self.trace {
            println!("[trace] {msg}");
        }
    }
}
