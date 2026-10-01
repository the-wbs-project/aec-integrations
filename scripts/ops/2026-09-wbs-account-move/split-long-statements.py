"""AECI-1166: make every statement in a D1 dump fit D1's 100,000-byte limit.

D1 rejects an import containing a longer statement (the 2026-10-01 rehearsal reset
with D1_RESET_DO on two promote_jobs rows of ~101 KB). For each oversized INSERT,
this blanks its longest string value, then appends the value back in chunks with
`UPDATE <table> SET <col> = <col> || '<chunk>' WHERE <first col> = <first value>`.
The stored value is byte-identical after the UPDATEs run.

Usage: python3 split-long-statements.py in.sql out.sql
"""

import re
import sys

LIMIT = 90_000  # stay well under 100,000 bytes per statement
CHUNK = 60_000  # characters of the string literal per UPDATE


def tokens(values):
    """Split the inside of VALUES(...) into top-level SQL literals."""
    out, i, n = [], 0, len(values)
    while i < n:
        if values[i] == "'":
            j = i + 1
            while True:
                if values[j] == "'" and j + 1 < n and values[j + 1] == "'":
                    j += 2
                elif values[j] == "'":
                    break
                else:
                    j += 1
            out.append(values[i : j + 1])
            i = j + 1
        else:
            j = values.find(",", i)
            j = n if j == -1 else j
            out.append(values[i:j])
            i = j
        if i < n and values[i] == ",":
            i += 1
    return out


def split(line):
    m = re.match(r'^INSERT INTO "([^"]+)" \(([^)]*)\) VALUES\((.*)\);$', line, re.S)
    if not m:
        sys.exit(f"cannot parse oversized statement: {line[:80]}")
    table, cols, vals = m.group(1), m.group(2), tokens(m.group(3))
    names = [c.strip().strip('"') for c in cols.split(",")]
    assert len(names) == len(vals), (table, len(names), len(vals))
    big = max(range(len(vals)), key=lambda k: len(vals[k]))
    literal = vals[big]
    assert literal.startswith("'") and literal.endswith("'")
    body = literal[1:-1]
    vals[big] = "''"
    out = [f'INSERT INTO "{table}" ({cols}) VALUES({",".join(vals)});']
    # Never cut inside an escaped quote pair.
    i = 0
    while i < len(body):
        j = min(i + CHUNK, len(body))
        while j < len(body) and body[i:j].count("'") % 2:
            j += 1
        out.append(f'UPDATE "{table}" SET "{names[big]}" = "{names[big]}" || \'{body[i:j]}\' WHERE "{names[0]}" = {vals[0]};')
        i = j
    return out


src, dst = sys.argv[1], sys.argv[2]
lines = open(src, encoding="utf-8").read().split("\n")
out, fixed = [], 0
for line in lines:
    if len(line.encode("utf-8")) > LIMIT:
        out.extend(split(line))
        fixed += 1
    else:
        out.append(line)
open(dst, "w", encoding="utf-8").write("\n".join(out))
print(f"{fixed} oversized statements split")
