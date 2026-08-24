use super::trades::{lock_escrow, read_f64_path, release_escrow_back, unix_now};
use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{CreateSwapOfferRequest, SwapOffer, SwapOfferStatus};
use crate::AppState;
use axum::{
    extract::{Path, Query},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use uuid::Uuid;

const SWAP_FEE_PCT: f64 = 1.0;

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_swap_offers).post(create_swap_offer))
        .route("/:id/accept", post(accept_swap_offer))
        .route("/:id/cancel", post(cancel_swap_offer))
}

#[derive(Debug, Deserialize, Default)]
struct ListSwapsQuery {
    #[serde(default)]
    mine: Option<bool>,
}

async fn list_swap_offers(ctx: Ctx, Query(query): Query<ListSwapsQuery>) -> Result<Json<Vec<SwapOffer>>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let mine = query.mine.unwrap_or(false);

    let mut offers = db
        .get_collection("swap_offers")
        .await?
        .into_iter()
        .filter_map(|v| serde_json::from_value::<SwapOffer>(v).ok())
        .filter(|o| {
            if mine {
                o.creator_uid == ctx.user.uid || o.taker_uid.as_deref() == Some(ctx.user.uid.as_str())
            } else {

                o.status == SwapOfferStatus::Open && o.creator_uid != ctx.user.uid
            }
        })
        .collect::<Vec<_>>();

    offers.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(offers))
}

async fn create_swap_offer(ctx: Ctx, Json(req): Json<CreateSwapOfferRequest>) -> Result<Json<SwapOffer>, AppError> {
    let from_coin = normalize_coin(&req.from_coin)?;
    let to_coin = normalize_coin(&req.to_coin)?;
    if from_coin == to_coin {
        return Err(AppError::BadRequest("from_coin and to_coin must be different".into()));
    }
    if !req.from_amount.is_finite() || req.from_amount <= 0.0 {
        return Err(AppError::BadRequest("from_amount must be positive".into()));
    }
    if !req.to_amount.is_finite() || req.to_amount <= 0.0 {
        return Err(AppError::BadRequest("to_amount must be positive".into()));
    }

    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);

    lock_escrow(&db, &ctx.user.uid, &from_coin, req.from_amount).await?;

    let offer = SwapOffer {
        id: Uuid::new_v4().to_string(),
        creator_uid: ctx.user.uid.clone(),
        from_coin,
        to_coin,
        from_amount: req.from_amount,
        to_amount: req.to_amount,
        fee_pct: SWAP_FEE_PCT,
        status: SwapOfferStatus::Open,
        created_at: unix_now(),
        taker_uid: None,
        filled_at: None,
        cancelled_at: None,
    };

    db.set(&format!("swap_offers/{}", offer.id), &serde_json::to_value(&offer).unwrap()).await?;
    Ok(Json(offer))
}

async fn accept_swap_offer(ctx: Ctx, Path(id): Path<String>) -> Result<Json<SwapOffer>, AppError> {
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

    let maker_uid = offer.creator_uid.clone();
    let taker_uid = ctx.user.uid.clone();

    let maker_escrow_path = format!("escrow_balances/{}/{}", maker_uid, offer.from_coin);
    let maker_escrowed = read_f64_path(&db, &maker_escrow_path).await?;
    if maker_escrowed + 1e-12 < offer.from_amount {
        return Err(AppError::Internal("Swap offer's locked funds are missing".into()));
    }

    let taker_to_bal_path = format!("balances/{}/{}", taker_uid, offer.to_coin);
    let taker_to_bal = read_f64_path(&db, &taker_to_bal_path).await?;
    if taker_to_bal + 1e-12 < offer.to_amount {
        return Err(AppError::BadRequest(format!(
            "Insufficient {} balance: have {:.8}, need {:.8}",
            offer.to_coin.to_uppercase(),
            taker_to_bal.max(0.0),
            offer.to_amount
        )));
    }

    let taker_from_bal_path = format!("balances/{}/{}", taker_uid, offer.from_coin);
    let taker_from_bal = read_f64_path(&db, &taker_from_bal_path).await?;
    let maker_to_bal_path = format!("balances/{}/{}", maker_uid, offer.to_coin);
    let maker_to_bal = read_f64_path(&db, &maker_to_bal_path).await?;

    let from_fee_path = format!("platform_fees/{}", offer.from_coin);
    let from_fee_bal = read_f64_path(&db, &from_fee_path).await?;
    let to_fee_path = format!("platform_fees/{}", offer.to_coin);
    let to_fee_bal = read_f64_path(&db, &to_fee_path).await?;

    let fee_rate = (offer.fee_pct / 100.0).clamp(0.0, 1.0);
    let from_fee = offer.from_amount * fee_rate;
    let to_fee = offer.to_amount * fee_rate;
    let taker_receives = offer.from_amount - from_fee;
    let maker_receives = offer.to_amount - to_fee;

    offer.status = SwapOfferStatus::Filled;
    offer.taker_uid = Some(taker_uid.clone());
    offer.filled_at = Some(unix_now());

    let mut updates = serde_json::Map::new();
    updates.insert(maker_escrow_path, serde_json::json!((maker_escrowed - offer.from_amount).max(0.0)));
    updates.insert(maker_to_bal_path, serde_json::json!(maker_to_bal + maker_receives));
    updates.insert(taker_to_bal_path, serde_json::json!(taker_to_bal - offer.to_amount));
    updates.insert(taker_from_bal_path, serde_json::json!(taker_from_bal + taker_receives));
    updates.insert(from_fee_path, serde_json::json!(from_fee_bal + from_fee));
    updates.insert(to_fee_path, serde_json::json!(to_fee_bal + to_fee));
    updates.insert(format!("swap_offers/{}", offer.id), serde_json::to_value(&offer).unwrap());

    db.multi_path_update(updates).await?;
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
    if offer.status != SwapOfferStatus::Open {
        return Err(AppError::BadRequest("This swap offer is no longer open".into()));
    }

    release_escrow_back(&db, &offer.creator_uid, &offer.from_coin, offer.from_amount).await?;

    offer.status = SwapOfferStatus::Cancelled;
    offer.cancelled_at = Some(unix_now());
    db.set(&format!("swap_offers/{}", offer.id), &serde_json::to_value(&offer).unwrap()).await?;
    Ok(Json(offer))
}

fn normalize_coin(raw: &str) -> Result<String, AppError> {
    let coin = raw.trim().to_lowercase();
    match coin.as_str() {
        "btc" | "eth" | "usdt" | "usdc" => Ok(coin),
        _ => Err(AppError::BadRequest(format!("Unsupported coin: {}", raw))),
    }
}
