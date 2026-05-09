use crate::auth::AuthUser;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{ChatMessage, Trade, TradeStatus};
use crate::AppState;
use axum::{
    extract::{Extension, Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/read-statuses", get(get_read_statuses))
        .route("/:trade_id/messages", get(get_messages).post(send_message))
        .route("/:trade_id/mark-read", post(mark_read))
}

async fn get_messages(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Path(trade_id): Path<String>,
) -> Result<Json<Vec<ChatMessage>>, AppError> {
    let db = RtdbClient::new(&state, &user.id_token);
    ensure_trade_chat_access(&db, &trade_id, &user.uid, false).await?;
    let docs = db.get_collection(&format!("chats/{}/messages", trade_id)).await?;

    let messages = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<ChatMessage>(v).ok())
        .collect::<Vec<_>>();

    Ok(Json(messages))
}

#[derive(Deserialize)]
struct SendMessageRequest {
    text: Option<String>,
    image_url: Option<String>,
}

async fn send_message(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Path(trade_id): Path<String>,
    Json(req): Json<SendMessageRequest>,
) -> Result<Json<ChatMessage>, AppError> {
    let db = RtdbClient::new(&state, &user.id_token);
    ensure_trade_chat_access(&db, &trade_id, &user.uid, true).await?;

    let has_text = req.text.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    let has_image = req.image_url.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);

    if !has_text && !has_image {
        return Err(AppError::BadRequest(
            "Message must contain text or an image URL".into(),
        ));
    }

    if let Some(url) = &req.image_url {
        if !url.starts_with("https://") && !url.starts_with("data:image/") {
            return Err(AppError::BadRequest(
                "image_url must be an HTTPS URL or a base64 data URL".into(),
            ));
        }
    }

    let msg = ChatMessage {
        id: Uuid::new_v4().to_string(),
        trade_id: trade_id.clone(),
        sender_uid: user.uid,
        text: req.text,
        image_url: req.image_url,
        created_at: unix_now(),
    };

    db.set(
        &format!("chats/{}/messages/{}", trade_id, msg.id),
        &serde_json::to_value(&msg).unwrap(),
    )
    .await?;

    Ok(Json(msg))
}

#[derive(Serialize)]
struct ReadStatusResponse {
    last_read_at: u64,
}

async fn mark_read(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Path(trade_id): Path<String>,
) -> Result<Json<ReadStatusResponse>, AppError> {
    let db = RtdbClient::new(&state, &user.id_token);
    ensure_trade_chat_access(&db, &trade_id, &user.uid, false).await?;
    let ts = unix_now();
    db.set(
        &format!("chat_reads/{}/{}", user.uid, trade_id),
        &serde_json::json!({ "last_read_at": ts }),
    )
    .await?;
    Ok(Json(ReadStatusResponse { last_read_at: ts }))
}

async fn get_read_statuses(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<HashMap<String, u64>>, AppError> {
    let db = RtdbClient::new(&state, &user.id_token);
    let val = db.get(&format!("chat_reads/{}", user.uid)).await?;
    let map: HashMap<String, u64> = match val {
        None => HashMap::new(),
        Some(v) => {
            // v is { trade_id: { last_read_at: u64 }, ... }
            v.as_object()
                .map(|obj| {
                    obj.iter()
                        .filter_map(|(k, entry)| {
                            let ts = entry.get("last_read_at")?.as_u64()?;
                            Some((k.clone(), ts))
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
    };
    Ok(Json(map))
}

async fn ensure_trade_chat_access(
    db: &RtdbClient<'_>,
    trade_id: &str,
    uid: &str,
    for_sending: bool,
) -> Result<Trade, AppError> {
    let val = db
        .get(&format!("trades/{}", trade_id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", trade_id)))?;
    let trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if trade.creator_uid != uid && trade.offer_owner_uid != uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }

    if for_sending && matches!(trade.status, TradeStatus::Completed | TradeStatus::Cancelled | TradeStatus::Expired) {
        return Err(AppError::BadRequest("Chat is closed for this trade".into()));
    }

    Ok(trade)
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

