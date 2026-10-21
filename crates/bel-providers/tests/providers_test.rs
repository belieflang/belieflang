use bel_providers::jev::*;
use bel_providers::openai::*;
use bel_providers::transport::{HttpResponse, MockTransport};
use bel_runtime::runtime::{BeliefRuntime, RuntimeOptions};
use bel_syntax::ast::ValueExpression;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[tokio::test]
async fn jev_response_feeds_runtime_and_reports_usage() {
    let input_tokens = Arc::new(AtomicU64::new(0));
    let output_tokens = Arc::new(AtomicU64::new(0));
    let in_clone = input_tokens.clone();
    let out_clone = output_tokens.clone();

    let transport = MockTransport::new(|_url, headers, body| {
        assert_eq!(
            headers.get("Authorization"),
            Some(&"Bearer test-key".to_string())
        );
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.get("state"), Some(&json!("cheap direct flight")));
        assert_eq!(parsed.get("model"), Some(&json!("jev-latest")));

        Ok(HttpResponse {
            status: 200,
            body: json!({
                "model": "jev-1.13.0",
                "answers": {
                    "intent": {
                        "type": "choice",
                        "choice": "book_flight",
                        "confidence": 0.9,
                        "probabilities": {
                            "book_flight": 0.8,
                            "book_hotel": 0.1,
                            "unknown": 0.1
                        }
                    },
                    "budget_sensitive": { "type": "noul", "noul": 0.9 },
                    "prefers_direct": { "type": "noul", "noul": 0.85 }
                },
                "usage": { "input_tokens": 120, "output_tokens": 12 }
            })
            .to_string(),
        })
    });

    let adapter = JevInferAdapter::new(JevOptions {
        api_key: "test-key".to_string(),
        model: None,
        chat_snapshot: false,
        chat_history: false,
        endpoint: None,
        transport: Some(Arc::new(transport)),
        on_usage: Some(Arc::new(move |usage| {
            in_clone.store(usage.input_tokens, Ordering::SeqCst);
            out_clone.store(usage.output_tokens, Ordering::SeqCst);
        })),
    })
    .unwrap();

    let options = RuntimeOptions {
        infer_beliefs: Some(Arc::new(adapter)),
        ..Default::default()
    };

    let mut runtime = BeliefRuntime::new(bel_runtime::ToolRegistry::new(), options);

    runtime
        .assign(
            "message",
            &ValueExpression::String {
                value: "cheap direct flight".to_string(),
            },
        )
        .await
        .unwrap();

    runtime
        .infer(&ValueExpression::Identifier {
            name: "message".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(runtime.confidence("intent.book_flight"), 0.8);
    assert_eq!(runtime.confidence("user.budget_sensitive"), 0.9);
    assert_eq!(runtime.confidence("user.prefers_direct"), 0.85);

    assert_eq!(input_tokens.load(Ordering::SeqCst), 120);
    assert_eq!(output_tokens.load(Ordering::SeqCst), 12);
}

#[tokio::test]
async fn jev_http_errors_do_not_expose_api_key() {
    let transport = MockTransport::new(|_url, _headers, _body| {
        Ok(HttpResponse {
            status: 401,
            body: "invalid key".to_string(),
        })
    });

    let adapter = JevInferAdapter::new(JevOptions {
        api_key: "private-key-12345".to_string(),
        model: None,
        chat_snapshot: false,
        chat_history: false,
        endpoint: None,
        transport: Some(Arc::new(transport)),
        on_usage: None,
    })
    .unwrap();

    let options = RuntimeOptions {
        infer_beliefs: Some(Arc::new(adapter)),
        ..Default::default()
    };

    let mut runtime = BeliefRuntime::new(bel_runtime::ToolRegistry::new(), options);

    runtime
        .assign(
            "message",
            &ValueExpression::String {
                value: "flight".to_string(),
            },
        )
        .await
        .unwrap();

    let res = runtime
        .infer(&ValueExpression::Identifier {
            name: "message".to_string(),
        })
        .await;

    assert!(res.is_err());
    let err = res.err().unwrap();
    assert!(err.contains("HTTP 401"));
    assert!(!err.contains("private-key-12345"));
}

#[tokio::test]
async fn jev_rejects_malformed_probabilities() {
    let transport = MockTransport::new(|_url, _headers, _body| {
        Ok(HttpResponse {
            status: 200,
            body: json!({
                "answers": {
                    "intent": {
                        "type": "choice",
                        "probabilities": { "book_flight": 2.0, "book_hotel": 0.0, "unknown": 0.0 }
                    },
                    "budget_sensitive": { "type": "noul", "noul": 0.5 },
                    "prefers_direct": { "type": "noul", "noul": 0.5 }
                },
                "usage": { "input_tokens": 1, "output_tokens": 1 }
            })
            .to_string(),
        })
    });

    let adapter = JevInferAdapter::new(JevOptions {
        api_key: "test-key".to_string(),
        model: None,
        chat_snapshot: false,
        chat_history: false,
        endpoint: None,
        transport: Some(Arc::new(transport)),
        on_usage: None,
    })
    .unwrap();

    let options = RuntimeOptions {
        infer_beliefs: Some(Arc::new(adapter)),
        ..Default::default()
    };

    let mut runtime = BeliefRuntime::new(bel_runtime::ToolRegistry::new(), options);

    runtime
        .assign(
            "message",
            &ValueExpression::String {
                value: "flight".to_string(),
            },
        )
        .await
        .unwrap();

    let res = runtime
        .infer(&ValueExpression::Identifier {
            name: "message".to_string(),
        })
        .await;

    assert!(res.is_err());
    assert!(res.err().unwrap().contains("invalid Jev probability"));
}

#[tokio::test]
async fn jev_rejects_missing_or_malformed_usage() {
    // 1. Missing usage object entirely
    let transport_missing = MockTransport::new(|_url, _headers, _body| {
        Ok(HttpResponse {
            status: 200,
            body: json!({
                "answers": {
                    "intent": {
                        "type": "choice",
                        "probabilities": { "book_flight": 0.8, "book_hotel": 0.1, "unknown": 0.1 }
                    },
                    "budget_sensitive": { "type": "noul", "noul": 0.5 },
                    "prefers_direct": { "type": "noul", "noul": 0.5 }
                }
            })
            .to_string(),
        })
    });

    let adapter_missing = JevInferAdapter::new(JevOptions {
        api_key: "test-key".to_string(),
        model: None,
        chat_snapshot: false,
        chat_history: false,
        endpoint: None,
        transport: Some(Arc::new(transport_missing)),
        on_usage: None,
    })
    .unwrap();

    let mut runtime1 = BeliefRuntime::new(
        bel_runtime::ToolRegistry::new(),
        RuntimeOptions {
            infer_beliefs: Some(Arc::new(adapter_missing)),
            ..Default::default()
        },
    );

    runtime1
        .assign(
            "message",
            &ValueExpression::String {
                value: "flight".to_string(),
            },
        )
        .await
        .unwrap();

    let res1 = runtime1
        .infer(&ValueExpression::Identifier {
            name: "message".to_string(),
        })
        .await;

    assert!(res1.is_err());
    assert_eq!(res1.err().unwrap(), "invalid Jev object at usage");

    // 2. Malformed usage (not an object)
    let transport_malformed = MockTransport::new(|_url, _headers, _body| {
        Ok(HttpResponse {
            status: 200,
            body: json!({
                "answers": {
                    "intent": {
                        "type": "choice",
                        "probabilities": { "book_flight": 0.8, "book_hotel": 0.1, "unknown": 0.1 }
                    },
                    "budget_sensitive": { "type": "noul", "noul": 0.5 },
                    "prefers_direct": { "type": "noul", "noul": 0.5 }
                },
                "usage": "non-object-string"
            })
            .to_string(),
        })
    });

    let adapter_malformed = JevInferAdapter::new(JevOptions {
        api_key: "test-key".to_string(),
        model: None,
        chat_snapshot: false,
        chat_history: false,
        endpoint: None,
        transport: Some(Arc::new(transport_malformed)),
        on_usage: None,
    })
    .unwrap();

    let mut runtime2 = BeliefRuntime::new(
        bel_runtime::ToolRegistry::new(),
        RuntimeOptions {
            infer_beliefs: Some(Arc::new(adapter_malformed)),
            ..Default::default()
        },
    );

    runtime2
        .assign(
            "message",
            &ValueExpression::String {
                value: "flight".to_string(),
            },
        )
        .await
        .unwrap();

    let res2 = runtime2
        .infer(&ValueExpression::Identifier {
            name: "message".to_string(),
        })
        .await;

    assert!(res2.is_err());
    assert_eq!(res2.err().unwrap(), "invalid Jev object at usage");

    // 3. Malformed token counts in usage
    let transport_invalid_tokens = MockTransport::new(|_url, _headers, _body| {
        Ok(HttpResponse {
            status: 200,
            body: json!({
                "answers": {
                    "intent": {
                        "type": "choice",
                        "probabilities": { "book_flight": 0.8, "book_hotel": 0.1, "unknown": 0.1 }
                    },
                    "budget_sensitive": { "type": "noul", "noul": 0.5 },
                    "prefers_direct": { "type": "noul", "noul": 0.5 }
                },
                "usage": { "input_tokens": "invalid-str", "output_tokens": 10 }
            })
            .to_string(),
        })
    });

    let adapter_invalid_tokens = JevInferAdapter::new(JevOptions {
        api_key: "test-key".to_string(),
        model: None,
        chat_snapshot: false,
        chat_history: false,
        endpoint: None,
        transport: Some(Arc::new(transport_invalid_tokens)),
        on_usage: None,
    })
    .unwrap();

    let mut runtime3 = BeliefRuntime::new(
        bel_runtime::ToolRegistry::new(),
        RuntimeOptions {
            infer_beliefs: Some(Arc::new(adapter_invalid_tokens)),
            ..Default::default()
        },
    );

    runtime3
        .assign(
            "message",
            &ValueExpression::String {
                value: "flight".to_string(),
            },
        )
        .await
        .unwrap();

    let res3 = runtime3
        .infer(&ValueExpression::Identifier {
            name: "message".to_string(),
        })
        .await;

    assert!(res3.is_err());
    assert_eq!(
        res3.err().unwrap(),
        "invalid Jev token count at usage.input_tokens"
    );
}

#[tokio::test]
async fn openai_structured_response_feeds_beliefs_and_reports_token_usage() {
    let input_tokens = Arc::new(AtomicU64::new(0));
    let output_tokens = Arc::new(AtomicU64::new(0));
    let in_clone = input_tokens.clone();
    let out_clone = output_tokens.clone();

    let transport = MockTransport::new(|_url, headers, body| {
        assert_eq!(
            headers.get("Authorization"),
            Some(&"Bearer test-key".to_string())
        );
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.get("model"), Some(&json!("gpt-6-luna")));
        assert_eq!(parsed.get("input"), Some(&json!("cheap direct flight")));

        let final_text = json!({
            "intent": { "book_flight": 0.8, "book_hotel": 0.1, "unknown": 0.1 },
            "budget_sensitive": 0.9,
            "prefers_direct": 0.85
        })
        .to_string();

        Ok(HttpResponse {
            status: 200,
            body: json!({
                "status": "completed",
                "output": [
                    { "type": "reasoning" },
                    {
                        "type": "message",
                        "content": [{ "type": "output_text", "text": final_text }]
                    }
                ],
                "usage": { "input_tokens": 140, "output_tokens": 35, "total_tokens": 175 }
            })
            .to_string(),
        })
    });

    let adapter = OpenAIInferAdapter::new(OpenAIOptions {
        api_key: "test-key".to_string(),
        model: None,
        instructions: None,
        transport: Some(Arc::new(transport)),
        on_usage: Some(Arc::new(move |usage| {
            in_clone.store(usage.input_tokens, Ordering::SeqCst);
            out_clone.store(usage.output_tokens, Ordering::SeqCst);
        })),
        on_response_id: None,
        on_compaction_items: None,
        store: None,
        previous_response_id: None,
        compact_threshold: None,
        belief_fields: None,
        request_timeout_ms: None,
    })
    .unwrap();

    let options = RuntimeOptions {
        infer_beliefs: Some(Arc::new(adapter)),
        ..Default::default()
    };

    let mut runtime = BeliefRuntime::new(bel_runtime::ToolRegistry::new(), options);

    runtime
        .assign(
            "message",
            &ValueExpression::String {
                value: "cheap direct flight".to_string(),
            },
        )
        .await
        .unwrap();

    runtime
        .infer(&ValueExpression::Identifier {
            name: "message".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(runtime.confidence("intent.book_flight"), 0.8);
    assert_eq!(runtime.confidence("user.budget_sensitive"), 0.9);
    assert_eq!(runtime.confidence("user.prefers_direct"), 0.85);

    assert_eq!(input_tokens.load(Ordering::SeqCst), 140);
    assert_eq!(output_tokens.load(Ordering::SeqCst), 35);
}

#[tokio::test]
async fn openai_parses_only_final_answer_and_charges_commentary() {
    let final_json = json!({
        "intent": { "book_flight": 1.0, "book_hotel": 0.0, "unknown": 0.0 },
        "budget_sensitive": 1.0,
        "prefers_direct": 0.0
    });
    let final_text = final_json.to_string();

    let transport = MockTransport::new(move |_url, _headers, _body| {
        Ok(HttpResponse {
            status: 200,
            body: json!({
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "phase": "commentary",
                        "content": [{ "type": "output_text", "text": format!("{final_text} intermediate commentary.") }]
                    },
                    {
                        "type": "message",
                        "phase": "final_answer",
                        "content": [{ "type": "output_text", "text": final_text }]
                    }
                ],
                "usage": { "input_tokens": 468, "output_tokens": 81 }
            })
            .to_string(),
        })
    });

    let adapter = OpenAIInferAdapter::new(OpenAIOptions {
        api_key: "test-key".to_string(),
        model: None,
        instructions: None,
        transport: Some(Arc::new(transport)),
        on_usage: None,
        on_response_id: None,
        on_compaction_items: None,
        store: None,
        previous_response_id: None,
        compact_threshold: None,
        belief_fields: None,
        request_timeout_ms: None,
    })
    .unwrap();

    let options = RuntimeOptions {
        infer_beliefs: Some(Arc::new(adapter)),
        ..Default::default()
    };

    let mut runtime = BeliefRuntime::new(bel_runtime::ToolRegistry::new(), options);

    runtime
        .assign(
            "message",
            &ValueExpression::String {
                value: "continue task".to_string(),
            },
        )
        .await
        .unwrap();

    runtime
        .infer(&ValueExpression::Identifier {
            name: "message".to_string(),
        })
        .await
        .unwrap();

    assert_eq!(runtime.confidence("intent.book_flight"), 1.0);
}
