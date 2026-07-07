#!/usr/bin/env python3
"""基准回归判定：aggregate MAD 恶化 >0.002 或 grad >0.004 → exit 1。"""
import json, sys
rep, base = (json.load(open(p)) for p in sys.argv[1:3])
dm = rep["aggregate"]["mad"] - base["aggregate"]["mad"]
dg = rep["aggregate"]["grad"] - base["aggregate"]["grad"]
print(f"ΔMAD={dm:+.4f} Δgrad={dg:+.4f}")
sys.exit(0 if (dm <= 0.002 and dg <= 0.004) else 1)
