"""Inject the Browse mega-menu into mock-ups 5 and 6 and the 7/8 body sources, then rebuild 7 and 8.

Idempotent: every insertion sits between markers and is replaced on re-run.
Fragments: catmenu-head.html (header + scrim, with placeholders), catmenu-card.html, catmenu.css, catmenu.js.
CSS and JS go into 5 and 6 only; 7 and 8 inherit them from 6 through build.py.

The four facet columns are generated here from the real vocabularies in apps/api/seed/taxonomy.sql
and apps/api/seed/trades.sql. Names are converted to sentence case with "and" for "&".
The Explore column (All products + hand-picked key categories) comes first; the Categories column leaves out
whichever key categories are shown, so nothing is listed twice. The "Key categories" option shows 3, 4 or 5.
Product counts are placeholders. Categories, audiences and trades are sorted by count, highest first.
Phases keep the vocabulary's display_order (project lifecycle order). Up to MAX_N terms are emitted;
the "Menu items per column" option hides the ones past N.
"""
import os, re, subprocess, sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.dirname(here)
repo = os.path.dirname(os.path.dirname(root))
read = lambda p: open(p).read()

MAX_N, DEFAULT_N, N_OPTIONS = 9, 7, (5, 7, 9)
# Key categories, chosen by AEC Integrations, in display order. The option shows the first K.
KEY = ("ai", "project-management", "bim-authoring", "accounting-erp", "estimating-takeoff")
DEFAULT_K, K_OPTIONS = 4, (3, 4, 5)
TOTAL = 486  # placeholder: all products
FOOT = "Key categories are chosen by AEC Integrations. Other lists show most products first. Phases in project order."

# Placeholder product counts, keyed by real slug. Stable across N options.
COUNTS = {
    "categories": {"bim-authoring": 64, "project-management": 58, "accounting-erp": 52, "field-management": 47, "estimating-takeoff": 45,
                   "construction-management": 41, "document-management": 38, "scheduling": 36, "collaboration-communication": 33,
                   "rfi-submittal-management": 31, "ai": 29, "safety-compliance": 27, "bid-management": 25, "reality-capture": 22, "payment-management": 20},
    "phases": {"concept-planning": 38, "design": 86, "pre-construction": 74, "construction": 112, "closeout-operations": 47},
    "audiences": {"general-contracting": 71, "project-manager": 66, "specialty-contracting": 49, "architecture": 44, "owner-developer": 39,
                  "superintendent": 35, "estimator": 31, "mep-engineering": 28, "bim-coordinator": 24},
    "trades": {"electrical": 23, "hvac-mechanical": 21, "concrete": 18, "plumbing": 16, "sitework-utilities": 14, "structural-steel": 12,
               "drywall-interior-framing": 11, "fire-protection": 9, "rebar-reinforcing": 8},
}
FACETS = (("categories", "Categories", "Cat", True), ("phases", "Phases", "Ph", False), ("audiences", "Audiences", "Aud", True), ("trades", "Trades", "Tr", True))


def vocab():
    """slug -> (name, display_order) per facet, parsed from the seed files."""
    tax = read(os.path.join(repo, "apps/api/seed/taxonomy.sql"))
    trades = read(os.path.join(repo, "apps/api/seed/trades.sql"))
    out = {}
    for facet, src, table in (("categories", tax, "taxonomy_categories"), ("audiences", tax, "taxonomy_audiences"),
                              ("phases", tax, "taxonomy_phases"), ("trades", trades, "taxonomy_trades")):
        block = src[src.index('INSERT INTO "%s"' % table):]
        block = block[: block.index("ON CONFLICT")]
        rows = re.findall(r"^  \('[^']*', '([^']*)', '([^']*)', '(?:[^']|'')*', (\d+)", block, re.M)
        out[facet] = {slug: (name, int(order)) for slug, name, order in rows}
    return out


def sentence(name):
    words = name.replace(" & ", " and ").split(" ")
    words = [w if (len(w) > 1 and w.upper() == w and any(c.isalpha() for c in w)) else w.lower() for w in words]
    s = " ".join(words)
    return s[0].upper() + s[1:]


ARROW = '<svg class="ico s" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'


