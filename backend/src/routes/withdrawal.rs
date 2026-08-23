//! Mnemonic encryption and on-chain (external) withdrawal.
//!
//! ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//! KMS SWAP BOUNDARY
//! Only `encrypt_mnemonic` and `decrypt_mnemonic` touch the plaintext
//! mnemonic.  To migrate from a static AES key to Cloud KMS, replace
//! only those two functions with your KMS SDK calls. Everything else
//! in this file stays unchanged.
//! ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//!
//! Storage layout (Firebase RTDB):
//!   wallet_secrets/{uid}  →  { "enc": "<12-byte-nonce-hex>:<ciphertext+tag-hex>" }
//!
//! Suggested RTDB security rules for wallet_secrets:
//!   "$uid": {
//!     ".read":  "$uid === auth.uid",            // user sees their own blob (useless without server key)
//!     ".write": "$uid === auth.uid && !data.exists()"  // create-once; server writes on init
//!   }
//!
//! Platform flat fees (deducted from ledger before broadcast):
//!   BTC  0.00005  |  ETH  0.001  |  USDT  1.0  |  USDC  1.0  |  TRX  1.0

use crate::auth::AuthUser;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{LedgerBalance, WithdrawRequest, WithdrawResponse};
use crate::AppState;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use axum::{
    extract::{Extension, State},
    routing::post,
    Json, Router,
};
use bip39::Mnemonic;
use rand::RngCore;
use secp256k1::{Message, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tiny_keccak::{Hasher, Keccak};

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/withdraw", post(withdraw_handler))
}

// ── Mnemonic storage helpers ──────────────────────────────────────────────────

/// Encrypt the mnemonic and write it to `wallet_secrets/{uid}` in RTDB.
/// Called exactly once per user inside `init_wallet`, before returning.
#[allow(dead_code)]
pub async fn store_mnemonic(
    db: &RtdbClient<'_>,
    uid: &str,
    mnemonic: &str,
    key: &[u8; 32],
) -> Result<(), AppError> {
    let enc = encrypt_mnemonic(mnemonic, key)?;
    db.set(
        &format!("wallet_secrets/{}", uid),
        &serde_json::json!({ "enc": enc }),
    )
    .await
}

/// Read and decrypt the mnemonic for `uid`.
/// Private key material lives in RAM only for the duration of the calling request.
pub async fn load_mnemonic(
    db: &RtdbClient<'_>,
    uid: &str,
    key: &[u8; 32],
) -> Result<String, AppError> {
    let val = db
        .get(&format!("wallet_secrets/{}", uid))
        .await?
        .ok_or_else(|| {
            AppError::NotFound(
                "No stored mnemonic — wallet may need re-initialisation".into(),
            )
        })?;
    let enc = val["enc"]
        .as_str()
        .ok_or_else(|| AppError::Internal("Malformed wallet_secrets node".into()))?;

    decrypt_mnemonic(enc, key)
}

// ── Encryption primitives — KMS swap boundary ─────────────────────────────────
//
// Algorithm : AES-256-GCM
// Key       : 32 bytes (from MNEMONIC_ENCRYPTION_KEY env var, 64-char hex)
// Nonce     : 12 bytes, freshly generated per encryption with a CSPRNG
// Auth tag  : 16 bytes, appended to ciphertext by the AEAD (tamper-evident)
//
// Stored format in RTDB:  "<24-char nonce hex>:<ciphertext+tag hex>"
//
// ┌─ To swap to AWS KMS ───────────────────────────────────────────────────┐
// │ 1. encrypt_mnemonic → kms_client.encrypt(key_id, plaintext_bytes)     │
// │    return base64(ciphertext_blob) instead of the nonce:ct format       │
// │ 2. decrypt_mnemonic → kms_client.decrypt(ciphertext_blob)             │
// │    parse base64, call KMS, return plaintext string                     │
// │ 3. Everything else in this file is unchanged.                          │
// └────────────────────────────────────────────────────────────────────────┘

#[allow(dead_code)]
fn encrypt_mnemonic(mnemonic: &str, key: &[u8; 32]) -> Result<String, AppError> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, mnemonic.as_bytes())
        .map_err(|_| AppError::Internal("Mnemonic encryption failed".into()))?;

    // "nonce_hex:ciphertext_hex"  — nonce is needed for decryption; safe to store alongside ct
    Ok(format!(
        "{}:{}",
        hex::encode(nonce_bytes),
        hex::encode(ciphertext)
    ))
}

