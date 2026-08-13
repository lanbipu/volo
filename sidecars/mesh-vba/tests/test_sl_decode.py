import cv2
import numpy as np
import pytest
from lmt_vba_sidecar.sl_decode import load_frames, segment_code_region, index_plateaus


def _white(h=120, w=160):
    return np.full((h, w), 255, np.uint8)


def _g(v, h=120, w=160):
    return np.full((h, w), v, np.uint8)


def test_segment_excludes_sentinels():
    frames = [_white(), _g(10), _g(200), _g(10), _white()]
    assert segment_code_region(frames, sentinel_threshold=0.85) == (1, 4)


def test_segment_skips_full_held_sentinel_runs():
    # recorded/held video: each logical frame spans many camera frames, so the
    # white sentinels are CONTIGUOUS RUNS. Must skip both full runs, not just the
    # first/last bright frame (else index_plateaus sees extra white plateaus).
    frames = [_white(), _white(), _g(10), _g(200), _g(10), _white(), _white()]
    assert segment_code_region(frames, sentinel_threshold=0.85) == (2, 5)


def test_index_plateaus_counts_anchor_plus_code():
    # anchor + 1 code frame, captured 3x each
    region = [_g(180), _g(180), _g(180), _g(40), _g(40), _g(40)]
    reps = index_plateaus(region, expected=2)   # expected = total_bits + 1
    assert len(reps) == 2


def test_index_plateaus_raises_on_mismatch():
    with pytest.raises(ValueError):
        index_plateaus([_g(10), _g(200)], expected=5)


from lmt_vba_sidecar.sl_decode import derive_screen_roi


def test_derive_screen_roi_finds_blinking_rect_ignoring_static_bright_bg():
    # Static bright textured background (range==0) + a blinking rect in the
    # middle (range high). ROI must be the rect, not the whole frame.
    rng = np.random.default_rng(0)
    bg = rng.integers(180, 256, size=(120, 160), dtype=np.uint8)  # bright, static
    frames = []
    for k in range(8):
        f = bg.copy()
        if k % 2 == 0:                       # rect blinks on even frames
            f[40:90, 50:130] = 255
        else:
            f[40:90, 50:130] = 20
        frames.append(f)
    x, y, w, h = derive_screen_roi(frames)
    assert 45 <= x <= 55 and 35 <= y <= 45      # near rect top-left (50,40)
    assert 70 <= w <= 90 and 45 <= h <= 60      # near rect 80x50
    assert (x, y, w, h) != (0, 0, 160, 120)     # not the whole frame


def test_derive_screen_roi_rejects_only_thin_offscreen_motion():
    # Only a thin, non-solid moving streak (an off-screen person/car) and no
    # screen activity -> no solid rect -> raise (caller maps to detection_failed).
    frames = []
    for k in range(8):
        f = np.full((120, 160), 200, np.uint8)
        f[10:14, (10 + k * 8):(14 + k * 8)] = 255   # thin sliding streak
        frames.append(f)
    with pytest.raises(ValueError):
        derive_screen_roi(frames)


def test_segment_uses_roi_mean_not_whole_frame():
    # Whole-frame mean is always bright (lit background), so a global mean would
    # never see the sentinel. Inside the ROI the sentinel run is the only bright
    # thing -> segmentation must use the ROI crop.
    def frame(roi_val):
        f = np.full((120, 160), 240, np.uint8)   # bright everywhere (background)
        f[40:90, 50:130] = roi_val               # ROI content
        return f
    roi = (50, 40, 80, 50)
    frames = [frame(255), frame(10), frame(200), frame(10), frame(255)]
    assert segment_code_region(frames, sentinel_threshold=0.85, roi=roi) == (1, 4)


