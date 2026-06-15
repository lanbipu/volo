# Changelog

All notable changes to this project are documented here. This project adheres to `contract_version 1.0`.

## [Unreleased]

### Added
- Initial project scaffolding (src layout, packaging metadata, package entrypoint).
- FBX camera-animation playback: `tracksim convert <in.fbx> --out track.json` and
  `tracksim run --source fbx|track` (operation `sim.convert`). FBX is parsed by an installed
  Blender headless subprocess (isolated in `infra/blender_fbx.py`; no Blender Python dependency
  in tracksim), producing a `tracksim.track/1` `track.json` that `TrackPoseSource` replays via
  the existing Simulator → FreeD/OpenTrackIO. Also reads Disguise dense CSV directly. Emission
  rate defaults to the track's authored frame rate. New `[fbx]` config section
  (`blender_path`/`default_camera`/`timeout_s`/`cache_dir`) and `FbxConversionError` (exit 13).
  Coordinate position mapping verified against a Disguise reference (<4mm); rotation/focus mapping
  is best-effort pending Unreal-Engine-FBX validation.
