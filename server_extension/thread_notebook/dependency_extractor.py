"""Static dependency extraction for reactive notebook cells.

Given the source of a single cell, this module reports, using only Python's
``ast`` (no execution, no runtime tracing):

  * ``defines``  - names the cell binds at its top level (other cells may read)
  * ``reads``    - free names the cell references that some other cell must
                   define (i.e. not bound anywhere in this cell, not builtins)
  * ``imports``  - names introduced by import statements (a subset of defines)
  * ``deletes``  - names removed with ``del`` at the top level
  * ``mutates``  - names this cell *probably* mutates in place (heuristic;
                   subscript/attribute assignment and a small set of well-known
                   mutating method calls). Conservative and advisory only.
  * ``errors``   - parse errors, if any (the cell then has no other deps)

Design notes / deliberate scope:
  * Redefining a name in multiple cells is allowed. This is NOT marimo/Pluto;
    we stay backwards compatible with arbitrary Jupyter notebooks and let the
    notebook store decide ownership (most-recently-run cell wins).
  * Mutation is fundamentally not knowable statically (an arbitrary method may
    or may not mutate). We surface a conservative heuristic and never rely on
    it for correctness — consumers treat ``mutates`` as a hint.
  * Closures over class-scope variables are resolved leniently (class bindings
    are treated as visible to nested functions). This can only *miss* a
    cross-cell read in rare code, never invent one.
"""

import ast
import builtins

# Names IPython/Jupyter injects into the user namespace. Referencing these is
# not a cross-cell dependency.
_IPYTHON_BUILTINS = frozenset(
    {
        "get_ipython",
        "display",
        "In",
        "Out",
        "exit",
        "quit",
        "_",
        "__",
        "___",
        "_i",
        "_ii",
        "_iii",
    }
)

_BUILTIN_NAMES = frozenset(dir(builtins)) | _IPYTHON_BUILTINS

# Method names that, when called as ``x.method(...)`` as a statement, strongly
# imply in-place mutation of ``x``. Intentionally small and well-known to keep
# false positives down.
_MUTATING_METHODS = frozenset(
    {
        "append",
        "extend",
        "insert",
        "remove",
        "pop",
        "clear",
        "sort",
        "reverse",
        "add",
        "discard",
        "update",
        "setdefault",
        "popitem",
        "__setitem__",
        "__delitem__",
    }
)


def _target_bound_names(target):
    """Names bound by an assignment/for/with target.

    Name in Store context binds. Tuple/List unpacking and Starred recurse.
    Subscript and Attribute targets bind *nothing* (they mutate an existing
    object), so they are skipped here.
    """
    if isinstance(target, ast.Name):
        yield target.id
        return
    if isinstance(target, ast.Starred):
        yield from _target_bound_names(target.value)
        return
    if isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            yield from _target_bound_names(elt)
        return
    # Subscript / Attribute / anything else binds no new name.
    return


def _import_bound_name(alias):
    """The name an import alias introduces into the namespace.

    ``import a.b.c`` binds ``a``; ``import a.b.c as x`` binds ``x``.
    """
    if alias.asname:
        return alias.asname
    return alias.name.split(".")[0]


# Statement node types that open a new lexical scope. We never descend into
# these when collecting the *current* scope's bindings.
_SCOPE_STMT_TYPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)


class _ScopeBindingCollector(ast.NodeVisitor):
    """Collect names bound directly within one scope.

    Descends through compound statements (if/for/while/with/try) that share the
    scope, but stops at nested function/class scopes — those bind only their own
    *name* in the enclosing scope, collected by the caller.
    """

    def __init__(self):
        # ``plain`` holds names bound by ordinary means (assign, for, import,
        # def, ...). ``aug`` holds augmented-assignment targets (``x += 1``),
        # tracked separately because they both define *and* read the name.
        self.plain = set()
        self.aug = set()
        self.globals = set()
        self.nonlocals = set()

    @property
    def bound(self):
        return self.plain | self.aug

    def visit_Assign(self, node):
        for target in node.targets:
            self.plain.update(_target_bound_names(target))
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        self.plain.update(_target_bound_names(node.target))
        self.generic_visit(node)

    def visit_AugAssign(self, node):
        self.aug.update(_target_bound_names(node.target))
        self.generic_visit(node)

    def visit_NamedExpr(self, node):
        # Walrus binds in the nearest function/module scope.
        self.plain.update(_target_bound_names(node.target))
        self.generic_visit(node)

    def visit_For(self, node):
        self.plain.update(_target_bound_names(node.target))
        self.generic_visit(node)

    visit_AsyncFor = visit_For

    def visit_With(self, node):
        for item in node.items:
            if item.optional_vars is not None:
                self.plain.update(_target_bound_names(item.optional_vars))
        self.generic_visit(node)

    visit_AsyncWith = visit_With

    def visit_Import(self, node):
        for alias in node.names:
            self.plain.add(_import_bound_name(alias))

    def visit_ImportFrom(self, node):
        for alias in node.names:
            # ``from x import *`` cannot be resolved statically; skip it.
            if alias.name == "*":
                continue
            self.plain.add(_import_bound_name(alias))

    def visit_ExceptHandler(self, node):
        if node.name:
            self.plain.add(node.name)
        self.generic_visit(node)

    def visit_Global(self, node):
        self.globals.update(node.names)

    def visit_Nonlocal(self, node):
        self.nonlocals.update(node.names)

    def _bind_scope_def(self, node):
        # A nested def/class binds its own name in *this* scope; its body is a
        # separate scope we do not descend into here.
        self.plain.add(node.name)

    visit_FunctionDef = _bind_scope_def
    visit_AsyncFunctionDef = _bind_scope_def
    visit_ClassDef = _bind_scope_def

    # Lambdas and comprehensions are expressions opening their own scope; they
    # bind nothing in the current scope, so do not descend for bindings.
    def visit_Lambda(self, node):
        return

    def visit_ListComp(self, node):
        return

    visit_SetComp = visit_ListComp
    visit_DictComp = visit_ListComp
    visit_GeneratorExp = visit_ListComp


