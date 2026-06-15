#!/bin/sh
# Mock sidecar that writes lots of stderr then exits non-zero.
# Verifies the adapter drains stderr concurrently and includes it in the
# error message.
read -r STDIN_PAYLOAD
i=0
while [ $i -lt 100 ]; do
    echo "stderr-line-$i diagnostic detail somewhere here padding padding padding" >&2
    i=$((i+1))
done
echo '{"event":"progress","stage":"load","percent":0.0}'
exit 1
