use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{CompleteTradeRequest, CreateTradeRequest, DisputeTradeRequest, LeaveTradeFeedbackRequest, Offer, Trade, TradeFeedback, TradeStatus, UserProfile};
use crate::moderation::is_moderator_email_cached;
use crate::AppState;
use axum::{
    extract::Path,
    routing::{get, post},
    Json, Router,
};
use std::collections::HashMap;
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
        .route("/disputes", get(list_disputes))
        .route("/:id", get(get_trade))
        .route("/:id/complete", post(complete_trade))
        .route("/:id/cancel", post(cancel_trade))
        .route("/:id/mark-paid", post(mark_paid))
        .route("/:id/dispute", post(dispute_trade))
        .route("/:id/resolve-dispute", post(resolve_dispute))
        .route("/:id/feedback", post(leave_feedback))
        .route("/:id/feedback/edit", post(edit_feedback))
}

async fn list_trades(ctx: Ctx) -> Result<Json<Vec<Trade>>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let docs = db.get_collection("trades").await?;

    let mut trades = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Trade>(v).ok())
        .filter(|t| t.creator_uid == ctx.user.uid || t.offer_owner_uid == ctx.user.uid)
        .collect::<Vec<_>>();

    for trade in &mut trades {
        if apply_effective_trade_status(trade) {
            db.set(&format!("trades/{}", trade.id), &serde_json::to_value(&trade).unwrap()).await?;
        }
    }

    trades.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    // One fetch of the whole users collection instead of 2 round-trips per
    // trade (resolve_trade_usernames) — with N trades that was N+1-style
    // sequential Firebase calls and was the main reason this list was slow.
    let users_map = fetch_users_meta_map(&ctx.state).await;
    for trade in &mut trades {
        apply_trade_usernames_from_map(trade, &users_map);
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
        return Err(AppError::BadRequest("Offer is no longer active. Refresh offers and try again.".into()));
    }

    enforce_active_trade_caps(&db, &ctx.user.uid, &offer.creator_uid).await?;

    let requested_coin = req.coin.trim().to_uppercase();
    let offer_coin = offer.coin.trim().to_uppercase();
    if requested_coin != offer_coin {
        return Err(AppError::BadRequest(format!("Trade coin must match offer coin: {}", offer_coin)));
    }

    match (offer.min_amount, offer.max_amount) {
        (Some(min), Some(max)) => {
            if req.fiat_amount < min || req.fiat_amount > max {
                return Err(AppError::BadRequest(format!("Trade amount must be within offer range: {:.2} to {:.2} {}",
                    min, max, offer.currency
                )));
            }
        }
        _ => {
            return Err(AppError::BadRequest("This offer has no valid amount range and cannot be traded".into()));
        }
    }

    let coin_price_usd = fetch_coin_usd_price(&ctx.state, &offer_coin).await?;
    let fiat_to_usd = convert_to_usd(&ctx.state, 1.0, &offer.currency).await?;
    let escrow_fee_pct = payment_method_escrow_fee_pct(&offer.card);
    let required_locked = required_locked_crypto_for_fiat(
        req.fiat_amount,
        fiat_to_usd,
        coin_price_usd,
        offer.profit_pct,
        escrow_fee_pct,
    )
    .ok_or_else(|| AppError::BadRequest("Invalid offer pricing configuration".into()))?;

    if req.crypto_amount + 1e-12 < required_locked {
        return Err(AppError::BadRequest(format!("Insufficient crypto amount for this fiat value. Required at least {:.8} {}",
            required_locked,
            offer_coin
        )));
    }

    let (seller_uid, _buyer_uid) = seller_buyer_for_offer(&offer, &ctx.user.uid);

    lock_escrow(&db, &seller_uid, &offer_coin.to_lowercase(), req.crypto_amount).await?;

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
        dispute_resolved: false,
        dispute_winner_uid: None,
        dispute_resolved_at: None,
        dispute_resolved_by_uid: None,
        dispute_raised_by_uid: None,
        dispute_reason_category: None,
        dispute_reason_text: None,
        dispute_raised_at: None,
        cancel_reason: None,
        feedback: vec![],
        creator_username: None,
        offer_owner_username: None,
        creator_avatar_number: None,
        offer_owner_avatar_number: None,
        creator_last_active_at: None,
        offer_owner_last_active_at: None,
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
    let is_party = trade.creator_uid == ctx.user.uid || trade.offer_owner_uid == ctx.user.uid;
    if !is_party {

        let is_disputed = matches!(trade.status, TradeStatus::Disputed);
        if !is_disputed || !is_moderator_email_cached(&ctx.state, &db, ctx.user.email.as_deref()).await? {
            return Err(AppError::Forbidden("Not a party to this trade".into()));
        }
    }
    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    }
    resolve_trade_usernames(&mut trade, &ctx.state).await;
    Ok(Json(trade))
}

