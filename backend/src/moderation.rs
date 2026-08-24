use crate::error::AppError;
use crate::firebase::RtdbClient;
use serde_json::Value;

pub async fn is_moderator_email(db: &RtdbClient<'_>, email: Option<&str>) -> Result<bool, AppError> {
    let Some(email) = email else { return Ok(false) };
    let email_norm = email.trim().to_lowercase();
    if email_norm.is_empty() {
        return Ok(false);
    }

    let Some(val) = db.get("moderators").await? else {
        return Ok(false);
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
