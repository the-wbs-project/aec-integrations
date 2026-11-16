"""Build mock-ups 11 (the vendor page) and 12 (the pair page with integrations), AECI-1791.

Usage, from this folder:  python3 -I 11-build.py
Reads 11-data.json (the production snapshot, see 11-snapshot.py), 11.css and
10-wordmark.svg, and writes ../11-vendor.html and ../12-pair.html.

Every name, count, fact, date and order comes from 11-data.json, except what the
"Illustrative states" option turns on in mock-up 12. Those values are marked
ILLUSTRATIVE below and on the page, because production has no example yet.
"""

import json
from datetime import datetime
from html import escape
from pathlib import Path

HERE = Path(__file__).parent
D = json.loads((HERE / "11-data.json").read_text())
CSS = (HERE / "11.css").read_text()
WORDMARK = (HERE / "10-wordmark.svg").read_text()


def e(s):
    return escape(str(s), quote=True)


def initial(name):
    return name.strip()[0].upper()


def plural(n, one, many):
    return f"{n:,} {one if n == 1 else many}"


def long_date(iso):
    """MMMM d, y in UTC: the maintenance marker and the field caption."""
    d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return f"{d:%B} {d.day}, {d.year}"


def short_date(iso):
    """MMM d, y in UTC: the company facts source line."""
    d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return f"{d:%b} {d.day}, {d.year}"


# ---------------------------------------------------------------- shared pieces

ICONS = """
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></symbol>
  <symbol id="i-chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
  <symbol id="i-grid" viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></symbol>
  <symbol id="i-list" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></symbol>
  <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></symbol>
  <symbol id="i-ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
  <symbol id="i-flag" viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></symbol>
  <symbol id="i-pen" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></symbol>
  <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></symbol>
  <symbol id="i-arrow" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></symbol>
"""

# Brand glyphs, copied from vendors/vendor-detail.ts (fill, 24 by 24).
SOCIAL = {
    "linkedin": ("LinkedIn", "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z"),
    "x": ("X (Twitter)", "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"),
    "youtube": ("YouTube", "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"),
    "facebook": ("Facebook", "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"),
    "instagram": ("Instagram", "M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z"),
}
SOCIAL_ORDER = ["linkedin", "x", "youtube", "facebook", "instagram"]


def ico(name, size=""):
    cls = "ico" + (f" {size}" if size else "")
    return f'<svg class="{cls}" aria-hidden="true"><use href="#i-{name}"/></svg>'


NEW_TAB = '<span class="sr"> (opens in a new tab)</span>' + ico("ext", "xs")

HEADER = f"""<a class="skip" href="#main">Skip to main content</a>

<header class="site-head">
  <div class="wrap">
    <a class="wordmark" href="#" aria-label="AEC Integrations home"><svg viewBox="0 0 196 30" aria-hidden="true" focusable="false"><use href="#wm"/></svg></a>
    <div class="head-search" role="search">
      <label class="sr" for="header-search">Search directory</label>
      {ico("search")}
      <input id="header-search" type="search" placeholder="Search directory" aria-keyshortcuts="Control+/">
      <kbd aria-hidden="true">Ctrl /</kbd>
    </div>
    <nav class="head-nav" aria-label="Primary">
      <a href="#" aria-expanded="false" aria-haspopup="true">Browse {ico("chev", "s")}</a>
      <a href="#">How we rank</a>
      <a href="#">For vendors</a>
    </nav>
    <div class="head-actions">
      <a class="btn btn-on-brand btn-signin" href="#">Sign in</a>
      <button class="menu-btn" type="button" aria-label="Menu" aria-expanded="false">{ico("menu")}</button>
    </div>
  </div>
</header>"""

