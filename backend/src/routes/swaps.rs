use super::trades::{fetch_coin_usd_price, lock_escrow, read_f64_path, release_escrow_back, unix_now};
use super::wallet::record_transaction;
use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{
    AcceptSwapOfferRequest, CreateSwapOfferRequest, SwapOffer, SwapOfferStatus,
    UpdateOfferStatusRequest, UpdateSwapOfferRequest,
};
use crate::AppState;
use axum::{
    extract::{Path, Query},
    http::StatusCode,
    routing::{get, patch, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use uuid::Uuid;

const SWAP_FEE_PCT: f64 = 1.0;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_swap_offers).post(create_swap_offer))
        .route("/:id", patch(update_swap_offer).delete(delete_swap_offer))
        .route("/:id/status", patch(toggle_swap_offer))
        .route("/:id/accept", post(accept_swap_offer))
        .route("/:id/cancel", post(cancel_swap_offer))
}

#[derive(Debug, Deserialize, Default)]
struct ListSwapsQuery {
    #[serde(default)]
    mine: Option<bool>,
}

const SWAP_OFFERS_CACHE_KEY: &str = "swap-offers-collection";

async fn list_swap_offers(ctx: Ctx, Query(query): Query<ListSwapsQuery>) -> Result<Json<Vec<SwapOffer>>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let mine = query.mine.unwrap_or(false);

    // Same shared-fetch cache pattern as offers.rs's list_offers — the raw
    // collection is identical for every caller.
    let mut offers: Vec<SwapOffer> = if let Some(cached) = ctx.state.ttl_cache.get::<Vec<SwapOffer>>(SWAP_OFFERS_CACHE_KEY).await {
        cached
    } else {
        let fresh: Vec<SwapOffer> = db
            .get_collection("swap_offers")
            .await?
            .into_iter()
            .filter_map(|v| serde_json::from_value::<SwapOffer>(v).ok())
            .collect();
        ctx.state.ttl_cache.set(SWAP_OFFERS_CACHE_KEY, &fresh, 10).await;
        fresh
    };

    for offer in &mut offers {
        if apply_effective_swap_status(offer) {
            db.set(&format!("swap_offers/{}", offer.id), &serde_json::to_value(&offer).unwrap()).await?;
        }
    }

    let mut offers = offers
        .into_iter()
        .filter(|o| {
            if mine {
                o.creator_uid == ctx.user.uid || o.last_taker_uid.as_deref() == Some(ctx.user.uid.as_str())
            } else {
                // The board only shows what's actually takeable right now.
                o.status == SwapOfferStatus::Open && o.creator_uid != ctx.user.uid
            }
        })
        .collect::<Vec<_>>();

    offers.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(offers))
}

fn apply_effective_swap_status(offer: &mut SwapOffer) -> bool {
    if matches!(offer.status, SwapOfferStatus::Open | SwapOfferStatus::Paused) && offer.remaining_amount <= 1e-8 {
        offer.remaining_amount = 0.0;
        offer.status = SwapOfferStatus::Filled;
        return true;
    }
    false                             
}

