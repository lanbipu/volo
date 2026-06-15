//! `lmt` subcommand group — LMT's agent-friendly CLI, platformed under
//! `voloctl lmt ...` (step 3c).
//!
//! Mirrors how step 2b mounted UECM under `uecm`: the LMT clap tree
//! (`cli::Cli`) is reparented onto a subcommand named `lmt` by `main.rs`, and
//! `commands::dispatch` runs the matched subcommand. The envelope / exit-code /
//! E2E contract is preserved verbatim — only crate-path references were
//! rewritten (`lmt_app`→`mesh_app`, `lmt_shared`→`volo_shared`) and the module
//! moved from a standalone bin into this `lmt` namespace.
//!
//! Output model (unchanged from LMT):
//! - default human-readable; `--json` / `--output json|ndjson` → stable envelope.
//! - stdout = business result; stderr = error envelope + human logs.
//! - exit codes are semantic (`volo_shared::exit_codes`).

pub mod cli;
pub mod commands;
pub mod output;
