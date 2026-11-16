"""Build mock-up 10, the browse lists (AECI-1790).

Usage, from this folder:  python3 -I 10-build.py
Reads 10-data.json (the production snapshot, see 10-snapshot.py), 10.css and
10-wordmark.svg, and writes ../10-browse.html. Every name, count and order in the
page comes from 10-data.json. Nothing is invented.
"""

import json
from html import escape
from pathlib import Path

HERE = Path(__file__).parent
D = json.loads((HERE / "10-data.json").read_text())
CSS = (HERE / "10.css").read_text()
WORDMARK = (HERE / "10-wordmark.svg").read_text()

ROBOTICS = next(c for c in D["categories_index"] if c["slug"] == "robotics")
LIFECYCLE = ["Concept & Planning", "Design", "Pre-Construction", "Construction", "Closeout & Operations"]
SHOW = 10  # aec-search-refinement-list shows the first 10 values, then "Show more (N)".


def e(s):
    return escape(str(s), quote=True)


def initial(name):
    return name.strip()[0].upper()


def plural(n, one, many):
    return f"{n:,} {one if n == 1 else many}"


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
"""


def ico(name, size=""):
    cls = "ico" + (f" {size}" if size else "")
    return f'<svg class="{cls}" aria-hidden="true"><use href="#i-{name}"/></svg>'


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
      <a href="#" id="nav-browse" aria-expanded="false" aria-haspopup="true">Browse {ico("chev", "s")}</a>
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


def signup(p):
    """shared/mailing-list-signup: copy unchanged. The page's one Bone band."""
    return f"""<section class="bone" aria-labelledby="{p}-signup-title">
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
    for label, link in items:
        if link:
            lis.append(f'<li><a href="#">{e(label)}</a></li>')
        else:
            lis.append(f'<li><span aria-current="page">{e(label)}</span></li>')
    return f'<nav class="crumbs" aria-label="Breadcrumb"><ol>{"".join(lis)}</ol></nav>'


# ---------------------------------------------------------------- filters


def refinement(p, label, terms, checked=()):
    """aec-search-refinement-list: checkboxes, first 10 plus checked, then Show more (N)."""
    if not terms:
        return ""
    gid = f"{p}-{label.lower().replace(' ', '-')}"
    shown = [t for i, t in enumerate(terms) if i < SHOW or t[0] in checked]
    hidden = len(terms) - len(shown)
    rows = []
    for name, count in shown:
        on = " checked" if name in checked else ""
        rows.append(
            f'<li><label class="fi"><input type="checkbox"{on}><span class="t">{e(name)}</span>'
            f'<span class="n num">({count})</span></label></li>'
        )
    more = (
        f'<button class="more" type="button" aria-expanded="false" aria-controls="{gid}">Show more ({hidden})</button>'
        if hidden > 0
        else ""
    )
    return (
        f'<fieldset class="fg"><legend class="overline">{e(label)}</legend>'
        f'<ul id="{gid}">{"".join(rows)}</ul>{more}</fieldset>'
    )


def numeric_menu(p, label):
    """aec-search-numeric-menu over integration_count: All, 0, 1-10, 11-50, 51+ (search-controller.ts)."""
    rows = []
    for i, b in enumerate(["All", "0", "1–10", "11–50", "51+"]):
        on = " checked" if i == 0 else ""
        rows.append(
            f'<li><label class="fi"><input type="radio" name="{p}-integration-count"{on}>'
            f'<span class="t">{b}</span></label></li>'
        )
    return f'<fieldset class="fg"><legend class="overline">{e(label)}</legend><ul>{"".join(rows)}</ul></fieldset>'


def nonzero(terms, checked=()):
    """facet-sidebar.ts: hide terms with no matches, but always keep a checked one."""
    return [t for t in terms if t[1] > 0 or t[0] in checked]


def panel(p, groups, active=0, order_note=""):
    badge = f'<span class="badge num" aria-hidden="true">{active}</span>' if active else ""
    sr_count = f'<span class="sr">, {active} active</span>' if active else ""
    clear = '<button class="link fclear" type="button">Clear filters</button>' if active else ""
    note = f'<p class="forder">{order_note}</p>' if order_note else ""
    return f"""<div class="fpanel">
      <button class="ftoggle" type="button" aria-expanded="false" aria-controls="{p}-fbody"><span>Filters{sr_count}{badge}</span>{ico("chev", "s")}</button>
      <div class="fbody" id="{p}-fbody">
        <h2 class="overline">Filters</h2>
        {"".join(groups)}
        {clear}
        {note}
      </div>
    </div>"""


ORDER_DB = "Phases in project order. Other terms A to Z."
ORDER_SEARCH = "Terms with the most matching products first. Phases in project order."


# ---------------------------------------------------------------- results


def stat_badge(n):
    if n == 0:
        return '<span class="stat-none">Not yet connected</span>'
    return f'<span class="chip quiet icon">{ico("link", "xs")}<span><span class="num">{n}</span> {"integration" if n == 1 else "integrations"}</span></span>'


def card(prod, first=False):
    role = ""
    if prod["role"] in ("connector", "hybrid"):
        role = f'<p><span class="chip">{prod["role"].capitalize()}</span></p>'
    vendor = e(prod["vendor"]) if prod["vendor"] else "Independent"
    cls = ' class="first"' if first else ""
    return f"""<li{cls}><div class="card pcard">
  <div class="top"><span class="tile" aria-hidden="true">{e(initial(prod["name"]))}</span>{stat_badge(prod["integrations"])}</div>
  <div class="body"><p class="nm"><a href="#">{e(prod["name"])}</a></p><p class="vd">{vendor}</p></div>
  {role}<p class="rated">Not yet rated</p>
