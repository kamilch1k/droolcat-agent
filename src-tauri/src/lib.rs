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
fn run_claude(app: AppHandle, session_id: String, prompt: String, cwd: String, resume: Option<String>, edits: bool, append_system: Option<String>, model: Option<String>) -> Result<(), String> {
    // make sure the working folder exists — otherwise current_dir() makes spawn
    // fail outright (which surfaced as an opaque "session ended")
    if !cwd.trim().is_empty() && !Path::new(&cwd).is_dir() {
        std::fs::create_dir_all(&cwd).map_err(|e| format!("can't use folder '{cwd}': {e}"))?;
    }
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
    // Board Helper turns get an extra system instruction so the model knows it is
    // the board organizer and how to emit board actions.
    if let Some(sys) = append_system.filter(|s| !s.trim().is_empty()) {
        cmd.arg("--append-system-prompt").arg(sys);
    }
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        cmd.arg("--model").arg(m);
    }
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
    append_system: Option<String>,
    model: Option<String>,
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
    run_claude(app, sid.clone(), prompt, workdir, resume, edits.unwrap_or(false), append_system, model)?;
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

// ---- observe real Claude Code sessions (~/.claude/projects/*/*.jsonl) -----

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CcSession {
    id: String,
    file: String,
    cwd: String,
    title: String,
    project: String,
    mtime_ms: u64,
    size: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TailOut {
    lines: Vec<String>,
    offset: u64,
}

fn claude_projects_dir() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").ok().or_else(|| std::env::var("HOME").ok())?;
    let p = Path::new(&home).join(".claude").join("projects");
    if p.is_dir() { Some(p) } else { None }
}

// cheap JSON-string extractor: value of "key":"..." with basic unescaping
fn json_str(line: &str, key: &str) -> Option<String> {
    let i = line.find(key)? + key.len();
    let mut out = String::new();
    let mut chars = line[i..].chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => { if let Some(n) = chars.next() { out.push(match n { 'n' => '\n', 't' => '\t', '"' => '"', '\\' => '\\', '/' => '/', o => o }); } }
            '"' => break,
            _ => out.push(c),
        }
    }
    Some(out)
}

// read the head of a transcript to derive a title + working dir. Reads at most
// 256 KB so a single multi-MB tool-result line can never blow up memory.
fn head_meta(path: &Path) -> (String, String) {
    use std::io::Read;
    let f = match std::fs::File::open(path) { Ok(f) => f, Err(_) => return (String::new(), String::new()) };
    let mut buf = Vec::new();
    let _ = f.take(256 * 1024).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let (mut title, mut first_user, mut cwd) = (String::new(), String::new(), String::new());
    for line in text.split('\n').take(80) {
        if cwd.is_empty() { if let Some(c) = json_str(line, "\"cwd\":\"") { cwd = c; } }
        if title.is_empty() { if let Some(t) = json_str(line, "\"aiTitle\":\"") { title = t; } }
        if first_user.is_empty()
            && line.contains("\"type\":\"user\"")
            && line.contains("\"role\":\"user\"")
            && !line.contains("tool_result")
        {
            // string content ("content":"…") or array content ([{ "text":"…" }])
            let got = json_str(line, "\"content\":\"").or_else(|| json_str(line, "\"text\":\""));
            if let Some(c) = got { first_user = c.chars().take(90).collect(); }
        }
        if !cwd.is_empty() && !title.is_empty() { break; } // best title found
    }
    let t = if !title.is_empty() { title } else if !first_user.is_empty() { first_user } else { "session".into() };
    (t.trim().to_string(), cwd)
}

/// List the user's recent Claude Code sessions (newest first).
#[tauri::command]
fn list_claude_sessions(limit: Option<usize>) -> Result<Vec<CcSession>, String> {
    let dir = match claude_projects_dir() { Some(d) => d, None => return Ok(vec![]) };
    let mut files: Vec<(PathBuf, u64, u64)> = vec![];
    for proj in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let pp = proj.path();
        if !pp.is_dir() { continue; }
        for f in std::fs::read_dir(&pp).map_err(|e| e.to_string())?.flatten() {
            let fp = f.path();
            if fp.extension().map(|e| e == "jsonl").unwrap_or(false) {
                if let Ok(md) = f.metadata() {
                    let mt = md.modified().ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64).unwrap_or(0);
                    if md.len() > 0 { files.push((fp, mt, md.len())); }
                }
            }
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(limit.unwrap_or(40));
    let mut out = vec![];
    for (path, mt, size) in files {
        let (title, cwd) = head_meta(&path);
        let id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let project = path.parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        out.push(CcSession { id, file: path.to_string_lossy().to_string(), cwd, title, project, mtime_ms: mt, size });
    }
    Ok(out)
}

