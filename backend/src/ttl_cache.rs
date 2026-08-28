use std::collections::HashMap;
use tokio::sync::Mutex;

/// Generic in-memory TTL cache: get/set by string key, values are anything
/// (de)serializable. One shared instance lives on AppState so every route
/// module can reuse it instead of hand-rolling its own static cache the way
/// PRICE_CACHE did. Also doubles as a cheap "have I done this recently?"
/// throttle — set a trivial marker value and check for its presence.
pub struct TtlCache {
    entries: Mutex<HashMap<String, (u64, serde_json::Value)>>,
}

impl TtlCache {
    pub fn new() -> Self {
        Self { entries: Mutex::new(HashMap::new()) }
    }

    pub async fn get<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        let now = unix_now();
        let map = self.entries.lock().await;
        let (expires_at, val) = map.get(key)?;
        if *expires_at <= now {
            return None;
        }
        serde_json::from_value(val.clone()).ok()
    }

    pub async fn set<T: serde::Serialize>(&self, key: &str, value: &T, ttl_secs: u64) {
        let Ok(v) = serde_json::to_value(value) else { return };
        let now = unix_now();
        let mut map = self.entries.lock().await;
        map.insert(key.to_string(), (now + ttl_secs, v));
    }

    pub async fn invalidate(&self, key: &str) {
        let mut map = self.entries.lock().await;
        map.remove(key);
    }
}

impl Default for TtlCache {
    fn default() -> Self {
        Self::new()
    }
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}
