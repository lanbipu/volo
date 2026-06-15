//! Total-station CSV adapter (M1).
//!
//! Reads instrument-numbered CSV from a Trimble / Leica total station,
//! a project YAML config, and produces `mesh_core::MeasuredPoints` ready
//! for reconstruction + export, plus a JSON validation report and a
//! field instruction card (PDF + HTML).

pub mod builder;
pub mod csv_parser;
pub mod error;
pub mod fallback;
pub mod geometric_naming;
pub mod instruction_card;
pub mod project;
pub mod project_loader;
pub mod raw_point;
pub mod reference_frame;
pub mod scatter_csv;
pub mod report;
pub mod report_builder;
pub mod shape_grid;
pub mod transform;

pub use error::AdapterError;
pub use raw_point::RawPoint;
