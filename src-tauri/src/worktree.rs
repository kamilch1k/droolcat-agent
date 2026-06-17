//! Git worktree plumbing for Milestone 2 (parallel agents in isolated worktrees).
//!
//! Every lane runs in its OWN worktree off a frozen base SHA, lives OUTSIDE the
//! target repo (an in-repo worktree shows as untracked and would trip the merge
//! cleanliness guard), and merges back one-at-a-time so cross-lane conflicts
//! surface at the right place. All git runs via `git -C <dir>` arg arrays — no
//! shell — so spaces in `C:\Users\First Last` are safe.

use std::path::Path;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct LaneSpec {
    pub key: String,
    pub title: String,
    pub prompt: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct LaneRef {
    pub agent_id: String,
    pub key: String,
    pub branch: String,
    pub wt_dir: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Plan {
    pub is_git: bool,
    pub base: String,
    pub base_branch: String,
    pub parallelizable: bool,
    pub lanes: Vec<LaneSpec>,
}

#[derive(Deserialize, Default, Clone, Debug)]
pub struct SessionOpts {
    pub budget_usd: Option<f64>,
    pub yolo: Option<bool>,
}

// NOTE: these four structs cross the Tauri event bus to the webview, which
// reads camelCase. Tauri's auto camelCase mapping applies only to command
// ARGUMENT names, NOT to fields of structs you emit — so they need rename_all.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeOne {
    pub agent_id: String,
    pub status: String, // merged | conflict | empty | error
    pub conflicts: Vec<String>,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    pub base_branch: String,
    pub ok: bool,
    pub results: Vec<MergeOne>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LaneInfo {
    pub agent_id: String,
    pub title: String,
    pub wt: String,
    pub branch: String,
    pub wt_dir: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationInfo {
    pub session_id: String,
    pub base: String,
    pub base_branch: String,
    pub is_git: bool,
    pub lanes: Vec<LaneInfo>,
}

const DROOLCAT_ID: [&str; 2] = ["-c", "user.email=droolcat@local"];

fn git_cmd(dir: &str) -> Command {
    let mut c = Command::new("git");
    c.arg("-C").arg(dir);
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Run git and return trimmed stdout on success, trimmed stderr as Err otherwise.
pub fn git_out(dir: &str, args: &[&str]) -> Result<String, String> {
    let out = git_cmd(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git {:?}: {e}", args))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Run git, returning (success, stdout, stderr) — never errors on a nonzero exit.
pub fn git_run(dir: &str, args: &[&str]) -> (bool, String, String) {
    match git_cmd(dir).args(args).output() {
        Ok(o) => (
            o.status.success(),
            String::from_utf8_lossy(&o.stdout).to_string(),
            String::from_utf8_lossy(&o.stderr).to_string(),
        ),
        Err(e) => (false, String::new(), e.to_string()),
    }
}

pub fn is_git(dir: &str) -> bool {
    git_out(dir, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s == "true")
        .unwrap_or(false)
}

pub fn repo_toplevel(dir: &str) -> Result<String, String> {
    git_out(dir, &["rev-parse", "--show-toplevel"])
}

/// Freeze the base the lanes branch from: (sha, branch-name).
pub fn freeze_base(dir: &str) -> Result<(String, String), String> {
    let base = git_out(dir, &["rev-parse", "HEAD"])?;
    let branch = git_out(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
    Ok((base, branch))
}

/// Deterministic 8-hex session namespace (FNV-1a) — collision-resistant across
/// sessions so branch/worktree names never clobber another run's work.
pub fn short_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x00000100000001B3);
    }
    format!("{:08x}", (h & 0xffff_ffff) as u32)
}

pub fn sanitize_key(k: &str) -> String {
    let s: String = k
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "lane".into() } else { s }
}

/// Sibling scratch root for a session's worktrees: <repoParent>/.droolcat-worktrees/<sid8>.
pub fn worktree_root(repo_top: &str, sid8: &str) -> String {
    let parent = Path::new(repo_top)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| repo_top.to_string());
    Path::new(&parent)
        .join(".droolcat-worktrees")
        .join(sid8)
        .to_string_lossy()
        .to_string()
}

/// Create a worktree on a fresh branch. NON-DESTRUCTIVE: never deletes a branch
/// by name (that could clobber another session's kept work). Only prunes stale
/// worktree *registrations* (safe) and retries; a genuine branch-name collision
/// fails loudly so the caller can pick a new name.
pub fn create_worktree(repo: &str, wt_dir: &str, branch: &str, base: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(wt_dir).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let (ok, _o, _err) = git_run(repo, &["worktree", "add", "-b", branch, wt_dir, base]);
    if ok {
        return Ok(());
    }
    // prune stale registrations from a crashed run (removes admin entries whose
    // dirs are gone — never touches branches or live worktrees), then retry once.
    let _ = git_run(repo, &["worktree", "prune"]);
    let (ok2, _o2, err2) = git_run(repo, &["worktree", "add", "-b", branch, wt_dir, base]);
    if ok2 {
        Ok(())
    } else {
        Err(format!("worktree add failed for {branch}: {err2}"))
    }
}

/// Commit a lane's work if its tree is dirty; returns the short sha (None if clean).
pub fn commit_lane(wt_dir: &str, msg: &str) -> Option<String> {
    let status = git_out(wt_dir, &["status", "--porcelain"]).unwrap_or_default();
    if status.trim().is_empty() {
        return None;
    }
    let _ = git_run(wt_dir, &["add", "-A"]);
    let mut args: Vec<&str> = DROOLCAT_ID.to_vec();
    args.extend_from_slice(&["-c", "user.name=Droolcat", "commit", "--no-verify", "-m", msg]);
    let (ok, _o, _e) = git_run(wt_dir, &args);
    if !ok {
        return None;
    }
    git_out(wt_dir, &["rev-parse", "--short", "HEAD"]).ok()
}

/// Merge one lane branch into the (already checked-out, clean) base branch.
/// Sequential `--no-commit --no-ff`: clean -> commit (apply) or abort (dry-run);
/// conflict -> record the unmerged files and abort, leaving base pristine.
pub fn merge_one(repo: &str, base: &str, branch: &str, agent_id: &str, apply: bool) -> MergeOne {
    let ahead = git_out(repo, &["rev-list", "--count", &format!("{base}..{branch}")]).unwrap_or_else(|_| "0".into());
    if ahead.trim() == "0" {
        return MergeOne { agent_id: agent_id.into(), status: "empty".into(), conflicts: vec![], message: "no commits to merge".into() };
    }
    let (ok, _o, err) = git_run(repo, &["merge", "--no-commit", "--no-ff", branch]);
    if ok {
        if apply {
            let mut args: Vec<&str> = DROOLCAT_ID.to_vec();
            let msg = format!("Merge droolcat lane {agent_id}");
            args.extend_from_slice(&["-c", "user.name=Droolcat", "commit", "--no-verify", "-m", &msg]);
            let (cok, _c, cerr) = git_run(repo, &args);
            if cok {
                MergeOne { agent_id: agent_id.into(), status: "merged".into(), conflicts: vec![], message: "merged".into() }
            } else {
                let _ = git_run(repo, &["merge", "--abort"]);
                MergeOne { agent_id: agent_id.into(), status: "error".into(), conflicts: vec![], message: cerr.trim().to_string() }
            }
        } else {
            let _ = git_run(repo, &["merge", "--abort"]);
            MergeOne { agent_id: agent_id.into(), status: "merged".into(), conflicts: vec![], message: "clean (preview)".into() }
        }
    } else {
        let conflicts = git_out(repo, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
        let list: Vec<String> = conflicts.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        let _ = git_run(repo, &["merge", "--abort"]);
        let message = if list.is_empty() { err.trim().to_string() } else { format!("conflicts in {}", list.join(", ")) };
        MergeOne { agent_id: agent_id.into(), status: "conflict".into(), conflicts: list, message }
    }
}

pub fn remove_worktree(repo: &str, wt_dir: &str) {
    let _ = git_run(repo, &["worktree", "remove", "--force", wt_dir]);
    let _ = git_run(repo, &["worktree", "prune"]);
}
