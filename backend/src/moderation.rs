use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::AppState;
use serde_json::Value;

/// Backed by a shared TTL cache — the moderators list is tiny and changes
/// rarely, so re-fetching it on every single moderator-gated request
/// (dispute resolve, warn, ban, viewing a disputed trade as a non-party)
/// would be pure waste.
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
        state.ttl_cache.set(CACHE_KEY, &fetched, 120).await;
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
