//! Read-only access to Grok's local configuration and account metadata.
//!
//! The commands in this module deliberately return only an allowlisted subset of
//! `auth.json`. Authentication material must never cross the Tauri IPC boundary.

use std::env;
use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
pub struct GrokAccount {
    pub first_name: String,
    pub email: String,
    pub auth_mode: String,
    pub team_id: String,
    pub grok_version: String,
    pub default_model: String,
}

/// Read the user's Grok directory without assuming a platform-specific home
/// directory API. `USERPROFILE` keeps the command useful on Windows as well.
fn grok_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(".grok"))
}

fn read_json(path: PathBuf) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn string_field(object: &Value, field: &str) -> String {
    object
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Finds a named string anywhere in a small metadata document. This accommodates
/// the version/cache formats used by different Grok CLI releases without exposing
/// unrecognised fields.
fn find_named_string(value: &Value, names: &[&str]) -> String {
    match value {
        Value::Object(values) => {
            for name in names {
                if let Some(found) = values.get(*name).and_then(Value::as_str) {
                    return found.to_string();
                }
            }
            for child in values.values() {
                let found = find_named_string(child, names);
                if !found.is_empty() {
                    return found;
                }
            }
            String::new()
        }
        Value::Array(values) => values
            .iter()
            .map(|child| find_named_string(child, names))
            .find(|found| !found.is_empty())
            .unwrap_or_default(),
        Value::String(value) if names.contains(&"value") => value.to_string(),
        _ => String::new(),
    }
}

/// Secret-bearing settings never belong in a read-only inspector. The value is
/// removed, rather than merely masked, so it cannot be copied from the panel.
fn is_sensitive_key(key: &str) -> bool {
    let key = key.trim().trim_matches(['\"', '\'']).to_ascii_lowercase();
    let key = key.replace(['-', ' '], "_");

    key == "key"
        || key.contains("key")
        || key.contains("token")
        || key.contains("secret")
        || key.contains("password")
        || key.contains("credential")
        || key.contains("api_key")
        || key.contains("private_key")
}

fn triple_quote_count(line: &str) -> usize {
    line.matches("\"\"\"").count() + line.matches("'''").count()
}

/// Keep TOML's readable shape while removing secret assignments, including a
/// simple triple-quoted value that continues across lines.
fn redact_config(text: &str) -> String {
    let mut redacted = String::new();
    let mut in_sensitive_multiline = false;

    for line in text.lines() {
        if in_sensitive_multiline {
            if triple_quote_count(line) % 2 == 1 {
                in_sensitive_multiline = false;
            }
            continue;
        }

        let assignment = line.split_once('=');
        if let Some((key, value)) = assignment {
            if is_sensitive_key(key) {
                if triple_quote_count(value) % 2 == 1 {
                    in_sensitive_multiline = true;
                }
                continue;
            }
        }

        redacted.push_str(line);
        redacted.push('\n');
    }

    redacted
}

/// Returns sanitized `~/.grok/config.toml` text. Missing or unreadable files are
/// represented as an empty string so opening the panel never becomes an error path.
#[tauri::command]
pub async fn read_grok_config() -> Result<String, String> {
    let config = grok_dir()
        .and_then(|directory| fs::read_to_string(directory.join("config.toml")).ok())
        .unwrap_or_default();
    Ok(redact_config(&config))
}

/// Returns only display-safe account metadata from Grok's local files.
#[tauri::command]
pub async fn read_grok_account() -> Result<GrokAccount, String> {
    let Some(directory) = grok_dir() else {
        return Ok(GrokAccount {
            first_name: String::new(),
            email: String::new(),
            auth_mode: String::new(),
            team_id: String::new(),
            grok_version: String::new(),
            default_model: String::new(),
        });
    };

    // auth.json has one opaque top-level key. Only its value is inspected and
    // only the fields explicitly copied below can leave this process.
    let auth = read_json(directory.join("auth.json"))
        .and_then(|value| {
            value
                .as_object()
                .and_then(|entries| entries.values().next().cloned())
        })
        .unwrap_or(Value::Null);
    let version = read_json(directory.join("version.json")).unwrap_or(Value::Null);
    let models = read_json(directory.join("models_cache.json")).unwrap_or(Value::Null);

    Ok(GrokAccount {
        first_name: string_field(&auth, "first_name"),
        email: string_field(&auth, "email"),
        auth_mode: string_field(&auth, "auth_mode"),
        team_id: string_field(&auth, "team_id"),
        grok_version: find_named_string(&version, &["grok_version", "version", "value"]),
        default_model: find_named_string(&models, &["default_model", "defaultModel"]),
    })
}
