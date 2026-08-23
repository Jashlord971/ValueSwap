use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{ChatMessage, Trade, TradeStatus};
use crate::presence::{ACTIVE_WINDOW_SECS, HEARTBEAT_MIN_INTERVAL_SECS};
use crate::AppState;
use axum::{
    extract::{Path, Query},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tracing::info;
use uuid::Uuid;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/:trade_id/receipt-status", get(get_partner_receipt_status))
        .route("/:trade_id/sync", get(sync_chat))
        .route("/:trade_id/messages", get(get_messages).post(send_message))
        .route("/:trade_id/mark-delivered", post(mark_delivered))
        .route("/:trade_id/mark-read", post(mark_read))
}

async fn get_messages(ctx: Ctx, Path(trade_id): Path<String>) -> Result<Json<Vec<ChatMessage>>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    ensure_trade_chat_access(&db, &trade_id, &ctx.user.uid, false).await?;

    let docs = db.get_collection(&format!("chats/{}/messages", trade_id)).await?;
    let messages = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<ChatMessage>(v).ok())
        .collect::<Vec<_>>();

    let latest_message_ts = messages.iter().map(|m| m.created_at).max().unwrap_or(0);
    let mut receipt = get_user_receipt(&db, &trade_id, &ctx.user.uid).await?;
    if latest_message_ts > receipt.last_delivered_at {
        receipt.last_delivered_at = latest_message_ts;
        set_user_receipt(&db, &trade_id, &ctx.user.uid, &receipt).await?;
    }

    Ok(Json(messages))
}

#[derive(Deserialize)]
struct SendMessageRequest {
    text: Option<String>,
    image_url: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct SyncChatQuery {
    #[serde(default)]
    since: Option<u64>,
    #[serde(default)]
    ping_presence: Option<bool>,
}

async fn send_message(ctx: Ctx, Path(trade_id): Path<String>, Json(req): Json<SendMessageRequest>) -> Result<Json<ChatMessage>, AppError> {
    let started = Instant::now();
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    ensure_trade_chat_access(&db, &trade_id, &ctx.user.uid, true).await?;
    let sender_uid = ctx.user.uid.clone();

    let text = match req.text {
        Some(raw) => {
            let cleaned = sanitize_chat_text(&raw)?;
            if cleaned.is_empty() { 
                None
            } else { 
                Some(cleaned) 
            }
        }
        None => None
    };

    let image_url = req
        .image_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);

    let has_text = text.is_some();
    let has_image = image_url.is_some();

    if !has_text && !has_image {
        return Err(AppError::BadRequest("Message must contain text or an image URL".into()));
    }

    if let Some(url) = &image_url {
        if !url.starts_with("https://") && !url.starts_with("data:image/") {
            return Err(AppError::BadRequest("image_url must be an HTTPS URL or a base64 data URL".into()));
        }
    }

    let msg = ChatMessage {
        id: Uuid::new_v4().to_string(),
        trade_id: trade_id.clone(),
        sender_uid: sender_uid.clone(),
        text,
        image_url,
        read_at: None,
        read_by_uid: None,
        created_at: unix_now(),
    };

    db.set(
        &format!("chats/{}/messages/{}", trade_id, msg.id),
        &serde_json::to_value(&msg).unwrap(),
    )
    .await?;

    db.set(
        &format!("chats/{}/meta/last_message_at", trade_id),
        &serde_json::json!(msg.created_at),
    )
    .await?;

    info!(
        target: "chat_metrics",
        event = "message_send_persisted",
        trade_id = %trade_id,
        message_id = %msg.id,
        sender_uid = %sender_uid,
        created_at = msg.created_at,
        has_text = msg.text.is_some(),
        has_image = msg.image_url.is_some(),
        elapsed_ms = started.elapsed().as_millis() as u64,
    );

    Ok(Json(msg))
}

fn sanitize_chat_text(input: &str) -> Result<String, AppError> {
    let cleaned = input
        .chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\r' | '\t'))
        .collect::<String>()
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let normalized = cleaned
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if normalized.chars().count() > 2000 {
        return Err(AppError::BadRequest("Message text must be 2000 characters or fewer".into()));
    }

    Ok(normalized)
}

#[derive(Serialize)]
struct ReadStatusResponse {
    last_read_at: u64,
}

#[derive(Serialize)]
struct ReceiptStatusResponse {
    last_delivered_at: u64,
    last_read_at: u64,
}