def test_index_plateaus_changed_pixels_counted_in_roi_only():
    # Off-ROI churn must not create phantom plateau boundaries: only ROI changes
    # split the region. anchor + 1 code frame, held 3x each, with off-ROI noise.
    rng = np.random.default_rng(1)
    def frame(roi_val):
        f = rng.integers(0, 256, size=(120, 160), dtype=np.uint8)  # off-ROI noise
        f[40:90, 50:130] = roi_val
        return f
    roi = (50, 40, 80, 50)
    region = [frame(180), frame(180), frame(180), frame(40), frame(40), frame(40)]
    reps = index_plateaus(region, expected=2, roi=roi)
    assert len(reps) == 2


import json
from lmt_vba_sidecar.ipc import GenerateStructuredLightInput, DecodeStructuredLightInput
from lmt_vba_sidecar.structured_light import run_generate_structured_light
from lmt_vba_sidecar.sl_decode import run_decode_structured_light


def _gen(tmp_path):
    cmd = GenerateStructuredLightInput.model_validate({
        "command": "generate_structured_light", "version": 1,
        "project": {"screen_id": "MAIN",
                    "cabinet_array": {"cols": 1, "rows": 1, "absent_cells": [],
                                      "cabinet_size_mm": [500, 500]}},
        "output_dir": str(tmp_path / "sl"), "screen_resolution": [960, 540],
        "dot_spacing_px": 160, "margin_px": 80,
    })
    assert run_generate_structured_light(cmd) == 0
    return tmp_path / "sl"


def test_roundtrip_recovers_every_dot_including_id0(tmp_path):
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "frames"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    by_id = {p["id"]: p for p in corr["points"]}
    assert len(corr["points"]) == len(meta["dots"])
    assert 0 in by_id                                  # id=0 must be recovered
    for d in meta["dots"]:
        p = by_id[d["id"]]
        assert abs(p["x"] - d["u"]) < 1.0 and abs(p["y"] - d["v"]) < 1.0


def test_roundtrip_from_held_video_sequence_mp4(tmp_path):
    # The advertised video path: decode the generated sequence.mp4 (each logical
    # frame held hold_repeat times -> sentinels span contiguous runs). Exercises
    # the held-sentinel segmentation + plateau indexing through a real (lossy
    # mp4v) codec end to end.
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "sequence.mp4"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    by_id = {p["id"]: p for p in corr["points"]}
    assert len(corr["points"]) == len(meta["dots"])
    assert 0 in by_id                                  # id=0 recovered from the anchor


def test_correspondence_has_provenance(tmp_path):
    sl = _gen(tmp_path)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "frames"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    run_decode_structured_light(dec)
    corr = json.loads((tmp_path / "corr.json").read_text())
    import hashlib
    expect_hash = hashlib.sha256((sl / "sl_meta.json").read_bytes()).hexdigest()
    assert corr["screen_id"] == "MAIN"
    assert corr["sl_meta_sha256"] == expect_hash
    assert corr["camera_image_size"] == [960, 540]


from lmt_vba_sidecar.sl_decode import _seed_dots, _read_bits_relative


def test_seed_dots_otsu_finds_dots_in_bright_roi():
    # Anchor with two lit dots over a bright (200) ROI background; global-128
    # would flood, Otsu must isolate the two dots.
    anchor = np.full((120, 160), 200, np.uint8)
    cv2.circle(anchor, (70, 60), 6, 255, -1)
    cv2.circle(anchor, (110, 60), 6, 255, -1)
    roi = (50, 40, 80, 50)
    seeds = _seed_dots(anchor, roi=roi, dot_radius_px=6)
    assert len(seeds) == 2
    xs = sorted(round(x) for (x, _y) in seeds)
    assert abs(xs[0] - 70) <= 2 and abs(xs[1] - 110) <= 2


def test_seed_dots_filters_oversized_blob():
    anchor = np.full((120, 160), 30, np.uint8)
    cv2.circle(anchor, (70, 60), 6, 255, -1)        # a real dot
    anchor[55:90, 95:130] = 255                     # a big non-dot block
    roi = (50, 40, 80, 50)
    seeds = _seed_dots(anchor, roi=roi, dot_radius_px=6)
    assert len(seeds) == 1


