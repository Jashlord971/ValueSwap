
use crate::auth::AuthUser;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{LedgerBalance, UserProfile, WithdrawRequest, WithdrawResponse};
use crate::AppState;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use axum::{
    extract::{Extension, State},
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use secp256k1::{Message, Secp256k1, SecretKey};
use std::sync::Arc;
use tiny_keccak::{Hasher, Keccak};

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/withdraw", post(withdraw_handler))
        .route("/withdrawals", get(list_withdrawals))
}

pub fn encrypt_mnemonic(mnemonic: &str, key: &[u8; 32]) -> Result<String, AppError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, mnemonic.as_bytes())
        .map_err(|_| AppError::Internal("Mnemonic encryption failed".into()))?;

    Ok(format!(
        "{}:{}",
        hex::encode(nonce_bytes),
        hex::encode(ciphertext)
    ))
}

pub fn decrypt_mnemonic(stored: &str, key: &[u8; 32]) -> Result<String, AppError> {
    let (nonce_hex, ct_hex) = stored
        .split_once(':')
        .ok_or_else(|| AppError::Internal("Invalid encrypted mnemonic format".into()))?;

    let nonce_bytes =
        hex::decode(nonce_hex).map_err(|_| AppError::Internal("Nonce hex decode failed".into()))?;
    let ciphertext = hex::decode(ct_hex)
        .map_err(|_| AppError::Internal("Ciphertext hex decode failed".into()))?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| AppError::Internal("Mnemonic decryption failed".into()))?;

    String::from_utf8(plaintext)
        .map_err(|_| AppError::Internal("Mnemonic UTF-8 decode failed".into()))
}

const FEE_BTC: f64 = 0.00005;
const FEE_ETH: f64 = 0.001;
const FEE_USDT: f64 = 1.0;
const FEE_USDC: f64 = 1.0;

async fn withdraw_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(req): Json<WithdrawRequest>,
) -> Result<Json<WithdrawResponse>, AppError> {
    let coin = req.coin.to_lowercase();

    crate::rate_limit::check_rate_limit(
        &state, &format!("wallet-send:{}", user.uid), 8, 300, "attempting sends",
    ).await?;

    let db = RtdbClient::new(&state, &user.id_token);

    let sender_profile = fetch_user_profile(&db, &user.uid).await?;
    super::twofa::require_valid_totp_if_gated(
        &state,
        user.email.as_deref(),
        &user.uid,
        sender_profile.withdraw_code_required,
        &sender_profile,
        req.totp_code.as_deref(),
    ).await?;

    let resp = do_withdraw(&db, &state, &user.uid, &coin, &req.to_address, req.amount).await?;
    Ok(Json(resp))
}

async fn fetch_user_profile(db: &RtdbClient<'_>, uid: &str) -> Result<UserProfile, AppError> {
    let val = db
        .get(&format!("users/{}", uid))
        .await?
        .ok_or_else(|| AppError::NotFound("User profile not found".into()))?;
    serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))
}

pub async fn do_withdraw(
    db: &RtdbClient<'_>,
    _state: &Arc<AppState>,
    uid: &str,
    coin: &str,
    to_address: &str,
    amount: f64,
) -> Result<WithdrawResponse, AppError> {
    validate_address(coin, to_address)?;

    if amount <= 0.0 {
        return Err(AppError::BadRequest("Amount must be positive".into()));
    }

    let fee = platform_fee(coin)?;
    let total = amount + fee;

    let balance: LedgerBalance = db
        .get(&format!("balances/{}", uid))
        .await?
        .map(|v| serde_json::from_value(v).unwrap_or_default())
        .unwrap_or_default();

    let available = ledger_field(&balance, coin);
    if available < total {
        return Err(AppError::BadRequest(format!(
            "Insufficient platform balance: need {:.8} {} (amount + {:.8} fee), have {:.8}",
            total,
            coin.to_uppercase(),
            fee,
            available,
        )));
    }

    let new_balance = available - total;
    let mut updates = serde_json::Map::new();
    updates.insert(
        format!("balances/{}/{}", uid, coin),
        serde_json::json!(new_balance),
    );
    db.multi_path_update(updates).await?;

    let request = crate::models::WithdrawalRequest {
        id: uuid::Uuid::new_v4().to_string(),
        uid: uid.to_string(),
        coin: coin.to_string(),
        to_address: to_address.to_string(),
        amount,
        fee,
        status: crate::models::WithdrawalRequestStatus::Queued,
        created_at: unix_now(),
        processed_at: None,
        tx_hash: None,
        error: None,
        attempts: 0,
    };
    db.set(
        &format!("withdrawal_requests/{}", request.id),
        &serde_json::to_value(&request).unwrap(),
    ).await?;

    tracing::info!(
        "Withdrawal queued uid={} coin={} amount={} fee={} to={} request_id={}",
        uid, coin, amount, fee, to_address, request.id
    );

    Ok(WithdrawResponse {
        request_id: request.id,
        status: "queued".to_string(),
        coin: coin.to_string(),
        amount,
        to_address: to_address.to_string(),
        fee_deducted: fee,
    })
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

async fn list_withdrawals(ctx: crate::auth::Ctx) -> Result<Json<Vec<crate::models::WithdrawalRequest>>, AppError> {
    let admin_db = RtdbClient::new_admin(&ctx.state);
    let docs = admin_db.get_collection("withdrawal_requests").await?;
    let mut mine: Vec<crate::models::WithdrawalRequest> = docs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<crate::models::WithdrawalRequest>(v).ok())
        .filter(|r| r.uid == ctx.user.uid)
        .collect();
    mine.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Json(mine))
}

