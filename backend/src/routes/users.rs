use crate::auth::Ctx;
use crate::error::AppError;
use crate::firebase::RtdbClient;
use crate::models::{ResolveRecipientRequest, ResolveRecipientResponse, UpdateProfileRequest, UsernameEntry, UserProfile};
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
        .route("/me/set-withdraw-code", post(set_withdraw_code))
        .route("/resolve", post(resolve_recipient))
        .route("/:uid", axum::routing::get(get_user_public))
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


