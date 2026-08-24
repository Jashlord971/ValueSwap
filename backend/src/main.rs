mod auth;
mod error;
mod firebase;
mod models;
mod moderation;
mod presence;
mod routes;

use axum::Router;
use std::fs;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

pub struct AdminAccessTokenCache {
    pub access_token: String,
    pub expires_at: u64,
}

pub struct AppState {
    pub firebase_project_id: String,
    pub firebase_database_url: String,
    pub firebase_storage_bucket: String,
    pub firebase_db_secret: String,
    pub firebase_admin_client_email: String,
    pub firebase_admin_private_key: String,
    pub firebase_admin_token_uri: String,
    pub firebase_admin_access_token: Mutex<Option<AdminAccessTokenCache>>,
    pub google_vision_api_key: String,
    pub http_client: reqwest::Client,
    pub swap_admin_key: String,
    pub internal_cron_key: String,
    pub mnemonic_key: [u8; 32],
    pub master_seed: [u8; 64],
}

fn load_service_account_fields() -> (String, String, String) {
    let token_uri_default = "https://oauth2.googleapis.com/token".to_string();

    if let Ok(path) = std::env::var("GOOGLE_APPLICATION_CREDENTIALS") {
        if !path.trim().is_empty() {
            if let Ok(raw) = fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    let client_email = v
                        .get("client_email")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let private_key = v
                        .get("private_key")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let token_uri = v
                        .get("token_uri")
                        .and_then(|x| x.as_str())
                        .unwrap_or(&token_uri_default)
                        .to_string();
                    return (client_email, private_key, token_uri);
                }
            }
        }
    }

    (
        std::env::var("FIREBASE_ADMIN_CLIENT_EMAIL").unwrap_or_default(),
        std::env::var("FIREBASE_ADMIN_PRIVATE_KEY").unwrap_or_default(),
        std::env::var("FIREBASE_ADMIN_TOKEN_URI").unwrap_or(token_uri_default),
    )
}

fn infer_project_id_from_database_url(database_url: &str) -> Option<String> {
    let trimmed = database_url.trim();
    if trimmed.is_empty() {
        return None;
    }

    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    let host = without_scheme.split('/').next().unwrap_or("");
    if host.is_empty() {
        return None;
    }

    let first_label = host.split('.').next().unwrap_or("");
    if first_label.is_empty() {
        return None;
    }

    let project = first_label
        .strip_suffix("-default-rtdb")
        .unwrap_or(first_label)
        .trim();

    if project.is_empty() {
        None
    } else {
        Some(project.to_string())
    }
}

#[tokio::main]
async fn main() {
    if dotenvy::dotenv().is_err() {
        let backend_env = std::path::Path::new("backend").join(".env");
        let _ = dotenvy::from_path(&backend_env);
    }

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

    let master_seed: [u8; 64] = {
        use bip39::Mnemonic;
        let phrase = std::env::var("MASTER_MNEMONIC").unwrap_or_else(|_| {
            tracing::warn!("MASTER_MNEMONIC not set — using insecure placeholder. Set this in production!");
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".into()
        });
        let m = Mnemonic::parse(&phrase).expect("MASTER_MNEMONIC is not a valid BIP-39 phrase");
        m.to_seed("")
    };

    let (firebase_admin_client_email, firebase_admin_private_key, firebase_admin_token_uri) =
        load_service_account_fields();

    let firebase_database_url = std::env::var("FIREBASE_DATABASE_URL")
        .unwrap_or_else(|_| "https://placeholder-rtdb.firebaseio.com".into());
    let firebase_project_id = std::env::var("FIREBASE_PROJECT_ID")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| infer_project_id_from_database_url(&firebase_database_url))
        .unwrap_or_else(|| "placeholder-project-id".into());

    let state = Arc::new(AppState {
        firebase_project_id,
        firebase_database_url,
        firebase_storage_bucket: std::env::var("FIREBASE_STORAGE_BUCKET")
            .unwrap_or_else(|_| "placeholder-project-id.firebasestorage.app".into()),
        firebase_db_secret: std::env::var("FIREBASE_DATABASE_SECRET")
            .unwrap_or_else(|_| "".into()),
        firebase_admin_client_email,
        firebase_admin_private_key,
        firebase_admin_token_uri,
        firebase_admin_access_token: Mutex::new(None),
        google_vision_api_key: std::env::var("GOOGLE_VISION_API_KEY")
            .unwrap_or_else(|_| "placeholder-vision-api-key".into()),
        http_client: reqwest::Client::new(),
        swap_admin_key: std::env::var("SWAP_ADMIN_KEY").unwrap_or_default(),
        internal_cron_key: std::env::var("INTERNAL_CRON_KEY")
            .unwrap_or_else(|_| std::env::var("SWAP_ADMIN_KEY").unwrap_or_default()),
        mnemonic_key,
        master_seed,
    });

    let run_internal_cron = std::env::var("RUN_INTERNAL_CRON")
        .map(|v| {
            let normalized = v.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false);

    tracing::info!(run_internal_cron, "Internal cron runner enabled status");

    {
        let rebalance_state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
            loop {
                interval.tick().await;
                routes::rebalance_all_active_offers(rebalance_state.clone()).await;
            }
        });
    }

    tracing::info!("Offer rebalance cron enabled (every 5 minutes)");

    if run_internal_cron {

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
    } else {
        tracing::info!("Internal cron runner disabled; use external scheduler to call /api/internal/cron/* endpoints");
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
