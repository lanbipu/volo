//! Stub for R025. M6.1 extends with alt key names and section variants.

use crate::core::ini_diagnostics::ParsedFile;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditorDdcPrefs {
    pub global_local: Option<String>,
    pub global_shared: Option<String>,
    pub project_local: Option<String>,
    pub project_shared: Option<String>,
}

const SECTIONS: &[&str] = &[
    "/Script/UnrealEd.EditorSettings",
    "/Script/UnrealEd.EditorPerProjectUserSettings",
];

pub fn extract(file: &ParsedFile) -> EditorDdcPrefs {
    let mut out = EditorDdcPrefs::default();
    for s in &file.sections {
        if !SECTIONS.iter().any(|sec| sec.eq_ignore_ascii_case(&s.name)) {
            continue;
        }
        for k in &s.keys {
            let n = k.name.as_str();
            let v = || k.value.trim().to_string();
            if n.eq_ignore_ascii_case("GlobalLocalDDCPath") && out.global_local.is_none() { out.global_local = Some(v()); }
            else if n.eq_ignore_ascii_case("GlobalSharedDDCPath") && out.global_shared.is_none() { out.global_shared = Some(v()); }
            else if n.eq_ignore_ascii_case("ProjectLocalDDCPath") && out.project_local.is_none() { out.project_local = Some(v()); }
            else if n.eq_ignore_ascii_case("ProjectSharedDDCPath") && out.project_shared.is_none() { out.project_shared = Some(v()); }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::ini_diagnostics::{Category, ParsedKey, ParsedSection};

    #[test]
    fn extracts_from_editor_settings_section() {
        let file = ParsedFile {
            path: "test.ini".into(),
            category: Category::User,
            sections: vec![ParsedSection {
                name: "/Script/UnrealEd.EditorSettings".into(),
                keys: vec![ParsedKey {
                    name: "ProjectSharedDDCPath".into(),
                    value: r"\\NAS\Proj".into(),
                    line_number: 0,
                }],
                backend_nodes: vec![],
            }],
        };
        let p = extract(&file);
        assert_eq!(p.project_shared.as_deref(), Some(r"\\NAS\Proj"));
    }

    #[test]
    fn extracts_from_editor_per_project_section() {
        let file = ParsedFile {
            path: "test.ini".into(),
            category: Category::User,
            sections: vec![ParsedSection {
                name: "/Script/UnrealEd.EditorPerProjectUserSettings".into(),
                keys: vec![ParsedKey {
                    name: "ProjectSharedDDCPath".into(),
                    value: r"\\NAS\Proj".into(),
                    line_number: 0,
                }],
                backend_nodes: vec![],
            }],
        };
        let p = extract(&file);
        assert_eq!(p.project_shared.as_deref(), Some(r"\\NAS\Proj"));
    }

    #[test]
    fn section_match_is_case_insensitive() {
        let file = ParsedFile {
            path: "test.ini".into(),
            category: Category::User,
            sections: vec![ParsedSection {
                name: "/script/unrealed.editorperprojectusersettings".into(),
                keys: vec![ParsedKey {
                    name: "GlobalSharedDDCPath".into(),
                    value: r"\\NAS\Global".into(),
                    line_number: 0,
                }],
                backend_nodes: vec![],
            }],
        };
        let p = extract(&file);
        assert_eq!(p.global_shared.as_deref(), Some(r"\\NAS\Global"));
    }

    #[test]
    fn unknown_section_is_ignored() {
        let file = ParsedFile {
            path: "test.ini".into(),
            category: Category::User,
            sections: vec![ParsedSection {
                name: "/Script/UnrealEd.SomeOtherSection".into(),
                keys: vec![ParsedKey {
                    name: "ProjectSharedDDCPath".into(),
                    value: r"\\NAS\Proj".into(),
                    line_number: 0,
                }],
                backend_nodes: vec![],
            }],
        };
        let p = extract(&file);
        assert!(p.project_shared.is_none());
    }
}
