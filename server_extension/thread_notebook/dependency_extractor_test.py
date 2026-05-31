"""Tests for dependency_extractor.

Run directly (no pytest needed):

    python server_extension/thread_notebook/dependency_extractor_test.py

Exits non-zero if any case fails.
"""

import sys
import textwrap

try:
    from dependency_extractor import extract_dependencies
except ImportError:
    from thread_notebook.dependency_extractor import extract_dependencies


_failures = []


def check(source, *, defines=None, reads=None, imports=None, deletes=None,
          mutates=None, has_error=False, label=""):
    src = textwrap.dedent(source)
    result = extract_dependencies(src)

    def cmp(field, expected):
        if expected is None:
            return
        actual = result[field]
        if sorted(expected) != actual:
            _failures.append(
                f"[{label or src.strip()[:40]!r}] {field}: "
                f"expected {sorted(expected)}, got {actual}"
            )

    cmp("defines", defines)
    cmp("reads", reads)
    cmp("imports", imports)
    cmp("deletes", deletes)
    cmp("mutates", mutates)

    if has_error and not result["errors"]:
        _failures.append(f"[{label}] expected a parse error, got none")
    if not has_error and result["errors"]:
        _failures.append(f"[{label}] unexpected error: {result['errors']}")


# --- basic binding & reading -------------------------------------------------

check("x = 1", defines=["x"], reads=[], label="simple assign")
check("y = x + 1", defines=["y"], reads=["x"], label="read upstream")
check("a = b = 0", defines=["a", "b"], reads=[], label="chained assign")
check("a, (b, c) = f()", defines=["a", "b", "c"], reads=["f"],
      label="nested tuple unpack")
check("first, *rest = items", defines=["first", "rest"], reads=["items"],
      label="starred unpack")
check("total += step", defines=["total"], reads=["total", "step"],
      mutates=["total"], label="augassign reads and mutates target")

# builtins and the cell's own defs are not reads
check("print(len(data))", defines=[], reads=["data"], label="builtins excluded")
check("z = 1\nw = z + 1", defines=["z", "w"], reads=[], label="self-defined not read")

# --- imports -----------------------------------------------------------------

check("import os", defines=["os"], imports=["os"], reads=[], label="import")
check("import os.path", defines=["os"], imports=["os"], reads=[],
      label="dotted import binds root")
check("import numpy as np", defines=["np"], imports=["np"], reads=[],
      label="import as")
check("from a.b import c, d as e", defines=["c", "e"], imports=["c", "e"],
      reads=[], label="from import with alias")
check("from x import *", defines=[], imports=[], reads=[],
      label="star import unresolved")

# --- functions, closures, scope ---------------------------------------------

check(
    """
    def f(a, b):
        return a + b + g
    """,
    defines=["f"], reads=["g"],
    label="function params not read, free var is",
)
check(
    """
    def outer():
        def inner():
            return shared
        return inner
    """,
    defines=["outer"], reads=["shared"],
    label="nested closure free var",
)
check(
    """
    def f(x=default, *args, **kwargs):
        return x
    """,
    defines=["f"], reads=["default"],
    label="default value reads enclosing scope",
)
check(
    """
    @decorator
    def f():
        pass
    """,
    defines=["f"], reads=["decorator"],
    label="decorator is a read",
)
check(
    """
    def f() -> ReturnType:
        v: LocalAnno = 1
        return v
    """,
    defines=["f"], reads=["ReturnType", "LocalAnno"],
    label="annotations are reads",
)

# global promotion: a function that declares+assigns a global defines it
check(
    """
    def setup():
        global config
        config = load()
    """,
    defines=["setup", "config"], reads=["load"],
    label="global assignment promotes to define",
)

# --- classes -----------------------------------------------------------------

check(
    """
    class A(Base, metaclass=Meta):
        attr = value
        def method(self):
            return self.attr
    """,
    defines=["A"], reads=["Base", "Meta", "value"],
    label="class bases/keywords/body reads",
)

# --- comprehensions ----------------------------------------------------------

check("squares = [i * i for i in nums]", defines=["squares"], reads=["nums"],
      label="listcomp target is local")
check("pairs = {k: v for k, v in mapping.items()}", defines=["pairs"],
      reads=["mapping"], label="dictcomp")
check("g = (transform(x) for x in source if pred(x))", defines=["g"],
      reads=["transform", "source", "pred"], label="genexp with condition")
check(
    "matrix = [[col for col in row] for row in grid]",
    defines=["matrix"], reads=["grid"],
    label="nested comprehension",
)

# --- lambda & walrus ---------------------------------------------------------

check("f = lambda a: a + base", defines=["f"], reads=["base"],
      label="lambda free var")
check("if (n := compute()) > 0:\n    pass", defines=["n"], reads=["compute"],
      label="walrus binds n")

# --- for / with / except -----------------------------------------------------

check(
    """
    for item in collection:
        acc.append(item)
    """,
    defines=["item"], reads=["collection", "acc"], mutates=["acc"],
    label="for loop + list mutation",
)
check(
    """
    with open(path) as fh:
        data = fh.read()
    """,
    defines=["fh", "data"], reads=["path"],
    label="with-as binding",
)
check(
    """
    try:
        risky()
    except Error as err:
        handle(err)
    """,
    defines=["err"], reads=["risky", "Error", "handle"],
    label="except-as binding",
)

# --- mutation heuristic ------------------------------------------------------

check("df['col'] = compute(df)", defines=[], reads=["df", "compute"],
      mutates=["df"], label="subscript assign mutates base")
check("obj.attr = 5", defines=[], reads=["obj"], mutates=["obj"],
      label="attribute assign mutates base")
check("config.settings['x'] = 1", defines=[], reads=["config"],
      mutates=["config"], label="chained subscript/attr mutates root")
check("results.append(row)", defines=[], reads=["results", "row"],
      mutates=["results"], label="append method mutates")
check("d.update(other)", defines=[], reads=["d", "other"], mutates=["d"],
      label="update method mutates")
# A non-mutating method call should NOT be flagged.
check("y = series.mean()", defines=["y"], reads=["series"], mutates=[],
      label="mean() is not a mutation")

# --- del ---------------------------------------------------------------------

check("del temp", defines=[], deletes=["temp"], reads=[],
      label="del removes name")
check(
    """
    def f():
        del local
    """,
    defines=["f"], deletes=[], reads=[],
    label="del inside function is not a cell-level delete",
)

# --- errors & edge cases -----------------------------------------------------

check("def f(:", has_error=True, label="syntax error reported")
check("", defines=[], reads=[], label="empty cell")
check("   \n  \n", defines=[], reads=[], label="whitespace-only cell")
check("# just a comment", defines=[], reads=[], label="comment-only cell")


if _failures:
    print(f"FAILED: {len(_failures)} case(s)\n")
    for f in _failures:
        print("  -", f)
    sys.exit(1)

print("All dependency_extractor tests passed.")
