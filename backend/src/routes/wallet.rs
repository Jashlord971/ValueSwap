use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{LedgerBalance, SendRequest, SmartSendRequest, SmartSendResponse, Transaction, TransferRecord, UsernameEntry, UserProfile, WalletBalances, WalletInfo};
use crate::AppState;
use axum::http::HeaderMap;
use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use bitcoin::{
    bip32::{DerivationPath, Xpriv},
    secp256k1::Secp256k1,
    Address, Network, PublicKey,
};
use sha2::{Digest, Sha256};
use std::str::FromStr;
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::sync::RwLock;
use tiny_keccak::{Hasher, Keccak};
use axum::extract::Query;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
struct PriceCacheEntry {
    expires_at: u64,
    value: serde_json::Value,
}

static PRICE_CACHE: OnceLock<RwLock<HashMap<String, PriceCacheEntry>>> = OnceLock::new();

fn price_cache() -> &'static RwLock<HashMap<String, PriceCacheEntry>> {
    PRICE_CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn price_cache_ttl_secs() -> u64 {
    std::env::var("PRICE_CACHE_TTL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60)
        .clamp(10, 300)
}

async fn read_shared_price_cache(state: &AppState, ids: &[&str], now: u64) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    let admin_db = RtdbClient::new_admin(state);
    let Some(val) = admin_db.get("system_cache/prices").await.ok().flatten() else {
        return out;
    };
    let Some(obj) = val.as_object() else {
        return out;
    };

    for id in ids {
        if let Some(entry) = obj.get(*id).and_then(|v| v.as_object()) {
            let expires_at = entry.get("expires_at").and_then(|v| v.as_u64()).unwrap_or(0);
            let usd = entry.get("usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if expires_at > now && usd > 0.0 {
                out.insert((*id).to_string(), usd);
            }
        }
    }
    out
}

async fn write_shared_price_cache(state: &AppState, prices: &HashMap<String, f64>, expires_at: u64) {
    if prices.is_empty() {
        return;
    }
    let mut updates = serde_json::Map::new();
    for (id, usd) in prices {
        updates.insert(
            format!("system_cache/prices/{}", id),
            serde_json::json!({ "usd": usd, "expires_at": expires_at }),
        );
    }
    let admin_db = RtdbClient::new_admin(state);
    let _ = admin_db.multi_path_update(updates).await;
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/init", post(init_wallet))
        .route("/me", get(get_wallet))
        .route("/balances", get(get_balances))
        .route("/ledger", get(get_ledger))
        .route("/faucet", post(faucet_credit))
        .route("/dev/set-balance-usd", post(dev_set_balance_usd))
        .route("/platform-fees", get(get_platform_fees))
        .route("/platform-fees/sweep", post(sweep_platform_fees))
        .route("/treasury/addresses", get(get_treasury_addresses))
        .route("/send", post(send_internal))
        .route("/smart-send", post(smart_send))
        .route("/claim-deposits", post(claim_deposits))
        .route("/transactions", get(list_transactions))
}

#[derive(Debug, serde::Deserialize)]
struct FaucetRequest {
    coin: String,
    amount: f64,
}

#[derive(Debug, serde::Deserialize)]
struct SweepFeesRequest {
    coin: String,
    amount: f64,
}

#[derive(Debug, serde::Deserialize)]
struct DevSetBalanceUsdRequest {
    coin: String,
    usd_amount: f64,
}

async fn init_wallet(ctx: Ctx) -> Result<Json<WalletInfo>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let path = format!("wallets/{}", ctx.user.uid);

    if let Some(val) = db.get(&path).await? {
        let wallet: WalletInfo = serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))?;
        return Ok(Json(wallet));
    }

    let index = wallet_index_for_uid(&ctx.user.uid);

    let seed = &ctx.state.master_seed;
    let wallet = WalletInfo {
        btc_address:  derive_btc_address_indexed(seed, index).map_err(|e| AppError::Internal(e.to_string()))?,
        eth_address:  derive_eth_address_indexed(seed, index).map_err(|e| AppError::Internal(e.to_string()))?,
        tron_address: derive_tron_address_indexed(seed, index).map_err(|e| AppError::Internal(e.to_string()))?,
    };

    let mut updates = serde_json::Map::new();
    updates.insert(path, serde_json::to_value(&wallet).unwrap());
    updates.insert(format!("wallet_indices/{}", ctx.user.uid), serde_json::json!(index));
    db.multi_path_update(updates).await?;

    Ok(Json(wallet))
}

pub(crate) fn wallet_index_for_uid(uid: &str) -> u32 {
    let mut hasher = Sha256::new();
    hasher.update(uid.as_bytes());
    let digest = hasher.finalize();
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

async fn get_wallet(ctx: Ctx) -> Result<Json<WalletInfo>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    Ok(Json(fetch_wallet_info(&db, &ctx.user.uid).await?))
}

