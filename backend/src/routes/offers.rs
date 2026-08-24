use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{
    Offer, OfferStatus, OfferType, CreateOfferRequest, UpdateOfferRequest, UpdateOfferStatusRequest,
    CryptoReleaserSide,
    UserProfile,
    PaymentMethod, FIAT_CURRENCIES, payment_methods,
};
use crate::AppState;
use axum::{
    extract::{Path, Query},
    http::{HeaderMap, StatusCode},
    routing::{get, patch, post},
    Json, Router,
};
use std::collections::HashMap;
use std::sync::Arc;
use tracing::{info, warn};
use uuid::Uuid;

#[derive(Debug, serde::Deserialize, Default)]
struct OfferListQuery {
    market: Option<bool>,
    side: Option<String>,
    coin: Option<String>,
    amount: Option<f64>,
    currency: Option<String>,
    payment_method: Option<String>,
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_offers).post(create_offer))
        .route("/:id", patch(update_offer).delete(delete_offer))
        .route("/:id/status", patch(toggle_offer_status))
        .route("/admin/normalize-crypto-releaser-side", post(normalize_crypto_releaser_side))
}

fn require_admin_key(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    if state.swap_admin_key.is_empty() {
        return Err(AppError::Forbidden(
            "Endpoint is disabled unless SWAP_ADMIN_KEY is configured".into(),
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

pub async fn list_payment_methods() -> Json<Vec<PaymentMethod>> {
    Json(payment_methods())
}

pub async fn list_currencies() -> Json<serde_json::Value> {
    let list: Vec<serde_json::Value> = FIAT_CURRENCIES
        .iter()
        .map(|(code, name)| serde_json::json!({ "code": code, "name": name }))
        .collect();
    Json(serde_json::Value::Array(list))
}

fn sanitize_terms(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Terms cannot be empty".into()));
    }
    if trimmed.chars().count() > 500 {
        return Err(AppError::BadRequest("Terms must be 500 characters or fewer".into()));
    }
    let sanitized: String = trimmed
        .chars()
        .filter(|&c| c != '<' && c != '>' && c != '\0' && (c >= ' ' || c == '\n' || c == '\t'))
        .collect();

    let lowered = sanitized.to_lowercase();
    let prohibited_terms = [
        "prostitution",
        "escort service",
        "sex work",
        "brothel",
        "murder for hire",
        "hitman",
        "assassination",
        "cocaine",
        "heroin",
        "fentanyl",
        "meth",
        "methamphetamine",
        "ecstasy",
        "mdma",
        "drug trafficking",
        "sell drugs",
        "buy drugs",
        "illegal activity",
        "stolen card",
        "fake id",
        "forged documents",
        "human trafficking",
    ];

    if prohibited_terms.iter().any(|term| lowered.contains(term)) {
        return Err(AppError::BadRequest(
            "Offer terms contain prohibited language related to illegal activity".into(),
        ));
    }

    Ok(sanitized)
}

fn resolve_payment_method<'a>(card: &str, pms: &'a [PaymentMethod]) -> Result<&'a PaymentMethod, AppError> {
    pms.iter()
        .find(|p| p.id == card || p.name.to_lowercase() == card.to_lowercase())
        .ok_or_else(|| AppError::BadRequest("Unknown payment method".into()))
}

fn normalize_currency(raw: &str) -> String {
    raw.trim().to_uppercase()
}

fn ensure_currency_supported(currency: &str) -> Result<(), AppError> {
    if FIAT_CURRENCIES.iter().any(|(c, _)| *c == currency) {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!("Unknown currency: {}", currency)))
    }
}

fn ensure_payment_method_currency_allowed(pm: &PaymentMethod, currency: &str) -> Result<(), AppError> {
    if let Some(allowed) = &pm.allowed_currencies {
        if !allowed.iter().any(|c| c == currency) {
            return Err(AppError::BadRequest(format!(
                "{} only accepts: {}",
                pm.name, allowed.join(", ")
            )));
        }
    }
    Ok(())
}

fn validate_coin(coin: &str) -> Result<String, AppError> {
    let normalized = coin.trim().to_uppercase();
    match normalized.as_str() {
        "BTC" | "ETH" | "USDT" | "USDC" => Ok(normalized),
        _ => Err(AppError::BadRequest(format!(
            "Unsupported coin: {}. Supported coins: BTC, ETH, USDT, USDC",
            coin
        ))),
    }
}