pub(crate) async fn broadcast_eth(
    state: &AppState,
    seed: &[u8],
    account_index: u32,
    to: &str,
    amount: f64,
    erc20_contract: Option<&str>,
) -> Result<String, AppError> {
    let secret_key = super::wallet::derive_eth_key_indexed(seed, account_index)
        .map_err(|e| AppError::Internal(format!("ETH key derivation: {e:?}")))?;
    let secp = Secp256k1::new();
    let pub_key = secret_key.public_key(&secp);

    let pub_bytes = pub_key.serialize_uncompressed();
    let mut k = Keccak::v256();
    let mut addr_hash = [0u8; 32];
    k.update(&pub_bytes[1..]);
    k.finalize(&mut addr_hash);
    let from_addr = format!("0x{}", hex::encode(&addr_hash[12..]));

    let nonce = eth_get_nonce(&state.http_client, &from_addr).await?;
    let gas_price = eth_get_gas_price(&state.http_client).await?;
    let chain_id = 1u64;

    let (dest, value_wei, data, gas_limit) = if let Some(contract) = erc20_contract {

        let token_units = (amount * 1_000_000.0) as u128;
        (
            contract.to_string(),
            0u128,
            erc20_transfer_data(to, token_units),
            100_000u64,
        )
    } else {

        let wei = (amount * 1e18) as u128;
        (to.to_string(), wei, vec![], 21_000u64)
    };

    let raw_tx = sign_eth_tx(&secret_key, nonce, gas_price, gas_limit, &dest, value_wei, &data, chain_id)?;
    eth_send_raw_tx(&state.http_client, &raw_tx).await
}

fn erc20_transfer_data(to: &str, amount: u128) -> Vec<u8> {

    let mut data = vec![0xa9u8, 0x05, 0x9c, 0xbb];
    let addr = hex::decode(to.trim_start_matches("0x")).unwrap_or_default();
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(&addr);
    data.extend_from_slice(&[0u8; 16]);
    data.extend_from_slice(&amount.to_be_bytes());
    data
}

fn uint_to_min_bytes(n: u128) -> Vec<u8> {
    if n == 0 {
        return vec![];
    }
    let b = n.to_be_bytes();
    let start = b.iter().position(|&x| x != 0).unwrap_or(15);
    b[start..].to_vec()
}

fn strip_leading_zeros(b: &[u8]) -> Vec<u8> {
    let start = b.iter().position(|&x| x != 0).unwrap_or(b.len());
    b[start..].to_vec()
}

fn sign_eth_tx(
    secret_key: &SecretKey,
    nonce: u64,
    gas_price: u128,
    gas_limit: u64,
    to: &str,
    value: u128,
    data: &[u8],
    chain_id: u64,
) -> Result<String, AppError> {
    let to_bytes = hex::decode(to.trim_start_matches("0x"))
        .map_err(|_| AppError::BadRequest("Invalid 'to' address hex".into()))?;

    let gp_bytes   = uint_to_min_bytes(gas_price);
    let val_bytes  = uint_to_min_bytes(value);
    let data_vec   = data.to_vec();
    let mut unsigned = rlp::RlpStream::new_list(9);
    unsigned.append(&nonce);
    unsigned.append(&gp_bytes);
    unsigned.append(&gas_limit);
    unsigned.append(&to_bytes);
    unsigned.append(&val_bytes);
    unsigned.append(&data_vec);
    unsigned.append(&chain_id);
    unsigned.append(&0u64);
    unsigned.append(&0u64);
    let pre_hash = unsigned.out();

    let mut k = Keccak::v256();
    let mut hash = [0u8; 32];
    k.update(&pre_hash[..]);
    k.finalize(&mut hash);

    let secp = Secp256k1::new();
    let msg = Message::from_digest(hash);
    let (rec_id, sig) = secp
        .sign_ecdsa_recoverable(&msg, secret_key)
        .serialize_compact();

    let v: u64 = chain_id * 2 + 35 + rec_id.to_i32() as u64;
    let r = strip_leading_zeros(&sig[..32]);
    let s = strip_leading_zeros(&sig[32..]);

    let mut signed = rlp::RlpStream::new_list(9);
    signed.append(&nonce);
    signed.append(&gp_bytes);
    signed.append(&gas_limit);
    signed.append(&to_bytes);
    signed.append(&val_bytes);
    signed.append(&data_vec);
    signed.append(&v);
    signed.append(&r);
    signed.append(&s);
    let raw = signed.out();

    Ok(format!("0x{}", hex::encode(&raw[..])))
}