async fn get_ledger(ctx: Ctx) -> Result<Json<LedgerBalance>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);

    // apply_onchain_deposits fires 7 parallel external RPC/explorer calls —
    // expensive and, more importantly, hitting third-party rate limits.
    // Passive balance checks (this endpoint gets polled every 45s per open
    // wallet tab) don't need to redo that on every call; skip it if we
    // already checked recently. claim_deposits (explicit "sync now") below
    // bypasses this and always checks fresh.
    let onchain_check_key = format!("onchain-check:{}", ctx.user.uid);
    if ctx.state.ttl_cache.get::<bool>(&onchain_check_key).await.is_none() {
        apply_onchain_deposits(&ctx.state, &db, &ctx.user.uid).await?;
        ctx.state.ttl_cache.set(&onchain_check_key, &true, 20).await;
    }

    let balance = fetch_ledger_balance(&db, &ctx.user.uid).await?;
    Ok(Json(balance))
}

pub async fn record_transaction(
    db: &RtdbClient<'_>,
    uid: &str,
    kind: &str,
    direction: &str,
    coin: &str,
    amount: f64,
    counterparty_uid: Option<&str>,
    counterparty_label: Option<&str>,
    related_id: Option<&str>,
) -> Result<(), AppError> {
    let tx = Transaction {
        id: uuid::Uuid::new_v4().to_string(),
        uid: uid.to_string(),
        kind: kind.to_string(),
        direction: direction.to_string(),
        coin: coin.to_uppercase(),
        amount,
        counterparty_uid: counterparty_uid.map(ToOwned::to_owned),
        counterparty_label: counterparty_label.map(ToOwned::to_owned),
        related_id: related_id.map(ToOwned::to_owned),
        created_at: unix_now_secs(),
    };
    db.set(&format!("transactions/{}/{}", uid, tx.id), &serde_json::to_value(&tx).unwrap()).await
}

async fn list_transactions(ctx: Ctx) -> Result<Json<Vec<Transaction>>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let docs = db.get_collection(&format!("transactions/{}", ctx.user.uid)).await?;
    let mut txs = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Transaction>(v).ok())
        .collect::<Vec<_>>();
    txs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(txs))
}

async fn faucet_credit(ctx: Ctx, headers: HeaderMap, Json(req): Json<FaucetRequest>) -> Result<Json<LedgerBalance>, AppError> {
    ensure_dev_or_admin(&ctx.state, &headers)?;

    if req.amount <= 0.0 {
        return Err(AppError::BadRequest("amount must be positive".into()));
    }
    let coin = req.coin.to_lowercase();
    validate_coin(&coin)?;

    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let current = fetch_ledger_balance(&db, &ctx.user.uid).await?;
    let updated = match coin.as_str() {
        "btc" => LedgerBalance { btc: current.btc + req.amount, ..current },
        "eth" => LedgerBalance { eth: current.eth + req.amount, ..current },
        "usdt" => LedgerBalance { usdt: current.usdt + req.amount, ..current },
        "usdc" => LedgerBalance { usdc: current.usdc + req.amount, ..current },
        _ => unreachable!(),
    };

    db.set(
        &format!("balances/{}", ctx.user.uid),
        &serde_json::to_value(&updated).unwrap(),
    )
    .await?;
    Ok(Json(updated))
}

async fn dev_set_balance_usd(ctx: Ctx, Json(req): Json<DevSetBalanceUsdRequest>) -> Result<Json<serde_json::Value>, AppError> {
    ensure_dev_mode()?;

    if req.usd_amount < 0.0 {
        return Err(AppError::BadRequest("usd_amount must be >= 0".into()));
    }

    let coin = req.coin.to_lowercase();
    validate_coin(&coin)?;

    let usd_price = fetch_coin_usd_price(&ctx.state, &coin).await?;
    if usd_price <= 0.0 {
        return Err(AppError::Internal("Invalid USD price for selected coin".into()));
    }

    let target_coin_amount = req.usd_amount / usd_price;
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let path = format!("balances/{}/{}", ctx.user.uid, coin);
    db.set(&path, &serde_json::json!(target_coin_amount)).await?;

    Ok(Json(serde_json::json!({
        "coin": coin.to_uppercase(),
        "usd_amount": req.usd_amount,
        "usd_price": usd_price,
        "coin_amount": target_coin_amount,
    })))
}

async fn get_platform_fees(ctx: Ctx) -> Result<Json<serde_json::Value>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let fees = db.get("platform_fees").await?.unwrap_or(serde_json::json!({}));
    Ok(Json(fees))
}

