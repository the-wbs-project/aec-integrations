"""Inject the rulings layer into mock-ups 5 and 6 and the 7/8 body sources, then rebuild 7 and 8.

Idempotent: every insertion sits between markers and is replaced on re-run. Run after catmenu.py.
- CSS (5 and 6, before </style>): rulings.css (the "Hero and bars: solid" comparison), then the "as first designed"
  restore layers: restore-type-<page>.css, restore-type-cm.css (the Browse menu) and restore-buttons.css.
  7 and 8 inherit 6's block through build.py, which appends restore-type-7/8.css after the page CSS.
- JS (5 and 6, own <script> before </body>): rulings.js. build.py adds it to 7 and 8.
- Options (5, 6, 7-body, 8-body): rulings-opt.html, just above the Options toggle.
The restore files hold the values the mock-ups had before rulings 9, 17 and 20; delete them and the options to drop the comparison.
"""
import os, re, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
read = lambda n: open(os.path.join(here, n)).read().rstrip("\n")


def css_block(page):
    parts = [read("rulings.css"), read("restore-type-%s.css" % page), read("restore-type-cm.css"), read("restore-buttons.css")]
    return "/* rulings:start */\n" + "\n".join(parts) + "\n/* rulings:end */\n"


def inject_css(s, page):
    s = re.sub(r"/\* rulings:start \*/.*?/\* rulings:end \*/\n", "", s, flags=re.S)
    i = s.index("</style>")
    return s[:i] + css_block(page) + s[i:]


def inject_js(s):
    s = re.sub(r"<script>/\* rulings-js:start \*/.*?/\* rulings-js:end \*/</script>\n", "", s, flags=re.S)
    i = s.rindex("</body>")
    return s[:i] + "<script>/* rulings-js:start */\n" + read("rulings.js") + "\n/* rulings-js:end */</script>\n" + s[i:]


def inject_opt(s):
    s = re.sub(r"    <!-- rulings-opt:start -->.*?<!-- rulings-opt:end -->\n", "", s, flags=re.S)
    anchor = '  </div>\n  <button type="button" id="mockToggle"'
    assert s.count(anchor) == 1
    return s.replace(anchor, read("rulings-opt.html") + "\n" + anchor)


for name, page in (("5-statement-first.html", "5"), ("6-product-detail.html", "6"), ("src/7-body.html", None), ("src/8-body.html", None)):
    p = os.path.join(root, name)
    s = inject_opt(open(p).read())
    if page:
        s = inject_js(inject_css(s, page))
    open(p, "w").write(s)
    print("rulings injected", name)

subprocess.run([sys.executable, os.path.join(here, "build.py")], check=True)
