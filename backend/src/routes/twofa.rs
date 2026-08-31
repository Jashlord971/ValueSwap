use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::UserProfile;
use crate::{AppState, TotpAttemptState};
use axum::{routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use totp_rs::{Algorithm, Secret, TOTP};

use super::withdrawal::{decrypt_mnemonic as decrypt_secret, encrypt_mnemonic as encrypt_secret};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/setup", post(setup_2fa))
        .route("/confirm", post(confirm_2fa))
        .route("/disable", post(disable_2fa))
        .route("/verify-login", post(verify_login_2fa))
}

const ISSUER: &str = "CardSwap";

fn build_totp(secret_b32: &str, account_label: &str) -> Result<TOTP, AppError> {
    let secret_bytes = Secret::Encoded(secret_b32.to_string())
        .to_bytes()
        .map_err(|_| AppError::Internal("Invalid TOTP secret".into()))?;
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret_bytes,
        Some(ISSUER.to_string()),
        account_label.to_string(),
    )
    .map_err(|e| AppError::Internal(format!("TOTP setup failed: {e}")))
}

fn account_label(user: &crate::auth::AuthUser) -> String {
    user.email.clone().unwrap_or_else(|| user.uid.clone())
}

const MAX_TOTP_ATTEMPTS: u32 = 3;
const TOTP_LOCKOUT_SECS: u64 = 60;

async fn verify_totp_with_rate_limit(state: &AppState, uid: &str, totp: &TOTP, code: &str) -> Result<(), AppError> {
    let now = unix_now();

    {
        let attempts = state.totp_attempts.lock().await;
        if let Some(entry) = attempts.get(uid) {
            if entry.locked_until > now {
                return Err(AppError::BadRequest(format!(
                    "Too many incorrect codes. Try again in {} seconds.",
                    entry.locked_until - now
                )));
            }
        }
    }

    let ok = code.len() == 6 && totp.check_current(code).unwrap_or(false);

    let mut attempts = state.totp_attempts.lock().await;
    if ok {
        attempts.remove(uid);
        return Ok(());
    }

    let entry = attempts.entry(uid.to_string()).or_insert(TotpAttemptState { failures: 0, locked_until: 0 });
    entry.failures += 1;

    if entry.failures >= MAX_TOTP_ATTEMPTS {
        entry.failures = 0;
        entry.locked_until = now + TOTP_LOCKOUT_SECS;
        Err(AppError::BadRequest(format!(
            "Too many incorrect codes. Try again in {} seconds.",
            TOTP_LOCKOUT_SECS
        )))
    } else {
        let remaining = MAX_TOTP_ATTEMPTS - entry.failures;
        Err(AppError::BadRequest(format!(
            "Incorrect code. {} attempt{} remaining before a short lockout.",
            remaining,
            if remaining == 1 { "" } else { "s" }
        )))
    }
}

async fn load_profile(db: &RtdbClient<'_>, uid: &str) -> Result<UserProfile, AppError> {
    let val = db
        .get(&format!("users/{}", uid))
        .await?
        .ok_or_else(|| AppError::NotFound("Profile not found — call POST /users/me first".into()))?;
    serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Serialize)]
struct SetupResponse {
    secret: String,
    otpauth_url: String,
    qr_base64: String,
}

async fn setup_2fa(ctx: Ctx) -> Result<Json<SetupResponse>, AppError> {
    let db = RtdbClient::new_admin(&ctx.state);
    let profile = load_profile(&db, &ctx.user.uid).await?;
    if profile.totp_enabled {
        return Err(AppError::BadRequest("2FA is already enabled — disable it first to set up a new device.".into()));
    }

    let secret_b32 = Secret::generate_secret().to_encoded().to_string();
    let totp = build_totp(&secret_b32, &account_label(&ctx.user))?;
    let otpauth_url = totp.get_url();
    let qr_base64 = totp
        .get_qr_base64()
        .map_err(|e| AppError::Internal(format!("QR generation failed: {e}")))?;

    let enc = encrypt_secret(&secret_b32, &ctx.state.mnemonic_key)?;
    db.set(
        &format!("totp_pending/{}", ctx.user.uid),
        &serde_json::json!({ "enc": enc, "created_at": unix_now() }),
    )
    .await?;

    Ok(Json(SetupResponse {
        secret: secret_b32,
        otpauth_url,
        qr_base64: format!("data:image/png;base64,{}", qr_base64),
    }))
}

#[derive(Deserialize)]
struct CodeRequest {
    code: String,
}

fn normalize_code(raw: &str) -> String {
    raw.trim().chars().filter(|c| c.is_ascii_digit()).collect()
}

