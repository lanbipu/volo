//! Project thumbnail resolution: a same-name PNG next to the .uproject, or
//! the Saved\autosequence_shot.png fallback. Read directly off disk for a
//! loopback target, over SSH for a genuinely remote one — same split as
//! `ddc_pak::verify_output`/`verify_output_local`.

use crate::core::loopback;
use crate::core::ssh::{run_json, NodeScript, SshExecutor};
use crate::error::{VoloError, VoloResult};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Candidates larger than this are skipped, not treated as a read error — a
/// file this big living at these paths is almost certainly not a thumbnail.
const MAX_THUMBNAIL_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct ThumbnailRaw {
    ok: bool,
    found: bool,
    #[serde(default)]
    path: String,
    #[serde(default)]
    base64: String,
    #[serde(default)]
    from: String,
    #[serde(default)]
    mtime: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectThumbnail {
    pub path: String,
    pub base64: String,
    /// "uproject_same_name" | "saved_autosequence" — the human-readable label
    /// is a frontend concern (mirrors the PROBE_DICT/PROBE_NARRATIVE split).
    pub from: String,
    /// The thumbnail candidate's own last-write time (UTC RFC3339-ish) — a
    /// proxy for "recently worked on" (editor-exported thumbnails/autosequence
    /// shots update while someone's active in the project), independent of
    /// `project_locations.discovered_at` (which only tracks when Volo last
    /// rescanned, not when project content actually changed).
    pub mtime: Option<String>,
}

/// The `.uproject` filename without its extension, e.g. `D:\Projects\Aurora\
/// Aurora.uproject` -> `Aurora`. Case-insensitive suffix match (Windows
/// filesystems are case-insensitive and preserve whatever case the project
/// wizard wrote — `project_identity::stem_lower` has the same precedent),
/// so a stray `Aurora.UPROJECT` still strips to `Aurora` instead of leaving
/// the extension attached and permanently missing the same-name PNG.
pub fn uproject_stem(uproject_path: &str) -> String {
    let file_name = uproject_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(uproject_path);
    const SUFFIX: &str = ".uproject";
    if file_name.len() >= SUFFIX.len()
        && file_name[file_name.len() - SUFFIX.len()..].eq_ignore_ascii_case(SUFFIX)
    {
        file_name[..file_name.len() - SUFFIX.len()].to_string()
    } else {
        file_name.to_string()
    }
}

pub fn read_thumbnail(
    host: &str,
    project_dir: &str,
    uproject_stem: &str,
) -> VoloResult<Option<ProjectThumbnail>> {
    if loopback::is_loopback_target(host) {
        return Ok(read_thumbnail_local(project_dir, uproject_stem));
    }
    let exec = SshExecutor::from_config()?;
    let result: ThumbnailRaw = run_json(
        &exec,
        host,
        &NodeScript {
            name: "read-project-thumbnail.ps1",
            args: serde_json::json!({ "ProjectDir": project_dir, "UprojectStem": uproject_stem }),
            ssh_user: None,
        },
    )?;
    if !result.ok {
        return Err(VoloError::OperationFailed(
            result.message.unwrap_or_else(|| "read thumbnail failed".into()),
        ));
    }
    if !result.found {
        return Ok(None);
    }
    Ok(Some(ProjectThumbnail {
        path: result.path,
        base64: result.base64,
        from: result.from,
        mtime: result.mtime,
    }))
}

fn read_thumbnail_local(project_dir: &str, uproject_stem: &str) -> Option<ProjectThumbnail> {
    use base64::Engine;
    let candidates = [
        (
            Path::new(project_dir).join(format!("{uproject_stem}.png")),
            "uproject_same_name",
        ),
        (
            Path::new(project_dir).join("Saved").join("autosequence_shot.png"),
            "saved_autosequence",
        ),
    ];
    for (path, from) in candidates {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_THUMBNAIL_BYTES {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path) {
            let mtime = meta
                .modified()
                .ok()
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339());
            return Some(ProjectThumbnail {
                path: path.to_string_lossy().to_string(),
                base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                from: from.to_string(),
                mtime,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uproject_stem_strips_extension_and_dir() {
        assert_eq!(
            uproject_stem(r"D:\Projects\Aurora\Aurora.uproject"),
            "Aurora"
        );
        assert_eq!(uproject_stem("Nomad.uproject"), "Nomad");
    }

    #[test]
    fn uproject_stem_strips_uppercase_extension() {
        assert_eq!(uproject_stem(r"D:\Projects\Aurora\Aurora.UPROJECT"), "Aurora");
        assert_eq!(uproject_stem("Nomad.UProject"), "Nomad");
    }

    #[test]
    fn read_thumbnail_local_prefers_same_name_over_saved_fallback() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Aurora.png"), b"same-name").unwrap();
        std::fs::create_dir(dir.path().join("Saved")).unwrap();
        std::fs::write(dir.path().join("Saved").join("autosequence_shot.png"), b"fallback").unwrap();

        let thumb = read_thumbnail_local(dir.path().to_str().unwrap(), "Aurora").unwrap();
        assert_eq!(thumb.from, "uproject_same_name");
    }

    #[test]
    fn read_thumbnail_local_falls_back_to_saved_autosequence() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("Saved")).unwrap();
        std::fs::write(dir.path().join("Saved").join("autosequence_shot.png"), b"fallback").unwrap();

        let thumb = read_thumbnail_local(dir.path().to_str().unwrap(), "Aurora").unwrap();
        assert_eq!(thumb.from, "saved_autosequence");
    }

    #[test]
    fn read_thumbnail_local_includes_mtime() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Aurora.png"), b"same-name").unwrap();

        let thumb = read_thumbnail_local(dir.path().to_str().unwrap(), "Aurora").unwrap();
        assert!(thumb.mtime.is_some());
    }

    #[test]
    fn read_thumbnail_local_none_when_nothing_found() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_thumbnail_local(dir.path().to_str().unwrap(), "Aurora").is_none());
    }

    #[test]
    fn read_thumbnail_local_skips_oversized_candidate() {
        let dir = tempfile::tempdir().unwrap();
        // Oversized same-name candidate is skipped (not an error) and falls
        // through to the Saved fallback.
        std::fs::write(
            dir.path().join("Aurora.png"),
            vec![0u8; (MAX_THUMBNAIL_BYTES + 1) as usize],
        )
        .unwrap();
        std::fs::create_dir(dir.path().join("Saved")).unwrap();
        std::fs::write(dir.path().join("Saved").join("autosequence_shot.png"), b"fallback").unwrap();

        let thumb = read_thumbnail_local(dir.path().to_str().unwrap(), "Aurora").unwrap();
        assert_eq!(thumb.from, "saved_autosequence");
    }
}