def test_read_bits_relative_uses_own_min_max_not_global_128():
    # A DIM dot: lit ~90, off ~20 (both below the global-128 brightness threshold).
    # Relative reading (own min/max) must still read [1, 0].
    lit = np.full((120, 160), 20, np.uint8)
    cv2.circle(lit, (70, 60), 6, 90, -1)
    off = np.full((120, 160), 20, np.uint8)
    code_frames = [lit, off]
    bits = _read_bits_relative(code_frames, 70.0, 60.0, anchor=lit)
    assert bits == [1, 0]


def test_read_bits_relative_all_one_codeword_not_silent_id0():
    # data_bits=5 (odd) -> max id 31 is the ALL-ONES codeword: lit in EVERY code
    # frame. A constant-LIT dot must read all-ones (its true id), NOT silently
    # collapse to all-zeros (a duplicate id=0 + lost correspondence). Regression
    # for the Codex P2 finding.
    from lmt_vba_sidecar.sl_codec import decode_bits, encode_id
    anchor = np.full((120, 160), 20, np.uint8)
    cv2.circle(anchor, (70, 60), 6, 200, -1)             # dot lit in the all-on anchor
    lit = anchor.copy()                                   # ... and lit in every code frame
    code_frames = [lit] * 6                               # total_bits = data_bits(5)+1
    bits = _read_bits_relative(code_frames, 70.0, 60.0, anchor=anchor)
    assert bits == [1, 1, 1, 1, 1, 1]
    assert encode_id(31, 5) == [1, 1, 1, 1, 1, 1]         # sanity: 31 IS the all-ones codeword
    assert decode_bits(bits, 5) == 31                     # true max id, NOT 0
    # A constant-DARK dot (id=0, off in every code frame) still reads all zeros.
    dark = np.full((120, 160), 20, np.uint8)              # no lit dot in the code frames
    assert _read_bits_relative([dark] * 6, 70.0, 60.0, anchor=anchor) == [0, 0, 0, 0, 0, 0]
    assert decode_bits([0, 0, 0, 0, 0, 0], 5) == 0


def test_decode_gray_bg_regression(tmp_path):
    # S1: the existing gray-background synthetic material decodes 100% through
    # the new three-pass frontend (no legacy flag).
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "frames"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    assert len(corr["points"]) == len(meta["dots"])
    assert 0 in {p["id"] for p in corr["points"]}          # id=0 recovered


def _pad_onto_canvas(frames_dir, surround, pad, tmp_path, out_name, mover=False):
    """Paste each generated screen frame into the centre of `surround` (an
    (H+2*pad, W+2*pad) canvas), leaving a genuine off-screen border. Off-screen
    detail therefore lives OUTSIDE the screen ROI the pipeline derives — the
    only construction in which "ignore off-screen X" can be meaningfully tested
    (the generator's frames ARE the screen, edge to edge). Returns the new dir.

    With `mover=True`, also paints a sliding bright block in the top border band
    so the off-screen mover is clearly outside the screen rectangle."""
    import pathlib
    src = sorted(pathlib.Path(frames_dir).glob("frame_*.png"))
    h, w = cv2.imread(str(src[0]), cv2.IMREAD_GRAYSCALE).shape[:2]
    dst = tmp_path / out_name
    dst.mkdir()
    for i, f in enumerate(src):
        fr = cv2.imread(str(f), cv2.IMREAD_GRAYSCALE)
        canvas = surround.copy()
        canvas[pad:pad + h, pad:pad + w] = fr
        if mover:
            x0 = (i * 40) % w
            canvas[5:35, x0:x0 + 24] = 255            # off-screen sliding block
        cv2.imwrite(str(dst / f"frame_{i:04d}.png"), canvas)
    return dst


