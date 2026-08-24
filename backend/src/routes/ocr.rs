use crate::auth::AuthUser;
use crate::error::AppError;
use crate::models::{OcrRequest, OcrResponse};
use crate::AppState;
use axum::{extract::Extension, extract::State, routing::post, Json, Router};
use regex::Regex;
use std::sync::Arc;

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/scan", post(scan_image))
}

async fn scan_image(
    State(state): State<Arc<AppState>>,
    Extension(_user): Extension<AuthUser>,
    Json(req): Json<OcrRequest>,
) -> Result<Json<OcrResponse>, AppError> {

    if req.image_base64.len() > 14_000_000 {
        return Err(AppError::BadRequest(
            "Image too large; maximum is ~10 MB".into(),
        ));
    }

    let raw_text = google_vision_ocr(&state, &req.image_base64).await?;

    let re = Regex::new(r"\b\d{4,19}\b").unwrap();
    let detected_numbers: Vec<String> = re
        .find_iter(&raw_text)
        .map(|m| m.as_str().to_string())
        .collect();

    Ok(Json(OcrResponse {
        raw_text,
        detected_numbers,
    }))
}

async fn google_vision_ocr(state: &AppState, image_base64: &str) -> Result<String, AppError> {
    let url = format!(
        "https://vision.googleapis.com/v1/images:annotate?key={}",
        state.google_vision_api_key
    );

    let body = serde_json::json!({
        "requests": [{
            "image": { "content": image_base64 },
            "features": [{ "type": "TEXT_DETECTION", "maxResults": 1 }]
        }]
    });

    let resp = state
        .http_client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Vision API request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Internal("Google Vision API returned an error".into()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(data["responses"][0]["fullTextAnnotation"]["text"]
        .as_str()
        .unwrap_or("")
        .to_string())
}
