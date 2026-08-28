// Sweeps deposits from individual user addresses into platform-controlled
// treasury addresses, and pays queued external withdrawals out of that
// treasury instead of signing live off whatever a user's own deposit
// address happens to hold.
//
// Why: the old model signed a withdrawal directly from the requesting
// user's own on-chain deposit address. That only works if the user's
// ledger balance matches what's physically sitting at that one address —
// which stops being true the moment they receive money via an internal
// transfer or a trade payout (both pure ledger moves, no on-chain
// transaction happens). This makes the treasury the single source of
// on-chain funds for every withdrawal instead, which is how real
// custodial exchanges do it. The tradeoff, by design: withdrawals are no
// longer signed synchronously on request — they're queued, and a
// background worker pays them out once the treasury actually has the
// funds (from a prior sweep).

use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{LedgerBalance, WithdrawalRequest, WithdrawalRequestStatus};
use crate::AppState;
use std::sync::Arc;

use super::wallet::{
    derive_btc_address_indexed, derive_eth_address_indexed, fetch_btc_balance,
    fetch_erc20_balance_from_rpc, fetch_eth_balance_from_rpc, record_transaction, TREASURY_INDEX,
};
use super::withdrawal::{broadcast_btc, broadcast_eth, fetch_btc_utxos};

const BTC_MIN_SWEEP_SATS: u64 = 10_000;
const BTC_SWEEP_FEE_SATS: u64 = 2_000;
const ETH_GAS_RESERVE: f64 = 0.0006;
const ETH_MIN_SWEEP: f64 = 0.002;
const ETH_TOPUP_AMOUNT: f64 = 0.0008;
const TOKEN_MIN_SWEEP: f64 = 1.0;
const MAX_WITHDRAWAL_ATTEMPTS: u32 = 5;

const USDT_CONTRACT: &str = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const USDC_CONTRACT: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_RPC: &str = "https://cloudflare-eth.com";

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn treasury_btc_address(state: &AppState) -> Result<String, AppError> {
    derive_btc_address_indexed(&state.master_seed, TREASURY_INDEX).map_err(|e| AppError::Internal(e.to_string()))
}

fn treasury_eth_address(state: &AppState) -> Result<String, AppError> {
    derive_eth_address_indexed(&state.master_seed, TREASURY_INDEX).map_err(|e| AppError::Internal(e.to_string()))
}

/// Background job: walk every user with a wallet and sweep whatever's
/// sitting at their deposit addresses into the treasury. Safe to run
/// repeatedly — a BTC address with nothing above the sweep threshold, or
/// an ETH/ERC20 balance below its threshold, is just skipped.
pub async fn sweep_all_deposits(state: Arc<AppState>) {
    let admin_db = RtdbClient::new_admin(&state);
    let Ok(Some(serde_json::Value::Object(wallets))) = admin_db.get("wallet_indices").await else {
        return;
    };

    let treasury_btc = match treasury_btc_address(&state) {
        Ok(a) => a,
        Err(e) => { tracing::warn!("sweep: treasury BTC address derive failed: {e}"); return; }
    };
    let treasury_eth = match treasury_eth_address(&state) {
        Ok(a) => a,
        Err(e) => { tracing::warn!("sweep: treasury ETH address derive failed: {e}"); return; }
    };

    for (uid, idx_val) in wallets {
        let Some(index) = idx_val.as_u64().map(|v| v as u32) else { continue };

        if let Err(e) = sweep_user_btc(&state, &uid, index, &treasury_btc).await {
            tracing::warn!("sweep: BTC sweep failed for {uid}: {e}");
        }
        if let Err(e) = sweep_user_eth_family(&state, &uid, index, &treasury_eth).await {
            tracing::warn!("sweep: ETH-family sweep failed for {uid}: {e}");
        }
    }
}

async fn sweep_user_btc(state: &AppState, uid: &str, index: u32, treasury_addr: &str) -> Result<(), AppError> {
    let addr = derive_btc_address_indexed(&state.master_seed, index).map_err(|e| AppError::Internal(e.to_string()))?;
    let utxos = fetch_btc_utxos(&state.http_client, &addr).await?;
    let total: u64 = utxos.iter().map(|u| u.value).sum();
    if total <= BTC_MIN_SWEEP_SATS {
        return Ok(());
    }

    let sweep_amount_btc = (total - BTC_SWEEP_FEE_SATS) as f64 / 1e8;
    let tx_hash = broadcast_btc(state, &state.master_seed, index, treasury_addr, sweep_amount_btc).await?;
    tracing::info!("sweep: BTC uid={uid} amount={sweep_amount_btc} tx={tx_hash}");
    Ok(())
}