#[derive(Serialize)]
struct ChatSyncResponse {
    messages: Vec<ChatMessage>,
    partner_receipt: ReceiptStatusResponse,
    partner_active: bool,
    partner_last_active_at: u64,
    trade_open: bool,
}

#[derive(Debug, Deserialize, Default)]
struct ChatReceipt {
    #[serde(default)]
    last_delivered_at: u64,
    #[serde(default)]
    last_read_at: u64,
}

#[derive(Debug, Deserialize, Default)]
struct AppPresence {
    #[serde(default)]
    last_active_at: u64,
}

#[derive(Debug, Deserialize, Default)]
struct ChatMeta {
    #[serde(default)]
    last_message_at: u64,
}

async fn sync_chat(ctx: Ctx, Path(trade_id): Path<String>, Query(query): Query<SyncChatQuery>) -> Result<Json<ChatSyncResponse>, AppError> {
    let started = Instant::now();
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let trade = ensure_trade_chat_access(&db, &trade_id, &ctx.user.uid, false).await?;
    let trade_open = is_trade_open_for_chat(&trade);
    let partner_uid = if trade.creator_uid == ctx.user.uid { trade.offer_owner_uid } else { trade.creator_uid };
    let since_ts = query.since.unwrap_or(0);
    let meta = get_chat_meta(&db, &trade_id).await?;

    let should_fetch_messages = since_ts == 0 || meta.last_message_at >= since_ts;
    let messages = if should_fetch_messages {
        let docs = db.get_collection(&format!("chats/{}/messages", trade_id)).await?;
        docs
            .into_iter()
            .filter_map(|v| serde_json::from_value::<ChatMessage>(v).ok())
            .filter(|m| m.created_at >= since_ts)
            .collect::<Vec<_>>()
    } else {
        vec![]
    };

    let now = unix_now();
    let latest_message_ts = meta.last_message_at;
    let mut receipt = get_user_receipt(&db, &trade_id, &ctx.user.uid).await?;
    let mut updates = serde_json::Map::new();

    if trade_open && latest_message_ts > receipt.last_delivered_at {
        let delivery_lag_secs = now.saturating_sub(latest_message_ts);
        receipt.last_delivered_at = latest_message_ts;
        updates.insert(
            format!("chats/{}/participants/{}/last_delivered_at", trade_id, ctx.user.uid),
            serde_json::json!(receipt.last_delivered_at),
        );
        updates.insert(
            format!("chats/{}/participants/{}/last_read_at", trade_id, ctx.user.uid),
            serde_json::json!(receipt.last_read_at),
        );

        info!(
            target: "chat_metrics",
            event = "delivery_advanced",
            trade_id = %trade_id,
            uid = %ctx.user.uid,
            delivered_message_ts = latest_message_ts,
            delivery_lag_secs,
        );
    }

    let should_ping_presence = trade_open && query.ping_presence.unwrap_or(false);
    if should_ping_presence {
        let self_last_active_at = get_user_presence(&db, &ctx.user.uid).await?.last_active_at;
        if now.saturating_sub(self_last_active_at) >= HEARTBEAT_MIN_INTERVAL_SECS {
            updates.insert(format!("users/{}/last_active_at", ctx.user.uid), serde_json::json!(now));
        }
    }

    if !updates.is_empty() {
        db.multi_path_update(updates).await?;
    }

    let partner_receipt = get_user_receipt(&db, &trade_id, &partner_uid).await?;
    let partner_last_active_at = get_user_presence(&db, &partner_uid).await?.last_active_at;
    let partner_active = now.saturating_sub(partner_last_active_at) <= ACTIVE_WINDOW_SECS;

    info!(
        target: "chat_metrics",
        event = "sync_completed",
        trade_id = %trade_id,
        uid = %ctx.user.uid,
        since_ts,
        returned_messages = messages.len() as u64,
        trade_open,
        partner_active,
        elapsed_ms = started.elapsed().as_millis() as u64,
    );

    Ok(Json(ChatSyncResponse {
        messages,
        partner_receipt: ReceiptStatusResponse {
            last_delivered_at: partner_receipt.last_delivered_at,
            last_read_at: partner_receipt.last_read_at,
        },
        partner_active,
        partner_last_active_at,
        trade_open,
    }))
}

