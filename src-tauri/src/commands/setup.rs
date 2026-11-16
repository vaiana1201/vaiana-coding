//! First-run setup: detect and install what the agents need on a fresh PC
//! (Git, Node.js, Claude Code), so the app works by just running the .exe.

use std::ffi::OsString;
use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::error::{InstallerError, Result};

/// Standard install folders of the tools. A program installed while the app is
/// running is not in the app's PATH yet, so these are always added to it.
pub fn tool_dirs() -> Vec<PathBuf> {
    let mut dirs_out = Vec::new();
    let mut push = |base: Option<OsString>, rest: &[&str]| {
        if let Some(base) = base {
            let mut path = PathBuf::from(base);
            for part in rest {
                path.push(part);
            }
            if path.is_dir() {
                dirs_out.push(path);
            }
        }
    };
    push(std::env::var_os("ProgramFiles"), &["nodejs"]);
    push(std::env::var_os("ProgramFiles"), &["Git", "cmd"]);
    push(std::env::var_os("LOCALAPPDATA"), &["Programs", "Git", "cmd"]);
    push(std::env::var_os("APPDATA"), &["npm"]);
    push(std::env::var_os("USERPROFILE"), &[".local", "bin"]);
    push(std::env::var_os("LOCALAPPDATA"), &["Microsoft", "WindowsApps"]);
    dirs_out
}

/// The app's PATH with the tool folders in front.
pub fn augmented_path() -> Option<OsString> {
    let mut paths = tool_dirs();
    if let Some(current) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current));
    }
    std::env::join_paths(paths).ok()
}

/// True when `name` resolves to a program with the augmented PATH.
fn has_tool(name: &str) -> bool {
    let lookup = if cfg!(target_os = "windows") { "where" } else { "which" };
    let mut cmd = std::process::Command::new(lookup);
    cmd.arg(name);
    if let Some(path) = augmented_path() {
        cmd.env("PATH", path);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prereqs {
    git: bool,
    node: bool,
    claude: bool,
    /// Whether this computer can install the missing tools automatically.
    can_install: bool,
}

fn detect() -> Prereqs {
    Prereqs {
        git: has_tool("git"),
        node: has_tool("npm"),
        claude: has_tool("claude"),
        can_install: cfg!(target_os = "windows") && has_tool("winget"),
    }
}

/// Which of the required tools are installed.
#[tauri::command]
pub async fn check_prereqs() -> Result<Prereqs> {
    tokio::task::spawn_blocking(detect)
        .await
        .map_err(|e| InstallerError::Custom(e.to_string()))
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum SetupProgress {
    /// Started installing one tool ("git", "node" or "claude").
    Step { tool: String },
    /// One line of installer output.
    Line { text: String },
    /// A tool finished installing (or failed).
    Result { tool: String, ok: bool },
}

/// Run one installer command and forward its output. Returns true on success.
async fn run_step(mut cmd: tokio::process::Command, on_event: &Channel<SetupProgress>) -> bool {
    if let Some(path) = augmented_path() {
        cmd.env("PATH", path);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            let _ = on_event.send(SetupProgress::Line { text: format!("Erreur : {e}") });
            return false;
        }
    };

    let stderr = child.stderr.take();
    let err_events = on_event.clone();
    let err_task = tokio::spawn(async move {
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(text) = clean_line(&line) {
                    let _ = err_events.send(SetupProgress::Line { text });
                }
            }
        }
    });
    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(text) = clean_line(&line) {
                let _ = on_event.send(SetupProgress::Line { text });
            }
        }
    }
    let _ = err_task.await;
    child.wait().await.map(|s| s.success()).unwrap_or(false)
}

/// Keep the readable part of an installer line: winget redraws progress bars
/// and spinners with carriage returns, which are noise in a log.
pub fn clean_line(line: &str) -> Option<String> {
    let last = line.rsplit('\r').find(|part| !part.trim().is_empty())?;
    let text = last.trim();
    let is_noise = text.chars().all(|c| {
        matches!(c, '-' | '\\' | '|' | '/' | '█' | '▒' | '░' | ' ')
    });
    if is_noise || text.contains('█') || text.contains('▒') {
        return None;
    }
    Some(text.chars().take(200).collect())
}

