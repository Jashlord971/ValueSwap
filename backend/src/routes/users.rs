use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{
    Offer, OfferStatus, ResolveRecipientRequest, ResolveRecipientResponse, Trade, TradeStatus,
    UpdateProfileRequest, UsernameEntry, UserProfile, Warning,
};
use crate::moderation::is_moderator_email;
use crate::presence::HEARTBEAT_MIN_INTERVAL_SECS;
use crate::AppState;
use axum::{extract::Path, routing::post, Json, Router};
use rand::Rng;
use sha2::{Digest, Sha256};
use std::sync::Arc;

static ADJECTIVES: &[&str] = &[
    "Bouncy", "Sneaky", "Grumpy", "Fluffy", "Wiggly", "Zesty", "Chunky", "Squishy",
    "Dizzy",  "Fuzzy",  "Jumpy",  "Loopy",  "Peppy",  "Quirky", "Rusty",  "Sassy",
    "Tipsy",  "Wacky",  "Zippy",  "Gloopy", "Soggy",  "Prickly","Nifty",  "Clumsy",
    "Wobbly", "Snarky", "Lanky",  "Plump",  "Stinky", "Cranky", "Sleepy", "Grouchy",
    "Dopey",  "Bashful","Sneezy", "Jolly",  "Cheeky", "Zany",   "Goofy",  "Nerdy",
    "Spunky", "Frisky", "Giddy",  "Kooky",  "Loopy",  "Muggy",  "Noisy",  "Perky",
];

static ANIMALS: &[&str] = &[
    "Alligator","Badger",   "Capybara",  "Dingo",    "Echidna",  "Ferret",
    "Gibbon",   "Hedgehog", "Iguana",    "Jackal",   "Kangaroo", "Lemur",
    "Mongoose", "Narwhal",  "Otter",     "Platypus", "Quokka",   "Raccoon",
    "Salamander","Tapir",   "Uakari",    "Vulture",  "Wombat",   "Axolotl",
    "Yak",      "Zebu",     "Pangolin",  "Binturong","Caracal",  "Dugong",
    "Wolverine","Manatee",  "Armadillo", "Capuchin", "Porcupine","Tarantula",
    "Orangutan","Numbat",   "Quetzal",   "Kinkajou", "Mandrill", "Tarsier",
    "Aardvark", "Cassowary","Marmot",    "Ocelot",   "Shoebill", "Coati",
];

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/me", post(upsert_me).get(get_me).patch(update_me))
        .route("/me/ping-active", post(ping_active))
        .route("/me/set-withdraw-code", post(set_withdraw_code))
        .route("/resolve", post(resolve_recipient))
        .route("/by-username/:username", axum::routing::get(get_user_public_by_username))
        .route("/:uid/warn", post(warn_user))
        .route("/:uid/ban", post(ban_user))
        .route("/:uid", axum::routing::get(get_user_public))
}

async fn ping_active(ctx: Ctx) -> Result<Json<serde_json::Value>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let path = format!("users/{}", ctx.user.uid);
    let now = unix_now();

    let Some(profile_val) = db.get(&path).await? else {
        return Ok(Json(serde_json::json!({
            "ok": true,
            "updated": false,
            "reason": "profile_not_initialized"
        })));
    };

    let last_active_at = profile_val
        .get("last_active_at")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if now.saturating_sub(last_active_at) < HEARTBEAT_MIN_INTERVAL_SECS {
        return Ok(Json(serde_json::json!({
            "ok": true,
            "updated": false,
            "last_active_at": last_active_at
        })));
    }

    db.set(&format!("{}/last_active_at", path), &serde_json::json!(now)).await?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "updated": true,
        "last_active_at": now
    })))
}

#[derive(serde::Serialize)]
struct PublicProfile {
    uid: String,
    username: String,
    avatar_number: u8,
    trade_count: u64,
    feedback_pos: u64,
    feedback_neg: u64,
}

async fn get_user_public(ctx: Ctx, Path(uid): Path<String>) -> Result<Json<PublicProfile>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db.get(&format!("users/{}", uid)).await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;
    let profile: UserProfile = serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(PublicProfile {
        uid: profile.uid,
        username: profile.username,
        avatar_number: profile.avatar_number,
        trade_count: profile.trade_count,
        feedback_pos: profile.feedback_pos,
        feedback_neg: profile.feedback_neg,
    }))
}

