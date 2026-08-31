use crate::error::AppError;
use crate::AppState;
use std::collections::VecDeque;

const MAX_TRACKED_KEYS: usize = 50_000;

pub async fn check_rate_limit(
    state: &AppState,
    key: &str,
    max_count: usize,
    window_secs: u64,
    what: &str,
) -> Result<(), AppError> {
    let now = unix_now();
    let mut map = state.rate_limits.lock().await;

    if !map.contains_key(key) && map.len() >= MAX_TRACKED_KEYS {
        prune(&mut map, now);
        if map.len() >= MAX_TRACKED_KEYS {
            return Err(AppError::BadRequest(
                "Service is busy. Please try again shortly.".into(),
            ));
        }
    }

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

pub async fn sweep(state: &AppState) {
    let now = unix_now();
    let mut map = state.rate_limits.lock().await;
    prune(&mut map, now);
}

fn prune(map: &mut std::collections::HashMap<String, VecDeque<u64>>, now: u64) {
    map.retain(|_, times| {
        while let Some(&oldest) = times.front() {
            if now.saturating_sub(oldest) >= 3600 {
                times.pop_front();
            } else {
                break;
            }
        }
        !times.is_empty()
    });
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}