def _collect_scope(body_nodes, extra_names=()):
    """Run the binding collector over a scope body, seeded with extra_names
    (e.g. function arguments). Returns (plain, aug, globals, nonlocals), where
    ``plain`` are ordinary bindings and ``aug`` are augmented-assignment targets
    (which also read their prior value)."""
    collector = _ScopeBindingCollector()
    collector.plain.update(extra_names)
    for node in body_nodes:
        collector.visit(node)
    return (
        collector.plain,
        collector.aug,
        collector.globals,
        collector.nonlocals,
    )


def _arg_names(args):
    """All parameter names of a function/lambda arguments node."""
    names = []
    for group in (
        getattr(args, "posonlyargs", []),
        args.args,
        args.kwonlyargs,
    ):
        names.extend(a.arg for a in group)
    if args.vararg:
        names.append(args.vararg.arg)
    if args.kwarg:
        names.append(args.kwarg.arg)
    return names


class _ReadCollector:
    """Walk the tree resolving Name loads against a stack of scope binding sets.

    A loaded name that is bound in no scope in the current lexical chain and is
    not a builtin is a cross-cell read. Module-level global declarations that
    are assigned inside functions are promoted to module defines.
    """

    def __init__(self, module_bound):
        self.module_bound = module_bound
        self.reads = set()
        # global-declared-and-assigned names become module-level effects.
        self.promoted_globals = set()

    def run(self, tree):
        self._visit_body(tree.body, [self.module_bound])

    def _visit_body(self, nodes, chain):
        for node in nodes:
            self._visit(node, chain)

    def _bound_in_chain(self, name, chain):
        for scope in chain:
            if name in scope:
                return True
        return False

    def _visit(self, node, chain):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Load):
                name = node.id
                if name in _BUILTIN_NAMES:
                    return
                if self._bound_in_chain(name, chain):
                    return
                self.reads.add(name)
            return

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            self._visit_function(node, chain)
            return

        if isinstance(node, ast.Lambda):
            self._visit_lambda(node, chain)
            return

        if isinstance(node, ast.ClassDef):
            self._visit_class(node, chain)
            return

        if isinstance(node, (ast.ListComp, ast.SetComp, ast.GeneratorExp)):
            self._visit_comprehension(node, chain, (node.elt,))
            return

        if isinstance(node, ast.DictComp):
            self._visit_comprehension(node, chain, (node.key, node.value))
            return

        # Default: descend into all child nodes in the same scope.
        for child in ast.iter_child_nodes(node):
            self._visit(child, chain)

    def _visit_function(self, node, chain):
        # Decorators, defaults, and annotations evaluate in the ENCLOSING scope.
        for dec in node.decorator_list:
            self._visit(dec, chain)
        self._visit_arg_defaults(node.args, chain)
        if node.returns is not None:
            self._visit(node.returns, chain)

        plain, aug, declared_globals, _ = _collect_scope(
            node.body, extra_names=_arg_names(node.args)
        )
        bound = plain | aug
        # global x; x = ... inside a function is a module-level definition.
        for g in declared_globals:
            if g in bound:
                self.promoted_globals.add(g)
        self._visit_body(node.body, chain + [bound])

    def _visit_lambda(self, node, chain):
        self._visit_arg_defaults(node.args, chain)
        bound = set(_arg_names(node.args))
        self._visit(node.body, chain + [bound])

    def _visit_arg_defaults(self, args, chain):
        for default in list(args.defaults) + [
            d for d in args.kw_defaults if d is not None
        ]:
            self._visit(default, chain)
        # Annotations also evaluate in the enclosing scope.
        for group in (
            getattr(args, "posonlyargs", []),
            args.args,
            args.kwonlyargs,
        ):
            for a in group:
                if a.annotation is not None:
                    self._visit(a.annotation, chain)

    def _visit_class(self, node, chain):
        for dec in node.decorator_list:
            self._visit(dec, chain)
        for base in node.bases:
            self._visit(base, chain)
        for kw in node.keywords:
            self._visit(kw.value, chain)
        plain, aug, _, _ = _collect_scope(node.body)
        self._visit_body(node.body, chain + [plain | aug])

    def _visit_comprehension(self, node, chain, element_nodes):
        # The first iterable is evaluated in the enclosing scope; targets and
        # subsequent iterables/conditions live in the comprehension's scope.
        comp_bound = set()
        for i, gen in enumerate(node.generators):
            if i == 0:
                self._visit(gen.iter, chain)
            comp_bound.update(_target_bound_names(gen.target))
        inner_chain = chain + [comp_bound]
        for i, gen in enumerate(node.generators):
            if i != 0:
                self._visit(gen.iter, inner_chain)
            for cond in gen.ifs:
                self._visit(cond, inner_chain)
        for elt in element_nodes:
            self._visit(elt, inner_chain)