async fn list_disputes(ctx: Ctx) -> Result<Json<Vec<Trade>>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    if !is_moderator_email_cached(&ctx.state, &db, ctx.user.email.as_deref()).await? {
        return Err(AppError::Forbidden("Moderator access required".into()));
    }

    let docs = db.get_collection("trades").await?;
    let mut trades = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Trade>(v).ok())
        .filter(|t| matches!(t.status, TradeStatus::Disputed) && !t.dispute_resolved)
        .collect::<Vec<_>>();

    trades.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let users_map = fetch_users_meta_map(&ctx.state).await;
    for trade in &mut trades {
        apply_trade_usernames_from_map(trade, &users_map);
    }

    Ok(Json(trades))
}

async fn complete_trade(ctx: Ctx, Path(id): Path<String>, Json(req): Json<CompleteTradeRequest>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("trades/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    }

    if seller_uid_for_trade(&trade) != ctx.user.uid {
        return Err(AppError::Forbidden("Only the seller can complete this trade".into()));
    }
    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if trade.creator_uid == trade.offer_owner_uid {
        return Err(AppError::BadRequest("Invalid trade participants".into()));
    }

    let releaser_profile = fetch_user_profile(&db, &ctx.user.uid).await?;
    super::twofa::require_valid_totp_if_gated(
        &ctx.state,
        ctx.user.email.as_deref(),
        &ctx.user.uid,
        releaser_profile.require_release_code,
        &releaser_profile,
        req.totp_code.as_deref(),
    ).await?;
    if !trade.escrow_locked_amount.is_finite() || trade.escrow_locked_amount <= 0.0 {
        return Err(AppError::BadRequest("Invalid escrow amount for completion".into()));
    }
    if !trade.escrow_fee_amount.is_finite() || trade.escrow_fee_amount < 0.0 || trade.escrow_fee_amount > trade.escrow_locked_amount {
        return Err(AppError::BadRequest("Invalid escrow fee state for completion".into()));
    }
    if trade.coin.trim().is_empty() {
        return Err(AppError::BadRequest("Invalid trade coin for completion".into()));
    }
    if trade.escrow_released {
        return Err(AppError::BadRequest("Trade escrow state is invalid for completion".into()));
    }

    ensure_escrow_available_for_completion(
        &db,
        &seller_uid_for_trade(&trade),
        &trade.coin,
        trade.escrow_locked_amount,
    )
    .await?;

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

    if let Err(e) = super::wallet::record_transaction(
        &db,
        &buyer_uid_for_trade(&trade),
        "trade",
        "in",
        &trade.coin,
        trade.escrow_locked_amount - trade.escrow_fee_amount,
        Some(&seller_uid_for_trade(&trade)),
        None,
        Some(&trade.id),
    ).await {
        tracing::warn!("Failed to record trade transaction for {}: {}", trade.id, e);
    }

    trade.status = TradeStatus::Completed;
    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;

    let rebalance_state = ctx.state.clone();
    let seller_uid = seller_uid_for_trade(&trade);
    let buyer_uid = buyer_uid_for_trade(&trade);
    tokio::spawn(async move {
        if let Err(e) = super::offers::rebalance_active_offers_for_user(rebalance_state.clone(), &seller_uid).await {
            tracing::warn!("complete_trade rebalance failed for seller {}: {}", seller_uid, e);
        }
        if buyer_uid != seller_uid {
            if let Err(e) = super::offers::rebalance_active_offers_for_user(rebalance_state, &buyer_uid).await {
                tracing::warn!("complete_trade rebalance failed for buyer {}: {}", buyer_uid, e);
            }
        }
    });

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
    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    }

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if matches!(trade.status, TradeStatus::Completed | TradeStatus::Expired) {
        return Err(AppError::BadRequest("Cannot cancel a completed or expired trade".into()));
    }
    if trade.dispute_resolved {
        return Err(AppError::BadRequest("Cannot cancel a trade whose dispute has already been resolved".into()));
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
            if matches!(trade.status, TradeStatus::Pending | TradeStatus::Open) && now > trade.expires_at {
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
                let _ = db.set(&format!("trades/{}", trade.id), &serde_json::to_value(&trade).unwrap()).await;
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

    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    }

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if buyer_uid_for_trade(&trade) != ctx.user.uid {
        return Err(AppError::Forbidden("Only the buyer can mark this trade as paid".into()));
    }
    if !matches!(trade.status, TradeStatus::Open) {
        return Err(AppError::BadRequest("Trade must be open to mark as paid".into()));
    }

    trade.status = TradeStatus::Paid;
    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;

    if let Err(e) = super::chat::insert_payment_verifying_notice(&db, &id, &ctx.user.uid).await {
        tracing::warn!("Failed to post payment-verifying notice to chat for trade {}: {}", id, e);
    }

    Ok(Json(trade))
}

fn sanitize_dispute_text(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Please explain the issue before submitting the dispute".into()));
    }
    if trimmed.chars().count() > 2000 {
        return Err(AppError::BadRequest("Dispute explanation must be 2000 characters or fewer".into()));
    }
    let sanitized: String = trimmed
        .chars()
        .filter(|&c| c != '<' && c != '>' && c != '\0' && (c >= ' ' || c == '\n' || c == '\t'))
        .collect();
    Ok(sanitized)
}