</div></li>"""


def lead_card(prod):
    """The /products lead card as it ships (product-card-grid.ts). Shown only with Options."""
    vendor = e(prod["vendor"]) if prod["vendor"] else "Independent"
    n = prod["integrations"]
    stat = (
        '<span class="stat-none">Not yet connected</span>'
        if n == 0
        else f'<span class="istat"><b class="num">{n}</b><span>{"integration" if n == 1 else "integrations"}</span></span>'
    )
    return f"""<li class="lead"><div class="card pcard">
  <div class="top"><span class="tile lg" aria-hidden="true">{e(initial(prod["name"]))}</span><span class="eyebrow">Recently added</span></div>
  <div class="body"><p class="nm"><a href="#">{e(prod["name"])}</a></p><p class="vd">{vendor}</p></div>
  <p class="rated">Not yet rated</p>{stat}
</div></li>"""


def row(prod):
    vendor = prod["vendor"]
    v_mobile = f'<a class="vm" href="#">{e(vendor)}</a>' if vendor else ""
    v_cell = f'<a href="#">{e(vendor)}</a>' if vendor else '<span aria-hidden="true">–</span><span class="sr">No vendor listed</span>'
    n = prod["integrations"]
    i_cell = (
        '<span class="rt-none">Not yet connected</span>'
        if n == 0
        else f'<span class="istat"><b class="num">{n}</b><span>{"integration" if n == 1 else "integrations"}</span></span>'
    )
    rating = (
        '<span class="rt-dash"><span class="rt-none" aria-hidden="true">–</span><span class="sr">No ratings yet</span></span>'
        '<span class="rt-text rt-none">Not yet rated</span>'
    )
    return f"""<tr>
  <td><span class="ncell"><span class="tile" aria-hidden="true">{e(initial(prod["name"]))}</span><span><a href="#">{e(prod["name"])}</a>{v_mobile}</span></span></td>
  <td class="vd md-only">{v_cell}</td>
  <td class="end md-only">{rating}</td>
  <td class="end">{i_cell}</td>
</tr>"""


def toolbar(p, sort_label, view=True):
    toggle = ""
    if view:
        toggle = f"""<div class="vtoggle" role="group" aria-label="Choose a view">
      <button type="button" data-view-btn="cards" aria-pressed="true">{ico("grid", "s glyph")}{ico("check", "s tick")}Cards</button>
      <button type="button" data-view-btn="table" aria-pressed="false">{ico("list", "s glyph")}{ico("check", "s tick")}Table</button>
    </div>"""
    return f"""<div class="toolbar">
    <div class="sort"><span id="{p}-sort-label">Sort</span><button type="button" id="{p}-sort" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="{p}-sort-label {p}-sort"><span>{e(sort_label)}</span>{ico("chev", "s")}</button></div>
    {toggle}
  </div>"""


def results(p, items, total, sort_label, lead=False, pager_button=False):
    cards = "".join(card(x, first=(i == 0)) for i, x in enumerate(items))
    if lead and items:
        cards = lead_card(items[0]) + cards
    rows = "".join(row(x) for x in items)
    more = (
        '<button class="btn btn-secondary" type="button">Load more</button>'
        if pager_button
        else '<a class="btn btn-secondary" href="#">Load more</a>'
    )
    return f"""<section aria-label="Results">
  {toolbar(p, sort_label)}
  <div class="results-body">
    <ul class="grid v-cards" role="list">{cards}</ul>
    <div class="tbl-wrap v-table"><table aria-label="Products">
      <thead><tr><th scope="col">Name</th><th scope="col" class="md-only">Vendor</th><th scope="col" class="end md-only">Rating</th><th scope="col" class="end">Integrations</th></tr></thead>
      <tbody>{rows}</tbody>
    </table></div>
    <div class="pager">
      <p aria-live="polite" aria-atomic="true">Showing <span class="num">{len(items)}</span> of <span class="num">{total:,}</span></p>
      {more}
    </div>
  </div>
