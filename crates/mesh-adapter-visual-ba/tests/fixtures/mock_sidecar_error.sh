#!/bin/sh
read -r STDIN_PAYLOAD
echo '{"event":"progress","stage":"load","percent":0.0}'
echo '{"event":"error","code":"detection_failed","message":"only 2/30 images had valid ChArUco","fatal":true}'
exit 1