const WARNING_EXPIRY_SECS: u64 = 14 * 24 * 3600;
const BAN_WARNING_THRESHOLD: usize = 3;

#[derive(serde::Serialize)]
struct PublicFeedbackEntry {
    positive: bool,
    comment: String,
    created_at: u64,
    from_uid: String,
}

#[derive(serde::Serialize)]
struct PublicUserProfileFull {
    uid: String,
    username: String,
    avatar_number: u8,
    trade_count: u64,
    feedback_pos: u64,
    feedback_neg: u64,
    last_active_at: u64,
    active_warning_count: u64,
    recent_feedback: Vec<PublicFeedbackEntry>,
    active_offers: Vec<Offer>,
}

/// Public-facing profile page data, looked up by username (the /user/:username
/// route) rather than uid — trade count and feedback are computed live from
/// the trades collection instead of the profile's own (unmaintained) counters.
async fn get_user_public_by_username(ctx: Ctx, Path(username): Path<String>) -> Result<Json<PublicUserProfileFull>, AppError> {
    let lower = username.trim().trim_start_matches('@').to_lowercase();
    if lower.is_empty() {
        return Err(AppError::BadRequest("Username cannot be empty".into()));
    }

    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let entry_val = db.get(&format!("usernames/{}", lower)).await?
        .ok_or_else(|| AppError::NotFound(format!("User '{}' not found", username)))?;
    let entry: UsernameEntry = serde_json::from_value(entry_val).map_err(|e| AppError::Internal(e.to_string()))?;

    let admin_db = RtdbClient::new_admin(&ctx.state);
    let profile_val = admin_db.get(&format!("users/{}", entry.uid)).await?
        .ok_or_else(|| AppError::NotFound(format!("User '{}' not found", username)))?;
    let profile: UserProfile = serde_json::from_value(profile_val).map_err(|e| AppError::Internal(e.to_string()))?;

    let now = unix_now();

    let trades: Vec<Trade> = admin_db.get_collection("trades").await?
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Trade>(v).ok())
        .filter(|t| t.creator_uid == entry.uid || t.offer_owner_uid == entry.uid)
        .collect();

    let trade_count = trades.iter().filter(|t| t.status == TradeStatus::Completed).count() as u64;

    let mut feedback_entries: Vec<PublicFeedbackEntry> = trades
        .iter()
        .flat_map(|t| t.feedback.iter())
        .filter(|f| f.to_uid == entry.uid)
        .map(|f| PublicFeedbackEntry {
            positive: f.positive,
            comment: f.comment.clone(),
            created_at: f.created_at,
            from_uid: f.from_uid.clone(),
        })
        .collect();
    feedback_entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    let feedback_pos = feedback_entries.iter().filter(|f| f.positive).count() as u64;
    let feedback_neg = feedback_entries.iter().filter(|f| !f.positive).count() as u64;
    feedback_entries.truncate(10);

    let active_offers: Vec<Offer> = admin_db.get_collection("offers").await?
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Offer>(v).ok())
        .filter(|o| o.creator_uid == entry.uid && o.status == OfferStatus::Active)
        .collect();

    let active_warning_count = admin_db.get_collection(&format!("warnings/{}", entry.uid)).await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Warning>(v).ok())
        .filter(|w| w.expires_at > now)
        .count() as u64;

    Ok(Json(PublicUserProfileFull {
        uid: profile.uid,
        username: profile.username,
        avatar_number: profile.avatar_number,
        trade_count,
        feedback_pos,
        feedback_neg,
        last_active_at: profile.last_active_at,
        active_warning_count,
        recent_feedback: feedback_entries,
        active_offers,
    }))
}

#[derive(serde::Deserialize, Default)]
struct WarnUserRequest {
    #[serde(default)]
    reason: String,
    #[serde(default)]
    trade_id: Option<String>,
}