async fn dispute_trade(ctx: Ctx, Path(id): Path<String>, Json(req): Json<DisputeTradeRequest>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db.get(&format!("trades/{}", id)).await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    }

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    if !matches!(trade.status, TradeStatus::Open | TradeStatus::Paid) {
        return Err(AppError::BadRequest("Trade cannot be disputed in its current state".into()));
    }

    let reason_text = sanitize_dispute_text(&req.reason_text)?;

    trade.status = TradeStatus::Disputed;
    trade.dispute_raised_by_uid = Some(ctx.user.uid.clone());
    trade.dispute_reason_category = Some(req.reason_category.label().to_string());
    trade.dispute_reason_text = Some(reason_text.clone());
    trade.dispute_raised_at = Some(unix_now());
    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;

    let raiser_label = fetch_username(&db, &ctx.user.uid).await
        .map(|u| format!("@{}", u))
        .unwrap_or_else(|| "A trade participant".to_string());
    let notice_text = format!(
        "Dispute in progress. {} raised this dispute — {}.\n\n{}",
        raiser_label,
        req.reason_category.label(),
        reason_text,
    );
    if let Err(e) = super::chat::insert_dispute_notice(&db, &id, &ctx.user.uid, &notice_text).await {
        tracing::warn!("Failed to post dispute notice to chat for trade {}: {}", id, e);
    }

    Ok(Json(trade))
}