FOOTER = """<footer class="foot">
  <div class="wrap">
    <div class="foot-top">
      <div>
        <a class="wordmark" href="#" aria-label="AEC Integrations home"><svg viewBox="0 0 196 30" aria-hidden="true" focusable="false"><use href="#wm"/></svg></a>
        <p class="tag">The independent directory of AEC software integrations.</p>
      </div>
      <div class="foot-cols">
        <nav aria-label="Directory"><p class="overline">Directory</p><ul><li><a href="#">Home</a></li><li><a href="#">Products</a></li><li><a href="#">Categories</a></li><li><a href="#">Audiences</a></li><li><a href="#">Trades</a></li><li><a href="#">Phases</a></li></ul></nav>
        <nav aria-label="Help"><p class="overline">Help</p><ul><li><a href="#">Help center</a></li><li><a href="#">Getting started</a></li><li><a href="#">How ranking works</a></li><li><a href="#">Vendor guide</a></li></ul></nav>
        <nav aria-label="Legal"><p class="overline">Legal</p><ul><li><a href="#">Terms</a></li><li><a href="#">Privacy</a></li><li><a href="#">Review guidelines</a></li><li><a href="#">Listing accuracy</a></li><li><a href="#">Vendor terms</a></li><li><a href="#">Managed plan agreement</a></li><li><a href="#">Third-party notices</a></li></ul></nav>
        <nav aria-label="Company"><p class="overline">Company</p><ul><li><a href="#">About</a></li><li><a href="#">Methodology</a></li><li><a href="#">For vendors</a></li><li><a href="#">Contact</a></li><li><a href="#">Updates</a></li><li><a href="#">Roadmap</a></li></ul></nav>
      </div>
    </div>
  </div>
  <div class="foot-base"><div class="wrap"><p>© 2026 AEC Integrations.</p></div></div>
</footer>"""

UNCLAIMED = "Unclaimed · not affiliated with or endorsed by this vendor"


def signup(p, ground):
    """shared/mailing-list-signup: copy unchanged. ground = 'bone' or 'white'."""
    return f"""<section class="mail {ground}" aria-labelledby="{p}-signup-title">
  <div class="wrap">
    <div class="card signup">
      <p class="overline">Directory updates</p>
      <h2 id="{p}-signup-title">Know when new tools and reviews land</h2>
      <p class="body">AEC Integrations is live and still growing. Add your email for occasional updates as we expand the directory with new tools, integrations, and reviews.</p>
      <form action="#" novalidate>
        <div class="row">
          <label class="sr" for="{p}-email">Email address</label>
          <input class="field" id="{p}-email" type="email" autocomplete="email" placeholder="you@yourfirm.com">
          <button class="btn btn-primary" type="submit">Subscribe</button>
        </div>
        <div class="sel">
          <span class="field-label" id="{p}-fv-label">How did you find AEC Integrations? (optional)</span>
          <button class="field select" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="{p}-fv-label {p}-fv-value"><span id="{p}-fv-value">Choose one</span>{ico("chev", "s")}</button>
        </div>
      </form>
    </div>
  </div>
</section>"""


def crumbs(items):
    lis = []
    for label in items[:-1]:
        lis.append(f'<li><a href="#">{e(label)}</a></li>')
    lis.append(f'<li><span aria-current="page">{e(items[-1])}</span></li>')
    return f'<nav class="crumbs" aria-label="Breadcrumb"><ol>{"".join(lis)}</ol></nav>'


def maintenance_chip(m, owner=None, dated=True):
    """aec-maintenance-marker: two labels only, the date when last_reviewed_at is set."""
    if m["maintained_by"] == "vendor":
        lead = "Vendor maintained"
        sr = f'<span class="sr">: {e(owner)} keeps this up to date</span>' if owner else ""
        date = f" · Updated {long_date(m['last_reviewed_at'])}" if dated and m["last_reviewed_at"] else ""
    else:
        lead, sr = "AEC Integrations maintained", ""
        date = f" · Reviewed {long_date(m['last_reviewed_at'])}" if dated and m["last_reviewed_at"] else ""
    return f'<span class="chip label"><span>{lead}{sr}{date}</span></span>'


def mark(name, logo_url, cls=""):
    """aec-logo-or-initial. A logo only where the payload carries one (claimed)."""
    if logo_url:
        return f'<span class="logo {cls}"><img src="{e(logo_url)}" alt="{e(name)} logo" width="104" height="104"></span>'
    return f'<span class="tile {cls}" aria-hidden="true">{e(initial(name))}</span>'