async fn sweep_platform_fees(ctx: Ctx, Json(req): Json<SweepFeesRequest>) -> Result<Json<serde_json::Value>, AppError> {
    if req.amount <= 0.0 {
        return Err(AppError::BadRequest("amount must be positive".into()));
    }
    let coin = req.coin.to_lowercase();
    validate_coin(&coin)?;

    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let fee_path = format!("platform_fees/{}", coin);
    let treasury_path = format!("treasury/balances/{}", coin);
    let fee_bal = db.get(&fee_path).await?.and_then(|v| v.as_f64()).unwrap_or(0.0);
    if fee_bal < req.amount {
        return Err(AppError::BadRequest(format!(
            "Insufficient platform fee balance in {}: have {:.8}, need {:.8}",
            coin.to_uppercase(), fee_bal, req.amount
        )));
    }
    let treasury_bal = db.get(&treasury_path).await?.and_then(|v| v.as_f64()).unwrap_or(0.0);

    let mut updates = serde_json::Map::new();
    updates.insert(fee_path, serde_json::json!(fee_bal - req.amount));
    updates.insert(treasury_path, serde_json::json!(treasury_bal + req.amount));
    db.multi_path_update(updates).await?;

    Ok(Json(serde_json::json!({
        "coin": coin.to_uppercase(),
        "swept": req.amount,
        "remaining_platform_fees": fee_bal - req.amount,
        "treasury_balance": treasury_bal + req.amount,
    })))
}

/// Deterministic index for the platform treasury's addresses — same
/// derivation scheme as user wallets (wallet_index_for_uid), just a fixed
/// reserved index instead of one hashed from a uid. Keys are re-derived
/// from the master seed on demand wherever they're needed (sweeping,
/// paying out queued withdrawals) and are NEVER written anywhere — not to
/// RTDB, not to logs. This used to write the raw private keys *and the
/// plaintext master mnemonic* to the `treasury` RTDB node, reachable by
/// any logged-in user with no admin check — that would have handed out
/// the key to every user's wallet on the platform, not just the
/// treasury's. Confirmed (Aug 2026) it was never actually called in
/// production before being caught and rewritten.
pub const TREASURY_INDEX: u32 = 900_000;

async fn get_treasury_addresses(ctx: Ctx) -> Result<Json<serde_json::Value>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    if !crate::moderation::is_moderator_email_cached(&ctx.state, &db, ctx.user.email.as_deref()).await? {
        return Err(AppError::Forbidden("Moderator access required".into()));
    }

    let seed = &ctx.state.master_seed;
    let btc_address = derive_btc_address_indexed(seed, TREASURY_INDEX)
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let eth_address = derive_eth_address_indexed(seed, TREASURY_INDEX)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(serde_json::json!({
        "wallets": {
            "btc": btc_address,
            "eth": eth_address,
            "usdt": eth_address,
            "usdc": eth_address,
        },
    })))
}

fn balance_updates(from_uid: &str, to_uid: &str, coin: &str, sender_new: f64, recipient_new: f64) -> serde_json::Map<String, serde_json::Value> {
    let mut updates = serde_json::Map::new();
    updates.insert(format!("balances/{}/{}", from_uid, coin), serde_json::json!(sender_new));
    updates.insert(format!("balances/{}/{}", to_uid, coin), serde_json::json!(recipient_new));
    updates
}

fn validate_coin(coin: &str) -> Result<(), AppError> {
    const VALID: &[&str] = &["btc", "eth", "usdt", "usdc"];
    if VALID.contains(&coin) { Ok(()) } else { Err(AppError::BadRequest(format!("Invalid coin: {}", coin))) }
}

async fn fetch_wallet_info(db: &RtdbClient<'_>, uid: &str) -> Result<WalletInfo, AppError> {
    let val = db.get(&format!("wallets/{}", uid)).await?.ok_or_else(|| AppError::NotFound("Wallet not initialised".into()))?;
    serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))
}

async fn fetch_user_profile(db: &RtdbClient<'_>, uid: &str) -> Result<UserProfile, AppError> {
    let val = db
        .get(&format!("users/{}", uid))
        .await?
        .ok_or_else(|| AppError::NotFound("User profile not found".into()))?;
    serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))
}

