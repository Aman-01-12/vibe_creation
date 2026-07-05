"""Pytest + Hypothesis configuration for the Tool_Runner worker (task 1.3).

Registers and loads the shared Hypothesis settings profile so every property
test in this package runs at the >= 100 example default. This mirrors the
TypeScript ``@app/test`` ``DEFAULT_NUM_RUNS`` of 100 on the Python side. Pytest
loads this module automatically.
"""

from hypothesis import settings

#: The per-property example count, matching the TypeScript fast-check default.
DEFAULT_MAX_EXAMPLES = 100

settings.register_profile("hdl-creation-loop", max_examples=DEFAULT_MAX_EXAMPLES)
settings.load_profile("hdl-creation-loop")