OPTIONS_SCRIPT = """<script>
// Options: each radio group sets one data attribute on <html>. The URL hash can preset
// them for screenshots, e.g. 12-pair.html#pair=jobtread&states=illustrative.
(function () {
  var root = document.documentElement;
  var params = new URLSearchParams(location.hash.slice(1));
  function sync() {
    var t = document.querySelector('.pg[data-for="' + (root.dataset.vendor || root.dataset.pair) + '"]');
    if (t) document.title = t.dataset.title;
    document.querySelectorAll('[data-view-btn]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.viewBtn === root.dataset[b.dataset.key]));
    });
    document.querySelectorAll('#mockPanel input').forEach(function (i) { i.checked = root.dataset[i.name] === i.value; });
  }
  document.querySelectorAll('#mockPanel input[type=radio]').forEach(function (input) {
    if (params.get(input.name) === input.value) input.checked = true;
    if (input.checked) root.dataset[input.name] = input.value;
    input.addEventListener('change', function () { root.dataset[input.name] = input.value; sync(); });
  });
  document.querySelectorAll('[data-view-btn]').forEach(function (b) {
    b.addEventListener('click', function () { root.dataset[b.dataset.key] = b.dataset.viewBtn; sync(); });
  });
  // The Sources popover: a disclosure. Escape closes it and returns focus.
  document.querySelectorAll('.prov-btn').forEach(function (b) {
    var pop = document.getElementById(b.getAttribute('aria-controls'));
    b.addEventListener('click', function () {
      var open = pop.classList.toggle('open');
      b.setAttribute('aria-expanded', String(open));
    });
    pop.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { pop.classList.remove('open'); b.setAttribute('aria-expanded', 'false'); b.focus(); }
    });
  });
  var mock = document.getElementById('mock');
  var toggle = document.getElementById('mockToggle');
  toggle.addEventListener('click', function () {
    var open = mock.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  if (params.has('panel')) { mock.classList.add('open'); toggle.setAttribute('aria-expanded', 'true'); }
  if (params.has('sources')) document.querySelectorAll('.pg[data-for="' + root.dataset.pair + '"] .prov-btn').forEach(function (b, i) { if (i === 0) b.click(); });
  sync();
})();
</script>"""


def page(title, comment, attrs, body, options):
    return f"""<!doctype html>
<html lang="en" {attrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,400..700;1,400..700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<!--
{comment}

  GENERATED by src/11-build.py from src/11-data.json and src/11.css. Edit those, then rebuild.
  Header and footer: copied from mock-ups 9 and 10, not redesigned.
  Data: production, read on 2026-11-16 through the public API (src/11-snapshot.py).
  The Options control (bottom right) switches states. Its defaults are the
  recommendation, not decisions. Decision note: ../records/11-vendor-and-pair-notes.md.
-->
<style>
{CSS}</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
{WORDMARK}{ICONS}</svg>

{HEADER}

{body}

{FOOTER}

{options}

{OPTIONS_SCRIPT}
</body>
</html>
"""


# ================================================================ 11: the vendor page

SIZE = {"1-10": "1–10", "11-50": "11–50", "51-200": "51–200", "201-1000": "201–1,000", "1001+": "1,001+"}
OWNERSHIP = {"public": "Public", "private": "Private", "subsidiary": "Subsidiary", "nonprofit": "Nonprofit"}
FUNDING = {"Public": "Publicly traded"}


def fact_rows(f):
    """aec-company-facts: in its own order, a null fact is not a row."""
    rows = []
    spec = [
        ("headquarters", "Headquarters", lambda v: v),
        ("founded_year", "Founded", str),
        ("company_size", "Employees", lambda v: SIZE.get(v, v)),
        ("ownership_type", "Ownership", lambda v: OWNERSHIP.get(v, v)),
        ("parent_company", "Parent company", lambda v: v),
        ("funding_stage", "Funding stage", lambda v: FUNDING.get(v, v)),
    ]
    for key, label, fmt in spec:
        fact = f.get(key)
        if not fact:
            continue
        s = fact["source"]
        who = "Set by the vendor" if s["set_by"] == "vendor" else "Set by AEC Integrations"
        note = f"{who} on {short_date(s['date'])}" if s.get("date") else who
        link = (
            f' <a href="{e(s["url"])}" target="_blank" rel="noopener nofollow">Source<span class="sr">: {e(label)}</span>{NEW_TAB}</a>'
            if s.get("url")
            else ""
        )
        rows.append(f'<div><dt>{e(label)}</dt><dd class="v">{e(fmt(fact["value"]))}</dd><dd class="src">{note}{link}</dd></div>')
    return rows


def vendor_rows(v):
    out = []
    for p in v["products"]:
        n = p["integrations"]
        stat = (
            '<span class="rt-none">Not yet connected</span>'
            if n == 0
            else f'<span class="istat"><b class="num">{n}</b><span>{"integration" if n == 1 else "integrations"}</span></span>'
        )
        out.append(f"""<tr>
  <td><span class="ncell">{mark(p["name"], p["logo_url"])}<a href="#">{e(p["name"])}</a></span></td>
  <td class="end md-only"><span class="rt-none" aria-hidden="true">–</span><span class="sr">No ratings yet</span></td>
  <td class="end">{stat}</td>
  <td class="end go"><a href="#" aria-label="View {e(p["name"])}">{ico("arrow")}</a></td>
</tr>""")
    return "".join(out)