fn payment_method_escrow_fee_pct(card: &str) -> f64 {
    let lower = card.trim().to_lowercase();
    payment_methods()
        .into_iter()
        .find(|pm| pm.id == lower || pm.name.to_lowercase() == lower)
        .map(|pm| pm.escrow_fee_pct)
        .unwrap_or(1.0)
}

fn required_locked_crypto_for_fiat(fiat_amount: f64, fiat_to_usd: f64, coin_price_usd: f64, profit_pct: f64,
    escrow_fee_pct: f64) -> Option<f64> {
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

async fn ensure_no_duplicate_active_offer(db: &RtdbClient<'_>, creator_uid: &str, card_id: &str, currency: &str,
    offer_type: &OfferType, exclude_id: Option<&str>) -> Result<(), AppError> {
    let existing: Vec<Offer> = db
        .get_collection("offers")
        .await?
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Offer>(v).ok())
        .collect();

    if existing.iter().any(|o| {
        o.creator_uid == creator_uid
            && o.card == card_id
            && o.currency == currency
            && &o.offer_type == offer_type
            && exclude_id.map(|id| o.id != id).unwrap_or(true)
            && o.status == OfferStatus::Active
    }) {
        return Err(AppError::BadRequest(
            "You already have an active offer for this trade type, payment method, and currency".into(),
        ));
    }

    Ok(())
}

fn offer_passes_market_filters(
    offer: &Offer,
    user_uid: &str,
    desired_offer_type: &Option<OfferType>,
    requested_coin: Option<&str>,
    requested_currency: Option<&str>,
    requested_pm: Option<&str>,
) -> bool {
    if offer.status != OfferStatus::Active || offer.creator_uid == user_uid {
        return false;
    }
    if let Some(target) = desired_offer_type {
        if &offer.offer_type != target {
            return false;
        }
    }
    if let Some(curr) = requested_currency {
        if offer.currency.trim().to_uppercase() != curr {
            return false;
        }
    }
    if let Some(coin) = requested_coin {
        if offer.coin.trim().to_uppercase() != coin {
            return false;
        }
    }
    if let Some(pm) = requested_pm {
        if offer.card != pm {
            return false;
        }
    }
    true
}

fn inferred_crypto_releaser_side(offer_type: &OfferType) -> CryptoReleaserSide {

    match offer_type {
        OfferType::Buy => CryptoReleaserSide::Taker,
        OfferType::Sell => CryptoReleaserSide::Maker,
    }
}

fn effective_crypto_releaser_side(offer: &Offer) -> CryptoReleaserSide {
    inferred_crypto_releaser_side(&offer.offer_type)
}

async fn normalize_crypto_releaser_side(ctx: Ctx, headers: HeaderMap) -> Result<Json<serde_json::Value>, AppError> {
    require_admin_key(&ctx.state, &headers)?;

    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let docs = db.get_collection("offers").await?;

    let mut scanned = 0u64;
    let mut updated = 0u64;

    for val in docs {
        let Ok(mut offer) = serde_json::from_value::<Offer>(val) else {
            continue;
        };
        scanned += 1;

        let desired = inferred_crypto_releaser_side(&offer.offer_type);
        if offer.crypto_releaser_side == Some(desired) {
            continue;
        }

        offer.crypto_releaser_side = Some(desired);
        db.set(&format!("offers/{}", offer.id), &serde_json::to_value(&offer).unwrap())
            .await?;
        updated += 1;
    }

    Ok(Json(serde_json::json!({
        "ok": true,
        "scanned": scanned,
        "updated": updated
    })))
}

