
use crate::AdminAccessTokenCache;
use crate::error::AppError;
use crate::AppState;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::Value;

enum AuthMode<'a> {
    UserToken(&'a str),
    Admin,
}

pub struct RtdbClient<'a> {
    state: &'a AppState,
    mode: AuthMode<'a>,
}

impl<'a> RtdbClient<'a> {
    pub fn new(state: &'a AppState, id_token: &'a str) -> Self {
        Self {
            state,
            mode: AuthMode::UserToken(id_token),
        }
    }

    pub fn new_admin(state: &'a AppState) -> Self {
        Self {
            state,
            mode: AuthMode::Admin,
        }
    }

    fn user_url(&self, path: &str, id_token: &str) -> String {
        format!(
            "{}/{}.json?auth={}",
            self.state.firebase_database_url, path, id_token
        )
    }

    fn bare_url(&self, path: &str) -> String {
        format!("{}/{}.json", self.state.firebase_database_url, path)
    }

    fn bare_root_url(&self) -> String {
        format!("{}/.json", self.state.firebase_database_url)
    }

    async fn admin_access_token(&self) -> Result<String, AppError> {

        if !self.state.firebase_db_secret.trim().is_empty() {
            return Ok(self.state.firebase_db_secret.clone());
        }

        if self.state.firebase_admin_client_email.trim().is_empty()
            || self.state.firebase_admin_private_key.trim().is_empty()
        {
            return Err(AppError::Internal(
                "Admin RTDB auth is not configured. Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_ADMIN_CLIENT_EMAIL/FIREBASE_ADMIN_PRIVATE_KEY".into(),
            ));
        }

        let now = unix_now();
        {
            let cache = self.state.firebase_admin_access_token.lock().await;
            if let Some(cached) = cache.as_ref() {
                if now + 30 < cached.expires_at {
                    return Ok(cached.access_token.clone());
                }
            }
        }

        let scope = "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email";
        let claims = ServiceAccountJwtClaims {
            iss: self.state.firebase_admin_client_email.clone(),
            sub: self.state.firebase_admin_client_email.clone(),
            aud: self.state.firebase_admin_token_uri.clone(),
            scope: scope.to_string(),
            iat: now,
            exp: now + 3600,
        };
        let key = EncodingKey::from_rsa_pem(self.state.firebase_admin_private_key.as_bytes())
            .map_err(|e| AppError::Internal(format!("Invalid service account private key: {}", e)))?;
        let assertion = jsonwebtoken::encode(&Header::new(Algorithm::RS256), &claims, &key)
            .map_err(|e| AppError::Internal(format!("Failed to sign service account JWT: {}", e)))?;

        let token_resp = self
            .state
            .http_client
            .post(&self.state.firebase_admin_token_uri)
            .form(&[
                ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ("assertion", assertion.as_str()),
            ])
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("OAuth token request failed: {}", e)))?;

        if !token_resp.status().is_success() {
            let status = token_resp.status();
            let text = token_resp.text().await.unwrap_or_default();
            return Err(AppError::Internal(format!(
                "OAuth token request failed ({status}): {text}"
            )));
        }

        let token_data: ServiceAccountTokenResponse = token_resp
            .json()
            .await
            .map_err(|e| AppError::Internal(format!("OAuth token parse failed: {}", e)))?;

        let expires_at = now + token_data.expires_in.saturating_sub(60);
        {
            let mut cache = self.state.firebase_admin_access_token.lock().await;
            *cache = Some(AdminAccessTokenCache {
                access_token: token_data.access_token.clone(),
                expires_at,
            });
        }

        Ok(token_data.access_token)
    }

    pub async fn get(&self, path: &str) -> Result<Option<Value>, AppError> {
        let resp = match &self.mode {
            AuthMode::UserToken(id_token) => {
                self.state
                    .http_client
                    .get(self.user_url(path, id_token))
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(e.to_string()))?
            }
            AuthMode::Admin => {
                let auth = self.admin_access_token().await?;
                if self.state.firebase_db_secret.trim().is_empty() {
                    self.state
                        .http_client
                        .get(self.bare_url(path))
                        .bearer_auth(auth)
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                } else {
                    self.state
                        .http_client
                        .get(format!("{}?auth={}", self.bare_url(path), auth))
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                }
            }
        };

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
        let resp = match &self.mode {
            AuthMode::UserToken(id_token) => {
                self.state
                    .http_client
                    .put(self.user_url(path, id_token))
                    .json(data)
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(e.to_string()))?
            }
            AuthMode::Admin => {
                let auth = self.admin_access_token().await?;
                if self.state.firebase_db_secret.trim().is_empty() {
                    self.state
                        .http_client
                        .put(self.bare_url(path))
                        .bearer_auth(auth)
                        .json(data)
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                } else {
                    self.state
                        .http_client
                        .put(format!("{}?auth={}", self.bare_url(path), auth))
                        .json(data)
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                }
            }
        };

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
        let resp = match &self.mode {
            AuthMode::UserToken(id_token) => {
                self.state
                    .http_client
                    .delete(self.user_url(path, id_token))
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(e.to_string()))?
            }
            AuthMode::Admin => {
                let auth = self.admin_access_token().await?;
                if self.state.firebase_db_secret.trim().is_empty() {
                    self.state
                        .http_client
                        .delete(self.bare_url(path))
                        .bearer_auth(auth)
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                } else {
                    self.state
                        .http_client
                        .delete(format!("{}?auth={}", self.bare_url(path), auth))
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                }
            }
        };

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
        let resp = match &self.mode {
            AuthMode::UserToken(id_token) => {
                let url = format!("{}?auth={}", self.bare_root_url(), id_token);
                self.state
                    .http_client
                    .patch(&url)
                    .json(&Value::Object(updates))
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(e.to_string()))?
            }
            AuthMode::Admin => {
                let auth = self.admin_access_token().await?;
                if self.state.firebase_db_secret.trim().is_empty() {
                    self.state
                        .http_client
                        .patch(self.bare_root_url())
                        .bearer_auth(auth)
                        .json(&Value::Object(updates))
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                } else {
                    let url = format!("{}?auth={}", self.bare_root_url(), auth);
                    self.state
                        .http_client
                        .patch(&url)
                        .json(&Value::Object(updates))
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                }
            }
        };

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
        let order_by_val = format!("\"{}\"", order_by);
        let equal_to_val = format!("\"{}\"", equal_to);
        let base_url = self.bare_url(path);
        let resp = match &self.mode {
            AuthMode::UserToken(id_token) => {
                self.state
                    .http_client
                    .get(&base_url)
                    .query(&[
                        ("auth", *id_token),
                        ("orderBy", order_by_val.as_str()),
                        ("equalTo", equal_to_val.as_str()),
                    ])
                    .send()
                    .await
                    .map_err(|e| AppError::Internal(e.to_string()))?
            }
            AuthMode::Admin => {
                let auth = self.admin_access_token().await?;
                if self.state.firebase_db_secret.trim().is_empty() {
                    self.state
                        .http_client
                        .get(&base_url)
                        .bearer_auth(auth)
                        .query(&[
                            ("orderBy", order_by_val.as_str()),
                            ("equalTo", equal_to_val.as_str()),
                        ])
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                } else {
                    self.state
                        .http_client
                        .get(&base_url)
                        .query(&[
                            ("auth", auth.as_str()),
                            ("orderBy", order_by_val.as_str()),
                            ("equalTo", equal_to_val.as_str()),
                        ])
                        .send()
                        .await
                        .map_err(|e| AppError::Internal(e.to_string()))?
                }
            }
        };

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

#[derive(Debug, Serialize)]
struct ServiceAccountJwtClaims {
    iss: String,
    sub: String,
    aud: String,
    scope: String,
    iat: u64,
    exp: u64,
}

#[derive(Debug, Deserialize)]
struct ServiceAccountTokenResponse {
    access_token: String,
    expires_in: u64,
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
