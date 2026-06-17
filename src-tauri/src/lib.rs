//! Droolcat bridge — the driver model (Milestone 2: parallel agents in worktrees).
//!
//! Every coding session is one or more LANES. A lane is its own driven
//! `claude -p --output-format stream-json --verbose` subprocess. The flat
//! single-session loop is the N=1 case (lane "main", run in place). Milestone 2
//! fans out into N lanes, each isolated in its own git worktree off a frozen
//! base, all funneling into one result, then a human-gated merge-back.
//!
//! Wire protocol (Rust -> webview, all enveloped so the flat path rides it too):
//!   orchestration-start { sessionId, base, baseBranch, isGit, lanes:[LaneInfo] }
//!   claude-event        { agentId, wt, seq, evt }      (evt = raw stream-json)
//!   claude-stderr       { agentId, line }
//!   claude-end          { agentId, ok, commit? }
//!   orchestration-end   { sessionId, ok }
//!   merge-result        MergeReport

mod worktree;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use worktree::*;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Live lane subprocesses, keyed by session id. Backs stop_all + cleanup gating.
#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<String, Vec<LaneProc>>>,
}
struct LaneProc {
    agent_id: String,
    child: Child,
}

// ---- claude binary resolution (bypasses PATH for GUI launches) -----------

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

/// (program, leading-args) — .cmd/.ps1 shims run via cmd.exe; a real .exe direct.
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
fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() > n {
        s.chars().take(n.saturating_sub(1)).collect::<String>() + "…"
    } else {
        s.to_string()
    }
}
fn lane_log_path(session_id: &str, agent_id: &str) -> PathBuf {
    let sid8: String = session_id.chars().take(8).collect();
    let dir = std::env::current_dir().unwrap_or_default().join("sessions");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("session-{sid8}-{agent_id}.jsonl"))
}

// ---- the lane spawner (shared by flat + orchestrated paths) ---------------

#[allow(clippy::too_many_arguments)]
fn spawn_lane(
    app: AppHandle,
    session_id: String,
    agent_id: String,
    wt: String,
    cwd: String,
    prompt: String,
    autonomous: bool,
    opts: SessionOpts,
    is_worktree: bool,
    remaining: Arc<AtomicUsize>,
) -> Result<(), String> {
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
        .arg("--verbose");

    if autonomous {
        let mode = if opts.yolo.unwrap_or(false) { "bypassPermissions" } else { "acceptEdits" };
        cmd.arg("--permission-mode").arg(mode);
        cmd.arg("--allowedTools")
            .arg("Read Edit MultiEdit Write Grep Glob LS Bash(git *) Bash(npm *) Bash(node *) Bash(cargo *) Bash(python *) Bash(pytest*)");
        cmd.arg("--disallowedTools")
            .arg("Bash(rm *) Bash(git push*) Bash(git reset*) Bash(curl*) Bash(wget*)");
        cmd.arg("--add-dir").arg(&cwd);
        if let Some(b) = opts.budget_usd {
            cmd.arg("--max-budget-usd").arg(format!("{b}"));
        }
    }

    cmd.current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn claude ({bin}) for lane {agent_id}: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout from claude")?;
    let stderr = child.stderr.take().ok_or("no stderr from claude")?;

    // register the live child for stop_all / cleanup gating
    {
        let st = app.state::<AppState>();
        st.sessions
            .lock()
            .unwrap()
            .entry(session_id.clone())
            .or_default()
            .push(LaneProc { agent_id: agent_id.clone(), child });
    }

    // stderr -> per-lane diagnostics
    {
        let app_err = app.clone();
        let aid = agent_id.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                if !line.trim().is_empty() {
                    let _ = app_err.emit("claude-stderr", serde_json::json!({ "agentId": aid, "line": line }));
                }
            }
        });
    }

    // stdout -> enveloped events; on EOF: wait, commit, end, maybe orchestration-end
    let app_out = app.clone();
    let log_path = lane_log_path(&session_id, &agent_id);
    thread::spawn(move || {
        let mut log = std::fs::File::create(&log_path).ok();
        let mut seq: u64 = 0;
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
                    let _ = app_out.emit(
                        "claude-event",
                        serde_json::json!({ "agentId": agent_id, "wt": wt, "seq": seq, "evt": v }),
                    );
                    seq += 1;
                }
                Err(_) => {
                    let _ = app_out.emit("claude-stderr", serde_json::json!({ "agentId": agent_id, "line": line }));
                }
            }
        }

        // take our child back out of state and wait for the real exit status
        let ok = {
            let st = app_out.state::<AppState>();
            let mut map = st.sessions.lock().unwrap();
            let child_opt = map.get_mut(&session_id).and_then(|v| {
                v.iter().position(|p| p.agent_id == agent_id).map(|i| v.remove(i).child)
            });
            drop(map);
            match child_opt {
                Some(mut c) => c.wait().map(|s| s.success()).unwrap_or(false),
                None => false,
            }
        };

        // auto-commit the lane's work (worktree lanes only)
        let commit = if is_worktree {
            commit_lane(&cwd, &format!("droolcat lane {agent_id}"))
        } else {
            None
        };

        let _ = app_out.emit(
            "claude-end",
            serde_json::json!({ "agentId": agent_id, "ok": ok, "commit": commit }),
        );

        if remaining.fetch_sub(1, Ordering::SeqCst) == 1 {
            let _ = app_out.emit("orchestration-end", serde_json::json!({ "sessionId": session_id, "ok": true }));
        }
    });

    Ok(())
}

