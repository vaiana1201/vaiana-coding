//! Multi-agent chat: runs several headless Claude Code sessions in parallel
//! inside the project folder and streams their output to the UI.
//!
//! Each agent is one `claude -p` process per message. The conversation is
//! continued with `--resume <session_id>`, so an agent keeps its own memory
//! while other agents work at the same time.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

use crate::error::{InstallerError, Result};

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum AgentEvent {
    /// Claude Code session started (or resumed).
    #[serde(rename_all = "camelCase")]
    Session { session_id: String },
    /// A piece of assistant text.
    Text { text: String },
    /// The agent is calling a tool (Studio MCP, file edit, ...).
    Tool { name: String, detail: String },
    /// The turn is finished.
    #[serde(rename_all = "camelCase")]
    Done { session_id: Option<String>, is_error: bool },
    /// The process could not run or printed an error.
    Error { message: String },
}

/// Running agent processes, keyed by the UI's agent id.
#[derive(Default)]
pub struct AgentsState {
    children: Arc<Mutex<HashMap<String, tokio::process::Child>>>,
}

impl AgentsState {
    /// Kill every agent (called when the window closes).
    pub fn kill_all_sync(&self) {
        if let Ok(mut guard) = self.children.try_lock() {
            for (_, child) in guard.iter_mut() {
                let _ = child.start_kill();
            }
            guard.clear();
        }
    }
}

/// Rules given to every agent so several of them can work at the same time
/// in one project without waiting for, or breaking, each other.
const PARALLEL_RULES: &str = "You are one of several AI agents working at the same time in this Roblox project. \
The other agents are independent: never wait for them, never ask about them, never undo their work. \
Only change what your own task needs. Always re-read a file right before editing it and make small targeted edits, \
never rewrite a whole file, because another agent may have just changed it. \
If a file changed in a way you did not expect, keep the other agent's changes and apply yours on top. \
Do not run git commands that change history or discard files (no reset, checkout, stash, clean). \
Roblox Studio is shared: do not start or stop a playtest unless the user explicitly asks you to, \
and prefix any temporary instance you create in Studio with your task name so it cannot collide.";

/// Extra rules given to agents when Blender is installed on this computer.
const BLENDER_RULES: &str = " Blender is installed and available as the `blender` command. \
When the user asks for a 3D model made in Blender: write a Python script in `blender/scripts/<name>.py` that starts from an empty scene, \
builds the model with bpy (low-poly, real-world scale in meters, applied transforms, one material per color), \
exports it to `blender/exports/<name>.fbx` and renders a preview to `blender/exports/<name>.png`. \
Run it with `blender --background --python blender/scripts/<name>.py`, read the output, fix errors and re-run until both files exist. \
Look at the preview image to check the result. Only use bpy and the Python standard library in these scripts, never network or system calls. \
Roblox Studio cannot load a local FBX by script: when the export is ready, tell the user to open Studio, \
use File > Import 3D and pick the FBX, and give them the full path of the file.";

/// Locate the Blender executable: PATH first, then the standard install folders.
pub fn find_blender() -> Option<std::path::PathBuf> {
    let lookup = if cfg!(target_os = "windows") { "where" } else { "which" };
    let mut cmd = std::process::Command::new(lookup);
    cmd.arg("blender");
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    if let Ok(output) = cmd.output() {
        if output.status.success() {
            if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                let path = std::path::PathBuf::from(line.trim());
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }

    let exe = if cfg!(target_os = "windows") { "blender.exe" } else { "blender" };
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(dir) = std::env::var(var) {
            roots.push(std::path::Path::new(&dir).join("Blender Foundation"));
            roots.push(
                std::path::Path::new(&dir).join("Steam").join("steamapps").join("common"),
            );
        }
    }
    // Newest version folder first ("Blender 4.5" > "Blender 4.2").
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        let mut dirs: Vec<std::path::PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().to_lowercase().starts_with("blender"))
                    .unwrap_or(false)
            })
            .collect();
        dirs.sort();
        dirs.reverse();
        for dir in dirs {
            let candidate = dir.join(exe);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    let mac = std::path::Path::new("/Applications/Blender.app/Contents/MacOS/Blender");
    if mac.is_file() {
        return Some(mac.to_path_buf());
    }
    None
}

/// Path of the Blender executable, or null when Blender is not installed.
#[tauri::command]
pub async fn detect_blender() -> Result<Option<String>> {
    let found = tokio::task::spawn_blocking(find_blender)
        .await
        .map_err(|e| InstallerError::Custom(e.to_string()))?;
    Ok(found.map(|p| p.to_string_lossy().to_string()))
}

