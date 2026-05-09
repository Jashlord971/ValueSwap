use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{
    AcceptSwapOfferRequest, AcceptSwapOfferResponse, CreateSwapOfferRequest, LedgerBalance,
    PlatformFeesSnapshot, SwapOffer, SwapOfferStatus, WithdrawPlatformFeesRequest,
};
use crate::AppState;
use axum::{
    extract::{Path, Query},
    http::HeaderMap,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use uuid::Uuid;

const SWAP_FEE_BPS: u16 = 0;
const DEFAULT_SWAP_EXPIRY_SECS: u64 = 3600;
const MAX_SWAP_EXPIRY_SECS: u64 = 86400;

#[derive(Debug, Deserialize, Default)]
struct ListSwapsQuery {
    mine: Option<bool>,
    status: Option<String>,
    from_coin: Option<String>,
    to_coin: Option<String>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_swap_offers).post(create_swap_offer))
        .route("/:id/accept", post(accept_swap_offer))
        .route("/:id", axum::routing::delete(cancel_swap_offer))
    .route("/fees", get(get_platform_fees))
    .route("/fees/withdraw", post(withdraw_platform_fees))
}

async fn list_swap_offers(ctx: Ctx, Query(query): Query<ListSwapsQuery>) -> Result<Json<Vec<SwapOffer>>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let now = unix_now();
    let requested_status = query.status.as_deref().map(str::to_lowercase);
    let pair_from = query
        .from_coin
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    let pair_to = query
        .to_coin
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);

    let mut offers = db
        .get_collection("swap_offers")
        .await?
        .into_iter()
        .filter_map(|v| serde_json::from_value::<SwapOffer>(v).ok())
        .filter(|offer| {
            if query.mine.unwrap_or(false) {
                offer.creator_uid == ctx.user.uid || offer.taker_uid.as_deref() == Some(ctx.user.uid.as_str())
            } else {
                true
            }
        })
        .filter(|offer| {
            let from_ok = pair_from
                .as_deref()
                .map(|c| offer.from_coin == c)
                .unwrap_or(true);
            let to_ok = pair_to
                .as_deref()
                .map(|c| offer.to_coin == c)
                .unwrap_or(true);
            from_ok && to_ok
        })
        .map(|mut offer| {
            if offer.status == SwapOfferStatus::Open && now > offer.expires_at {
                offer.status = SwapOfferStatus::Expired;
            }
            offer
        })
        .filter(|offer| match requested_status.as_deref() {
            Some("open") => offer.status == SwapOfferStatus::Open,
            Some("filled") => offer.status == SwapOfferStatus::Filled,
            Some("cancelled") => offer.status == SwapOfferStatus::Cancelled,
            Some("expired") => offer.status == SwapOfferStatus::Expired,
            Some(_) => false,
            None => true,
        })
        .collect::<Vec<_>>();

    offers.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(offers))
}

async fn create_swap_offer(ctx: Ctx, Json(req): Json<CreateSwapOfferRequest>) -> Result<Json<SwapOffer>, AppError> {
    let from_coin = normalize_coin(&req.from_coin)?;
    let to_coin = normalize_coin(&req.to_coin)?;

    if from_coin == to_coin {
        return Err(AppError::BadRequest(
            "from_coin and to_coin must be different".into(),
        ));
    }
    if req.from_amount <= 0.0 {
        return Err(AppError::BadRequest("Base amount must be positive".into()));
    }
    if !(0.0..=50.0).contains(&req.taker_profit_pct) {
        return Err(AppError::BadRequest(
            "taker_profit_pct must be between 0 and 50".into(),
        ));
    }

    let expiry = req
        .expires_in_secs
        .unwrap_or(DEFAULT_SWAP_EXPIRY_SECS)
        .clamp(60, MAX_SWAP_EXPIRY_SECS);

    let from_price = fetch_usd_price(&ctx.state, &from_coin).await?;
    let to_price = fetch_usd_price(&ctx.state, &to_coin).await?;
    let maker_notional_usd = req.from_amount * from_price;
    let taker_pay_notional_usd = maker_notional_usd / (1.0 + (req.taker_profit_pct / 100.0));
    let to_amount = taker_pay_notional_usd / to_price;
    if to_amount <= 0.0 {
        return Err(AppError::BadRequest("Computed target amount is invalid".into()));
    }

    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let ledger = fetch_ledger_balance(&db, &ctx.user.uid).await?;
    let locked = fetch_locked_balances(&db, &ctx.user.uid).await?;

    let available = get_coin_amount(&ledger, &from_coin) - get_coin_amount(&locked, &from_coin);
    if available + 1e-12 < req.from_amount {
        return Err(AppError::BadRequest(format!(
            "Insufficient available {} balance: have {:.8}, need {:.8}",
            from_coin.to_uppercase(),
            available.max(0.0),
            req.from_amount,
        )));
    }

    let mut updates = serde_json::Map::new();
    let new_locked = get_coin_amount(&locked, &from_coin) + req.from_amount;
    updates.insert(
        format!("locked_balances/{}/{}", ctx.user.uid, from_coin),
        serde_json::json!(new_locked),
    );

    let now = unix_now();
    let offer = SwapOffer {
        id: Uuid::new_v4().to_string(),
        creator_uid: ctx.user.uid,
        from_coin,
        to_coin,
        from_amount: req.from_amount,
        to_amount,
        taker_profit_pct: req.taker_profit_pct,
        fee_bps: SWAP_FEE_BPS,
        status: SwapOfferStatus::Open,
        created_at: now,
        expires_at: now + expiry,
        remaining_from_amount: Some(req.from_amount),
        remaining_to_amount: Some(to_amount),
        taker_uid: None,
        filled_at: None,
        cancelled_at: None,
    };

    updates.insert(
        format!("swap_offers/{}", offer.id),
        serde_json::to_value(&offer).map_err(|e| AppError::Internal(e.to_string()))?,
    );

    db.multi_path_update(updates).await?;
    Ok(Json(offer))
}