def test_decode_bright_textured_bg(tmp_path):
    # S2: a bright, high-frequency, STATIC textured background surrounding the
    # screen. The screen fills the generator's frames edge to edge, so the
    # background must live in a padded border to be genuinely off-screen. It is
    # static (zero temporal activity) so Pass-1 never admits it into the ROI.
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    h, w = meta["screen_resolution"][1], meta["screen_resolution"][0]
    pad = 60
    rng = np.random.default_rng(7)
    surround = (rng.integers(0, 2, size=(h + 2 * pad, w + 2 * pad),
                             dtype=np.uint8) * 255)        # bright textured noise
    frames = _pad_onto_canvas(sl / "frames", surround, pad, tmp_path, "bright")
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(frames), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    assert len(corr["points"]) >= int(0.99 * len(meta["dots"]))
    assert corr["screen_roi"] is not None                  # provenance stamped


def test_decode_bright_textured_bg_fails_with_naive(tmp_path):
    # Control: the OLD global-128 frontend floods on the same bright textured
    # background and produces garbage blobs (far more than the true dot count),
    # whereas the three-pass pipeline (test above) decodes it cleanly.
    from lmt_vba_sidecar.sl_decode import load_frames
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    h, w = meta["screen_resolution"][1], meta["screen_resolution"][0]
    pad = 60
    rng = np.random.default_rng(7)
    surround = (rng.integers(0, 2, size=(h + 2 * pad, w + 2 * pad),
                             dtype=np.uint8) * 255)
    frames_dir = _pad_onto_canvas(sl / "frames", surround, pad, tmp_path, "bright")
    anchor = load_frames(str(frames_dir))[1]               # all-on anchor frame
    _t, bw = cv2.threshold(anchor, 128, 255, cv2.THRESH_BINARY)  # the naive path
    n, _l, _s, _c = cv2.connectedComponentsWithStats(bw, connectivity=8)
    assert (n - 1) > 2 * len(meta["dots"])                 # naive floods


def test_decode_moving_object_outside_roi(tmp_path):
    # S3: a bright moving block OUTSIDE the screen ROI must not change the result.
    # The screen is padded into a larger canvas so the mover sits in the border,
    # genuinely outside the auto-derived screen rectangle.
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    h, w = meta["screen_resolution"][1], meta["screen_resolution"][0]
    pad = 60
    surround = np.full((h + 2 * pad, w + 2 * pad), 40, np.uint8)   # dark border
    dst = _pad_onto_canvas(sl / "frames", surround, pad, tmp_path, "mover", mover=True)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(dst), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    assert len(corr["points"]) == len(meta["dots"])        # mover ignored


def test_decode_dim_dots_below_external_bg(tmp_path):
    # S4: dim/oblique-lit dots whose ABSOLUTE brightness sits BELOW a bright
    # external wall still decode — proving detection is change/ROI-based, not
    # global-brightness-based. Physical LED model: inter-dot screen background
    # is black (LED off); lit dots read a low DIM value; a bright wall surrounds
    # the screen in a padded border (genuinely OFF-screen, outside the ROI).
    # The dots' absolute level (DIM=60) is far below the wall (WALL=200), yet
    # all decode because the ROI excludes the wall and bit reading is relative.
    DIM, WALL, pad = 60, 200, 60
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    h, w = meta["screen_resolution"][1], meta["screen_resolution"][0]
    src = sorted((sl / "frames").glob("frame_*.png"))
    dst = tmp_path / "dim"; dst.mkdir()
    for i, f in enumerate(src):
        fr = cv2.imread(str(f), cv2.IMREAD_GRAYSCALE)
        # within-screen: black where the LED is off, DIM where the generator lit it
        screen = np.where(fr > 5, DIM, 0).astype(np.uint8)
        canvas = np.full((h + 2 * pad, w + 2 * pad), WALL, np.uint8)   # bright wall
        canvas[pad:pad + h, pad:pad + w] = screen
        cv2.imwrite(str(dst / f"frame_{i:04d}.png"), canvas)
    # The all-white sentinel frame reads as a uniform DIM screen (~60), so the
    # default 0.85 sentinel threshold (~217) would miss it — lower it below
    # DIM/255 (~0.235). Sparse code frames stay near 0, so 0.18 isolates the
    # sentinel cleanly. Mirrors the GUI guidance for dim / non-black captures.
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(dst), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json"),
        "sentinel_threshold": 0.18})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    assert len(corr["points"]) == len(meta["dots"])        # all dim dots decoded
    # ROI is the padded screen region — the bright wall border is excluded.
    rx, ry, rw, rh = corr["screen_roi"]
    assert rx >= pad - 2 and ry >= pad - 2
    assert rx + rw <= pad + w + 2 and ry + rh <= pad + h + 2