fn decrypt_mnemonic(stored: &str, key: &[u8; 32]) -> Result<String, AppError> {
    let (nonce_hex, ct_hex) = stored
        .split_once(':')
        .ok_or_else(|| AppError::Internal("Invalid encrypted mnemonic format".into()))?;

    let nonce_bytes =
        hex::decode(nonce_hex).map_err(|_| AppError::Internal("Nonce hex decode failed".into()))?;
    let ciphertext = hex::decode(ct_hex)
        .map_err(|_| AppError::Internal("Ciphertext hex decode failed".into()))?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(&nonce_bytes);

    // Generic error message — never leak "wrong key" vs "corrupted" to avoid oracle attacks
    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| AppError::Internal("Mnemonic decryption failed".into()))?;

    String::from_utf8(plaintext)
        .map_err(|_| AppError::Internal("Mnemonic UTF-8 decode failed".into()))
}

// ── Platform fees ─────────────────────────────────────────────────────────────

const FEE_BTC: f64 = 0.00005; // ~3 sat/vbyte typical P2WPKH tx
const FEE_ETH: f64 = 0.001; // covers 21 000 gas at ≈48 gwei
const FEE_USDT: f64 = 1.0; // 1 USDT flat (gas paid by platform)
const FEE_USDC: f64 = 1.0; // 1 USDC flat
const FEE_TRX: f64 = 1.0; // 1 TRX flat

// ── Withdraw handler ──────────────────────────────────────────────────────────

async fn withdraw_handler(
    State(state): State<Arc<AppState>>,
    Extension(user): Extension<AuthUser>,
    Json(req): Json<WithdrawRequest>,
) -> Result<Json<WithdrawResponse>, AppError> {
    let coin = req.coin.to_lowercase();
    let db = RtdbClient::new(&state, &user.id_token);
    let resp = do_withdraw(&db, &state, &user.uid, &coin, &req.to_address, req.amount).await?;
    Ok(Json(resp))
}