/// Read only the TAIL of a transcript (last `max_lines` / `max_bytes`), plus the
/// current file size as the offset for incremental follow-up reads.
#[tauri::command]
fn read_session_tail(path: String, max_lines: Option<usize>, max_bytes: Option<u64>) -> Result<TailOut, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let mb = max_bytes.unwrap_or(700_000).min(len);
    let start = len - mb;
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.take(mb).read_to_end(&mut buf).map_err(|e| e.to_string())?; // tolerant if the file shrank
    // consume only up to the last newline so `offset` lands on a line boundary
    // (keeps the tail->since seam UTF-8-safe and re-reads a partial final line)
    let consume = buf.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
    let text = String::from_utf8_lossy(&buf[..consume]);
    let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    if start > 0 && !lines.is_empty() { lines.remove(0); } // drop the partial first line
    lines.retain(|l| !l.trim().is_empty());
    let ml = max_lines.unwrap_or(180);
    if lines.len() > ml { lines = lines.split_off(lines.len() - ml); }
    Ok(TailOut { lines, offset: start + consume as u64 })
}

/// Read newly-appended lines since a byte offset (for live tailing). Only
/// consumes up to the last newline so a partially-written line isn't returned;
/// `offset` always sits on a newline so decoding never starts mid-codepoint.
#[tauri::command]
fn read_session_since(path: String, offset: u64) -> Result<TailOut, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len <= offset { return Ok(TailOut { lines: vec![], offset: len }); }
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.take(len - offset).read_to_end(&mut buf).map_err(|e| e.to_string())?; // tolerant of a racing shrink
    let consume = match buf.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => return Ok(TailOut { lines: vec![], offset }),
    };
    let text = String::from_utf8_lossy(&buf[..consume]);
    let lines: Vec<String> = text.split('\n').map(|s| s.to_string()).filter(|l| !l.trim().is_empty()).collect();
    Ok(TailOut { lines, offset: offset + consume as u64 })
}

#[tauri::command]
fn claude_path() -> String {
    find_claude()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    short: String,
    parents: usize,
    refs: String,
    author: String,
    when: String,
    subject: String,
}

/// Read the recent git history of a folder for the git-tree panel. Async +
/// spawn_blocking so the blocking `git log` never stalls the UI thread.
#[tauri::command]
async fn git_graph(cwd: String, limit: Option<usize>) -> Result<Vec<GitCommit>, String> {
    if cwd.trim().is_empty() || !Path::new(&cwd).is_dir() {
        return Err("no folder".into());
    }
    let n = limit.unwrap_or(60);
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<GitCommit>, String> {
        let fmt = "%H\x1f%h\x1f%P\x1f%D\x1f%an\x1f%cr\x1f%s";
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&cwd).arg("log")
            .arg(format!("--max-count={n}"))
            .arg(format!("--pretty=format:{fmt}"));
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let output = cmd.output().map_err(|e| format!("git not available: {e}"))?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            if err.contains("does not have any commits yet") { return Ok(Vec::new()); } // fresh repo
            return Err(if err.trim().is_empty() { "not a git repository".into() } else { err.trim().to_string() });
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut out = Vec::new();
        for line in text.lines() {
            // splitn(7) keeps any stray 0x1F in the subject attached instead of dropping it
            let f: Vec<&str> = line.splitn(7, '\u{1f}').collect();
            if f.len() < 7 { continue; }
            out.push(GitCommit {
                hash: f[0].to_string(),
                short: f[1].to_string(),
                parents: f[2].split_whitespace().filter(|s| !s.is_empty()).count(),
                refs: f[3].to_string(),
                author: f[4].to_string(),
                when: f[5].to_string(),
                subject: f[6].to_string(),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("git task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_session,
            stop_session,
            scan_code_graph,
            list_claude_sessions,
            read_session_tail,
            read_session_since,
            git_graph,
            claude_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
