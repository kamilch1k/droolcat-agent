//! Droolcat bridge — the driver model.
//!
//! `start_session` spawns `claude -p --output-format stream-json --verbose`,
//! reads its newline-delimited JSON event stream, tees the raw transcript to
//! disk, and emits each parsed event to the frontend over Tauri's event bus:
//!
//!   claude-event   -> one parsed stream-json object
//!   claude-stderr  -> a non-JSON / stderr line (diagnostics)
//!   claude-end     -> { ok: bool } when the process exits
//!   claude-error   -> spawn / setup failure (returned from the command too)
//!
//! This is the load-bearing 90% the brief calls out: owning the subprocess so
//! we get the full structured stream, not a scrollback dump.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Locate the Claude Code binary, bypassing PATH (GUI apps often launch without
/// the user's shell PATH). Falls back to bare `claude` so a PATH hit still works.
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

fn session_log_path() -> PathBuf {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::current_dir().unwrap_or_default().join("sessions");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("session-{ts}.jsonl"))
}

/// Start a headless Claude Code session and stream its events to the UI.
/// Returns immediately after spawning; events arrive asynchronously.
#[tauri::command]
fn start_session(
    app: AppHandle,
    prompt: String,
    cwd: Option<String>,
    // accepted for forward-compat (per-agent steering); unused in the flat loop
    steer: Option<String>,
) -> Result<String, String> {
    let _ = steer;
    if prompt.trim().is_empty() {
        return Err("empty prompt".into());
    }

    let bin = find_claude();
    let workdir = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());

    // .cmd / .ps1 shims must run through a shell on Windows; a real .exe doesn't.
    let needs_shell = cfg!(windows) && (bin.ends_with(".cmd") || bin.ends_with(".ps1") || bin.ends_with(".bat"));
    let mut cmd = if needs_shell {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&bin);
        c
    } else {
        Command::new(&bin)
    };

    cmd.arg("-p")
        .arg(&prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .current_dir(&workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn claude ({bin}): {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout from claude")?;
    let stderr = child.stderr.take().ok_or("no stderr from claude")?;
    let log_path = session_log_path();
    let log_str = log_path.to_string_lossy().to_string();

    // stdout: parse JSON lines, tee to disk, emit events
    let app_out = app.clone();
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
                Ok(v) => {
                    let _ = app_out.emit("claude-event", v);
                }
                Err(_) => {
                    let _ = app_out.emit("claude-stderr", line);
                }
            }
        }
        let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        let _ = app_out.emit("claude-end", serde_json::json!({ "ok": ok }));
    });

    // stderr: surface diagnostics
    let app_err = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = app_err.emit("claude-stderr", line);
            }
        }
    });

    Ok(log_str)
}

/// Report the resolved Claude binary path (handy for diagnostics / the UI).
#[tauri::command]
fn claude_path() -> String {
    find_claude()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![start_session, claude_path])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
