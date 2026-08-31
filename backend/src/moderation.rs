use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::AppState;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::Arc;

pub async fn is_moderator_email_cached(state: &AppState, db: &RtdbClient<'_>, email: Option<&str>) -> Result<bool, AppError> {
    let Some(email) = email else { return Ok(false) };
    let email_norm = email.trim().to_lowercase();
    if email_norm.is_empty() {
        return Ok(false);
    }

    const CACHE_KEY: &str = "moderators-list";
    let val: Value = if let Some(cached) = state.ttl_cache.get::<Value>(CACHE_KEY).await {
        cached
    } else {
        let fetched = db.get("moderators").await?.unwrap_or(Value::Null);
        state.ttl_cache.set(CACHE_KEY, &fetched, 3600).await;
        fetched
    };

    Ok(contains_email(&val, &email_norm))
}

fn contains_email(val: &Value, email_norm: &str) -> bool {
    match val {
        Value::String(s) => s.trim().to_lowercase() == email_norm,
        Value::Array(items) => items.iter().any(|v| contains_email(v, email_norm)),
        Value::Object(map) => map.values().any(|v| contains_email(v, email_norm)),
        _ => false,
    }
}

fn collect_emails(val: &Value) -> HashSet<String> {
    let mut out = HashSet::new();
    match val {
        Value::String(s) => {
            out.insert(s.trim().to_lowercase());
        }
        Value::Array(items) => {
            for v in items {
                out.extend(collect_emails(v));
            }
        }
        Value::Object(map) => {
            for v in map.values() {
                out.extend(collect_emails(v));
            }
        }
        _ => {}
    }
    out
}

pub async fn sync_moderator_uid_mirror(state: Arc<AppState>) {
    let db = RtdbClient::new_admin(&state);

    let moderators_val = match db.get("moderators").await {
        Ok(v) => v.unwrap_or(Value::Null),
        Err(e) => { tracing::warn!("moderator uid sync: failed to read moderators list: {e}"); return; }
    };
    let mod_emails = collect_emails(&moderators_val);

    let users_val = match db.get("users").await {
        Ok(v) => v.unwrap_or(Value::Null),
        Err(e) => { tracing::warn!("moderator uid sync: failed to read users: {e}"); return; }
    };
    let Value::Object(users_map) = users_val else { return };

    let mut current_uids = HashSet::new();
    if !mod_emails.is_empty() {
        for (uid, profile) in users_map.iter() {
            let email = profile
                .get("email")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_lowercase());
            if let Some(email) = email {
                if mod_emails.contains(&email) {
                    current_uids.insert(uid.clone());
                }
            }
        }
    }

    let existing_mirror = match db.get("moderator_uids").await {
        Ok(v) => v.unwrap_or(Value::Null),
        Err(e) => { tracing::warn!("moderator uid sync: failed to read moderator_uids mirror: {e}"); return; }
    };
    let existing_uids: Vec<String> = match &existing_mirror {
        Value::Object(m) => m.keys().cloned().collect(),
        _ => vec![],
    };

    let mut updates = serde_json::Map::new();
    for uid in &current_uids {
        if !matches!(&existing_mirror, Value::Object(m) if m.get(uid).and_then(|v| v.as_bool()) == Some(true)) {
            updates.insert(format!("moderator_uids/{}", uid), Value::Bool(true));
        }
    }
    for uid in &existing_uids {
        if !current_uids.contains(uid) {
            updates.insert(format!("moderator_uids/{}", uid), Value::Null);
        }
    }

    if !updates.is_empty() {
        if let Err(e) = db.multi_path_update(updates).await {
            tracing::warn!("moderator uid sync: failed to write mirror updates: {e}");
        }
    }
}