/// Issues a warning against `uid`, expiring in 2 weeks. If this pushes their
/// active (non-expired) warning count to 3 or more, they're auto-banned.
async fn warn_user(ctx: Ctx, Path(uid): Path<String>, Json(req): Json<WarnUserRequest>) -> Result<Json<serde_json::Value>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    if !is_moderator_email(&db, ctx.user.email.as_deref()).await? {
        return Err(AppError::Forbidden("Moderator access required".into()));
    }

    let reason = req.reason.trim();
    if reason.chars().count() > 500 {
        return Err(AppError::BadRequest("Reason must be 500 characters or fewer".into()));
    }

    let admin_db = RtdbClient::new_admin(&ctx.state);
    if admin_db.get(&format!("users/{}", uid)).await?.is_none() {
        return Err(AppError::NotFound("User not found".into()));
    }

    let now = unix_now();
    let warning = Warning {
        id: uuid::Uuid::new_v4().to_string(),
        uid: uid.clone(),
        moderator_uid: ctx.user.uid.clone(),
        reason: reason.to_string(),
        created_at: now,
        expires_at: now + WARNING_EXPIRY_SECS,
        trade_id: req.trade_id.clone(),
    };
    admin_db.set(&format!("warnings/{}/{}", uid, warning.id), &serde_json::to_value(&warning).unwrap()).await?;

    let active_warnings: usize = admin_db.get_collection(&format!("warnings/{}", uid)).await?
        .into_iter()
        .filter_map(|v| serde_json::from_value::<Warning>(v).ok())
        .filter(|w| w.expires_at > now)
        .count();

    let mut auto_banned = false;
    if active_warnings >= BAN_WARNING_THRESHOLD {
        if let Some(val) = admin_db.get(&format!("users/{}", uid)).await? {
            if let Ok(mut profile) = serde_json::from_value::<UserProfile>(val) {
                if !profile.banned {
                    profile.banned = true;
                    profile.ban_reason = Some(format!("Automatically banned after {} active warnings", active_warnings));
                    profile.banned_at = Some(now);
                    admin_db.set(&format!("users/{}", uid), &serde_json::to_value(&profile).unwrap()).await?;
                    auto_banned = true;
                }
            }
        }
    }

    Ok(Json(serde_json::json!({
        "ok": true,
        "warning_id": warning.id,
        "active_warning_count": active_warnings,
        "auto_banned": auto_banned,
    })))
}

#[derive(serde::Deserialize, Default)]
struct BanUserRequest {
    #[serde(default)]
    reason: String,
}

/// Direct moderator ban — independent of the warning-count auto-ban, so a
/// severe case doesn't need 3 prior warnings first.
async fn ban_user(ctx: Ctx, Path(uid): Path<String>, Json(req): Json<BanUserRequest>) -> Result<Json<UserProfile>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    if !is_moderator_email(&db, ctx.user.email.as_deref()).await? {
        return Err(AppError::Forbidden("Moderator access required".into()));
    }

    let reason = req.reason.trim();
    if reason.chars().count() > 500 {
        return Err(AppError::BadRequest("Reason must be 500 characters or fewer".into()));
    }

    let admin_db = RtdbClient::new_admin(&ctx.state);
    let val = admin_db.get(&format!("users/{}", uid)).await?
        .ok_or_else(|| AppError::NotFound("User not found".into()))?;
    let mut profile: UserProfile = serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))?;

    profile.banned = true;
    profile.ban_reason = if reason.is_empty() { None } else { Some(reason.to_string()) };
    profile.banned_at = Some(unix_now());
    profile.banned_by_uid = Some(ctx.user.uid.clone());
    admin_db.set(&format!("users/{}", uid), &serde_json::to_value(&profile).unwrap()).await?;

    Ok(Json(profile))
}

async fn upsert_me(ctx: Ctx) -> Result<Json<UserProfile>, AppError> {
    let (state, user) = (&ctx.state, &ctx.user);
    let db = RtdbClient::new(state, &user.id_token);
    let path = format!("users/{}", user.uid);

    if let Some(val) = db.get(&path).await? {
        let has_avatar_number = val
            .get("avatar_number")
            .and_then(|v| v.as_u64())
            .is_some();

        let mut profile: UserProfile = serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))?;
        let mut should_save = false;

        if profile.username.is_empty() {
            let username = generate_username();
            let entry = UsernameEntry { uid: user.uid.clone(), display: username.clone() };
            db.set(&format!("usernames/{}", username.to_lowercase()), &serde_json::to_value(&entry).unwrap()).await?;
            profile.username = username;
            should_save = true;
        }

        if !has_avatar_number || !(1..=21).contains(&profile.avatar_number) {
            profile.avatar_number = random_avatar_number();
            should_save = true;
        }

        if should_save {
            db.set(&path, &serde_json::to_value(&profile).unwrap()).await?;
        }
        return Ok(Json(profile));
    }

    let username = generate_username();
    let entry = UsernameEntry { uid: user.uid.clone(), display: username.clone() };
    db.set(&format!("usernames/{}", username.to_lowercase()), &serde_json::to_value(&entry).unwrap()).await?;

    let profile = UserProfile {
        uid: user.uid.clone(),
        email: user.email.clone(),
        username,
        username_changes: vec![],
        first_name: None,
        last_name: None,
        country: None,
        avatar_number: random_avatar_number(),
        require_release_code: false,
        withdraw_code_required: false,
        withdraw_code_hash: None,
        blocked_users: vec![],
        trusted_users: vec![],
        created_at: unix_now(),
        trade_count: 0,
        feedback_pos: 0,
        feedback_neg: 0,
        last_active_at: 0,
        banned: false,
        ban_reason: None,
        banned_at: None,
        banned_by_uid: None,
    };

    db.set(&path, &serde_json::to_value(&profile).unwrap()).await?;
    Ok(Json(profile))
}

