//! System-level Tauri commands (sidecar tests, app metadata).

use cache_core::core::powershell;
use cache_core::error::VoloResult;
use serde::Deserialize;
use std::net::IpAddr;
use volo_shared::error::{VoloError, VoloResult as SharedVoloResult};

#[derive(Debug, Deserialize, serde::Serialize)]
pub struct EchoResult {
    pub received: String,
    pub timestamp: String,
    pub machine: String,
}

#[tauri::command]
pub fn test_powershell_bridge(message: String) -> VoloResult<EchoResult> {
    let script_path = powershell::script_path("test-echo.ps1");
    powershell::run_json::<EchoResult>(&script_path, &[&message])
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NetInterface {
    pub name: String,
    pub ipv4: String,
}

fn include_ipv4(ip: std::net::Ipv4Addr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified()
}

#[tauri::command]
pub fn list_net_interfaces() -> SharedVoloResult<Vec<NetInterface>> {
    let mut interfaces = if_addrs::get_if_addrs()
        .map_err(|e| VoloError::Io(format!("failed to enumerate network interfaces: {e}")))?
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if include_ipv4(ip) => Some(NetInterface {
                name: interface.name,
                ipv4: ip.to_string(),
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    interfaces.sort_by(|a, b| (&a.name, &a.ipv4).cmp(&(&b.name, &b.ipv4)));
    interfaces.dedup();
    Ok(interfaces)
}

#[cfg(test)]
mod net_tests {
    use super::*;

    #[test]
    fn loopback_and_unspecified_are_excluded() {
        assert!(!include_ipv4("127.0.0.1".parse().unwrap()));
        assert!(!include_ipv4("0.0.0.0".parse().unwrap()));
        assert!(include_ipv4("192.168.10.20".parse().unwrap()));
    }

    #[test]
    fn live_enumeration_contains_no_loopback() {
        let interfaces = list_net_interfaces().unwrap();
        assert!(
            !interfaces.is_empty(),
            "expected at least one non-loopback IPv4 interface"
        );
        for interface in interfaces {
            let ip: std::net::Ipv4Addr = interface.ipv4.parse().unwrap();
            assert!(!ip.is_loopback());
        }
    }
}