async fn accept_swap_offer(ctx: Ctx, Path(id): Path<String>, Json(req): Json<AcceptSwapOfferRequest>) -> Result<Json<AcceptSwapOfferResponse>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("swap_offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound("Swap offer not found".into()))?;
    let mut offer = serde_json::from_value::<SwapOffer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.status != SwapOfferStatus::Open {
        return Err(AppError::BadRequest("Offer is not open".into()));
    }
    if offer.creator_uid == ctx.user.uid {
        return Err(AppError::BadRequest("Cannot accept your own offer".into()));
    }
    let now = unix_now();
    if now > offer.expires_at {
        offer.status = SwapOfferStatus::Expired;
        db.set(
            &format!("swap_offers/{}", offer.id),
            &serde_json::to_value(&offer).map_err(|e| AppError::Internal(e.to_string()))?,
        )
        .await?;
        return Err(AppError::BadRequest("Offer has expired".into()));
    }

    let maker_uid = offer.creator_uid.clone();
    let taker_uid = ctx.user.uid.clone();
    let remaining_from = offer.remaining_from_amount.unwrap_or(offer.from_amount);
    let remaining_to = offer.remaining_to_amount.unwrap_or(offer.to_amount);

    if remaining_from <= 1e-12 || remaining_to <= 1e-12 {
        return Err(AppError::BadRequest("Offer has no remaining liquidity".into()));
    }

    let take_from_amount = req.take_from_amount.unwrap_or(remaining_from);
    if take_from_amount <= 0.0 {
        return Err(AppError::BadRequest("take_from_amount must be positive".into()));
    }
    if take_from_amount - remaining_from > 1e-12 {
        return Err(AppError::BadRequest(format!(
            "Requested fill exceeds available amount: requested {:.8}, remaining {:.8}",
            take_from_amount, remaining_from
        )));
    }

    let price = remaining_to / remaining_from;
    let take_to_amount = take_from_amount * price;

    let maker_ledger = fetch_ledger_balance(&db, &maker_uid).await?;
    let taker_ledger = fetch_ledger_balance(&db, &taker_uid).await?;
    let maker_locked = fetch_locked_balances(&db, &maker_uid).await?;

    let maker_locked_from = get_coin_amount(&maker_locked, &offer.from_coin);
    if maker_locked_from + 1e-12 < take_from_amount {
        return Err(AppError::BadRequest(
            "Offer maker no longer has locked funds".into(),
        ));
    }

    let taker_available_to = get_coin_amount(&taker_ledger, &offer.to_coin);
    if taker_available_to + 1e-12 < take_to_amount {
        return Err(AppError::BadRequest(format!(
            "Taker has insufficient {}: have {:.8}, need {:.8}",
            offer.to_coin.to_uppercase(),
            taker_available_to.max(0.0),
            take_to_amount,
        )));
    }

    let fee_from_coin = 0.0;
    let fee_to_coin = 0.0;
    let maker_receive_amount = take_to_amount;
    let taker_receive_amount = take_from_amount;

    if maker_receive_amount <= 0.0 || taker_receive_amount <= 0.0 {
        return Err(AppError::BadRequest("Swap amount too small after fee".into()));
    }

    let maker_from = get_coin_amount(&maker_ledger, &offer.from_coin);
    let maker_to = get_coin_amount(&maker_ledger, &offer.to_coin);
    let taker_from = get_coin_amount(&taker_ledger, &offer.from_coin);
    let taker_to = get_coin_amount(&taker_ledger, &offer.to_coin);

    if maker_from + 1e-12 < take_from_amount {
        return Err(AppError::BadRequest("Maker balance changed; retry".into()));
    }

    let maker_new_from = maker_from - take_from_amount;
    let maker_new_to = maker_to + maker_receive_amount;
    let taker_new_to = taker_to - take_to_amount;
    let taker_new_from = taker_from + taker_receive_amount;
    let maker_new_locked = maker_locked_from - take_from_amount;
    let new_remaining_from = (remaining_from - take_from_amount).max(0.0);
    let new_remaining_to = (remaining_to - take_to_amount).max(0.0);

    if taker_new_to < -1e-12 || maker_new_locked < -1e-12 {
        return Err(AppError::BadRequest("Balance underflow; retry".into()));
    }

    offer.remaining_from_amount = Some(new_remaining_from);
    offer.remaining_to_amount = Some(new_remaining_to);
    if new_remaining_from <= 1e-12 || new_remaining_to <= 1e-12 {
        offer.status = SwapOfferStatus::Filled;
        offer.filled_at = Some(now);
    }
    offer.taker_uid = Some(taker_uid.clone());

    let mut updates = serde_json::Map::new();
    updates.insert(
        format!("balances/{}/{}", maker_uid, offer.from_coin),
        serde_json::json!(maker_new_from),
    );
    updates.insert(
        format!("balances/{}/{}", maker_uid, offer.to_coin),
        serde_json::json!(maker_new_to),
    );
    updates.insert(
        format!("balances/{}/{}", taker_uid, offer.to_coin),
        serde_json::json!(taker_new_to),
    );
    updates.insert(
        format!("balances/{}/{}", taker_uid, offer.from_coin),
        serde_json::json!(taker_new_from),
    );
    updates.insert(
        format!("locked_balances/{}/{}", maker_uid, offer.from_coin),
        serde_json::json!(maker_new_locked.max(0.0)),
    );
    updates.insert(
        format!("swap_offers/{}", offer.id),
        serde_json::to_value(&offer).map_err(|e| AppError::Internal(e.to_string()))?,
    );

    db.multi_path_update(updates).await?;

    Ok(Json(AcceptSwapOfferResponse {
        offer,
        filled_from_amount: take_from_amount,
        filled_to_amount: take_to_amount,
        maker_receive_amount,
        taker_receive_amount,
        fee_from_coin,
        fee_to_coin,
    }))
}