// ---- commands ------------------------------------------------------------

/// Flat single-session loop (also the sample path). N=1 lane "main", in place.
#[tauri::command]
fn start_session(app: AppHandle, prompt: String, cwd: Option<String>, steer: Option<String>) -> Result<String, String> {
    let _ = steer;
    if prompt.trim().is_empty() {
        return Err("empty prompt".into());
    }
    let workdir = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".into());

    let session_id = format!("flat-{}", millis());
    let info = OrchestrationInfo {
        session_id: session_id.clone(),
        base: String::new(),
        base_branch: String::new(),
        is_git: false,
        lanes: vec![LaneInfo {
            agent_id: "main".into(),
            title: truncate(&prompt, 40),
            wt: "main".into(),
            branch: String::new(),
            wt_dir: workdir.clone(),
        }],
    };
    app.emit("orchestration-start", &info).ok();

    let remaining = Arc::new(AtomicUsize::new(1));
    spawn_lane(app, session_id.clone(), "main".into(), "main".into(), workdir, prompt, false, SessionOpts::default(), false, remaining)?;
    Ok(session_id)
}

/// Opt-in auto-planner: split a prompt into 1-4 file-disjoint lanes (read-only,
/// Haiku). Falls back to a single lane on any failure — never throws.
#[tauri::command]
fn plan_lanes(cwd: String, prompt: String, model: Option<String>) -> Result<Plan, String> {
    let is_g = is_git(&cwd);
    let (base, base_branch) = if is_g {
        freeze_base(&repo_toplevel(&cwd).unwrap_or_else(|_| cwd.clone())).unwrap_or((String::new(), String::new()))
    } else {
        (String::new(), String::new())
    };
    let single = |p: &str| Plan {
        is_git: is_g,
        base: base.clone(),
        base_branch: base_branch.clone(),
        parallelizable: false,
        lanes: vec![LaneSpec { key: "main".into(), title: truncate(p, 40), prompt: p.to_string() }],
    };
    if !is_g {
        return Ok(single(&prompt));
    }

    let bin = find_claude();
    let (program, pre) = shell_wrap(&bin);
    let schema = r#"{"type":"object","properties":{"parallelizable":{"type":"boolean"},"lanes":{"type":"array","items":{"type":"object","properties":{"key":{"type":"string"},"title":{"type":"string"},"prompt":{"type":"string"}},"required":["key","title","prompt"]}}},"required":["parallelizable","lanes"]}"#;
    let plan_prompt = format!(
        "Split this task into 1-4 INDEPENDENT, FILE-DISJOINT subtasks that can run in parallel git worktrees without touching the same files. If it cannot be safely parallelized, return parallelizable=false with a single lane. Each lane needs: key (short kebab slug), title (short), prompt (self-contained instructions for that subtask). Task: {prompt}"
    );
    let mdl = model.unwrap_or_else(|| "haiku".into());

    let mut cmd = Command::new(&program);
    for a in &pre {
        cmd.arg(a);
    }
    cmd.arg("-p").arg(&plan_prompt)
        .arg("--output-format").arg("json")
        .arg("--json-schema").arg(schema)
        .arg("--permission-mode").arg("plan")
        .arg("--allowedTools").arg("Read Grep Glob LS")
        .arg("--add-dir").arg(&cwd)
        .arg("--model").arg(&mdl)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let out = match cmd.output() {
        Ok(o) if o.status.success() => o,
        _ => return Ok(single(&prompt)),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let parsed: serde_json::Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(_) => return Ok(single(&prompt)),
    };
    let inner_text = parsed.get("result").and_then(|r| r.as_str()).unwrap_or("");
    let inner: serde_json::Value = match serde_json::from_str(inner_text) {
        Ok(v) => v,
        Err(_) => return Ok(single(&prompt)),
    };
    let parallelizable = inner.get("parallelizable").and_then(|b| b.as_bool()).unwrap_or(false);
    let lanes_v = inner.get("lanes").and_then(|l| l.as_array()).cloned().unwrap_or_default();
    let mut lanes: Vec<LaneSpec> = vec![];
    let mut seen = std::collections::HashSet::new();
    for lv in lanes_v.iter().take(4) {
        let mut key = sanitize_key(lv.get("key").and_then(|x| x.as_str()).unwrap_or("lane"));
        let mut n = 1;
        while seen.contains(&key) {
            key = format!("{}-{}", sanitize_key(lv.get("key").and_then(|x| x.as_str()).unwrap_or("lane")), n);
            n += 1;
        }
        seen.insert(key.clone());
        let title = lv.get("title").and_then(|x| x.as_str()).unwrap_or(&key).to_string();
        let p = lv.get("prompt").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if !p.trim().is_empty() {
            lanes.push(LaneSpec { key, title, prompt: p });
        }
    }
    if !parallelizable || lanes.len() < 2 {
        return Ok(single(&prompt));
    }
    Ok(Plan { is_git: true, base, base_branch, parallelizable: true, lanes })
}