def build_columns(V):
    cols, secs = [], []
    for i, (facet, label, key, by_count) in enumerate(FACETS):
        counts = COUNTS[facet]
        for slug in counts:
            assert slug in V[facet], (facet, slug)
        if by_count:
            terms = sorted(counts, key=lambda s: -counts[s])
            vals = [counts[s] for s in terms]
            assert vals == sorted(vals, reverse=True) and len(set(vals)) == len(vals), facet
        else:
            assert set(counts) == set(V[facet]), "every phase needs a count"
            terms = sorted(V[facet], key=lambda s: V[facet][s][1])
        # Categories keep enough terms to fill N after the largest key set is taken out.
        terms = terms[: MAX_N + (len(KEY) if facet == "categories" else 0)]
        more = "See all " + label.lower()
        items, mitems = [], []
        shown = 0
        for r, slug in enumerate(terms, 1):
            name, n = sentence(V[facet][slug][0]), counts[slug]
            k = KEY.index(slug) + 1 if facet == "categories" and slug in KEY else 0
            if k and k <= DEFAULT_K:
                hid = True
            else:
                shown += 1
                hid = shown > DEFAULT_N
            attrs = 'data-r="%d"%s%s' % (r, ' data-key="%d"' % k if k else "", " hidden" if hid else "")
            items.append('                <li %s><a href="#"><span class="t">%s</span><span class="m">%d products</span></a></li>' % (attrs, name, n))
            mitems.append('<li %s><a href="#">%s<span class="n">%d<span class="sr"> products</span></span></a></li>' % (attrs, name, n))
        items.append('                <li class="cm-more"><a class="cm-all" href="#">%s%s</a></li>' % (more, ARROW))
        mitems.append('<li class="cm-more"><a class="cm-all" href="#">%s%s</a></li>' % (more, ARROW))
        cols.append('            <div class="cm-col cm-fac" style="--i:%d" data-facet="%s">\n'
                    '              <h2 class="cm-ov" id="cmOv%s">%s</h2>\n'
                    '              <ul class="cm-list" aria-labelledby="cmOv%s">\n%s\n              </ul>\n'
                    '            </div>' % (i + 1, facet, key, label, key, "\n".join(items)))
        secs.append('      <li class="mm-fac" data-facet="%s">\n'
                    '        <button type="button" class="mm-dis" id="mmDis%s" aria-expanded="false" aria-controls="mmSec%s">%s<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>\n'
                    '        <div class="mm-sec" id="mmSec%s" hidden><ul aria-labelledby="mmDis%s">%s</ul></div>\n'
                    '      </li>' % (facet, key, key, label, key, key, "".join(mitems)))
    return "\n".join(cols), "\n".join(secs)


def build_explore(V):
    """The Explore column: All products, then the key categories as large links. Same markup idea on mobile."""
    keys = []
    for k, slug in enumerate(KEY, 1):
        assert slug in V["categories"] and slug in COUNTS["categories"], slug
        keys.append((k, sentence(V["categories"][slug][0]), COUNTS["categories"][slug]))
    hid = lambda k: " hidden" if k > DEFAULT_K else ""
    col = ('            <div class="cm-col cm-exp" style="--i:0">\n'
           '              <h2 class="cm-ov" id="cmOvExp">Explore</h2>\n'
           '              <a class="cm-big cm-total" href="#all-products"><span class="t">All products</span><span class="m">%d products</span></a>\n'
           '              <p class="cm-sub" id="cmOvKey">Key categories</p>\n'
           '              <ul class="cm-keys" aria-labelledby="cmOvKey">\n%s\n              </ul>\n'
           '            </div>' % (TOTAL, "\n".join(
               '                <li data-k="%d"%s><a class="cm-big" href="#"><span class="t">%s</span><span class="m">%d products</span></a></li>' % (k, hid(k), name, n)
               for k, name, n in keys)))
    mob = ('      <li class="mm-exp">\n'
           '        <a class="mm-big mm-total" href="#all-products">All products<span class="n">%d<span class="sr"> products</span></span></a>\n'
           '        <p class="mm-sub" id="mmKeyLbl">Key categories</p>\n'
           '        <ul class="mm-keys" aria-labelledby="mmKeyLbl">%s</ul>\n'
           '      </li>' % (TOTAL, "".join(
               '<li data-k="%d"%s><a class="mm-big" href="#">%s<span class="n">%d<span class="sr"> products</span></span></a></li>' % (k, hid(k), name, n)
               for k, name, n in keys)))
    return col, mob


