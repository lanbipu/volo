# mesh-core

Shared library for the LED Mesh Toolkit. Defines:

- IR types (`MeasuredPoint`, `MeasuredPoints`, `ReconstructedSurface`, `MeshOutput`)
- 3-point coordinate frame (`CoordinateFrame`)
- Cabinet array and shape priors (`CabinetArray`, `ShapePrior`)
- 4 reconstruction strategies + auto-dispatch
- UV layout (one cell per cabinet)
- Coordinate-frame adapters for disguise / unreal / neutral targets
- Vertex welding (KD-tree) + grid triangulation
- Wavefront OBJ writer + `OutputTarget` trait

This crate's public API is **frozen** after M0.1 — both M1 and M2
sessions must consume it as-is. Breaking changes require a workspace-wide PR.
