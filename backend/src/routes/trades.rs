use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{CreateTradeRequest, LeaveTradeFeedbackRequest, Offer, Trade, TradeFeedback, TradeStatus, UserProfile};
use crate::AppState;
use axum::{
    extract::Path,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use uuid::Uuid;

static EXPIRE_SKIP_LOGGED: AtomicBool = AtomicBool::new(false);

#[derive(serde::Deserialize, Default)]
struct CancelRequest {
    reason: Option<String>,
}

#[derive(serde::Deserialize)]
struct ResolveDisputeRequest {
    winner_uid: String,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_trades).post(create_trade))
        .route("/:id", get(get_trade))
        .route("/:id/complete", post(complete_trade))
        .route("/:id/cancel", post(cancel_trade))
        .route("/:id/mark-paid", post(mark_paid))
        .route("/:id/dispute", post(dispute_trade))
    .route("/:id/resolve-dispute", post(resolve_dispute))
        .route("/:id/feedback", post(leave_feedback))
}

async fn list_trades(ctx: Ctx) -> Result<Json<Vec<Trade>>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let docs = db.get_collection("trades").await?;

    let mut trades = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Trade>(v).ok())
        .filter(|t| t.creator_uid == ctx.user.uid || t.offer_owner_uid == ctx.user.uid)
        .collect::<Vec<_>>();

    trades.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    for trade in &mut trades {
        resolve_trade_usernames(trade, &db).await;
    }

    Ok(Json(trades))
}

async fn create_trade(ctx: Ctx, Json(req): Json<CreateTradeRequest>) -> Result<Json<Trade>, AppError> {
    if req.fiat_amount <= 0.0 || req.crypto_amount <= 0.0 {
        return Err(AppError::BadRequest("Amounts must be positive".into()));
    }
    if req.coin.trim().is_empty() {
        return Err(AppError::BadRequest("Coin is required".into()));
    }

    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);

    let offer_val = db
        .get(&format!("offers/{}", req.offer_id))
        .await?
        .ok_or_else(|| AppError::NotFound("Offer not found".into()))?;
    let offer = serde_json::from_value::<Offer>(offer_val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.creator_uid == ctx.user.uid {
        return Err(AppError::BadRequest("Cannot trade on your own offer".into()));
    }
    if offer.status != crate::models::OfferStatus::Active {
        return Err(AppError::BadRequest("Offer is not active".into()));
    }

    match (offer.min_amount, offer.max_amount) {
        (Some(min), Some(max)) => {
            if req.fiat_amount < min || req.fiat_amount > max {
                return Err(AppError::BadRequest(format!(
                    "Trade amount must be within offer range: {:.2} to {:.2} {}",
                    min, max, offer.currency
                )));
            }
        }
        _ => {
            return Err(AppError::BadRequest(
                "This offer has no valid amount range and cannot be traded".into(),
            ));
        }
    }

    let (seller_uid, _buyer_uid) = seller_buyer_for_offer(&offer, &ctx.user.uid);

    // Lock the crypto holder's funds into escrow as soon as trade opens.
    lock_escrow(&db, &seller_uid, &req.coin.to_lowercase(), req.crypto_amount).await?;

    let fee_pct = crate::models::payment_methods()
        .into_iter()
        .find(|pm| pm.id == offer.card)
        .map(|pm| pm.escrow_fee_pct)
        .unwrap_or(1.0);
    let fee_amount = req.crypto_amount * (fee_pct / 100.0);

    let time_limit = match offer.time_limit_secs {
        900 | 1800 | 3600 => offer.time_limit_secs,
        _ => 1800,
    };

    let now = unix_now();
    let trade = Trade {
        id: Uuid::new_v4().to_string(),
        creator_uid: ctx.user.uid.clone(),
        offer_owner_uid: offer.creator_uid.clone(),
        offer_id: offer.id.clone(),
        card: offer.card.clone(),
        currency: offer.currency.clone(),
        offer_type: format!("{:?}", offer.offer_type).to_lowercase(),
        profit_pct: offer.profit_pct,
        terms: offer.terms.clone(),
        fiat_amount: req.fiat_amount,
        crypto_amount: req.crypto_amount,
        coin: req.coin.to_uppercase(),
        time_limit_secs: time_limit,
        expires_at: now + time_limit,
        status: TradeStatus::Open,
        created_at: now,
        escrow_locked_amount: req.crypto_amount,
        escrow_fee_amount: fee_amount,
        escrow_released: false,
        cancel_reason: None,
        feedback: vec![],
        creator_username: None,
        offer_owner_username: None,
        creator_avatar_number: None,
        offer_owner_avatar_number: None,
    };

    db.set(
        &format!("trades/{}", trade.id),
        &serde_json::to_value(&trade).unwrap(),
    )
    .await?;

    Ok(Json(trade))
}

