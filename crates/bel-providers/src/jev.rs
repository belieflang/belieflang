use crate::transport::{HttpTransport, ReqwestTransport};
use async_trait::async_trait;
use bel_runtime::runtime::{BeliefPatch, BeliefPatchEntry, InferBeliefsAdapter, InferContext};
use bel_runtime::values::RuntimeValue;
use bel_syntax::ast::{BeliefCardinality, BeliefDistribution, BeliefDomain};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub const DEFAULT_JEV_ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct JevUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Clone)]
pub struct JevOptions {
    pub api_key: String,
    pub model: Option<String>,
    pub chat_snapshot: bool,
    pub chat_history: bool,
    pub endpoint: Option<String>,
    pub transport: Option<Arc<dyn HttpTransport>>,
    pub on_usage: Option<Arc<dyn Fn(JevUsage) + Send + Sync>>,
}

fn check_probability(val: Option<&Value>, path: &str) -> Result<f64, String> {
    match val {
        Some(Value::Number(n)) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && (0.0..=1.0).contains(&f) {
                    return Ok(f);
                }
            }
            Err(format!("invalid Jev probability at {path}"))
        }
        _ => Err(format!("invalid Jev probability at {path}")),
    }
}

fn check_token_count(val: Option<&Value>, path: &str) -> Result<u64, String> {
    match val {
        Some(Value::Number(n)) => {
            if let Some(u) = n.as_u64() {
                Ok(u)
            } else if let Some(f) = n.as_f64() {
                if f >= 0.0 && f.fract() == 0.0 {
                    Ok(f as u64)
                } else {
                    Err(format!("invalid Jev token count at {path}"))
                }
            } else {
                Err(format!("invalid Jev token count at {path}"))
            }
        }
        _ => Err(format!("invalid Jev token count at {path}")),
    }
}

pub struct JevInferAdapter {
    options: JevOptions,
    transport: Arc<dyn HttpTransport>,
}

impl JevInferAdapter {
    pub fn new(options: JevOptions) -> Result<Self, String> {
        if options.api_key.trim().is_empty() {
            return Err("TYPESAFE_API_KEY is required for Jev inference".to_string());
        }
        if options.chat_snapshot && options.chat_history {
            return Err("choose either chatSnapshot or chatHistory for Jev inference".to_string());
        }
        let transport = options
            .transport
            .clone()
            .unwrap_or_else(|| Arc::new(ReqwestTransport::new()));

        Ok(Self { options, transport })
    }
}

