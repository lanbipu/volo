//! Visual photogrammetry adapter (M2).
//!
//! Wraps a one-shot Python sidecar invocation. The sidecar handles
//! ChArUco detection, bundle adjustment, and Procrustes alignment;
//! this crate handles subprocess management, NDJSON parsing, and IR
//! conversion.

pub mod api;
pub mod error;
pub mod ipc;
pub mod locate;
pub mod sidecar;

pub use error::{VbaError, VbaResult};
pub use ipc::{Event, FrameStrategy, ReconstructInput, ResultData};