async fn send_internal(ctx: Ctx, Json(req): Json<SendRequest>) -> Result<Json<TransferRecord>, AppError> {
    let (state, user) = (&ctx.state, &ctx.user);
    if req.amount <= 0.0 {
        return Err(AppError::BadRequest("Amount must be greater than zero".into()));
    }
    let coin = req.coin.to_lowercase();
    validate_coin(&coin)?;

    crate::rate_limit::check_rate_limit(
        state, &format!("wallet-send:{}", user.uid), 8, 300, "attempting sends",
    ).await?;

    let db = RtdbClient::new(&state, &user.id_token);
    tracing::info!("/wallet/send: from_uid={}, to_email={}, coin={}, amount={}", user.uid, req.to_email, req.coin, req.amount);

    let sender_profile = fetch_user_profile(&db, &user.uid).await?;
    super::twofa::require_valid_totp_if_gated(
        state,
        user.email.as_deref(),
        &user.uid,
        sender_profile.withdraw_code_required,
        &sender_profile,
        req.totp_code.as_deref(),
    ).await?;

    let users_result = db.query_equal("users", "email", &req.to_email).await?;
    let recipient_uid = match users_result {
        None => return Err(AppError::NotFound("Recipient not found on this platform".into())),
        Some(val) => val
            .as_object()
            .and_then(|map| map.keys().next().cloned())
            .ok_or_else(|| AppError::NotFound("Recipient not found".into()))?,
    };
    if recipient_uid == user.uid {
        return Err(AppError::BadRequest("Cannot send to yourself".into()));
    }

    let record = do_internal_transfer(&ctx.state, &user.uid, &recipient_uid, &coin, req.amount).await?;
    Ok(Json(record))
}

async fn save_transfer_record(db: &RtdbClient<'_>, from_uid: &str, to_uid: &str, coin: &str, amount: f64) -> Result<TransferRecord, AppError> {
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    let record = TransferRecord {
        id: transfer_id.clone(),
        from_uid: from_uid.to_string(),
        to_uid: to_uid.to_string(),
        coin: coin.to_string(),
        amount,
        timestamp: now,
    };
    db.set(&format!("transfers/{}", transfer_id), &serde_json::to_value(&record).unwrap()).await?;
    Ok(record)
}

async fn fetch_ledger_balance(db: &RtdbClient<'_>, uid: &str) -> Result<LedgerBalance, AppError> {
    Ok(db.get(&format!("balances/{}", uid)).await?.map(|v| serde_json::from_value(v).unwrap_or_default()).unwrap_or_default())
}

fn compute_transfer(sender: &LedgerBalance, recipient: &LedgerBalance, coin: &str, amount: f64,) -> Result<(f64, f64), AppError> {
    let (sender_bal, recipient_bal) = match coin {
        "btc"  => (sender.btc,  recipient.btc),
        "eth"  => (sender.eth,  recipient.eth),
        "usdt" => (sender.usdt, recipient.usdt),
        "usdc" => (sender.usdc, recipient.usdc),
        _      => unreachable!(),
    };
    if sender_bal < amount {
        return Err(AppError::BadRequest(format!(
            "Insufficient platform balance: have {:.8} {}, need {:.8}",
            sender_bal,
            coin.to_uppercase(),
            amount,
        )));
    }
    Ok((sender_bal - amount, recipient_bal + amount))
}

pub fn detect_address_wallet_field(addr: &str) -> Option<&'static str> {
    if addr.starts_with("bc1") || (addr.starts_with('1') && addr.len() >= 25 && addr.len() <= 34) || addr.starts_with('3') {
        return Some("btc_address");
    }

    if addr.starts_with("0x") && addr.len() == 42 {
        return Some("eth_address");
    }

    if addr.starts_with('T') && addr.len() == 34 {
        return Some("tron_address");
    }
    None
}

async fn smart_send(ctx: Ctx, Json(req): Json<SmartSendRequest>) -> Result<Json<SmartSendResponse>, AppError> {
    let (state, user) = (&ctx.state, &ctx.user);
    if req.amount <= 0.0 {
        return Err(AppError::BadRequest("Amount must be positive".into()));
    }
    let coin = req.coin.to_lowercase();
    validate_coin(&coin)?;

    crate::rate_limit::check_rate_limit(
        state, &format!("wallet-send:{}", user.uid), 8, 300, "attempting sends",
    ).await?;

    let db = RtdbClient::new(&state, &user.id_token);
    let to_raw = req.to.trim().to_string();
    let identifier = to_raw.trim_start_matches('@');

    if identifier.is_empty() {
        return Err(AppError::BadRequest("Recipient cannot be empty".into()));
    }

    let sender_profile = fetch_user_profile(&db, &user.uid).await?;
    super::twofa::require_valid_totp_if_gated(
        state,
        user.email.as_deref(),
        &user.uid,
        sender_profile.withdraw_code_required,
        &sender_profile,
        req.totp_code.as_deref(),
    ).await?;

    let recipient_uid: Option<String> =
        if let Some(wallet_field) = detect_address_wallet_field(identifier) {
            let result = db.query_equal("wallets", wallet_field, identifier).await?;
            result.and_then(|v| v.as_object().and_then(|m| m.keys().next().cloned()))
        } else {

            let lower = identifier.to_lowercase();
            let result = db.get(&format!("usernames/{}", lower)).await?;
            match result.and_then(|v| UsernameEntry::from_value(&v, identifier)) {
                None => {
                    return Err(AppError::NotFound(format!("User '{}' not found on this platform", identifier)))
                }
                Some(entry) => Some(entry.uid),
            }
        };

    if let Some(uid) = recipient_uid {
        if uid == user.uid {
            return Err(AppError::BadRequest("Cannot send to yourself".into()));
        }
        let record = do_internal_transfer(&ctx.state, &user.uid, &uid, &coin, req.amount).await?;
        Ok(Json(SmartSendResponse {
            transfer_type: "internal".to_string(),
            transfer: Some(record),
            withdrawal: None,
        }))
    } else {
        let response =
            super::withdrawal::do_withdraw(&db, &state, &user.uid, &coin, identifier, req.amount)
                .await?;
        Ok(Json(SmartSendResponse {
            transfer_type: "onchain".to_string(),
            transfer: None,
            withdrawal: Some(response),
        }))
    }
}

