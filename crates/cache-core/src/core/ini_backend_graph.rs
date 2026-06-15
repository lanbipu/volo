//! Parser for tuple-form values like Shared=(K1=V1, K2=V2). PRESERVES original
//! field order via Vec<(String, String)>.

use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Eq, Clone, Serialize, Deserialize)]
pub struct BackendNode {
    pub name: String,
    pub fields: Vec<(String, String)>,
    pub line_number: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError { MissingOpenParen, MissingCloseParen, EmptyName }

pub fn parse_node(line: &str, line_number: u32) -> Result<BackendNode, ParseError> {
    let eq = line.find('=').ok_or(ParseError::MissingOpenParen)?;
    let name = line[..eq].trim().to_string();
    if name.is_empty() { return Err(ParseError::EmptyName); }
    let rest = line[eq + 1..].trim_start();
    if !rest.starts_with('(') { return Err(ParseError::MissingOpenParen); }
    let close = rest.rfind(')').ok_or(ParseError::MissingCloseParen)?;
    let body = &rest[1..close];
    let mut fields = Vec::new();
    for part in body.split(',') {
        let part = part.trim();
        if part.is_empty() { continue; }
        let Some(p_eq) = part.find('=') else { continue; };
        let k = part[..p_eq].trim().to_string();
        let v = part[p_eq + 1..].trim().to_string();
        if !k.is_empty() { fields.push((k, v)); }
    }
    Ok(BackendNode { name, fields, line_number })
}

pub fn get_field<'a>(node: &'a BackendNode, name: &str) -> Option<&'a str> {
    node.fields.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

pub fn upsert_field(node: &mut BackendNode, name: &str, value: &str) {
    if let Some((_, v)) = node.fields.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case(name)) {
        *v = value.to_string();
    } else {
        node.fields.push((name.to_string(), value.to_string()));
    }
}

pub fn write_node(node: &BackendNode) -> String {
    let body = node.fields.iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>().join(", ");
    format!("{}=({})", node.name, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_node() {
        let n = parse_node(r"Shared=(Type=FileSystem, Path=\\NAS\DDC, ReadOnly=false)", 12).unwrap();
        assert_eq!(n.name, "Shared");
        assert_eq!(n.fields.len(), 3);
        assert_eq!(n.fields[0], ("Type".into(), "FileSystem".into()));
        assert_eq!(n.fields[1], ("Path".into(), r"\\NAS\DDC".into()));
        assert_eq!(n.fields[2], ("ReadOnly".into(), "false".into()));
        assert_eq!(n.line_number, 12);
    }

    #[test]
    fn preserves_sop_13_field_order() {
        let n = parse_node(r"Shared=(Type=FileSystem, ReadOnly=false, Clean=false, Flush=false, DeleteUnused=true, UnusedFileAge=10, FoldersToClean=10, MaxFileChecksPerSec=1, ConsiderSlowAt=70, PromptIfMissing=false, Path=\\NAS\DDC, EnvPathOverride=UE-SharedDataCachePath, EditorOverrideSetting=SharedDerivedDataCache)", 1).unwrap();
        assert_eq!(n.fields.len(), 13);
        let keys: Vec<&str> = n.fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["Type","ReadOnly","Clean","Flush","DeleteUnused","UnusedFileAge","FoldersToClean","MaxFileChecksPerSec","ConsiderSlowAt","PromptIfMissing","Path","EnvPathOverride","EditorOverrideSetting"]);
    }

    #[test] fn rejects_missing_open_paren() { assert_eq!(parse_node("Shared=Foo", 1), Err(ParseError::MissingOpenParen)); }
    #[test] fn rejects_missing_close_paren() { assert_eq!(parse_node("Shared=(Foo", 1), Err(ParseError::MissingCloseParen)); }
    #[test] fn rejects_empty_name() { assert_eq!(parse_node("=(Foo)", 1), Err(ParseError::EmptyName)); }

    #[test]
    fn upsert_preserves_existing_order() {
        let mut n = parse_node(r"Shared=(Type=FileSystem, ReadOnly=true, Path=\\NAS)", 1).unwrap();
        upsert_field(&mut n, "ReadOnly", "false");
        let keys: Vec<&str> = n.fields.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["Type", "ReadOnly", "Path"]);
        assert_eq!(get_field(&n, "ReadOnly"), Some("false"));
    }

    #[test]
    fn upsert_appends_new_field() {
        let mut n = parse_node(r"Shared=(Type=FileSystem)", 1).unwrap();
        upsert_field(&mut n, "ReadOnly", "false");
        assert_eq!(n.fields.len(), 2);
        assert_eq!(n.fields[1].0, "ReadOnly");
    }

    #[test]
    fn write_node_round_trips() {
        let raw = r"Shared=(Type=FileSystem, Path=\\NAS\DDC, ReadOnly=false)";
        let n = parse_node(raw, 1).unwrap();
        assert_eq!(write_node(&n), raw);
    }
}
