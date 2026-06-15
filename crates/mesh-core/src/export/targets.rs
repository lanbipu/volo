use std::path::Path;

use crate::error::CoreError;
use crate::export::build::surface_to_mesh_output;
use crate::export::obj::write_obj;
use crate::shape::CabinetArray;
use crate::surface::{ReconstructedSurface, TargetSoftware};

/// Spec §3.3: high-level export API.
///
/// Each target encapsulates the full pipeline (build → write) so
/// callers don't need to construct `MeshOutput` themselves.
pub trait OutputTarget {
    /// Which target software this implementation produces output for.
    fn software(&self) -> TargetSoftware;

    /// Run the full pipeline: build mesh, then write OBJ to `path`.
    fn export(
        &self,
        surface: &ReconstructedSurface,
        cabinet_array: &CabinetArray,
        path: &Path,
    ) -> Result<(), CoreError>;
}

/// Disguise: right-handed, +Y up, meters. Hard cap at 200k vertices.
pub struct DisguiseTarget {
    pub weld_tolerance_m: f64,
}

impl Default for DisguiseTarget {
    fn default() -> Self {
        Self {
            weld_tolerance_m: 0.001,
        } // 1mm
    }
}

impl OutputTarget for DisguiseTarget {
    fn software(&self) -> TargetSoftware {
        TargetSoftware::Disguise
    }

    fn export(
        &self,
        surface: &ReconstructedSurface,
        cabinet_array: &CabinetArray,
        path: &Path,
    ) -> Result<(), CoreError> {
        let mesh = surface_to_mesh_output(
            surface,
            cabinet_array,
            TargetSoftware::Disguise,
            self.weld_tolerance_m,
        )?;
        write_obj(&mesh, path)
    }
}

/// Unreal nDisplay: left-handed, +Z up, centimeters.
pub struct UnrealTarget {
    pub weld_tolerance_m: f64,
}

impl Default for UnrealTarget {
    fn default() -> Self {
        Self {
            weld_tolerance_m: 0.001,
        } // 1mm in model frame; weld runs before unit conversion
    }
}

impl OutputTarget for UnrealTarget {
    fn software(&self) -> TargetSoftware {
        TargetSoftware::Unreal
    }

    fn export(
        &self,
        surface: &ReconstructedSurface,
        cabinet_array: &CabinetArray,
        path: &Path,
    ) -> Result<(), CoreError> {
        let mesh = surface_to_mesh_output(
            surface,
            cabinet_array,
            TargetSoftware::Unreal,
            self.weld_tolerance_m,
        )?;
        write_obj(&mesh, path)
    }
}

/// Neutral: raw model frame (right-handed, +Z up, meters). Debug / inspection.
pub struct NeutralTarget {
    pub weld_tolerance_m: f64,
}

impl Default for NeutralTarget {
    fn default() -> Self {
        Self {
            weld_tolerance_m: 0.001,
        }
    }
}

impl OutputTarget for NeutralTarget {
    fn software(&self) -> TargetSoftware {
        TargetSoftware::Neutral
    }

    fn export(
        &self,
        surface: &ReconstructedSurface,
        cabinet_array: &CabinetArray,
        path: &Path,
    ) -> Result<(), CoreError> {
        let mesh = surface_to_mesh_output(
            surface,
            cabinet_array,
            TargetSoftware::Neutral,
            self.weld_tolerance_m,
        )?;
        write_obj(&mesh, path)
    }
}