/// Core on-chain withdrawal logic — also called by the smart-send handler in wallet.rs.
/// Validates the address, checks the ledger, decrypts the mnemonic, broadcasts the
/// transaction, and debits the ledger.  The mnemonic lives in RAM only for the duration
/// of this call and is never logged or serialised.
pub async fn do_withdraw(
    db: &RtdbClient<'_>,
    state: &Arc<AppState>,
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

    // ── Check platform ledger balance ─────────────────────────────────────────
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

    // ── Derive seed from master HD wallet ────────────────────────────────────
    // Look up this user's account index (stored when their wallet was created).
    // If not found (legacy pre-migration user), fall back to decrypting their
    // per-user mnemonic from wallet_secrets.
    let seed_storage;
    let (seed, account_index): (&[u8], u32) =
        if let Some(idx_val) = db.get(&format!("wallet_indices/{}", uid)).await? {
            let index = idx_val.as_u64().unwrap_or(0) as u32;
            (&state.master_seed, index)
        } else {
            // Legacy path: decrypt per-user mnemonic (index 0 = old fixed path)
            let mnemonic_str = load_mnemonic(db, uid, &state.mnemonic_key).await?;
            let mnemonic = Mnemonic::parse(&mnemonic_str)
                .map_err(|e| AppError::Internal(format!("Mnemonic parse failed: {e}")))?;
            seed_storage = mnemonic.to_seed("");
            (&seed_storage, 0u32)
        };

    // ── Broadcast on-chain transaction ────────────────────────────────────────
    let tx_hash = match coin {
        "eth" => broadcast_eth(state, seed, account_index, to_address, amount, None).await?,
        "usdt" => {
            broadcast_eth(
                state, seed, account_index,
                to_address, amount,
                Some("0xdAC17F958D2ee523a2206206994597C13D831ec7"),
            ).await?
        }
        "usdc" => {
            broadcast_eth(
                state, seed, account_index,
                to_address, amount,
                Some("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
            ).await?
        }
        "btc" => broadcast_btc(state, seed, account_index, to_address, amount).await?,
        "trx" => broadcast_trx(state, seed, account_index, to_address, amount).await?,
        _ => unreachable!(),
    };

    // ── Debit ledger only after confirmed broadcast ───────────────────────────
    let new_balance = available - total;
    let mut updates = serde_json::Map::new();
    updates.insert(
        format!("balances/{}/{}", uid, coin),
        serde_json::json!(new_balance),
    );
    db.multi_path_update(updates).await?;

    tracing::info!(
        "Withdrawal uid={} coin={} amount={} fee={} to={} tx={}",
        uid, coin, amount, fee, to_address, tx_hash
    );

    Ok(WithdrawResponse {
        tx_hash,
        coin: coin.to_string(),
        amount,
        to_address: to_address.to_string(),
        fee_deducted: fee,
    })
}

// ── ETH / ERC-20 broadcast ────────────────────────────────────────────────────

async fn broadcast_eth(
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

    // Derive our sending address for the nonce lookup
    let pub_bytes = pub_key.serialize_uncompressed();
    let mut k = Keccak::v256();
    let mut addr_hash = [0u8; 32];
    k.update(&pub_bytes[1..]);
    k.finalize(&mut addr_hash);
    let from_addr = format!("0x{}", hex::encode(&addr_hash[12..]));

    let nonce = eth_get_nonce(&state.http_client, &from_addr).await?;
    let gas_price = eth_get_gas_price(&state.http_client).await?;
    let chain_id = 1u64; // Ethereum mainnet

    let (dest, value_wei, data, gas_limit) = if let Some(contract) = erc20_contract {
        // ERC-20 transfer: send 0 ETH to the contract, encode transfer() in data
        let token_units = (amount * 1_000_000.0) as u128; // USDT and USDC: 6 decimals
        (
            contract.to_string(),
            0u128,
            erc20_transfer_data(to, token_units),
            100_000u64,
        )
    } else {
        // Native ETH transfer
        let wei = (amount * 1e18) as u128;
        (to.to_string(), wei, vec![], 21_000u64)
    };

    let raw_tx = sign_eth_tx(&secret_key, nonce, gas_price, gas_limit, &dest, value_wei, &data, chain_id)?;
    eth_send_raw_tx(&state.http_client, &raw_tx).await
}

fn erc20_transfer_data(to: &str, amount: u128) -> Vec<u8> {
    // Function selector: keccak256("transfer(address,uint256)")[0..4] = 0xa9059cbb
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

/// Strips leading zero bytes from signature components r and s for RLP encoding.
fn strip_leading_zeros(b: &[u8]) -> Vec<u8> {
    let start = b.iter().position(|&x| x != 0).unwrap_or(b.len());
    b[start..].to_vec()
}

/// Signs and RLP-encodes an EIP-155 transaction, returning the `0x`-prefixed hex string
/// ready to be passed to `eth_sendRawTransaction`.
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

    // EIP-155 unsigned tx: [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
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
    unsigned.append(&0u64); // r = 0
    unsigned.append(&0u64); // s = 0
    let pre_hash = unsigned.out();

    // Keccak256(rlp) → sign
    let mut k = Keccak::v256();
    let mut hash = [0u8; 32];
    k.update(&pre_hash[..]);
    k.finalize(&mut hash);

    let secp = Secp256k1::new();
    let msg = Message::from_digest(hash);
    let (rec_id, sig) = secp
        .sign_ecdsa_recoverable(&msg, secret_key)
        .serialize_compact();

    // EIP-155 replay-protected v
    let v: u64 = chain_id * 2 + 35 + rec_id.to_i32() as u64;
    let r = strip_leading_zeros(&sig[..32]);
    let s = strip_leading_zeros(&sig[32..]);

    // Signed tx: [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
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

struct BtcUtxo {
    txid: String,
    vout: u32,
    value: u64, // satoshis
}

async fn broadcast_btc(
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
    let fee_sats: u64 = 2000; // conservative: ~14 sat/vbyte for a 1-in 2-out P2WPKH tx
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
            script_sig: ScriptBuf::new(), // empty for SegWit
            sequence: Sequence::MAX,
            witness: Witness::new(),
        })
        .collect();

    let mut outputs = vec![TxOut {
        value: Amount::from_sat(send_sats),
        script_pubkey: dest_addr.script_pubkey(),
    }];
    if change_sats > 546 {
        // dust threshold — don't create unspendable outputs
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

async fn fetch_btc_utxos(client: &reqwest::Client, address: &str) -> Result<Vec<BtcUtxo>, AppError> {
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

async fn broadcast_trx(state: &AppState, seed: &[u8], account_index: u32, to: &str, amount: f64) -> Result<String, AppError> {
    let secp = Secp256k1::new();
    let path = format!("m/44'/195'/{}'/0/0", account_index);
    let ext = tiny_hderive::bip32::ExtendedPrivKey::derive(seed, path.as_str())
        .map_err(|e| AppError::Internal(format!("TRX key derivation: {e:?}")))?;
    let secret_key = SecretKey::from_slice(&ext.secret())
        .map_err(|e| AppError::Internal(format!("TRX secret key: {e}")))?;
    let pub_key = secret_key.public_key(&secp);

    let pub_bytes = pub_key.serialize_uncompressed();
    let mut k = Keccak::v256();
    let mut addr_hash = [0u8; 32];
    k.update(&pub_bytes[1..]);
    k.finalize(&mut addr_hash);
    let raw_addr = &addr_hash[12..];
    let mut payload = vec![0x41u8];
    payload.extend_from_slice(raw_addr);
    let c1 = Sha256::digest(&payload);
    let c2 = Sha256::digest(&c1);
    payload.extend_from_slice(&c2[..4]);
    let from_addr = bs58::encode(&payload).into_string();

    let sun = (amount * 1_000_000.0) as u64;

    let create_resp: serde_json::Value = state
        .http_client
        .post("https://api.trongrid.io/wallet/createtransaction")
        .json(&serde_json::json!({
            "owner_address": from_addr,
            "to_address":    to,
            "amount":        sun,
        }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("TRX create tx network error: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("TRX create tx parse error: {e}")))?;

    if let Some(err) = create_resp.get("Error") {
        return Err(AppError::Internal(format!("TRX build tx error: {err}")));
    }

    // Sign: SHA256(raw_data_bytes) → secp256k1 recoverable signature
    let raw_data_hex = create_resp["raw_data_hex"]
        .as_str()
        .ok_or_else(|| AppError::Internal("TRX: missing raw_data_hex in response".into()))?;
    let raw_data =
        hex::decode(raw_data_hex).map_err(|e| AppError::Internal(format!("TRX raw_data decode: {e}")))?;

    let hash: [u8; 32] = Sha256::digest(&raw_data).into();
    let msg = Message::from_digest(hash);
    let (rec_id, sig) = secp
        .sign_ecdsa_recoverable(&msg, &secret_key)
        .serialize_compact();
    let mut sig_with_v = sig.to_vec();
    sig_with_v.push(rec_id.to_i32() as u8);

    // Broadcast signed transaction
    let mut broadcast_body = create_resp.clone();
    broadcast_body["signature"] = serde_json::json!([hex::encode(&sig_with_v)]);

    let broadcast_resp: serde_json::Value = state
        .http_client
        .post("https://api.trongrid.io/wallet/broadcasttransaction")
        .json(&broadcast_body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("TRX broadcast network error: {e}")))?
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("TRX broadcast parse error: {e}")))?;

    if broadcast_resp["result"].as_bool() != Some(true) {
        return Err(AppError::Internal(format!(
            "TRX broadcast failed: {}",
            broadcast_resp["message"]
                .as_str()
                .unwrap_or("unknown error")
        )));
    }

    Ok(create_resp["txID"]
        .as_str()
        .or_else(|| create_resp["txid"].as_str())
        .unwrap_or("unknown")
        .to_string())
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
            // Accept native SegWit (bc1), Legacy P2PKH (1), P2SH (3)
            if !address.starts_with("bc1")
                && !address.starts_with('1')
                && !address.starts_with('3')
            {
                return Err(AppError::BadRequest(
                    "Invalid BTC address (must start with bc1, 1, or 3)".into(),
                ));
            }
        }
        "trx" => {
            if !address.starts_with('T') || address.len() != 34 {
                return Err(AppError::BadRequest(
                    "Invalid TRX address (must start with T and be 34 chars)".into(),
                ));
            }
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
        "trx" => Ok(FEE_TRX),
        _ => Err(AppError::BadRequest(format!("Unknown coin: {}", coin))),
    }
}

fn ledger_field(balance: &LedgerBalance, coin: &str) -> f64 {
    match coin {
        "btc" => balance.btc,
        "eth" => balance.eth,
        "usdt" => balance.usdt,
        "usdc" => balance.usdc,
        "trx" => balance.trx,
        _ => 0.0,
    }
}