async fn eth_get_nonce(client: &reqwest::Client, address: &str) -> Result<u64, AppError> {
    let resp: serde_json::Value = client
        .post("https://cloudflare-eth.com")
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "method": "eth_getTransactionCount",
            "params": [address, "pending"], "id": 1
        }))
        .send()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let hex = resp["result"].as_str().unwrap_or("0x0");
    Ok(u64::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(0))
}

async fn eth_get_gas_price(client: &reqwest::Client) -> Result<u128, AppError> {
    let resp: serde_json::Value = client
        .post("https://cloudflare-eth.com")
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "method": "eth_gasPrice",
            "params": [], "id": 1
        }))
        .send()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    let hex = resp["result"].as_str().unwrap_or("0x0");
    Ok(u128::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap_or(20_000_000_000))
}

async fn eth_send_raw_tx(client: &reqwest::Client, raw_tx: &str) -> Result<String, AppError> {
    let resp: serde_json::Value = client
        .post("https://cloudflare-eth.com")
        .json(&serde_json::json!({
            "jsonrpc": "2.0", "method": "eth_sendRawTransaction",
            "params": [raw_tx], "id": 1
        }))
        .send()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;
    if let Some(err) = resp.get("error") {
        return Err(AppError::Internal(format!("ETH broadcast error: {err}")));
    }
    Ok(resp["result"].as_str().unwrap_or("").to_string())
}

pub(crate) struct BtcUtxo {
    pub(crate) txid: String,
    pub(crate) vout: u32,
    pub(crate) value: u64,
}

