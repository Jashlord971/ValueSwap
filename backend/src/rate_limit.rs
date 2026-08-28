use crate::error::AppError;
use crate::AppState;
use std::collections::VecDeque;

/// Generic in-memory sliding-window rate limiter: at most `max_count` calls
/// under this `key` within `window_secs`. Callers compose their own key
/// (e.g. `format!("offer-create:{}", uid)`) so unrelated actions never
/// share a bucket. `what` is a short gerund phrase used in the error
/// message ("creating offers", "editing offers").
pub async fn check_rate_limit(
    state: &AppState,
    key: &str,
    max_count: usize,
    window_secs: u64,
    what: &str,
) -> Result<(), AppError> {
    let now = unix_now();
    let mut map = state.rate_limits.lock().await;
    let entry = map.entry(key.to_string()).or_insert_with(VecDeque::new);

    while let Some(&oldest) = entry.front() {
        if now.saturating_sub(oldest) >= window_secs {
            entry.pop_front();
        } else {
            break;
        }
    }

    if entry.len() >= max_count {
        let oldest = *entry.front().unwrap();
        let retry_after = window_secs.saturating_sub(now.saturating_sub(oldest)).max(1);
        return Err(AppError::BadRequest(format!(
            "You're {what} too often. Try again in {retry_after} seconds."
        )));
    }

    entry.push_back(now);
    Ok(())
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}