async fn do_internal_transfer(state: &AppState, from_uid: &str, to_uid: &str, coin: &str, amount: f64) -> Result<TransferRecord, AppError> {
    let db = RtdbClient::new_admin(state);
    let sender_balance = fetch_ledger_balance(&db, from_uid).await?;
    let recipient_balance = fetch_ledger_balance(&db, to_uid).await?;

    let (sender_new, recipient_new) = compute_transfer(&sender_balance, &recipient_balance, coin, amount)?;

    db.multi_path_update(balance_updates(from_uid, to_uid, coin, sender_new, recipient_new)).await?;

    let record = save_transfer_record(&db, from_uid, to_uid, coin, amount).await?;

    if let Err(e) = record_transaction(&db, to_uid, "internal_transfer", "in", coin, amount, Some(from_uid), None, Some(&record.id)).await {
        tracing::warn!("Failed to record incoming transaction for {}: {}", to_uid, e);
    }
    if let Err(e) = record_transaction(&db, from_uid, "internal_transfer", "out", coin, amount, Some(to_uid), None, Some(&record.id)).await {
        tracing::warn!("Failed to record outgoing transaction for {}: {}", from_uid, e);
    }

    Ok(record)
}

async fn apply_onchain_deposits(state: &AppState, db: &RtdbClient<'_>, uid: &str) -> Result<(), AppError> {
    let wallet = fetch_wallet_info(db, uid).await?;

    let (btc, eth_mainnet, eth_arb, usdt_mainnet, usdt_arb, usdc_mainnet, usdc_arb) = tokio::join!(
        fetch_btc_balance(&state.http_client, &wallet.btc_address),
        fetch_eth_balance_from_rpc(&state.http_client, "https://cloudflare-eth.com", &wallet.eth_address),
        fetch_eth_balance_from_rpc(&state.http_client, "https://arb1.arbitrum.io/rpc", &wallet.eth_address),
        fetch_erc20_balance_from_rpc(&state.http_client, "https://cloudflare-eth.com", &wallet.eth_address, "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6),
        fetch_erc20_balance_from_rpc(&state.http_client, "https://arb1.arbitrum.io/rpc", &wallet.eth_address, "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9", 6),
        fetch_erc20_balance_from_rpc(&state.http_client, "https://cloudflare-eth.com", &wallet.eth_address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6),
        fetch_erc20_balance_from_rpc(&state.http_client, "https://arb1.arbitrum.io/rpc", &wallet.eth_address, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6),
    );

    let slots: &[(&str, &str, f64)] = &[
        ("btc",          "btc",  btc.unwrap_or(0.0)),
        ("eth_mainnet",  "eth",  eth_mainnet.unwrap_or(0.0)),
        ("eth_arb",      "eth",  eth_arb.unwrap_or(0.0)),
        ("usdt_mainnet", "usdt", usdt_mainnet.unwrap_or(0.0)),
        ("usdt_arb",     "usdt", usdt_arb.unwrap_or(0.0)),
        ("usdc_mainnet", "usdc", usdc_mainnet.unwrap_or(0.0)),
        ("usdc_arb",     "usdc", usdc_arb.unwrap_or(0.0)),
    ];

    let watermarks_val = db.get(&format!("deposit_watermarks/{}", uid)).await?;
    let mut watermarks: HashMap<String, f64> = watermarks_val
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();

    let mut ledger = fetch_ledger_balance(db, uid).await?;
    let mut multi_updates: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut new_deposits: Vec<(&str, &str, f64)> = Vec::new();

    for &(slot_key, coin, on_chain) in slots {
        let watermark = *watermarks.get(slot_key).unwrap_or(&0.0);
        let delta = on_chain - watermark;
        if delta > 1e-9 {
            let new_bal = match coin {
                "btc"  => { ledger.btc  += delta; ledger.btc  },
                "eth"  => { ledger.eth  += delta; ledger.eth  },
                "usdt" => { ledger.usdt += delta; ledger.usdt },
                "usdc" => { ledger.usdc += delta; ledger.usdc },
                _ => continue,
            };
            watermarks.insert(slot_key.to_string(), on_chain);
            multi_updates.insert(
                format!("deposit_watermarks/{}/{}", uid, slot_key),
                serde_json::json!(on_chain),
            );
            multi_updates.insert(
                format!("balances/{}/{}", uid, coin),
                serde_json::json!(new_bal),
            );
            new_deposits.push((slot_key, coin, delta));
        }
    }

    if !multi_updates.is_empty() {
        db.multi_path_update(multi_updates).await?;
        for (slot_key, coin, delta) in new_deposits {
            let network_label = slot_key.replace('_', " ");
            if let Err(e) = record_transaction(db, uid, "deposit", "in", coin, delta, None, Some(&network_label), None).await {
                tracing::warn!("Failed to record deposit transaction for {}: {}", uid, e);
            }
        }
    }
    Ok(())
}

async fn claim_deposits(ctx: Ctx) -> Result<Json<serde_json::Value>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    apply_onchain_deposits(&ctx.state, &db, &ctx.user.uid).await?;
    let ledger = fetch_ledger_balance(&db, &ctx.user.uid).await?;
    Ok(Json(serde_json::json!({
        "message": "Balances synced",
        "ledger": ledger
    })))
}