async fn get_trade(ctx: Ctx, Path(id): Path<String>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("trades/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    resolve_trade_usernames(&mut trade, &db).await;
    Ok(Json(trade))
}

async fn complete_trade(ctx: Ctx, Path(id): Path<String>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("trades/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if seller_uid_for_trade(&trade) != ctx.user.uid {
        return Err(AppError::Forbidden("Only the seller can complete this trade".into()));
    }
    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if !matches!(trade.status, TradeStatus::Open | TradeStatus::Paid) {
        return Err(AppError::BadRequest("Trade cannot be completed in its current state".into()));
    }
    if unix_now() > trade.expires_at && matches!(trade.status, TradeStatus::Open) {
        trade.status = TradeStatus::Expired;
        db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
        return Err(AppError::BadRequest("Trade has expired".into()));
    }

    if !trade.escrow_released {
        release_escrow_to_user(
            &db,
            &seller_uid_for_trade(&trade),
            &buyer_uid_for_trade(&trade),
            &trade.coin.to_lowercase(),
            trade.escrow_locked_amount,
            trade.escrow_fee_amount,
        )
        .await?;
        trade.escrow_released = true;
    }

    trade.status = TradeStatus::Completed;
    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    Ok(Json(trade))
}

async fn cancel_trade(ctx: Ctx, Path(id): Path<String>, body: Option<Json<CancelRequest>>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("trades/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if matches!(trade.status, TradeStatus::Completed | TradeStatus::Expired) {
        return Err(AppError::BadRequest("Cannot cancel a completed or expired trade".into()));
    }

    if !trade.escrow_released {
        release_escrow_back(
            &db,
            &seller_uid_for_trade(&trade),
            &trade.coin.to_lowercase(),
            trade.escrow_locked_amount,
        )
        .await?;
        trade.escrow_released = true;
    }

    trade.status = TradeStatus::Cancelled;
    if let Some(Json(req)) = body {
        trade.cancel_reason = req.reason.filter(|r| !r.trim().is_empty());
    }
    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    Ok(Json(trade))
}

pub async fn expire_stale_trades(state: Arc<AppState>) {
    let db = RtdbClient::new_admin(&state);
    let docs = match db.get_collection("trades").await {
        Ok(d) => d,
        Err(e) => {
            let msg = e.to_string().to_lowercase();
            if msg.contains("permission denied") || msg.contains("401") {
                if !EXPIRE_SKIP_LOGGED.swap(true, Ordering::Relaxed) {
                    tracing::info!(
                        "expire_stale_trades skipped: RTDB rules require authenticated user context"
                    );
                }
            } else {
                tracing::warn!("expire_stale_trades: list failed: {e}");
            }
            return;
        }
    };

    let now = unix_now();
    let mut expired_count = 0u32;

    for val in docs {
        if let Ok(mut trade) = serde_json::from_value::<Trade>(val) {
            if matches!(trade.status, TradeStatus::Pending | TradeStatus::Open)
                && now > trade.expires_at
            {
                if !trade.escrow_released {
                    let _ = release_escrow_back(
                        &db,
                        &seller_uid_for_trade(&trade),
                        &trade.coin.to_lowercase(),
                        trade.escrow_locked_amount,
                    ).await;
                    trade.escrow_released = true;
                }
                trade.status = TradeStatus::Expired;
                let _ = db.set(
                    &format!("trades/{}", trade.id),
                    &serde_json::to_value(&trade).unwrap(),
                ).await;
                expired_count += 1;
            }
        }
    }

    if expired_count > 0 {
        tracing::info!("Cron: expired {} trade(s)", expired_count);
    }
}

async fn mark_paid(ctx: Ctx, Path(id): Path<String>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db.get(&format!("trades/{}", id)).await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if !matches!(trade.status, TradeStatus::Open) {
        return Err(AppError::BadRequest("Trade must be open to mark as paid".into()));
    }

    trade.status = TradeStatus::Paid;
    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    Ok(Json(trade))
}

async fn dispute_trade(ctx: Ctx, Path(id): Path<String>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db.get(&format!("trades/{}", id)).await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if !matches!(trade.status, TradeStatus::Open | TradeStatus::Paid) {
        return Err(AppError::BadRequest("Trade cannot be disputed in its current state".into()));
    }

    trade.status = TradeStatus::Disputed;
    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    Ok(Json(trade))
}

async fn resolve_dispute(ctx: Ctx, Path(id): Path<String>, Json(req): Json<ResolveDisputeRequest>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("trades/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if !matches!(trade.status, TradeStatus::Disputed) {
        return Err(AppError::BadRequest("Only disputed trades can be resolved".into()));
    }
    if req.winner_uid != trade.creator_uid && req.winner_uid != trade.offer_owner_uid {
        return Err(AppError::BadRequest("winner_uid must be one of the trade counterparties".into()));
    }

    if !trade.escrow_released {
        release_escrow_to_user(
            &db,
            &seller_uid_for_trade(&trade),
            &req.winner_uid,
            &trade.coin.to_lowercase(),
            trade.escrow_locked_amount,
            trade.escrow_fee_amount,
        )
        .await?;
        trade.escrow_released = true;
    }

    trade.status = TradeStatus::Completed;
    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    Ok(Json(trade))
}

async fn leave_feedback(ctx: Ctx, Path(id): Path<String>, Json(req): Json<LeaveTradeFeedbackRequest>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("trades/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if !matches!(trade.status, TradeStatus::Completed) {
        return Err(AppError::BadRequest("Feedback is only available for completed trades".into()));
    }
    if trade.feedback.iter().any(|entry| entry.from_uid == ctx.user.uid) {
        return Err(AppError::BadRequest("You have already left feedback for this trade".into()));
    }

    let comment = sanitize_feedback_comment(&req.comment)?;

    let to_uid = if trade.creator_uid == ctx.user.uid {
        trade.offer_owner_uid.clone()
    } else {
        trade.creator_uid.clone()
    };

    trade.feedback.push(TradeFeedback {
        from_uid: ctx.user.uid,
        to_uid,
        positive: req.positive,
        comment,
        created_at: unix_now(),
    });

    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    increment_feedback_totals(&db, &trade.feedback.last().unwrap().to_uid, req.positive).await?;
    resolve_trade_usernames(&mut trade, &db).await;
    Ok(Json(trade))
}

async fn increment_feedback_totals(
    db: &RtdbClient<'_>,
    uid: &str,
    positive: bool,
) -> Result<(), AppError> {
    let path = format!("users/{}", uid);
    let Some(val) = db.get(&path).await? else {
        tracing::warn!("leave_feedback: user profile missing for uid {}", uid);
        return Ok(());
    };

    let mut profile = serde_json::from_value::<UserProfile>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if positive {
        profile.feedback_pos = profile.feedback_pos.saturating_add(1);
    } else {
        profile.feedback_neg = profile.feedback_neg.saturating_add(1);
    }

    db.set(&path, &serde_json::to_value(&profile).unwrap()).await?;
    Ok(())
}

fn sanitize_feedback_comment(input: &str) -> Result<String, AppError> {
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

    let len = normalized.chars().count();
    if len < 5 || len > 500 {
        return Err(AppError::BadRequest("Feedback text must be between 5 and 500 characters".into()));
    }

    Ok(normalized)
}

async fn read_f64_path(db: &RtdbClient<'_>, path: &str) -> Result<f64, AppError> {
    Ok(db
        .get(path)
        .await?
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0))
}

