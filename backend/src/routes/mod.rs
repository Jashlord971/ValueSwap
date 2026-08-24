mod cards;
mod chat;
mod ocr;
mod offers;
mod swaps;
mod trades;
mod users;
mod wallet;
pub mod withdrawal;

pub use trades::expire_stale_trades;
pub use wallet::sweep_platform_fees_background;

use crate::auth::auth_middleware;
use crate::error::AppError;
use crate::AppState;
use axum::{
    extract::State,
    http::HeaderMap,
    middleware,
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;

pub fn router(state: Arc<AppState>) -> Router {
    let protected = Router::new()
        .nest("/wallet", wallet::router().merge(withdrawal::router()))
        .nest("/trades", trades::router())
        .nest("/swaps", swaps::router())
        .nest("/offers", offers::router())
        .nest("/cards", cards::router())
        .nest("/chat", chat::router())
        .nest("/ocr", ocr::router())
        .nest("/users", users::router())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    Router::new()
        .route("/health", get(|| async { "OK" }))
        .route("/internal/cron/expire-trades", post(cron_expire_trades))
        .route("/internal/cron/sweep-fees", post(cron_sweep_fees))
        .route("/internal/cron/rebalance-offers", post(cron_rebalance_offers))
        .route("/wallet/prices", get(wallet::get_prices))
        .route("/offers/payment-methods", get(offers::list_payment_methods))
        .route("/offers/currencies", get(offers::list_currencies))
        .merge(protected)
        .with_state(state)
}

fn require_cron_key(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    if state.internal_cron_key.is_empty() {
        return Err(AppError::Forbidden("INTERNAL_CRON_KEY is not configured on server".into()));
    }
    let provided = headers
        .get("x-cron-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if provided != state.internal_cron_key {
        return Err(AppError::Unauthorized("Invalid cron key".into()));
    }
    Ok(())
}

async fn cron_expire_trades(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<serde_json::Value>, AppError> {
    require_cron_key(&state, &headers)?;
    expire_stale_trades(state).await;
    Ok(Json(serde_json::json!({ "ok": true, "job": "expire-trades" })))
}

async fn cron_sweep_fees(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<serde_json::Value>, AppError> {
    require_cron_key(&state, &headers)?;
    sweep_platform_fees_background(state).await;
    Ok(Json(serde_json::json!({ "ok": true, "job": "sweep-fees" })))
}

async fn cron_rebalance_offers(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Result<Json<serde_json::Value>, AppError> {
    require_cron_key(&state, &headers)?;
    rebalance_all_active_offers(state).await;
    Ok(Json(serde_json::json!({ "ok": true, "job": "rebalance-offers" })))
}

pub async fn rebalance_all_active_offers(state: Arc<AppState>) {
    offers::rebalance_all_active_offers(state).await;
}
