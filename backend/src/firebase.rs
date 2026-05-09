/// Thin wrapper around the Firebase Realtime Database REST API.
/// All requests are authenticated with the end-user's Firebase ID token via
/// the `?auth=` query parameter, so database security rules apply normally.
use crate::error::AppError;
use crate::AppState;
use serde_json::Value;

pub struct RtdbClient<'a> {
    state: &'a AppState,
    id_token: &'a str,
}

impl<'a> RtdbClient<'a> {
    pub fn new(state: &'a AppState, id_token: &'a str) -> Self {
        Self { state, id_token }
    }

    /// Uses the FIREBASE_DATABASE_SECRET (legacy admin token) — for server-side
    /// background tasks that run without a user auth token.
    pub fn new_admin(state: &'a AppState) -> Self {
        Self { state, id_token: &state.firebase_db_secret }
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}/{}.json?auth={}",
            self.state.firebase_database_url, path, self.id_token
        )
    }

    pub async fn get(&self, path: &str) -> Result<Option<Value>, AppError> {
        let resp = self
            .state
            .http_client
            .get(&self.url(path))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "RTDB read failed ({status}): {text}"
            )));
        }

        let val: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        Ok(if val.is_null() { None } else { Some(val) })
    }

    pub async fn set(&self, path: &str, data: &Value) -> Result<(), AppError> {
        let resp = self
            .state
            .http_client
            .put(&self.url(path))
            .json(data)
            .send()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "RTDB write failed ({status}): {text}"
            )));
        }
        Ok(())
    }

    pub async fn delete(&self, path: &str) -> Result<(), AppError> {
        let resp = self
            .state
            .http_client
            .delete(&self.url(path))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "RTDB delete failed ({status}): {text}"
            )));
        }
        Ok(())
    }

    pub async fn get_collection(&self, path: &str) -> Result<Vec<Value>, AppError> {
        match self.get(path).await? {
            None => Ok(vec![]),
            Some(Value::Object(map)) => Ok(map.into_values().collect()),
            Some(other) => Ok(vec![other]),
        }
    }

    pub async fn multi_path_update(&self, updates: serde_json::Map<String, Value>) -> Result<(), AppError> {
        let url = format!(
            "{}/.json?auth={}",
            self.state.firebase_database_url, self.id_token
        );
        let resp = self
            .state
            .http_client
            .patch(&url)
            .json(&Value::Object(updates))
            .send()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "RTDB multi-path update failed ({status}): {text}"
            )));
        }
        Ok(())
    }

    pub async fn query_equal(&self, path: &str, order_by: &str, equal_to: &str) -> Result<Option<Value>, AppError> {
        let resp = self
            .state
            .http_client
            .get(&format!(
                "{}/{}.json",
                self.state.firebase_database_url, path
            ))
            .query(&[
                ("auth", self.id_token),
                ("orderBy", &format!("\"{}\"", order_by)),
                ("equalTo", &format!("\"{}\"", equal_to)),
            ])
            .send()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "RTDB query failed ({status}): {text}"
            )));
        }

        let val: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;

        match &val {
            Value::Null => Ok(None),
            Value::Object(m) if m.is_empty() => Ok(None),
            _ => Ok(Some(val)),
        }
    }
}