def vendor_cards(v):
    out = []
    for p in v["products"]:
        n = p["integrations"]
        stat = (
            '<span class="stat-none">Not yet connected</span>'
            if n == 0
            else f'<span class="chip quiet icon">{ico("link", "xs")}<span><span class="num">{n}</span> {"integration" if n == 1 else "integrations"}</span></span>'
        )
        out.append(f"""<li><div class="card pcard">
  <div class="top">{mark(p["name"], p["logo_url"])}{stat}</div>
  <p class="nm"><a href="#">{e(p["name"])}</a></p>
</div></li>""")
    return "".join(out)


def vendor_page(slug):
    v = D["vendors"][slug]
    p = slug[:2]
    name = v["name"]
    claimed = v["claim_status"] == "claimed"
    hero_mark = f'{mark(name, v["logo_url"], "mark-hero")}' if claimed else ""
    unc = "" if claimed else f'<p class="unc">{mark(name, None)}<span>{UNCLAIMED}</span></p>'
    socials = "".join(
        f'<li><a class="btn btn-on-brand-ghost btn-icon" href="{e(v["social"][k])}" target="_blank" rel="noopener nofollow" aria-label="{SOCIAL[k][0]} (opens in a new tab)" title="{SOCIAL[k][0]}"><svg class="ico fill" viewBox="0 0 24 24" aria-hidden="true" width="18" height="18"><path d="{SOCIAL[k][1]}"/></svg></a></li>'
        for k in SOCIAL_ORDER
        if k in v["social"]
    )
    social = f'<ul class="social" aria-label="Social links">{socials}</ul>' if socials else ""
    facts = fact_rows(v["company_facts"])
    count = len(v["products"])
    return f"""<div class="pg" data-for="{slug}" data-title="{e(name)} products and integrations | AEC Integrations">
<section class="hero" aria-labelledby="{p}-name">
  <div class="wrap">
    {crumbs(["Home", name])}
    <div class="eyebrow"><p class="overline">Vendor</p>{maintenance_chip(v["maintenance"], owner=name)}</div>
    <div class="v-namerow">{hero_mark}<h1 class="v-name" id="{p}-name"><span>{e(name)}</span></h1></div>
    {unc}
    <p class="lede v-desc">{e(v["description"])}</p>
    <div class="hero-acts">
      <a class="btn btn-on-brand" href="{e(v["website"])}" target="_blank" rel="noopener nofollow">Visit website{NEW_TAB}</a>
      {social}
    </div>
  </div>
</section>

<div class="facts-ground">
  <div class="wrap">
    <div class="card facts">
      <section class="f-stat" aria-labelledby="{p}-glance">
        <h2 class="overline" id="{p}-glance">At a glance</h2>
        <dl class="stat-dl">
          <div class="figure-pair"><dt class="fig-l">Products</dt><dd class="fig num">{v["product_count"]}</dd></div>
          <div class="inline-pair"><dt>Integrations</dt><dd class="num">{v["integration_count"]}</dd></div>
        </dl>
      </section>
      <section class="f-facts" aria-labelledby="{p}-facts">
        <h2 class="overline" id="{p}-facts">Company facts</h2>
        <dl class="cf">{"".join(facts)}</dl>
      </section>
      <section class="f-acts-sec" aria-labelledby="{p}-acts">
        <h2 class="overline" id="{p}-acts">Actions</h2>
        <div class="f-acts">
          <a class="btn btn-secondary" href="#">{ico("flag", "s")}Claim {e(name)}</a>
          <a class="btn btn-secondary" href="#">{ico("pen", "s")}Suggest a correction</a>
        </div>
      </section>
    </div>
    <p class="ogl">Company facts may include public sector information licensed under the <a class="inlink" href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" target="_blank" rel="noopener nofollow">Open Government Licence v3.0{NEW_TAB}</a>.</p>
    <section class="about" aria-labelledby="{p}-about">
      <h2 id="{p}-about">About</h2>
      <p>{e(v["description"])}</p>
    </section>
  </div>
</div>

<section class="band" aria-labelledby="{p}-products">
  <div class="wrap">
    <div class="band-head">
      <div>
        <h2 id="{p}-products">Products<span class="c num">{count}</span></h2>
        <p class="order">A to Z by name.</p>
      </div>
    </div>
    <div class="tbl-wrap v-table"><table class="p-table" aria-label="Products">
      <thead><tr><th scope="col">Product</th><th scope="col" class="end md-only">Rating</th><th scope="col" class="end">Integrations</th><th scope="col"><span class="sr">Details</span></th></tr></thead>
      <tbody>{vendor_rows(v)}</tbody>
    </table></div>
    <ul class="grid v-cards" role="list">{vendor_cards(v)}</ul>
  </div>
</section>

{signup(p, "white")}
</div>"""