</section>"""


def empty_results(p, sort_label, inner):
    return f"""<section aria-label="Results">
  {toolbar(p, sort_label)}
  <div class="results-body"><div class="empty">{inner}</div></div>
</section>"""


# ---------------------------------------------------------------- pages

pf = D["products_facets"]
cf = D["category_facets"]
ef = D["empty_filters"]["facets"]
sf = D["search"]["facets"]
P = D["products"]
C = D["category"]
S = D["search"]


def page_products():
    groups = [
        refinement("pr", "Categories", nonzero(pf["categories"])),
        refinement("pr", "Audiences", nonzero(pf["audiences"])),
        refinement("pr", "Trades", nonzero(pf["trades"])),
        refinement("pr", "Phases", nonzero(pf["phases"])),
    ]
    return f"""<div class="pg" data-for="products">
  <div class="page-head"><div class="wrap">
    {crumbs([("Home", True), ("Products", False)])}
    <h1>Products</h1>
    <p class="lede">Every AEC software product indexed on AEC Integrations (<span class="num">{P["total"]:,}</span> in total).</p>
  </div></div>
  <div class="wrap browse">
    <aside aria-label="Filters">{panel("pr", groups, order_note=ORDER_DB)}</aside>
    {results("pr", P["items"], P["total"], "Newest", lead=True)}
  </div>
  {signup("pr")}
</div>"""


def page_products_empty():
    chk = (D["empty_filters"]["category"], D["empty_filters"]["trade"])
    groups = [
        refinement("pe", "Categories", nonzero(ef["categories"], chk), chk),
        refinement("pe", "Audiences", nonzero(ef["audiences"], chk), chk),
        refinement("pe", "Trades", nonzero(ef["trades"], chk), chk),
        refinement("pe", "Phases", nonzero(ef["phases"], chk), chk),
    ]
    return f"""<div class="pg" data-for="products-empty">
  <div class="page-head"><div class="wrap">
    {crumbs([("Home", True), ("Products", False)])}
    <h1>Products</h1>
    <p class="lede">Every AEC software product indexed on AEC Integrations (<span class="num">0</span> in total).</p>
  </div></div>
  <div class="wrap browse">
    <aside aria-label="Filters">{panel("pe", groups, active=2, order_note=ORDER_DB)}</aside>
    {empty_results("pe", "Newest", "<p>No products match these filters.</p>")}
  </div>
  {signup("pe")}
</div>"""


def page_category():
    groups = [
        refinement("ca", "Audiences", nonzero(cf["audiences"])),
        refinement("ca", "Trades", nonzero(cf["trades"])),
        refinement("ca", "Phases", nonzero(cf["phases"])),
    ]
    return f"""<div class="pg" data-for="category">
  <div class="page-head"><div class="wrap">
    {crumbs([("Home", True), ("Categories", True), (C["name"], False)])}
    <h1>{e(C["name"])}</h1>
    <p class="lede">{e(C["description"])}</p>
    <p class="count"><span class="num">{C["total"]}</span> products</p>
  </div></div>
  <div class="wrap browse">
    <aside aria-label="Filters">{panel("ca", groups, order_note=ORDER_DB)}</aside>
    {results("ca", C["items"], C["total"], "Newest", lead=True)}
  </div>
  {signup("ca")}
</div>"""


def page_category_empty():
    r = ROBOTICS
    return f"""<div class="pg" data-for="category-empty">
  <div class="page-head"><div class="wrap">
    {crumbs([("Home", True), ("Categories", True), (r["name"], False)])}
    <h1>{e(r["name"])}</h1>
    <p class="lede">{e(r["description"])}</p>
  </div></div>
  <div class="wrap empty-solo">
    <div class="empty">
      <p class="head">No products are tagged {e(r["name"])} yet.</p>
      <p>As the catalog grows, this page fills in on its own.</p>
      <a class="link" href="#">Browse all products</a>
    </div>
  </div>
  {signup("ce")}