async fn get_partner_receipt_status(ctx: Ctx, Path(trade_id): Path<String>) -> Result<Json<ReceiptStatusResponse>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let trade = ensure_trade_chat_access(&db, &trade_id, &ctx.user.uid, false).await?;
    let partner_uid = if trade.creator_uid == ctx.user.uid {
        trade.offer_owner_uid.clone()
    } else {
        trade.creator_uid.clone()
    };

    let receipt = get_user_receipt(&db, &trade_id, &partner_uid).await?;
    Ok(Json(ReceiptStatusResponse {
        last_delivered_at: receipt.last_delivered_at,
        last_read_at: receipt.last_read_at,
    }))
}

async fn mark_delivered(ctx: Ctx, Path(trade_id): Path<String>) -> Result<Json<ReceiptStatusResponse>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let trade = ensure_trade_chat_access(&db, &trade_id, &ctx.user.uid, false).await?;

    let mut receipt = get_user_receipt(&db, &trade_id, &ctx.user.uid).await?;
    if !is_trade_open_for_chat(&trade) {
        return Ok(Json(ReceiptStatusResponse {
            last_delivered_at: receipt.last_delivered_at,
            last_read_at: receipt.last_read_at,
        }));
    }

    let docs = db.get_collection(&format!("chats/{}/messages", trade_id)).await?;
    let latest_message_ts = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<ChatMessage>(v).ok())
        .map(|m| m.created_at)
        .max()
        .unwrap_or(0);

    if latest_message_ts > receipt.last_delivered_at {
        receipt.last_delivered_at = latest_message_ts;
        set_user_receipt(&db, &trade_id, &ctx.user.uid, &receipt).await?;
    }

    Ok(Json(ReceiptStatusResponse {
        last_delivered_at: receipt.last_delivered_at,
        last_read_at: receipt.last_read_at,
    }))
}

async fn mark_read(ctx: Ctx, Path(trade_id): Path<String>) -> Result<Json<ReadStatusResponse>, AppError> {
    let started = Instant::now();
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let trade = ensure_trade_chat_access(&db, &trade_id, &ctx.user.uid, false).await?;
    let partner_uid = if trade.creator_uid == ctx.user.uid {
        trade.offer_owner_uid.clone()
    } else {
        trade.creator_uid.clone()
    };

    let receipt = get_user_receipt(&db, &trade_id, &ctx.user.uid).await?;
    if !is_trade_open_for_chat(&trade) {
        return Ok(Json(ReadStatusResponse {last_read_at: receipt.last_read_at}));
    }
    let previous_read_at = receipt.last_read_at;
    let now = unix_now();
    let docs = db.get_collection(&format!("chats/{}/messages", trade_id)).await?;
    let mut latest_partner_message_ts = 0;
    let mut unread_partner_message_ids: Vec<String> = Vec::new();
    let mut read_lag_total_secs: u64 = 0;
    let mut read_lag_count: u64 = 0;
    let mut read_lag_max_secs: u64 = 0;

    let mut updates = serde_json::Map::new();
    for raw_message in docs {
        let Ok(message) = serde_json::from_value::<ChatMessage>(raw_message) else {
            continue;
        };

        if message.sender_uid != partner_uid {
            continue;
        }

        latest_partner_message_ts = latest_partner_message_ts.max(message.created_at);
        if message.read_at.is_some() || message.created_at < previous_read_at {
            continue;
        }
        let lag = now.saturating_sub(message.created_at);
        read_lag_total_secs = read_lag_total_secs.saturating_add(lag);
        read_lag_count = read_lag_count.saturating_add(1);
        read_lag_max_secs = read_lag_max_secs.max(lag);
        unread_partner_message_ids.push(message.id);
    }

    let next_delivered_at = receipt.last_delivered_at.max(latest_partner_message_ts);
    let next_read_at = receipt.last_read_at.max(latest_partner_message_ts);
    for message_id in unread_partner_message_ids {
        updates.insert(format!("chats/{}/messages/{}/read_at", trade_id, message_id), serde_json::json!(next_read_at));
        updates.insert(format!("chats/{}/messages/{}/read_by_uid", trade_id, message_id), serde_json::json!(ctx.user.uid));
    }

    if next_delivered_at != receipt.last_delivered_at || next_read_at != receipt.last_read_at {
        updates.insert(
            format!("chats/{}/participants/{}/last_delivered_at", trade_id, ctx.user.uid),
            serde_json::json!(next_delivered_at),
        );
        updates.insert(
            format!("chats/{}/participants/{}/last_read_at", trade_id, ctx.user.uid),
            serde_json::json!(next_read_at),
        );
    }

    if !updates.is_empty() {
        db.multi_path_update(updates).await?;
    }

    if read_lag_count > 0 {
        info!(
            target: "chat_metrics",
            event = "read_advanced",
            trade_id = %trade_id,
            uid = %ctx.user.uid,
            read_messages = read_lag_count,
            avg_read_lag_secs = read_lag_total_secs / read_lag_count,
            max_read_lag_secs = read_lag_max_secs,
            elapsed_ms = started.elapsed().as_millis() as u64,
        );
    } else {
        info!(
            target: "chat_metrics",
            event = "read_noop",
            trade_id = %trade_id,
            uid = %ctx.user.uid,
            elapsed_ms = started.elapsed().as_millis() as u64,
        );
    }

    Ok(Json(ReadStatusResponse {last_read_at: next_read_at}))
}

