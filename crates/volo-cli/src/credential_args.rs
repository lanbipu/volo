//! Shared `--cred-alias` / `--user --pass[--pass-stdin]` argument set, used by
//! every subcommand that authenticates against a remote host.

use cache_core::data::credentials as data_creds;
use cache_core::data::Db;
use cache_core::error::{VoloError, VoloResult};
use clap::Args;
use std::io::{self, BufRead};

#[derive(Args, Debug, Clone)]
pub struct CredentialArgs {
    /// Resolve credentials from a saved alias (SecretStore).
    #[arg(long, value_name = "ALIAS", group = "cred")]
    pub cred_alias: Option<String>,

    /// Inline username; use with --pass-stdin.
    #[arg(long, value_name = "USER", group = "cred", requires = "secret")]
    pub user: Option<String>,

    /// Internal-only password carrier (set by `inline()`); NOT a CLI flag.
    /// Passwords arrive via --pass-stdin or --cred-alias (spec §9: no argv secrets).
    #[arg(skip)]
    pub pass: Option<String>,

    /// Read password from stdin (one line, \r\n trimmed).
    #[arg(
        long,
        group = "secret",
        conflicts_with_all = ["cred_alias"]
    )]
    pub pass_stdin: bool,
}

impl CredentialArgs {
    /// Validate the flag combination without reading stdin or DPAPI. Used by
    /// destructive-command dry-run / preflight paths so calling `resolve` on
    /// the real `--yes` path is not preempted (which would consume the
    /// `--pass-stdin` line and leave the second `resolve` hanging or empty).
    ///
    /// Catches:
    /// - `--cred-alias <X>` where X doesn't exist in SQLite metadata
    /// - inconsistent flag combinations (`--pass` without `--user`, etc.)
    ///
    /// Does NOT read stdin and does NOT call DPAPI — those run only on the
    /// real-execution path inside `resolve`.
    pub fn preflight(&self, db: &Db) -> VoloResult<()> {
        if let Some(alias) = &self.cred_alias {
            data_creds::find_by_alias(db, alias)?.ok_or_else(|| {
                VoloError::InvalidInput(format!("credential alias '{}' not found", alias))
            })?;
            return Ok(());
        }
        match (&self.user, &self.pass, self.pass_stdin) {
            (Some(_), Some(_), false) => Ok(()),
            (Some(_), None, true) => Ok(()), // stdin password read later by `resolve`
            (None, None, false) => Ok(()),
            _ => Err(VoloError::InvalidInput(
                "inconsistent credential flags".into(),
            )),
        }
    }

    /// Build a stdin-free `CredentialArgs` from an already-resolved credential.
    /// Used by orchestration commands that resolve once then fan out to many
    /// sub-handlers — calling `resolve` repeatedly would re-read `--pass-stdin`
    /// (only readable once).
    pub fn inline(resolved: Option<(String, String)>) -> Self {
        match resolved {
            Some((user, pass)) => CredentialArgs {
                cred_alias: None,
                user: Some(user),
                pass: Some(pass),
                pass_stdin: false,
            },
            None => CredentialArgs {
                cred_alias: None,
                user: None,
                pass: None,
                pass_stdin: false,
            },
        }
    }

