use bel_syntax::ast::{ConditionExpression, Operator, ValueExpression};
use indexmap::IndexMap;
use serde_json::Value;

pub type RuntimeValue = Value;

pub fn to_boolean(value: &RuntimeValue) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(arr) => !arr.is_empty(),
        Value::Object(obj) => !obj.is_empty(),
    }
}

pub fn to_number(value: &RuntimeValue) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        Value::Array(_) | Value::Object(_) => None,
    }
}

pub fn format_value(value: &RuntimeValue) -> String {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 && !f.is_nan() && !f.is_infinite() {
                    format!("{}", f as i64)
                } else {
                    format!("{:.3}", f)
                }
            } else {
                n.to_string()
            }
        }
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\"")),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        Value::Array(_) | Value::Object(_) => serde_json::to_string(value).unwrap_or_default(),
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

pub fn compare_values(
    left: &RuntimeValue,
    op: Operator,
    right: &RuntimeValue,
) -> Result<bool, String> {
    if op == Operator::Eq {
        return Ok(left == right);
    }
    if op == Operator::Neq {
        return Ok(left != right);
    }

    let left_num = to_number(left);
    let right_num = to_number(right);

    match (left_num, right_num) {
        (Some(l), Some(r)) if !l.is_nan() && !r.is_nan() => match op {
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
            Value::Object(map) => {
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
    if let Value::Object(map) = val {
        let mut im = IndexMap::new();
        for (k, v) in map {
            im.insert(k.clone(), v.clone());
        }
        Some(im)
    } else {
        None
    }
}
