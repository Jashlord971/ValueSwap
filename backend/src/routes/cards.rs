use crate::auth::AuthUser;
use crate::error::AppError;
use crate::models::{CardStatus, GiftCard, RegisterCardRequest};
use crate::firebase::RtdbClient;
use crate::AppState;
use axum::{
    extract::{Extension, State},
    routing::post,
    Json, Router,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/register", post(register_card))
        .route("/check", post(check_card))
}

async fn register_card(State(state): State<Arc<AppState>>, Extension(user): Extension<AuthUser>,
    Json(req): Json<RegisterCardRequest>) -> Result<Json<GiftCard>, AppError> {
    let raw = req.card_number.trim();
    if raw.is_empty() {
        return Err(AppError::BadRequest("card_number is required".into()));
    }
    if req.amount_usd <= 0.0 {
        return Err(AppError::BadRequest("amount_usd must be positive".into()));
    }

    let hash = sha256_hex(raw);

    let db = RtdbClient::new(&state, &user.id_token);
    let all_cards = db.get_collection("cards").await?;
    if all_cards.iter().any(|v| v.get("hash").and_then(|h| h.as_str()) == Some(&hash)) {
        return Err(AppError::BadRequest(
            "This gift card has already been registered on the platform".into(),
        ));
    }

    let card = GiftCard {
        id: Uuid::new_v4().to_string(),
        hash,
        brand: req.brand,
        amount_usd: req.amount_usd,
        status: CardStatus::Active,
        trade_id: req.trade_id,
        reported_by_uid: user.uid,
        created_at: unix_now(),
    };

    db.set(
        &format!("cards/{}", card.id),
        &serde_json::to_value(&card).unwrap(),
    )
    .await?;

    Ok(Json(card))
}

async fn check_card(State(state): State<Arc<AppState>>, Extension(user): Extension<AuthUser>,
    Json(body): Json<serde_json::Value>) -> Result<Json<serde_json::Value>, AppError> {
    let raw = body
        .get("card_number")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::BadRequest("card_number required".into()))?;

    let hash = sha256_hex(raw);
    let db = RtdbClient::new(&state, &user.id_token);
    let all_cards = db.get_collection("cards").await?;
    let count = all_cards
        .iter()
        .filter(|v| v.get("hash").and_then(|h| h.as_str()) == Some(&hash))
        .count();

    Ok(Json(serde_json::json!({
        "seen_before": count > 0,
        "count": count,
    })))
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