async fn fetch_usd_price(state: &AppState, coin: &str) -> Result<f64, AppError> {
    match coin {
        "usdt" | "usdc" => return Ok(1.0),
        _ => {}
    }

    let pair = match coin {
        "btc" => "XXBTZUSD",
        "eth" => "XETHZUSD",
        "trx" => "TRXUSD",
        _ => return Err(AppError::BadRequest(format!("Unsupported coin for pricing: {}", coin))),
    };

    let url = format!("https://api.kraken.com/0/public/Ticker?pair={}", pair);
    let resp: serde_json::Value = state
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Pricing request failed: {}", e)))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("Pricing parse failed: {}", e)))?;

    let result = resp["result"]
        .as_object()
        .ok_or_else(|| AppError::Internal("Pricing result missing".into()))?;
    let entry = result
        .get(pair)
        .or_else(|| result.iter().find(|(k, _)| k.contains(pair) || pair.contains(k.as_str())).map(|(_, v)| v))
        .ok_or_else(|| AppError::Internal("Pricing pair missing".into()))?;
    let price = entry["c"][0]
        .as_str()
        .unwrap_or("0")
        .parse::<f64>()
        .unwrap_or(0.0);

    if price <= 0.0 {
        return Err(AppError::Internal("Invalid pricing data".into()));
    }

    Ok(price)
}