async fn sweep_user_eth_family(state: &AppState, uid: &str, index: u32, treasury_addr: &str) -> Result<(), AppError> {
    let addr = derive_eth_address_indexed(&state.master_seed, index).map_err(|e| AppError::Internal(e.to_string()))?;

    let eth_bal = fetch_eth_balance_from_rpc(&state.http_client, ETH_RPC, &addr).await.unwrap_or(0.0);
    let usdt_bal = fetch_erc20_balance_from_rpc(&state.http_client, ETH_RPC, &addr, USDT_CONTRACT, 6).await.unwrap_or(0.0);
    let usdc_bal = fetch_erc20_balance_from_rpc(&state.http_client, ETH_RPC, &addr, USDC_CONTRACT, 6).await.unwrap_or(0.0);

    let needs_token_sweep = usdt_bal >= TOKEN_MIN_SWEEP || usdc_bal >= TOKEN_MIN_SWEEP;

    if needs_token_sweep && eth_bal < ETH_GAS_RESERVE {
        // Not enough gas at this address to move a token out. Top it up
        // from the treasury now; the actual token sweep happens next cycle
        // once that lands (ERC20 transfers need the user's own address to
        // pay gas — the platform can't sponsor it in the same tx).
        let tx = broadcast_eth(state, &state.master_seed, TREASURY_INDEX, &addr, ETH_TOPUP_AMOUNT, None).await?;
        tracing::info!("sweep: gas top-up uid={uid} tx={tx}");
        return Ok(());
    }

    if usdt_bal >= TOKEN_MIN_SWEEP {
        let tx = broadcast_eth(state, &state.master_seed, index, treasury_addr, usdt_bal, Some(USDT_CONTRACT)).await?;
        tracing::info!("sweep: USDT uid={uid} amount={usdt_bal} tx={tx}");
    }
    if usdc_bal >= TOKEN_MIN_SWEEP {
        let tx = broadcast_eth(state, &state.master_seed, index, treasury_addr, usdc_bal, Some(USDC_CONTRACT)).await?;
        tracing::info!("sweep: USDC uid={uid} amount={usdc_bal} tx={tx}");
    }

    // eth_bal above was read before any token sweeps just now spent gas —
    // only sweep the native-ETH surplus on a cycle where we didn't also
    // spend some of it, so we're never sweeping a stale balance.
    if !needs_token_sweep && eth_bal > ETH_GAS_RESERVE + ETH_MIN_SWEEP {
        let sweep_amount = eth_bal - ETH_GAS_RESERVE;
        let tx = broadcast_eth(state, &state.master_seed, index, treasury_addr, sweep_amount, None).await?;
        tracing::info!("sweep: ETH uid={uid} amount={sweep_amount} tx={tx}");
    }

    Ok(())
}

/// Background job: pay out queued withdrawals from the treasury, oldest
/// first, whenever it has enough of the relevant coin. Requests that
/// genuinely fail to broadcast (not just "treasury doesn't have enough
/// yet") get a few retries, then are marked Failed and their reserved
/// ledger balance is refunded rather than left stuck forever.
pub async fn process_withdrawal_queue(state: Arc<AppState>) {
    let admin_db = RtdbClient::new_admin(&state);
    let Ok(docs) = admin_db.get_collection("withdrawal_requests").await else { return };

    let mut requests: Vec<WithdrawalRequest> = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<WithdrawalRequest>(v).ok())
        .filter(|r| r.status == WithdrawalRequestStatus::Queued)
        .collect();
    requests.sort_by_key(|r| r.created_at);

    for req in requests {
        if let Err(e) = process_one_withdrawal(&state, &admin_db, &req).await {
            tracing::warn!("withdrawal queue: request {} failed: {}", req.id, e);
        }
    }
}