async fn create_swap_offer(ctx: Ctx, Json(req): Json<CreateSwapOfferRequest>) -> Result<Json<SwapOffer>, AppError> {
    let from_coin = normalize_coin(&req.from_coin)?;
    let to_coin = normalize_coin(&req.to_coin)?;
    if from_coin == to_coin {
        return Err(AppError::BadRequest("from_coin and to_coin must be different".into()));
    }
    if !req.min_amount.is_finite() || req.min_amount <= 0.0 {
        return Err(AppError::BadRequest("min_amount must be positive".into()));
    }
    if !req.max_amount.is_finite() || req.max_amount <= 0.0 {
        return Err(AppError::BadRequest("max_amount must be positive".into()));
    }
    if req.min_amount > req.max_amount {
        return Err(AppError::BadRequest("min_amount cannot be greater than max_amount".into()));
    }
    if !(-100.0..=200.0).contains(&req.profit_pct) {
        return Err(AppError::BadRequest("profit_pct must be between -100 and 200".into()));
    }

    let from_price = fetch_coin_usd_price(&ctx.state, &from_coin).await?;
    let to_price = fetch_coin_usd_price(&ctx.state, &to_coin).await?;
    let from_notional_usd = req.max_amount * from_price;
    let to_notional_usd = from_notional_usd * (1.0 + req.profit_pct / 100.0);
    let to_amount = to_notional_usd / to_price;
    if !to_amount.is_finite() || to_amount <= 0.0 {
        return Err(AppError::BadRequest("Computed amount to receive is invalid — adjust the profit/loss rate".into()));
    }

    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);

    lock_escrow(&db, &ctx.user.uid, &from_coin, req.max_amount).await?;

    let offer = SwapOffer {
        id: Uuid::new_v4().to_string(),
        creator_uid: ctx.user.uid.clone(),
        from_coin,
        to_coin,
        min_amount: req.min_amount,
        max_amount: req.max_amount,
        to_amount,
        remaining_amount: req.max_amount,
        profit_pct: req.profit_pct,
        fee_pct: SWAP_FEE_PCT,
        status: SwapOfferStatus::Open,
        created_at: unix_now(),
        last_taker_uid: None,
        last_filled_at: None,
        cancelled_at: None,
    };

    db.set(&format!("swap_offers/{}", offer.id), &serde_json::to_value(&offer).unwrap()).await?;
    Ok(Json(offer))
}

async fn accept_swap_offer(ctx: Ctx, Path(id): Path<String>, Json(req): Json<AcceptSwapOfferRequest>) -> Result<Json<SwapOffer>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("swap_offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound("Swap offer not found".into()))?;
    let mut offer = serde_json::from_value::<SwapOffer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.status != SwapOfferStatus::Open {
        return Err(AppError::BadRequest("This swap offer is no longer open".into()));
    }
    if offer.creator_uid == ctx.user.uid {
        return Err(AppError::BadRequest("Cannot accept your own swap offer".into()));
    }

    let take_from_amount = req.amount;
    if !take_from_amount.is_finite() || take_from_amount <= 0.0 {
        return Err(AppError::BadRequest("amount must be positive".into()));
    }
    if take_from_amount - offer.remaining_amount > 1e-9 {
        return Err(AppError::BadRequest(format!(
            "Only {:.8} {} remains on this offer",
            offer.remaining_amount, offer.from_coin.to_uppercase()
        )));
    }

    let is_dust_sweep = (offer.remaining_amount - take_from_amount).abs() <= 1e-9;
    if take_from_amount + 1e-9 < offer.min_amount && !is_dust_sweep {
        return Err(AppError::BadRequest(format!(
            "This offer requires at least {:.8} {} per fill",
            offer.min_amount, offer.from_coin.to_uppercase()
        )));
    }

    let rate = offer.to_amount / offer.max_amount;
    let take_to_amount = take_from_amount * rate;

    let maker_uid = offer.creator_uid.clone();
    let taker_uid = ctx.user.uid.clone();

    let maker_escrow_path = format!("escrow_balances/{}/{}", maker_uid, offer.from_coin);
    let maker_escrowed = read_f64_path(&db, &maker_escrow_path).await?;
    if maker_escrowed + 1e-9 < take_from_amount {
        return Err(AppError::Internal("Swap offer's locked funds are missing".into()));
    }

    let taker_to_bal_path = format!("balances/{}/{}", taker_uid, offer.to_coin);
    let taker_to_bal = read_f64_path(&db, &taker_to_bal_path).await?;
    if taker_to_bal + 1e-9 < take_to_amount {
        return Err(AppError::BadRequest(format!(
            "Insufficient {} balance: have {:.8}, need {:.8}",
            offer.to_coin.to_uppercase(),
            taker_to_bal.max(0.0),
            take_to_amount
        )));
    }

    let taker_from_bal_path = format!("balances/{}/{}", taker_uid, offer.from_coin);
    let taker_from_bal = read_f64_path(&db, &taker_from_bal_path).await?;
    let maker_to_bal_path = format!("balances/{}/{}", maker_uid, offer.to_coin);
    let maker_to_bal = read_f64_path(&db, &maker_to_bal_path).await?;

    // from_coin != to_coin is enforced at creation, so these are always distinct paths.
    let from_fee_path = format!("platform_fees/{}", offer.from_coin);
    let from_fee_bal = read_f64_path(&db, &from_fee_path).await?;
    let to_fee_path = format!("platform_fees/{}", offer.to_coin);
    let to_fee_bal = read_f64_path(&db, &to_fee_path).await?;

    let fee_rate = (offer.fee_pct / 100.0).clamp(0.0, 1.0);
    let from_fee = take_from_amount * fee_rate;
    let to_fee = take_to_amount * fee_rate;
    let taker_receives = take_from_amount - from_fee;
    let maker_receives = take_to_amount - to_fee;

    offer.remaining_amount = (offer.remaining_amount - take_from_amount).max(0.0);
    if offer.remaining_amount <= 1e-8 {
        offer.remaining_amount = 0.0;
        offer.status = SwapOfferStatus::Filled;
    }
    offer.last_taker_uid = Some(taker_uid.clone());
    offer.last_filled_at = Some(unix_now());

    let mut updates = serde_json::Map::new();
    updates.insert(maker_escrow_path, serde_json::json!((maker_escrowed - take_from_amount).max(0.0)));
    updates.insert(maker_to_bal_path, serde_json::json!(maker_to_bal + maker_receives));
    updates.insert(taker_to_bal_path, serde_json::json!(taker_to_bal - take_to_amount));
    updates.insert(taker_from_bal_path, serde_json::json!(taker_from_bal + taker_receives));
    updates.insert(from_fee_path, serde_json::json!(from_fee_bal + from_fee));
    updates.insert(to_fee_path, serde_json::json!(to_fee_bal + to_fee));
    updates.insert(format!("swap_offers/{}", offer.id), serde_json::to_value(&offer).unwrap());

    db.multi_path_update(updates).await?;

    let related_id = Some(offer.id.as_str());
    if let Err(e) = record_transaction(&db, &maker_uid, "swap", "out", &offer.from_coin, take_from_amount, Some(&taker_uid), None, related_id).await {
        tracing::warn!("Failed to record swap-out transaction for maker {}: {}", maker_uid, e);
    }
    if let Err(e) = record_transaction(&db, &maker_uid, "swap", "in", &offer.to_coin, maker_receives, Some(&taker_uid), None, related_id).await {
        tracing::warn!("Failed to record swap-in transaction for maker {}: {}", maker_uid, e);
    }
    if let Err(e) = record_transaction(&db, &taker_uid, "swap", "out", &offer.to_coin, take_to_amount, Some(&maker_uid), None, related_id).await {
        tracing::warn!("Failed to record swap-out transaction for taker {}: {}", taker_uid, e);
    }
    if let Err(e) = record_transaction(&db, &taker_uid, "swap", "in", &offer.from_coin, taker_receives, Some(&maker_uid), None, related_id).await {
        tracing::warn!("Failed to record swap-in transaction for taker {}: {}", taker_uid, e);
    }

    Ok(Json(offer))
}