VENDOR_OPTIONS = """<div id="mock">
  <div id="mockPanel">
    <fieldset><legend>Vendor</legend>
      <label><input type="radio" name="vendor" value="autodesk" checked> Autodesk: unclaimed, 19 products</label>
      <label><input type="radio" name="vendor" value="rental-leak"> Rental Leak: claimed, vendor maintained</label>
    </fieldset>
    <fieldset><legend>Description (question 3)</legend>
      <label><input type="radio" name="about" value="hero" checked> In the hero, as the lede (recommended)</label>
      <label><input type="radio" name="about" value="band"> In an About section, as today</label>
    </fieldset>
    <fieldset><legend>Products list (question 4)</legend>
      <label><input type="radio" name="pview" value="table" checked> Table, as today (recommended)</label>
      <label><input type="radio" name="pview" value="cards"> Cards</label>
    </fieldset>
  </div>
  <button type="button" id="mockToggle" aria-expanded="false" aria-controls="mockPanel">Options</button>
</div>"""

VENDOR_HTML = page(
    "Autodesk products and integrations | AEC Integrations",
    "  Mock-up 11: the vendor page, /vendors/:slug, in the November 2026 design language (AECI-1791).\n"
    "  Build issue: AECI-1797. It moves vendor-detail.ts onto DetailLayout's band shell.",
    'data-vendor="autodesk" data-about="hero" data-pview="table"',
    f'<main id="main">\n{vendor_page("autodesk")}\n{vendor_page("rental-leak")}\n</main>',
    VENDOR_OPTIONS,
)

# ================================================================ 12: the pair page

GLYPH = {"outbound": "→", "inbound": "←", "both": "⇄"}
DEPTH = {"outbound": "Outbound", "inbound": "Inbound", "both": "Both"}
KIND = {"native": "Native", "ipaas": "iPaaS", "marketplace_app": "Marketplace app", "api": "API", "webhook": "Webhook", "partner": "Partner", "integrator": "Integrator"}


def lane_heading(direction, other):
    return {"outbound": f"Sends to {other}", "inbound": f"Receives from {other}", "both": "Syncs both ways"}[direction]


def sync_headline(total):
    return "1 type of data shared" if total == 1 else f"{total} types of data shared"


# ILLUSTRATIVE: production has no confirmed, single-source, conflicting or refuted
# claim, no version data and no row caption on these pairs. These values only show
# where each state sits. They are drawn under data-states="illustrative".
ILLUS = {
    "jobtread": {
        "versions": ("JobTread version", "2026.2", "QuickBooks Online version", "Latest"),
        "summary": "Changes from 2026.1 · 1 added, 1 removed",
        "rows": {
            "Cost Codes": ("confirmed", None, "added"),
            "Directory & Contacts": ("single_source", "JobTread", None),
            "Invoices & Payments": ("conflict", None, None),
            "Time & Labor": ("refuted", None, None),
            "Documents": ("unverified", None, "removed"),
        },
        "caption": "Maintained by JobTread · updated October 21, 2026",
    },
    "rental-leak": {
        "versions": ("Rental Leak version", "Latest", "QuickBooks Online version", "Latest"),
        "summary": None,
        "rows": {"Invoices & Payments": ("single_source", "Rental Leak", None)},
        "caption": "Maintained by Rental Leak · updated October 21, 2026",
    },
}

BADGE = {
    "unverified": ("", "dot", "Listed by AEC Integrations", "Listed by AEC Integrations from public sources. Neither company has confirmed it yet."),
    "refuted": ("", "dot strong", "A company says no", "One of these companies says this does not happen. Neither company has confirmed it."),
    "confirmed": ("confirmed", "dot", "Confirmed by both companies", "Confirmed by both companies."),
    "conflict": ("conflict", None, "Companies disagree", "The two companies disagree about this."),
}