pub(crate) async fn broadcast_btc(
    state: &AppState,
    seed: &[u8],
    account_index: u32,
    to: &str,
    amount: f64,
) -> Result<String, AppError> {
    use bitcoin::{
        absolute::LockTime,
        bip32::{DerivationPath, Xpriv},
        consensus::serialize,
        ecdsa::Signature as EcdsaSig,
        secp256k1::Secp256k1 as BtcSecp,
        sighash::{EcdsaSighashType, SighashCache},
        transaction::Version,
        Address, Amount, Network, OutPoint, PublicKey, ScriptBuf, Sequence, Transaction, TxIn,
        TxOut, Txid, Witness,
    };
    use std::str::FromStr;

    let secp = BtcSecp::new();
    let xprv = Xpriv::new_master(Network::Bitcoin, seed)
        .map_err(|e| AppError::Internal(format!("BTC master key: {e}")))?;
    let path = DerivationPath::from_str(&format!("m/84'/0'/{}'/0/0", account_index))
        .map_err(|e| AppError::Internal(format!("BTC path: {e}")))?;
    let child = xprv
        .derive_priv(&secp, &path)
        .map_err(|e| AppError::Internal(format!("BTC derive: {e}")))?;
    let priv_key = child.to_priv();
    let pub_key = PublicKey::from_private_key(&secp, &priv_key);
    let our_addr = Address::p2wpkh(&pub_key, Network::Bitcoin)
        .map_err(|e| AppError::Internal(format!("BTC address: {e}")))?;

    let utxos = fetch_btc_utxos(&state.http_client, &our_addr.to_string()).await?;
    if utxos.is_empty() {
        return Err(AppError::BadRequest(
            "No on-chain BTC UTXOs available for withdrawal".into(),
        ));
    }

    let send_sats: u64 = (amount * 1e8) as u64;
    let fee_sats: u64 = 2000;
    let total_avail: u64 = utxos.iter().map(|u| u.value).sum();

    if total_avail < send_sats + fee_sats {
        return Err(AppError::BadRequest(format!(
            "Insufficient on-chain BTC: have {} sats, need {} + {} miner fee",
            total_avail, send_sats, fee_sats
        )));
    }
    let change_sats = total_avail - send_sats - fee_sats;

    let dest_addr = Address::from_str(to)
        .map_err(|_| AppError::BadRequest("Invalid BTC destination address".into()))?
        .require_network(Network::Bitcoin)
        .map_err(|_| AppError::BadRequest("BTC address is not for mainnet".into()))?;

    let inputs: Vec<TxIn> = utxos
        .iter()
        .map(|u| TxIn {
            previous_output: OutPoint {
                txid: Txid::from_str(&u.txid).unwrap(),
                vout: u.vout,
            },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::MAX,
            witness: Witness::new(),
        })
        .collect();

    let mut outputs = vec![TxOut {
        value: Amount::from_sat(send_sats),
        script_pubkey: dest_addr.script_pubkey(),
    }];
    if change_sats > 546 {

        outputs.push(TxOut {
            value: Amount::from_sat(change_sats),
            script_pubkey: our_addr.script_pubkey(),
        });
    }

    let mut tx = Transaction {
        version: Version::TWO,
        lock_time: LockTime::ZERO,
        input: inputs,
        output: outputs,
    };

    let script_pubkey = our_addr.script_pubkey();
    for i in 0..utxos.len() {
        let utxo_amt = Amount::from_sat(utxos[i].value);

        let sighash_bytes: [u8; 32] = {
            let mut cache = SighashCache::new(&tx);
            let sh = cache
                .p2wpkh_signature_hash(i, &script_pubkey, utxo_amt, EcdsaSighashType::All)
                .map_err(|e| AppError::Internal(format!("BTC sighash: {e}")))?;
            use bitcoin::hashes::Hash;
            *sh.as_byte_array()
        };
        let msg = secp256k1::Message::from_digest(sighash_bytes);
        let sig = secp.sign_ecdsa(&msg, &priv_key.inner);
        let bitcoin_sig = EcdsaSig {
            sig,
            hash_ty: EcdsaSighashType::All,
        };
        tx.input[i].witness = Witness::p2wpkh(&bitcoin_sig, &pub_key.inner);
    }

    let raw_hex = hex::encode(serialize(&tx));
    let resp = state
        .http_client
        .post("https://blockstream.info/api/tx")
        .body(raw_hex)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("BTC broadcast network error: {e}")))?;

    if !resp.status().is_success() {
        let err = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!("BTC broadcast rejected: {err}")));
    }
    Ok(resp.text().await.unwrap_or_default().trim().to_string())
}

pub(crate) async fn fetch_btc_utxos(client: &reqwest::Client, address: &str) -> Result<Vec<BtcUtxo>, AppError> {
    let url = format!("https://blockstream.info/api/address/{}/utxo", address);
    let resp: serde_json::Value = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .json()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(resp
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .map(|u| BtcUtxo {
            txid: u["txid"].as_str().unwrap_or("").to_string(),
            vout: u["vout"].as_u64().unwrap_or(0) as u32,
            value: u["value"].as_u64().unwrap_or(0),
        })
        .collect())
}

fn validate_address(coin: &str, address: &str) -> Result<(), AppError> {
    match coin {
        "eth" | "usdt" | "usdc" => {
            if address.len() != 42
                || !address.starts_with("0x")
                || !address[2..].chars().all(|c| c.is_ascii_hexdigit())
            {
                return Err(AppError::BadRequest(format!(
                    "Invalid {} address (expected 0x + 40 hex chars)",
                    coin.to_uppercase()
                )));
            }
        }
        "btc" => {
            use std::str::FromStr;
            bitcoin::Address::from_str(address)
                .map_err(|_| AppError::BadRequest("Invalid BTC address".into()))?
                .require_network(bitcoin::Network::Bitcoin)
                .map_err(|_| AppError::BadRequest("BTC address is not for mainnet".into()))?;
        }
        _ => return Err(AppError::BadRequest(format!("Unknown coin: {}", coin))),
    }
    Ok(())
}

fn platform_fee(coin: &str) -> Result<f64, AppError> {
    match coin {
        "btc" => Ok(FEE_BTC),
        "eth" => Ok(FEE_ETH),
        "usdt" => Ok(FEE_USDT),
        "usdc" => Ok(FEE_USDC),
        _ => Err(AppError::BadRequest(format!("Unknown coin: {}", coin))),
    }
}

fn ledger_field(balance: &LedgerBalance, coin: &str) -> f64 {
    match coin {
        "btc" => balance.btc,
        "eth" => balance.eth,
        "usdt" => balance.usdt,
        "usdc" => balance.usdc,
        _ => 0.0,
    }
}