async fn confirm_2fa(ctx: Ctx, Json(req): Json<CodeRequest>) -> Result<Json<UserProfile>, AppError> {
    let db = RtdbClient::new_admin(&ctx.state);
    let pending_path = format!("totp_pending/{}", ctx.user.uid);
    let pending = db
        .get(&pending_path)
        .await?
        .ok_or_else(|| AppError::BadRequest("No pending 2FA setup found — start setup again.".into()))?;
    let enc = pending
        .get("enc")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Internal("Malformed pending 2FA record".into()))?
        .to_string();
    let secret_b32 = decrypt_secret(&enc, &ctx.state.mnemonic_key)?;

    let totp = build_totp(&secret_b32, &account_label(&ctx.user))?;
    let code = normalize_code(&req.code);
    verify_totp_with_rate_limit(&ctx.state, &ctx.user.uid, &totp, &code).await?;

    let path = format!("users/{}", ctx.user.uid);
    let mut profile = load_profile(&db, &ctx.user.uid).await?;
    profile.totp_enabled = true;
    profile.totp_secret_enc = Some(enc);
    db.set(&path, &serde_json::to_value(&profile).unwrap()).await?;
    db.delete(&pending_path).await?;

    Ok(Json(profile.redacted()))
}

async fn disable_2fa(ctx: Ctx, Json(req): Json<CodeRequest>) -> Result<Json<UserProfile>, AppError> {
    let db = RtdbClient::new_admin(&ctx.state);
    let path = format!("users/{}", ctx.user.uid);
    let mut profile = load_profile(&db, &ctx.user.uid).await?;

    if !profile.totp_enabled {
        return Err(AppError::BadRequest("2FA is not enabled.".into()));
    }
    let enc = profile
        .totp_secret_enc
        .clone()
        .ok_or_else(|| AppError::Internal("2FA enabled but no secret stored".into()))?;
    let secret_b32 = decrypt_secret(&enc, &ctx.state.mnemonic_key)?;
    let totp = build_totp(&secret_b32, &account_label(&ctx.user))?;
    let code = normalize_code(&req.code);
    verify_totp_with_rate_limit(&ctx.state, &ctx.user.uid, &totp, &code).await?;

    profile.totp_enabled = false;
    profile.totp_secret_enc = None;

    profile.require_release_code = false;
    profile.withdraw_code_required = false;
    db.set(&path, &serde_json::to_value(&profile).unwrap()).await?;

    Ok(Json(profile.redacted()))
}

#[derive(Serialize)]
struct VerifyLoginResponse {
    ok: bool,
}

async fn verify_login_2fa(ctx: Ctx, Json(req): Json<CodeRequest>) -> Result<Json<VerifyLoginResponse>, AppError> {
    let db = RtdbClient::new_admin(&ctx.state);
    let profile = load_profile(&db, &ctx.user.uid).await?;

    if !profile.totp_enabled {
        return Ok(Json(VerifyLoginResponse { ok: true }));
    }
    let enc = profile
        .totp_secret_enc
        .ok_or_else(|| AppError::Internal("2FA enabled but no secret stored".into()))?;
    let secret_b32 = decrypt_secret(&enc, &ctx.state.mnemonic_key)?;
    let totp = build_totp(&secret_b32, &account_label(&ctx.user))?;
    let code = normalize_code(&req.code);
    verify_totp_with_rate_limit(&ctx.state, &ctx.user.uid, &totp, &code).await?;

    Ok(Json(VerifyLoginResponse { ok: true }))
}

pub async fn require_valid_totp_if_gated(
    state: &AppState,
    email: Option<&str>,
    uid: &str,
    gated: bool,
    profile: &UserProfile,
    supplied_code: Option<&str>,
) -> Result<(), AppError> {
    let _ = uid;
    if !gated {
        return Ok(());
    }
    if !profile.totp_enabled {
        return Err(AppError::BadRequest(
            "This action requires a confirmation code, but 2FA isn't set up yet. Set it up in Settings first.".into(),
        ));
    }
    let enc = profile
        .totp_secret_enc
        .as_deref()
        .ok_or_else(|| AppError::Internal("2FA enabled but no secret stored".into()))?;
    let secret_b32 = decrypt_secret(enc, &state.mnemonic_key)?;
    let label = email.unwrap_or(uid).to_string();
    let totp = build_totp(&secret_b32, &label)?;

    let code = supplied_code.map(normalize_code).unwrap_or_default();
    if code.len() != 6 {
        return Err(AppError::BadRequest("Enter the 6-digit code from your authenticator app.".into()));
    }
    verify_totp_with_rate_limit(state, uid, &totp, &code).await
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}