async fn get_balances(ctx: Ctx) -> Result<Json<WalletBalances>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let wallet = fetch_wallet_info(&db, &ctx.user.uid).await?;

    let (btc, eth_mainnet, eth_arbitrum, usdt_mainnet, usdt_arbitrum, usdc_mainnet, usdc_arbitrum) = tokio::join!(
        fetch_btc_balance(&ctx.state.http_client, &wallet.btc_address),
        fetch_eth_balance_from_rpc(&ctx.state.http_client, "https://cloudflare-eth.com", &wallet.eth_address),
        fetch_eth_balance_from_rpc(&ctx.state.http_client, "https://arb1.arbitrum.io/rpc", &wallet.eth_address),
        fetch_erc20_balance_from_rpc(&ctx.state.http_client, "https://cloudflare-eth.com", &wallet.eth_address, "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6),
        fetch_erc20_balance_from_rpc(&ctx.state.http_client, "https://arb1.arbitrum.io/rpc", &wallet.eth_address, "0xFd086bC7CD5C481DCC9C85ebe478A1C0b69FCbb9", 6),
        fetch_erc20_balance_from_rpc(&ctx.state.http_client, "https://cloudflare-eth.com", &wallet.eth_address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6),
        fetch_erc20_balance_from_rpc(&ctx.state.http_client, "https://arb1.arbitrum.io/rpc", &wallet.eth_address, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6),
    );

    Ok(Json(WalletBalances {
        btc: btc.unwrap_or(0.0),
        eth: eth_mainnet.unwrap_or(0.0) + eth_arbitrum.unwrap_or(0.0),
        usdt: usdt_mainnet.unwrap_or(0.0) + usdt_arbitrum.unwrap_or(0.0),
        usdc: usdc_mainnet.unwrap_or(0.0) + usdc_arbitrum.unwrap_or(0.0),
    }))
}

pub fn derive_eth_key_indexed(seed: &[u8], index: u32) -> Result<secp256k1::SecretKey, anyhow::Error> {
    let path = format!("m/44'/60'/{}'/0/0", index);
    let ext = tiny_hderive::bip32::ExtendedPrivKey::derive(seed, path.as_str())
        .map_err(|e| anyhow::anyhow!("{:?}", e))?;
    Ok(secp256k1::SecretKey::from_slice(&ext.secret())?)
}

pub(crate) fn derive_eth_address_indexed(seed: &[u8], index: u32) -> Result<String, anyhow::Error> {
    let secret_key = derive_eth_key_indexed(seed, index)?;
    let secp = secp256k1::Secp256k1::new();
    let public_key = secret_key.public_key(&secp);
    let pub_bytes = public_key.serialize_uncompressed();
    let mut keccak = Keccak::v256();
    let mut hash = [0u8; 32];
    keccak.update(&pub_bytes[1..]);
    keccak.finalize(&mut hash);
    Ok(format!("0x{}", hex::encode(&hash[12..])))
}

pub(crate) fn derive_btc_address_indexed(seed: &[u8], index: u32) -> Result<String, anyhow::Error> {
    let secp = Secp256k1::new();
    let xprv = Xpriv::new_master(Network::Bitcoin, seed)?;
    let path = DerivationPath::from_str(&format!("m/84'/0'/{}'/0/0", index))?;
    let child = xprv.derive_priv(&secp, &path)?;
    let pub_key: PublicKey = child.to_priv().public_key(&secp);
    let address = Address::p2wpkh(&pub_key, Network::Bitcoin)?;
    Ok(address.to_string())
}

