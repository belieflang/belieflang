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
use std::time::Duration;

pub const DEFAULT_OPENAI_ENDPOINT: &str = "https://api.openai.com/v1/responses";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenAIUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct BeliefFields {
    pub intents: Vec<String>,
    pub flags: Vec<String>,
}

#[derive(Clone)]
pub struct OpenAIOptions {
    pub api_key: String,
    pub model: Option<String>,
    pub instructions: Option<String>,
    pub transport: Option<Arc<dyn HttpTransport>>,
    pub on_usage: Option<Arc<dyn Fn(OpenAIUsage) + Send + Sync>>,
    pub on_response_id: Option<Arc<dyn Fn(String) + Send + Sync>>,
    pub on_compaction_items: Option<Arc<dyn Fn(usize) + Send + Sync>>,
    pub store: Option<bool>,
    pub previous_response_id: Option<String>,
    pub compact_threshold: Option<usize>,
    pub belief_fields: Option<BeliefFields>,
    pub request_timeout_ms: Option<u64>,
}

fn probability(val: Option<&Value>, path: &str) -> Result<f64, String> {
    match val {
        Some(Value::Number(n)) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && (0.0..=1.0).contains(&f) {
                    return Ok(f);
                }
            }
            Err(format!("invalid OpenAI probability at {path}"))
        }
        _ => Err(format!("invalid OpenAI probability at {path}")),
    }
}

fn token_count(val: Option<&Value>, path: &str) -> Result<u64, String> {
    match val {
        Some(Value::Number(n)) => {
            if let Some(u) = n.as_u64() {
                Ok(u)
            } else if let Some(f) = n.as_f64() {
                if f >= 0.0 && f.fract() == 0.0 {
                    Ok(f as u64)
                } else {
                    Err(format!("invalid OpenAI token count at {path}"))
                }
            } else {
                Err(format!("invalid OpenAI token count at {path}"))
            }
        }
        _ => Err(format!("invalid OpenAI token count at {path}")),
    }
}

