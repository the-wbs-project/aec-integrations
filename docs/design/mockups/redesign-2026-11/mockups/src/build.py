"""Assemble mock-ups 7 and 8 from mock-up 6's head, CSS and script prelude."""
import os, sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
six = open(os.path.join(root, "6-product-detail.html")).read()

head = six[: six.index("</style>")]
s0 = six.index("<script>") + len("<script>\n")
prelude = six[s0 : six.index("  /* ---------- Data ---------- */")]
shared = open(os.path.join(here, "shared.js")).read()

TITLES = {
    "7": ("Bluebeam Revu: integrations and reviews", "Procore Project Management: integrations and reviews"),
    "8": ("Bluebeam Revu: integrations and reviews", "SiteLedger: integrations and reviews"),
}
OUT = {"7": "7-product-many.html", "8": "8-product-none.html"}

for v in sys.argv[1:] or ["7", "8"]:
    h = head.replace(*TITLES[v])
    css = open(os.path.join(here, v + ".css")).read()
    body = open(os.path.join(here, v + "-body.html")).read()
    js = open(os.path.join(here, v + ".js")).read()
    rest = os.path.join(here, "restore-type-%s.css" % v)
    if os.path.exists(rest):  # "Type and spacing: as first designed" for this page's own CSS (see rulings.py)
        css += "/* rulings-%s:start */\n" % v + open(rest).read() + "/* rulings-%s:end */\n" % v
    out = h + css + "</style>\n</head>\n" + body + prelude + shared + js
    rj = os.path.join(here, "rulings.js")
    if os.path.exists(rj):
        i = out.rindex("</body>")
        out = out[:i] + "<script>/* rulings-js:start */\n" + open(rj).read().rstrip("\n") + "\n/* rulings-js:end */</script>\n" + out[i:]
    open(os.path.join(root, OUT[v]), "w").write(out)
    print("wrote", OUT[v], len(out))