async fn fetch_username(db: &RtdbClient<'_>, uid: &str) -> Option<String> {
    let v = db.get(&format!("users/{}", uid)).await.ok().flatten()?;
    v.get("username")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

async fn resolve_dispute(ctx: Ctx, Path(id): Path<String>, Json(req): Json<ResolveDisputeRequest>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("trades/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    }

    if !is_moderator_email_cached(&ctx.state, &db, ctx.user.email.as_deref()).await? {
        return Err(AppError::Forbidden("Moderator access required".into()));
    }
    if !matches!(trade.status, TradeStatus::Disputed) {
        return Err(AppError::BadRequest("Only disputed trades can be resolved".into()));
    }
    if trade.dispute_resolved {
        return Err(AppError::BadRequest("This dispute has already been resolved".into()));
    }
    if req.winner_uid != trade.creator_uid && req.winner_uid != trade.offer_owner_uid {
        return Err(AppError::BadRequest("winner_uid must be one of the trade counterparties".into()));
    }

    if !trade.escrow_released {
        release_escrow_to_user(&db, &seller_uid_for_trade(&trade), &req.winner_uid,
            &trade.coin.to_lowercase(), trade.escrow_locked_amount, trade.escrow_fee_amount
        )
        .await?;
        trade.escrow_released = true;

        let other_party = if req.winner_uid == trade.creator_uid { &trade.offer_owner_uid } else { &trade.creator_uid };
        if let Err(e) = super::wallet::record_transaction(
            &db,
            &req.winner_uid,
            "trade",
            "in",
            &trade.coin,
            trade.escrow_locked_amount - trade.escrow_fee_amount,
            Some(other_party),
            Some("dispute resolution"),
            Some(&trade.id),
        ).await {
            tracing::warn!("Failed to record dispute-resolution transaction for {}: {}", trade.id, e);
        }
    }

    trade.dispute_resolved = true;
    trade.dispute_winner_uid = Some(req.winner_uid.clone());
    trade.dispute_resolved_at = Some(unix_now());
    trade.dispute_resolved_by_uid = Some(ctx.user.uid.clone());
    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;

    if let Err(e) = super::chat::insert_dispute_resolved_notice(&db, &id, &ctx.user.uid).await {
        tracing::warn!("Failed to post dispute-resolved notice to chat for trade {}: {}", id, e);
    }

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

    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    }

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    ensure_feedback_eligible(&trade, &ctx.user.uid)?;
    if trade.feedback.iter().any(|entry| entry.from_uid == ctx.user.uid) {
        return Err(AppError::BadRequest("You have already left feedback for this trade".into()));
    }

    if let Some(existing_trade_id) = find_existing_feedback_trade_for_offer(
        &db,
        &trade.offer_id,
        &ctx.user.uid,
        Some(&trade.id),
    )
    .await?
    {
        return Err(AppError::BadRequest(format!(
            "You already left feedback for this offer on trade '{}'. Edit your existing feedback instead.",
            existing_trade_id
        )));
    }

    let comment = sanitize_feedback_comment(&req.comment)?;

    let to_uid = if trade.creator_uid == ctx.user.uid {
        trade.offer_owner_uid.clone()
    } else {
        trade.creator_uid.clone()
    };

    trade.feedback.push(TradeFeedback {
        from_uid: ctx.user.uid,
        to_uid: to_uid.clone(),
        positive: req.positive,
        comment,
        created_at: unix_now(),
    });

    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    apply_feedback_delta(&db, &to_uid, req.positive, 1).await?;
    resolve_trade_usernames(&mut trade, &ctx.state).await;
    Ok(Json(trade))
}

async fn edit_feedback(ctx: Ctx, Path(id): Path<String>, Json(req): Json<LeaveTradeFeedbackRequest>) -> Result<Json<Trade>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("trades/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Trade '{}' not found", id)))?;
    let mut trade = serde_json::from_value::<Trade>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if apply_effective_trade_status(&mut trade) {
        db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    }

    if trade.creator_uid != ctx.user.uid && trade.offer_owner_uid != ctx.user.uid {
        return Err(AppError::Forbidden("Not a party to this trade".into()));
    }
    ensure_feedback_eligible(&trade, &ctx.user.uid)?;

    let comment = sanitize_feedback_comment(&req.comment)?;

    let Some(entry) = trade.feedback.iter_mut()
        .find(|entry| entry.from_uid == ctx.user.uid) else {
        if let Some(existing_trade_id) = find_existing_feedback_trade_for_offer(
            &db,
            &trade.offer_id,
            &ctx.user.uid,
            Some(&trade.id),
        )
        .await?
        {
            return Err(AppError::BadRequest(format!(
                "You already left feedback for this offer on trade '{}'. Edit that feedback entry instead.",
                existing_trade_id
            )));
        }
        return Err(AppError::BadRequest("You have not left feedback for this trade yet".into()));
    };

    let old_positive = entry.positive;
    let target_uid = entry.to_uid.clone();
    entry.positive = req.positive;
    entry.comment = comment;

    if old_positive != req.positive {
        apply_feedback_delta(&db, &target_uid, old_positive, -1).await?;
        apply_feedback_delta(&db, &target_uid, req.positive, 1).await?;
    }

    db.set(&format!("trades/{}", id), &serde_json::to_value(&trade).unwrap()).await?;
    resolve_trade_usernames(&mut trade, &ctx.state).await;
    Ok(Json(trade))
}