async fn treasury_balance_for_coin(state: &AppState, coin: &str) -> f64 {
    match coin {
        "btc" => {
            let Ok(addr) = treasury_btc_address(state) else { return 0.0 };
            fetch_btc_balance(&state.http_client, &addr).await.unwrap_or(0.0)
        }
        "eth" => {
            let Ok(addr) = treasury_eth_address(state) else { return 0.0 };
            fetch_eth_balance_from_rpc(&state.http_client, ETH_RPC, &addr).await.unwrap_or(0.0)
        }
        "usdt" => {
            let Ok(addr) = treasury_eth_address(state) else { return 0.0 };
            fetch_erc20_balance_from_rpc(&state.http_client, ETH_RPC, &addr, USDT_CONTRACT, 6).await.unwrap_or(0.0)
        }
        "usdc" => {
            let Ok(addr) = treasury_eth_address(state) else { return 0.0 };
            fetch_erc20_balance_from_rpc(&state.http_client, ETH_RPC, &addr, USDC_CONTRACT, 6).await.unwrap_or(0.0)
        }
        _ => 0.0,
    }
}

async fn process_one_withdrawal(state: &AppState, admin_db: &RtdbClient<'_>, req: &WithdrawalRequest) -> Result<(), AppError> {
    let available = treasury_balance_for_coin(state, &req.coin).await;
    if available < req.amount {
        let mut updated = req.clone();
        updated.attempts += 1;
        admin_db.set(&format!("withdrawal_requests/{}", req.id), &serde_json::to_value(&updated).unwrap()).await?;
        return Ok(());
    }

    let result = match req.coin.as_str() {
        "btc" => broadcast_btc(state, &state.master_seed, TREASURY_INDEX, &req.to_address, req.amount).await,
        "eth" => broadcast_eth(state, &state.master_seed, TREASURY_INDEX, &req.to_address, req.amount, None).await,
        "usdt" => broadcast_eth(state, &state.master_seed, TREASURY_INDEX, &req.to_address, req.amount, Some(USDT_CONTRACT)).await,
        "usdc" => broadcast_eth(state, &state.master_seed, TREASURY_INDEX, &req.to_address, req.amount, Some(USDC_CONTRACT)).await,
        other => Err(AppError::Internal(format!("Unsupported coin for withdrawal: {other}"))),
    };

    let mut updated = req.clone();
    match result {
        Ok(tx_hash) => {
            updated.status = WithdrawalRequestStatus::Completed;
            updated.tx_hash = Some(tx_hash.clone());
            updated.processed_at = Some(unix_now());
            admin_db.set(&format!("withdrawal_requests/{}", req.id), &serde_json::to_value(&updated).unwrap()).await?;

            tracing::info!(
                "withdrawal queue: paid uid={} coin={} amount={} to={} tx={}",
                req.uid, req.coin, req.amount, req.to_address, tx_hash
            );

            if let Err(e) = record_transaction(
                admin_db, &req.uid, "withdrawal", "out", &req.coin, req.amount, None, Some(&req.to_address), Some(&tx_hash),
            ).await {
                tracing::warn!("Failed to record withdrawal transaction for {}: {}", req.uid, e);
            }
        }
        Err(e) => {
            updated.attempts += 1;
            if updated.attempts >= MAX_WITHDRAWAL_ATTEMPTS {
                updated.status = WithdrawalRequestStatus::Failed;
                updated.error = Some(e.to_string());
                if let Err(refund_err) = refund_ledger(admin_db, &req.uid, &req.coin, req.amount + req.fee).await {
                    tracing::error!(
                        "withdrawal queue: request {} failed AND refund failed for {}: {}",
                        req.id, req.uid, refund_err
                    );
                }
            }
            admin_db.set(&format!("withdrawal_requests/{}", req.id), &serde_json::to_value(&updated).unwrap()).await?;
        }
    }

    Ok(())
}

async fn refund_ledger(db: &RtdbClient<'_>, uid: &str, coin: &str, amount: f64) -> Result<(), AppError> {
    let balance: LedgerBalance = db
        .get(&format!("balances/{}", uid))
        .await?
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default();
    let current = match coin {
        "btc" => balance.btc,
        "eth" => balance.eth,
        "usdt" => balance.usdt,
        "usdc" => balance.usdc,
        _ => 0.0,
    };
    db.set(&format!("balances/{}/{}", uid, coin), &serde_json::json!(current + amount)).await
}