V = vocab()
print("vocabulary sizes:", {k: len(v) for k, v in V.items()})
COLS, SECS = build_columns(V)
EXP, MEXP = build_explore(V)
CARD = read(os.path.join(here, "catmenu-card.html")).rstrip("\n")
HEAD = read(os.path.join(here, "catmenu-head.html")).rstrip("\n") + "\n"
HEAD = HEAD.replace("<!--CM_COLS-->", COLS).replace("<!--MM_SECS-->", SECS).replace("<!--CM_EXP-->", EXP).replace("<!--MM_EXP-->", MEXP)
HEAD = HEAD.replace("<!--CM_FOOT-->", FOOT)
HEAD = HEAD.replace("<!--CM_CARD-->\n", "\n".join("            " + l for l in CARD.split("\n")) + "\n", 1)
HEAD = HEAD.replace("<!--CM_CARD-->", CARD.replace("\n", "\n        "))
assert "<!--" not in HEAD
CSS = read(os.path.join(here, "catmenu.css")).rstrip("\n")
JS = read(os.path.join(here, "catmenu.js")).rstrip("\n")
NOPT = "".join('\n    <label><input type="radio" name="cmN" value="%d"%s> Menu items per column: %d</label>' % (n, " checked" if n == DEFAULT_N else "", n) for n in N_OPTIONS)
KOPT = "".join('\n    <label><input type="radio" name="cmK" value="%d"%s> Key categories: %d</label>' % (k, " checked" if k == DEFAULT_K else "", k) for k in K_OPTIONS)
OPT = ('    <!-- catmenu-opt:start --><h5>HEADER</h5>\n    <label><input type="checkbox" id="optCatMenu"> Browse menu: open</label>' + KOPT + NOPT +
       '\n    <label><input type="radio" name="cmCard" value="on"> Menu card: on</label>'
       '\n    <label><input type="radio" name="cmCard" value="off" checked> Menu card: off</label><!-- catmenu-opt:end -->\n')


def header(s):
    pat = re.compile(r'<header class="site-head">.*?</header>\n(<div class="cm-scrim"[^\n]*\n)?', re.S)
    assert len(pat.findall(s)) == 1
    return pat.sub(lambda m: HEAD, s)


def option(s):
    s = re.sub(r"    <!-- catmenu-opt:start -->.*?<!-- catmenu-opt:end -->\n", "", s, flags=re.S)
    anchor = '  </div>\n  <button type="button" id="mockToggle"'
    assert s.count(anchor) == 1
    return s.replace(anchor, OPT + anchor)


def css_js(s):
    for old, new in ((".nav a {", ".nav > a {"), (".nav a:hover", ".nav > a:hover"), (".nav a.signin", ".nav > a.signin")):
        s = s.replace(old, new)
    s = re.sub(r"/\* catmenu:start \*/.*?/\* catmenu:end \*/\n", "", s, flags=re.S)
    i = s.index("/* rulings:start */") if "/* rulings:start */" in s else s.index("</style>")
    s = s[:i] + "/* catmenu:start */\n" + CSS + "\n/* catmenu:end */\n" + s[i:]
    s = re.sub(r"  /\* catmenu-js:start \*/.*?/\* catmenu-js:end \*/\n", "", s, flags=re.S)
    m = re.search(r"  function has\(list, x\)[^\n]*\n", s)
    return s[: m.end()] + "  /* catmenu-js:start */\n" + JS + "\n  /* catmenu-js:end */\n" + s[m.end():]


for name, full in (("5-statement-first.html", True), ("6-product-detail.html", True), ("src/7-body.html", False), ("src/8-body.html", False)):
    p = os.path.join(root, name)
    s = option(header(read(p)))
    if full:
        s = css_js(s)
    open(p, "w").write(s)
    print("injected", name)

subprocess.run([sys.executable, os.path.join(here, "build.py")], check=True)
