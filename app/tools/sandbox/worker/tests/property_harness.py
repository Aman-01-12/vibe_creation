"""Shared Hypothesis strategies and the property-test tag convention (task 1.3).

The Python-side mirror of the TypeScript ``@app/test`` harness. It provides the
``Feature: hdl-creation-loop, Property {n}: {text}`` tag convention and a small
set of primitive edge-case strategies (unsafe paths, non-positive port widths)
that later worker property tests - for example the sandbox path-confinement
property in task 3.4 - reuse instead of re-rolling their own.
"""

from hypothesis import strategies as st

#: The feature slug used in every property-test tag for this spec.
FEATURE = "hdl-creation-loop"

_TRAVERSAL_TOKENS = ("../", "..\\", "%2e%2e%2f", "..%2f", "%252e%252e%252f")

#: Characters that make up a plain, safe workspace path segment: lowercase
#: letters, digits, and underscore. Deliberately excludes ``.`` (so no ``..``
#: segment can form), ``/`` and ``\`` (no separators smuggled into a segment),
#: ``%`` (no percent-encoding), and the NUL byte, so a segment is never itself
#: an attack class.
_SAFE_SEGMENT_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_"

#: Verilog/support suffixes a legitimate workspace file may carry.
_SAFE_SUFFIXES = (".v", ".sv", ".vh", ".svh", ".txt", ".mem")


def property_tag(number: int, text: str) -> str:
    """Return the canonical property-test tag string."""
    return f"Feature: {FEATURE}, Property {number}: {text}"


def _safe_segments() -> st.SearchStrategy[str]:
    """A single safe path segment (never empty, never ``.`` or ``..``)."""
    return st.text(alphabet=_SAFE_SEGMENT_ALPHABET, min_size=1, max_size=8)


def unsafe_path_strings() -> st.SearchStrategy[str]:
    """Hostile, non-empty path strings spanning the syntactic attack classes.

    Covers the NUL-byte, percent-encoded, backslash-separator, absolute (POSIX
    and Windows-drive), and parent-directory-traversal classes the path screen
    must reject. Every string produced here is non-empty and fails the syntactic
    screen, so confining any of them yields a rejection rather than a write. The
    empty-path class is a single fixed value, so a caller that needs it composes
    ``st.just("")`` alongside this strategy rather than drawing it here.
    """
    leaf = _safe_segments()
    traversal = st.lists(st.sampled_from(_TRAVERSAL_TOKENS), min_size=1, max_size=4).map("".join)
    posix_absolute = leaf.map(lambda name: f"/etc/{name}")
    windows_absolute = leaf.map(lambda name: f"C:/{name}.v")
    nul_byte = leaf.map(lambda name: f"{name}\x00.v")
    percent_encoded = leaf.map(lambda name: f"%2e{name}.v")
    backslash = leaf.map(lambda name: f"sub\\{name}.v")
    return st.one_of(
        traversal,
        posix_absolute,
        windows_absolute,
        nul_byte,
        percent_encoded,
        backslash,
    )


def safe_relative_paths() -> st.SearchStrategy[str]:
    """Legitimate workspace-relative paths that confinement must accept.

    Produces forward-slash relative paths of safe segments ending in a source
    suffix (for example ``rtl/adder.v``); none is empty, absolute, encoded,
    backslash-separated, or contains a ``..`` segment, so each resolves strictly
    inside the workspace root.
    """
    directories = st.lists(_safe_segments(), min_size=0, max_size=3)
    return st.builds(
        lambda parts, name, suffix: "/".join([*parts, name]) + suffix,
        directories,
        _safe_segments(),
        st.sampled_from(_SAFE_SUFFIXES),
    )


def non_positive_port_widths() -> st.SearchStrategy[int]:
    """Zero and negative port widths (invalid), mirroring the TypeScript generator."""
    return st.integers(max_value=0)
