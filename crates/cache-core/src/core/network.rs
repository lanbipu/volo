//! Async TCP port probe for LAN discovery. Cross-platform — works on macOS
//! during development. No raw sockets, no ICMP, no privileges required.

use crate::error::{UecmError, UecmResult};
use ipnet::Ipv4Net;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::timeout;

/// Port probe result for a single host.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProbedHost {
    pub ip: String,
    pub winrm_open: bool,   // port 5985 — UECM remote management
    pub smb_open: bool,     // port 445  — SMB ADMIN$ + share access
    pub rpc_open: bool,     // port 135  — DCE/RPC Endpoint Mapper, required by PsExec-based Path B
}

/// Default per-port connect timeout. Public so callers (and tests) can tune.
pub const DEFAULT_TIMEOUT_MS: u64 = 1000;

/// Maximum hosts to scan in one call. Guard against accidentally scanning a /16.
pub const MAX_HOSTS: usize = 1024;

/// Cap on simultaneous in-flight hosts. Each permitted host opens 3 concurrent
/// `connect()` syscalls (WinRM 5985 + SMB 445 + RPC 135), so effective socket
/// inflight is `MAX_INFLIGHT * 3`. Default macOS `ulimit -n` is 256 — keeping
/// `50 * 3 = 150` sockets leaves comfortable margin for stdin/out/err, DB
/// handles, and stray temp files. Going above this risks EMFILE on dev macOS,
/// which `TcpStream::connect` would report as a closed port (false negative).
const MAX_INFLIGHT: usize = 50;

const PORT_WINRM: u16 = 5985;
const PORT_SMB: u16 = 445;
const PORT_RPC: u16 = 135;

pub async fn scan_cidr(cidr: &str, timeout_ms: u64) -> UecmResult<Vec<ProbedHost>> {
    let net = Ipv4Net::from_str(cidr)
        .map_err(|e| UecmError::InvalidInput(format!("invalid CIDR '{}': {}", cidr, e)))?;

    let hosts: Vec<IpAddr> = net.hosts().map(IpAddr::V4).collect();

    if hosts.len() > MAX_HOSTS {
        return Err(UecmError::InvalidInput(format!(
            "CIDR expands to {} hosts (max {})",
            hosts.len(),
            MAX_HOSTS
        )));
    }

    let semaphore = Arc::new(Semaphore::new(MAX_INFLIGHT));
    let mut handles = Vec::with_capacity(hosts.len());
    for ip in hosts {
        let permit_source = semaphore.clone();
        handles.push(tokio::spawn(async move {
            let _permit = permit_source.acquire_owned().await.ok()?;
            Some(probe_host(ip, timeout_ms).await)
        }));
    }

    let mut results = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(Some(probed)) = h.await {
            results.push(probed);
        }
    }

    // Only return hosts where UECM has at least one usable management path:
    // WinRM (5985) for direct management, or SMB (445) for Path B remote
    // bootstrap. TCP 135 alone is NOT enough — PsExec needs SMB ADMIN$ to push
    // its service binary, and Refresh needs WinRM. RPC-only hosts have no
    // actionable surface and would clutter discovery results.
    Ok(results
        .into_iter()
        .filter(|r| r.winrm_open || r.smb_open)
        .collect())
}

async fn probe_host(ip: IpAddr, timeout_ms: u64) -> ProbedHost {
    let (winrm, smb, rpc) = tokio::join!(
        probe_port(ip, PORT_WINRM, timeout_ms),
        probe_port(ip, PORT_SMB, timeout_ms),
        probe_port(ip, PORT_RPC, timeout_ms),
    );
    ProbedHost {
        ip: ip.to_string(),
        winrm_open: winrm,
        smb_open: smb,
        rpc_open: rpc,
    }
}

/// Single-host port probe. Unlike `scan_cidr`, returns the result regardless of
/// which ports are open — callers (health-run) need to see "all closed" as a
/// distinct outcome from "host not in CIDR".
pub async fn probe_host_one(ip_str: &str, timeout_ms: u64) -> ProbedHost {
    let ip: IpAddr = match IpAddr::from_str(ip_str) {
        Ok(addr) => addr,
        Err(_) => {
            return ProbedHost {
                ip: ip_str.to_string(),
                winrm_open: false,
                smb_open: false,
                rpc_open: false,
            };
        }
    };
    probe_host(ip, timeout_ms).await
}

async fn probe_port(ip: IpAddr, port: u16, timeout_ms: u64) -> bool {
    let addr = SocketAddr::new(ip, port);
    matches!(
        timeout(Duration::from_millis(timeout_ms), TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn invalid_cidr_returns_error() {
        let result = scan_cidr("not-a-cidr", 100).await;
        assert!(matches!(result, Err(UecmError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn cidr_too_large_returns_error() {
        // /16 = 65534 hosts, well over MAX_HOSTS
        let result = scan_cidr("10.0.0.0/16", 100).await;
        assert!(matches!(result, Err(UecmError::InvalidInput(_))));
    }

    #[tokio::test]
    async fn small_cidr_completes_within_reasonable_time() {
        // /30 = 2 usable hosts, in TEST-NET-3 (RFC 5737) — normally unreachable
        let started = std::time::Instant::now();
        let result = scan_cidr("203.0.113.0/30", 200).await.unwrap();
        let elapsed = started.elapsed();
        // All probes parallel; 4-port-probe x 2 hosts at 200ms each should
        // complete in well under 1s if concurrency works.
        assert!(elapsed.as_millis() < 1500, "scan took {}ms", elapsed.as_millis());
        // Note: the result.is_empty() assertion was removed because some
        // networks (transparent proxies, captive portals, ISP middleboxes)
        // intercept TCP SYN to TEST-NET-3 and reply with SYN-ACK, producing
        // false positives. Concurrency/timing is what this test really
        // exercises; per-host reachability semantics are covered elsewhere.
        let _ = result;
    }

    #[tokio::test]
    async fn loopback_smb_probe_does_not_panic() {
        // /32 expands to 0 hosts, so use /31 with two addresses
        // Just confirm probe_port returns bool without panicking
        let _ = probe_port(IpAddr::from_str("127.0.0.1").unwrap(), 1, 50).await;
    }

    #[tokio::test]
    async fn probe_host_one_returns_all_ports_for_unreachable_host() {
        // TEST-NET-3 (RFC 5737): documentation range, unroutable in real LANs.
        let probed = probe_host_one("203.0.113.1", 100).await;
        assert_eq!(probed.ip, "203.0.113.1");
        // We do not assert false for each port — middleboxes may intercept.
        // We assert the shape: function returns a ProbedHost no matter what.
        let _ = probed.winrm_open;
        let _ = probed.smb_open;
        let _ = probed.rpc_open;
    }
}