/// Milestone 2 core: create one worktree per lane off a frozen base, then spawn
/// one driven claude per lane in parallel. Degrades to a single in-place lane
/// when cwd isn't a git repo.
#[tauri::command]
fn start_orchestration(
    app: AppHandle,
    session_id: String,
    cwd: String,
    lanes: Vec<LaneSpec>,
    opts: Option<SessionOpts>,
) -> Result<OrchestrationInfo, String> {
    let opts = opts.unwrap_or_default();
    let mut lanes = lanes;
    lanes.truncate(4);
    if lanes.is_empty() {
        return Err("no lanes provided".into());
    }
    let sid8: String = session_id.chars().take(8).collect();

    if !is_git(&cwd) {
        let l = &lanes[0];
        let info = OrchestrationInfo {
            session_id: session_id.clone(),
            base: String::new(),
            base_branch: String::new(),
            is_git: false,
            lanes: vec![LaneInfo {
                agent_id: "main".into(),
                title: l.title.clone(),
                wt: "main".into(),
                branch: String::new(),
                wt_dir: cwd.clone(),
            }],
        };
        app.emit("orchestration-start", &info).ok();
        let remaining = Arc::new(AtomicUsize::new(1));
        spawn_lane(app, session_id, "main".into(), "main".into(), cwd, l.prompt.clone(), true, opts, false, remaining)?;
        return Ok(info);
    }

    let repo_top = repo_toplevel(&cwd)?;
    let (base, base_branch) = freeze_base(&repo_top)?;
    let _ = git_run(&repo_top, &["config", "core.longpaths", "true"]);
    let wt_root = worktree_root(&repo_top, &sid8);

    // serial worktree creation (worktree add races on .git admin — never parallel)
    let mut infos: Vec<LaneInfo> = vec![];
    let mut seen = std::collections::HashSet::new();
    for l in &lanes {
        let base_key = sanitize_key(&l.key);
        let mut key = base_key.clone();
        let mut n = 1;
        while seen.contains(&key) {
            key = format!("{base_key}-{n}");
            n += 1;
        }
        seen.insert(key.clone());
        let branch = format!("droolcat/{sid8}/{key}");
        let wt_dir = Path::new(&wt_root).join(&key).to_string_lossy().to_string();
        create_worktree(&repo_top, &wt_dir, &branch, &base)?;
        infos.push(LaneInfo { agent_id: key.clone(), title: l.title.clone(), wt: key, branch, wt_dir });
    }

    let info = OrchestrationInfo {
        session_id: session_id.clone(),
        base,
        base_branch,
        is_git: true,
        lanes: infos.clone(),
    };
    app.emit("orchestration-start", &info).ok();

    let remaining = Arc::new(AtomicUsize::new(infos.len()));
    for (i, l) in lanes.iter().enumerate() {
        let li = &infos[i];
        spawn_lane(
            app.clone(),
            session_id.clone(),
            li.agent_id.clone(),
            li.wt.clone(),
            li.wt_dir.clone(),
            l.prompt.clone(),
            true,
            opts.clone(),
            true,
            remaining.clone(),
        )?;
    }
    Ok(info)
}

