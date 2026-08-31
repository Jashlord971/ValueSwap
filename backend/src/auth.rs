use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::AppState;
use axum::{
    async_trait,
    extract::{ConnectInfo, FromRequestParts, Request, State},
    http::request::Parts,
    middleware::Next,
    response::Response,
    Extension,
};
use std::net::SocketAddr;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc};

const GOOGLE_CERT_URL: &str = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const CERT_CACHE_KEY: &str = "google_signing_certs";
const CERT_REFRESH_LOCK_KEY: &str = "google_signing_certs:refresh_lock";
const CERT_CACHE_FALLBACK_TTL: u64 = 3600;
const CERT_CACHE_MAX_TTL: u64 = 3600;
const CERT_REFRESH_MIN_INTERVAL: u64 = 60;
const BAN_CACHE_TTL: u64 = 30;

fn trust_proxy_headers() -> bool {
    std::env::var("TRUST_PROXY_HEADERS")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

#[derive(Serialize, Deserialize, Clone)]
struct BanStatus {
    banned: bool,
    reason: String,
}

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
    pub ip: Option<String>,
}

fn client_ip_from_req(req: &Request) -> Option<String> {
    let socket_ip = req
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip().to_string());

    if !trust_proxy_headers() {
        return socket_ip;
    }

    let headers = req.headers();
    for header_name in ["cf-connecting-ip", "x-real-ip"] {
        if let Some(v) = headers.get(header_name).and_then(|v| v.to_str().ok()) {
            let ip = v.trim();
            if !ip.is_empty() {
                return Some(ip.to_string());
            }
        }
    }
    if let Some(v) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = v.split(',').next() {
            let ip = first.trim();
            if !ip.is_empty() {
                return Some(ip.to_string());
            }
        }
    }
    socket_ip
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
    let ip = client_ip_from_req(&req);

    let ban_key = format!("authban:{}", claims.sub);
    let ban_status = match state.ttl_cache.get::<BanStatus>(&ban_key).await {
        Some(cached) => cached,
        None => {
            let admin_db = RtdbClient::new_admin(&state);
            let status = match admin_db.get(&format!("users/{}", claims.sub)).await {
                Ok(Some(val)) => BanStatus {
                    banned: val.get("banned").and_then(|v| v.as_bool()).unwrap_or(false),
                    reason: val
                        .get("ban_reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                },
                _ => BanStatus { banned: false, reason: String::new() },
            };
            state.ttl_cache.set(&ban_key, &status, BAN_CACHE_TTL).await;
            status
        }
    };
    if ban_status.banned {
        let suffix = if ban_status.reason.is_empty() {
            String::new()
        } else {
            format!(": {}", ban_status.reason)
        };
        return Err(AppError::Forbidden(format!("Your account has been banned{suffix}")));
    }

    req.extensions_mut().insert(AuthUser {
        uid: claims.sub,
        email: claims.email,
        ip,
    });

    Ok(next.run(req).await)
}

async fn fetch_google_signing_certs(state: &AppState) -> Result<HashMap<String, String>, AppError> {
    let resp = state
        .http_client
        .get(GOOGLE_CERT_URL)
        .send()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let ttl = resp
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(',').find_map(|part| {
                part.trim()
                    .strip_prefix("max-age=")
                    .and_then(|n| n.trim().parse::<u64>().ok())
            })
        })
        .unwrap_or(CERT_CACHE_FALLBACK_TTL)
        .clamp(300, CERT_CACHE_MAX_TTL);

    let certs: HashMap<String, String> = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    state.ttl_cache.set(CERT_CACHE_KEY, &certs, ttl).await;
    Ok(certs)
}

async fn google_signing_certs(state: &AppState) -> Result<HashMap<String, String>, AppError> {
    if let Some(certs) = state.ttl_cache.get::<HashMap<String, String>>(CERT_CACHE_KEY).await {
        return Ok(certs);
    }
    fetch_google_signing_certs(state).await
}

async fn refresh_certs_for_unknown_kid(
    state: &AppState,
    current: HashMap<String, String>,
) -> HashMap<String, String> {
    if state.ttl_cache.get::<bool>(CERT_REFRESH_LOCK_KEY).await.is_some() {
        return current;
    }
    state
        .ttl_cache
        .set(CERT_REFRESH_LOCK_KEY, &true, CERT_REFRESH_MIN_INTERVAL)
        .await;
    match fetch_google_signing_certs(state).await {
        Ok(fresh) => fresh,
        Err(_) => current,
    }
}

async fn verify_firebase_token(state: &AppState, token: &str) -> Result<FirebaseClaims, AppError> {
    let mut certs = google_signing_certs(state).await?;

    let header = decode_header(token).map_err(|_| AppError::Unauthorized("Invalid token header".into()))?;

    let kid = header
        .kid
        .ok_or_else(|| AppError::Unauthorized("Token missing kid claim".into()))?;

    if !certs.contains_key(&kid) {
        certs = refresh_certs_for_unknown_kid(state, certs).await;
    }

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
