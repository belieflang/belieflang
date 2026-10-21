use bel_syntax::ast::{ConditionExpression, Operator, ValueExpression};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum RuntimeValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Arc<Vec<RuntimeValue>>),
    Object(Arc<IndexMap<String, RuntimeValue>>),
}

impl PartialEq for RuntimeValue {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (RuntimeValue::Null, RuntimeValue::Null) => true,
            (RuntimeValue::Bool(a), RuntimeValue::Bool(b)) => a == b,
            (RuntimeValue::Number(a), RuntimeValue::Number(b)) => {
                if a.is_nan() || b.is_nan() {
                    false
                } else {
                    a == b
                }
            }
            (RuntimeValue::String(a), RuntimeValue::String(b)) => a == b,
            (RuntimeValue::Array(a), RuntimeValue::Array(b)) => a == b,
            (RuntimeValue::Object(a), RuntimeValue::Object(b)) => a == b,
            _ => false,
        }
    }
}

impl PartialEq<Value> for RuntimeValue {
    fn eq(&self, other: &Value) -> bool {
        match (self, other) {
            (RuntimeValue::Null, Value::Null) => true,
            (RuntimeValue::Bool(a), Value::Bool(b)) => a == b,
            (RuntimeValue::Number(a), Value::Number(b)) => b
                .as_f64()
                .is_some_and(|bn| !a.is_nan() && !bn.is_nan() && *a == bn),
            (RuntimeValue::String(a), Value::String(b)) => a == b,
            (RuntimeValue::Array(a), Value::Array(b)) => {
                if a.len() != b.len() {
                    return false;
                }
                a.iter().zip(b.iter()).all(|(x, y)| x == y)
            }
            (RuntimeValue::Object(a), Value::Object(b)) => {
                if a.len() != b.len() {
                    return false;
                }
                for (k, v) in a.iter() {
                    if let Some(bv) = b.get(k) {
                        if v != bv {
                            return false;
                        }
                    } else {
                        return false;
                    }
                }
                true
            }
            _ => false,
        }
    }
}

impl PartialEq<RuntimeValue> for Value {
    fn eq(&self, other: &RuntimeValue) -> bool {
        other == self
    }
}