</div>"""


def search_head(p, query, counts):
    tabs = []
    for i, (label, n) in enumerate(counts):
        sel = "true" if i == 0 else "false"
        cnt = f'<span class="n num">{n}</span>' if n else ""
        tabs.append(
            f'<button class="tab" type="button" role="tab" id="{p}-tab-{i}" aria-selected="{sel}" aria-controls="{p}-panel" tabindex="{0 if i == 0 else -1}">{label}{cnt}</button>'
        )
    return f"""<div class="page-head"><div class="wrap">
    {crumbs([("Home", True), ("Search", False)])}
    <h1>Search</h1>
    <form class="q-form" role="search" action="#">
      <label class="sr" for="{p}-q">Search the directory</label>
      {ico("search")}
      <input class="field" id="{p}-q" type="search" name="q" value="{e(query)}" placeholder="Search products and vendors" autocomplete="off">
    </form>
    <div class="tabs" role="tablist" aria-label="Search results by type">{"".join(tabs)}</div>
  </div></div>"""


FACTS_NOTE = (
    '<p class="facts-note">Company facts may include public sector information licensed under the '
    '<a class="inlink" href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/" '
    'target="_blank" rel="noopener nofollow">Open Government Licence v3.0<span class="sr"> (opens in a new tab)</span> '
    + '<svg class="ico xs" aria-hidden="true"><use href="#i-ext"/></svg></a>.</p>'
)


def page_search():
    groups = [
        refinement("se", "Categories", sf["categories"]),
        refinement("se", "Audiences", sf["audiences"]),
        # search-facet-order.ts: phases re-sorted to the project lifecycle; the rest keep Algolia's count order.
        refinement("se", "Phases", sorted(sf["phases"], key=lambda t: LIFECYCLE.index(t[0]))),
        refinement("se", "Trades", sf["trades"]),
        refinement("se", "Vendor", sf["vendor_name"]),
        numeric_menu("se", "Integrations"),
    ]
    return f"""<div class="pg" data-for="search">
  {search_head("se", S["query"], [("Products", S["products_total"]), ("Vendors", S["vendors_total"])])}
  <div class="wrap browse">
    <aside aria-label="Filters">{panel("se", groups, order_note=ORDER_SEARCH)}</aside>
    <div role="tabpanel" id="se-panel" aria-labelledby="se-tab-0">
      {results("se", S["items"], S["products_total"], "Newest", pager_button=True)}
      {FACTS_NOTE}
    </div>
  </div>
  {signup("se")}
</div>"""


def page_search_empty():
    inner = (
        '<p>No results. Try a broader search or <a class="inlink" href="#">browse by category</a>.</p>'
    )
    return f"""<div class="pg" data-for="search-empty">
  {search_head("sx", "geotextile loom", [("Products", 0), ("Vendors", 0)])}
  <div class="wrap browse">
    <aside aria-label="Filters">{panel("sx", [numeric_menu("sx", "Integrations")])}</aside>
    <div role="tabpanel" id="sx-panel" aria-labelledby="sx-tab-0">
      {empty_results("sx", "Newest", inner)}
      {FACTS_NOTE}
    </div>
  </div>
  {signup("sx")}
</div>"""


def page_categories():
    terms = sorted(D["categories_index"], key=lambda t: t["name"].casefold())
    cards = []
    for t in terms:
        counts = plural(t["products"], "product", "products") + " · " + plural(t["integrations"], "integration", "integrations")
        cards.append(
            f'<li><div class="card tcard"><h2><a href="#">{e(t["name"])}</a></h2>'
            f'<p class="d">{e(t["description"])}</p><p class="c num">{counts}</p></div></li>'
        )
    return f"""<div class="pg" data-for="categories">
  <div class="page-head"><div class="wrap">
    {crumbs([("Home", True), ("Categories", False)])}
    <h1>Categories</h1>
    <p class="lede">Browse AEC software by category. Each links to the products tagged with it.</p>
  </div></div>
  <div class="wrap index">
    {toolbar("ci", "Name (A–Z)", view=False)}
    <ul class="grid results-body" role="list">{"".join(cards)}</ul>
  </div>
  {signup("ci")}
