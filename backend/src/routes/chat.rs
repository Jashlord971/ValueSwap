use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{ChatMessage, Trade, TradeStatus};
use crate::moderation::is_moderator_email_cached;
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

fn redact_message_for(mut msg: ChatMessage, viewer_uid: &str, viewer_is_moderator: bool) -> ChatMessage {
    if msg.visibility == "moderator_only" && msg.sender_uid != viewer_uid && !viewer_is_moderator {
        msg.text = None;
        msg.image_url = None;
        msg.media_type = None;
        msg.redacted = true;
    }
    msg
}

async fn get_messages(ctx: Ctx, Path(trade_id): Path<String>) -> Result<Json<Vec<ChatMessage>>, AppError> {
    let db = RtdbClient::new_admin(&ctx.state);
    let trade = ensure_trade_chat_access(&ctx.state, &db, &trade_id, &ctx.user.uid, ctx.user.email.as_deref(), false).await?;
    let viewer_is_moderator = trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid;

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

    let messages = messages
        .into_iter()
        .map(|m| redact_message_for(m, &ctx.user.uid, viewer_is_moderator))
        .collect::<Vec<_>>();

    Ok(Json(messages))
}

const MAX_IMAGE_DATA_URL_LEN: usize = 4_200_000;
const MAX_VIDEO_DATA_URL_LEN: usize = 105_000_000;
const MAX_MESSAGES_PER_PARTY_AFTER_DISPUTE: usize = 10;

#[derive(Deserialize)]
struct SendMessageRequest {
    text: Option<String>,
    image_url: Option<String>,
    #[serde(default)]
    media_type: Option<String>,
    #[serde(default)]
    visibility: Option<String>,
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
    let db = RtdbClient::new_admin(&ctx.state);
    let trade = ensure_trade_chat_access(&ctx.state, &db, &trade_id, &ctx.user.uid, ctx.user.email.as_deref(), true).await?;
    let sender_uid = ctx.user.uid.clone();

    crate::rate_limit::check_rate_limit(
        &ctx.state, &format!("chat-send:{}:{}", sender_uid, trade_id), 20, 60, "sending messages in this chat",
    ).await?;

    if matches!(trade.status, TradeStatus::Disputed) {
        if let Some(raised_at) = trade.dispute_raised_at {
            let docs = db.get_collection(&format!("chats/{}/messages", trade_id)).await?;
            let sent_since_dispute = docs
                .into_iter()
                .filter_map(|v| serde_json::from_value::<ChatMessage>(v).ok())
                .filter(|m| m.sender_uid == sender_uid && m.created_at >= raised_at)
                .count();

            if sent_since_dispute >= MAX_MESSAGES_PER_PARTY_AFTER_DISPUTE {
                return Err(AppError::BadRequest(format!(
                    "You've reached the {}-message limit after opening a dispute. A moderator will review this trade.",
                    MAX_MESSAGES_PER_PARTY_AFTER_DISPUTE
                )));
            }
        }
    }

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

    let media_type = if has_image {
        match req.media_type.as_deref() {
            Some("video") => Some("video".to_string()),
            Some("image") | None => Some("image".to_string()),
            Some(other) => return Err(AppError::BadRequest(format!("Unsupported media_type: {}", other))),
        }
    } else {
        None
    };

    let visibility = match req.visibility.as_deref() {
        Some("moderator_only") => "moderator_only".to_string(),
        Some("everyone") | None => "everyone".to_string(),
        Some(other) => return Err(AppError::BadRequest(format!("Unsupported visibility: {}", other))),
    };

    if let Some(url) = &image_url {
        let is_data_media = url.starts_with("data:image/") || url.starts_with("data:video/");
        if !url.starts_with("https://") && !is_data_media {
            return Err(AppError::BadRequest("image_url must be an HTTPS URL or a base64 data URL".into()));
        }
        let is_video = media_type.as_deref() == Some("video");
        let cap = if is_video { MAX_VIDEO_DATA_URL_LEN } else { MAX_IMAGE_DATA_URL_LEN };
        if url.len() > cap {
            return Err(AppError::BadRequest(format!(
                "Attachment is too large. {} must be under {}MB.",
                if is_video { "Videos" } else { "Images" },
                if is_video { 75 } else { 3 },
            )));
        }
    }

    let sender_role = if trade.creator_uid == sender_uid || trade.offer_owner_uid == sender_uid {
        None
    } else {
        Some("moderator".to_string())
    };

