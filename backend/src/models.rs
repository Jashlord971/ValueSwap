use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserProfile {
    pub uid: String,
    pub email: Option<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub username_changes: Vec<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country: Option<String>,
    #[serde(default = "default_avatar_number")]
    pub avatar_number: u8,
    #[serde(default)]
    pub require_release_code: bool,
    #[serde(default)]
    pub withdraw_code_required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withdraw_code_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_users: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trusted_users: Vec<String>,
    pub created_at: u64,
    pub trade_count: u64,
    #[serde(default)]
    pub feedback_pos: u64,
    #[serde(default)]
    pub feedback_neg: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UsernameEntry {
    pub uid: String,
    pub display: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateProfileRequest {
    pub username: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub country: Option<String>,
    pub avatar_number: Option<u8>,
    pub require_release_code: Option<bool>,
    pub withdraw_code_required: Option<bool>,
    pub blocked_users: Option<Vec<String>>,
    pub trusted_users: Option<Vec<String>>,
}

fn default_avatar_number() -> u8 {
    1
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SmartSendRequest {
    pub to: String,
    pub coin: String,
    pub amount: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SmartSendResponse {
    pub transfer_type: String,
    pub transfer: Option<TransferRecord>,
    pub withdrawal: Option<WithdrawResponse>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResolveRecipientRequest {
    pub identifier: String,
    pub coin: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ResolveRecipientResponse {
    pub is_platform_user: bool,
    pub uid: Option<String>,
    pub username: Option<String>,
    pub blocked_you: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WalletInfo {
    pub btc_address: String,
    pub eth_address: String,
    pub tron_address: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WalletBalances {
    pub btc: f64,
    pub eth: f64,
    pub usdt: f64,
    pub usdc: f64,
    pub trx: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct LedgerBalance {
    #[serde(default)]
    pub btc: f64,
    #[serde(default)]
    pub eth: f64,
    #[serde(default)]
    pub usdt: f64,
    #[serde(default)]
    pub usdc: f64,
    #[serde(default)]
    pub trx: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SendRequest {
    pub to_email: String,
    pub coin: String,
    pub amount: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TransferRecord {
    pub id: String,
    pub from_uid: String,
    pub to_uid: String,
    pub coin: String,
    pub amount: f64,
    pub timestamp: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SwapOfferStatus {
    Open,
    Filled,
    Cancelled,
    Expired,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SwapOffer {
    pub id: String,
    pub creator_uid: String,
    pub from_coin: String,
    pub to_coin: String,
    pub from_amount: f64,
    pub to_amount: f64,
    #[serde(default)]
    pub taker_profit_pct: f64,
    pub fee_bps: u16,
    pub status: SwapOfferStatus,
    pub created_at: u64,
    pub expires_at: u64,
    #[serde(default)]
    pub remaining_from_amount: Option<f64>,
    #[serde(default)]
    pub remaining_to_amount: Option<f64>,
    #[serde(default)]
    pub taker_uid: Option<String>,
    #[serde(default)]
    pub filled_at: Option<u64>,
    #[serde(default)]
    pub cancelled_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateSwapOfferRequest {
    pub from_coin: String,
    pub to_coin: String,
    pub from_amount: f64,
    pub taker_profit_pct: f64,
    #[serde(default)]
    pub expires_in_secs: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AcceptSwapOfferRequest {
    #[serde(default)]
    pub take_from_amount: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AcceptSwapOfferResponse {
    pub offer: SwapOffer,
    pub filled_from_amount: f64,
    pub filled_to_amount: f64,
    pub maker_receive_amount: f64,
    pub taker_receive_amount: f64,
    pub fee_from_coin: f64,
    pub fee_to_coin: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WithdrawPlatformFeesRequest {
    pub coin: String,
    pub amount: f64,
    pub to_uid: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlatformFeesSnapshot {
    #[serde(default)]
    pub btc: f64,
    #[serde(default)]
    pub eth: f64,
    #[serde(default)]
    pub usdt: f64,
    #[serde(default)]
    pub usdc: f64,
    #[serde(default)]
    pub trx: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WithdrawRequest {
    pub coin: String,
    pub to_address: String,
    pub amount: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WithdrawResponse {
    pub tx_hash: String,
    pub coin: String,
    pub amount: f64,
    pub to_address: String,
    pub fee_deducted: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TradeFeedback {
    pub from_uid: String,
    pub to_uid: String,
    pub positive: bool,
    #[serde(default)]
    pub comment: String,
    pub created_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Trade {
    pub id: String,
    pub creator_uid: String,
    pub offer_owner_uid: String,
    pub offer_id: String,
    #[serde(default)]
    pub card: String,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub offer_type: String,
    #[serde(default)]
    pub profit_pct: f64,
    #[serde(default)]
    pub terms: String,
    pub fiat_amount: f64,
    pub crypto_amount: f64,
    pub coin: String,
    pub time_limit_secs: u64,
    pub expires_at: u64,
    pub status: TradeStatus,
    pub created_at: u64,
    #[serde(default)]
    pub escrow_locked_amount: f64,
    #[serde(default)]
    pub escrow_fee_amount: f64,
    #[serde(default)]
    pub escrow_released: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub cancel_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feedback: Vec<TradeFeedback>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub creator_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub offer_owner_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub creator_avatar_number: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(default)]
    pub offer_owner_avatar_number: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TradeStatus {
    Open,
    Pending,
    Paid,
    Completed,
    Cancelled,
    Disputed,
    Expired,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateTradeRequest {
    pub offer_id: String,
    pub fiat_amount: f64,
    pub crypto_amount: f64,
    pub coin: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LeaveTradeFeedbackRequest {
    pub positive: bool,
    pub comment: String,
}

pub const FIAT_CURRENCIES: &[(&str, &str)] = &[
    ("AED", "UAE Dirham"),
    ("AUD", "Australian Dollar"),
    ("BRL", "Brazilian Real"),
    ("CAD", "Canadian Dollar"),
    ("CHF", "Swiss Franc"),
    ("CNY", "Chinese Yuan"),
    ("CZK", "Czech Koruna"),
    ("DKK", "Danish Krone"),
    ("EGP", "Egyptian Pound"),
    ("EUR", "Euro"),
    ("GBP", "British Pound"),
    ("GHS", "Ghanaian Cedi"),
    ("HKD", "Hong Kong Dollar"),
    ("HUF", "Hungarian Forint"),
    ("IDR", "Indonesian Rupiah"),
    ("INR", "Indian Rupee"),
    ("JPY", "Japanese Yen"),
    ("KES", "Kenyan Shilling"),
    ("KRW", "South Korean Won"),
    ("MAD", "Moroccan Dirham"),
    ("MXN", "Mexican Peso"),
    ("MYR", "Malaysian Ringgit"),
    ("NGN", "Nigerian Naira"),
    ("NOK", "Norwegian Krone"),
    ("NZD", "New Zealand Dollar"),
    ("PHP", "Philippine Peso"),
    ("PLN", "Polish Zloty"),
    ("RON", "Romanian Leu"),
    ("SAR", "Saudi Riyal"),
    ("SEK", "Swedish Krona"),
    ("SGD", "Singapore Dollar"),
    ("THB", "Thai Baht"),
    ("TRY", "Turkish Lira"),
    ("TZS", "Tanzanian Shilling"),
    ("UGX", "Ugandan Shilling"),
    ("USD", "US Dollar"),
    ("ZAR", "South African Rand"),
    ("ZMW", "Zambian Kwacha"),
];

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMethodType {
    GiftCard,
    BankTransfer,
    MobileApp,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PaymentMethod {
    pub id: String,
    pub name: String,
    pub method_type: PaymentMethodType,
    pub allowed_currencies: Option<Vec<String>>,
    pub escrow_fee_pct: f64,
}

pub fn payment_methods() -> Vec<PaymentMethod> {
    use PaymentMethodType::*;
    macro_rules! only {
        ($($c:literal),+) => { Some(vec![$($c.to_string()),+]) }
    }
    vec![
        // ── Gift Cards ──────────────────────────────────────────────────────────
        PaymentMethod { id: "moneypak".into(),          name: "MoneyPak".into(),                          method_type: GiftCard,     allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "apple_gift_card".into(),   name: "Apple Gift Card".into(),                   method_type: GiftCard,     allowed_currencies: only!["USD","GBP","EUR","AUD","CAD","JPY","CNY","INR"], escrow_fee_pct: 0.05 },
        PaymentMethod { id: "google_play".into(),       name: "Google Play Gift Card".into(),             method_type: GiftCard,     allowed_currencies: only!["USD","GBP","EUR","AUD","CAD","INR","JPY"],       escrow_fee_pct: 0.05 },
        PaymentMethod { id: "amazon_gift_card".into(),  name: "Amazon Gift Card".into(),                  method_type: GiftCard,     allowed_currencies: only!["USD","GBP","EUR","AUD","CAD","INR","JPY"],       escrow_fee_pct: 0.05 },
        PaymentMethod { id: "steam".into(),             name: "Steam Gift Card".into(),                   method_type: GiftCard,     allowed_currencies: only!["USD","GBP","EUR","AUD","CAD"],                    escrow_fee_pct: 0.05 },
        PaymentMethod { id: "razer_gold".into(),        name: "Razer Gold".into(),                        method_type: GiftCard,     allowed_currencies: only!["USD","EUR","GBP","SGD","MYR","IDR","PHP","THB"], escrow_fee_pct: 0.05 },
        PaymentMethod { id: "uber_eats".into(),         name: "Uber Eats Gift Card".into(),               method_type: GiftCard,     allowed_currencies: only!["USD","GBP","AUD","CAD"],                          escrow_fee_pct: 0.05 },
        PaymentMethod { id: "uber_gift_card".into(),    name: "Uber Gift Card".into(),                    method_type: GiftCard,     allowed_currencies: only!["USD","GBP","EUR","AUD","CAD"],                    escrow_fee_pct: 0.05 },
        PaymentMethod { id: "instacart".into(),         name: "Instacart Gift Card".into(),               method_type: GiftCard,     allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "walmart".into(),           name: "Walmart Gift Card".into(),                 method_type: GiftCard,     allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "target".into(),            name: "Target Gift Card".into(),                  method_type: GiftCard,     allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "best_buy".into(),          name: "Best Buy Gift Card".into(),                method_type: GiftCard,     allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "ebay_gift_card".into(),    name: "eBay Gift Card".into(),                    method_type: GiftCard,     allowed_currencies: only!["USD","GBP","AUD"],                                 escrow_fee_pct: 0.05 },
        PaymentMethod { id: "visa_gift_card".into(),    name: "Visa Gift Card".into(),                    method_type: GiftCard,     allowed_currencies: only!["USD","GBP","EUR","AUD","CAD"],                    escrow_fee_pct: 0.05 },
        PaymentMethod { id: "mastercard_gift".into(),   name: "Mastercard Gift Card".into(),              method_type: GiftCard,     allowed_currencies: only!["USD","GBP","EUR","AUD","CAD"],                    escrow_fee_pct: 0.05 },
        PaymentMethod { id: "vanilla_visa".into(),      name: "Vanilla Visa".into(),                      method_type: GiftCard,     allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "nike".into(),              name: "Nike Gift Card".into(),                    method_type: GiftCard,     allowed_currencies: only!["USD","GBP","EUR","AUD"],                          escrow_fee_pct: 0.05 },
        PaymentMethod { id: "sephora".into(),           name: "Sephora Gift Card".into(),                 method_type: GiftCard,     allowed_currencies: only!["USD","CAD"],                                       escrow_fee_pct: 0.05 },
        // ── Mobile Money ────────────────────────────────────────────────────────
        PaymentMethod { id: "mtn_momo".into(),          name: "MTN Mobile Money".into(),                  method_type: MobileApp,    allowed_currencies: only!["GHS"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "telecel_ghana".into(),     name: "Telecel Ghana".into(),                     method_type: MobileApp,    allowed_currencies: only!["GHS"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "airteltigo".into(),        name: "AirtelTigo Money".into(),                  method_type: MobileApp,    allowed_currencies: only!["GHS"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "opay".into(),              name: "OPay".into(),                              method_type: MobileApp,    allowed_currencies: only!["NGN"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "palmpay".into(),           name: "PalmPay".into(),                           method_type: MobileApp,    allowed_currencies: only!["NGN"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "kuda".into(),              name: "Kuda Bank".into(),                         method_type: MobileApp,    allowed_currencies: only!["NGN"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "mpesa".into(),             name: "M-Pesa".into(),                            method_type: MobileApp,    allowed_currencies: only!["KES"],                                              escrow_fee_pct: 0.05 },
        // ── Mobile App Transfers ────────────────────────────────────────────────
        PaymentMethod { id: "paypal".into(),            name: "PayPal".into(),                            method_type: MobileApp,    allowed_currencies: None,                                                      escrow_fee_pct: 0.05 },
        PaymentMethod { id: "venmo".into(),             name: "Venmo".into(),                             method_type: MobileApp,    allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "cash_app".into(),          name: "Cash App".into(),                          method_type: MobileApp,    allowed_currencies: only!["USD","GBP"],                                       escrow_fee_pct: 0.05 },
        PaymentMethod { id: "zelle".into(),             name: "Zelle".into(),                             method_type: MobileApp,    allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "revolut".into(),           name: "Revolut".into(),                           method_type: MobileApp,    allowed_currencies: None,                                                      escrow_fee_pct: 0.05 },
        PaymentMethod { id: "wise".into(),              name: "Wise".into(),                              method_type: MobileApp,    allowed_currencies: None,                                                      escrow_fee_pct: 0.05 },
        PaymentMethod { id: "skrill".into(),            name: "Skrill".into(),                            method_type: MobileApp,    allowed_currencies: None,                                                      escrow_fee_pct: 0.05 },
        PaymentMethod { id: "chime".into(),             name: "Chime".into(),                             method_type: MobileApp,    allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "google_pay".into(),        name: "Google Pay".into(),                        method_type: MobileApp,    allowed_currencies: None,                                                      escrow_fee_pct: 0.05 },
        PaymentMethod { id: "apple_pay".into(),         name: "Apple Pay".into(),                         method_type: MobileApp,    allowed_currencies: None,                                                      escrow_fee_pct: 0.05 },
        // ── Bank Transfers ──────────────────────────────────────────────────────
        PaymentMethod { id: "bank_ach".into(),          name: "Bank Transfer (ACH)".into(),               method_type: BankTransfer, allowed_currencies: only!["USD"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "bank_sepa".into(),         name: "Bank Transfer (SEPA)".into(),              method_type: BankTransfer, allowed_currencies: only!["EUR"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "bank_fps".into(),          name: "Bank Transfer (Faster Payments)".into(),   method_type: BankTransfer, allowed_currencies: only!["GBP"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "bank_imps".into(),         name: "Bank Transfer (IMPS/NEFT)".into(),         method_type: BankTransfer, allowed_currencies: only!["INR"],                                              escrow_fee_pct: 0.05 },
        PaymentMethod { id: "bank_transfer".into(),     name: "Bank Transfer".into(),                     method_type: BankTransfer, allowed_currencies: None,                                                      escrow_fee_pct: 0.05 },
    ]
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OfferType {
    Buy,
    Sell,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OfferStatus {
    Active,
    Inactive,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CryptoReleaserSide {
    Maker,
    Taker,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Offer {
    pub id: String,
    pub creator_uid: String,
    /// "buy" = poster wants to buy crypto; "sell" = poster wants to sell crypto
    pub offer_type: OfferType,
    /// Payment method ID (matches PaymentMethod.id)
    pub card: String,
    /// ISO 4217 fiat currency code for this offer (e.g. "USD")
    #[serde(default)]
    pub currency: String,
    /// Cryptocurrency being traded (e.g. "BTC", "ETH", "USDC")
    #[serde(default)]
    pub coin: String,
    /// Sanitized trade terms supplied by the poster (max 500 chars)
    #[serde(default)]
    pub terms: String,
    /// Profit percentage (-100 to 200)
    pub profit_pct: f64,
    pub status: OfferStatus,
    /// Trade time limit in seconds. 900=15min, 1800=30min, 3600=1hr. Default 1800.
    #[serde(default = "default_time_limit")]
    pub time_limit_secs: u64,
    pub created_at: u64,
    /// Positive feedback count (trade completed + upvote)
    #[serde(default)]
    pub feedback_pos: Option<u64>,
    /// Negative feedback count (trade completed + downvote)
    #[serde(default)]
    pub feedback_neg: Option<u64>,
    /// Minimum trade amount in offer currency (if set, USD equivalent must be >= $10)
    #[serde(default)]
    pub min_amount: Option<f64>,
    /// Maximum trade amount in offer currency (if set, must be > min_amount)
    #[serde(default)]
    pub max_amount: Option<f64>,
    /// Maximum amount of crypto available (auto-adjusted if user balance < required amount)
    #[serde(default)]
    pub max_amount_auto_adjusted: bool,
    /// Which side is responsible for releasing crypto on-platform for this offer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crypto_releaser_side: Option<CryptoReleaserSide>,
}

pub fn default_time_limit() -> u64 { 1800 }

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateOfferRequest {
    pub offer_type: OfferType,
    pub card: String,
    pub currency: String,
    pub coin: String,
    pub terms: String,
    pub profit_pct: f64,
    /// 900, 1800, or 3600. Defaults to 1800 if absent.
    #[serde(default = "default_time_limit")]
    pub time_limit_secs: u64,
    /// Minimum trade amount in offer currency (optional, USD equivalent must be >= $10 if set)
    #[serde(default)]
    pub min_amount: Option<f64>,
    /// Maximum trade amount in offer currency (optional, must be > min_amount if set)
    #[serde(default)]
    pub max_amount: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateOfferStatusRequest {
    pub active: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateOfferRequest {
    pub offer_type: OfferType,
    pub card: String,
    pub currency: String,
    pub coin: String,
    pub terms: String,
    pub profit_pct: f64,
    #[serde(default = "default_time_limit")]
    pub time_limit_secs: u64,
    /// Minimum trade amount in offer currency (optional, USD equivalent must be >= $10 if set)
    #[serde(default)]
    pub min_amount: Option<f64>,
    /// Maximum trade amount in offer currency (optional, must be > min_amount if set)
    #[serde(default)]
    pub max_amount: Option<f64>,
}

// ── Gift Cards ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GiftCard {
    pub id: String,
    /// SHA-256 of the raw card number — raw number never stored
    pub hash: String,
    pub brand: String,
    pub amount_usd: f64,
    pub status: CardStatus,
    pub trade_id: Option<String>,
    pub reported_by_uid: String,
    pub created_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "lowercase")]
pub enum CardStatus {
    Active,
    Used,
    Flagged,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RegisterCardRequest {
    /// Raw card number — will be hashed before persistence
    pub card_number: String,
    pub brand: String,
    pub amount_usd: f64,
    pub trade_id: Option<String>,
}

// ── OCR ───────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct OcrRequest {
    /// Base64-encoded image (no data-URL prefix)
    pub image_base64: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OcrResponse {
    pub raw_text: String,
    pub detected_numbers: Vec<String>,
}

// ── Chat ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub id: String,
    pub trade_id: String,
    pub sender_uid: String,
    pub text: Option<String>,
    /// Firebase Storage download URL for an uploaded image
    pub image_url: Option<String>,
    pub created_at: u64,
}
