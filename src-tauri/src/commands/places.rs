//! "My games": link a Roblox place to a project and open it in Studio from the app.

use serde::Serialize;

use crate::error::{InstallerError, Result};

/// Extract a placeId from what the user pasted: a bare number, a game page
/// link (`roblox.com/games/123/Name`) or a Creator Hub link (`.../places/123/...`).
pub fn parse_place_id(input: &str) -> Option<u64> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    if input.chars().all(|c| c.is_ascii_digit()) {
        return input.parse().ok().filter(|id| *id > 0);
    }
    for marker in ["/places/", "/games/", "placeId=", "placeid="] {
        if let Some(pos) = input.find(marker) {
            let digits: String = input[pos + marker.len()..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(id) = digits.parse::<u64>() {
                if id > 0 {
                    return Some(id);
                }
            }
        }
    }
    None
}

/// Ask Roblox which universe (experience) a place belongs to. Best effort.
async fn lookup_universe_id(place_id: u64) -> Option<u64> {
    let url = format!("https://apis.roblox.com/universes/v1/places/{place_id}/universe");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()?;
    let value: serde_json::Value = client.get(url).send().await.ok()?.json().await.ok()?;
    value.get("universeId").and_then(|v| v.as_u64()).filter(|id| *id > 0)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedPlace {
    place_id: u64,
    universe_id: Option<u64>,
}

/// Link a place (pasted link or id) to a project and remember it.
#[tauri::command]
pub async fn link_place(project_path: String, place_input: String) -> Result<LinkedPlace> {
    let place_id = parse_place_id(&place_input).ok_or_else(|| {
        InstallerError::Custom(
            "Lien non reconnu. Colle le lien de la page du jeu ou le numéro de la place.".into(),
        )
    })?;
    let universe_id = lookup_universe_id(place_id).await;
    crate::commands::config::save_place_id(&project_path, place_id, universe_id);
    Ok(LinkedPlace { place_id, universe_id })
}

/// Open the place linked to a project in Roblox Studio.
#[tauri::command]
pub async fn open_place_in_studio(project_path: String) -> Result<u64> {
    let config = crate::commands::config::load_config()
        .await
        .ok_or_else(|| InstallerError::Custom("Configuration introuvable".into()))?;
    let project = config
        .projects
        .iter()
        .find(|p| p.path == project_path)
        .ok_or_else(|| InstallerError::Custom("Projet introuvable".into()))?;
    let place_id = project
        .place_id
        .filter(|id| *id > 0)
        .ok_or_else(|| InstallerError::Custom("Aucune place liée à ce jeu".into()))?;
    crate::commands::rojo::open_studio_url(place_id, project.universe_id.unwrap_or(0)).await;
    Ok(place_id)
}

#[cfg(test)]
mod tests {
    use super::parse_place_id;

    #[test]
    fn parses_links_and_ids() {
        assert_eq!(parse_place_id(" 123456 "), Some(123456));
        assert_eq!(parse_place_id("https://www.roblox.com/games/987654321/Mon-Jeu"), Some(987654321));
        assert_eq!(parse_place_id("https://www.roblox.com/fr/games/42/x?a=1"), Some(42));
        assert_eq!(
            parse_place_id("https://create.roblox.com/dashboard/creations/experiences/111/places/222/configure"),
            Some(222)
        );
        assert_eq!(parse_place_id("https://www.roblox.com/games/start?placeId=77"), Some(77));
        assert_eq!(parse_place_id("bonjour"), None);
        assert_eq!(parse_place_id("0"), None);
        assert_eq!(parse_place_id(""), None);
    }
}