async fn cancel_swap_offer(ctx: Ctx, Path(id): Path<String>) -> Result<StatusCode, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("swap_offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound("Swap offer not found".into()))?;
    let mut offer = serde_json::from_value::<SwapOffer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.creator_uid != ctx.user.uid {
        return Err(AppError::Forbidden("You can only cancel your own offer".into()));
    }
    if offer.status != SwapOfferStatus::Open {
        return Err(AppError::BadRequest("Offer is not open".into()));
    }

    let locked = fetch_locked_balances(&db, &offer.creator_uid).await?;
    let currently_locked = get_coin_amount(&locked, &offer.from_coin);
    let remaining_from = offer.remaining_from_amount.unwrap_or(offer.from_amount);
    let new_locked = (currently_locked - remaining_from).max(0.0);

    offer.status = SwapOfferStatus::Cancelled;
    offer.cancelled_at = Some(unix_now());

    let mut updates = serde_json::Map::new();
    updates.insert(
        format!("locked_balances/{}/{}", offer.creator_uid, offer.from_coin),
        serde_json::json!(new_locked),
    );
    updates.insert(
        format!("swap_offers/{}", offer.id),
        serde_json::to_value(&offer).map_err(|e| AppError::Internal(e.to_string()))?,
    );

    db.multi_path_update(updates).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get_platform_fees(ctx: Ctx, headers: HeaderMap) -> Result<Json<PlatformFeesSnapshot>, AppError> {
    require_admin_key(&ctx.state, &headers)?;
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let btc = get_platform_fee(&db, "btc").await?;
    let eth = get_platform_fee(&db, "eth").await?;
    let usdt = get_platform_fee(&db, "usdt").await?;
    let usdc = get_platform_fee(&db, "usdc").await?;
    let trx = get_platform_fee(&db, "trx").await?;
    Ok(Json(PlatformFeesSnapshot {
        btc,
        eth,
        usdt,
        usdc,
        trx,
    }))
}

async fn withdraw_platform_fees(ctx: Ctx, headers: HeaderMap, Json(req): Json<WithdrawPlatformFeesRequest>) -> Result<Json<serde_json::Value>, AppError> {
    require_admin_key(&ctx.state, &headers)?;
    let coin = normalize_coin(&req.coin)?;
    if req.amount <= 0.0 {
        return Err(AppError::BadRequest("amount must be positive".into()));
    }
    if req.to_uid.trim().is_empty() {
        return Err(AppError::BadRequest("to_uid is required".into()));
    }

    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let fee_path = format!("platform_fees/{}", coin);
    let available = db
        .get(&fee_path)
        .await?
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    if available + 1e-12 < req.amount {
        return Err(AppError::BadRequest(format!(
            "Insufficient platform fee balance: have {:.8}, need {:.8}",
            available, req.amount
        )));
    }

    let recipient_ledger = fetch_ledger_balance(&db, req.to_uid.trim()).await?;
    let recipient_current = get_coin_amount(&recipient_ledger, &coin);

    let mut updates = serde_json::Map::new();
    updates.insert(fee_path, serde_json::json!(available - req.amount));
    updates.insert(
        format!("balances/{}/{}", req.to_uid.trim(), coin),
        serde_json::json!(recipient_current + req.amount),
    );
    db.multi_path_update(updates).await?;

    Ok(Json(serde_json::json!({
        "message": "Platform fee withdrawal posted to user ledger",
        "coin": coin,
        "amount": req.amount,
        "to_uid": req.to_uid.trim(),
    })))
}

fn require_admin_key(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    if state.swap_admin_key.is_empty() {
        return Err(AppError::Forbidden(
            "SWAP_ADMIN_KEY is not configured on server".into(),
        ));
    }

    let provided = headers
        .get("x-admin-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided != state.swap_admin_key {
        return Err(AppError::Unauthorized("Invalid admin key".into()));
    }
    Ok(())
}

async fn get_platform_fee(db: &RtdbClient<'_>, coin: &str) -> Result<f64, AppError> {
    Ok(db
        .get(&format!("platform_fees/{}", coin))
        .await?
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0))
}

fn normalize_coin(raw: &str) -> Result<String, AppError> {
    let coin = raw.trim().to_lowercase();
    match coin.as_str() {
        "btc" | "eth" | "usdt" | "usdc" | "trx" => Ok(coin),
        _ => Err(AppError::BadRequest(format!("Invalid coin: {}", raw))),
    }
}

async fn fetch_ledger_balance(db: &RtdbClient<'_>, uid: &str) -> Result<LedgerBalance, AppError> {
    Ok(db
        .get(&format!("balances/{}", uid))
        .await?
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default())
}

async fn fetch_locked_balances(db: &RtdbClient<'_>, uid: &str) -> Result<LedgerBalance, AppError> {
    Ok(db
        .get(&format!("locked_balances/{}", uid))
        .await?
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default())
}

fn get_coin_amount(balance: &LedgerBalance, coin: &str) -> f64 {
    match coin {
        "btc" => balance.btc,
        "eth" => balance.eth,
        "usdt" => balance.usdt,
        "usdc" => balance.usdc,
        "trx" => balance.trx,
        _ => 0.0,
    }
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
