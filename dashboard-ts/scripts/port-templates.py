"""Port the Jinja2 templates to nunjucks.

Two kinds of change, both mechanical:

  1. `{% for x in ys %} … {% else %} … {% endfor %}` — Jinja's empty-loop
     branch, which nunjucks does not have. Rewritten to an explicit
     `{% if ys and ys.length %}` around the loop.

  2. Expressions that were Python and have to become JavaScript: `is not
     none`, `.startswith`, string slicing, `~` concatenation, tuple membership,
     and the several places where an empty list was relied on to be falsy —
     which it is in Python and is not in JavaScript.

Everything else in these 1,681 lines is left exactly as it was.
"""

import re
import sys
from pathlib import Path

TEMPLATES = Path(sys.argv[1])

BLOCK = re.compile(r"\{%-?\s*(for|if|elif|else|endfor|endif)\b(.*?)-?%\}", re.S)
FOR_IN = re.compile(r"^\s*\w[\w\s,]*\s+in\s+(.+?)\s*$", re.S)


def rewrite_for_else(text: str) -> tuple[str, int]:
    """Turn each for/else into if/for/endfor/else/endif.

    `{% else %}` belongs to whichever block is innermost, so the only reliable
    way to tell a for-else from an if-else is to track the nesting.
    """
    edits = []          # (start, end, replacement)
    stack = []          # ('for', iterable, match) | ('if', None, match)

    for m in BLOCK.finditer(text):
        kind, rest = m.group(1), m.group(2)
        if kind == "for":
            it = FOR_IN.match(rest)
            stack.append(("for", it.group(1) if it else None, m))
        elif kind == "if":
            stack.append(("if", None, m))
        elif kind == "else":
            if stack and stack[-1][0] == "for":
                _, iterable, open_m = stack[-1]
                if iterable:
                    # guard before the loop, close the loop before the else
                    edits.append((open_m.start(), open_m.start(),
                                  "{%% if %s and %s.length %%}" % (iterable, iterable)))
                    edits.append((m.start(), m.start(), "{% endfor %}"))
                    stack[-1] = ("for-else", iterable, open_m)
        elif kind == "endfor":
            frame = stack.pop() if stack else None
            if frame and frame[0] == "for-else":
                # the loop is already closed; this closes the if instead
                edits.append((m.start(), m.end(), "{% endif %}"))
        elif kind == "endif":
            if stack:
                stack.pop()

    for start, end, replacement in sorted(edits, reverse=True):
        text = text[:start] + replacement + text[end:]
    return text, len([e for e in edits if e[2].startswith("{% if")])


# (pattern, replacement, why)
EXPRESSIONS = [
    (r"\bis not none\b", "!= null", "Python's None is JavaScript's null"),
    (r"\.startswith\(", ".startsWith(", "JS spells it with a capital W"),
    # Python slice syntax anywhere in an expression.
    (r"(\{\{[^}]*?[\w.\)\]])\[(\d*):(\d*)\]",
     lambda m: f"{m.group(1)}.slice({m.group(2) or '0'}"
               f"{', ' + m.group(3) if m.group(3) else ''})",
     "Python slice -> String.slice"),
    # Jinja unpacks a list of tuples in a for loop; nunjucks has no tuples and
    # walks the strings instead, which renders but is wrong.
    (r"\[\('', 'any status'\)", "[['', 'any status']", "tuple list -> arrays"),
    (r"\(path ~ '/' ~ e\.name\)", "(path + '/' + e.name)", "nunjucks has no ~"),
    (r"t\.status in \('PENDING', 'RUNNING'\)",
     "t.status in ['PENDING', 'RUNNING']", "tuple -> array"),
    # An empty list is falsy in Python and truthy in JavaScript. Every one of
    # these guards an empty state that would otherwise never render.
    (r"\{% if not computers %\}", "{% if not computers.length %}", "empty list"),
    (r"\{% if schedules %\}", "{% if schedules.length %}", "empty list"),
    (r"\{% if inv\.apps %\}", "{% if inv.apps.length %}", "empty list"),
    (r"\{% if inv\.python_packages %\}",
     "{% if inv.python_packages.length %}", "empty list"),
    (r"\{% if inv\.runtimes %\}", "{% if inv.runtimes.length %}", "empty list"),
    (r"\{% if g\.blocking or g\.warnings %\}",
     "{% if g.blocking.length or g.warnings.length %}", "empty list"),
]


total_loops = 0
total_exprs = 0
for path in sorted(TEMPLATES.glob("*.html")):
    original = path.read_text()
    text, loops = rewrite_for_else(original)
    exprs = 0
    for pattern, replacement, _why in EXPRESSIONS:
        text, n = re.subn(pattern, replacement, text)
        exprs += n
    if text != original:
        path.write_text(text)
        print(f"{path.name}: {loops} for/else, {exprs} expressions")
    total_loops += loops
    total_exprs += exprs

print(f"\ntotal: {total_loops} for/else blocks, {total_exprs} expressions")