def test_decode_finds_id0(tmp_path):
    sl = _gen(tmp_path)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "frames"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    assert 0 in {p["id"] for p in corr["points"]}


def test_roi_auto_vs_manual(tmp_path):
    # Auto-derived ROI and a generous manual ROI must decode the same dot set.
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    h, w = meta["screen_resolution"][1], meta["screen_resolution"][0]
    auto = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "frames"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "auto.json")})
    assert run_decode_structured_light(auto) == 0
    manual = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "frames"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "manual.json"),
        "screen_roi": [0, 0, w, h]})
    assert run_decode_structured_light(manual) == 0
    a = {p["id"] for p in json.loads((tmp_path / "auto.json").read_text())["points"]}
    m = {p["id"] for p in json.loads((tmp_path / "manual.json").read_text())["points"]}
    assert a == m
    assert json.loads((tmp_path / "manual.json").read_text())["screen_roi"] == [0, 0, w, h]


def test_decode_emit_debug_image_writes_png(tmp_path):
    sl = _gen(tmp_path)
    out = tmp_path / "corr.json"
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "frames"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(out), "emit_debug_image": True})
    assert run_decode_structured_light(dec) == 0
    dbg = tmp_path / "corr.json.debug.png"
    assert dbg.is_file() and dbg.stat().st_size > 0


def test_roundtrip_from_dpx_frame_dir(tmp_path):
    # disguise feed export = a directory of 10-bit .dpx frames. Decoding it must
    # match the PNG-directory happy path (every dot, including id=0, recovered).
    from _dpx_fixtures import convert_dir_to_dpx

    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    dpx_dir = sl / "frames_dpx"
    n = convert_dir_to_dpx(sl / "frames", dpx_dir)
    assert n > 0

    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(dpx_dir), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    by_id = {p["id"]: p for p in corr["points"]}
    assert len(corr["points"]) == len(meta["dots"])
    assert 0 in by_id


def test_decode_bad_dpx_reports_decode_failed(tmp_path, capsys):
    # An unsupported/garbage .dpx must surface as a clean fatal decode_failed
    # envelope, not an internal_error traceback.
    from lmt_vba_sidecar.ipc import GenerateStructuredLightInput  # noqa: F401 (sl already generated below)

    sl = _gen(tmp_path)
    bad_dir = tmp_path / "bad_dpx"
    bad_dir.mkdir()
    (bad_dir / "frame0000.dpx").write_bytes(b"NOTADPX" + b"\x00" * 2000)

    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(bad_dir), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 1
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    err = [e for e in events if e.get("event") == "error"][-1]
    assert err["code"] == "decode_failed"
    assert err["fatal"] is True


def test_decode_missing_dpx_file_reports_decode_failed(tmp_path, capsys):
    # Regression guard for the dispatch we add in Step 4: a missing SINGLE .dpx
    # path is routed to read_dpx_gray8, whose read_bytes() raises FileNotFoundError
    # (an OSError, NOT a ValueError). The load wrapper must map it to a clean fatal
    # decode_failed, never let it escape to __main__.py's internal_error+traceback.
    sl = _gen(tmp_path)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(tmp_path / "nope.dpx"),
        "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 1
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.strip()]
    err = [e for e in events if e.get("event") == "error"][-1]
    assert err["code"] == "decode_failed"
    assert err["fatal"] is True


