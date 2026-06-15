#!/bin/sh
# Mock calibrate sidecar: write an intrinsics JSON to the file named by
# $MOCK_INTRINSICS_OUT (the test points CalibrateArgs.output_path at the same
# file), then emit a vestigial ResultData (iterations hard-coded to 0, exactly
# like the real calibrate.py) and exit 0. Proves the adapter reads frames_used
# from the JSON file, NOT from ba_stats.iterations.
read -r STDIN_PAYLOAD
if [ -n "$MOCK_INTRINSICS_OUT" ]; then
    cat > "$MOCK_INTRINSICS_OUT" <<'JSON'
{"K":[[1000,0,960],[0,1000,540],[0,0,1]],"dist_coeffs":[0,0,0,0,0],"image_size":[1920,1080],"reproj_error_px":0.42,"frames_used":12}
JSON
fi
echo '{"event":"result","data":{"measured_points":[],"ba_stats":{"rms_reprojection_px":0.42,"iterations":0,"converged":true},"frame_strategy_used":"nominal_anchoring","procrustes_align_rms_m":0.0}}'
exit 0
