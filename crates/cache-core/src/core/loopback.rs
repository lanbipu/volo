use std::collections::BTreeSet;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::OnceLock;

#[derive(Debug, Clone, Default)]
struct LocalFacts {
    names: Vec<String>,
    ips: Vec<IpAddr>,
}

static LOCAL_FACTS: OnceLock<LocalFacts> = OnceLock::new();

pub fn is_loopback_target(target: &str) -> bool {
    is_loopback_target_with_facts(target, LOCAL_FACTS.get_or_init(collect_local_facts))
}

fn is_loopback_target_with_facts(target: &str, facts: &LocalFacts) -> bool {
    let normalized = normalize_target(target);
    if normalized.is_empty() {
        return false;
    }

    if let Ok(ip) = normalized.parse::<IpAddr>() {
        return ip.is_loopback() || ip.is_unspecified() || facts.ips.contains(&ip);
    }

    if normalized == "localhost" {
        return true;
    }

    let target_names = name_variants(&normalized);
    let local_names: BTreeSet<String> = facts
        .names
        .iter()
        .flat_map(|name| name_variants(name))
        .collect();
    if target_names
        .iter()
        .any(|name| local_names.contains(name))
    {
        return true;
    }

    let local_ips: BTreeSet<IpAddr> = facts.ips.iter().copied().collect();
    !local_ips.is_empty()
        && resolve_host_ips(&normalized)
            .into_iter()
            .any(|ip| local_ips.contains(&ip))
}

fn collect_local_facts() -> LocalFacts {
    let mut names = BTreeSet::new();
    for key in ["COMPUTERNAME", "HOSTNAME"] {
        if let Ok(value) = std::env::var(key) {
            insert_name_variants(&mut names, &value);
        }
    }
    if let Ok(output) =
        crate::core::proc::hide_console(&mut std::process::Command::new("hostname")).output()
    {
        if output.status.success() {
            if let Ok(value) = String::from_utf8(output.stdout) {
                insert_name_variants(&mut names, value.trim());
            }
        }
    }

    let mut ips = BTreeSet::new();
    for name in &names {
        ips.extend(resolve_host_ips(name));
    }
    ips.extend(default_route_ips());
    collect_windows_interface_ips(&mut ips);

    LocalFacts {
        names: names.into_iter().collect(),
        ips: ips.into_iter().collect(),
    }
}

fn normalize_target(target: &str) -> String {
    let mut s = target.trim();
    if let Some(rest) = s.strip_prefix("\\\\") {
        s = rest.split(['\\', '/']).next().unwrap_or(rest);
    }

    if let Ok(addr) = s.parse::<SocketAddr>() {
        return addr.ip().to_string().to_ascii_lowercase();
    }
    if let Ok(ip) = s.parse::<IpAddr>() {
        return ip.to_string().to_ascii_lowercase();
    }

    if let Some(stripped) = s.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        s = stripped;
    }

    if s.matches(':').count() == 1 {
        if let Some((host, port)) = s.rsplit_once(':') {
            if !host.is_empty() && port.chars().all(|ch| ch.is_ascii_digit()) {
                s = host;
            }
        }
    }

    s.trim_end_matches('.').to_ascii_lowercase()
}

fn insert_name_variants(names: &mut BTreeSet<String>, name: &str) {
    for variant in name_variants(name) {
        if !variant.is_empty() {
            names.insert(variant);
        }
    }
}

fn name_variants(name: &str) -> Vec<String> {
    let canonical = name.trim().trim_end_matches('.').to_ascii_lowercase();
    let mut variants = vec![canonical.clone()];
    if let Some((short, _)) = canonical.split_once('.') {
        variants.push(short.to_string());
    }
    variants
}

fn resolve_host_ips(host: &str) -> Vec<IpAddr> {
    (host, 0)
        .to_socket_addrs()
        .map(|addrs| addrs.map(|addr| addr.ip()).collect())
        .unwrap_or_default()
}

fn default_route_ips() -> Vec<IpAddr> {
    let mut ips = Vec::new();
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                ips.push(addr.ip());
            }
        }
    }
    if let Ok(socket) = UdpSocket::bind("[::]:0") {
        if socket.connect("[2001:4860:4860::8888]:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                ips.push(addr.ip());
            }
        }
    }
    ips
}

#[cfg(windows)]
fn collect_windows_interface_ips(ips: &mut BTreeSet<IpAddr>) {
    let script = "[Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object { $_.GetIPProperties().UnicastAddresses } | ForEach-Object { $_.Address.IPAddressToString }";
    if let Ok(output) = crate::core::proc::hide_console(
        std::process::Command::new("powershell.exe").arg("-NoProfile"),
    )
        .arg("-Command")
        .arg(script)
        .output()
    {
        if output.status.success() {
            if let Ok(stdout) = String::from_utf8(output.stdout) {
                for line in stdout.lines() {
                    if let Ok(ip) = line.trim().parse::<IpAddr>() {
                        ips.insert(ip);
                    }
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn collect_windows_interface_ips(_ips: &mut BTreeSet<IpAddr>) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn well_known_loopback_targets_are_local() {
        assert!(is_loopback_target("127.0.0.1"));
        assert!(is_loopback_target("::1"));
        assert!(is_loopback_target("localhost"));
        assert!(is_loopback_target("0.0.0.0"));
    }

    #[test]
    fn local_machine_names_are_local() {
        let facts = LocalFacts {
            names: vec!["lanPC".to_string(), "lanpc.local".to_string()],
            ips: vec![IpAddr::V4(Ipv4Addr::new(192, 168, 10, 20))],
        };

        assert!(is_loopback_target_with_facts("lanpc", &facts));
        assert!(is_loopback_target_with_facts("LANPC.local", &facts));
        assert!(is_loopback_target_with_facts("192.168.10.20", &facts));
        assert!(!is_loopback_target_with_facts("192.168.10.21", &facts));
    }
}