async fn offer_has_sufficient_balance_for_market(
    state: &AppState,
    admin_db: &RtdbClient<'_>,
    offer: &Offer,
    user_uid: &str,
    fiat_amount: f64,
    fiat_to_usd_by_currency: &mut HashMap<String, f64>,
    coin_usd_by_coin: &mut HashMap<String, f64>,
    balance_by_uid_coin: &mut HashMap<String, f64>,
) -> Result<bool, AppError> {
    let coin = offer.coin.trim().to_uppercase();
    if coin.is_empty() {
        return Ok(false);
    }

    let coin_price_usd = if let Some(v) = coin_usd_by_coin.get(&coin) {
        *v
    } else {
        let v = fetch_coin_usd_price(state, &coin).await?;
        coin_usd_by_coin.insert(coin.clone(), v);
        v
    };

    if coin_price_usd <= 0.0 {
        return Ok(false);
    }

    let normalized_currency = offer.currency.trim().to_uppercase();
    let fiat_to_usd = if let Some(v) = fiat_to_usd_by_currency.get(&normalized_currency) {
        *v
    } else {
        let v = convert_to_usd(state, 1.0, &normalized_currency).await?;
        fiat_to_usd_by_currency.insert(normalized_currency.clone(), v);
        v
    };
    if fiat_to_usd <= 0.0 {
        return Ok(false);
    }

    let escrow_fee_pct = payment_method_escrow_fee_pct(&offer.card);
    let Some(required_crypto) = required_locked_crypto_for_fiat(
        fiat_amount,
        fiat_to_usd,
        coin_price_usd,
        offer.profit_pct,
        escrow_fee_pct,
    ) else {
        return Ok(false);
    };

    let crypto_giver_uid = match effective_crypto_releaser_side(offer) {
        CryptoReleaserSide::Maker => offer.creator_uid.clone(),
        CryptoReleaserSide::Taker => user_uid.to_string(),
    };

    let bal_key = format!("{}:{}", crypto_giver_uid, coin.to_lowercase());
    let available = if let Some(v) = balance_by_uid_coin.get(&bal_key) {
        *v
    } else {
        let v = read_balance_coin(admin_db, &crypto_giver_uid, &coin).await?;
        balance_by_uid_coin.insert(bal_key, v);
        v
    };

    Ok(available + 1e-12 >= required_crypto)
}

async fn validate_min_max_amounts(state: &AppState, min_amount: Option<f64>, max_amount: Option<f64>, currency: &str) -> Result<(), AppError> {
    let (min, max) = match (min_amount, max_amount) {
        (Some(min), Some(max)) => (min, max),
        _ => {
            return Err(AppError::BadRequest(
                "Both minimum and maximum trade amounts are required".into(),
            ));
        }
    };

    if min <= 0.0 || max <= 0.0 {
        return Err(AppError::BadRequest("Minimum and maximum amounts must be positive".into()));
    }
    if max <= min {
        return Err(AppError::BadRequest("Maximum amount must be greater than minimum amount".into()));
    }

    let min_usd_value = convert_to_usd(state, min, currency).await?;
    if min_usd_value < 10.0 {
        return Err(AppError::BadRequest(format!(
            "Minimum trade amount must be worth at least $10 USD (currently ~${:.2})",
            min_usd_value
        )));
    }

    Ok(())
}

struct BalanceAdjustmentResult {
    should_deactivate: bool,
    adjusted_max_amount: Option<f64>,
    max_amount_auto_adjusted: bool,
}

async fn check_and_adjust_offer_balance(
    admin_db: &RtdbClient<'_>,
    state: &AppState,
    user_uid: &str,
    crypto_releaser_side: CryptoReleaserSide,
    coin: &str,
    currency: &str,
    min_amount: Option<f64>,
    max_amount: Option<f64>,
    profit_pct: f64,
    card_id: &str,
) -> Result<BalanceAdjustmentResult, AppError> {
    if crypto_releaser_side != CryptoReleaserSide::Maker {
        return Ok(BalanceAdjustmentResult {
            should_deactivate: false,
            adjusted_max_amount: max_amount,
            max_amount_auto_adjusted: false,
        });
    }

    let crypto_balance = read_balance_coin(admin_db, user_uid, coin).await?;

    let (Some(min_fiat), Some(max_fiat)) = (min_amount, max_amount) else {
        return Ok(BalanceAdjustmentResult {
            should_deactivate: false,
            adjusted_max_amount: max_amount,
            max_amount_auto_adjusted: false,
        });
    };

    let coin_price_usd = fetch_coin_usd_price(state, coin).await?;
    let fiat_to_usd = convert_to_usd(state, 1.0, currency).await?;
    let escrow_fee_pct = payment_method_escrow_fee_pct(card_id);

    let min_crypto_required = required_locked_crypto_for_fiat(
        min_fiat,
        fiat_to_usd,
        coin_price_usd,
        profit_pct,
        escrow_fee_pct,
    )
    .ok_or_else(|| AppError::BadRequest("Invalid min amount/price/profit configuration".into()))?;

    let max_crypto_required = required_locked_crypto_for_fiat(
        max_fiat,
        fiat_to_usd,
        coin_price_usd,
        profit_pct,
        escrow_fee_pct,
    )
    .ok_or_else(|| AppError::BadRequest("Invalid max amount/price/profit configuration".into()))?;

    if crypto_balance < min_crypto_required {
        return Ok(BalanceAdjustmentResult {
            should_deactivate: true,
            adjusted_max_amount: None,
            max_amount_auto_adjusted: false,
        });
    }

    if crypto_balance < max_crypto_required {

        let escrow_rate = (escrow_fee_pct / 100.0).clamp(0.0, 0.95);
        let net_crypto_available = crypto_balance * (1.0 - escrow_rate);
        let multiplier = 1.0 + (profit_pct / 100.0);
        if multiplier <= 0.0 {
            return Err(AppError::BadRequest("Invalid profit_pct".into()));
        }
        let adjusted_max_fiat = (net_crypto_available * coin_price_usd * multiplier) / fiat_to_usd;
        return Ok(BalanceAdjustmentResult {
            should_deactivate: false,
            adjusted_max_amount: Some(adjusted_max_fiat.max(min_fiat)),
            max_amount_auto_adjusted: true,
        });
    }

    Ok(BalanceAdjustmentResult {
        should_deactivate: false,
        adjusted_max_amount: max_amount,
        max_amount_auto_adjusted: false,
    })
}