fn build_schema(intents: &[String], flags: &[String]) -> Value {
    let prob_schema = json!({ "type": "number", "minimum": 0, "maximum": 1 });

    let mut intent_props = serde_json::Map::new();
    for intent in intents {
        intent_props.insert(intent.clone(), prob_schema.clone());
    }

    let mut properties = serde_json::Map::new();
    properties.insert(
        "intent".to_string(),
        json!({
            "type": "object",
            "properties": intent_props,
            "required": intents,
            "additionalProperties": false,
        }),
    );

    for flag in flags {
        properties.insert(flag.clone(), prob_schema.clone());
    }

    let mut required = vec!["intent".to_string()];
    required.extend(flags.iter().cloned());

    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

pub struct OpenAIInferAdapter {
    options: OpenAIOptions,
    transport: Arc<dyn HttpTransport>,
}

impl OpenAIInferAdapter {
    pub fn new(options: OpenAIOptions) -> Result<Self, String> {
        if options.api_key.trim().is_empty() {
            return Err("OPENAI_API_KEY is required for ChatGPT inference".to_string());
        }

        if let Some(fields) = &options.belief_fields {
            if fields.intents.is_empty() || fields.flags.is_empty() {
                return Err("invalid OpenAI belief fields".to_string());
            }

            let mut intent_set = std::collections::HashSet::new();
            for i in &fields.intents {
                if i.trim().is_empty() || !intent_set.insert(i) {
                    return Err("invalid OpenAI belief fields".to_string());
                }
            }

            let mut flag_set = std::collections::HashSet::new();
            for f in &fields.flags {
                if f.trim().is_empty() || f == "intent" || !flag_set.insert(f) {
                    return Err("invalid OpenAI belief fields".to_string());
                }
            }
        }

        let transport = options
            .transport
            .clone()
            .unwrap_or_else(|| Arc::new(ReqwestTransport::new()));

        Ok(Self { options, transport })
    }
}

#[async_trait]
impl InferBeliefsAdapter for OpenAIInferAdapter {
    async fn infer(
        &self,
        source: &RuntimeValue,
        _context: &InferContext,
    ) -> Result<BeliefPatch, String> {
        let source_str = match source {
            Value::String(s) => s,
            _ => return Err("ChatGPT inference currently requires a string source".to_string()),
        };

        let default_intents = vec![
            "book_flight".to_string(),
            "book_hotel".to_string(),
            "unknown".to_string(),
        ];
        let default_flags = vec!["budget_sensitive".to_string(), "prefers_direct".to_string()];

        let (intents, flags) = match &self.options.belief_fields {
            Some(f) => (&f.intents, &f.flags),
            None => (&default_intents, &default_flags),
        };

        let schema_name = if self.options.belief_fields.is_some() {
            "multidomain_beliefs"
        } else {
            "travel_beliefs"
        };
        let schema = build_schema(intents, flags);

        let model = self.options.model.as_deref().unwrap_or("gpt-6-luna");

        let mut body_map = serde_json::Map::new();
        body_map.insert("model".to_string(), json!(model));

        if model == "gpt-6-luna" {
            body_map.insert("reasoning".to_string(), json!({ "effort": "none" }));
        }

        if let Some(store) = self.options.store {
            body_map.insert("store".to_string(), json!(store));
        } else {
            body_map.insert("store".to_string(), json!(false));
        }

        if let Some(prev_id) = &self.options.previous_response_id {
            body_map.insert("previous_response_id".to_string(), json!(prev_id));
        }

        if let Some(compact) = self.options.compact_threshold {
            body_map.insert(
                "context_management".to_string(),
                json!([{ "type": "compaction", "compact_threshold": compact }]),
            );
        }

        let default_instructions = "Classify the user's travel request. Give probabilities for primary intent: book_flight means booking or finding a flight, book_hotel means booking or finding a hotel, and unknown means neither or unclear. The three intent probabilities should sum to 1. Give independent probabilities for budget_sensitive (low price or limited budget) and prefers_direct (a direct flight without stops). Base answers only on the supplied request.";
        body_map.insert(
            "instructions".to_string(),
            json!(self
                .options
                .instructions
                .as_deref()
                .unwrap_or(default_instructions)),
        );

        body_map.insert("input".to_string(), json!(source_str));
        body_map.insert(
            "text".to_string(),
            json!({
                "format": {
                    "type": "json_schema",
                    "name": schema_name,
                    "strict": true,
                    "schema": schema,
                }
            }),
        );

        let mut headers = HashMap::new();
        headers.insert(
            "Authorization".to_string(),
            format!("Bearer {}", self.options.api_key),
        );
        headers.insert("Content-Type".to_string(), "application/json".to_string());

        let timeout = self.options.request_timeout_ms.map(Duration::from_millis);

        let resp = self
            .transport
            .send(
                DEFAULT_OPENAI_ENDPOINT,
                &headers,
                &Value::Object(body_map).to_string(),
                timeout,
            )
            .await?;

        if resp.status != 200 {
            return Err(format!("OpenAI API returned HTTP {}", resp.status));
        }

        let data: Value = serde_json::from_str(&resp.body)
            .map_err(|_| "invalid OpenAI object at response".to_string())?;

        let status = data.get("status").and_then(|s| s.as_str());
        if status != Some("completed") {
            return Err(format!(
                "OpenAI response status: {}",
                status.unwrap_or("unknown")
            ));
        }

        let output_array = data
            .get("output")
            .and_then(|o| o.as_array())
            .ok_or_else(|| "OpenAI response has no output array".to_string())?;

        let compaction_count = output_array
            .iter()
            .filter(|item| item.get("type").and_then(|t| t.as_str()) == Some("compaction"))
            .count();
        if let Some(on_compaction) = &self.options.on_compaction_items {
            on_compaction(compaction_count);
        }

        let messages: Vec<&Value> = output_array
            .iter()
            .filter(|item| item.get("type").and_then(|t| t.as_str()) == Some("message"))
            .collect();

        let final_messages: Vec<&Value> = messages
            .iter()
            .copied()
            .filter(|item| item.get("phase").and_then(|p| p.as_str()) == Some("final_answer"))
            .collect();

        let answer_messages: Vec<&Value> = if !final_messages.is_empty() {
            final_messages
        } else {
            messages
                .into_iter()
                .filter(|item| item.get("phase").is_none())
                .collect()
        };

        if answer_messages.len() != 1 {
            return Err("OpenAI response must have exactly one final answer message".to_string());
        }

        let msg = answer_messages[0];
        let content_array = msg
            .get("content")
            .and_then(|c| c.as_array())
            .ok_or_else(|| "OpenAI message has no content array".to_string())?;

        let mut text_parts = Vec::new();
        for part in content_array {
            if part.get("type").and_then(|t| t.as_str()) == Some("output_text") {
                if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                    text_parts.push(text);
                }
            }
        }

        if text_parts.is_empty() {
            return Err("OpenAI response has no output text".to_string());
        }

        let full_text = text_parts.join("");
        let parsed: Value = serde_json::from_str(&full_text)
            .map_err(|_| "OpenAI returned invalid JSON".to_string())?;

        let result_obj = parsed
            .as_object()
            .ok_or_else(|| "invalid OpenAI object at output text".to_string())?;

        let intent_obj = result_obj
            .get("intent")
            .and_then(|i| i.as_object())
            .ok_or_else(|| "invalid OpenAI object at intent".to_string())?;

        let mut intent_values = BeliefDistribution::new();
        for k in intents {
            let p = probability(intent_obj.get(k), &format!("intent.{k}"))?;
            intent_values.insert(k.clone(), p);
        }

        let mut user_values = BeliefDistribution::new();
        for flag in flags {
            let p = probability(result_obj.get(flag), flag)?;
            user_values.insert(flag.clone(), p);
        }

        if self.options.belief_fields.is_some() {
            let total: f64 = intent_values.values().sum();
            if (total - 1.0).abs() > 0.02 {
                return Err(format!("intent probabilities must sum to 1 (got {total})"));
            }
            if intent_obj.len() != intents.len() || result_obj.len() != flags.len() + 1 {
                return Err("unexpected OpenAI belief fields".to_string());
            }
        }

        let usage_obj = data
            .get("usage")
            .and_then(|u| u.as_object())
            .ok_or_else(|| "invalid OpenAI object at usage".to_string())?;

        let input_tokens = token_count(usage_obj.get("input_tokens"), "usage.input_tokens")?;
        let output_tokens = token_count(usage_obj.get("output_tokens"), "usage.output_tokens")?;

        let mut cached_input_tokens = None;
        let mut cache_write_tokens = None;

        if let Some(details) = usage_obj
            .get("input_tokens_details")
            .and_then(|d| d.as_object())
        {
            if let Some(ct) = details.get("cached_tokens") {
                cached_input_tokens = Some(token_count(
                    Some(ct),
                    "usage.input_tokens_details.cached_tokens",
                )?);
            }
            if let Some(cwt) = details.get("cache_write_tokens") {
                cache_write_tokens = Some(token_count(
                    Some(cwt),
                    "usage.input_tokens_details.cache_write_tokens",
                )?);
            }
        }

        if cached_input_tokens.unwrap_or(0) + cache_write_tokens.unwrap_or(0) > input_tokens {
            return Err("OpenAI cache token counts exceed input tokens".to_string());
        }

        if let Some(on_usage) = &self.options.on_usage {
            on_usage(OpenAIUsage {
                input_tokens,
                output_tokens,
                cached_input_tokens,
                cache_write_tokens,
            });
        }

        if let Some(on_id) = &self.options.on_response_id {
            let id = data
                .get("id")
                .and_then(|i| i.as_str())
                .ok_or_else(|| "OpenAI response has no id".to_string())?;
            on_id(id.to_string());
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
