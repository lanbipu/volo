//! Parses LogDerivedDataCache lines into structured facts. Pure: takes a
//! string slice, returns enums. No I/O.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DdcEvent {
    LocalPath { path: String, writable: bool },
    SharedPath { path: String, writable: bool },
    SharedDeactivated { reason: String },
    MaintenanceFinished { layer: String, file_count: u64, total_bytes: u64 },
    MoveCollision { path: String },
    PakOpened { path: String },
    Other,
}

pub fn parse_line(line: &str) -> DdcEvent {
    let body = match line.strip_prefix("LogDerivedDataCache: ") {
        Some(b) => b,
        None => return DdcEvent::Other,
    };
    let body = body.trim_start_matches("Warning: ").trim_start_matches("Display: ");

    if let Some(rest) = body.strip_prefix("Using Local data cache path ") {
        let (path, suffix) = split_path_suffix(rest);
        return DdcEvent::LocalPath { path, writable: suffix.eq_ignore_ascii_case("Writable") };
    }
    if let Some(rest) = body.strip_prefix("Using Shared data cache path ") {
        let (path, suffix) = split_path_suffix(rest);
        return DdcEvent::SharedPath { path, writable: suffix.eq_ignore_ascii_case("Writable") };
    }
    if let Some(rest) = body.strip_prefix("Shared backend deactivated") {
        return DdcEvent::SharedDeactivated { reason: rest.trim().to_string() };
    }
    if let Some(rest) = body.strip_prefix("Maintenance finished on ") {
        if let Some((layer, stats)) = rest.split_once(": ") {
            if let Some((count_part, size_part)) = stats.split_once(", ") {
                let file_count = count_part
                    .trim_end_matches(" files")
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(0);
                let total_bytes = parse_size_with_unit(size_part.trim());
                return DdcEvent::MaintenanceFinished {
                    layer: layer.trim().to_string(),
                    file_count,
                    total_bytes,
                };
            }
        }
    }
    if let Some(rest) = body.strip_prefix("Move collision when writing ") {
        return DdcEvent::MoveCollision { path: rest.trim().to_string() };
    }
    if let Some(rest) = body.strip_prefix("Opened pak ") {
        return DdcEvent::PakOpened { path: rest.trim().to_string() };
    }
    DdcEvent::Other
}

fn split_path_suffix(rest: &str) -> (String, String) {
    if let Some(idx) = rest.rfind(": ") {
        (rest[..idx].trim().to_string(), rest[idx + 2..].trim().to_string())
    } else {
        (rest.trim().to_string(), String::new())
    }
}

fn parse_size_with_unit(s: &str) -> u64 {
    let s = s.trim();
    let (num, unit): (f64, u64) = if let Some(n) = s.strip_suffix(" GiB") {
        (n.trim().parse().unwrap_or(0.0), 1024u64.pow(3))
    } else if let Some(n) = s.strip_suffix(" MiB") {
        (n.trim().parse().unwrap_or(0.0), 1024u64.pow(2))
    } else if let Some(n) = s.strip_suffix(" KiB") {
        (n.trim().parse().unwrap_or(0.0), 1024)
    } else if let Some(n) = s.strip_suffix(" B") {
        (n.trim().parse().unwrap_or(0.0), 1)
    } else {
        return 0;
    };
    (num * unit as f64) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_local_path_writable() {
        let e = parse_line(r"LogDerivedDataCache: Using Local data cache path D:\DDC: Writable");
        assert_eq!(e, DdcEvent::LocalPath { path: r"D:\DDC".into(), writable: true });
    }

    #[test]
    fn parses_local_path_readonly() {
        let e = parse_line(r"LogDerivedDataCache: Using Local data cache path D:\DDC: ReadOnly");
        assert_eq!(e, DdcEvent::LocalPath { path: r"D:\DDC".into(), writable: false });
    }

    #[test]
    fn parses_shared_path() {
        let e = parse_line(r"LogDerivedDataCache: Using Shared data cache path \\NAS\DDC: Writable");
        assert_eq!(e, DdcEvent::SharedPath { path: r"\\NAS\DDC".into(), writable: true });
    }

    #[test]
    fn parses_deactivated_due_to_latency() {
        let e = parse_line(r"LogDerivedDataCache: Warning: Shared backend deactivated due to latency (87ms over 70ms threshold)");
        match e {
            DdcEvent::SharedDeactivated { reason } => assert!(reason.contains("latency")),
            _ => panic!("expected SharedDeactivated, got {:?}", e),
        }
    }

    #[test]
    fn parses_maintenance_summary() {
        let e = parse_line(r"LogDerivedDataCache: Maintenance finished on Shared: 152 files, 30 MiB");
        match e {
            DdcEvent::MaintenanceFinished { layer, file_count, total_bytes } => {
                assert_eq!(layer, "Shared");
                assert_eq!(file_count, 152);
                assert_eq!(total_bytes, 30 * 1024 * 1024);
            }
            _ => panic!("got {:?}", e),
        }
    }

    #[test]
    fn parses_move_collision() {
        let e = parse_line(r"LogDerivedDataCache: Warning: Move collision when writing \\NAS\DDC\AB\CD\hash.udd");
        match e {
            DdcEvent::MoveCollision { path } => assert!(path.contains(r"AB\CD")),
            _ => panic!("got {:?}", e),
        }
    }

    #[test]
    fn unknown_line_is_other() {
        assert_eq!(parse_line("LogTemp: hello"), DdcEvent::Other);
    }
}