def badge(state, vendor=None):
    """aec-agreement-badge: four states, only "Confirmed by both companies" is green."""
    if state == "single_source":
        label = f"Confirmed by {vendor}" if vendor else "Confirmed by one company"
        aria = f"Confirmed by {vendor}. The other company has not answered yet." if vendor else "Confirmed by one company. The other company has not answered yet."
        tone, dot = "", "dot strong"
    else:
        tone, dot, label, aria = BADGE[state]
    mark_ = ico("x", "xs") if dot is None else f'<span class="{dot}" aria-hidden="true"></span>'
    # The chip's visible text is short. Its full meaning is in sr text, never an aria-label on a span.
    return f'<span class="chip label {tone}">{mark_}<span aria-hidden="true">{e(label)}</span><span class="sr">{e(aria)}</span></span>'


def provenance(pid, data_object, entries, closing):
    lis = "".join(f'<li>{e(w)}{(" <span>" + e(s) + "</span>") if s else ""}</li>' for w, s in entries)
    return f"""<span class="prov-wrap">
  <button class="prov-btn" type="button" aria-expanded="false" aria-controls="{pid}" aria-label="Sources for {e(data_object)}">{ico("info")}</button>
  <span class="prov" id="{pid}" role="group" aria-label="Sources for {e(data_object)}">
    <span class="overline" style="display:block">Sources</span>
    <ul>{lis}</ul>
    <p>{e(closing)}</p>
  </span>
</span>"""


def claim_row(key, i, c, pair, illus):
    ctx_vendor, other_vendor = pair["context"]["vendor"], pair["other"]["vendor"]
    pid = f"{key}-src-{i}"
    real = badge("refuted" if c["refuted"] else c["agreement"])
    real_prov = provenance(pid, c["data_object"], [("Listed by AEC Integrations", None)], "Neither company has confirmed this yet.")
    state, by, diff = illus["rows"].get(c["data_object"], (c["agreement"], None, None))
    if state == "confirmed":
        ip = ([(ctx_vendor, "confirms this"), (other_vendor, "confirms this")], "Both companies confirm this.")
    elif state == "single_source":
        silent = other_vendor if by == ctx_vendor else ctx_vendor
        ip = ([(by, "confirms this")], f"{silent} has not answered yet. Only one company has confirmed this.")
    elif state == "conflict":
        ip = ([(ctx_vendor, "confirms this"), (other_vendor, "says this is not accurate")], f"{ctx_vendor} and {other_vendor} disagree about this. We show both answers and do not take sides.")
    elif state == "refuted":
        ip = ([("Listed by AEC Integrations", None), (other_vendor, "says this is not accurate")], "Neither company has confirmed this yet.")
    else:
        ip = ([("Listed by AEC Integrations", None)], "Neither company has confirmed this yet.")
    ill_badge = badge(state, by)
    ill_prov = provenance(pid + "i", c["data_object"], *ip)
    diff_html = ""
    if diff == "added":
        diff_html = '<span class="diff illus flex"><span aria-hidden="true">+</span><span class="overline">New in 2026.2</span></span>'
    elif diff == "removed":
        diff_html = '<span class="diff illus flex"><span aria-hidden="true">−</span><span class="overline">Removed in 2026.2</span></span>'
    cls = f' data-diff="{diff}"' if diff else ""
    return f"""<li class="crow"{cls}>
  <span class="nm"><b>{e(c["data_object"])}</b>{diff_html}</span>
  <span class="end"><span class="real-only">{real}</span><span class="illus">{ill_badge}</span><span class="real-only">{real_prov}</span><span class="illus">{ill_prov}</span></span>
</li>"""


