#!/usr/bin/env python3
"""Keyer v2 regression gate: every case and metric is checked independently."""

from __future__ import annotations

import json
import pathlib
import sys

METRICS = ("mad", "grad", "edge", "fgErr", "bgResidue", "coreLeak", "flicker")
DEFAULT_TOLERANCES = {
    "mad": 0.002,
    "grad": 0.004,
    "edge": 0.010,
    "fgErr": 0.002,       # rgba16f subtraction/readback noise floor included
    "bgResidue": 0.002,
    "coreLeak": 0.010,
    "flicker": 0.003,
}


def load(path: str) -> dict:
    return json.loads(pathlib.Path(path).read_text())


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check_report.py REPORT BASELINE", file=sys.stderr)
        return 2
    report, baseline = (load(path) for path in sys.argv[1:3])
    tolerances = {**DEFAULT_TOLERANCES, **baseline.get("tolerances", {})}
    report_cases = {row["id"]: row for row in report.get("cases", [])}
    baseline_cases = {row["id"]: row for row in baseline.get("cases", [])}
    failures: list[str] = []
    for case_id, expected in baseline_cases.items():
        actual = report_cases.get(case_id)
        if actual is None:
            failures.append(f"{case_id}: missing case")
            continue
        for metric in METRICS:
            if metric not in expected:
                continue
            if metric not in actual:
                failures.append(f"{case_id}.{metric}: missing metric")
                continue
            delta = float(actual[metric]) - float(expected[metric])
            limit = float(tolerances[metric])
            status = "PASS" if delta <= limit else "FAIL"
            print(f"{status} {case_id}.{metric}: {actual[metric]:.6f} baseline={expected[metric]:.6f} delta={delta:+.6f} limit={limit:.6f}")
            if delta > limit:
                failures.append(f"{case_id}.{metric}: +{delta:.6f} > {limit:.6f}")
    extra = sorted(set(report_cases) - set(baseline_cases))
    if extra:
        print("INFO extra cases: " + ", ".join(extra))
    if failures:
        print("\nRegression gate failed:", file=sys.stderr)
        for failure in failures:
            print("- " + failure, file=sys.stderr)
        return 1
    print(f"\nKeyer v2 regression gate passed ({len(baseline_cases)} cases, {len(METRICS)} metrics).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