/// Merge lane branches back into the base branch. apply=false is a dry-run
/// preview; apply=true commits clean lanes. Conflicts are reported + aborted,
/// leaving base pristine and the lane's worktree intact.
#[tauri::command]
fn merge_lanes(
    app: AppHandle,
    cwd: String,
    base_branch: String,
    lanes: Vec<LaneRef>,
    apply: bool,
) -> Result<MergeReport, String> {
    let repo_top = repo_toplevel(&cwd)?;
    let cur = git_out(&repo_top, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    if !base_branch.is_empty() && cur != base_branch {
        return Err(format!("check out '{base_branch}' first (currently on '{cur}')"));
    }
    let status = git_out(&repo_top, &["status", "--porcelain"]).unwrap_or_default();
    if !status.trim().is_empty() {
        return Err(format!("commit or stash your changes on '{cur}' before merging"));
    }
    let base = git_out(&repo_top, &["rev-parse", "HEAD"]).unwrap_or_default();

    let mut lanes = lanes;
    lanes.sort_by(|a, b| a.key.cmp(&b.key));
    let mut results = vec![];
    for l in &lanes {
        results.push(merge_one(&repo_top, &base, &l.branch, &l.agent_id, apply));
    }
    let ok = results.iter().all(|r| r.status == "merged" || r.status == "empty");
    let report = MergeReport { base_branch: cur, ok, results };
    app.emit("merge-result", &report).ok();
    Ok(report)
}

/// Remove worktrees for exited lanes (keep branches by default so nothing is
/// lost). Also a start-of-session orphan sweep.
#[tauri::command]
fn cleanup_session(
    app: AppHandle,
    cwd: String,
    session_id: String,
    lanes: Vec<LaneRef>,
    keep_branches: Option<bool>,
    force: Option<bool>,
) -> Result<(), String> {
    let keep_branches = keep_branches.unwrap_or(true);
    let force = force.unwrap_or(false);
    let repo_top = repo_toplevel(&cwd).unwrap_or(cwd);

    let live: std::collections::HashSet<String> = {
        let st = app.state::<AppState>();
        let map = st.sessions.lock().unwrap();
        map.get(&session_id).map(|v| v.iter().map(|p| p.agent_id.clone()).collect()).unwrap_or_default()
    };
    for l in &lanes {
        if live.contains(&l.agent_id) && !force {
            continue; // child still running
        }
        if !l.wt_dir.is_empty() {
            remove_worktree(&repo_top, &l.wt_dir);
        }
        if !keep_branches && !l.branch.is_empty() {
            let _ = git_run(&repo_top, &["branch", "-D", &l.branch]);
        }
    }
    let _ = git_run(&repo_top, &["worktree", "prune"]);
    Ok(())
}

/// Hard kill switch / cost-cap enforcement: kill every live lane for a session.
#[tauri::command]
fn stop_all(app: AppHandle, session_id: String) -> Result<(), String> {
    let st = app.state::<AppState>();
    let mut map = st.sessions.lock().unwrap();
    if let Some(v) = map.get_mut(&session_id) {
        for p in v.iter_mut() {
            let _ = p.child.kill();
        }
    }
    Ok(())
}

/// Reveal a lane's worktree in the OS file manager (for manual conflict fixes).
#[tauri::command]
fn open_worktree(cwd: String, session_id: String, key: String) -> Result<String, String> {
    let repo_top = repo_toplevel(&cwd)?;
    let sid8: String = session_id.chars().take(8).collect();
    let wt_dir = Path::new(&worktree_root(&repo_top, &sid8))
        .join(sanitize_key(&key))
        .to_string_lossy()
        .to_string();
    #[cfg(windows)]
    {
        let _ = Command::new("explorer").arg(&wt_dir).spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("open").arg(&wt_dir).spawn();
    }
    Ok(wt_dir)
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
            plan_lanes,
            start_orchestration,
            merge_lanes,
            cleanup_session,
            stop_all,
            open_worktree,
            claude_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