fn derive_tron_address_indexed(seed: &[u8], index: u32) -> Result<String, anyhow::Error> {
    let path = format!("m/44'/195'/{}'/0/0", index);
    let ext = tiny_hderive::bip32::ExtendedPrivKey::derive(seed, path.as_str())
        .map_err(|e| anyhow::anyhow!("{:?}", e))?;
    let secp = secp256k1::Secp256k1::new();
    let secret_key = secp256k1::SecretKey::from_slice(&ext.secret())?;
    let public_key = secret_key.public_key(&secp);
    let pub_bytes = public_key.serialize_uncompressed();
    let mut keccak = Keccak::v256();
    let mut hash = [0u8; 32];
    keccak.update(&pub_bytes[1..]);
    keccak.finalize(&mut hash);
    let raw_addr = &hash[12..];
    let mut payload = vec![0x41u8];
    payload.extend_from_slice(raw_addr);
    let c1 = Sha256::digest(&payload);
    let c2 = Sha256::digest(&c1);
    payload.extend_from_slice(&c2[..4]);
    Ok(bs58::encode(payload).into_string())
}

pub(crate) async fn fetch_btc_balance(client: &reqwest::Client, address: &str) -> Result<f64, anyhow::Error> {
    let url = format!("https://blockstream.info/api/address/{}", address);
    let resp: serde_json::Value = client.get(&url).send().await?.json().await?;
    let funded = resp["chain_stats"]["funded_txo_sum"].as_u64().unwrap_or(0);
    let spent = resp["chain_stats"]["spent_txo_sum"].as_u64().unwrap_or(0);
    Ok(funded.saturating_sub(spent) as f64 / 1e8)
}

pub(crate) async fn fetch_eth_balance_from_rpc(client: &reqwest::Client, rpc_url: &str, address: &str) -> Result<f64, anyhow::Error> {
    let body = serde_json::json!({
        "jsonrpc": "2.0", "method": "eth_getBalance",
        "params": [address, "latest"], "id": 1,
    });
    let resp: serde_json::Value = client
        .post(rpc_url)
        .json(&body)
        .send()
        .await?
        .json()
        .await?;
    let hex = resp["result"].as_str().unwrap_or("0x0");
    let wei = u128::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(0);
    Ok(wei as f64 / 1e18)
}

pub(crate) async fn fetch_erc20_balance_from_rpc(client: &reqwest::Client, rpc_url: &str, address: &str, contract: &str, decimals: u32) -> Result<f64, anyhow::Error> {
    let addr_clean = address.trim_start_matches("0x");
    let data = format!("0x70a08231{:0>64}", addr_clean);
    let body = serde_json::json!({
        "jsonrpc": "2.0", "method": "eth_call",
        "params": [{"to": contract, "data": data}, "latest"],
        "id": 1,
    });
    let resp: serde_json::Value = client
        .post(rpc_url)
        .json(&body)
        .send()
        .await?
        .json()
        .await?;
    let hex = resp["result"].as_str().unwrap_or("0x0");
    let raw = u128::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(0);
    Ok(raw as f64 / 10u128.pow(decimals) as f64)
}