async fn lock_escrow(db: &RtdbClient<'_>, uid: &str, coin: &str, amount: f64) -> Result<(), AppError> {
    let coin = coin.to_lowercase();
    let bal_path = format!("balances/{}/{}", uid, coin);
    let esc_path = format!("escrow_balances/{}/{}", uid, coin);

    let available = read_f64_path(db, &bal_path).await?;
    if available < amount {
        return Err(AppError::BadRequest(format!(
            "Insufficient {} balance for escrow: have {:.8}, need {:.8}",
            coin.to_uppercase(),
            available,
            amount
        )));
    }
    let escrowed = read_f64_path(db, &esc_path).await?;

    let mut updates = serde_json::Map::new();
    updates.insert(bal_path, serde_json::json!(available - amount));
    updates.insert(esc_path, serde_json::json!(escrowed + amount));
    db.multi_path_update(updates).await
}

async fn release_escrow_back(db: &RtdbClient<'_>, uid: &str, coin: &str, amount: f64) -> Result<(), AppError> {
    let coin = coin.to_lowercase();
    let bal_path = format!("balances/{}/{}", uid, coin);
    let esc_path = format!("escrow_balances/{}/{}", uid, coin);

    let available = read_f64_path(db, &bal_path).await?;
    let escrowed = read_f64_path(db, &esc_path).await?;
    if escrowed + 1e-12 < amount {
        return Err(AppError::Internal("Escrow underflow while releasing funds".into()));
    }

    let mut updates = serde_json::Map::new();
    updates.insert(bal_path, serde_json::json!(available + amount));
    updates.insert(esc_path, serde_json::json!((escrowed - amount).max(0.0)));
    db.multi_path_update(updates).await
}

