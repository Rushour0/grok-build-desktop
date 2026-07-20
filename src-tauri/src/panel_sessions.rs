//! Read-only inventory of every Grok session stored on this machine.
//!
//! This is deliberately separate from the sidebar's `list_sessions` command: the
//! Sessions panel needs a compact, cross-project shape whose timestamps come from
//! the session directories themselves.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
struct PanelSession {
    project_path: String,
    project_name: String,
    session_id: String,
    title: String,
    updated_ms: u64,
}

/// List every persisted Grok session, grouped by its encoded project directory.
///
/// The session store is user-owned and may be absent, partially written, or contain
/// unexpected directories. Each of those cases is treated as an empty/partial read;
/// the inspector never needs to make the rest of the app fail because history is gone.
#[tauri::command]
pub async fn panel_sessions() -> Result<serde_json::Value, String> {
    let sessions = tauri::async_runtime::spawn_blocking(read_panel_sessions)
        .await
        .unwrap_or_default();

    // `PanelSession` is entirely serializable, but preserve the panel's read-only,
    // best-effort contract even if serialization ever changes in the future.
    Ok(serde_json::to_value(sessions).unwrap_or_else(|_| Value::Array(Vec::new())))
}

fn read_panel_sessions() -> Vec<PanelSession> {
    let Some(home) = std::env::var_os("HOME") else {
        return Vec::new();
    };
    read_panel_sessions_at(&PathBuf::from(home).join(".grok/sessions"))
}

fn read_panel_sessions_at(root: &Path) -> Vec<PanelSession> {
    let Ok(project_entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    for project_entry in project_entries.flatten() {
        let project_dir = project_entry.path();
        if !project_dir.is_dir() {
            continue;
        }

        let project_path = percent_decode(&project_entry.file_name().to_string_lossy());
        let project_name = Path::new(&project_path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| project_path.clone());

        let Ok(session_entries) = std::fs::read_dir(project_dir) else {
            continue;
        };
        for session_entry in session_entries.flatten() {
            let session_dir = session_entry.path();
            if !session_dir.is_dir() || !session_dir.join("chat_history.jsonl").is_file() {
                continue;
            }

            let session_id = session_entry.file_name().to_string_lossy().into_owned();
            let title = read_title(&session_dir.join("summary.json"));
            let updated_ms = session_entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
                .unwrap_or(0);

            sessions.push(PanelSession {
                project_path: project_path.clone(),
                project_name: project_name.clone(),
                session_id,
                title,
                updated_ms,
            });
        }
    }

    sessions.sort_by(|left, right| right.updated_ms.cmp(&left.updated_ms));
    sessions
}

fn read_title(summary_path: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(summary_path) else {
        return "Untitled".to_string();
    };
    let Ok(summary) = serde_json::from_str::<Value>(&text) else {
        return "Untitled".to_string();
    };

    ["generated_title", "title", "session_summary"]
        .into_iter()
        .filter_map(|key| summary.get(key).and_then(Value::as_str))
        .map(str::trim)
        .find(|title| !title.is_empty())
        .unwrap_or("Untitled")
        .to_string()
}

/// Decode Grok's percent-encoded project-directory names without assuming that
/// arbitrary bytes in the store are valid UTF-8. Invalid escapes remain literal,
/// which is safer than dropping an otherwise visible project from this read-only list.
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }

    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}
