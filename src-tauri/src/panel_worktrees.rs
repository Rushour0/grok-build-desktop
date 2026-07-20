//! Read-only inspector for the current project's git worktrees. Shells out to
//! `git worktree list --porcelain` in the project cwd and parses the porcelain blocks.
//! Never mutates anything; a non-git folder simply reports `is_repo: false`.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct Worktree {
    path: String,
    /// Short (8-char) HEAD sha.
    head: String,
    /// Branch name (without `refs/heads/`), or None when detached.
    branch: Option<String>,
    /// The first entry `git` lists is the main working tree.
    is_main: bool,
    locked: bool,
}

#[derive(Serialize)]
pub struct Worktrees {
    is_repo: bool,
    worktrees: Vec<Worktree>,
}

#[tauri::command]
pub async fn list_worktrees(cwd: String) -> Worktrees {
    let none = || Worktrees {
        is_repo: false,
        worktrees: Vec::new(),
    };

    let output = match Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&cwd)
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return none(),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut worktrees: Vec<Worktree> = Vec::new();
    let mut current: Option<Worktree> = None;

    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(done) = current.take() {
                worktrees.push(done);
            }
            current = Some(Worktree {
                path: path.to_string(),
                head: String::new(),
                branch: None,
                is_main: worktrees.is_empty(),
                locked: false,
            });
        } else if let Some(head) = line.strip_prefix("HEAD ") {
            if let Some(w) = current.as_mut() {
                w.head = head.chars().take(8).collect();
            }
        } else if let Some(branch) = line.strip_prefix("branch ") {
            if let Some(w) = current.as_mut() {
                w.branch = Some(branch.trim_start_matches("refs/heads/").to_string());
            }
        } else if line == "locked" || line.starts_with("locked ") {
            if let Some(w) = current.as_mut() {
                w.locked = true;
            }
        }
    }
    if let Some(done) = current.take() {
        worktrees.push(done);
    }

    Worktrees {
        is_repo: true,
        worktrees,
    }
}