async fn get_me(ctx: Ctx) -> Result<Json<UserProfile>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let val = db
        .get(&format!("users/{}", ctx.user.uid))
        .await?
        .ok_or_else(|| AppError::NotFound("Profile not initialised — call POST /users/me first".into()))?;
    let profile: UserProfile = serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(profile))
}

async fn update_me(ctx: Ctx, Json(req): Json<UpdateProfileRequest>) -> Result<Json<UserProfile>, AppError> {
    let (state, user) = (&ctx.state, &ctx.user);
    let db = RtdbClient::new(state, &user.id_token);
    let path = format!("users/{}", user.uid);
    let val = db.get(&path).await?.ok_or_else(|| AppError::NotFound("Profile not found".into()))?;
    let mut profile: UserProfile = serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))?;

    if let Some(ref new_username) = req.username {
        let new_username = new_username.trim().to_string();
        let new_lower = new_username.to_lowercase();

        if new_username.len() < 3 || new_username.len() > 30 {
            return Err(AppError::BadRequest("Username must be 3-30 characters".into()));
        }
        if !new_username.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(AppError::BadRequest("Username may only contain letters and digits".into()));
        }

        let existing = db.get(&format!("usernames/{}", new_lower)).await?;
        if let Some(v) = existing {
            let taken_uid = serde_json::from_value::<UsernameEntry>(v)
                .map(|e| e.uid)
                .unwrap_or_default();
            if taken_uid != user.uid {
                return Err(AppError::BadRequest("Username already taken".into()));
            }
        }

        let one_year_ago = unix_now() - 365 * 24 * 3600;
        let recent = profile.username_changes.iter().filter(|&&t| t > one_year_ago).count();
        if recent >= 2 {
            return Err(AppError::BadRequest("Username can only be changed twice per year".into()));
        }

        let old_lower = profile.username.to_lowercase();
        if !old_lower.is_empty() && old_lower != new_lower {
            db.delete(&format!("usernames/{}", old_lower)).await?;
        }
        let entry = UsernameEntry { uid: user.uid.clone(), display: new_username.clone() };
        db.set(&format!("usernames/{}", new_lower), &serde_json::to_value(&entry).unwrap()).await?;

        profile.username_changes.push(unix_now());
        profile.username = new_username;
    }

    if let Some(v) = req.first_name {
        let v = v.trim().to_string();
        if v.len() > 50 { return Err(AppError::BadRequest("First name too long".into())); }
        profile.first_name = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.last_name {
        let v = v.trim().to_string();
        if v.len() > 50 { return Err(AppError::BadRequest("Last name too long".into())); }
        profile.last_name = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.country {
        let v = v.trim().to_string();
        if v.len() > 80 { return Err(AppError::BadRequest("Country name too long".into())); }
        profile.country = if v.is_empty() { None } else { Some(v) };
    }
    if let Some(v) = req.avatar_number {
        if !(1..=21).contains(&v) {
            return Err(AppError::BadRequest("avatar_number must be between 1 and 21".into()));
        }
        profile.avatar_number = v;
    }
    if let Some(v) = req.require_release_code {
        profile.require_release_code = v;
    }
    if let Some(v) = req.withdraw_code_required {
        profile.withdraw_code_required = v;
    }
    if let Some(v) = req.blocked_users {
        if v.len() > 500 { return Err(AppError::BadRequest("Block list too large".into())); }
        if v.iter().any(|u| u.len() > 128) { return Err(AppError::BadRequest("UID too long".into())); }
        profile.blocked_users = v;
    }
    if let Some(v) = req.trusted_users {
        if v.len() > 500 { return Err(AppError::BadRequest("Trusted list too large".into())); }
        if v.iter().any(|u| u.len() > 128) { return Err(AppError::BadRequest("UID too long".into())); }
        profile.trusted_users = v;
    }

    db.set(&path, &serde_json::to_value(&profile).unwrap()).await?;
    Ok(Json(profile))
}

#[derive(serde::Deserialize)]
struct SetWithdrawCodeRequest {
    code: String,
}

async fn set_withdraw_code(ctx: Ctx, Json(req): Json<SetWithdrawCodeRequest>) -> Result<Json<UserProfile>, AppError> {
    let (state, user) = (&ctx.state, &ctx.user);
    let db = RtdbClient::new(state, &user.id_token);
    let path = format!("users/{}", user.uid);
    let val = db.get(&path).await?.ok_or_else(|| AppError::NotFound("Profile not found".into()))?;
    let mut profile: UserProfile = serde_json::from_value(val).map_err(|e| AppError::Internal(e.to_string()))?;

    let code = req.code.trim().to_string();
    if code.is_empty() {
        profile.withdraw_code_hash = None;
    } else {
        if code.len() < 4 || code.len() > 6 || !code.chars().all(|c| c.is_ascii_digit()) {
            return Err(AppError::BadRequest("Confirmation code must be 4–6 digits".into()));
        }
        let mut hasher = Sha256::new();
        hasher.update(format!("{}:{}", user.uid, code).as_bytes());
        let hash = format!("{:x}", hasher.finalize());
        profile.withdraw_code_hash = Some(hash);
    }

    db.set(&path, &serde_json::to_value(&profile).unwrap()).await?;
    Ok(Json(profile))
}

pub async fn resolve_recipient(ctx: Ctx, Json(req): Json<ResolveRecipientRequest>) -> Result<Json<ResolveRecipientResponse>, AppError> {
    let db = RtdbClient::new(&ctx.state, &ctx.user.id_token);
    let identifier = req.identifier.trim().trim_start_matches('@');

    if identifier.is_empty() {
        return Err(AppError::BadRequest("Identifier cannot be empty".into()));
    }

    if let Some(wallet_field) = super::wallet::detect_address_wallet_field(identifier) {
        let result = db.query_equal("wallets", wallet_field, identifier).await?;
        if let Some(val) = result {
            if let Some(uid) = val.as_object().and_then(|m| m.keys().next().cloned()) {
                let profile = db
                    .get(&format!("users/{}", uid))
                    .await?
                    .and_then(|v| serde_json::from_value::<UserProfile>(v).ok());
                let username = profile.as_ref().map(|p| p.username.clone()).filter(|u| !u.is_empty());
                let blocked_you = profile.as_ref().map(|p| p.blocked_users.contains(&ctx.user.uid)).unwrap_or(false);
                return Ok(Json(ResolveRecipientResponse {
                    is_platform_user: true,
                    uid: Some(uid),
                    username,
                    blocked_you,
                }));
            }
        }
        return Ok(Json(ResolveRecipientResponse {
            is_platform_user: false,
            uid: None,
            username: None,
            blocked_you: false,
        }));
    }

    let lower = identifier.to_lowercase();
    let result = db.get(&format!("usernames/{}", lower)).await?;
    if let Some(val) = result {
        if let Ok(entry) = serde_json::from_value::<UsernameEntry>(val) {
            let profile = db
                .get(&format!("users/{}", entry.uid))
                .await?
                .and_then(|v| serde_json::from_value::<UserProfile>(v).ok());
            let blocked_you = profile.map(|p| p.blocked_users.contains(&ctx.user.uid)).unwrap_or(false);
            return Ok(Json(ResolveRecipientResponse {
                is_platform_user: true,
                uid: Some(entry.uid),
                username: Some(entry.display),
                blocked_you,
            }));
        }
    }

    Err(AppError::NotFound(format!(
        "User '{}' not found on this platform",
        identifier
    )))
}

fn generate_username() -> String {
    let mut rng = rand::thread_rng();
    let adj = ADJECTIVES[rng.gen_range(0..ADJECTIVES.len())];
    let animal = ANIMALS[rng.gen_range(0..ANIMALS.len())];
    let num: u16 = rng.gen_range(100..1000);
    format!("{}{}{}", adj, animal, num)
}

fn random_avatar_number() -> u8 {
    rand::thread_rng().gen_range(1..=21)
}

fn unix_now() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
