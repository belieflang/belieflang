use bel_providers::jev::{JevInferAdapter, JevOptions, JevUsage};
use bel_providers::openai::{OpenAIInferAdapter, OpenAIOptions, OpenAIUsage};
use bel_runtime::runtime::{BeliefRuntime, RuntimeOptions};
use bel_syntax::parser::parse;
use serde_json::json;
use std::env;
use std::fs;
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const USAGE_TEXT: &str =
    "usage: bel run <file.bel> [--trace] [--engine heuristic|jev|chatgpt] [--usage]";

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();

    // args[0] is binary name (bel)
    if args.len() < 2 {
        eprintln!("{USAGE_TEXT}");
        return ExitCode::from(2);
    }

    let command = &args[1];
    if command != "run" {
        eprintln!("{USAGE_TEXT}");
        return ExitCode::from(2);
    }

    let rest = &args[2..];
    let mut engine = "heuristic".to_string();
    let mut trace = false;
    let mut show_usage = false;
    let mut file_path: Option<String> = None;

    let mut i = 0;
    while i < rest.len() {
        let arg = &rest[i];
        if arg == "--engine" {
            if i + 1 >= rest.len() {
                eprintln!("{USAGE_TEXT}");
                return ExitCode::from(2);
            }
            engine = rest[i + 1].clone();
            i += 2;
            continue;
        } else if arg == "--trace" {
            trace = true;
            i += 1;
            continue;
        } else if arg == "--usage" {
            show_usage = true;
            i += 1;
            continue;
        } else if arg.starts_with("--") {
            eprintln!("{USAGE_TEXT}");
            return ExitCode::from(2);
        } else if file_path.is_none() {
            file_path = Some(arg.clone());
            i += 1;
            continue;
        } else {
            // More than one positional argument
            eprintln!("{USAGE_TEXT}");
            return ExitCode::from(2);
        }
    }

    if engine != "heuristic" && engine != "jev" && engine != "chatgpt" {
        eprintln!("{USAGE_TEXT}");
        return ExitCode::from(2);
    }

    let path = match file_path {
        Some(p) => p,
        None => {
            eprintln!("{USAGE_TEXT}");
            return ExitCode::from(2);
        }
    };

    let input_tokens = Arc::new(AtomicU64::new(0));
    let output_tokens = Arc::new(AtomicU64::new(0));
    let in_clone = input_tokens.clone();
    let out_clone = output_tokens.clone();

    let infer_adapter: Option<Arc<dyn bel_runtime::runtime::InferBeliefsAdapter>> =
        match engine.as_str() {
            "jev" => {
                let api_key = env::var("TYPESAFE_API_KEY").unwrap_or_default();
                let model = env::var("JEV_MODEL").ok();
                let options = JevOptions {
                    api_key,
                    model,
                    chat_snapshot: false,
                    chat_history: false,
                    endpoint: None,
                    transport: None,
                    on_usage: Some(Arc::new(move |usage: JevUsage| {
                        in_clone.fetch_add(usage.input_tokens, Ordering::SeqCst);
                        out_clone.fetch_add(usage.output_tokens, Ordering::SeqCst);
                    })),
                };
                match JevInferAdapter::new(options) {
                    Ok(adapter) => Some(Arc::new(adapter)),
                    Err(e) => {
                        eprintln!("error: {e}");
                        return ExitCode::from(1);
                    }
                }
            }
            "chatgpt" => {
                let api_key = env::var("OPENAI_API_KEY").unwrap_or_default();
                let model = env::var("OPENAI_MODEL").ok();
                let options = OpenAIOptions {
                    api_key,
                    model,
                    instructions: None,
                    transport: None,
                    on_usage: Some(Arc::new(move |usage: OpenAIUsage| {
                        in_clone.fetch_add(usage.input_tokens, Ordering::SeqCst);
                        out_clone.fetch_add(usage.output_tokens, Ordering::SeqCst);
                    })),
                    on_response_id: None,
                    on_compaction_items: None,
                    store: None,
                    previous_response_id: None,
                    compact_threshold: None,
                    belief_fields: None,
                    request_timeout_ms: None,
                };
                match OpenAIInferAdapter::new(options) {
                    Ok(adapter) => Some(Arc::new(adapter)),
                    Err(e) => {
                        eprintln!("error: {e}");
                        return ExitCode::from(1);
                    }
                }
            }
            _ => None,
        };

    let source = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(1);
        }
    };

    let statements = match parse(&source) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return ExitCode::from(1);
        }
    };

    let mut runtime = BeliefRuntime::new(
        bel_runtime::ToolRegistry::new(),
        RuntimeOptions {
            trace,
            infer_beliefs: infer_adapter,
            now: None,
            memory: None,
        },
    );

    if let Err(e) = runtime.run(&statements).await {
        eprintln!("error: {e}");
        return ExitCode::from(1);
    }

    if show_usage {
        let usage_json = json!({
            "input_tokens": input_tokens.load(Ordering::SeqCst),
            "output_tokens": output_tokens.load(Ordering::SeqCst)
        });
        println!("[usage] {usage_json}");
    }

    ExitCode::from(0)
}