async fn create_offer(ctx: Ctx, Json(req): Json<CreateOfferRequest>) -> Result<Json<Offer>, AppError> {
    let state = &ctx.state;
    let user = &ctx.user;
    let pms = payment_methods();
    let pm = resolve_payment_method(&req.card, &pms)?;
    let card_id = pm.id.clone();

    let currency = normalize_currency(&req.currency);
    ensure_currency_supported(&currency)?;
    ensure_payment_method_currency_allowed(pm, &currency)?;

    let coin = validate_coin(&req.coin)?;
    let crypto_releaser_side = inferred_crypto_releaser_side(&req.offer_type);

    if !(-100.0..=200.0).contains(&req.profit_pct) {
        return Err(AppError::BadRequest("profit_pct must be between -100 and 200".into()));
    }

    validate_min_max_amounts(&state, req.min_amount, req.max_amount, &currency).await?;

    let terms = sanitize_terms(&req.terms)?;

    let db = RtdbClient::new(&state, &user.id_token);
    ensure_no_duplicate_active_offer(&db, &user.uid, &card_id, &currency, &req.offer_type, None).await?;

    if !matches!(req.time_limit_secs, 900 | 1800 | 3600) {
        return Err(AppError::BadRequest("time_limit_secs must be 900 (15 min), 1800 (30 min), or 3600 (1 hr)".into()));
    }

    let balance_db = RtdbClient::new(&state, &user.id_token);
    let balance_result = check_and_adjust_offer_balance(
        &balance_db,
        &state,
        &user.uid,
        crypto_releaser_side,
        &coin,
        &currency,
        req.min_amount,
        req.max_amount,
        req.profit_pct,
        &card_id,
    )
    .await?;

    if balance_result.should_deactivate {
        return Err(AppError::BadRequest("Insufficient crypto balance to create this sell offer: minimum amount is not coverable".into()));
    }

    let final_status = OfferStatus::Active;

    let final_max_amount = balance_result.adjusted_max_amount.or(req.max_amount);

    let offer = Offer {
        id: Uuid::new_v4().to_string(),
        creator_uid: user.uid.clone(),
        offer_type: req.offer_type,
        card: card_id,
        currency,
        coin,
        terms,
        profit_pct: req.profit_pct,
        status: final_status,
        time_limit_secs: req.time_limit_secs,
        created_at: unix_now(),
        feedback_pos: None,
        feedback_neg: None,
        min_amount: req.min_amount,
        max_amount: final_max_amount,
        max_amount_auto_adjusted: balance_result.max_amount_auto_adjusted,
        crypto_releaser_side: Some(crypto_releaser_side),
        creator_last_active_at: None,
    };

    db.set(&format!("offers/{}", offer.id), &serde_json::to_value(&offer).unwrap()).await?;

    Ok(Json(offer))
}