pub async fn get_prices(Query(params): Query<HashMap<String, String>>, State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>, AppError> {
    const STABLE_IDS: &[&str] = &["tether", "usd-coin"];

    let ids_str = params.get("ids").cloned().unwrap_or_default();
    let requested: Vec<&str> = ids_str.split(',').filter(|s| !s.is_empty()).collect();

    let mut key_parts: Vec<String> = requested.iter().map(|s| s.to_string()).collect();
    key_parts.sort();
    let cache_key = key_parts.join(",");
    let now = unix_now_secs();

    {
        let cache = price_cache().read().await;
        if let Some(entry) = cache.get(&cache_key) {
            if entry.expires_at > now {
                tracing::info!(
                    "Serving cached prices for ids='{}' (expires in {}s)",
                    cache_key,
                    entry.expires_at.saturating_sub(now)
                );
                return Ok(Json(entry.value.clone()));
            }
        }
    }

    let mut result = serde_json::Map::new();

    for &id in &requested {
        if STABLE_IDS.contains(&id) {
            result.insert(id.to_string(), serde_json::json!({ "usd": 1.0 }));
        }
    }

    let shared_hits = read_shared_price_cache(&state, &requested, now).await;
    for (id, usd) in &shared_hits {
        if !result.contains_key(id) {
            result.insert(id.clone(), serde_json::json!({ "usd": usd }));
        }
    }

    let to_fetch: Vec<(&str, &str)> = requested
        .iter()
        .filter(|&&id| !STABLE_IDS.contains(&id))
        .filter(|&&id| !result.contains_key(id))
        .filter_map(|&id| gecko_to_kraken(id).map(|pair| (id, pair)))
        .collect();

    let mut fresh_prices: HashMap<String, f64> = HashMap::new();

    if !to_fetch.is_empty() {
        let pairs_param = to_fetch.iter().map(|(_, p)| *p).collect::<Vec<_>>().join(",");
        let url = format!("https://api.kraken.com/0/public/Ticker?pair={}", pairs_param);
        tracing::info!("Fetching Kraken prices: {}", url);

        match state.http_client.get(&url).send().await {
            Err(e) => tracing::error!("Kraken request failed: {}", e),
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                tracing::info!("Kraken status={} body={:.300}", status, body);
                if status.is_success() {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&body) {
                        if let Some(result_obj) = val["result"].as_object() {
                            for (gecko_id, kraken_pair) in &to_fetch {
                                let entry = result_obj.get(*kraken_pair)
                                    .map(|v| v)
                                    .or_else(|| result_obj.iter().find(|(k, _)| k.contains(kraken_pair) || kraken_pair.contains(k.as_str())).map(|(_, v)| v));
                                if let Some(data) = entry {
                                    let price_str = data["c"][0].as_str().unwrap_or("0");
                                    let price: f64 = price_str.parse().unwrap_or(0.0);
                                    result.insert(gecko_id.to_string(), serde_json::json!({ "usd": price }));
                                    if price > 0.0 {
                                        fresh_prices.insert(gecko_id.to_string(), price);
                                    }
                                }
                            }
                        }
                    } else {
                        tracing::error!("Kraken JSON parse error, body: {}", body);
                    }
                } else {
                    tracing::error!("Kraken non-success status={} body={}", status, body);
                }
            }
        }
    }

    let value = serde_json::Value::Object(result);

    let ttl_secs = price_cache_ttl_secs();

    {
        let mut cache = price_cache().write().await;
        cache.insert(
            cache_key.clone(),
            PriceCacheEntry {
                expires_at: now + ttl_secs,
                value: value.clone(),
            },
        );
    }

    tracing::info!(
        "Cached prices for ids='{}' with ttl={}s",
        cache_key,
        ttl_secs
    );

    write_shared_price_cache(&state, &fresh_prices, now + ttl_secs).await;

    Ok(Json(value))
}

fn gecko_to_kraken(id: &str) -> Option<&'static str> {
    match id {
        "bitcoin" => Some("XXBTZUSD"),
        "ethereum" => Some("XETHZUSD"),
        _ => None,
    }
}

fn coin_to_gecko_id(coin: &str) -> Option<&'static str> {
    match coin {
        "btc" => Some("bitcoin"),
        "eth" => Some("ethereum"),
        "usdt" => Some("tether"),
        "usdc" => Some("usd-coin"),
        _ => None,
    }
}

fn ensure_dev_mode() -> Result<(), AppError> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    match std::env::var("ENABLE_DEV_TOOLS") {
        Ok(v) if v == "1" || v.eq_ignore_ascii_case("true") => Ok(()),
        _ => Err(AppError::Forbidden(
            "Developer tooling endpoint is disabled outside local development".into(),
        )),
    }
}

fn ensure_dev_or_admin(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    if ensure_dev_mode().is_ok() {
        return Ok(());
    }

    if state.swap_admin_key.is_empty() {
        return Err(AppError::Forbidden(
            "Endpoint is disabled outside dev unless SWAP_ADMIN_KEY is configured".into(),
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

async fn fetch_coin_usd_price(state: &AppState, coin: &str) -> Result<f64, AppError> {
    let gecko = coin_to_gecko_id(coin)
        .ok_or_else(|| AppError::BadRequest(format!("Unsupported coin: {}", coin)))?;

    if gecko == "tether" || gecko == "usd-coin" {
        return Ok(1.0);
    }

    let pair = gecko_to_kraken(gecko)
        .ok_or_else(|| AppError::Internal(format!("No Kraken mapping for {}", gecko)))?;
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

pub async fn sweep_platform_fees_background(state: Arc<AppState>) {
    let db = RtdbClient::new_admin(&state);
    let Some(fees_val) = db.get("platform_fees").await.ok().flatten() else {
        return;
    };
    let Some(map) = fees_val.as_object() else {
        return;
    };

    let mut updates = serde_json::Map::new();
    let mut swept_any = false;

    for (coin, amount_val) in map {
        let amount = amount_val.as_f64().unwrap_or(0.0);
        if amount <= 0.0 {
            continue;
        }

        let treasury_path = format!("treasury/balances/{}", coin);
        let treasury_bal = db
            .get(&treasury_path)
            .await
            .ok()
            .flatten()
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        updates.insert(format!("platform_fees/{}", coin), serde_json::json!(0.0));
        updates.insert(treasury_path, serde_json::json!(treasury_bal + amount));
        swept_any = true;
    }

    if swept_any {
        if db.multi_path_update(updates).await.is_ok() {
            tracing::info!("Background sweeper moved platform fees into treasury balances");
        }
    }
}