impl RuntimeValue {
    pub fn is_null(&self) -> bool {
        matches!(self, RuntimeValue::Null)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            RuntimeValue::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            RuntimeValue::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            RuntimeValue::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&IndexMap<String, RuntimeValue>> {
        match self {
            RuntimeValue::Object(map) => Some(map.as_ref()),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[RuntimeValue]> {
        match self {
            RuntimeValue::Array(arr) => Some(arr.as_ref()),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&RuntimeValue> {
        match self {
            RuntimeValue::Object(map) => map.get(key),
            _ => None,
        }
    }
}

impl From<Value> for RuntimeValue {
    fn from(v: Value) -> Self {
        match v {
            Value::Null => RuntimeValue::Null,
            Value::Bool(b) => RuntimeValue::Bool(b),
            Value::Number(n) => RuntimeValue::Number(n.as_f64().unwrap_or(0.0)),
            Value::String(s) => RuntimeValue::String(s),
            Value::Array(arr) => {
                let items: Vec<RuntimeValue> = arr.into_iter().map(RuntimeValue::from).collect();
                RuntimeValue::Array(Arc::new(items))
            }
            Value::Object(map) => {
                let mut index_map = IndexMap::new();
                for (k, val) in map {
                    index_map.insert(k, RuntimeValue::from(val));
                }
                RuntimeValue::Object(Arc::new(index_map))
            }
        }
    }
}

impl From<&Value> for RuntimeValue {
    fn from(v: &Value) -> Self {
        Self::from(v.clone())
    }
}

impl From<RuntimeValue> for Value {
    fn from(rv: RuntimeValue) -> Self {
        match rv {
            RuntimeValue::Null => Value::Null,
            RuntimeValue::Bool(b) => Value::Bool(b),
            RuntimeValue::Number(n) => {
                if n.fract() == 0.0
                    && n.is_finite()
                    && n >= (i64::MIN as f64)
                    && n <= (i64::MAX as f64)
                {
                    Value::Number(serde_json::Number::from(n as i64))
                } else if let Some(num) = serde_json::Number::from_f64(n) {
                    Value::Number(num)
                } else {
                    Value::Null
                }
            }
            RuntimeValue::String(s) => Value::String(s),
            RuntimeValue::Array(arr) => {
                Value::Array(arr.iter().cloned().map(Value::from).collect())
            }
            RuntimeValue::Object(map) => {
                let mut serde_map = serde_json::Map::new();
                for (k, v) in map.iter() {
                    serde_map.insert(k.clone(), Value::from(v.clone()));
                }
                Value::Object(serde_map)
            }
        }
    }
}

impl From<&RuntimeValue> for Value {
    fn from(rv: &RuntimeValue) -> Self {
        rv.clone().into()
    }
}

impl From<f64> for RuntimeValue {
    fn from(n: f64) -> Self {
        RuntimeValue::Number(n)
    }
}

impl From<i64> for RuntimeValue {
    fn from(n: i64) -> Self {
        RuntimeValue::Number(n as f64)
    }
}

impl From<bool> for RuntimeValue {
    fn from(b: bool) -> Self {
        RuntimeValue::Bool(b)
    }
}

impl From<String> for RuntimeValue {
    fn from(s: String) -> Self {
        RuntimeValue::String(s)
    }
}

impl From<&str> for RuntimeValue {
    fn from(s: &str) -> Self {
        RuntimeValue::String(s.to_string())
    }
}

impl Serialize for RuntimeValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        Value::from(self).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for RuntimeValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let v = Value::deserialize(deserializer)?;
        Ok(RuntimeValue::from(v))
    }
}

pub fn to_boolean(value: &RuntimeValue) -> bool {
    match value {
        RuntimeValue::Null => false,
        RuntimeValue::Bool(b) => *b,
        RuntimeValue::Number(n) => *n != 0.0 && !n.is_nan(),
        RuntimeValue::String(s) => !s.is_empty(),
        RuntimeValue::Array(arr) => !arr.is_empty(),
        RuntimeValue::Object(obj) => !obj.is_empty(),
    }
}

pub fn js_string_to_number(s: &str) -> Option<f64> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if trimmed == "Infinity" || trimmed == "+Infinity" {
        return Some(f64::INFINITY);
    }
    if trimmed == "-Infinity" {
        return Some(f64::NEG_INFINITY);
    }
    if let Some(rest) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return i64::from_str_radix(rest, 16).map(|n| n as f64).ok();
    }
    if let Some(rest) = trimmed
        .strip_prefix("0o")
        .or_else(|| trimmed.strip_prefix("0O"))
    {
        return i64::from_str_radix(rest, 8).map(|n| n as f64).ok();
    }
    if let Some(rest) = trimmed
        .strip_prefix("0b")
        .or_else(|| trimmed.strip_prefix("0B"))
    {
        return i64::from_str_radix(rest, 2).map(|n| n as f64).ok();
    }
    trimmed.parse::<f64>().ok().filter(|f| !f.is_nan())
}

pub fn js_to_number(value: &RuntimeValue) -> Option<f64> {
    match value {
        RuntimeValue::Number(n) => {
            if n.is_nan() {
                None
            } else {
                Some(*n)
            }
        }
        RuntimeValue::Null => Some(0.0),
        RuntimeValue::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        RuntimeValue::String(s) => js_string_to_number(s),
        RuntimeValue::Array(arr) => {
            if arr.is_empty() {
                Some(0.0)
            } else if arr.len() == 1 {
                js_to_number(&arr[0])
            } else {
                None
            }
        }
        RuntimeValue::Object(_) => None,
    }
}

pub fn to_number(value: &RuntimeValue) -> Option<f64> {
    js_to_number(value)
}

pub fn format_value(value: &RuntimeValue) -> String {
    match value {
        RuntimeValue::Number(n) => {
            if n.fract() == 0.0 && !n.is_nan() && !n.is_infinite() {
                format!("{}", *n as i64)
            } else {
                format!("{:.3}", n)
            }
        }
        RuntimeValue::String(s) => serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\"")),
        RuntimeValue::Bool(b) => b.to_string(),
        RuntimeValue::Null => "null".to_string(),
        RuntimeValue::Array(arr) => {
            let items: Vec<String> = arr.iter().map(format_value).collect();
            format!("[{}]", items.join(", "))
        }
        RuntimeValue::Object(obj) => {
            let items: Vec<String> = obj
                .iter()
                .map(|(k, v)| format!("{k}: {}", format_value(v)))
                .collect();
            format!("{{{}}}", items.join(", "))
        }
    }
}

