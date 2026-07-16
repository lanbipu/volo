# vpcal Sim-to-Real Acceptance Protocol

## Purpose

This protocol gates promotion of calibration behaviour and QA thresholds from
synthetic closure to physical LED-stage use. Synthetic success is necessary,
but it does not certify camera timing, tracking transport, optics, processor
mapping, or surveyed geometry.

## Golden dataset capture

For each supported camera/tracker/backend combination, retain:

- raw normal/inverted frames and `frames.jsonl`;
- raw tracking records with arrival, monotonic, hardware, and protocol clocks;
- immutable screen/marker-map/lens files with SHA-256 fingerprints;
- exposure, shutter, frame rate, transfer function, zoom/focus/iris, and LED
  processor configuration;
- independently surveyed hand-eye and control-point measurements;
- operator notes for dropped frames, saturation, PWM artefacts, and re-takes.

Never replace raw captures. Derived sessions, observations, results, QA, and
exports must be reproducible into versioned sibling directories.

## Paired comparison

1. Reproduce each golden capture in the simulator with the same geometry,
   intrinsics, pose distribution, timing, and observation count.
2. Add one measured error source at a time: pixel noise, outliers, clock delay,
   dropped frames, lens-domain scaling, tracker scale, marker-map uncertainty,
   saturation, and rolling-shutter motion.
3. Compare synthetic and physical residual spectra, not only global RMS:
   per-pose RMS, radial/tangential signature, spatial heat map, tails, temporal
   autocorrelation, and cross-subset parameter drift.
4. Attribute material spectrum differences to a measured error source or keep
   the affected QA gate fail-closed.

## Acceptance gates

- The physical dataset passes input, mapping, FIZ-constancy, staticity, coverage,
  and cross-subset gates without overrides.
- `verify live` and offline overlay agree on residual direction and magnitude.
- Solved transforms agree with independent survey/hand-eye truth within the
  declared production tolerance.
- Ceres and scipy agree within the backend-consistency tolerance.
- Delay estimates do not hit a search boundary and repeat within 2 ms.
- QLE parameters that are retained remain stable across disjoint pose subsets;
  reverted parameters stay reverted.
- No threshold is relaxed from synthetic evidence alone. A change requires at
  least three representative physical datasets and no regression in the
  retained golden corpus.

## Hardware sign-off matrix

Record camera, lens/FIZ state, capture backend, tracking protocol, LED processor,
resolution/rate, dataset fingerprint, vpcal version, solver backend, QA result,
overlay result, survey delta, reviewer, and date. Unsupported combinations stay
marked `pending hardware`; they must not inherit another combination's sign-off.

## Regression policy

Run the full golden corpus for changes to projection, timing, detector,
observation weighting, solver loss/covariance, hand-eye, or export semantics.
Archive machine-readable result/QA diffs and require explicit review of every
new warning, confidence downgrade, threshold crossing, or backend fallback.
