use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::AppState;
use axum::{
    async_trait,
    extract::{FromRequestParts, Request, State},
    http::request::Parts,
    middleware::Next,
    response::Response,
    Extension,
};
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

const GOOGLE_CERT_URL: &str = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FirebaseClaims {
    pub sub: String,
    pub email: Option<String>,
    pub aud: String,
    pub iss: String,
    pub exp: usize,
    pub iat: usize,
}

#[derive(Clone)]
pub struct AuthUser {
    pub uid: String,
    pub email: Option<String>,
    pub id_token: String,
}

pub struct Ctx {
    pub state: Arc<AppState>,
    pub user: AuthUser,
}

#[async_trait]
impl FromRequestParts<Arc<AppState>> for Ctx {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        app_state: &Arc<AppState>,
    ) -> Result<Self, Self::Rejection> {
        let Extension(user) = Extension::<AuthUser>::from_request_parts(parts, app_state)
            .await
            .map_err(|_| AppError::Unauthorized("Missing auth extension".into()))?;
        Ok(Ctx {
            state: Arc::clone(app_state),
            user,
        })
    }
}

pub async fn auth_middleware(State(state): State<Arc<AppState>>, mut req: Request, next: Next) -> Result<Response, AppError> {
    let token = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| AppError::Unauthorized("Missing or malformed Authorization header".into()))?
        .to_owned();

    let claims = verify_firebase_token(&state, &token).await?;

    let admin_db = RtdbClient::new_admin(&state);
    if let Ok(Some(val)) = admin_db.get(&format!("users/{}", claims.sub)).await {
        let banned = val.get("banned").and_then(|v| v.as_bool()).unwrap_or(false);
        if banned {
            let reason = val
                .get("ban_reason")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| format!(": {s}"))
                .unwrap_or_default();
            return Err(AppError::Forbidden(format!("Your account has been banned{reason}")));
        }
    }

    req.extensions_mut().insert(AuthUser {
        uid: claims.sub,
        email: claims.email,
        id_token: token,
    });

    Ok(next.run(req).await)
}

async fn verify_firebase_token(state: &AppState, token: &str) -> Result<FirebaseClaims, AppError> {
    let certs: HashMap<String, String> = state
        .http_client
        .get(GOOGLE_CERT_URL)
        .send()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let header = decode_header(token).map_err(|_| AppError::Unauthorized("Invalid token header".into()))?;

    let kid = header
        .kid
        .ok_or_else(|| AppError::Unauthorized("Token missing kid claim".into()))?;

    let cert_pem = certs
        .get(&kid)
        .ok_or_else(|| AppError::Unauthorized("Unknown signing key".into()))?;

    let decoding_key = DecodingKey::from_rsa_pem(cert_pem.as_bytes())
        .map_err(|_| AppError::Unauthorized("Invalid certificate".into()))?;

    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[&state.firebase_project_id]);
    validation.set_issuer(&[format!(
        "https://securetoken.google.com/{}",
        state.firebase_project_id
    )]);

    let token_data = decode::<FirebaseClaims>(token, &decoding_key, &validation)
        .map_err(|e| AppError::Unauthorized(format!("Token validation failed: {e}")))?;

    Ok(token_data.claims)
}
