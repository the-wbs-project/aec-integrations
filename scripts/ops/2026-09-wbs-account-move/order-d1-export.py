"""AECI-1166: reorder a `wrangler d1 export` dump so it imports into an empty D1.

The export writes each table's CREATE TABLE immediately followed by its rows. A
row in an early table that has a FOREIGN KEY to a later table fails on import with
"no such table" (audit_log -> profiles did, 2026-10-01). This moves every CREATE
TABLE block to the top, after the PRAGMA line. No line is added, dropped or changed.

Usage: python3 order-d1-export.py in.sql out.sql
"""

import sys

src_path, out_path = sys.argv[1], sys.argv[2]
lines = open(src_path, encoding="utf-8").read().split("\n")

creates, rest, i = [], [], 0
while i < len(lines):
    if lines[i].startswith("CREATE TABLE"):
        block = [lines[i]]
        while not block[-1].rstrip().endswith(");"):
            i += 1
            block.append(lines[i])
        creates.append(block)
    else:
        rest.append(lines[i])
    i += 1

if not rest[0].startswith("PRAGMA defer_foreign_keys"):
    sys.exit(f"unexpected first line: {rest[0][:60]}")
out = [rest[0]] + [line for block in creates for line in block] + rest[1:]
assert len(out) == len(lines)
open(out_path, "w", encoding="utf-8").write("\n".join(out))
print(f"{len(creates)} tables hoisted, {len(out)} lines")
