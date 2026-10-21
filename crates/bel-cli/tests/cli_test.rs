use std::path::Path;
use std::process::Command;

#[test]
fn cli_rejects_unknown_flags_with_exit_code_2() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/intent.bel", "--unknown-flag"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("usage: bel run <file.bel>"));
}

#[test]
fn cli_rejects_missing_file_with_exit_code_1() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "nonexistent.bel"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("error:"));
}

#[test]
fn cli_reports_usage_when_requested() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/jev_intent.bel", "--usage"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("[usage] {\"input_tokens\":0,\"output_tokens\":0}"));
}

#[test]
fn cli_golden_output_intent_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/intent.bel", "--trace"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let expected = "\
[trace] call search_flights()
[state]
  intent [exclusive/closed]: book_flight=0.820, book_hotel=0.120, unknown=0.060
  user [multi/closed]: budget_sensitive=0.910, prefers_direct=0.840
[vars]
  threshold: 0.7
  flights: {\"count\":3,\"best_price\":214,\"currency\":\"EUR\"}
[trace] rule 1 when (confidence(intent.book_flight) > threshold && user.prefers_direct > 0.5) => true
[trace]   confidence(intent.book_flight)=0.820 > threshold=0.700 -> true
[trace]   user.prefers_direct=0.840 > 0.5=0.500 -> true
[trace]   and -> true
[trace] action call rank_flights()
[trace] call rank_flights()
[tool] rank_flights()
[trace] rule 2 when (flights.count > 0 || entropy(intent) > 0.6) => true
[trace]   flights.count=3 > 0=0 -> true
[trace]   or short-circuit -> true
[trace] action ask_user(\"I found flight options.\")
[ask_user] I found flight options.
";
    assert_eq!(stdout, expected);
}

#[test]
fn cli_golden_output_intent_no_flight_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/intent_no_flight.bel", "--trace"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let expected = "\
[state]
  intent [exclusive/open]: book_flight=0.280, book_hotel=0.570, other=0.150
  user [multi/closed]: budget_sensitive=0.910, prefers_direct=0.840
[trace] rule 1 when (confidence(intent.book_flight) > 0.7 && user.prefers_direct > 0.6) => false
[trace]   confidence(intent.book_flight)=0.280 > 0.7=0.700 -> false
[trace]   and short-circuit -> false
[trace] rule 2 when (entropy(intent) > 0.4 || confidence(intent.other) > 0.1) => true
[trace]   entropy(intent)=0.875 > 0.4=0.400 -> true
[trace]   or short-circuit -> true
[trace] action ask_user(\"What exactly do you want to book?\")
[ask_user] What exactly do you want to book?
";
    assert_eq!(stdout, expected);
}

#[test]
fn cli_golden_output_observe_infer_merge_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/observe_infer_merge.bel", "--trace"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let expected = "\
[trace] observe user_message=\"I need a cheap direct flight to Berlin\"
[trace] infer beliefs from user_message
[trace] call extract_patch()
[trace] merge beliefs from extracted
[state]
  intent [exclusive/closed]: book_flight=0.920, book_hotel=0.080
  user [multi/closed]: budget_sensitive=0.860, prefers_direct=0.880
[vars]
  message: \"I need a cheap direct flight to Berlin\"
  user_message: \"I need a cheap direct flight to Berlin\"
  extracted: {\"intent\":{\"cardinality\":\"exclusive\",\"domain\":\"closed\",\"values\":{\"book_flight\":0.92,\"book_hotel\":0.08}},\"user\":{\"cardinality\":\"multi\",\"domain\":\"closed\",\"values\":{\"budget_sensitive\":0.86,\"prefers_direct\":0.88}}}
[observations]
  1 user_message: \"I need a cheap direct flight to Berlin\"
[trace] rule 1 when (confidence(intent.book_flight) > 0.7 && confidence(user.budget_sensitive) > 0.5) => true
[trace]   confidence(intent.book_flight)=0.920 > 0.7=0.700 -> true
[trace]   confidence(user.budget_sensitive)=0.860 > 0.5=0.500 -> true
[trace]   and -> true
[trace] action call rank_flights()
[trace] call rank_flights()
[tool] rank_flights()
[trace] rule 2 when entropy(intent) > 0.5 => false
[trace]   entropy(intent)=0.402 > 0.5=0.500 -> false
";
    assert_eq!(stdout, expected);
}

#[test]
fn cli_golden_output_jev_intent_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/jev_intent.bel", "--trace"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let expected = "\
[trace] observe user_message=\"I need a cheap direct flight to Berlin\"
[trace] infer beliefs from user_message
[state]
  intent [exclusive/closed]: book_flight=1.000
  user [multi/closed]: budget_sensitive=0.900, prefers_direct=0.850
[vars]
  message: \"I need a cheap direct flight to Berlin\"
  user_message: \"I need a cheap direct flight to Berlin\"
[observations]
  1 user_message: \"I need a cheap direct flight to Berlin\"
[trace] rule 1 when (confidence(intent.book_flight) > 0.7 && confidence(user.budget_sensitive) > 0.5) => true
[trace]   confidence(intent.book_flight)=1 > 0.7=0.700 -> true
[trace]   confidence(user.budget_sensitive)=0.900 > 0.5=0.500 -> true
[trace]   and -> true
[trace] action call rank_flights()
[trace] call rank_flights()
[tool] rank_flights()
[trace] rule 2 when entropy(intent) > 0.5 => false
[trace]   entropy(intent)=0 > 0.5=0.500 -> false
";
    assert_eq!(stdout, expected);
}