# ---------- FIX-30: frame directory ingest hygiene ----------

def test_load_frames_corrupt_image_raises(tmp_path):
    """FIX-30: corrupt PNG in a frame directory must raise ValueError with the filename."""
    d = tmp_path / "frames"
    d.mkdir()
    (d / "frame0000.png").write_bytes(b"NOTAPNG")
    with pytest.raises(ValueError, match="unreadable frame.*frame0000.png"):
        load_frames(str(d))


def test_load_frames_mixed_extensions_raises(tmp_path):
    """FIX-30: a directory with both .png and .dpx files must be rejected."""
    d = tmp_path / "frames"
    d.mkdir()
    cv2.imwrite(str(d / "frame0000.png"), _white())
    (d / "frame0001.dpx").write_bytes(b"\x00" * 100)
    with pytest.raises(ValueError, match="mixed extensions"):
        load_frames(str(d))


def test_load_frames_skips_debug_files(tmp_path):
    """FIX-30: *.debug.png self-produced artifacts must not appear as sequence frames."""
    d = tmp_path / "frames"
    d.mkdir()
    cv2.imwrite(str(d / "frame0000.png"), _white())
    cv2.imwrite(str(d / "frame0001.png"), _white())
    cv2.imwrite(str(d / "activity.debug.png"), _white())
    frames = load_frames(str(d))
    assert len(frames) == 2


# ---- corr schema v2 per-dot quality (decoder confidence layer) ----

import hashlib as _hashlib

import cv2 as _cv2
import numpy as _np

from lmt_vba_sidecar.sl_codec import encode_id as _encode_id


def test_v2_schema_quality_fields_on_frames_dir(tmp_path):
    """Frames-dir (1:1) path: schema v2 with a quality summary; sigma stays
    None (single anchor frame — unknown, not zero), confidence in (0, 1]."""
    sl = _gen(tmp_path)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "frames"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    assert corr["schema_version"] == 2
    q = corr["quality"]
    assert q["n_decoded"] == len(corr["points"])
    assert q["sigma_source"] is None and q["sigma_median_px"] is None
    assert all(v == 0 for v in q["rejected"].values())
    for p in corr["points"]:
        assert p["sigma_px"] is None
        assert 0.0 < p["confidence"] <= 1.0
        assert 0.0 <= p["plateau_margin"] <= 1.0


def test_video_path_measures_anchor_plateau_sigma(tmp_path):
    """Held-video path: the anchor plateau spans many camera frames, so the
    centroid temporal jitter IS measured — sigma_px present and small on a
    clean synthetic sequence."""
    sl = _gen(tmp_path)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(sl / "sequence.mp4"), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    q = corr["quality"]
    assert q["sigma_source"] == "anchor_plateau_temporal"
    assert q["sigma_median_px"] is not None and q["sigma_median_px"] < 0.5
    assert all(p["sigma_px"] is not None and p["sigma_px"] < 1.0 for p in corr["points"])