fn claude_command() -> tokio::process::Command {
    // On Windows `claude` is usually a .cmd shim, which CreateProcess cannot
    // start directly — go through cmd.exe. The prompt is sent on stdin, so no
    // user text ever reaches the command line.
    #[cfg(target_os = "windows")]
    {
        let mut cmd = tokio::process::Command::new("cmd.exe");
        cmd.args(["/C", "claude"]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        tokio::process::Command::new("claude")
    }
}

fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Short human-readable summary of a tool call's input.
fn tool_detail(input: &serde_json::Value) -> String {
    for key in ["file_path", "path", "command", "description", "pattern", "code"] {
        if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
            let line = s.lines().next().unwrap_or("");
            let short: String = line.chars().take(120).collect();
            return short;
        }
    }
    String::new()
}

/// Turn one stream-json line from Claude Code into UI events.
fn parse_line(line: &str) -> Vec<AgentEvent> {
    let mut out = Vec::new();
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return out;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("system") => {
            if let Some(id) = v.get("session_id").and_then(|s| s.as_str()) {
                out.push(AgentEvent::Session { session_id: id.to_string() });
            }
        }
        Some("assistant") => {
            let blocks = v
                .pointer("/message/content")
                .and_then(|c| c.as_array())
                .cloned()
                .unwrap_or_default();
            for block in blocks {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            if !text.trim().is_empty() {
                                out.push(AgentEvent::Text { text: text.to_string() });
                            }
                        }
                    }
                    Some("tool_use") => {
                        let name = block
                            .get("name")
                            .and_then(|n| n.as_str())
                            .unwrap_or("tool")
                            .to_string();
                        let detail = block.get("input").map(tool_detail).unwrap_or_default();
                        out.push(AgentEvent::Tool { name, detail });
                    }
                    _ => {}
                }
            }
        }
        Some("result") => {
            let is_error = v.get("is_error").and_then(|b| b.as_bool()).unwrap_or(false);
            if is_error {
                if let Some(msg) = v.get("result").and_then(|r| r.as_str()) {
                    out.push(AgentEvent::Error { message: msg.to_string() });
                }
            }
            out.push(AgentEvent::Done {
                session_id: v.get("session_id").and_then(|s| s.as_str()).map(String::from),
                is_error,
            });
        }
        _ => {}
    }
    out
}

/// Send one message to an agent and stream the answer.
/// Returns when the agent has finished its turn.
#[tauri::command]
pub async fn agent_send(
    agent_id: String,
    project_path: String,
    prompt: String,
    session_id: Option<String>,
    on_event: Channel<AgentEvent>,
    state: tauri::State<'_, AgentsState>,
) -> Result<()> {
    let project_path = crate::util::expand_tilde(&project_path);
    let children = state.children.clone();

    if children.lock().await.contains_key(&agent_id) {
        return Err(InstallerError::Custom("This agent is already working".into()));
    }

    let blender = tokio::task::spawn_blocking(find_blender).await.ok().flatten();
    let mut allowed = String::from(
        "mcp__roxlit,mcp__Roblox_Studio,Bash(git status:*),Bash(git diff:*),Bash(git log:*)",
    );
    let mut rules = String::from(PARALLEL_RULES);
    if blender.is_some() {
        allowed.push_str(",Bash(blender --background --python blender/scripts/:*)");
        rules.push_str(BLENDER_RULES);
    }

    let mut cmd = claude_command();
    cmd.args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        allowed.as_str(),
        "--append-system-prompt",
        rules.as_str(),
    ]);
    // Give the agent a PATH that contains the tools even when they were
    // installed after the app started (Git, Node.js, Claude Code) and Blender.
    {
        let mut paths = crate::commands::setup::tool_dirs();
        if let Some(dir) = blender.as_deref().and_then(|p| p.parent()) {
            paths.insert(0, dir.to_path_buf());
        }
        if let Some(current) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&current));
        }
        if let Ok(joined) = std::env::join_paths(paths) {
            cmd.env("PATH", joined);
        }
    }
    // Project-scoped MCP servers are not auto-trusted in headless mode:
    // pass the project's .mcp.json explicitly so Studio tools are available.
    let mcp_config = std::path::Path::new(&project_path).join(".mcp.json");
    if mcp_config.exists() {
        cmd.arg("--mcp-config").arg(&mcp_config);
    }
    if let Some(id) = session_id.as_deref() {
        if is_safe_session_id(id) {
            cmd.args(["--resume", id]);
        }
    }
    cmd.current_dir(&project_path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        InstallerError::Custom(format!(
            "Claude Code ne démarre pas ({e}). Relance l'app pour l'installer."
        ))
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    children.lock().await.insert(agent_id.clone(), child);

    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if collected.len() < 2000 {
                    collected.push_str(&line);
                    collected.push('\n');
                }
            }
        }
        collected
    });

    let mut got_done = false;
    if let Some(stdout) = stdout {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            for event in parse_line(&line) {
                if matches!(event, AgentEvent::Done { .. }) {
                    got_done = true;
                }
                let _ = on_event.send(event);
            }
        }
    }

    // The process is finished (or was killed by agent_stop, which already removed it).
    let child = children.lock().await.remove(&agent_id);
    let stopped_by_user = child.is_none();
    if let Some(mut child) = child {
        let _ = child.wait().await;
    }
    let stderr_text = stderr_task.await.unwrap_or_default();

    if !got_done {
        if !stopped_by_user && !stderr_text.trim().is_empty() {
            let _ = on_event.send(AgentEvent::Error { message: stderr_text.trim().to_string() });
        }
        let _ = on_event.send(AgentEvent::Done { session_id: None, is_error: !stopped_by_user });
    }
    Ok(())
}

