"""Throwaway non-vacuity probe: mutate eda.py, confirm the new pins go RED, restore.

Not a durable test. Deleted at the end of task 2.3; the pins themselves are the
deliverable and this only proves they can fail.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

EDA = Path("src/tool_runner_worker/eda.py")

MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        "run the checks in a different order",
        '    ("presat", ("--presat",)),\n    (_BASE_CHECK, ()),\n',
        '    (_BASE_CHECK, ()),\n    ("presat", ("--presat",)),\n',
        "test_a_proved_result_is_audited_once_under_the_cross_check_solver",
    ),
    (
        "trigger the audit on FAILED instead of PASSED",
        '_PROVED_STATUS = "PASSED"',
        '_PROVED_STATUS = "FAILED"',
        "test_a_proved_result_is_audited_once_under_the_cross_check_solver",
    ),
    (
        "audit under the main solver instead of z3",
        '_CROSS_CHECK_SOLVER = "z3"',
        '_CROSS_CHECK_SOLVER = "bitwuzla"',
        "test_a_proved_result_is_audited_once_under_the_cross_check_solver",
    ),
    (
        "report a check that did not run as one that passed",
        "                status=None,\n",
        '                status="PASSED",\n',
        "test_a_missing_smt2_reports_an_assertion_count_of_zero",
    ),
]


def main() -> int:
    original = EDA.read_text(encoding="utf-8")
    failures: list[str] = []
    try:
        for label, old, new, test in MUTATIONS:
            if old not in original:
                failures.append(f"UNAPPLIED  {label}: anchor not found")
                continue
            EDA.write_text(original.replace(old, new, 1), encoding="utf-8")
            done = subprocess.run(
                ["uv", "run", "--extra", "test", "--extra", "dev", "pytest", "-x", "-k", test],
                capture_output=True,
                text=True,
                check=False,
            )
            verdict = "RED (good)" if done.returncode != 0 else "GREEN (VACUOUS PIN)"
            print(f"{verdict:20} {label} -> {test}")
            if done.returncode == 0:
                failures.append(f"VACUOUS  {label} -> {test}")
    finally:
        EDA.write_text(original, encoding="utf-8")
    for line in failures:
        print(line)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
