# tracksim

Camera tracking protocol simulator emitting FreeD and OpenTrackIO data over UDP / serial transports.

## Status

Early scaffolding. Implements `contract_version 1.0` (the stable CLI / envelope / protocol contract; see `SCHEMA_VERSION` and `CONTRACT_VERSION` in `tracksim.envelope`).

## Install

```bash
pip install -e ".[dev]"
```

## Usage

```bash
tracksim --help
python -m tracksim --help
```

### FBX / track playback

Play a recorded camera-animation track and emit it as FreeD / OpenTrackIO:

```bash
# Play a structured track directly (tracksim track.json, or a Disguise dense CSV)
tracksim run --source track shot.json --protocol freed

# Play an FBX camera animation (converts via Blender under the hood, then plays)
tracksim run --source fbx shot.fbx --camera "cam 1"

# Or convert once to a reusable track.json (also via Blender)
tracksim convert shot.fbx --out shot.track.json
```

FBX parsing uses an installed **Blender** (headless subprocess; auto-detected, or set
`[fbx].blender_path`). tracksim itself has no Blender Python dependency, so `run --source track`
and the test suite need no Blender. Emission rate defaults to the track's authored frame rate
(`--rate` overrides). The Blender→canonical **position** mapping is verified; **rotation/focus**
mapping is best-effort and will be re-validated against Unreal-Engine-exported FBX.

### Controller zoom/focus (Xbox Elite paddles)

Drive a live camera from an Xbox controller and stream it:

```bash
tracksim run --source controller --protocol freed --config my.toml
```

The built-in default mapping (used when `[controller].mapping` is empty) binds:

| Control | Channel |
|---------|---------|
| Left stick | x / y translate |
| Right stick | pan / tilt |
| LT / RT | z down / up |
| LB / RB | roll |
| **Upper paddles P1 / P3** | **focal_length (zoom)** — P1 tele (+), P3 wide (−) |
| **Lower paddles P2 / P4** | **focus_distance (focus)** — P2 far (+), P4 near (−) |

Mapping is rate-based (hold to ramp). Values clamp to physical lens limits:
focal_length **12–300 mm**, focus_distance **0.1–100 m** (so the raw FreeD zoom/focus
floor at `12000` / `100`, not 0). Tune in `[controller].mapping`.

**Xbox Elite Series 2 — required paddle setup:** the paddles report as independent
buttons (`p1`–`p4`) **only when the controller is on its default button mapping**.
Press the controller's **Profile button until no LED bar is lit**; otherwise the
firmware mutes the dedicated paddle bits and a paddle press just fires the face button
it is assigned to (A/B/X/Y). On **macOS the Elite 2 works over Bluetooth only** (its USB
mode is the GIP protocol, which macOS does not enumerate). Verify the paddles toggle
`p1`–`p4` with `tracksim controllers monitor`.

### FreeD zoom/focus encoding

FreeD zoom/focus are 24-bit raw lens-encoder counts derived from the pose:
`zoom_raw = round(focal_length_mm × zoom_lsb_per_mm)`,
`focus_raw = round(focus_distance_m × focus_lsb_per_m)` (defaults `1000`, saturated to
u24; set an lsb to `0` to disable that field). Tune via `[freed].scaling`.

Receivers (Disguise, Unreal, …) treat these as **opaque encoder counts** and map them to
field-of-view through their own **lens calibration**: position/rotation track immediately,
but zoom/focus won't drive FOV until the receiver's lens is ranged/calibrated against the
encoder values. In Disguise, first confirm the camera's Tracking Source → Values zoom/focus
rows are enabled (a greyed-out row is received-but-toggled-off), then range the encoder /
build the lens poses.