    /// Resolve to `(username, password)` if any credential was supplied;
    /// `None` means inherit the caller's Kerberos/NTLM context.
    ///
    /// `--cred-alias` yields the real `(user, pass)` from the cross-platform
    /// SecretStore (the username comes from the SQLite alias metadata). SSH-key
    /// callers resolve then discard the pair harmlessly; the SMB / svc-secret
    /// callers actually use it. An alias with no SecretStore entry is an
    /// `InvalidInput` error.
    ///
    /// `no_input` mirrors `--no-input`: when true, the `--pass-stdin` branch
    /// refuses to read stdin (which would block on an interactive terminal)
    /// and returns `InvalidInput` instead. `--cred-alias` and inline `--user
    /// --pass` resolve without stdin, so they are unaffected.
    pub fn resolve(&self, db: &Db, no_input: bool) -> VoloResult<Option<(String, String)>> {
        if let Some(alias) = &self.cred_alias {
            let user = data_creds::find_by_alias(db, alias)?
                .ok_or_else(|| {
                    VoloError::InvalidInput(format!("credential alias '{}' not found", alias))
                })?
                .username;
            let pass = cache_core::core::secrets::SecretStore::from_config()?
                .get(alias)?
                .ok_or_else(|| {
                    VoloError::InvalidInput(format!(
                        "no secret stored for credential alias '{}'",
                        alias
                    ))
                })?;
            return Ok(Some((user, pass)));
        }
        match (&self.user, &self.pass, self.pass_stdin) {
            (Some(u), Some(p), false) => Ok(Some((u.clone(), p.clone()))),
            (Some(u), None, true) => {
                if no_input {
                    return Err(VoloError::InvalidInput(
                        "--no-input set but --pass-stdin requires reading the password from stdin".into(),
                    ));
                }
                let mut line = String::new();
                io::stdin().lock().read_line(&mut line).map_err(|e| {
                    VoloError::InvalidInput(format!("read password from stdin: {}", e))
                })?;
                let pass = line.trim_end_matches(['\r', '\n']).to_string();
                Ok(Some((u.clone(), pass)))
            }
            (None, None, false) => Ok(None),
            _ => Err(VoloError::InvalidInput(
                "inconsistent credential flags".into(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cache_core::data::{open_in_memory, schema};

    fn fresh_db() -> Db {
        let db = open_in_memory().unwrap();
        {
            let mut conn = db.lock().unwrap();
            schema::migrate(&mut conn).unwrap();
        }
        db
    }

    #[test]
    fn resolve_returns_none_when_no_flags_given() {
        let args = CredentialArgs {
            cred_alias: None,
            user: None,
            pass: None,
            pass_stdin: false,
        };
        let db = fresh_db();
        assert!(args.resolve(&db, false).unwrap().is_none());
    }

    #[test]
    fn inline_from_resolved_roundtrips_without_stdin() {
        let reused = CredentialArgs::inline(Some(("alice".into(), "pw".into())));
        let db = fresh_db();
        // resolve must not read stdin — it just returns the inline pair.
        assert_eq!(reused.resolve(&db, false).unwrap(), Some(("alice".into(), "pw".into())));

        let none = CredentialArgs::inline(None);
        assert!(none.resolve(&db, false).unwrap().is_none());
    }

    #[test]
    fn resolve_inline_user_pass() {
        let args = CredentialArgs {
            cred_alias: None,
            user: Some("alice".into()),
            pass: Some("hunter2".into()),
            pass_stdin: false,
        };
        let db = fresh_db();
        assert_eq!(args.resolve(&db, false).unwrap(), Some(("alice".into(), "hunter2".into())));
    }

    #[test]
    fn resolve_unknown_alias_returns_invalid_input() {
        let args = CredentialArgs {
            cred_alias: Some("nope".into()),
            user: None,
            pass: None,
            pass_stdin: false,
        };
        let db = fresh_db();
        let r = args.resolve(&db, false);
        assert!(matches!(r, Err(VoloError::InvalidInput(_))));
    }

    #[test]
    fn resolve_pass_stdin_with_no_input_errors_without_reading_stdin() {
        // --no-input must turn the --pass-stdin branch into a fast
        // InvalidInput instead of blocking on stdin.
        let args = CredentialArgs {
            cred_alias: None,
            user: Some("alice".into()),
            pass: None,
            pass_stdin: true,
        };
        let db = fresh_db();
        let r = args.resolve(&db, true);
        match r {
            Err(VoloError::InvalidInput(msg)) => assert!(msg.contains("--no-input")),
            other => panic!("expected InvalidInput, got {:?}", other),
        }
    }

    #[test]
    fn pass_flag_is_not_accepted_on_cli() {
        use crate::args::Cli;
        use clap::Parser;
        let r = Cli::try_parse_from(["cache","machine","refresh","1","--user","u","--pass","p"]);
        assert!(r.is_err(), "--pass should no longer be a CLI flag");
        let ok = Cli::try_parse_from(["cache","machine","refresh","1","--user","u","--pass-stdin"]);
        assert!(ok.is_ok());
    }
}