async fn cancel_swap_offer(ctx: Ctx, Path(id): Path<String>) -> Result<Json<SwapOffer>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("swap_offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound("Swap offer not found".into()))?;
    let mut offer = serde_json::from_value::<SwapOffer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.creator_uid != ctx.user.uid {
        return Err(AppError::Forbidden("You can only cancel your own swap offer".into()));
    }
    if !matches!(offer.status, SwapOfferStatus::Open | SwapOfferStatus::Paused) {
        return Err(AppError::BadRequest("This swap offer is no longer open".into()));
    }

    release_escrow_back(&db, &offer.creator_uid, &offer.from_coin, offer.remaining_amount).await?;

    offer.status = SwapOfferStatus::Cancelled;
    offer.cancelled_at = Some(unix_now());
    db.set(&format!("swap_offers/{}", offer.id), &serde_json::to_value(&offer).unwrap()).await?;
    Ok(Json(offer))
}

async fn toggle_swap_offer(ctx: Ctx, Path(id): Path<String>, Json(req): Json<UpdateOfferStatusRequest>) -> Result<Json<SwapOffer>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("swap_offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound("Swap offer not found".into()))?;
    let mut offer = serde_json::from_value::<SwapOffer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.creator_uid != ctx.user.uid {
        return Err(AppError::Forbidden("You can only modify your own swap offer".into()));
    }
    if !matches!(offer.status, SwapOfferStatus::Open | SwapOfferStatus::Paused) {
        return Err(AppError::BadRequest("This offer can no longer be turned on or off".into()));
    }

    offer.status = if req.active { SwapOfferStatus::Open } else { SwapOfferStatus::Paused };
    db.set(&format!("swap_offers/{}", offer.id), &serde_json::to_value(&offer).unwrap()).await?;
    Ok(Json(offer))
}

