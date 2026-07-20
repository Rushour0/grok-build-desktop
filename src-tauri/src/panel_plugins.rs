//! Read-only inventory for Grok's locally installed bundle and marketplaces.
//!
//! The filesystem is the authority for installed entries. The bundled manifest is
//! also inspected because some bundle versions list entries there before their
//! category directory is materialized; both sources are merged and deduplicated.

use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

const CATEGORIES: [&str; 4] = ["skills", "agents", "personas", "roles"];

fn grok_directory() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".grok"))
}

fn directory_names(directory: &Path) -> BTreeSet<String> {
    fs::read_dir(directory)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            entry
                .file_type()
                .ok()?
                .is_dir()
                .then(|| entry.file_name().into_string().ok())?
        })
        .collect()
}

fn manifest_entries(value: &Value, entries: &mut [BTreeSet<String>; 4]) {
    match value {
        Value::String(path) => {
            let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
            for (index, category) in CATEGORIES.iter().enumerate() {
                if let Some(position) = parts.iter().position(|part| part == category) {
                    if let Some(name) = parts.get(position + 1) {
                        entries[index].insert((*name).to_string());
                    }
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                manifest_entries(value, entries);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                manifest_entries(value, entries);
            }
        }
        _ => {}
    }
}

fn installed_entries(grok_directory: &Path) -> [BTreeSet<String>; 4] {
    let bundled_directory = grok_directory.join("bundled");
    let vendor_directory = grok_directory.join("vendor");
    let mut entries = std::array::from_fn(|_| BTreeSet::new());

    for (index, category) in CATEGORIES.iter().enumerate() {
        entries[index].extend(directory_names(&bundled_directory.join(category)));
        entries[index].extend(directory_names(&vendor_directory.join(category)));
    }

    if let Ok(manifest) = fs::read_to_string(bundled_directory.join("manifest.json")) {
        if let Ok(value) = serde_json::from_str::<Value>(&manifest) {
            manifest_entries(&value, &mut entries);
        }
    }

    entries
}

fn toml_value(raw_value: &str) -> Option<String> {
    let value = raw_value.trim();
    let quote = value.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }

    let end = value[1..].find(quote)? + 1;
    Some(value[1..end].to_string())
}

fn marketplace_sources(config: &Path) -> Vec<Value> {
    let Ok(contents) = fs::read_to_string(config) else {
        return Vec::new();
    };

    let mut sources = Vec::new();
    let mut current: Option<(String, String)> = None;

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line == "[[marketplace.sources]]" {
            if let Some((name, git)) = current.take() {
                sources.push(json!({ "name": name, "git": git }));
            }
            current = Some((String::new(), String::new()));
            continue;
        }

        if line.starts_with('[') {
            if let Some((name, git)) = current.take() {
                sources.push(json!({ "name": name, "git": git }));
            }
            continue;
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let Some((name, git)) = current.as_mut() else {
            continue;
        };
        let Some(value) = toml_value(raw_value) else {
            continue;
        };

        match key.trim() {
            "name" => *name = value,
            "git" => *git = value,
            _ => {}
        }
    }

    if let Some((name, git)) = current {
        sources.push(json!({ "name": name, "git": git }));
    }

    sources
}

/// Returns the locally installed Grok bundle categories and configured marketplace
/// sources. All reads are best-effort: a missing or malformed Grok installation
/// simply produces empty lists for the inspector panel.
#[tauri::command]
pub async fn plugin_inventory() -> Result<Value, String> {
    let Some(grok_directory) = grok_directory() else {
        return Ok(json!({
            "skills": [],
            "agents": [],
            "personas": [],
            "roles": [],
            "marketplace": [],
        }));
    };

    let entries = installed_entries(&grok_directory);
    Ok(json!({
        "skills": entries[0].iter().collect::<Vec<_>>(),
        "agents": entries[1].iter().collect::<Vec<_>>(),
        "personas": entries[2].iter().collect::<Vec<_>>(),
        "roles": entries[3].iter().collect::<Vec<_>>(),
        "marketplace": marketplace_sources(&grok_directory.join("config.toml")),
    }))
}
