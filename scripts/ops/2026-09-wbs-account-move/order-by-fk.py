"""AECI-1166: put a D1 dump's rows in foreign-key order, parents first.

D1's import checks foreign keys statement by statement. The dump's
`PRAGMA defer_foreign_keys` does not cover it (2026-10-01: "FOREIGN KEY constraint
failed" with every table already created). This keeps the schema block and the
trailing index/trigger block where they are, and re-sequences the row statements
(INSERT, plus the UPDATEs from split-long-statements.py) table by table in
topological order of the FOREIGN KEY graph. Within a table, order is unchanged.

Usage: python3 order-by-fk.py in.sql out.sql
"""

import re
import sys

src, dst = sys.argv[1], sys.argv[2]
lines = open(src, encoding="utf-8").read().split("\n")

# Group lines into statements: a statement starts on a line that begins with a
# SQL keyword; any other line is a continuation of a multi-line string value.
START = re.compile(r"^(PRAGMA|CREATE|INSERT INTO|UPDATE|DELETE|ANALYZE)\b")
stmts = []
for line in lines:
    if START.match(line) or not stmts:
        stmts.append([line])
    else:
        stmts[-1].append(line)

def table_of(stmt):
    # The dump resets AUTOINCREMENT counters with `DELETE FROM sqlite_sequence`
    # before re-inserting them; keep that DELETE with its INSERTs, or it runs last
    # and wipes the counters.
    m = re.match(r'^(?:INSERT INTO|UPDATE|DELETE FROM) "?([A-Za-z0-9_]+)"?', stmt[0])
    return m.group(1) if m else None

head, rows, tail = [], {}, []
order_seen = []
for s in stmts:
    t = table_of(s)
    if t is None:
        (tail if rows else head).append(s)
    else:
        if t not in rows:
            rows[t] = []
            order_seen.append(t)
        rows[t].append(s)

# FK graph from the CREATE TABLE statements.
deps = {}
for s in head:
    text = "\n".join(s)
    m = re.match(r'^CREATE TABLE (?:IF NOT EXISTS )?[`"]?([A-Za-z0-9_]+)[`"]?', text)
    if m:
        refs = set(re.findall(r'REFERENCES [`"]?([A-Za-z0-9_]+)[`"]?', text)) - {m.group(1)}
        deps[m.group(1)] = refs

done, ordered = set(), []
def visit(t, stack=()):
    if t in done:
        return
    if t in stack:
        sys.exit(f"foreign-key cycle: {' -> '.join(stack + (t,))}")
    for d in sorted(deps.get(t, ())):
        visit(d, stack + (t,))
    done.add(t)
    if t in rows:
        ordered.append(t)
for t in order_seen:
    visit(t)

# sqlite_sequence has no CREATE TABLE in the dump; load its counters last.
ordered = [t for t in ordered if t != "sqlite_sequence"] + (["sqlite_sequence"] if "sqlite_sequence" in rows else [])
out = [l for s in head for l in s]
for t in ordered:
    out += [l for s in rows[t] for l in s]
out += [l for s in tail for l in s]
assert len(out) == len(lines), (len(out), len(lines))
open(dst, "w", encoding="utf-8").write("\n".join(out))
print(f"{len(ordered)} tables in FK order; first: {ordered[:6]}")