/// Stop an agent that is currently working.
#[tauri::command]
pub async fn agent_stop(agent_id: String, state: tauri::State<'_, AgentsState>) -> Result<()> {
    if let Some(mut child) = state.children.lock().await.remove(&agent_id) {
        let _ = child.kill().await;
    }
    Ok(())
}

// ─── Git checkpoints ─────────────────────────────────────────────────────────

async fn git(project_path: &str, args: &[&str]) -> Result<(bool, String)> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args).current_dir(project_path);
    if let Some(path) = crate::commands::setup::augmented_path() {
        cmd.env("PATH", path);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    let output = cmd.output().await.map_err(|e| {
        InstallerError::Custom(format!("Git is not installed or not in PATH ({e})"))
    })?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok((output.status.success(), text.trim().to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    is_repo: bool,
    changed_files: usize,
    last_commit: Option<String>,
}

/// Number of modified files and the last checkpoint.
#[tauri::command]
pub async fn git_info(project_path: String) -> Result<GitInfo> {
    let project_path = crate::util::expand_tilde(&project_path);
    let (is_repo, _) = git(&project_path, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !is_repo {
        return Ok(GitInfo { is_repo: false, changed_files: 0, last_commit: None });
    }
    let (_, status) = git(&project_path, &["status", "--porcelain"]).await?;
    let changed_files = status.lines().filter(|l| !l.trim().is_empty()).count();
    let (ok, log) = git(&project_path, &["log", "-1", "--format=%s (%cr)"]).await?;
    Ok(GitInfo {
        is_repo: true,
        changed_files,
        last_commit: if ok && !log.is_empty() { Some(log) } else { None },
    })
}

/// Save every change as one commit ("checkpoint"). Creates the repo if needed.
#[tauri::command]
pub async fn git_checkpoint(project_path: String, message: String) -> Result<String> {
    let project_path = crate::util::expand_tilde(&project_path);
    let (is_repo, _) = git(&project_path, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !is_repo {
        let (ok, out) = git(&project_path, &["init"]).await?;
        if !ok {
            return Err(InstallerError::Custom(out));
        }
    }
    let (ok, out) = git(&project_path, &["add", "-A"]).await?;
    if !ok {
        return Err(InstallerError::Custom(out));
    }
    let (_, status) = git(&project_path, &["status", "--porcelain"]).await?;
    if status.trim().is_empty() {
        return Ok("Nothing to save".into());
    }
    let message = if message.trim().is_empty() { "Checkpoint" } else { message.trim() };
    let (ok, out) = git(
        &project_path,
        &[
            "-c", "user.name=Roxlit",
            "-c", "user.email=roxlit@localhost",
            "commit", "-m", message,
        ],
    )
    .await?;
    if !ok {
        return Err(InstallerError::Custom(out));
    }
    Ok("Saved".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_stream_json() {
        let init = r#"{"type":"system","subtype":"init","session_id":"abc-123"}"#;
        assert!(matches!(&parse_line(init)[..], [AgentEvent::Session { session_id }] if session_id == "abc-123"));

        let msg = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Salut"},{"type":"tool_use","name":"mcp__roxlit__run_code","input":{"code":"print(1)\nprint(2)"}}]}}"#;
        let events = parse_line(msg);
        assert!(matches!(&events[0], AgentEvent::Text { text } if text == "Salut"));
        assert!(matches!(&events[1], AgentEvent::Tool { name, detail } if name == "mcp__roxlit__run_code" && detail == "print(1)"));

        let done = r#"{"type":"result","is_error":false,"result":"ok","session_id":"abc-123"}"#;
        assert!(matches!(&parse_line(done)[..], [AgentEvent::Done { is_error: false, .. }]));

        assert!(parse_line("not json").is_empty());
    }

    #[test]
    fn rejects_bad_session_ids() {
        assert!(is_safe_session_id("0a1b-22"));
        assert!(!is_safe_session_id("x & calc"));
        assert!(!is_safe_session_id(""));
    }
}
