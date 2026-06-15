#!/bin/sh
# Mock sidecar: read stdin, emit a few NDJSON events, exit 0.
read -r STDIN_PAYLOAD
cat <<'EOF'
{"event":"progress","stage":"load","percent":0.0}
{"event":"progress","stage":"detect_charuco","percent":0.5}
{"event":"result","data":{"measured_points":[],"ba_stats":{"rms_reprojection_px":0.4,"iterations":7,"converged":true},"frame_strategy_used":"nominal_anchoring","procrustes_align_rms_m":0.003}}
EOF
exit 0