#[allow(dead_code)]
fn winget_install(id: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("winget");
    cmd.args([
        "install",
        "--id",
        id,
        "-e",
        "--source",
        "winget",
        "--silent",
        "--disable-interactivity",
        "--accept-package-agreements",
        "--accept-source-agreements",
    ]);
    cmd
}

/// Install every missing tool, in order, and report progress.
/// Returns the state after installation.
#[tauri::command]
pub async fn install_prereqs(on_event: Channel<SetupProgress>) -> Result<Prereqs> {
    let before = check_prereqs().await?;

    #[cfg(not(target_os = "windows"))]
    {
        let _ = &on_event;
        if !(before.git && before.node && before.claude) {
            return Err(InstallerError::Custom(
                "Installation automatique disponible sur Windows seulement.".into(),
            ));
        }
    }

    #[cfg(target_os = "windows")]
    {
        if !before.can_install && !(before.git && before.node) {
            return Err(InstallerError::Custom(
                "winget est introuvable sur ce PC : installe « App Installer » depuis le Microsoft Store, puis relance.".into(),
            ));
        }
        if !before.git {
            let _ = on_event.send(SetupProgress::Step { tool: "git".into() });
            let ok = run_step(winget_install("Git.Git"), &on_event).await;
            let _ = on_event.send(SetupProgress::Result { tool: "git".into(), ok: ok || has_tool("git") });
        }
        if !before.node {
            let _ = on_event.send(SetupProgress::Step { tool: "node".into() });
            let ok = run_step(winget_install("OpenJS.NodeJS.LTS"), &on_event).await;
            let _ = on_event.send(SetupProgress::Result { tool: "node".into(), ok: ok || has_tool("npm") });
        }
        if !before.claude {
            let _ = on_event.send(SetupProgress::Step { tool: "claude".into() });
            let mut ok = false;
            if has_tool("npm") {
                let mut cmd = tokio::process::Command::new("cmd.exe");
                cmd.args(["/C", "npm", "install", "-g", "@anthropic-ai/claude-code"]);
                ok = run_step(cmd, &on_event).await;
            } else {
                let _ = on_event.send(SetupProgress::Line {
                    text: "Node.js n'est pas installé : impossible d'installer Claude Code.".into(),
                });
            }
            let _ = on_event.send(SetupProgress::Result { tool: "claude".into(), ok: ok || has_tool("claude") });
        }
    }

    check_prereqs().await
}

/// Open a terminal running Claude Code so the user can sign in to their account.
#[tauri::command]
pub async fn claude_login() -> Result<()> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    // An empty folder: signing in must not ask to trust the whole home folder.
    let dir = home.join(".roxlit").join("login");
    std::fs::create_dir_all(&dir)?;

    #[cfg(target_os = "windows")]
    {
        let mut cmd = tokio::process::Command::new("cmd.exe");
        cmd.args(["/C", "start", "Claude Code", "cmd.exe", "/K", "claude"]);
        cmd.current_dir(&dir);
        if let Some(path) = augmented_path() {
            cmd.env("PATH", path);
        }
        cmd.creation_flags(0x08000000);
        cmd.spawn()
            .map(|_| ())
            .map_err(|e| InstallerError::Custom(format!("Impossible d'ouvrir le terminal : {e}")))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
        return Err(InstallerError::Custom(
            "Ouvre un terminal et lance `claude` pour te connecter.".into(),
        ));
    }
    #[allow(unreachable_code)]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::clean_line;

    #[test]
    fn cleans_installer_output() {
        assert_eq!(clean_line("Found Git [Git.Git] Version 2.56.1").as_deref(), Some("Found Git [Git.Git] Version 2.56.1"));
        assert_eq!(clean_line("   - \r   \\ \r   | ").as_deref(), None);
        assert_eq!(clean_line("  ██████▒▒▒▒  4.27 MB / 9 MB").as_deref(), None);
        assert_eq!(clean_line(" - \rSuccessfully installed").as_deref(), Some("Successfully installed"));
        assert_eq!(clean_line("").as_deref(), None);
    }
}