#[async_trait]
impl InferBeliefsAdapter for JevInferAdapter {
    async fn infer(
        &self,
        source: &RuntimeValue,
        _context: &InferContext,
    ) -> Result<BeliefPatch, String> {
        let source_str = match source.as_str() {
            Some(s) => s,
            _ => return Err("Jev inference currently requires a string source".to_string()),
        };

        let state_val: Value = if self.options.chat_snapshot {
            let parsed: Value = serde_json::from_str(source_str).map_err(|_| {
                "Jev chat inference requires a snapshot and new_message JSON input".to_string()
            })?;
            let obj = parsed.as_object().ok_or_else(|| {
                "Jev chat inference requires a snapshot and new_message JSON input".to_string()
            })?;

            if !obj.get("new_message").is_some_and(|m| m.is_string())
                || !obj.get("previous_beliefs").is_some_and(|p| p.is_object())
            {
                return Err(
                    "Jev chat inference requires a snapshot and new_message JSON input".to_string(),
                );
            }
            parsed
        } else if self.options.chat_history {
            let parsed: Value = serde_json::from_str(source_str).map_err(|_| {
                "Jev chat-history inference requires a messages JSON array".to_string()
            })?;
            let obj = parsed.as_object().ok_or_else(|| {
                "Jev chat-history inference requires a messages JSON array".to_string()
            })?;

            let msgs = obj.get("messages").and_then(|m| m.as_array());
            match msgs {
                Some(arr) if !arr.is_empty() && arr.iter().all(|m| m.is_string()) => parsed,
                _ => {
                    return Err(
                        "Jev chat-history inference requires a messages JSON array".to_string()
                    )
                }
            }
        } else {
            Value::String(source_str.to_string())
        };

        let endpoint = self
            .options
            .endpoint
            .as_deref()
            .unwrap_or(DEFAULT_JEV_ENDPOINT);

        let mut headers = HashMap::new();
        headers.insert(
            "Authorization".to_string(),
            format!("Bearer {}", self.options.api_key),
        );
        headers.insert("Content-Type".to_string(), "application/json".to_string());

        let intent_instructions = if self.options.chat_snapshot {
            "Given previous beliefs and the new message, what is the user's current primary booking intent? The latest explicit change overrides earlier intent."
        } else if self.options.chat_history {
            "Given the messages in order, what is the user's current primary booking intent? The latest explicit change overrides earlier intent."
        } else {
            "What is the user's primary booking intent?"
        };

        let budget_instructions = if self.options.chat_snapshot {
            "Considering previous beliefs and the new message, does the user currently prefer a low price or have a limited budget? Preserve the previous preference unless explicitly changed."
        } else if self.options.chat_history {
            "Considering all messages in order, does the user currently prefer a low price or have a limited budget? The latest explicit change overrides older statements; otherwise preserve the preference."
        } else {
            "Does the user express a preference for a low price or a limited budget?"
        };

        let direct_instructions = if self.options.chat_snapshot {
            "Considering previous beliefs and the new message, does the user currently prefer a direct flight without stops? Preserve the previous preference unless explicitly changed."
        } else if self.options.chat_history {
            "Considering all messages in order, does the user currently prefer a direct flight without stops? The latest explicit change overrides older statements; otherwise preserve the preference."
        } else {
            "Does the user express a preference for a direct flight without stops?"
        };

        let body = json!({
            "model": self.options.model.as_deref().unwrap_or("jev-latest"),
            "state": state_val,
            "questions": {
                "intent": {
                    "type": "choice",
                    "instructions": intent_instructions,
                    "criteria": {
                        "book_flight": "The user wants to book or find a flight.",
                        "book_hotel": "The user wants to book or find a hotel.",
                        "unknown": "Neither flight nor hotel booking is the primary intent, or the intent is unclear."
                    }
                },
                "budget_sensitive": {
                    "type": "noul",
                    "instructions": budget_instructions
                },
                "prefers_direct": {
                    "type": "noul",
                    "instructions": direct_instructions
                }
            }
        });

        let resp = self
            .transport
            .send(endpoint, &headers, &body.to_string(), None)
            .await?;

        if resp.status != 200 {
            return Err(format!("Jev API returned HTTP {}", resp.status));
        }

        let data: Value = serde_json::from_str(&resp.body)
            .map_err(|_| "invalid Jev object at response".to_string())?;

        let answers = data
            .get("answers")
            .and_then(|a| a.as_object())
            .ok_or_else(|| "invalid Jev object at answers".to_string())?;

        let intent_obj = answers
            .get("intent")
            .and_then(|i| i.as_object())
            .ok_or_else(|| "invalid Jev object at answers.intent".to_string())?;
        let budget_obj = answers
            .get("budget_sensitive")
            .and_then(|b| b.as_object())
            .ok_or_else(|| "invalid Jev object at answers.budget_sensitive".to_string())?;
        let direct_obj = answers
            .get("prefers_direct")
            .and_then(|d| d.as_object())
            .ok_or_else(|| "invalid Jev object at answers.prefers_direct".to_string())?;

        if intent_obj.get("type").and_then(|t| t.as_str()) != Some("choice")
            || budget_obj.get("type").and_then(|t| t.as_str()) != Some("noul")
            || direct_obj.get("type").and_then(|t| t.as_str()) != Some("noul")
        {
            return Err("Jev returned an unexpected answer type".to_string());
        }

        let probs = intent_obj
            .get("probabilities")
            .and_then(|p| p.as_object())
            .ok_or_else(|| "invalid Jev object at answers.intent.probabilities".to_string())?;

        let mut intent_values = BeliefDistribution::new();
        intent_values.insert(
            "book_flight".to_string(),
            check_probability(probs.get("book_flight"), "intent.book_flight")?,
        );
        intent_values.insert(
            "book_hotel".to_string(),
            check_probability(probs.get("book_hotel"), "intent.book_hotel")?,
        );
        intent_values.insert(
            "unknown".to_string(),
            check_probability(probs.get("unknown"), "intent.unknown")?,
        );

        let budget_val = check_probability(budget_obj.get("noul"), "budget_sensitive.noul")?;
        let direct_val = check_probability(direct_obj.get("noul"), "prefers_direct.noul")?;

        let mut user_values = BeliefDistribution::new();
        user_values.insert("budget_sensitive".to_string(), budget_val);
        user_values.insert("prefers_direct".to_string(), direct_val);

        let usage_val = data
            .get("usage")
            .ok_or_else(|| "invalid Jev object at usage".to_string())?;
        let usage_obj = usage_val
            .as_object()
            .ok_or_else(|| "invalid Jev object at usage".to_string())?;

        let input_tokens = check_token_count(usage_obj.get("input_tokens"), "usage.input_tokens")?;
        let output_tokens =
            check_token_count(usage_obj.get("output_tokens"), "usage.output_tokens")?;

        if let Some(on_usage) = &self.options.on_usage {
            on_usage(JevUsage {
                input_tokens,
                output_tokens,
            });
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
        patch.insert(
            "user".to_string(),
            BeliefPatchEntry {
                values: user_values,
                cardinality: Some(BeliefCardinality::Multi),
                domain: Some(BeliefDomain::Closed),
            },
        );

        Ok(patch)
    }
}