async fn find_existing_feedback_trade_for_offer(db: &RtdbClient<'_>, offer_id: &str, from_uid: &str, exclude_trade_id: Option<&str>)
    -> Result<Option<String>, AppError> {
    let docs = db.get_collection("trades").await?;

    for val in docs {
        let Ok(trade) = serde_json::from_value::<Trade>(val) else {
            continue;
        };

        if trade.offer_id != offer_id {
            continue;
        }
        if exclude_trade_id.is_some_and(|excluded| excluded == trade.id) {
            continue;
        }
        if trade.feedback.iter().any(|entry| entry.from_uid == from_uid) {
            return Ok(Some(trade.id));
        }
    }

    Ok(None)
}

async fn apply_feedback_delta(db: &RtdbClient<'_>, uid: &str, positive: bool, delta: i8) -> Result<(), AppError> {
    if delta == 0 {
        return Ok(());
    }

    let path = format!("users/{}", uid);
    let Some(val) = db.get(&path).await? else {
        tracing::warn!("feedback_delta: user profile missing for uid {}", uid);
        return Ok(());
    };

    let mut profile = serde_json::from_value::<UserProfile>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if positive && delta > 0 {
        profile.feedback_pos = profile.feedback_pos.saturating_add(delta as u64);
    } else if positive && delta < 0 {
        profile.feedback_pos = profile.feedback_pos.saturating_sub((-delta) as u64);
    } else if !positive && delta > 0 {
        profile.feedback_neg = profile.feedback_neg.saturating_add(delta as u64);
    } else {
        profile.feedback_neg = profile.feedback_neg.saturating_sub((-delta) as u64);
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
    if len < 5 || len > 200 {
        return Err(AppError::BadRequest("Feedback text must be between 5 and 200 characters".into()));
    }

    if contains_prohibited_feedback_content(&normalized) {
        return Err(AppError::BadRequest("Feedback contains prohibited language (obscene, sexual, vulgar, or harassing content).".into()));
    }

    Ok(normalized)
}

fn contains_prohibited_feedback_content(input: &str) -> bool {
    let lowered = input.to_lowercase();
    let normalized = lowered
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { ' ' })
        .collect::<String>();

    const BANNED_TERMS: &[&str] = &[
        "fuck",
        "shit",
        "bitch",
        "asshole",
        "dick",
        "pussy",
        "slut",
        "whore",
        "sex",
        "sexy",
        "nude",
        "porn",
        "horny",
        "idiot",
        "moron",
        "stupid",
        "loser",
        "kys",
    ];

    if BANNED_TERMS.iter().any(|term| normalized.contains(term)) {
        return true;
    }

    normalized.contains("kill yourself")
}

pub(crate) async fn read_f64_path(db: &RtdbClient<'_>, path: &str) -> Result<f64, AppError> {
    Ok(db
        .get(path)
        .await?
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0))
}

pub(crate) async fn lock_escrow(db: &RtdbClient<'_>, uid: &str, coin: &str, amount: f64) -> Result<(), AppError> {
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

    let mut updates: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    updates.insert(bal_path.to_string(), serde_json::json!(available - amount));
    updates.insert(esc_path.to_string(), serde_json::json!(escrowed + amount));
    db.multi_path_update(updates).await
}

pub(crate) async fn release_escrow_back(db: &RtdbClient<'_>, uid: &str, coin: &str, amount: f64) -> Result<(), AppError> {
    let coin = coin.to_lowercase();
    let bal_path = format!("balances/{}/{}", uid, coin);
    let esc_path = format!("escrow_balances/{}/{}", uid, coin);

    let available = read_f64_path(db, &bal_path).await?;
    let escrowed = read_f64_path(db, &esc_path).await?;
    if escrowed + 1e-12 < amount {
        return Err(AppError::Internal("Escrow underflow while releasing funds".into()));
    }

    let mut updates: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    updates.insert(bal_path.to_string(), serde_json::json!(available + amount));
    updates.insert(esc_path.to_string(), serde_json::json!((escrowed - amount).max(0.0)));
    db.multi_path_update(updates).await
}