def _write_custom_sequence(tmp_path, *, jitter_dot=False, impostor_on=True):
    """Hand-built 200x200 sequence: 5 listed dots + one IMPOSTOR blinking dot
    1's codeword. data_bits=3, total_bits=4. With jitter_dot, dot id=2 wanders
    ±2px across the (held) anchor plateau copies."""
    db, tb, r = 3, 4, 8
    listed = [(1, 40, 40), (2, 150, 40), (3, 40, 150), (4, 150, 150), (5, 100, 100)]
    impostor = (60, 100)
    sl_meta = {
        "schema_version": 1, "screen_id": "T", "screen_resolution": [200, 200],
        "dot_radius_px": r,
        "code": {"data_bits": db, "total_bits": tb, "parity": "even", "encoding": "binary"},
        "sequence": {"sentinel": "white_full", "anchor": "all_on",
                     "n_code_frames": tb, "hold_ms": 500, "fps": 30},
        "cabinets": [], "dots": [{"id": i, "u": u, "v": v, "cabinet": [0, 0]}
                                 for (i, u, v) in listed],
    }
    meta_path = tmp_path / "sl_meta.json"
    meta_path.write_text(json.dumps(sl_meta))

    code = {i: _encode_id(i, db) for (i, _u, _v) in listed}

    def _frame(lit, anchor_shift=0):
        img = _np.zeros((200, 200), dtype=_np.uint8)
        for (i, u, v) in listed:
            if i in lit:
                du = anchor_shift if (jitter_dot and i == 2) else 0
                _cv2.circle(img, (u + du, v), r, 255, -1)
        if "imp" in lit:
            _cv2.circle(img, impostor, r, 255, -1)
        return img

    white = _np.full((200, 200), 255, dtype=_np.uint8)
    all_ids = {i for (i, _u, _v) in listed} | ({"imp"} if impostor_on else set())
    hold = 5
    logical = [("white", None)]
    logical.append(("anchor", all_ids))
    for b in range(tb):
        lit = {i for (i, _u, _v) in listed if code[i][b]}
        if impostor_on and code[1][b]:
            lit = lit | {"imp"}          # impostor mimics dot 1's codeword
        logical.append(("code", lit))
    logical.append(("white", None))

    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    n = 0
    shifts = [0, 2, -2, 2, 0]            # anchor-plateau wander for the jitter dot
    for kind, lit in logical:
        for k in range(hold):
            if kind == "white":
                img = white
            elif kind == "anchor":
                img = _frame(lit, anchor_shift=shifts[k])
            else:
                img = _frame(lit)
            _cv2.imwrite(str(frames_dir / f"{n:06d}.png"), img)
            n += 1
    return frames_dir, meta_path


def test_duplicate_decoded_ids_all_dropped(tmp_path):
    """Two blobs decoding to one id = unresolved identity ambiguity: BOTH are
    rejected (keeping either risks a wrong world↔pixel pairing)."""
    frames_dir, meta_path = _write_custom_sequence(tmp_path)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(frames_dir), "sl_meta_path": str(meta_path),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    ids = {p["id"] for p in corr["points"]}
    assert 1 not in ids                     # both copies of id 1 dropped
    assert ids == {2, 3, 4, 5}
    assert corr["quality"]["rejected"]["duplicate_id"] == 2


def test_jittering_dot_hard_rejected(tmp_path):
    """A dot whose anchor-plateau centroid wanders ~2px must be rejected on
    the temporal-jitter ceiling; steady dots keep small sigma."""
    frames_dir, meta_path = _write_custom_sequence(tmp_path, jitter_dot=True, impostor_on=False)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(frames_dir), "sl_meta_path": str(meta_path),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    ids = {p["id"] for p in corr["points"]}
    assert ids == {1, 3, 4, 5}              # the wanderer (id 2) is out
    assert corr["quality"]["rejected"]["jitter"] >= 1
    for p in corr["points"]:
        assert p["sigma_px"] is not None and p["sigma_px"] < 1.0


# ---- §12.1 rejection/robustness matrix gap-fill ----

def _renumber_into(dst_dir, frame_paths):
    dst_dir.mkdir()
    for n, src in enumerate(frame_paths):
        (dst_dir / f"{n:06d}.png").write_bytes(src.read_bytes())


def test_looped_capture_uses_first_complete_cycle(tmp_path):
    """A looped playback recording ([sentinel, cycle, sentinel, cycle, ...])
    must decode from the FIRST complete inter-sentinel cycle, not choke on the
    doubled loop-boundary whites or see N× plateaus."""
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    seq = sorted((sl / "frames").iterdir())
    looped = tmp_path / "looped"
    _renumber_into(looped, seq + seq)          # two playthroughs back to back
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(looped), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    assert len(corr["points"]) == len(meta["dots"])