</div>"""


OPTIONS = """<div id="mock">
  <div id="mockPanel">
    <fieldset><legend>Page</legend>
      <label><input type="radio" name="page" value="products" checked> /products</label>
      <label><input type="radio" name="page" value="category"> /categories/accounting-erp (a term page)</label>
      <label><input type="radio" name="page" value="search"> /search?q=procore</label>
      <label><input type="radio" name="page" value="categories"> /categories (a taxonomy index)</label>
    </fieldset>
    <fieldset><legend>View</legend>
      <label><input type="radio" name="view" value="cards" checked> Cards</label>
      <label><input type="radio" name="view" value="table"> Table</label>
    </fieldset>
    <fieldset><legend>State</legend>
      <label><input type="radio" name="state" value="results" checked> Results</label>
      <label><input type="radio" name="state" value="empty"> Empty (no filter match, an empty term, no search results)</label>
    </fieldset>
    <fieldset><legend>Lead card (question 2)</legend>
      <label><input type="radio" name="lead" value="off" checked> Off: a uniform grid (recommended)</label>
      <label><input type="radio" name="lead" value="on"> On: the wide Bone card, page 1 at Newest</label>
    </fieldset>
    <fieldset><legend>Below five reviews (question 4)</legend>
      <label><input type="radio" name="rating" value="dash" checked> As today: no line on cards, a dash in the table</label>
      <label><input type="radio" name="rating" value="text"> "Not yet rated" on cards and in the table</label>
    </fieldset>
  </div>
  <button type="button" id="mockToggle" aria-expanded="false" aria-controls="mockPanel">Options</button>
</div>"""

SCRIPT = """<script>
// Options: each radio group sets one data attribute on <html>. The URL hash can preset
// them for screenshots, e.g. 10-browse.html#page=search&view=table.
(function () {
  var root = document.documentElement;
  var params = new URLSearchParams(location.hash.slice(1));
  var titles = { products: 'Products', category: 'Accounting & ERP', search: 'Search', categories: 'Categories' };
  function sync() {
    document.title = titles[root.dataset.page] + ' | AEC Integrations';
    var browse = document.getElementById('nav-browse');
    if (root.dataset.page === 'search') browse.removeAttribute('aria-current');
    else browse.setAttribute('aria-current', 'page');
    document.querySelectorAll('[data-view-btn]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.viewBtn === root.dataset.view));
    });
    document.querySelectorAll('#mockPanel input').forEach(function (i) { i.checked = root.dataset[i.name] === i.value; });
  }
  document.querySelectorAll('#mockPanel input[type=radio]').forEach(function (input) {
    if (params.get(input.name) === input.value) input.checked = true;
    if (input.checked) root.dataset[input.name] = input.value;
    input.addEventListener('change', function () { root.dataset[input.name] = input.value; sync(); });
  });
  // The view toggle is live, as on the site: it sets ?view= there.
  document.querySelectorAll('[data-view-btn]').forEach(function (b) {
    b.addEventListener('click', function () { root.dataset.view = b.dataset.viewBtn; sync(); });
  });
  // The mobile Filters disclosure.
  document.querySelectorAll('.ftoggle').forEach(function (t) {
    t.addEventListener('click', function () {
      var open = t.parentElement.classList.toggle('open');
      t.setAttribute('aria-expanded', String(open));
    });
  });
  var mock = document.getElementById('mock');
  var toggle = document.getElementById('mockToggle');
  toggle.addEventListener('click', function () {
    var open = mock.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  if (params.has('panel')) { mock.classList.add('open'); toggle.setAttribute('aria-expanded', 'true'); }
  if (params.has('filters')) document.querySelectorAll('.ftoggle').forEach(function (t) { t.click(); });
  sync();
})();
</script>"""

HTML = f"""<!doctype html>
<html lang="en" data-page="products" data-view="cards" data-state="results" data-lead="off" data-rating="dash">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Products | AEC Integrations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,400..700;1,400..700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<!--
  Mock-up 10: the browse lists in the November 2026 design language (AECI-1790).
  One file for /products, a category term page, /search and a taxonomy index, because
  they share BrowseLayout. Build issues: AECI-1793 to AECI-1796, AECI-1799.
  Decision note: ../records/10-directory-notes.md.

  GENERATED by src/10-build.py from src/10-data.json and src/10.css. Edit those, then rebuild.

  Tokens: names and values copied from apps/web/src/styles.css on redesign/on-hold-2026-11-16.
  Header and footer: copied from mock-up 9 (AECI-1789), not redesigned.
  Data: production, read on 2026-11-16 through the public API and the public search key
  (src/10-snapshot.py). Every order is the order the code gives today.
  The Options control (bottom right) switches pages and states. Its defaults are the
  recommendation, not decisions.
-->
<style>
{CSS}</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
{WORDMARK}{ICONS}</svg>

{HEADER}

<main id="main">
{page_products()}
{page_products_empty()}
{page_category()}
{page_category_empty()}
{page_search()}
{page_search_empty()}
{page_categories()}
</main>

{FOOTER}

{OPTIONS}

{SCRIPT}
</body>
</html>
"""

(HERE.parent / "10-browse.html").write_text(HTML)
print("wrote", HERE.parent / "10-browse.html", len(HTML))