async fn list_offers(ctx: Ctx, Query(query): Query<OfferListQuery>) -> Result<Json<Vec<Offer>>, AppError> {
    let state = &ctx.state;
    let user = &ctx.user;
    let is_market = query.market.unwrap_or(false);
    let db = RtdbClient::new(&state, &user.id_token);
    let docs = db.get_collection("offers").await?;

    let mut offers: Vec<Offer> = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Offer>(v).ok())
        .collect();

    if is_market {
        let my_profile = db
            .get(&format!("users/{}", user.uid))
            .await?
            .and_then(|v| serde_json::from_value::<UserProfile>(v).ok());

        let mut profiles_by_uid: HashMap<String, UserProfile> = HashMap::new();
        if let Ok(user_docs) = db.get_collection("users").await {
            for v in user_docs {
                if let Ok(p) = serde_json::from_value::<UserProfile>(v) {
                    profiles_by_uid.insert(p.uid.clone(), p);
                }
            }
        }

        let side = query.side.as_deref().map(|s| s.trim().to_lowercase());
        let desired_offer_type = match side.as_deref() {
            Some("buy") => Some(OfferType::Sell),
            Some("sell") => Some(OfferType::Buy),
            _ => None,
        };
        let amount = query.amount.filter(|v| *v > 0.0);
        let requested_coin = query.coin.as_deref().map(normalize_currency);
        let requested_currency = query.currency.as_deref().map(normalize_currency);
        let requested_pm = query.payment_method.as_deref().map(|p| p.trim().to_string());

        let mut fiat_to_usd_by_currency: HashMap<String, f64> = HashMap::new();
        let mut coin_usd_by_coin: HashMap<String, f64> = HashMap::new();
        let mut balance_by_uid_coin: HashMap<String, f64> = HashMap::new();
        let mut filtered = Vec::new();
        let balance_db = RtdbClient::new_admin(&state);
        let mut balance_checks_enabled = true;

        for mut offer in offers {
            if !offer_passes_market_filters(
                &offer,
                &user.uid,
                &desired_offer_type,
                requested_coin.as_deref(),
                requested_currency.as_deref(),
                requested_pm.as_deref(),
            ) {
                continue;
            }

            let creator_profile = profiles_by_uid.get(&offer.creator_uid);
            offer.creator_last_active_at = creator_profile
                .and_then(|p| (p.last_active_at > 0).then_some(p.last_active_at));
            let i_blocked_them = my_profile
                .as_ref()
                .map(|p| p.blocked_users.contains(&offer.creator_uid))
                .unwrap_or(false);
            let they_blocked_me = creator_profile
                .map(|p| p.blocked_users.contains(&user.uid))
                .unwrap_or(false);
            if i_blocked_them || they_blocked_me {
                continue;
            }

            if balance_checks_enabled {
                let side = effective_crypto_releaser_side(&offer);
                match check_and_adjust_offer_balance(
                    &balance_db,
                    &state,
                    &offer.creator_uid,
                    side,
                    &offer.coin,
                    &offer.currency,
                    offer.min_amount,
                    offer.max_amount,
                    offer.profit_pct,
                    &offer.card,
                )
                .await {
                    Ok(adjustment) => {
                        if adjustment.should_deactivate {
                            continue;
                        }

                        let old_max_amount = offer.max_amount;
                        offer.max_amount = adjustment.adjusted_max_amount.or(offer.max_amount);
                        offer.max_amount_auto_adjusted = adjustment.max_amount_auto_adjusted;

                        if offer.max_amount != old_max_amount {
                            db.set(
                                &format!("offers/{}", offer.id),
                                &serde_json::to_value(&offer).unwrap(),
                            )
                            .await?;
                        }
                    }
                    Err(e) if is_rtdb_permission_error(&e) => {
                        warn!("list_offers market: admin balance checks disabled due to RTDB permission error: {}", e);
                        balance_checks_enabled = false;

                        if side == CryptoReleaserSide::Maker {
                            continue;
                        }
                    }
                    Err(e) => return Err(e),
                }
            } else if effective_crypto_releaser_side(&offer) == CryptoReleaserSide::Maker {
                continue;
            }

            if let Some(fiat_amount) = amount {
                match (offer.min_amount, offer.max_amount) {
                    (Some(min), Some(max)) if fiat_amount >= min && fiat_amount <= max => {}
                    _ => continue,
                }
            }

            if let Some(fiat_amount) = amount {
                if balance_checks_enabled {
                    match offer_has_sufficient_balance_for_market(
                        &state,
                        &balance_db,
                        &offer,
                        &user.uid,
                        fiat_amount,
                        &mut fiat_to_usd_by_currency,
                        &mut coin_usd_by_coin,
                        &mut balance_by_uid_coin,
                    ).await {
                        Ok(has_balance) => {
                            if !has_balance {
                                continue;
                            }
                        }
                        Err(e) if is_rtdb_permission_error(&e) => {
                            warn!("list_offers market: amount balance filter disabled due to RTDB permission error: {}", e);
                            balance_checks_enabled = false;
                        }
                        Err(e) => return Err(e),
                    }
                }
            }

            filtered.push(offer);
        }

        offers = filtered;
    } else {
        let balance_db = RtdbClient::new(&state, &user.id_token);
        let self_last_active_at = db
            .get(&format!("users/{}", user.uid))
            .await?
            .and_then(|v| v.get("last_active_at").and_then(|x| x.as_u64()));

        for offer in &mut offers {
            if offer.creator_uid == user.uid {
                offer.creator_last_active_at = self_last_active_at;

                if offer.status == OfferStatus::Active {
                    let side = effective_crypto_releaser_side(offer);
                    let adjustment = check_and_adjust_offer_balance(
                        &balance_db,
                        &state,
                        &user.uid,
                        side,
                        &offer.coin,
                        &offer.currency,
                        offer.min_amount,
                        offer.max_amount,
                        offer.profit_pct,
                        &offer.card,
                    )
                    .await?;

                    let old_status = offer.status.clone();
                    let old_max = offer.max_amount;
                    let old_auto = offer.max_amount_auto_adjusted;

                    if adjustment.should_deactivate {
                        offer.status = OfferStatus::Inactive;
                    }
                    offer.max_amount = adjustment.adjusted_max_amount.or(offer.max_amount);
                    offer.max_amount_auto_adjusted = adjustment.max_amount_auto_adjusted;

                    if offer.status != old_status
                        || offer.max_amount != old_max
                        || offer.max_amount_auto_adjusted != old_auto
                    {
                        db.set(
                            &format!("offers/{}", offer.id),
                            &serde_json::to_value(&offer).unwrap(),
                        )
                        .await?;
                    }
                }
            }
        }
    }

    offers.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(offers))
}