def test_missed_first_sentinel_recovers_from_next_cycle(tmp_path):
    """A recording that starts mid-cycle (opening sentinel missed) still
    decodes as long as one complete inter-sentinel cycle exists later."""
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    seq = sorted((sl / "frames").iterdir())
    clipped = tmp_path / "clipped"
    # Start at the anchor (missed the opening white), then a full second pass.
    _renumber_into(clipped, seq[1:] + seq)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(clipped), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    assert len(corr["points"]) == len(meta["dots"])


def test_mixed_bit_depth_frame_set_rejected():
    """8-bit and 10-bit frames in one set would silently skew every absolute
    threshold — frames_full_scale must refuse, not guess. (At the CLI surface
    this cannot even arise: mixed extensions are rejected before reading, PNG
    loads normalize to 8-bit, and the DPX dir path is uniformly 10-bit — this
    guards the internal seam those invariants rest on.)"""
    from lmt_vba_sidecar.sl_decode import frames_full_scale
    import pytest as _pytest
    eight = _np.zeros((4, 4), dtype=_np.uint8)
    ten = _np.zeros((4, 4), dtype=_np.uint16)
    assert frames_full_scale([eight, eight]) == 255.0
    assert frames_full_scale([ten, ten]) == 1023.0
    with _pytest.raises(ValueError, match="mixed frame bit depths"):
        frames_full_scale([eight, ten])


def test_partial_occlusion_loses_only_covered_dots(tmp_path):
    """A static occluder over part of the screen must cost exactly the covered
    dots — the rest decode normally (no global failure)."""
    sl = _gen(tmp_path)
    meta = json.loads((sl / "sl_meta.json").read_text())
    occluded = tmp_path / "occluded"
    occluded.mkdir()
    # Cover the top-left dot (min u,v) with a black rectangle in EVERY frame.
    target = min(meta["dots"], key=lambda d: (d["v"], d["u"]))
    u, v = int(target["u"]), int(target["v"])
    for src in sorted((sl / "frames").iterdir()):
        img = _cv2.imread(str(src), _cv2.IMREAD_GRAYSCALE)
        _cv2.rectangle(img, (u - 30, v - 30), (u + 30, v + 30), 0, -1)
        _cv2.imwrite(str(occluded / src.name), img)
    dec = DecodeStructuredLightInput.model_validate({
        "command": "decode_structured_light", "version": 1,
        "input_path": str(occluded), "sl_meta_path": str(sl / "sl_meta.json"),
        "output_path": str(tmp_path / "corr.json")})
    assert run_decode_structured_light(dec) == 0
    corr = json.loads((tmp_path / "corr.json").read_text())
    ids = {p["id"] for p in corr["points"]}
    assert target["id"] not in ids
    assert len(ids) == len(meta["dots"]) - 1


def test_sentinel_found_on_oblique_partial_fill_roi():
    """Oblique screen: the ROI (projected quad's bbox) is only ~55% screen, so
    the white sentinel's ROI mean misses the absolute 0.85 cut — the relative
    fallback (vs the clip's brightest frame) must still segment the cycle."""
    def frame(mean_level):
        img = _np.zeros((100, 100), dtype=_np.uint8)
        # left 55% of the ROI is "screen" at full white scaled to the level
        img[:, :55] = int(round(mean_level / 0.55))
        return img
    sentinel = frame(140)                  # ROI mean ≈ 0.55*255 ≈ 140 < 0.85*255
    dark = _np.zeros((100, 100), dtype=_np.uint8)
    dark[40:44, 20:24] = 255               # sparse "dots"
    frames = [sentinel, dark, dark, sentinel]
    s, e = segment_code_region(frames, sentinel_threshold=0.85)
    assert (s, e) == (1, 3)
