use crate::memory::{FactSource, FactStatus, FactView, SourceRef};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScopeEntry {
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub action: String,
    pub allowed: bool,
    pub source: SourceRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_after_turn: Option<i64>,
    pub scope: IndexMap<String, ScopeEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Decision {
    pub allowed: bool,
    pub reason: String,
    pub sources: Vec<SourceRef>,
}

#[derive(Debug, Clone, Default)]
pub struct AgentDecisionGuard {
    approvals: Vec<Approval>,
}

impl AgentDecisionGuard {
    pub fn new() -> Self {
        Self {
            approvals: Vec::new(),
        }
    }

    pub fn record(
        &mut self,
        view: &FactView,
        action: &str,
        allowed: bool,
        fields: &[String],
        source: &FactSource,
        expires_after_turn: Option<i64>,
    ) -> Result<(), String> {
        let trimmed = action.trim();
        if trimmed.is_empty() {
            return Err("invalid host approval".to_string());
        }

        if source.turn < 1 {
            return Err("invalid host approval".to_string());
        }

        let id = &source.id;
        if id.is_empty()
            || id.len() > 128
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == ':' || c == '_' || c == '-')
        {
            return Err("invalid host approval".to_string());
        }

        if fields.is_empty() {
            return Err("invalid host approval".to_string());
        }

        let mut unique_fields = std::collections::HashSet::new();
        for f in fields {
            if f.is_empty() || !unique_fields.insert(f) {
                return Err("invalid host approval".to_string());
            }
        }

        if let Some(exp) = expires_after_turn {
            if exp < source.turn {
                return Err("invalid host approval".to_string());
            }
        }

        let previous = self.approvals.iter().rev().find(|a| a.action == action);

        if let Some(prev) = previous {
            if source.turn <= prev.source.turn {
                return Err("approval events must increase".to_string());
            }
        }

        let mut scope = IndexMap::new();
        for field in fields {
            let entry = if let Some(cell) = view.current.get(field) {
                ScopeEntry {
                    revision: cell.revision,
                    value: cell.value.clone(),
                }
            } else {
                ScopeEntry {
                    revision: -1,
                    value: None,
                }
            };
            scope.insert(field.clone(), entry);
        }

        self.approvals.push(Approval {
            action: action.to_string(),
            allowed,
            source: SourceRef {
                id: source.id.clone(),
                turn: source.turn,
            },
            expires_after_turn,
            scope,
        });

        Ok(())
    }

    pub fn explain(
        &self,
        view: &FactView,
        action: &str,
        parameters: &IndexMap<String, Value>,
        turn: i64,
    ) -> Result<Decision, String> {
        if turn < 1 {
            return Err("invalid decision turn".to_string());
        }

        let approval = match self.approvals.iter().rev().find(|a| a.action == action) {
            Some(a) => a,
            None => {
                return Ok(Decision {
                    allowed: false,
                    reason: "approval_missing".to_string(),
                    sources: Vec::new(),
                })
            }
        };

        let mut sources = vec![approval.source.clone()];
        let denied = |reason: &str, sources: Vec<SourceRef>| Decision {
            allowed: false,
            reason: reason.to_string(),
            sources,
        };

        if !approval.allowed {
            return Ok(denied("approval_revoked", sources));
        }

        if turn < approval.source.turn
            || (approval.expires_after_turn.is_some()
                && turn > approval.expires_after_turn.unwrap())
        {
            return Ok(denied("approval_expired_or_future", sources));
        }

        if parameters.len() != approval.scope.len() {
            return Ok(denied("scope_mismatch", sources));
        }

        for (field, scope) in &approval.scope {
            let cell = view.current.get(field);
            if let Some(c) = cell {
                sources.push(c.source.clone());
            }

            let cell = match cell {
                Some(c) if c.status == FactStatus::Confirmed => c,
                _ => return Ok(denied(&format!("fact_not_confirmed:{field}"), sources)),
            };

            let val_ok = match &cell.value {
                Some(Value::String(_)) | Some(Value::Bool(_)) => true,
                Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f.is_finite()),
                _ => false,
            };

            if !val_ok
                || cell.revision < 1
                || cell.source.turn < 1
                || cell.source.turn > turn
                || cell.source.id.is_empty()
            {
                return Ok(denied(&format!("invalid_or_future_fact:{field}"), sources));
            }

            if cell.revision != scope.revision || cell.value != scope.value {
                return Ok(denied(&format!("stale_approval:{field}"), sources));
            }

            if parameters.get(field) != cell.value.as_ref() {
                return Ok(denied(&format!("stale_parameters:{field}"), sources));
            }
        }

        Ok(Decision {
            allowed: true,
            reason: "verified_approval_and_current_constraints".to_string(),
            sources,
        })
    }

    pub fn history(&self) -> Vec<Approval> {
        self.approvals.clone()
    }

    pub async fn execute<F, Fut, T>(
        &self,
        view: &FactView,
        action: &str,
        parameters: &IndexMap<String, Value>,
        turn: i64,
        tool: F,
    ) -> Result<(Decision, Option<T>), String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let decision = self.explain(view, action, parameters, turn)?;
        if decision.allowed {
            let res = tool().await;
            Ok((decision, Some(res)))
        } else {
            Ok((decision, None))
        }
    }
}
