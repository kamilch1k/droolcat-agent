//! Milestone 3 — Code Graph extraction.
//!
//! Walk a repo into a file/module dependency graph: one node per source file,
//! one edge per resolved intra-repo import. File-level first (the brief's
//! stated starting depth); symbol/call level is a later pass. External package
//! imports are intentionally dropped so the graph shows the project's own
//! structure, not its node_modules.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use regex::Regex;
use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodeNode {
    pub id: String,   // repo-relative path, forward slashes
    pub path: String, // same; kept for clarity on the JS side
    pub dir: String,  // parent directory (the layout cluster)
    pub lang: String,
    pub imports: usize,
    pub imported_by: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CodeEdge {
    pub from: String,
    pub to: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeGraph {
    pub root: String,
    pub nodes: Vec<CodeNode>,
    pub edges: Vec<CodeEdge>,
    pub truncated: bool,
    pub file_count: usize,
}

const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "out", ".next", ".nuxt",
    "vendor", "__pycache__", ".venv", "venv", ".droolcat-worktrees", "sessions",
    ".vite", "coverage", ".idea", ".vscode", ".gradle", "bin", "obj", "Pods",
];
const MAX_FILES: usize = 1500;
const MAX_BYTES: u64 = 512 * 1024;

fn lang_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "js" | "mjs" | "cjs" | "jsx" => "js",
        "ts" | "tsx" | "mts" | "cts" => "ts",
        "vue" => "vue",
        "svelte" => "svelte",
        "py" => "py",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "css" | "scss" | "sass" | "less" => "css",
        "html" | "htm" => "html",
        _ => return None,
    })
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

fn parent_dir(relpath: &str) -> String {
    match relpath.rsplit_once('/') {
        Some((d, _)) => d.to_string(),
        None => ".".to_string(),
    }
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<std::path::PathBuf>, depth: usize) {
    if out.len() >= MAX_FILES || depth > 40 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut paths: Vec<_> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();
    for p in paths {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        // NEVER follow symlinks — a directory symlink cycle would recurse until
        // the stack overflows (an uncatchable abort under panic="abort").
        if fs::symlink_metadata(&p).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            continue;
        }
        if p.is_dir() {
            if (name.starts_with('.') && name != ".") || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(root, &p, out, depth + 1);
        } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if lang_of(ext).is_some() {
                out.push(p);
            }
        }
    }
}

/// Resolve a relative import spec to a known repo file (None for packages).
fn resolve(spec: &str, from_dir: &str, files: &HashSet<String>) -> Option<String> {
    if !(spec.starts_with('.') || spec.starts_with('/')) {
        return None; // bare/package import — not an intra-repo edge
    }
    // join from_dir + spec, normalizing . and ..
    let base = if spec.starts_with('/') { String::new() } else { from_dir.to_string() };
    let mut parts: Vec<String> = vec![];
    for seg in format!("{base}/{spec}").split('/') {
        match seg {
            "" | "." => {}
            ".." => { parts.pop(); }
            s => parts.push(s.to_string()),
        }
    }
    let joined = parts.join("/");
    let cands = [
        joined.clone(),
        format!("{joined}.ts"), format!("{joined}.tsx"), format!("{joined}.js"),
        format!("{joined}.jsx"), format!("{joined}.mjs"), format!("{joined}.cjs"),
        format!("{joined}.vue"), format!("{joined}.svelte"), format!("{joined}.css"),
        format!("{joined}.scss"), format!("{joined}.py"),
        format!("{joined}/index.ts"), format!("{joined}/index.js"),
        format!("{joined}/index.tsx"), format!("{joined}/index.jsx"),
        format!("{joined}/mod.rs"),
    ];
    cands.into_iter().find(|c| files.contains(c))
}

/// Resolve a Rust `mod name;` to a sibling file in the importing file's dir.
fn resolve_rust_mod(name: &str, from_dir: &str, files: &HashSet<String>) -> Option<String> {
    let base = if from_dir.is_empty() { name.to_string() } else { format!("{from_dir}/{name}") };
    for c in [format!("{base}.rs"), format!("{base}/mod.rs")] {
        if files.contains(&c) {
            return Some(c);
        }
    }
    None
}

