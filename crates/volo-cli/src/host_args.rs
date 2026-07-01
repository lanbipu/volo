//! `--host` (single) vs `--hosts a,b,c` (batch) mutually-exclusive flag set
//! used by `env set` / `ini set` / `ini remove`.

use cache_core::error::{VoloError, VoloResult};
use clap::Args;

#[derive(Args, Debug, Clone)]
pub struct HostArgs {
    /// Single host. Mutually exclusive with --hosts.
    #[arg(long, group = "target", value_name = "HOST")]
    pub host: Option<String>,

    /// Comma-separated host list. Mutually exclusive with --host.
    #[arg(
        long,
        group = "target",
        value_name = "H1,H2,...",
        value_delimiter = ','
    )]
    pub hosts: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HostTarget {
    Single(String),
    Batch(Vec<String>),
}

impl HostArgs {
    /// Require exactly one of --host / --hosts. `clap` group already enforces
    /// mutex; this catches the "neither supplied" case.
    pub fn require_one(&self) -> VoloResult<HostTarget> {
        match (&self.host, &self.hosts) {
            (Some(h), None) => Ok(HostTarget::Single(h.clone())),
            (None, Some(hs)) if !hs.is_empty() => Ok(HostTarget::Batch(hs.clone())),
            (None, Some(_)) => Err(VoloError::InvalidInput(
                "--hosts requires at least one host".into(),
            )),
            (None, None) => Err(VoloError::InvalidInput(
                "one of --host or --hosts is required".into(),
            )),
            (Some(_), Some(_)) => unreachable!("clap group 'target' enforces mutex"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_host_returns_single_variant() {
        let args = HostArgs { host: Some("a".into()), hosts: None };
        assert_eq!(args.require_one().unwrap(), HostTarget::Single("a".into()));
    }

    #[test]
    fn hosts_list_returns_batch_variant() {
        let args = HostArgs { host: None, hosts: Some(vec!["a".into(), "b".into()]) };
        match args.require_one().unwrap() {
            HostTarget::Batch(v) => assert_eq!(v, vec!["a".to_string(), "b".to_string()]),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn empty_returns_invalid_input() {
        let args = HostArgs { host: None, hosts: None };
        assert!(matches!(args.require_one(), Err(VoloError::InvalidInput(_))));
    }

    #[test]
    fn empty_hosts_vec_returns_invalid_input() {
        let args = HostArgs { host: None, hosts: Some(vec![]) };
        assert!(matches!(args.require_one(), Err(VoloError::InvalidInput(_))));
    }
}