def mechanism(key, i, m, pair, single):
    other = pair["other"]["name"]
    illus = ILLUS[key]
    title = m["mechanism_name"] or KIND.get(m["mechanism_kind"], "Integration")
    eff = m["effective_direction"]
    depth = (
        f'<span class="chip quiet"><span class="sr">Direction:</span><span class="g" aria-hidden="true">{GLYPH[eff]}</span><span>{DEPTH[eff]}</span></span>'
        if eff
        else ""
    )
    objs = "" if single else f'<span class="chip quiet">{"1 type of data" if len(m["claims"]) == 1 else f"{len(m["claims"])} types of data"}</span>'
    desc = f'<p class="desc">{e(m["description"])}</p>' if m["description"] else ""
    # At a glance
    facts = []
    if m["pricing_model"] or m["pricing_url"]:
        txt = e(m["pricing_model"]) if m["pricing_model"] else "See pricing"
        val = f'<a class="inlink" href="{e(m["pricing_url"])}" target="_blank" rel="noopener nofollow">{txt}{NEW_TAB}</a>' if m["pricing_url"] else txt
        facts.append(f"<div><dt>Price</dt><dd>{val}</dd></div>")
    if m["maturity"]:
        facts.append(f"<div><dt>Release stage</dt><dd>{e(m['maturity'])}</dd></div>")
    how = []
    if m["mechanism_name"] and m["mechanism_kind"]:
        how.append(f'<span class="s0">{KIND[m["mechanism_kind"]]}</span>')
    by = []
    if m["built_by_vendor"]:
        by.append(f'Offered by <a class="inlink" href="#">{e(m["built_by_vendor"])}</a>')
    if m["through"]:
        by.append(("through " if by else "Through ") + f'<a class="inlink" href="#">{e(m["through"])}</a>')
    if by:
        how.append(f'<span class="s">{", ".join(by)}</span>')
    if how:
        facts.append(f"<div><dt>How you get it</dt><dd>{''.join(how)}</dd></div>")
    if m["last_reviewed_at"]:
        facts.append(f'<div><dt>Last checked</dt><dd class="num">{long_date(m["last_reviewed_at"])}</dd></div>')
    glance = f'<div class="glance"><h4 class="overline">At a glance</h4><dl>{"".join(facts)}</dl></div>' if facts else ""
    # Lanes, in canonical order: outbound, inbound, both.
    lanes = []
    n = 0
    for direction in ("outbound", "inbound", "both"):
        rows = [c for c in m["claims"] if c["direction"] == direction]
        if not rows:
            continue
        lis = []
        for c in rows:
            lis.append(claim_row(f"{key}{i}", n, c, pair, illus))
            n += 1
        lanes.append(f"""<div class="lane">
  <div class="lane-h"><span class="g" aria-hidden="true">{GLYPH[direction]}</span><h4 class="overline">{e(lane_heading(direction, other))}</h4></div>
  <ul class="rows">{"".join(lis)}</ul>
</div>""")
    lanes_html = f'<div class="lanes{" two" if len(lanes) > 1 else ""}">{"".join(lanes)}</div>' if lanes else ""
    # Links: each side's own link first, labelled with its product; AECi's curated link as fallback.
    links = []
    vl = m["vendor_links"] or {}
    sides = [(vl.get("context"), pair["context"]), (vl.get("other"), pair["other"])]
    for kind, label_own, label_cur, url_cur in (
        ("listing_url", "listing", "View listing", m["listing_url"]),
        ("docs_url", "documentation", "Documentation", m["docs_url"]),
    ):
        own = [(s, prod) for s, prod in sides if s and s.get(kind)]
        if own:
            for s, prod in own:
                links.append(
                    f'<li><a class="link" href="{e(s[kind])}" target="_blank" rel="noopener nofollow">{e(prod["name"])} {label_own}{NEW_TAB}</a>'
                    f'<span class="from">Link from {e(prod["vendor"])}</span></li>'
                )
        elif url_cur:
            links.append(f'<li><a class="link" href="{e(url_cur)}" target="_blank" rel="noopener nofollow">{label_cur}{NEW_TAB}</a></li>')
    links_html = f'<ul class="mlinks">{"".join(links)}</ul>' if links else ""
    caption = f'<p class="caption illus block">{e(illus["caption"])}</p>'
    return f"""<article class="card mech" aria-labelledby="{key}-m{i}">
  <header class="mech-h"><h3 id="{key}-m{i}">{e(title)}</h3>{depth}{objs}</header>
  {desc}
  {glance}
  {lanes_html}
  {links_html}
  {caption}
</article>"""


def pair_side(key, which, prod, illus):
    claimed = prod["claim_status"] == "claimed"
    note = "" if claimed else f'<p class="side-unc">{UNCLAIMED}</p>'
    rate = ""
    if prod["rating"] is not None:
        rate = f'<p class="side-rate">★ {prod["rating"]:.1f} · {prod["reviews"]} reviews</p>'
    lab, val = (illus["versions"][0], illus["versions"][1]) if which == "a" else (illus["versions"][2], illus["versions"][3])
    ver = f"""<div class="ver illus block">
    <span class="field-label" id="{key}-{which}-vl">{e(lab)}</span>
    <button class="field select" type="button" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="{key}-{which}-vl {key}-{which}-vv"><span id="{key}-{which}-vv">{e(val)}</span>{ico("chev", "s")}</button>
  </div>"""
    return f"""<div class="card {which}">
  <div class="pside">{mark(prod["name"], prod["logo_url"], "lg")}<div><p class="nm"><a href="#">{e(prod["name"])}</a></p><p class="vd">{e(prod["vendor"] or "")}</p></div></div>
  {note}{rate}
  {ver}
</div>"""