pub fn scan(root_dir: &str) -> CodeGraph {
    let root = Path::new(root_dir);
    let mut paths = vec![];
    walk(root, root, &mut paths, 0);
    let truncated = paths.len() >= MAX_FILES;

    let rels: Vec<String> = paths.iter().map(|p| rel(root, p)).collect();
    let file_set: HashSet<String> = rels.iter().cloned().collect();

    // import extractors
    let re_js = Regex::new(r#"(?:import|export)[^;'"\n]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]"#).unwrap();
    // strip comments before JS extraction so imports named in comments/jsdoc
    // don't become phantom edges
    let re_block = Regex::new(r"(?s)/\*.*?\*/").unwrap();
    let re_line = Regex::new(r"(?m)//[^\n]*").unwrap();
    let re_py_from = Regex::new(r#"(?m)^\s*from\s+([.\w]+)\s+import\s+([^\n#]+)"#).unwrap();
    let re_py_imp = Regex::new(r#"(?m)^\s*import\s+([.\w]+(?:\s*,\s*[.\w]+)*)"#).unwrap();
    let re_rs = Regex::new(r#"(?m)^\s*(?:pub\s+)?mod\s+([a-zA-Z0-9_]+)\s*;"#).unwrap();
    // handles @import "x", @import url(x), @import url("x")
    let re_css = Regex::new(r#"@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?"#).unwrap();
    let re_html = Regex::new(r#"(?:src|href)\s*=\s*['"]([^'"]+\.(?:js|mjs|css|ts))['"]"#).unwrap();

    let mut edge_set: HashSet<(String, String)> = HashSet::new();
    let mut import_count: HashMap<String, usize> = HashMap::new();
    let mut imported_by: HashMap<String, usize> = HashMap::new();

    for (i, p) in paths.iter().enumerate() {
        if fs::metadata(p).map(|m| m.len()).unwrap_or(0) > MAX_BYTES {
            continue;
        }
        let content = match fs::read_to_string(p) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let from = &rels[i];
        let from_dir = match from.rsplit_once('/') {
            Some((d, _)) => d.to_string(),
            None => String::new(),
        };
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        let lang = lang_of(ext).unwrap_or("");

        let mut add = |spec_target: Option<String>| {
            if let Some(to) = spec_target {
                if to != *from && edge_set.insert((from.clone(), to.clone())) {
                    *import_count.entry(from.clone()).or_insert(0) += 1;
                    *imported_by.entry(to).or_insert(0) += 1;
                }
            }
        };

        match lang {
            "js" | "ts" | "vue" | "svelte" => {
                let cleaned = re_line.replace_all(&re_block.replace_all(&content, " "), " ").into_owned();
                for cap in re_js.captures_iter(&cleaned) {
                    let spec = cap.get(1).or(cap.get(2)).or(cap.get(3)).or(cap.get(4)).map(|m| m.as_str());
                    if let Some(s) = spec {
                        add(resolve(s, &from_dir, &file_set));
                    }
                }
            }
            "py" => {
                let mut try_mod = |modpath: &str| {
                    if !modpath.is_empty() {
                        add(resolve(&format!("./{modpath}"), &from_dir, &file_set)
                            .or_else(|| resolve(&format!("/{modpath}"), "", &file_set)));
                    }
                };
                for cap in re_py_from.captures_iter(&content) {
                    let modpath = cap.get(1).map(|m| m.as_str()).unwrap_or("").trim_start_matches('.').replace('.', "/");
                    try_mod(&modpath);
                    if let Some(names) = cap.get(2) {
                        for raw in names.as_str().split(',') {
                            let name = raw.trim().split_whitespace().next().unwrap_or("");
                            if name.is_empty() || name == "*" { continue; }
                            let full = if modpath.is_empty() { name.to_string() } else { format!("{modpath}/{name}") };
                            try_mod(&full);
                        }
                    }
                }
                for cap in re_py_imp.captures_iter(&content) {
                    if let Some(m) = cap.get(1) {
                        for raw in m.as_str().split(',') {
                            try_mod(&raw.trim().trim_start_matches('.').replace('.', "/"));
                        }
                    }
                }
            }
            "rust" => {
                for cap in re_rs.captures_iter(&content) {
                    if let Some(m) = cap.get(1) {
                        add(resolve_rust_mod(m.as_str(), &from_dir, &file_set));
                    }
                }
            }
            "css" => {
                for cap in re_css.captures_iter(&content) {
                    if let Some(m) = cap.get(1) {
                        add(resolve(m.as_str(), &from_dir, &file_set));
                    }
                }
            }
            "html" => {
                for cap in re_html.captures_iter(&content) {
                    if let Some(m) = cap.get(1) {
                        add(resolve(m.as_str(), &from_dir, &file_set));
                    }
                }
            }
            _ => {}
        }
    }

    let nodes: Vec<CodeNode> = rels
        .iter()
        .map(|r| CodeNode {
            id: r.clone(),
            path: r.clone(),
            dir: parent_dir(r),
            lang: lang_of(Path::new(r).extension().and_then(|e| e.to_str()).unwrap_or("")).unwrap_or("").to_string(),
            imports: *import_count.get(r).unwrap_or(&0),
            imported_by: *imported_by.get(r).unwrap_or(&0),
        })
        .collect();
    let edges: Vec<CodeEdge> = edge_set.into_iter().map(|(from, to)| CodeEdge { from, to }).collect();

    CodeGraph {
        root: root_dir.to_string(),
        file_count: nodes.len(),
        nodes,
        edges,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scans_droolcat_repo() {
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
        let g = scan(root);
        let has_node = |id: &str| g.nodes.iter().any(|n| n.id == id);
        let has_edge = |a: &str, b: &str| g.edges.iter().any(|e| e.from == a && e.to == b);
        assert!(has_node("src/main.js"), "expected src/main.js node");
        // JS relative imports resolve to files
        assert!(has_edge("src/main.js", "src/graph.js"), "main.js -> graph.js");
        assert!(has_edge("src/main.js", "src/canvas.js"), "main.js -> canvas.js");
        assert!(has_edge("src/canvas.js", "src/icons.js"), "canvas.js -> icons.js");
        // Rust `mod` declarations resolve to sibling files
        assert!(has_edge("src-tauri/src/lib.rs", "src-tauri/src/codegraph.rs"), "lib.rs mod codegraph");
        assert!(has_edge("src-tauri/src/lib.rs", "src-tauri/src/worktree.rs"), "lib.rs mod worktree");
        // node_modules / target must be skipped
        assert!(!g.nodes.iter().any(|n| n.id.contains("node_modules")), "node_modules skipped");
        assert!(!g.nodes.iter().any(|n| n.id.contains("/target/")), "target skipped");
        eprintln!("codegraph self-scan: {} nodes, {} edges", g.nodes.len(), g.edges.len());
    }
}