class _MutationCollector(ast.NodeVisitor):
    """Heuristic: top-level names whose objects are probably mutated in place."""

    def __init__(self):
        self.mutates = set()

    @staticmethod
    def _root_name(node):
        # Walk a.b.c[0].d back to the root Name, if any.
        while isinstance(node, (ast.Attribute, ast.Subscript)):
            node = node.value
        if isinstance(node, ast.Name):
            return node.id
        return None

    def _record_target(self, target):
        if isinstance(target, (ast.Subscript, ast.Attribute)):
            root = self._root_name(target)
            if root is not None:
                self.mutates.add(root)
            return
        if isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._record_target(elt)

    def visit_Assign(self, node):
        for target in node.targets:
            self._record_target(target)
        self.generic_visit(node)

    def visit_AnnAssign(self, node):
        self._record_target(node.target)
        self.generic_visit(node)

    def visit_AugAssign(self, node):
        # x += 1 mutates x; df['a'] += 1 mutates df.
        root = self._root_name(node.target)
        if root is not None:
            self.mutates.add(root)
        self.generic_visit(node)

    def visit_Call(self, node):
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in _MUTATING_METHODS:
            root = self._root_name(func.value)
            if root is not None:
                self.mutates.add(root)
        self.generic_visit(node)


class _DeleteCollector(ast.NodeVisitor):
    """Top-level ``del name`` statements (only plain names count as deletes)."""

    def __init__(self):
        self.deletes = set()
        self._depth = 0

    def _enter_scope(self, node):
        self._depth += 1
        self.generic_visit(node)
        self._depth -= 1

    visit_FunctionDef = _enter_scope
    visit_AsyncFunctionDef = _enter_scope
    visit_ClassDef = _enter_scope
    visit_Lambda = _enter_scope

    def visit_Delete(self, node):
        if self._depth == 0:
            for target in node.targets:
                if isinstance(target, ast.Name):
                    self.deletes.add(target.id)
        self.generic_visit(node)


def _import_names(tree):
    names = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(_import_bound_name(alias))
            continue
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                if alias.name == "*":
                    continue
                names.add(_import_bound_name(alias))
    return names


def _empty_result(errors=None):
    return {
        "defines": [],
        "reads": [],
        "imports": [],
        "deletes": [],
        "mutates": [],
        "errors": errors or [],
    }


def extract_dependencies(source):
    """Extract static dependency info from one cell's source.

    Returns a dict with sorted string lists under the keys documented at the top
    of this module. Never raises on user code: a syntax error is reported in
    ``errors`` and all other fields come back empty.
    """
    if not source or not source.strip():
        return _empty_result()

    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return _empty_result(errors=[f"SyntaxError: {exc}"])

    module_plain, module_aug, _, _ = _collect_scope(tree.body)
    module_bound = module_plain | module_aug

    reader = _ReadCollector(module_bound)
    reader.run(tree)

    defines = module_bound | reader.promoted_globals

    mutator = _MutationCollector()
    mutator.visit(tree)

    deleter = _DeleteCollector()
    deleter.visit(tree)

    # ``x += ...`` at the top level both defines and reads x, unless the cell
    # also defines x by ordinary means (then the prior value is self-supplied).
    aug_reads = {n for n in module_aug - module_plain if n not in _BUILTIN_NAMES}
    reads = set(reader.reads) | aug_reads
    mutates = {m for m in mutator.mutates if m not in _BUILTIN_NAMES}

    return {
        "defines": sorted(defines),
        "reads": sorted(reads),
        "imports": sorted(_import_names(tree)),
        "deletes": sorted(deleter.deletes),
        "mutates": sorted(mutates),
        "errors": [],
    }


if __name__ == "__main__":
    import json
    import sys

    print(json.dumps(extract_dependencies(sys.stdin.read()), indent=2))