#[test]
fn cli_golden_output_chatgpt_hotel_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/chatgpt_hotel.bel", "--trace"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let expected = "\
[trace] observe user_message=\"Find an inexpensive hotel near the station\"
[trace] infer beliefs from user_message
[state]
  intent [exclusive/closed]: book_hotel=1.000
[vars]
  message: \"Find an inexpensive hotel near the station\"
  user_message: \"Find an inexpensive hotel near the station\"
[observations]
  1 user_message: \"Find an inexpensive hotel near the station\"
[trace] rule 1 when (confidence(intent.book_hotel) > 0.7 && confidence(user.budget_sensitive) > 0.5) => false
[trace]   confidence(intent.book_hotel)=1 > 0.7=0.700 -> true
[trace]   confidence(user.budget_sensitive)=0 > 0.5=0.500 -> false
[trace]   and -> false
[trace] rule 2 when entropy(intent) > 0.5 => false
[trace]   entropy(intent)=0 > 0.5=0.500 -> false
";
    assert_eq!(stdout, expected);
}

#[test]
fn cli_golden_output_chatgpt_unknown_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/chatgpt_unknown.bel", "--trace"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let expected = "\
[trace] observe user_message=\"What time does the train leave?\"
[trace] infer beliefs from user_message
[state]
  intent [exclusive/closed]: unknown=1.000
[vars]
  message: \"What time does the train leave?\"
  user_message: \"What time does the train leave?\"
[observations]
  1 user_message: \"What time does the train leave?\"
[trace] rule 1 when confidence(intent.unknown) > 0.6 => true
[trace]   confidence(intent.unknown)=1 > 0.6=0.600 -> true
[trace] action ask_user(\"I can help with flights or hotels. Which do you need?\")
[ask_user] I can help with flights or hotels. Which do you need?
";
    assert_eq!(stdout, expected);
}

#[test]
fn cli_differential_parity_with_typescript_when_available() {
    let ts_cli = Path::new("../../dist/src/cli.js");
    if !ts_cli.exists() {
        return;
    }

    let examples = [
        "examples/intent.bel",
        "examples/intent_no_flight.bel",
        "examples/observe_infer_merge.bel",
        "examples/jev_intent.bel",
        "examples/chatgpt_hotel.bel",
        "examples/chatgpt_unknown.bel",
    ];

    for example in examples {
        let ts_output = Command::new("node")
            .args(["dist/src/cli.js", "run", example, "--trace"])
            .current_dir("../../")
            .output();

        let Ok(ts_output) = ts_output else {
            return;
        };

        let rust_output = Command::new(env!("CARGO_BIN_EXE_bel"))
            .args(["run", example, "--trace"])
            .current_dir("../../")
            .output()
            .expect("Failed to execute bel");

        assert_eq!(rust_output.status.code(), ts_output.status.code());
        assert_eq!(
            String::from_utf8_lossy(&rust_output.stdout),
            String::from_utf8_lossy(&ts_output.stdout),
            "Line-for-line output mismatch on {example}"
        );
    }
}
