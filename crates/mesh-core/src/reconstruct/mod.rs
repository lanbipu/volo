use crate::error::CoreError;
use crate::measured_points::MeasuredPoints;
use crate::surface::ReconstructedSurface;

pub mod boundary_interp;
pub mod direct;
pub mod grid_check;
pub mod nominal;
pub mod provenance;
pub mod radial_basis;
pub mod surface_fit;

/// Strategy for reconstructing a continuous surface from sparse measured points.
pub trait Reconstructor {
    /// Whether this reconstructor can produce a result given the available measurements.
    fn applicable(&self, points: &MeasuredPoints) -> bool;

    /// Run reconstruction. Caller should call `applicable` first.
    fn reconstruct(&self, points: &MeasuredPoints) -> Result<ReconstructedSurface, CoreError>;

    /// Human-readable identifier for diagnostics.
    fn name(&self) -> &'static str;
}

/// Pick the most accurate applicable reconstructor and run it.
/// Order: direct_link → radial_basis → boundary_interp → nominal.
pub fn auto_reconstruct(points: &MeasuredPoints) -> Result<ReconstructedSurface, CoreError> {
    // Order: direct_link → radial_basis → boundary_interp → nominal.
    // Rationale: radial_basis uses every STRICTLY interior anchor as a
    // constraint (exact anchor reproduction), while boundary_interp only uses
    // top+bottom rows. When a strictly interior anchor exists, prefer radial
    // so it isn't silently dropped. Edge-only captures (top+bottom rows, any
    // perimeter anchors) leave radial not-applicable (FIX-11: edge anchors no
    // longer count as "interior", which used to shadow boundary_interp into
    // production-unreachable), so boundary_interp genuinely wins there.
    let strategies: Vec<Box<dyn Reconstructor>> = vec![
        Box::new(direct::DirectLinkReconstructor),
        Box::new(radial_basis::RadialBasisReconstructor),
        Box::new(boundary_interp::BoundaryInterpReconstructor),
        Box::new(nominal::NominalReconstructor),
    ];

    for s in &strategies {
        if s.applicable(points) {
            return s.reconstruct(points);
        }
    }

    Err(CoreError::Reconstruction(
        "no applicable reconstructor for this point set".into(),
    ))
}
