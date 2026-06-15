#!/bin/sh
read -r STDIN_PAYLOAD
echo '{"event":"progress","stage":"load","percent":0.0}'
echo '{"event":"warning","code":"no_intrinsics_anchor","message":"auto intrinsics solved without an independent anchor","cabinet":null}'
echo '{"event":"warning","code":"high_rejection","message":"cabinet MAIN_V000_R000: rejected 5/12 observations","cabinet":"MAIN_V000_R000"}'
echo '{"event":"result","data":{"measured_points":[],"ba_stats":{"rms_reprojection_px":0.3,"iterations":5,"converged":true},"frame_strategy_used":"nominal_anchoring","procrustes_align_rms_m":0.0}}'
exit 0