    let msg = ChatMessage {
        id: Uuid::new_v4().to_string(),
        trade_id: trade_id.clone(),
        sender_uid: sender_uid.clone(),
        text,
        image_url,
        media_type,
        visibility,
        redacted: false,
        read_at: None,
        read_by_uid: None,
        sender_role,
        is_system: false,
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
    let db = RtdbClient::new_admin(&ctx.state);
    let trade = ensure_trade_chat_access(&ctx.state, &db, &trade_id, &ctx.user.uid, ctx.user.email.as_deref(), false).await?;
    let trade_open = is_trade_open_for_chat(&trade);
    let viewer_is_moderator = trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid;
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
            .map(|m| redact_message_for(m, &ctx.user.uid, viewer_is_moderator))
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
    let db = RtdbClient::new_admin(&ctx.state);
    let trade = ensure_trade_chat_access(&ctx.state, &db, &trade_id, &ctx.user.uid, ctx.user.email.as_deref(), false).await?;
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
    let db = RtdbClient::new_admin(&ctx.state);
    let trade = ensure_trade_chat_access(&ctx.state, &db, &trade_id, &ctx.user.uid, ctx.user.email.as_deref(), false).await?;

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
    let db = RtdbClient::new_admin(&ctx.state);
    let trade = ensure_trade_chat_access(&ctx.state, &db, &trade_id, &ctx.user.uid, ctx.user.email.as_deref(), false).await?;
    let partner_uid = if trade.creator_uid == ctx.user.uid {
        trade.offer_owner_uid.clone()
    } else {
        trade.creator_uid.clone()
    };

    let receipt = get_user_receipt(&db, &trade_id, &ctx.user.uid).await?;

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

async fn ensure_trade_chat_access(state: &AppState, db: &RtdbClient<'_>, trade_id: &str, uid: &str, email: Option<&str>, for_sending: bool) -> Result<Trade, AppError> {
    let val = db
        .get(&format!("trades/{}", trade_id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", trade_id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", trade_id), &serde_json::to_value(&trade).unwrap()).await?;
    }

    let is_party = trade.creator_uid == uid || trade.offer_owner_uid == uid;
    if !is_party {

        if !matches!(trade.status, TradeStatus::Disputed) || !is_moderator_email_cached(state, db, email).await? {
            return Err(AppError::Forbidden("Not a party to this trade".into()));
        }
        if for_sending {
            if trade.dispute_resolved {
                return Err(AppError::BadRequest("This dispute has already been resolved".into()));
            }
        } else {
            announce_moderator_join(db, trade_id, uid).await?;
        }
        return Ok(trade);
    }

    if for_sending && matches!(trade.status, TradeStatus::Completed | TradeStatus::Cancelled | TradeStatus::Expired) {
        return Err(AppError::BadRequest("Chat is closed for this trade".into()));
    }

    Ok(trade)
}

async fn post_system_message(
    db: &RtdbClient<'_>,
    trade_id: &str,
    sender_uid: &str,
    sender_role: Option<&str>,
    text: &str,
) -> Result<(), AppError> {
    post_system_message_with_id(db, trade_id, Uuid::new_v4().to_string(), sender_uid, sender_role, text).await
}

async fn post_system_message_with_id(
    db: &RtdbClient<'_>,
    trade_id: &str,
    message_id: String,
    sender_uid: &str,
    sender_role: Option<&str>,
    text: &str,
) -> Result<(), AppError> {
    let msg = ChatMessage {
        id: message_id,
        trade_id: trade_id.to_string(),
        sender_uid: sender_uid.to_string(),
        text: Some(text.to_string()),
        image_url: None,
        media_type: None,
        visibility: "everyone".to_string(),
        redacted: false,
        read_at: None,
        read_by_uid: None,
        sender_role: sender_role.map(|s| s.to_string()),
        is_system: true,
        created_at: unix_now(),
    };

    db.set(&format!("chats/{}/messages/{}", trade_id, msg.id), &serde_json::to_value(&msg).unwrap()).await?;
    db.set(&format!("chats/{}/meta/last_message_at", trade_id), &serde_json::json!(msg.created_at)).await?;
    Ok(())
}

pub async fn insert_dispute_notice(db: &RtdbClient<'_>, trade_id: &str, raiser_uid: &str, text: &str) -> Result<(), AppError> {
    let full_text = format!(
        "{text}\n\n\
        We will look to resolve this dispute within 96 hours of this claim being made.\n\n\
        Both parties: please add evidence here in the chat to help a moderator resolve this quickly. Good evidence includes:\n\
        - A screen recording of the payment being sent (or not received)\n\
        - Payment receipts or bank/app confirmation screenshots\n\
        - Transaction IDs or reference numbers\n\
        - Timestamps showing when payment was expected vs. sent\n\n\
        When attaching evidence, you can choose to show it to the entire chat or keep it visible to the moderator only. \
        Each of you can send up to {MAX_MESSAGES_PER_PARTY_AFTER_DISPUTE} messages after this dispute, so make them count."
    );
    post_system_message(db, trade_id, raiser_uid, None, &full_text).await
}

pub async fn insert_dispute_resolved_notice(db: &RtdbClient<'_>, trade_id: &str, resolver_uid: &str) -> Result<(), AppError> {
    post_system_message(
        db,
        trade_id,
        resolver_uid,
        Some("moderator"),
        "This dispute has been resolved by a moderator.",
    ).await
}

pub async fn insert_payment_verifying_notice(db: &RtdbClient<'_>, trade_id: &str, buyer_uid: &str) -> Result<(), AppError> {
    post_system_message(
        db,
        trade_id,
        buyer_uid,
        None,
        "Your partner is verifying the payment and will be with you shortly.",
    ).await
}

async fn announce_moderator_join(db: &RtdbClient<'_>, trade_id: &str, moderator_uid: &str) -> Result<(), AppError> {
    let marker_path = format!("chats/{}/moderator_notices/{}", trade_id, moderator_uid);
    if db.get(&marker_path).await?.is_some() {
        return Ok(());
    }

    let message_id = format!("modjoin-{}", moderator_uid);
    post_system_message_with_id(db, trade_id, message_id, moderator_uid, Some("moderator"), "Moderator entered the chat").await?;
    db.set(&marker_path, &serde_json::json!(true)).await?;
    Ok(())
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
