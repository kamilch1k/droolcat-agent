//! Droolcat bridge — "Claude Code with visual nodes".
//!
//! A session is ONE continuous Claude Code conversation. Each turn spawns
//! `claude -p --output-format stream-json --verbose` (resuming the same Claude
//! session with `--resume <id>` so context carries across turns), streams its
//! events to the webview, and tees the transcript to disk. The frontend turns
//! that stream into a growing graph of turns.
//!
//! Events emitted to the webview:
//!   claude-event  -> one parsed stream-json object (verbatim)
//!   claude-stderr -> a non-JSON / stderr line
//!   claude-end    -> { ok } when the turn's process exits

mod codegraph;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The live claude process for each session (for stop_session). One turn runs
/// at a time per session, so a single child per session id is enough.
#[derive(Default)]
struct AppState {
    procs: Mutex<HashMap<String, Child>>,
}

fn find_claude() -> String {
    #[cfg(windows)]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            let exe = format!("{home}\\.local\\bin\\claude.exe");
            if Path::new(&exe).exists() {
                return exe;
            }
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            for shim in ["npm\\claude.cmd", "npm\\claude.ps1"] {
                let p = format!("{appdata}\\{shim}");
                if Path::new(&p).exists() {
                    return p;
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            let p = format!("{home}/.local/bin/claude");
            if Path::new(&p).exists() {
                return p;
            }
        }
        for p in ["/usr/local/bin/claude", "/opt/homebrew/bin/claude", "/usr/bin/claude"] {
            if Path::new(p).exists() {
                return p.to_string();
            }
        }
    }
    "claude".to_string()
}

fn shell_wrap(bin: &str) -> (String, Vec<String>) {
    let needs_shell = cfg!(windows) && (bin.ends_with(".cmd") || bin.ends_with(".ps1") || bin.ends_with(".bat"));
    if needs_shell {
        ("cmd".to_string(), vec!["/C".to_string(), bin.to_string()])
    } else {
        (bin.to_string(), vec![])
    }
}

fn millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn turn_log_path(session_id: &str) -> PathBuf {
    let dir = std::env::current_dir().unwrap_or_default().join("sessions");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("{session_id}-{}.jsonl", millis()))
}

/// Spawn one turn of a Claude Code conversation and stream its events.
fn run_claude(app: AppHandle, session_id: String, prompt: String, cwd: String, resume: Option<String>, edits: bool) -> Result<(), String> {
    let bin = find_claude();
    let (program, pre) = shell_wrap(&bin);
    let mut cmd = Command::new(&program);
    for a in &pre {
        cmd.arg(a);
    }
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        // stream token-by-token so text/nodes grow live instead of popping in
        .arg("--include-partial-messages")
        // Interactive-only tools can't work in a headless -p turn (there's no UI
        // to answer) and would surface as an error node. Deny them so the agent
        // proceeds autonomously with a sensible default instead.
        .arg("--disallowedTools")
        .arg("AskUserQuestion");
    if edits {
        // bypass ALL permission prompts so the agent just does the work in the
        // chat's folder (no approval friction). On by default; the chat's
        // toggle can turn it off for a read-only session.
        cmd.arg("--permission-mode").arg("bypassPermissions");
    }
    if let Some(r) = resume.filter(|s| !s.trim().is_empty()) {
        cmd.arg("--resume").arg(r);
    }
    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn claude ({bin}): {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout from claude")?;
    let stderr = child.stderr.take().ok_or("no stderr from claude")?;
    {
        let st = app.state::<AppState>();
        st.procs.lock().unwrap().insert(session_id.clone(), child);
    }

    {
        let app_err = app.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    let _ = app_err.emit("claude-stderr", line);
                }
            }
        });
    }

    let app_out = app.clone();
    let log_path = turn_log_path(&session_id);
    thread::spawn(move || {
        let mut log = std::fs::File::create(&log_path).ok();
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            if let Some(f) = log.as_mut() {
                let _ = writeln!(f, "{line}");
            }
            match serde_json::from_str::<serde_json::Value>(&line) {
                Ok(v) => { let _ = app_out.emit("claude-event", v); }
                Err(_) => { let _ = app_out.emit("claude-stderr", line); }
            }
        }
        let ok = {
            let st = app_out.state::<AppState>();
            let child = st.procs.lock().unwrap().remove(&session_id);
            match child {
                Some(mut c) => c.wait().map(|s| s.success()).unwrap_or(false),
                None => false, // removed by stop_session
            }
        };
        let _ = app_out.emit("claude-end", serde_json::json!({ "ok": ok }));
    });

    Ok(())
}

/// Run one turn of a session. Pass the same session_id across turns; pass the
/// Claude session id as `resume` (captured from the first turn's system event)
/// so the conversation stays coherent.
#[tauri::command]
fn start_session(
    app: AppHandle,
    session_id: Option<String>,
    prompt: String,
    cwd: Option<String>,
    resume: Option<String>,
    edits: Option<bool>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("empty prompt".into());
    }
    let sid = session_id.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("s-{}", millis()));
    let workdir = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());
    run_claude(app, sid.clone(), prompt, workdir, resume, edits.unwrap_or(false))?;
    Ok(sid)
}

/// Interrupt the running turn of a session.
#[tauri::command]
fn stop_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let st = app.state::<AppState>();
    if let Some(c) = st.procs.lock().unwrap().get_mut(&session_id) {
        let _ = c.kill();
    }
    Ok(())
}

/// Code Graph: scan a repo into a file/import dependency graph.
#[tauri::command]
fn scan_code_graph(cwd: String) -> Result<codegraph::CodeGraph, String> {
    if cwd.trim().is_empty() {
        return Err("no path".into());
    }
    Ok(codegraph::scan(&cwd))
}

#[tauri::command]
fn claude_path() -> String {
    find_claude()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_session,
            stop_session,
            scan_code_graph,
            claude_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