fn is_rtdb_permission_error(err: &AppError) -> bool {
    match err {
        AppError::Internal(msg) => {
            let lowered = msg.to_lowercase();
            lowered.contains("permission denied") || lowered.contains("401 unauthorized") || lowered.contains("401")
        }
        _ => false,
    }
}

async fn read_balance_coin(db: &RtdbClient<'_>, uid: &str, coin: &str) -> Result<f64, AppError> {
    Ok(db
        .get(&format!("balances/{}/{}", uid, coin.trim().to_lowercase()))
        .await?
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0))
}

async fn fetch_coin_usd_price(state: &AppState, coin: &str) -> Result<f64, AppError> {
    let coin = coin.trim().to_uppercase();
    if coin == "USDT" || coin == "USDC" {
        return Ok(1.0);
    }

    let pair = match coin.as_str() {
        "BTC" => "XXBTZUSD",
        "ETH" => "XETHZUSD",
        _ => {
            return Err(AppError::BadRequest(format!(
                "Unsupported coin for market filtering: {}",
                coin
            )));
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

async fn toggle_offer_status(ctx: Ctx, Path(id): Path<String>, Json(req): Json<UpdateOfferStatusRequest>) -> Result<Json<Offer>, AppError> {
    let state = &ctx.state;
    let user = &ctx.user;
    let db = RtdbClient::new(&state, &user.id_token);
    let val = db
        .get(&format!("offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Offer '{}' not found", id)))?;

    let mut offer = serde_json::from_value::<Offer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.creator_uid != user.uid {
        return Err(AppError::Forbidden(
            "You can only modify your own offers".into(),
        ));
    }

    if req.active {
        let side = effective_crypto_releaser_side(&offer);
        let balance_db = RtdbClient::new(&state, &user.id_token);
        let balance_result = check_and_adjust_offer_balance(
            &balance_db,
            &state,
            &user.uid,
            side,
            &offer.coin,
            &offer.currency,
            offer.min_amount,
            offer.max_amount,
            offer.profit_pct,
            &offer.card,
        )
        .await?;

        if balance_result.should_deactivate {
            return Err(AppError::BadRequest(
                "Cannot activate this offer: insufficient crypto balance for minimum trade amount".into(),
            ));
        }

        offer.max_amount = balance_result.adjusted_max_amount.or(offer.max_amount);
        offer.max_amount_auto_adjusted = balance_result.max_amount_auto_adjusted;
        offer.status = OfferStatus::Active;
    } else {
        offer.status = OfferStatus::Inactive;
    }

    db.set(
        &format!("offers/{}", id),
        &serde_json::to_value(&offer).unwrap(),
    )
    .await?;

    Ok(Json(offer))
}

async fn update_offer(ctx: Ctx, Path(id): Path<String>, Json(req): Json<UpdateOfferRequest>) -> Result<Json<Offer>, AppError> {
    let state = &ctx.state;
    let user = &ctx.user;
    let db = RtdbClient::new(&state, &user.id_token);
    let val = db
        .get(&format!("offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Offer '{}' not found", id)))?;

    let mut offer = serde_json::from_value::<Offer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.creator_uid != user.uid {
        return Err(AppError::Forbidden("You can only modify your own offers".into()));
    }

    if req.offer_type != offer.offer_type {
        return Err(AppError::BadRequest(
            "Offer type cannot be changed after creation".into(),
        ));
    }

    let pms = payment_methods();
    let pm = resolve_payment_method(&req.card, &pms)?;
    let card_id = pm.id.clone();

    let currency = normalize_currency(&req.currency);
    ensure_currency_supported(&currency)?;
    ensure_payment_method_currency_allowed(pm, &currency)?;

    let coin = validate_coin(&req.coin)?;
    let crypto_releaser_side = inferred_crypto_releaser_side(&offer.offer_type);

    if !(-100.0..=200.0).contains(&req.profit_pct) {
        return Err(AppError::BadRequest(
            "profit_pct must be between -100 and 200".into(),
        ));
    }

    validate_min_max_amounts(&state, req.min_amount, req.max_amount, &currency).await?;

    let terms = sanitize_terms(&req.terms)?;

    ensure_no_duplicate_active_offer(&db, &user.uid, &card_id, &currency, &offer.offer_type, Some(&id)).await?;

    let balance_db = RtdbClient::new(&state, &user.id_token);
    let balance_result = check_and_adjust_offer_balance(
        &balance_db,
        &state,
        &user.uid,
        crypto_releaser_side,
        &coin,
        &currency,
        req.min_amount,
        req.max_amount,
        req.profit_pct,
        &card_id,
    )
    .await?;

    offer.card = card_id;
    offer.currency = currency;
    offer.coin = coin;
    offer.terms = terms;
    offer.profit_pct = req.profit_pct;
    if matches!(req.time_limit_secs, 900 | 1800 | 3600) {
        offer.time_limit_secs = req.time_limit_secs;
    }
    offer.min_amount = req.min_amount;
    offer.max_amount = balance_result.adjusted_max_amount.or(req.max_amount);
    offer.max_amount_auto_adjusted = balance_result.max_amount_auto_adjusted;
    offer.crypto_releaser_side = Some(crypto_releaser_side);

    if balance_result.should_deactivate {
        offer.status = OfferStatus::Inactive;
    }

    db.set(&format!("offers/{}", id), &serde_json::to_value(&offer).unwrap())
    .await?;

    Ok(Json(offer))
}

async fn delete_offer(ctx: Ctx, Path(id): Path<String>) -> Result<StatusCode, AppError> {
    let state = &ctx.state;
    let user = &ctx.user;
    let db = RtdbClient::new(&state, &user.id_token);
    let val = db
        .get(&format!("offers/{}", id))
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Offer '{}' not found", id)))?;

    let offer = serde_json::from_value::<Offer>(val)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    if offer.creator_uid != user.uid {
        return Err(AppError::Forbidden("You can only delete your own offers".into()));
    }

    db.delete(&format!("offers/{}", id)).await?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn rebalance_active_offers_for_user(state: Arc<AppState>, uid: &str) -> Result<u64, AppError> {
    let db = RtdbClient::new_admin(&state);
    let docs = db.get_collection("offers").await?;

    let mut updated = 0u64;
    for val in docs {
        let Ok(mut offer) = serde_json::from_value::<Offer>(val) else {
            continue;
        };

        if offer.status != OfferStatus::Active || offer.creator_uid != uid {
            continue;
        }

        let side = effective_crypto_releaser_side(&offer);
        let balance_result = check_and_adjust_offer_balance(
            &db,
            &state,
            &offer.creator_uid,
            side,
            &offer.coin,
            &offer.currency,
            offer.min_amount,
            offer.max_amount,
            offer.profit_pct,
            &offer.card,
        )
        .await?;

        let new_status = if balance_result.should_deactivate {
            OfferStatus::Inactive
        } else {
            OfferStatus::Active
        };
        let new_max = balance_result.adjusted_max_amount.or(offer.max_amount);
        let new_auto = balance_result.max_amount_auto_adjusted;

        let changed = offer.status != new_status
            || offer.max_amount != new_max
            || offer.max_amount_auto_adjusted != new_auto;

        if !changed {
            continue;
        }

        offer.status = new_status;
        offer.max_amount = new_max;
        offer.max_amount_auto_adjusted = new_auto;
        db.set(&format!("offers/{}", offer.id), &serde_json::to_value(&offer).unwrap())
            .await?;
        updated += 1;
    }

    Ok(updated)
}

pub async fn rebalance_all_active_offers(state: Arc<AppState>) {
    let db = RtdbClient::new_admin(&state);
    let docs = match db.get_collection("offers").await {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("rebalance_all_active_offers: list failed: {e}");
            return;
        }
    };

    let mut uids = std::collections::HashSet::new();
    for val in docs {
        if let Ok(offer) = serde_json::from_value::<Offer>(val) {
            if offer.status == OfferStatus::Active {
                uids.insert(offer.creator_uid);
            }
        }
    }

    let mut touched = 0u64;
    for uid in uids {
        match rebalance_active_offers_for_user(state.clone(), &uid).await {
            Ok(n) => touched += n,
            Err(e) => tracing::warn!("rebalance_all_active_offers: user {} failed: {}", uid, e),
        }
    }

    if touched > 0 {
        tracing::info!("Cron: rebalanced {} offer(s)", touched);
    }
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

async fn convert_to_usd(state: &AppState, amount: f64, currency: &str) -> Result<f64, AppError> {
    let currency = currency.trim().to_uppercase();

    if currency == "USD" {
        info!(amount, currency, "Skipping FX lookup because currency is already USD");
        return Ok(amount);
    }
    info!(amount, currency, "Converting offer minimum to USD via open.er-api.com");

    match fetch_open_er_api_rate(state, &currency).await {
        Ok(rate) if rate > 0.0 => {
            let usd_value = amount * rate;
            info!(currency, rate, usd_value, "open.er-api.com rate lookup succeeded");
            return Ok(usd_value);
        }
        Ok(_) => {
            info!(currency, "open.er-api.com returned a non-usable rate");
        }
        Err(e) => {
            info!(currency, error = %e, "open.er-api.com rate lookup failed");
        }
    }
    info!(currency, "USD exchange-rate provider failed");

    Err(AppError::BadRequest(format!(
        "Unable to fetch USD exchange rate for {}. This currency may not be available through our exchange rate services. \
         Please check with support or use a different currency.",
        currency
    )))
}

async fn fetch_open_er_api_rate(state: &AppState, currency: &str) -> Result<f64, AppError> {
    let url = format!("https://open.er-api.com/v6/latest/{}", currency);
    info!(currency, %url, "Requesting open.er-api.com rate");

    let resp: serde_json::Value = state
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            info!(currency, error = %e, "open.er-api.com HTTP request failed");
            AppError::Internal(format!("open.er-api.com request failed: {}", e))
        })?
        .json()
        .await
        .map_err(|e| {
            info!(currency, error = %e, "open.er-api.com response JSON parse failed");
            AppError::Internal(format!("open.er-api.com parse failed: {}", e))
        })?;

    let result = resp["result"].as_str().unwrap_or("");
    if !result.is_empty() && result != "success" {
        return Err(AppError::Internal(format!(
            "open.er-api.com returned non-success result: {}",
            result
        )));
    }

    let rate = resp["rates"]["USD"]
        .as_f64()
        .ok_or_else(|| AppError::Internal("USD rate not found in open.er-api.com response".into()))?;

    if rate <= 0.0 {
        return Err(AppError::Internal("Invalid open.er-api.com exchange rate".into()));
    }

    info!(currency, rate, "open.er-api.com returned valid rate");
    Ok(rate)
}
