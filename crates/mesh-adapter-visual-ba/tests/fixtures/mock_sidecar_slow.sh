#!/bin/sh
read -r STDIN_PAYLOAD
echo '{"event":"progress","stage":"detect_charuco","percent":0.1}'
sleep 30
echo '{"event":"result","data":{"measured_points":[],"ba_stats":{"rms_reprojection_px":0.5,"iterations":1,"converged":true},"frame_strategy_used":"nominal_anchoring","procrustes_align_rms_m":0.003}}'
