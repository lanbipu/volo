#!/bin/sh
# Mock sidecar: capture the stdin payload to the file named by
# $MOCK_PAYLOAD_OUT (so a test can assert the wire contract), then emit a
# minimal valid reconstruct ResultData and exit 0.
PAYLOAD=$(cat)
if [ -n "$MOCK_PAYLOAD_OUT" ]; then
    printf '%s' "$PAYLOAD" > "$MOCK_PAYLOAD_OUT"
fi
echo '{"event":"result","data":{"measured_points":[],"ba_stats":{"rms_reprojection_px":0.3,"iterations":5,"converged":true},"frame_strategy_used":"nominal_anchoring","procrustes_align_rms_m":0.0}}'
exit 0
