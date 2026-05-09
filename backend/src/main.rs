mod auth;
mod error;
mod firebase;
mod models;
mod routes;

use axum::Router;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

pub struct AppState {
    pub firebase_project_id: String,
    pub firebase_database_url: String,
    pub firebase_storage_bucket: String,
    pub firebase_db_secret: String,
    pub google_vision_api_key: String,
    pub http_client: reqwest::Client,
    pub swap_fee_bps: u16,
    pub swap_admin_key: String,
    pub internal_cron_key: String,
    pub mnemonic_key: [u8; 32],
    pub master_seed: [u8; 64],
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let mnemonic_key: [u8; 32] = {
        let hex = std::env::var("MNEMONIC_ENCRYPTION_KEY")
            .unwrap_or_else(|_| "0".repeat(64));
        let bytes = hex::decode(&hex)
            .expect("MNEMONIC_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)");
        bytes.try_into()
            .expect("MNEMONIC_ENCRYPTION_KEY must be exactly 32 bytes")
    };
    if mnemonic_key == [0u8; 32] {
        tracing::warn!("MNEMONIC_ENCRYPTION_KEY is all-zeros — use a random key in production!");
    }

    // ── Master HD wallet seed ──────────────────────────────────────────────────
    // Set MASTER_MNEMONIC to a 12/24-word BIP-39 phrase in your .env.
    // Write this phrase on paper and store offline — it re-derives every user’s
    // private key even if the entire database is wiped.
    let master_seed: [u8; 64] = {
        use bip39::Mnemonic;
        let phrase = std::env::var("MASTER_MNEMONIC").unwrap_or_else(|_| {
            tracing::warn!("MASTER_MNEMONIC not set — using insecure placeholder. Set this in production!");
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".into()
        });
        let m = Mnemonic::parse(&phrase).expect("MASTER_MNEMONIC is not a valid BIP-39 phrase");
        m.to_seed("")
    };

    let state = Arc::new(AppState {
        firebase_project_id: std::env::var("FIREBASE_PROJECT_ID")
            .unwrap_or_else(|_| "placeholder-project-id".into()),
        firebase_database_url: std::env::var("FIREBASE_DATABASE_URL")
            .unwrap_or_else(|_| "https://placeholder-rtdb.firebaseio.com".into()),
        firebase_storage_bucket: std::env::var("FIREBASE_STORAGE_BUCKET")
            .unwrap_or_else(|_| "placeholder-project-id.firebasestorage.app".into()),
        firebase_db_secret: std::env::var("FIREBASE_DATABASE_SECRET")
            .unwrap_or_else(|_| "".into()),
        google_vision_api_key: std::env::var("GOOGLE_VISION_API_KEY")
            .unwrap_or_else(|_| "placeholder-vision-api-key".into()),
        http_client: reqwest::Client::new(),
        swap_fee_bps: std::env::var("SWAP_FEE_BPS")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(50)
            .min(2000),
        swap_admin_key: std::env::var("SWAP_ADMIN_KEY").unwrap_or_default(),
        internal_cron_key: std::env::var("INTERNAL_CRON_KEY")
            .unwrap_or_else(|_| std::env::var("SWAP_ADMIN_KEY").unwrap_or_default()),
        mnemonic_key,
        master_seed,
    });

    // ── Background cron: expire stale trades every 3 minutes ──────────────────
    {
        let cron_state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(180));
            loop {
                interval.tick().await;
                routes::expire_stale_trades(cron_state.clone()).await;
            }
        });
    }

    // ── Background sweeper: move platform fees to treasury every 5 minutes ───
    {
        let sweep_state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
            loop {
                interval.tick().await;
                routes::sweep_platform_fees_background(sweep_state.clone()).await;
            }
        });
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .nest("/api", routes::router(state.clone()))
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await
        .unwrap_or_else(|e| { tracing::error!("Failed to bind {addr}: {e}"); std::process::exit(1); });
    tracing::info!("Server listening on http://{addr}");
    axum::serve(listener, app).await.unwrap();
}