async fn ensure_trade_chat_access(db: &RtdbClient<'_>, trade_id: &str, uid: &str, for_sending: bool) -> Result<Trade, AppError> {
    let val = db
        .get(&format!("trades/{}", trade_id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", trade_id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", trade_id), &serde_json::to_value(&trade).unwrap()).await?;
    }

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

fn chat_participant_path(trade_id: &str, uid: &str) -> String {
    format!("chats/{}/participants/{}", trade_id, uid)
}

fn legacy_chat_receipt_path(trade_id: &str, uid: &str) -> String {
    format!("chat_receipts/{}/{}", trade_id, uid)
}

fn is_trade_open_for_chat(trade: &Trade) -> bool {
    !matches!(trade.status, TradeStatus::Completed | TradeStatus::Cancelled | TradeStatus::Expired)
        && !(matches!(trade.status, TradeStatus::Open | TradeStatus::Pending)
            && trade.expires_at > 0
            && unix_now() >= trade.expires_at)
}

fn apply_effective_trade_status(trade: &mut Trade) -> bool {
    if matches!(trade.status, TradeStatus::Open | TradeStatus::Pending)
        && trade.expires_at > 0
        && unix_now() >= trade.expires_at
    {
        trade.status = TradeStatus::Expired;
        return true;
    }
    false
}

async fn get_user_receipt(db: &RtdbClient<'_>, trade_id: &str, uid: &str) -> Result<ChatReceipt, AppError> {
    let nested_path = chat_participant_path(trade_id, uid);
    if let Some(val) = db.get(&nested_path).await? {
        return Ok(serde_json::from_value::<ChatReceipt>(val).unwrap_or_default());
    }

    let legacy_path = legacy_chat_receipt_path(trade_id, uid);
    let Some(val) = db.get(&legacy_path).await? else {
        return Ok(ChatReceipt::default());
    };
    Ok(serde_json::from_value::<ChatReceipt>(val).unwrap_or_default())
}

async fn get_user_presence(db: &RtdbClient<'_>, uid: &str) -> Result<AppPresence, AppError> {
    if let Some(val) = db.get(&format!("users/{}", uid)).await? {
        if let Some(last_active_at) = val
            .get("last_active_at")
            .and_then(|v| v.as_u64())
        {
            return Ok(AppPresence { last_active_at });
        }
    }

    Ok(AppPresence::default())
}

async fn get_chat_meta(db: &RtdbClient<'_>, trade_id: &str) -> Result<ChatMeta, AppError> {
    if let Some(val) = db.get(&format!("chats/{}/meta", trade_id)).await? {
        return Ok(serde_json::from_value::<ChatMeta>(val).unwrap_or_default());
    }

    let Some(val) = db.get(&format!("chat_meta/{}", trade_id)).await? else {
        return Ok(ChatMeta::default());
    };
    Ok(serde_json::from_value::<ChatMeta>(val).unwrap_or_default())
}

async fn set_user_receipt(db: &RtdbClient<'_>, trade_id: &str, uid: &str, receipt: &ChatReceipt) -> Result<(), AppError> {
    let path = chat_participant_path(trade_id, uid);
    let data = &serde_json::json!(
        {
            "last_delivered_at": receipt.last_delivered_at,
            "last_read_at": receipt.last_read_at
        }
    );
    db.set(&path, data)
    .await
}

