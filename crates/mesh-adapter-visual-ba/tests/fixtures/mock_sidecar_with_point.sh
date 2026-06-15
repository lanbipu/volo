#!/bin/sh
read -r STDIN_PAYLOAD
echo '{"event":"result","data":{"measured_points":[{"name":"MAIN_V000_R000","position":[0.25,0.25,0.0],"uncertainty":{"covariance":[[1e-6,0,0],[0,1e-6,0],[0,0,1e-6]]},"source":{"visual_ba":{"camera_count":4}}}],"ba_stats":{"rms_reprojection_px":0.3,"iterations":5,"converged":true},"frame_strategy_used":"nominal_anchoring","procrustes_align_rms_m":0.002}}'
exit 0
