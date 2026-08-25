// One-time maintenance script: find (and optionally delete) malformed entries
// under the `offers` node in the Firebase RTDB.
//
// "Malformed" = the raw JSON does not deserialize into the app's `Offer`
// struct (missing/mistyped required field: id, creator_uid, offer_type,
// card, profit_pct, status, created_at). These are already silently
// dropped by the app everywhere it reads offers (`.filter_map(...).ok()`),
// so they're just dead weight in the DB — but we never delete anything
// without an explicit --delete flag.
//
// Usage (run from backend/):
//   cargo run --bin cleanup_malformed_offers                 # dry run, lists what would be deleted
//   cargo run --bin cleanup_malformed_offers -- --delete      # actually deletes malformed entries

#[path = "../models.rs"]
mod models;

use models::Offer;
use std::collections::HashMap;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let db_url = std::env::var("FIREBASE_DATABASE_URL")
        .expect("FIREBASE_DATABASE_URL must be set (backend/.env)");
    let db_secret = std::env::var("FIREBASE_DATABASE_SECRET")
        .expect("FIREBASE_DATABASE_SECRET must be set (backend/.env)");

    let delete = std::env::args().any(|a| a == "--delete");

    let client = reqwest::Client::new();
    let url = format!("{}/offers.json?auth={}", db_url.trim_end_matches('/'), db_secret);

    println!("Fetching offers from {}/offers.json ...", db_url.trim_end_matches('/'));
    let resp = client.get(&url).send().await.expect("request failed");
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        eprintln!("Fetch failed: {} — {}", status, body);
        std::process::exit(1);
    }

    let raw: Option<HashMap<String, serde_json::Value>> =
        resp.json().await.expect("failed to parse response body as JSON");
    let raw = raw.unwrap_or_default();

    println!("Total offer entries found: {}", raw.len());

    let mut malformed: Vec<(String, String)> = Vec::new();
    let mut ok_count = 0usize;

    for (id, val) in &raw {
        match serde_json::from_value::<Offer>(val.clone()) {
            Ok(_) => ok_count += 1,
            Err(e) => malformed.push((id.clone(), e.to_string())),
        }
    }

    println!("Valid offers: {}", ok_count);
    println!("Malformed offers: {}", malformed.len());
    println!();

    if malformed.is_empty() {
        println!("Nothing to do.");
        return;
    }

    for (id, reason) in &malformed {
        println!("  - offers/{}  ({})", id, reason);
    }

    if !delete {
        println!();
        println!("Dry run only — no data was deleted. Re-run with --delete to remove the {} malformed entries listed above.", malformed.len());
        return;
    }

    println!();
    println!("Deleting {} malformed offers...", malformed.len());
    let mut deleted = 0usize;
    let mut failed = 0usize;
    for (id, _) in &malformed {
        let del_url = format!("{}/offers/{}.json?auth={}", db_url.trim_end_matches('/'), id, db_secret);
        match client.delete(&del_url).send().await {
            Ok(r) if r.status().is_success() => {
                deleted += 1;
                println!("  deleted offers/{}", id);
            }
            Ok(r) => {
                failed += 1;
                eprintln!("  FAILED offers/{} — HTTP {}", id, r.status());
            }
            Err(e) => {
                failed += 1;
                eprintln!("  FAILED offers/{} — {}", id, e);
            }
        }
    }

    println!();
    println!("Done. Deleted: {}, Failed: {}", deleted, failed);
}