pub fn describe_value_expression(expr: &ValueExpression) -> String {
    match expr {
        ValueExpression::Number { value } => {
            if value.fract() == 0.0 && !value.is_nan() && !value.is_infinite() {
                format!("{}", *value as i64)
            } else {
                format!("{value}")
            }
        }
        ValueExpression::String { value } => {
            serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
        }
        ValueExpression::Boolean { value } => value.to_string(),
        ValueExpression::Identifier { name } => name.clone(),
        ValueExpression::Metric { function, arg } => format!("{function}({arg})"),
        ValueExpression::Call { tool_name } => format!("call {tool_name}()"),
    }
}

pub fn describe_condition(expr: &ConditionExpression) -> String {
    match expr {
        ConditionExpression::Comparison { left, op, right } => {
            format!(
                "{} {} {}",
                describe_value_expression(left),
                op.as_str(),
                describe_value_expression(right)
            )
        }
        ConditionExpression::Truthy { expr } => describe_value_expression(expr),
        ConditionExpression::Not { expr } => format!("!({})", describe_condition(expr)),
        ConditionExpression::And { left, right } => {
            format!(
                "({} && {})",
                describe_condition(left),
                describe_condition(right)
            )
        }
        ConditionExpression::Or { left, right } => {
            format!(
                "({} || {})",
                describe_condition(left),
                describe_condition(right)
            )
        }
    }
}

/// JavaScript strict equality (`===`) semantics:
/// Primitives compare by value. Objects and Arrays compare by pointer/reference identity.
pub fn strict_eq(left: &RuntimeValue, right: &RuntimeValue) -> bool {
    match (left, right) {
        (RuntimeValue::Null, RuntimeValue::Null) => true,
        (RuntimeValue::Bool(a), RuntimeValue::Bool(b)) => a == b,
        (RuntimeValue::Number(a), RuntimeValue::Number(b)) => {
            if a.is_nan() || b.is_nan() {
                false
            } else {
                a == b
            }
        }
        (RuntimeValue::String(a), RuntimeValue::String(b)) => a == b,
        (RuntimeValue::Array(a), RuntimeValue::Array(b)) => Arc::ptr_eq(a, b),
        (RuntimeValue::Object(a), RuntimeValue::Object(b)) => Arc::ptr_eq(a, b),
        _ => false,
    }
}

pub fn compare_values(
    left: &RuntimeValue,
    op: Operator,
    right: &RuntimeValue,
) -> Result<bool, String> {
    if op == Operator::Eq {
        return Ok(strict_eq(left, right));
    }
    if op == Operator::Neq {
        return Ok(!strict_eq(left, right));
    }

    let left_num = js_to_number(left);
    let right_num = js_to_number(right);

    match (left_num, right_num) {
        (Some(l), Some(r)) => match op {
            Operator::Gt => Ok(l > r),
            Operator::Gte => Ok(l >= r),
            Operator::Lt => Ok(l < r),
            Operator::Lte => Ok(l <= r),
            _ => Err(format!("Unsupported operator {op}")),
        },
        _ => Err(format!("Operator {op} requires numeric operands")),
    }
}

pub fn resolve_path_in_json(value: &RuntimeValue, path: &str) -> Result<RuntimeValue, String> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = value;

    for part in parts {
        match current {
            RuntimeValue::Object(map) => {
                if let Some(v) = map.get(part) {
                    current = v;
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

    Ok(current.clone())
}

pub fn json_to_indexmap(val: &RuntimeValue) -> Option<IndexMap<String, RuntimeValue>> {
    if let RuntimeValue::Object(map) = val {
        Some((**map).clone())
    } else {
        None
    }
}
