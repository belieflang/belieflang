use std::process::Command;

#[test]
fn cli_runs_intent_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/intent.bel", "--trace"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("[state]"));
    assert!(stdout.contains("intent [exclusive/closed]: book_flight=0.820"));
    assert!(stdout.contains("[vars]"));
    assert!(stdout.contains("[tool] rank_flights()"));
    assert!(stdout.contains("[ask_user] I found flight options."));
}

#[test]
fn cli_runs_intent_no_flight_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/intent_no_flight.bel", "--trace"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("[state]"));
    assert!(stdout.contains("other=0.150"));
    assert!(stdout.contains("[ask_user] What exactly do you want to book?"));
}

#[test]
fn cli_runs_observe_infer_merge_example() {
    let output = Command::new(env!("CARGO_BIN_EXE_bel"))
        .args(["run", "examples/observe_infer_merge.bel", "--trace"])
        .current_dir("../../")
        .output()
        .expect("Failed to execute bel");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("[observations]"));
    assert!(stdout.contains("1 user_message: \"I need a cheap direct flight to Berlin\""));
    assert!(stdout.contains("[tool] rank_flights()"));
}

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