def pair_page(key):
    pr = D["pairs"][key]
    a, b = pr["context"], pr["other"]
    illus = ILLUS[key]
    total = pr["sync_headline"]["total"]
    dirs = {m["effective_direction"] for m in pr["mechanisms"] if m["effective_direction"]}
    glyph = GLYPH[dirs.pop()] if len(dirs) == 1 else GLYPH["both"]
    single = len(pr["mechanisms"]) == 1 and total > 0
    mechs = "".join(mechanism(key, i, m, pr, single) for i, m in enumerate(pr["mechanisms"]))
    summary = (
        f'<p class="sub illus block"><span>{e(illus["summary"])}</span></p>'
        f'<button class="link latest illus" type="button">Show the latest versions</button>'
        if illus["summary"]
        else ""
    )
    return f"""<div class="pg" data-for="{key}" data-title="{e(a["name"])} and {e(b["name"])} integrations | AEC Integrations">
<div class="mock-note" role="note"><div class="wrap">Illustrative states are on: agreement states, versions and the field caption below are not production data.</div></div>
<section class="hero short" aria-labelledby="{key}-h1">
  <div class="wrap">
    {crumbs(["Home", a["name"], "Integrations", b["name"]])}
    <div class="pair-grid">
      <div>
        <div class="eyebrow"><p class="overline">Integration</p>{maintenance_chip(pr["maintenance"], dated=False)}</div>
        <h1 class="statement" id="{key}-h1">How <b>{e(a["name"])}</b> and <b>{e(b["name"])}</b> exchange data</h1>
      </div>
      <div class="rail" role="group" aria-label="The two products">
        {pair_side(key, "a", a, illus)}
        <div class="link-row" aria-hidden="true"><span class="medal"><span class="g">{glyph}</span>{e(sync_headline(total))}</span></div>
        {pair_side(key, "b", b, illus)}
      </div>
    </div>
  </div>
</section>

<section class="band" aria-labelledby="{key}-data">
  <div class="wrap">
    <div class="d-head">
      <div>
        <h2 id="{key}-data">{e(sync_headline(total))}</h2>
        {summary}
      </div>
      <div class="vtoggle" role="group" aria-label="Choose a view">
        <button type="button" data-key="view" data-view-btn="basic" aria-pressed="false">{ico("check", "s tick")}Basic</button>
        <button type="button" data-key="view" data-view-btn="detailed" aria-pressed="true">{ico("check", "s tick")}Detailed</button>
      </div>
    </div>
    <div class="mechs">{mechs}</div>
  </div>
</section>

{signup(key, "bone")}
</div>"""


PAIR_OPTIONS = """<div id="mock">
  <div id="mockPanel">
    <fieldset><legend>Pair</legend>
      <label><input type="radio" name="pair" value="rental-leak" checked> Rental Leak and QuickBooks Online: one side claimed, priced, checked</label>
      <label><input type="radio" name="pair" value="jobtread"> JobTread and QuickBooks Online: five types of data, two lanes</label>
    </fieldset>
    <fieldset><legend>View</legend>
      <label><input type="radio" name="view" value="detailed" checked> Detailed (the default today)</label>
      <label><input type="radio" name="view" value="basic"> Basic</label>
    </fieldset>
    <fieldset><legend>States</legend>
      <label><input type="radio" name="states" value="real" checked> Production data only</label>
      <label><input type="radio" name="states" value="illustrative"> Illustrative: the four agreement states, versions, a field caption</label>
    </fieldset>
  </div>
  <button type="button" id="mockToggle" aria-expanded="false" aria-controls="mockPanel">Options</button>
</div>"""

PAIR_HTML = page(
    "Rental Leak and QuickBooks Online integrations | AEC Integrations",
    "  Mock-up 12: the pair page with integrations, /products/:a/integrations/:b (AECI-1791).\n"
    "  It shares mock-up 5's hero: the statement left, the two products right. Build issue: AECI-1798.",
    'data-pair="rental-leak" data-view="detailed" data-states="real"',
    f'<main id="main">\n{pair_page("rental-leak")}\n{pair_page("jobtread")}\n</main>',
    PAIR_OPTIONS,
)

(HERE.parent / "11-vendor.html").write_text(VENDOR_HTML)
(HERE.parent / "12-pair.html").write_text(PAIR_HTML)
print("wrote", HERE.parent / "11-vendor.html", len(VENDOR_HTML))
print("wrote", HERE.parent / "12-pair.html", len(PAIR_HTML))