async fn release_escrow_to_user(db: &RtdbClient<'_>, seller_uid: &str, winner_uid: &str, coin: &str,
    amount: f64, fee: f64) -> Result<(), AppError> {
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

    let mut updates: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    updates.insert(esc_path.to_string(), serde_json::json!((escrowed - amount).max(0.0)));
    updates.insert(win_bal_path.to_string(), serde_json::json!(winner_bal + payout));
    updates.insert(fee_path.to_string(), serde_json::json!(fee_bal + fee));
    db.multi_path_update(updates).await
}

async fn ensure_escrow_available_for_completion(db: &RtdbClient<'_>, seller_uid: &str, coin: &str, required_amount: f64) -> Result<(), AppError> {
    let coin = coin.trim().to_lowercase();
    let esc_path = format!("escrow_balances/{}/{}", seller_uid, coin);
    let escrowed = read_f64_path(db, &esc_path).await?;
    if escrowed + 1e-12 < required_amount {
        return Err(AppError::BadRequest(format!(
            "Cannot complete trade: escrow balance is insufficient (have {:.8} {}, need {:.8} {})",
            escrowed,
            coin.to_uppercase(),
            required_amount,
            coin.to_uppercase()
        )));
    }
    Ok(())
}

async fn fetch_user_profile(db: &RtdbClient<'_>, uid: &str) -> Result<UserProfile, AppError> {
    let val = db
        .get(&format!("users/{}", uid))
        .await?
        .ok_or_else(|| AppError::NotFound("User profile not found".into()))?;
    serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))
}

// Caps how much capital a single user (or a single pair of users) can have
// locked in escrow at once — mainly to limit malicious/careless coin-locking
// (opening many trades to tie up sellers' balances) rather than payment
// throughput, which real trading volume rarely approaches anyway.
const MAX_ACTIVE_TRADES_PER_USER: usize = 8;
const MAX_ACTIVE_TRADES_PER_PAIR: usize = 3;

fn is_active_trade_status(status: &TradeStatus) -> bool {
    matches!(status, TradeStatus::Open | TradeStatus::Pending | TradeStatus::Paid | TradeStatus::Disputed)
}

async fn enforce_active_trade_caps(db: &RtdbClient<'_>, uid: &str, counterparty_uid: &str) -> Result<(), AppError> {
    let docs = db.get_collection("trades").await?;
    let trades: Vec<Trade> = docs.into_iter().filter_map(|v| serde_json::from_value::<Trade>(v).ok()).collect();

    let active_for_user = trades.iter()
        .filter(|t| is_active_trade_status(&t.status) && (t.creator_uid == uid || t.offer_owner_uid == uid))
        .count();
    if active_for_user >= MAX_ACTIVE_TRADES_PER_USER {
        return Err(AppError::BadRequest(format!(
            "You already have {} active trades — the limit is {}. Complete or cancel one before starting another.",
            active_for_user, MAX_ACTIVE_TRADES_PER_USER
        )));
    }

    let active_with_counterparty = trades.iter()
        .filter(|t| is_active_trade_status(&t.status) && (
            (t.creator_uid == uid && t.offer_owner_uid == counterparty_uid) ||
            (t.offer_owner_uid == uid && t.creator_uid == counterparty_uid)
        ))
        .count();
    if active_with_counterparty >= MAX_ACTIVE_TRADES_PER_PAIR {
        return Err(AppError::BadRequest(format!(
            "You already have {} active trades with this trader — the limit is {} at a time.",
            active_with_counterparty, MAX_ACTIVE_TRADES_PER_PAIR
        )));
    }

    Ok(())
}

pub(crate) fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
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

type UserMeta = (Option<String>, Option<u8>, Option<u64>);

