use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

use crate::error::CoreError;
use crate::surface::{MeshOutput, TargetSoftware};

fn target_label(t: TargetSoftware) -> &'static str {
    match t {
        TargetSoftware::Disguise => "disguise (right-hand, +Y up, m)",
        TargetSoftware::Unreal => "unreal (left-hand, +Z up, cm)",
        TargetSoftware::Neutral => "neutral (right-hand, +Z up, m)",
    }
}

/// Serialize a `MeshOutput` to a Wavefront OBJ file atomically.
///
/// Validates `mesh` before opening the file. Writes to a same-directory
/// temp file first, fsyncs, then `rename()`s into place. If any I/O step
/// fails, the temp file is removed and the destination is left unchanged
/// (so a previously valid OBJ survives a failed re-export).
///
/// Format:
/// - 1-based indices
/// - Vertex / UV pairs in `f` lines
/// - No normals (renderers compute them, OBJ allows omitting)
/// - Single mesh group
pub fn write_obj(mesh: &MeshOutput, path: &Path) -> Result<(), CoreError> {
    mesh.validate()?;

    // Pick a temp path next to `path` so rename stays on the same filesystem.
    let temp_path = match path.file_name() {
        Some(name) => {
            let mut tmp_name = name.to_os_string();
            tmp_name.push(format!(".tmp.{}", std::process::id()));
            path.with_file_name(tmp_name)
        }
        None => {
            return Err(CoreError::InvalidInput(format!(
                "write_obj: path {:?} has no file name component",
                path
            )));
        }
    };

    // Inner closure does the write so we can clean up the temp on any error.
    let write_result: Result<(), CoreError> = (|| {
        let file = File::create(&temp_path)?;
        let mut w = BufWriter::new(file);

        writeln!(w, "# LED Mesh Toolkit OBJ export")?;
        writeln!(w, "# Target: {}", target_label(mesh.target))?;
        writeln!(w, "# Vertices: {}", mesh.vertices.len())?;
        writeln!(w, "# Triangles: {}", mesh.triangles.len())?;
        writeln!(w)?;

        for v in &mesh.vertices {
            writeln!(
                w,
                "v {} {} {}",
                trim_zero(v.x),
                trim_zero(v.y),
                trim_zero(v.z)
            )?;
        }
        for uv in &mesh.uv_coords {
            writeln!(w, "vt {} {}", trim_zero(uv.x), trim_zero(uv.y))?;
        }

        writeln!(w, "g screen_mesh")?;
        for t in &mesh.triangles {
            let a = t[0] + 1;
            let b = t[1] + 1;
            let c = t[2] + 1;
            writeln!(w, "f {a}/{a} {b}/{b} {c}/{c}")?;
        }

        // Flush BufWriter, fsync the file, then drop to release the handle.
        w.flush()?;
        let file = w.into_inner().map_err(|e| {
            CoreError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            ))
        })?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_result {
        // Best-effort cleanup of the temp file. Ignore the cleanup result
        // (we want to surface the original error, not a secondary one).
        let _ = fs::remove_file(&temp_path);
        return Err(e);
    }

    // Atomic rename into place. On failure, remove the temp.
    if let Err(e) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(CoreError::Io(e));
    }

    Ok(())
}

fn trim_zero(x: f64) -> String {
    let s = format!("{:.6}", x);
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    if s.is_empty() || s == "-" {
        "0".to_string()
    } else {
        s
    }
}