async fn release_escrow_to_user(
    db: &RtdbClient<'_>,
    seller_uid: &str,
    winner_uid: &str,
    coin: &str,
    amount: f64,
    fee: f64,
) -> Result<(), AppError> {
    let coin = coin.to_lowercase();
    let esc_path = format!("escrow_balances/{}/{}", seller_uid, coin);
    let win_bal_path = format!("balances/{}/{}", winner_uid, coin);
    let fee_path = format!("platform_fees/{}", coin);

    let escrowed = read_f64_path(db, &esc_path).await?;
    if escrowed + 1e-12 < amount {
        return Err(AppError::Internal("Escrow underflow while settling trade".into()));
    }
    let winner_bal = read_f64_path(db, &win_bal_path).await?;
    let fee_bal = read_f64_path(db, &fee_path).await?;

    let fee = fee.clamp(0.0, amount);
    let payout = amount - fee;

    let mut updates = serde_json::Map::new();
    updates.insert(esc_path, serde_json::json!((escrowed - amount).max(0.0)));
    updates.insert(win_bal_path, serde_json::json!(winner_bal + payout));
    updates.insert(fee_path, serde_json::json!(fee_bal + fee));
    db.multi_path_update(updates).await
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

async fn resolve_trade_usernames(trade: &mut Trade, db: &RtdbClient<'_>) {
    async fn fetch_user_meta(db: &RtdbClient<'_>, uid: &str) -> (Option<String>, Option<u8>) {
        let Some(v) = db.get(&format!("users/{}", uid)).await.ok().flatten() else {
            return (None, None);
        };

        let username = v
            .get("username")
            .and_then(|x| x.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);

        let avatar_number = v
            .get("avatar_number")
            .and_then(|x| x.as_u64())
            .and_then(|n| u8::try_from(n).ok())
            .filter(|n| (1..=21).contains(n));

        (username, avatar_number)
    }

    let (creator_username, creator_avatar_number) = fetch_user_meta(db, &trade.creator_uid).await;
    let (offer_owner_username, offer_owner_avatar_number) = fetch_user_meta(db, &trade.offer_owner_uid).await;

    trade.creator_username = creator_username;
    trade.creator_avatar_number = creator_avatar_number;
    trade.offer_owner_username = offer_owner_username;
    trade.offer_owner_avatar_number = offer_owner_avatar_number;
}

fn seller_buyer_for_offer(offer: &Offer, taker_uid: &str) -> (String, String) {
    match offer.offer_type {
        crate::models::OfferType::Buy => (offer.creator_uid.clone(), taker_uid.to_string()),
        crate::models::OfferType::Sell => (taker_uid.to_string(), offer.creator_uid.clone()),
    }
}

fn seller_uid_for_trade(trade: &Trade) -> String {
    if trade.offer_type == "buy" {
        trade.offer_owner_uid.clone()
    } else {
        trade.creator_uid.clone()
    }
}

fn buyer_uid_for_trade(trade: &Trade) -> String {
    if trade.offer_type == "buy" {
        trade.creator_uid.clone()
    } else {
        trade.offer_owner_uid.clone()
    }
}