/// Edits the rate and per-fill minimum on an offer that hasn't been cancelled
/// or fully filled. from_coin/to_coin/max_amount aren't editable — changing
/// what's actually collateralized would mean unlocking/relocking escrow, so
/// that's a cancel-and-repost instead. Changing profit_pct re-quotes to_amount
/// against today's prices and rebases max_amount to whatever's currently
/// remaining, so the offer's rate (to_amount / max_amount) stays meaningful.
async fn update_swap_offer(ctx: Ctx, Path(id): Path<String>, Json(req): Json<UpdateSwapOfferRequest>) -> Result<Json<SwapOffer>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("swap_offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound("Swap offer not found".into()))?;
    let mut offer = serde_json::from_value::<SwapOffer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.creator_uid != ctx.user.uid {
        return Err(AppError::Forbidden("You can only edit your own swap offer".into()));
    }
    if !matches!(offer.status, SwapOfferStatus::Open | SwapOfferStatus::Paused) {
        return Err(AppError::BadRequest("Only an open or paused offer can be edited".into()));
    }
    // Rebasing max_amount onto a near-zero remaining_amount (see below) would
    // produce a degenerate offer priced on dust. Cancel-and-repost instead.
    if offer.remaining_amount <= 1e-8 {
        return Err(AppError::BadRequest("This offer is essentially filled and can't be edited — cancel it instead".into()));
    }
    if !req.min_amount.is_finite() || req.min_amount <= 0.0 {
        return Err(AppError::BadRequest("min_amount must be positive".into()));
    }
    if req.min_amount - offer.remaining_amount > 1e-9 {
        return Err(AppError::BadRequest("min_amount cannot exceed what's currently remaining on this offer".into()));
    }
    if !(-100.0..=200.0).contains(&req.profit_pct) {
        return Err(AppError::BadRequest("profit_pct must be between -100 and 200".into()));
    }

    let from_price = fetch_coin_usd_price(&ctx.state, &offer.from_coin).await?;
    let to_price = fetch_coin_usd_price(&ctx.state, &offer.to_coin).await?;
    let from_notional_usd = offer.remaining_amount * from_price;
    let to_notional_usd = from_notional_usd * (1.0 + req.profit_pct / 100.0);
    let to_amount = to_notional_usd / to_price;
    if !to_amount.is_finite() || to_amount <= 0.0 {
        return Err(AppError::BadRequest("Computed amount to receive is invalid — adjust the profit/loss rate".into()));
    }

    offer.min_amount = req.min_amount;
    offer.max_amount = offer.remaining_amount;
    offer.to_amount = to_amount;
    offer.profit_pct = req.profit_pct;

    db.set(&format!("swap_offers/{}", offer.id), &serde_json::to_value(&offer).unwrap()).await?;
    Ok(Json(offer))
}

async fn delete_swap_offer(ctx: Ctx, Path(id): Path<String>) -> Result<StatusCode, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("swap_offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound("Swap offer not found".into()))?;
    let offer = serde_json::from_value::<SwapOffer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.creator_uid != ctx.user.uid {
        return Err(AppError::Forbidden("You can only delete your own swap offer".into()));
    }
    if matches!(offer.status, SwapOfferStatus::Open | SwapOfferStatus::Paused) {
        return Err(AppError::BadRequest("Cancel this offer first to release its locked funds, then delete it".into()));
    }

    db.delete(&format!("swap_offers/{}", id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn normalize_coin(raw: &str) -> Result<String, AppError> {
    let coin = raw.trim().to_lowercase();
    match coin.as_str() {
        "btc" | "eth" | "usdt" | "usdc" => Ok(coin),
        _ => Err(AppError::BadRequest(format!("Unsupported coin: {}", raw))),
    }
}