fn user_meta_from_value(v: &serde_json::Value) -> UserMeta {
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

    let last_active_at = v
        .get("last_active_at")
        .and_then(|x| x.as_u64())
        .filter(|ts| *ts > 0);

    (username, avatar_number, last_active_at)
}

async fn fetch_users_meta_map(state: &AppState) -> HashMap<String, UserMeta> {
    const CACHE_KEY: &str = "users-meta-map";
    if let Some(cached) = state.ttl_cache.get::<HashMap<String, UserMeta>>(CACHE_KEY).await {
        return cached;
    }

    // Admin-scoped: RTDB rules typically restrict users/$uid reads to that
    // user themselves, which would silently deny a whole-collection read
    // (or a counterparty's single node) under a normal user token — and
    // every caller here just wants the public username/avatar/last-seen
    // fields to label a trade counterparty, not anything sensitive.
    let admin_db = RtdbClient::new_admin(state);
    let mut map = HashMap::new();
    if let Ok(Some(serde_json::Value::Object(users))) = admin_db.get("users").await {
        for (uid, v) in users {
            map.insert(uid, user_meta_from_value(&v));
        }
    }
    state.ttl_cache.set(CACHE_KEY, &map, 30).await;
    map
}

fn apply_trade_usernames_from_map(trade: &mut Trade, map: &HashMap<String, UserMeta>) {
    let (creator_username, creator_avatar_number, creator_last_active_at) = map
        .get(&trade.creator_uid)
        .cloned()
        .unwrap_or((None, None, None));
    let (offer_owner_username, offer_owner_avatar_number, offer_owner_last_active_at) = map
        .get(&trade.offer_owner_uid)
        .cloned()
        .unwrap_or((None, None, None));

    trade.creator_username = creator_username;
    trade.creator_avatar_number = creator_avatar_number;
    trade.offer_owner_username = offer_owner_username;
    trade.offer_owner_avatar_number = offer_owner_avatar_number;
    trade.creator_last_active_at = creator_last_active_at;
    trade.offer_owner_last_active_at = offer_owner_last_active_at;
}

async fn resolve_trade_usernames(trade: &mut Trade, state: &AppState) {
    // Admin-scoped for the same reason as fetch_users_meta_map above: a
    // trade party reading the *other* party's users/$uid node under their
    // own user token is routinely denied by RTDB rules, which silently
    // resolved to "no username" everywhere this was called from.
    let admin_db = RtdbClient::new_admin(state);

    async fn fetch_user_meta(db: &RtdbClient<'_>, uid: &str) -> UserMeta {
        let Some(v) = db.get(&format!("users/{}", uid)).await.ok().flatten() else {
            return (None, None, None);
        };
        user_meta_from_value(&v)
    }

    let (creator_username, creator_avatar_number, creator_last_active_at) = fetch_user_meta(&admin_db, &trade.creator_uid).await;
    let (offer_owner_username, offer_owner_avatar_number, offer_owner_last_active_at) = fetch_user_meta(&admin_db, &trade.offer_owner_uid).await;

    trade.creator_username = creator_username;
    trade.creator_avatar_number = creator_avatar_number;
    trade.offer_owner_username = offer_owner_username;
    trade.offer_owner_avatar_number = offer_owner_avatar_number;
    trade.creator_last_active_at = creator_last_active_at;
    trade.offer_owner_last_active_at = offer_owner_last_active_at;
}

fn seller_buyer_for_offer(offer: &Offer, taker_uid: &str) -> (String, String) {

    match offer.offer_type {
        crate::models::OfferType::Buy => (taker_uid.to_string(), offer.creator_uid.clone()),
        crate::models::OfferType::Sell => (offer.creator_uid.clone(), taker_uid.to_string()),
    }
}

fn seller_uid_for_trade(trade: &Trade) -> String {
    if trade.offer_type == "buy" {
        trade.creator_uid.clone()
    } else {
        trade.offer_owner_uid.clone()
    }
}

fn buyer_uid_for_trade(trade: &Trade) -> String {
    if trade.offer_type == "buy" {
        trade.offer_owner_uid.clone()
    } else {
        trade.creator_uid.clone()
    }
}

fn ensure_feedback_eligible(trade: &Trade, uid: &str) -> Result<(), AppError> {
    match trade.status {
        TradeStatus::Completed => Ok(()),
        TradeStatus::Disputed if trade.dispute_resolved => {
            if trade.dispute_winner_uid.as_deref() == Some(uid) {
                Ok(())
            } else {
                Err(AppError::BadRequest("Only the dispute winner can leave feedback for this trade".into()))
            }
        }
        _ => Err(AppError::BadRequest("Feedback is only available for completed trades".into())),
    }
}

fn payment_method_escrow_fee_pct(card: &str) -> f64 {
    let lower = card.trim().to_lowercase();
    crate::models::payment_methods()
        .into_iter()
        .find(|pm| pm.id == lower || pm.name.to_lowercase() == lower)
        .map(|pm| pm.escrow_fee_pct)
        .unwrap_or(1.0)
}

fn required_locked_crypto_for_fiat(fiat_amount: f64, fiat_to_usd: f64, coin_price_usd: f64, profit_pct: f64, escrow_fee_pct: f64) -> Option<f64> {
    if fiat_amount <= 0.0 || fiat_to_usd <= 0.0 || coin_price_usd <= 0.0 {
        return None;
    }

    let multiplier = 1.0 + (profit_pct / 100.0);
    if multiplier <= 0.0 {
        return None;
    }

    let target_crypto_value_usd = (fiat_amount * fiat_to_usd) / multiplier;
    let target_net_crypto = target_crypto_value_usd / coin_price_usd;
    if !target_net_crypto.is_finite() || target_net_crypto <= 0.0 {
        return None;
    }

    let escrow_rate = (escrow_fee_pct / 100.0).clamp(0.0, 0.95);
    let locked = target_net_crypto / (1.0 - escrow_rate);
    if locked.is_finite() && locked > 0.0 {
        Some(locked)
    } else {
        None
    }
}

pub(crate) async fn fetch_coin_usd_price(state: &AppState, coin: &str) -> Result<f64, AppError> {
    let coin = coin.trim().to_uppercase();
    if coin == "USDT" || coin == "USDC" {
        return Ok(1.0);
    }

    let pair = match coin.as_str() {
        "BTC" => "XXBTZUSD",
        "ETH" => "XETHZUSD",
        _ => {
            return Err(AppError::BadRequest(format!("Unsupported coin for pricing: {}", coin)));
        }
    };

    let url = format!("https://api.kraken.com/0/public/Ticker?pair={}", pair);
    let resp: serde_json::Value = state
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Price request failed: {}", e)))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Price parse failed: {}", e)))?;

    let result = resp["result"]
        .as_object()
        .ok_or_else(|| AppError::Internal("Price result missing".into()))?;

    let entry = result
        .get(pair)
        .or_else(|| {
            result
                .iter()
                .find(|(k, _)| k.contains(pair) || pair.contains(k.as_str()))
                .map(|(_, v)| v)
        })
        .ok_or_else(|| AppError::Internal("Price pair not found".into()))?;

    let price = entry["c"][0]
        .as_str()
        .unwrap_or("0")
        .parse::<f64>()
        .unwrap_or(0.0);

    if price <= 0.0 {
        return Err(AppError::Internal("Invalid USD price from provider".into()));
    }
    Ok(price)
}

async fn convert_to_usd(state: &AppState, amount: f64, currency: &str) -> Result<f64, AppError> {
    let currency = currency.trim().to_uppercase();
    if currency == "USD" {
        return Ok(amount);
    }

    let url = format!("https://open.er-api.com/v6/latest/{}", currency);
    let resp: serde_json::Value = state
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("FX request failed: {}", e)))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("FX parse failed: {}", e)))?;

    let result = resp["result"].as_str().unwrap_or("");
    if !result.is_empty() && result != "success" {
        return Err(AppError::Internal(format!("FX provider returned non-success result: {}", result)));
    }

    let rate = resp["rates"]["USD"]
        .as_f64()
        .ok_or_else(|| AppError::Internal("USD rate not found in FX response".into()))?;

    if rate <= 0.0 {
        return Err(AppError::Internal("Invalid FX exchange rate".into()));
    }

    Ok(amount * rate)
}