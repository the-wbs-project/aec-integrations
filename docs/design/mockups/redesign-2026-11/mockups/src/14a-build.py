"""Build mock-up 14, the admin console (AECI-1813, epic AECI-1729).

Usage, from this folder:  python3 -I 14a-build.py
Reads the shared part of 11.css (everything above its first "Mock-up 11" banner),
14a.css and 10-wordmark.svg, and writes ../14-admin-console.html.

One file, two modes. Opened plainly it is the harness: a control strip above a
frame that holds the page at the chosen width. The frame loads the same file with
?inner, which renders the page alone. The hash carries the choices, for example
14-admin-console.html#page=detail&state=error&width=390.

Labels, column names, statuses and messages are copied from apps/web/src/app/admin.
Every name, email, count and date in the rows is invented. No logo is used.
"""

from html import escape
from pathlib import Path

HERE = Path(__file__).parent
CSS11 = (HERE / "11.css").read_text()
CSS11 = CSS11[: CSS11.index("/* ======")]
CSS = CSS11 + (HERE / "14a.css").read_text()
WORDMARK = (HERE / "10-wordmark.svg").read_text()


def e(s):
    return escape(str(s), quote=True)


ICONS = """
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></symbol>
  <symbol id="i-chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></symbol>
  <symbol id="i-ext" viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></symbol>
  <symbol id="i-user" viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h.01"/></symbol>
  <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></symbol>
"""


def ico(name, size=""):
    cls = "ico" + (f" {size}" if size else "")
    return f'<svg class="{cls}" aria-hidden="true" focusable="false"><use href="#i-{name}"/></svg>'


NEW_TAB = '<span class="sr"> (opens in a new tab)</span>' + ico("ext", "xs")
ERR = ico("alert")

# The header and footer are copied from mock-ups 9 to 12. Signed in: the account
# trigger replaces "Sign in" and carries the pending-review badge (DESIGN.md §5).
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
      <button class="acct" type="button" aria-expanded="false" aria-haspopup="true">{ico("user")}<span class="sr">Account menu, </span><span class="badge" aria-hidden="true">7</span><span class="sr">7 reviews awaiting moderation</span></button>
      <button class="menu-btn" type="button" aria-expanded="false">{ico("menu")}<span class="sr">Menu, 7 reviews awaiting moderation</span><span class="badge" aria-hidden="true">7</span></button>
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


def chip(label, tone="neutral", sr=""):
    extra = f'<span class="sr">{e(sr)}</span>' if sr else ""
    return f'<span class="chip dense" data-tone="{tone}">{e(label)}{extra}</span>'


def dash(sr):
    return f'<span aria-hidden="true">–</span><span class="sr">{e(sr)}</span>'


# ------------------------------------------------------------------ the shell

NAV = [
    ("ins", "Insights", None, [[(None, [("Overview", None), ("Activity", None), ("Traffic", None), ("Audience", None), ("Subscribers", None)])]]),
    ("cat", "Catalog", None, [[(None, [("Coverage", None), ("Connectors", None)])]]),
    ("ops", "Operations", 16, [
        [("Queues", [("Review queue", 7), ("Review updates", 1), ("Review replies", 2), ("Requests", 3), ("Vendor claims", 1), ("Change requests", 2), ("Row threads", None), ("Re-index queue", 4)])],
        [("Accounts and site", [("Vendors", None), ("Users", None), ("Email", None), ("Legal versions", None), ("Copyright notices", None), ("System status", None), ("Audit log", None)])],
    ]),
]
CURRENT = {"queue": ("ops", "Review queue"), "detail": ("ops", "Vendors"), "overview": ("ins", "Overview")}


def nav_row():
    lis = []
    for i, (gid, heading, total, cols) in enumerate(NAV):
        end = " end" if i == len(NAV) - 1 else ""
        two = " two" if len(cols) > 1 else ""
        badge = ""
        if total:
            badge = f'<span class="count" aria-hidden="true">{total}</span><span class="sr">{total} items awaiting action</span>'
        colhtml = []
        for col in cols:
            parts = []
            for sub, items in col:
                if sub:
                    parts.append(f'<p class="overline" id="{gid}-{sub[:3].lower()}">{e(sub)}</p>')
                lab = f' aria-labelledby="{gid}-{sub[:3].lower()}"' if sub else f' aria-label="{e(heading)}"'
                rows = []
                for label, n in items:
                    cnt = f'<span class="count" aria-hidden="true">{n}</span><span class="sr">{n} awaiting action</span>' if n else ""
                    rows.append(f'<li><a href="#" data-item="{e(label)}"><span>{e(label)}</span>{cnt}</a></li>')
                parts.append(f'<ul{lab}>{"".join(rows)}</ul>')
            colhtml.append(f'<div>{"".join(parts)}</div>')
        lis.append(f"""<li class="dd" data-group="{gid}">
          <button type="button" class="sec-trigger" aria-expanded="false" aria-controls="{gid}-panel" aria-haspopup="true" data-group-btn="{gid}"><span>{e(heading)}</span>{badge}</button>
          <div class="dd-panel{end}" id="{gid}-panel" hidden><div class="menu{two}">{"".join(colhtml)}</div></div>
        </li>""")
    return f"""<nav class="secrow" aria-label="Admin sections"><ul>{"".join(lis)}</ul></nav>"""


def crumbs(items, cls):
    out = []
    for i, (label, link) in enumerate(items):
        if i:
            out.append('<li class="sep" aria-hidden="true">›</li>')
        if i == len(items) - 1:
            out.append(f'<li aria-current="page">{e(label)}</li>')
        elif link:
            out.append(f'<li><a href="#">{e(label)}</a></li>')
        else:
            out.append(f"<li>{e(label)}</li>")
    return f'<nav class="acrumbs {cls}" aria-label="Breadcrumb"><ol>{"".join(out)}</ol></nav>'


SHELL_HEAD = f"""<h1>Admin</h1>
{nav_row()}
<div class="pg pg-queue">{crumbs([("Admin", True), ("Operations", False), ("Review queue", True)], "")}</div>
<div class="pg pg-detail">{crumbs([("Admin", True), ("Operations", False), ("Vendors", True), ("Northbeam Software", True)], "")}</div>
<div class="pg pg-overview">{crumbs([("Admin", True), ("Insights", False), ("Overview", True)], "")}</div>"""

# ------------------------------------------------------------------ the queue page

REVIEWS = [
    # product, reviewer, overall, onboarding, toxicity, submitted, age, role, years, rec, title, body
    ("Fieldline Takeoff", "r.amari@harbourline-arch.example", 4, 3, 12, "Nov 24, 2026, 8:41 AM", "38 min", "Practitioner", 3, "Would recommend",
     "Fast takeoffs, slow export", "Takeoffs on a 40-sheet set take an afternoon instead of two days.\nThe export to our estimating tool drops the assembly codes, so we still retype them."),
    ("Quarry BIM Sync", None, 1, 1, 84, "Nov 24, 2026, 7:02 AM", "2 h", "Other", None, "Would not recommend",
     "Do not buy this", "Support never answered. The sync wiped two days of model changes and the vendor blamed our server. Whoever built this should be ashamed."),
    ("Ledgerstone ERP", "d.whitcombe@northfield-mep.example", 5, 4, 3, "Nov 23, 2026, 6:15 PM", "15 h", "Manager", 6, "Would recommend",
     "Job costing finally matches the field", "We moved 14 active jobs over a weekend. Cost codes map one to one with our schedule of values."),
    ("Northbeam Scheduler", "p.lindqvist@ashgrove.example", 3, 2, 21, "Nov 23, 2026, 2:47 PM", "18 h", "Practitioner", 1, "Might recommend",
     "Good once it is set up", "The resource view is clear. Getting our crews and calendars in took three calls with support."),
    ("Siteledger Daily Logs", "k.mensah@tallowbuild.example", 4, 4, 8, "Nov 23, 2026, 11:20 AM", "21 h", "Practitioner", 2, "Would recommend",
     "Supers actually use it", "Photo logs attach to the right day without anyone thinking about it."),
    ("Fieldline Takeoff", "s.oduya@cobaltframe.example", 2, 3, 47, "Nov 22, 2026, 4:05 PM", "1 d", "IT", 4, "Might recommend",
     "Licensing is a mess", "Seats are tied to machines, not people. Every laptop swap is a support ticket."),
    ("Rivet Submittals", "a.brandt@merrow-eng.example", 5, 5, 2, "Nov 22, 2026, 9:33 AM", "2 d", "Executive", 8, "Would recommend",
     "Review cycles cut in half", "Architects comment in the same place we track the log. No more PDF ping-pong."),
    ("Quarry BIM Sync", "t.haddad@lumenarch.example", 3, 2, None, "Nov 21, 2026, 3:58 PM", "2 d", "Practitioner", 2, "Might recommend",
     "Works for small models", "Fine under 200 MB. Above that the sync times out and we split the model."),
    ("Ledgerstone ERP", "j.ferreira@brightwater-gc.example", 4, 3, 15, "Nov 21, 2026, 10:12 AM", "3 d", "Manager", 3, "Would recommend",
     "Solid, plan the rollout", "The AP approvals are the best part. Budget a month for the chart of accounts."),
    ("Siteledger Daily Logs", None, 2, 2, 61, "Nov 20, 2026, 7:44 PM", "3 d", "Other", None, "Would not recommend",
     "Overpriced", "Paying per project is ridiculous for what is basically a form app. Total ripoff."),
    ("Northbeam Scheduler", "m.castell@ridgeway-ce.example", 4, 4, 6, "Nov 20, 2026, 1:26 PM", "4 d", "Practitioner", 5, "Would recommend",
     "Look-ahead reports save my Mondays", "Three-week look-aheads print the way the owner wants them."),
    ("Rivet Submittals", "h.nakamura@sorrel-arch.example", 3, 4, 10, "Nov 19, 2026, 5:09 PM", "4 d", "Practitioner", 1, "Might recommend",
     "Clean, missing spec links", "Submittals look good. I want to link a spec section, and it only takes free text."),
]


def review_rows():
    out = []
    for i, (prod, who, ov, ob, tox, sub, age, role, yrs, rec, title, body) in enumerate(REVIEWS):
        rid = f"rv{i}"
        who_html = e(who) if who else '<span class="muted">Anonymized</span>'
        if tox is None:
            tox_html = chip("Not scored", "quiet")
        elif tox >= 60:
            tox_html = chip(f"{tox} · High", "attention", " of 100, high")
        else:
            tox_html = f'<span>{tox}</span>'
        open_ = i == 1
        yrs_html = f"<span>{yrs} yrs using</span>" if yrs else ""
        out.append(f"""<tr id="{rid}" data-row>
  <td class="disc"><button class="ib" type="button" aria-expanded="false" aria-controls="{rid}-x" data-disc{' data-demo-open' if open_ else ''}>{ico("chev")}<span class="sr">Open the review of {e(prod)}</span></button></td>
  <th scope="row"><a href="#">{e(prod)}</a></th>
  <td class="nowrap">{who_html}</td>
  <td class="num">{ov}/5</td>
  <td class="num">{ob}/5</td>
  <td class="num">{tox_html}</td>
  <td class="nowrap">{sub}</td>
  <td class="num">{age}</td>
  <td>{chip("Pending", "waiting")}</td>
</tr>
<tr class="xrow" id="{rid}-x" hidden>
  <td colspan="9">
    <div class="xin"><div class="xgrid">
      <div>
        <p class="rv-title">{e(title)}</p>
        <p class="rv-body">{e(body)}</p>
        <p class="rv-meta"><span>{role}</span>{yrs_html}<span>{rec}</span></p>
      </div>
      {decide_form(rid, demo=open_)}
    </div></div>
  </td>
</tr>""")
    return "\n".join(out)


def decide_form(rid, demo):
    """The decision for one review. Approve is the one filled button. Reject opens a
    required reason; while it is open, Confirm rejection is the filled button."""
    err = ""
    if demo:
        err = f"""<p class="ferr s-err" id="{rid}-err" role="alert">{ERR}<span>Enter a reason between 1 and 500 characters so the reviewer understands the decision.</span></p>"""
    return f"""<div class="decide" role="group" aria-labelledby="{rid}-dl">
        <span class="lbl" id="{rid}-dl">Decision</span>
        <div class="btns" data-choose>
          <button class="btn btn-primary" type="button">Approve</button>
          <button class="btn btn-secondary" type="button" data-reject-open aria-expanded="false" aria-controls="{rid}-rf">Reject</button>
        </div>
        <form class="fld" id="{rid}-rf" method="dialog" novalidate hidden data-reject-form>
          <label class="lbl" for="{rid}-reason">Reason for rejection</label>
          <textarea class="field ta" id="{rid}-reason" rows="3" maxlength="500" aria-describedby="{rid}-help{(' ' + rid + '-err') if demo else ''}"{' data-demo-invalid' if demo else ''}></textarea>
          {err}
          <p class="help" id="{rid}-help">Shown to the reviewer on their account page. Name the guideline the review breaks.</p>
          <div class="btns"><button class="btn btn-primary" type="submit">Confirm rejection</button><button class="btn btn-ghost" type="button" data-reject-cancel>Cancel</button></div>
        </form>
      </div>"""


QUEUE = f"""<section class="pg pg-queue" aria-labelledby="q-h">
  <div class="pg-head">
    <div><h2 id="q-h">Reviews</h2><p class="sub">Pending reviews wait here until you approve or reject them.</p></div>
  </div>
  <div class="toolbar">
    <div class="tgroup"><span class="lbl" id="q-status">Status</span>
      <div class="seg" role="group" aria-labelledby="q-status">
        <button type="button" aria-pressed="true">{ico("check", "s tick")}Pending</button>
        <button type="button" aria-pressed="false">{ico("check", "s tick")}Approved</button>
        <button type="button" aria-pressed="false">{ico("check", "s tick")}Rejected</button>
        <button type="button" aria-pressed="false">{ico("check", "s tick")}Removed</button>
      </div>
    </div>
    <div class="tgroup s-full"><span class="lbl" id="q-sort">Sort by</span>
      <div class="row">
        <div class="seg" role="group" aria-labelledby="q-sort">
          <button type="button" aria-pressed="false">{ico("check", "s tick")}Toxicity</button>
          <button type="button" aria-pressed="true">{ico("check", "s tick")}Queue age</button>
          <button type="button" aria-pressed="false">{ico("check", "s tick")}Product</button>
          <button type="button" aria-pressed="false">{ico("check", "s tick")}Reviewer</button>
        </div>
        <button class="hint-btn" type="button" aria-label="About the toxicity score: 0 to 100, from the automatic screen. 60 and above is marked High. It never decides a review.">i</button>
      </div>
    </div>
  </div>
  <p class="sr" role="status" aria-live="polite"></p>
  <p class="empty-note s-empty">No reviews are waiting for moderation.</p>
  <div class="s-full" style="margin-top:24px">
    <div class="tw" role="region" aria-labelledby="q-cap" tabindex="0">
      <table class="ct" style="min-width:62rem">
        <caption id="q-cap" class="sr">Pending reviews, oldest first</caption>
        <thead><tr>
          <th scope="col"><span class="sr">Open</span></th>
          <th scope="col">Product</th><th scope="col">Reviewer</th>
          <th scope="col" class="num">Overall</th><th scope="col" class="num">Onboarding</th>
          <th scope="col" class="num">Toxicity</th><th scope="col">Submitted</th>
          <th scope="col" class="num">In queue</th><th scope="col">Status</th>
        </tr></thead>
        <tbody>
{review_rows()}
        </tbody>
      </table>
    </div>
    <nav class="pager" aria-label="Pagination">
      <p>Page 1 of 4 · 41 rows</p>
      <div class="btns"><button class="btn btn-secondary btn-compact" type="button" disabled>Previous</button><button class="btn btn-secondary btn-compact" type="button">Next</button></div>
    </nav>
  </div>
</section>"""

# ------------------------------------------------------------------ the detail page

SEATS = [
    ("Ines Rowe", "i.rowe@northbeam.example", "Owner", ["Can manage seats", "Work email verified"], "Mar 3, 2026"),
    ("Theo Banerjee", "t.banerjee@northbeam.example", "Member", ["Work email verified"], "Apr 18, 2026"),
    ("Grace Liu", "g.liu@gmail.example", "Member", [], "Oct 2, 2026"),
    ("Paul Okonkwo", "p.okonkwo@northbeam.example", "Member", ["Banned"], "Jun 9, 2026"),
]


def seat_rows():
    out = []
    for i, (name, mail, role, flags, created) in enumerate(SEATS):
        fl = " ".join(chip(f, "critical" if f == "Banned" else "neutral") for f in flags) or dash("No flags")
        demo = i == 2
        out.append(f"""<tr data-row>
  <th scope="row"><a href="#">{e(name)}<span class="sr"> (open user page)</span></a><span class="sub">{e(mail)}</span></th>
  <td>{role}</td>
  <td><span class="chips" style="display:flex;flex-wrap:wrap;gap:4px">{fl}</span></td>
  <td class="nowrap">{created}</td>
  <td class="act"><button class="btn btn-secondary btn-compact" type="button" aria-expanded="false" aria-controls="seat{i}-x" data-disc{' data-demo-open' if demo else ''}>Remove seat<span class="sr">: {e(name)}</span></button></td>
</tr>
<tr class="xrow" id="seat{i}-x" hidden><td colspan="5" style="padding-left:12px">
  <div class="xin"><form class="fld" method="dialog" novalidate style="max-width:36rem;padding-top:8px">
    <p class="warnbox">Remove this seat? They lose portal access immediately and keep their AECi account. Only a fresh grant restores it. There is no undo on this screen.</p>
    <label class="lbl" for="seat{i}-r">Reason shown to the vendor (required)</label>
    <textarea class="field ta" id="seat{i}-r" rows="3" aria-describedby="seat{i}-h{(' seat' + str(i) + '-e') if demo else ''}"{' data-demo-invalid' if demo else ''}></textarea>
    {'<p class="ferr s-err" id="seat' + str(i) + '-e" role="alert">' + ERR + '<span>Enter a reason for the vendor. Its other seats read it in their portal messages.</span></p>' if demo else ''}
    <p class="help" id="seat{i}-h">The vendor's other seats read this in their portal messages. If this is the last seat, nobody is told. It is recorded in the audit trail with your name.</p>
    <label class="lbl" for="seat{i}-n">Internal note (optional, never shown to the vendor)</label>
    <textarea class="field ta" id="seat{i}-n" rows="2"></textarea>
    <div class="btns" style="margin-top:8px"><button class="btn btn-danger" type="submit">Confirm removal</button><button class="btn btn-ghost" type="button" data-close>Cancel</button></div>
  </form></div>
</td></tr>""")
    return "\n".join(out)


def ictl(cid, label, value, hint, demo_err=None, input_type="text"):
    err = ""
    if demo_err:
        err = f'<p class="ferr s-err" id="{cid}-e" role="alert">{ERR}<span>{e(demo_err)}</span></p>'
    return f"""<div class="ictl">
  <span class="lbl" id="{cid}-l">{e(label)}</span>
  <span class="v">{value}</span>
  <button class="btn btn-secondary btn-compact" type="button" aria-expanded="false" aria-controls="{cid}-f" data-ictl{' data-demo-open' if demo_err else ''}>Change<span class="sr"> {e(label.lower())}</span></button>
  <form id="{cid}-f" method="dialog" novalidate hidden>
    <label class="lbl" for="{cid}-i">{e(label)}</label>
    <input class="field" id="{cid}-i" type="{input_type}" value="{e(demo_err and 'billing@northbeam' or '')}" aria-describedby="{cid}-h{(' ' + cid + '-e') if demo_err else ''}"{' data-demo-invalid' if demo_err else ''}>
    {err}
    <p class="help" id="{cid}-h">{e(hint)}</p>
    <div class="btns"><button class="btn btn-primary btn-compact" type="submit">Save</button><button class="btn btn-ghost" type="button" data-close>Cancel</button></div>
  </form>
</div>"""


DETAIL = f"""<section class="pg pg-detail" aria-labelledby="v-h">
  <div class="pg-head"><div><h2 id="v-h">Northbeam Software</h2></div></div>
  <div class="idrow">
    <span class="tile lg" aria-hidden="true">N</span>
    {chip("Account active", "positive")}
    <a class="link" href="#">View page{NEW_TAB}</a>
  </div>
  <nav class="vtabs" aria-label="Vendor sections"><ul>
    <li><a href="#" data-vtab-link="vendor" aria-current="page">Vendor</a></li>
    <li><a href="#" data-vtab-link="billing">Billing</a></li>
    <li><a href="#">Products</a></li>
    <li><a href="#">Integrations</a></li>
    <li><a href="#">Audit trail</a></li>
  </ul></nav>

  <div class="tabpane tab-vendor">
  <div class="dgrid">
    <div>
      <section class="panel" aria-labelledby="b-h">
        <h3 id="b-h">Basics</h3>
        <dl class="facts-dl">
          <div><dt class="lbl">Products</dt><dd class="num"><span class="s-full">6</span><span class="s-empty">0</span></dd></div>
          <div><dt class="lbl">Products by role</dt><dd><span class="s-full">5 product, 1 connector</span><span class="s-empty">No products on record</span></dd></div>
          <div><dt class="lbl">Integrations owned</dt><dd class="num"><span class="s-full">18</span><span class="s-empty">0</span></dd></div>
          <div><dt class="lbl">Promotion status</dt><dd>Promoted</dd></div>
          <div><dt class="lbl">Maintained by</dt><dd>Vendor</dd></div>
          <div><dt class="lbl">Website</dt><dd><a class="inlink" href="#">northbeam.example{NEW_TAB}</a></dd></div>
          <div><dt class="lbl">Headquarters</dt><dd><span class="s-full">Denver, Colorado</span><span class="s-empty">{dash("No headquarters listed")}</span></dd></div>
          <div><dt class="lbl">Record updated</dt><dd>Nov 21, 2026, 4:12 PM</dd></div>
          <div><dt class="lbl">Claims open</dt><dd class="num">0</dd></div>
          <div><dt class="lbl">In review</dt><dd class="num">1</dd></div>
          <div><dt class="lbl">Approved</dt><dd class="num">2</dd></div>
          <div><dt class="lbl">Rejected</dt><dd class="num">0</dd></div>
        </dl>
      </section>

      <section class="panel" aria-labelledby="s-h">
        <h3 id="s-h">Seats</h3>
        <p class="intro">People with portal access to this vendor. A seat is a login, not a subscription. Removing a seat does not change the vendor's subscriptions.</p>
        <div class="btns" style="margin-top:16px"><button class="btn btn-secondary btn-compact" type="button">Add a seat</button></div>
        <p class="empty-note s-empty">No one has portal access to this vendor yet.</p>
        <div class="tw s-full" role="region" aria-labelledby="s-cap" tabindex="0" style="margin-top:16px">
          <table class="ct" style="min-width:44rem">
            <caption id="s-cap" class="sr">People with portal access to this vendor</caption>
            <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Flags</th><th scope="col">Account created</th><th scope="col" class="num">Actions</th></tr></thead>
            <tbody>
{seat_rows()}
            </tbody>
          </table>
        </div>
      </section>
    </div>

    <div>
      <section class="panel" aria-labelledby="lv-h">
        <h3 id="lv-h">Listing visibility</h3>
        <p class="caption" style="margin-top:12px">On the public site.</p>
        <div class="btns" style="margin-top:16px"><button class="btn btn-secondary btn-compact" type="button" aria-expanded="false" aria-controls="lv-f" data-ictl>Hide from the public site</button></div>
        <form class="formbox" id="lv-f" method="dialog" novalidate hidden>
          <p class="help">5 products are also hidden with it. The vendor's portal still works.</p>
          <div class="fld"><label class="lbl" for="lv-r">Reason shown to the vendor</label><textarea class="field ta" id="lv-r" rows="3"></textarea></div>
          <div class="btns"><button class="btn btn-danger btn-compact" type="submit">Hide the listing</button><button class="btn btn-ghost" type="button" data-close>Cancel</button></div>
        </form>
      </section>

      <section class="panel" aria-labelledby="su-h">
        <h3 id="su-h">Suspension</h3>
        <p class="caption" style="margin-top:12px">This vendor is not suspended. To end a vendor, suspend it first: the vendor gets a notice and 7 business days before Terminate is possible.</p>
        <div class="btns" style="margin-top:16px"><button class="btn btn-secondary btn-compact" type="button" aria-expanded="false" aria-controls="su-f" data-ictl>Suspend</button></div>
        <form class="formbox" id="su-f" method="dialog" novalidate hidden>
          <p class="warnbox">This locks every seat out at once and sends the notice to the owner seats and the billing email. The listing stays live and billing is untouched.</p>
          <div class="fld"><span class="lbl" id="su-k">Kind</span><button class="field select-like" type="button" aria-haspopup="listbox" aria-labelledby="su-k su-kv"><span id="su-kv">Identity not proven</span>{ico("chev", "s")}</button></div>
          <div class="fld"><label class="lbl" for="su-r">Rule broken (required, vendor-facing: the notice quotes it)</label><textarea class="field ta" id="su-r" rows="2"></textarea></div>
          <div class="fld"><label class="lbl" for="su-e">Evidence (required, vendor-facing: the notice quotes it)</label><textarea class="field ta" id="su-e" rows="2"></textarea></div>
          <div class="fld"><label class="lbl" for="su-i">Reason (required, internal: the vendor never sees it)</label><textarea class="field ta" id="su-i" rows="2"></textarea></div>
          <div class="btns"><button class="btn btn-danger btn-compact" type="submit">Suspend and send the notice</button><button class="btn btn-ghost" type="button" data-close>Cancel</button></div>
        </form>
      </section>

      <section class="panel" aria-labelledby="ro-h">
        <h3 id="ro-h">Record ownership</h3>
        <p class="caption" style="margin-top:12px">Vendor owned since Mar 3, 2026. Promote leaves its records alone.</p>
        <div class="btns" style="margin-top:16px"><button class="btn btn-secondary btn-compact" type="button">Return records to AEC Integrations</button></div>
      </section>
    </div>
  </div>
  </div>

  <div class="tabpane tab-billing">
  <div class="stack" style="margin-top:24px">
    <section class="panel" aria-labelledby="ac-h">
      <h3 id="ac-h">Account</h3>
      <div style="margin-top:16px">
        {ictl("ln", "Company legal name", "Northbeam Software, Inc.", "The name a checkout acceptance records. Leave it empty to remove the name.")}
        {ictl("be", "Billing email", "billing@northbeam.example", "Subscription grant, renewal notice and plan-end emails go to this address and to every seat. Leave it empty to remove the address.", demo_err="Enter a valid email address.", input_type="email")}
      </div>
    </section>
    <section class="panel" aria-labelledby="sb-h">
      <h3 id="sb-h">Subscriptions</h3>
      <div class="tw" role="region" aria-labelledby="sb-cap" tabindex="0" style="margin-top:16px">
        <table class="ct" style="min-width:56rem">
          <caption id="sb-cap" class="sr">Subscriptions, live first</caption>
          <thead><tr><th scope="col" class="chk"><span class="sr">Select</span></th><th scope="col">Product</th><th scope="col">Source</th><th scope="col">Starts</th><th scope="col">Ends</th><th scope="col">Status</th><th scope="col">Terms version</th></tr></thead>
          <tbody>
            <tr class="sel"><td class="chk"><label><input type="checkbox" checked><span class="sr">Select Northbeam Scheduler</span></label></td><th scope="row">Northbeam Scheduler<span class="sub">northbeam-scheduler</span></th><td>Paid by card<span class="sub">sub_9f2k</span></td><td class="nowrap">Apr 1, 2026</td><td class="nowrap">Monthly, renews</td><td>{chip("Live", "positive")}</td><td>2026-10</td></tr>
            <tr><td class="chk"><label><input type="checkbox"><span class="sr">Select Northbeam Field</span></label></td><th scope="row">Northbeam Field<span class="sub">northbeam-field</span></th><td>Complimentary grant<span class="sub">grant 114</span></td><td class="nowrap">Jul 15, 2026</td><td class="nowrap">Jan 15, 2027</td><td>{chip("Live", "positive")} {chip("Cancels at term end: vendor banned", "attention")}</td><td>2026-06</td></tr>
            <tr><td class="chk"><label><input type="checkbox"><span class="sr">Select Unassigned</span></label></td><th scope="row" class="muted">Unassigned</th><td class="muted">Complimentary grant<span class="sub">grant 61</span></td><td class="nowrap muted">Jan 2, 2026</td><td class="nowrap muted">Jun 30, 2026</td><td>{chip("Ended Jun 30, 2026", "quiet")}</td><td class="muted">{dash("No terms version")}</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
  </div>
</section>"""

# ------------------------------------------------------------------ the overview page

# 30 UTC days of page requests by class. Invented, shaped like the production mix
# (most of it automation). Order: identified, suspected, human evidence, unresolved.
DAYS = []
for d in range(30):
    base = 900 + (d * 37) % 260
    DAYS.append((int(base * 0.55), int(base * 0.24) + (d % 5) * 9, int(base * 0.11) + (d % 7) * 6, int(base * 0.07) + (d % 3) * 8))
CLASSES = [
    ("Identified automation", "var(--text-secondary)"),
    ("Suspected automation", "var(--border-input)"),
    ("Browser activity with supporting human evidence", "var(--accent-primary)"),
    ("Unresolved", "var(--accent-secondary-deep)"),
]


def chart_svg():
    w, h, gap = 600, 200, 2
    top = 1400
    col = w / 30
    bw = min(16, col - 4)
    parts = []
    for gy in (0, 350, 700, 1050, 1400):
        y = h - gy / top * h
        parts.append(f'<line x1="0" x2="{w}" y1="{y:.1f}" y2="{y:.1f}" stroke="var(--chart-grid)" stroke-width="1" vector-effect="non-scaling-stroke"/>')
    for i, vals in enumerate(DAYS):
        x = i * col + (col - bw) / 2
        y = h
        for j, v in enumerate(vals):
            hh = v / top * h
            seg_h = max(hh - (gap if j < 3 else 0), 1)
            y -= hh
            rx = ' rx="2"' if j == 3 else ""
            parts.append(f'<rect x="{x:.1f}" y="{y + (gap if j < 3 else 0):.1f}" width="{bw:.1f}" height="{seg_h:.1f}" fill="{CLASSES[j][1]}"{rx}/>')
    return f'<svg viewBox="0 0 {w} {h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">{"".join(parts)}</svg>'


def chart_table():
    rows = []
    for i, v in enumerate(DAYS):
        day = f"Oct {25 + i}" if i < 7 else f"Nov {i - 6}"
        rows.append(f"<tr><th scope=\"row\">{day}</th>{''.join(f'<td>{x:,}</td>' for x in v)}</tr>")
    head = "".join(f'<th scope="col">{e(n)}</th>' for n, _ in CLASSES)
    # The wrapper carries .sr: a table will not shrink to the 1px box itself.
    return f'<div class="sr"><table><caption>Page requests per day over the last 30 UTC days, by traffic class</caption><thead><tr><th scope="col">UTC day</th>{head}</tr></thead><tbody>{"".join(rows)}</tbody></table></div>'


def ranked(items):
    mx = max(n for _, n in items)
    return "".join(
        f'<li><span>{e(name)}</span><span class="num">{n:,}</span><span class="bar" aria-hidden="true"><span style="width:{n / mx * 100:.0f}%"></span></span></li>'
        for name, n in items
    )


CLS_TODAY = [(5410, 380), (2380, 611), (1020, 402), (690, 288)]

OVERVIEW = f"""<section class="pg pg-overview" aria-labelledby="o-h">
  <div class="pg-head">
    <div><h2 id="o-h">Overview</h2><p class="sub">Reporting UTC day 2026-11-23 · generated Nov 24, 2026, 5:00:12 AM UTC</p></div>
    <button class="btn btn-secondary" type="button">{ico("refresh", "s")}Recompute</button>
  </div>
  <p class="alert-line s-err" role="alert">{ERR}<span>Recompute failed. The figures below are unchanged; try again.</span></p>

  <section class="panel" aria-labelledby="tc-h" style="margin-top:24px">
    <div class="ph"><h3 id="tc-h">Traffic by class</h3><span class="caption">Classifier v7 · UTC day 2026-11-23</span></div>
    <p class="intro">Requests, not people. Each figure counts page requests; a visitor is a distinct browser-and-network pair.</p>
    <div class="s-full" style="margin-top:16px">
      {''.join(f'<div class="cls-row"><span class="key" style="background:{c}" aria-hidden="true"></span><span>{e(n)}</span><span class="num">{r:,}</span><span class="caption">Visitors: {v:,}</span></div>' for (n, c), (r, v) in zip(CLASSES, CLS_TODAY))}
    </div>
    <p class="empty-note s-empty">The classifier did not run for this day, so there are no class counts. Nothing is shown as zero.</p>
  </section>

  <div class="tiles">
    <section class="panel ovtile" aria-labelledby="t1"><p class="lbl" id="t1">Unique visitors</p><p class="tile-fig s-full">412</p><p class="tile-fig nm s-empty">Not measured</p><p class="tile-delta s-full">+38 vs 374 the prior day</p><p class="caption">UTC day 2026-11-23. A visitor is a distinct browser-and-network pair.</p></section>
    <section class="panel ovtile" aria-labelledby="t2"><p class="lbl" id="t2">New sign-ins</p><p class="tile-fig s-full">6</p><p class="tile-fig nm s-empty">Not measured</p><p class="tile-delta s-full">No change vs the prior day</p><p class="caption">UTC day 2026-11-23</p></section>
    <section class="panel ovtile" aria-labelledby="t3"><p class="lbl" id="t3">Active subscribers</p><p class="tile-fig">128</p><p class="caption">Live total as of now, not a daily figure.</p></section>
  </div>

  <div class="ovgrid">
    <section class="panel" aria-labelledby="ch-h">
      <h3 id="ch-h">Page requests by class over the last 30 days</h3>
      <div class="s-full">
        <div class="chart">
          {chart_svg()}
          <span class="ylab" style="top:6px" aria-hidden="true">1,400</span><span class="ylab" style="top:110px" aria-hidden="true">700</span><span class="ylab" style="top:214px" aria-hidden="true">0</span>
          <div class="axis" aria-hidden="true"><span>Oct 25</span><span>Nov 8</span><span>Nov 23</span></div>
        </div>
        <ul class="legend">{''.join(f'<li><span class="key" style="background:{c}" aria-hidden="true"></span>{e(n)}</li>' for n, c in CLASSES)}</ul>
        {chart_table()}
      </div>
      <p class="empty-note s-empty">No page views recorded in the last 30 days.</p>
    </section>
    <section class="panel" aria-labelledby="ct-h">
      <h3 id="ct-h">Catalog totals</h3>
      <dl class="totals">
        <div><dt class="lbl">Products</dt><dd>1,284</dd></div>
        <div><dt class="lbl">Integrations</dt><dd>3,906</dd></div>
        <div><dt class="lbl">Vendors</dt><dd>702</dd></div>
        <div><dt class="lbl">Claims</dt><dd>41</dd></div>
        <div><dt class="lbl">Attestations</dt><dd>86</dd></div>
      </dl>
    </section>
  </div>

  <div class="ovgrid">
    <section class="panel" aria-labelledby="rs-h">
      <h3 id="rs-h">Top traffic sources</h3>
      <ul class="ranked s-full" style="margin-top:8px">{ranked([("google.com", 214), ("Unattributed", 132), ("bing.com", 41), ("linkedin.com", 18), ("duckduckgo.com", 7)])}</ul>
      <p class="empty-note s-empty">No traffic sources recorded for this day.</p>
    </section>
    <section class="panel" aria-labelledby="rp-h">
      <h3 id="rp-h">Top viewed products</h3>
      <ul class="ranked s-full" style="margin-top:8px">{ranked([("Ledgerstone ERP", 58), ("Fieldline Takeoff", 41), ("Northbeam Scheduler", 33), ("Rivet Submittals", 19), ("Quarry BIM Sync", 12)])}</ul>
      <p class="empty-note s-empty">No product page views recorded for this day.</p>
    </section>
  </div>

  <section class="panel" aria-labelledby="ss-h" style="margin-top:24px">
    <h3 id="ss-h">System status</h3>
    <dl class="strip-st">
      <div><dt class="lbl">Deploy</dt><dd><span>SSR 6de0d3c · API 6de0d3c</span></dd></div>
      <div><dt class="lbl">Home stats freshness</dt><dd><span>Computed 3 hours ago</span></dd></div>
      <div><dt class="lbl">Moderation queue</dt><dd><span>7 reviews pending</span><span>3 corrections open</span><span>1 claims open</span></dd></div>
      <div><dt class="lbl">Data-quality checks</dt><dd>{chip("Needs attention", "attention")}<span>1 of 14 failing</span><span class="caption">Last scheduled run, 11/24/26, 4:00 AM UTC</span></dd></div>
      <div><dt class="lbl">Algolia index drift</dt><dd>{chip("Not measured", "quiet")}<span class="caption">Not measured. Use Recompute.</span></dd></div>
    </dl>
  </section>
</section>"""

# ------------------------------------------------------------------ the legend panel

TONES = [
    ("count", "Forest fill, white text (12.34:1)", "Queue counts on the section row, the menu and the account badge (error fill there)", "7, 16. The Operations total leaves out the re-index queue, as the code does"),
    ("neutral", "Raised fill, default edge, primary ink (18.97:1)", "A fact about the row that is not a state", "Can manage seats, Work email verified, Practitioner (role), priority 1 to 4, Note, Matched by hand"),
    ("waiting", "White fill, strong edge, primary ink, hollow ring", "Waits on someone. Never the sunken fill: the row hover is the sunken fill", "Pending, Open, In review, Waiting for acceptance, Not yet reviewed, In flight, Requested, With the owner, Not decided yet, Waiting to be forwarded to the complainant, Restore window opens {date}, Help requested, Parked as ambiguous, Linear issue pending"),
    ("positive", "Forest-soft fill, Forest edge and ink (10.80:1)", "Live or done as intended", "Approved, Accepted, Resolved, Live, Active, Account active, Matched, Passing, Succeeded, Restored, Agreed with the submitter"),
    ("quiet", "Raised fill, default edge, secondary ink (7.41:1)", "Closed, withdrawn or not measured. Nothing to do", "Rejected, Removed, Archived, Withdrawn, Declined, Ended {date}, Expired, never accepted, Retired by the owner, Retired by AEC Integrations, Not restored, Unsubscribed, Removed by the vendor, Not scored, Not measured, Skipped, Inferred, Recorded, Unknown, Out of scope, Ruled out, Agreed with the owner, No record"),
    ("attention", "Raised fill, strong edge, Clay-deep ink (5.59:1)", "Look before you act. Not a fault", "Toxicity {n} · High, Possible duplicate, Pure connector vendor, No products on record, role unknown, Needs attention, Repeat offender, Hidden, Cancels at term end, Restore by {date}, Caveat, Classifier changed"),
    ("critical", "White fill, error edge and ink (6.54:1)", "A fault or a block. The only red", "Failed, Errored, Refused, Banned, Overdue. Restore was due by {date}, Court action reported. Do not restore., Suspended, Companies disagree"),
]

RECIPE = [
    ("Wrapper", "A region that scrolls sideways: role=\"region\", aria-labelledby on the caption, tabindex=\"0\". No shadow, no radius, no fill of its own, in a panel or on the page."),
    ("Caption", "A visually hidden &lt;caption&gt; with an id. The visible h2 or h3 above it names the section."),
    ("Header row", "The Label role (13px, 600, sentence case, secondary ink). A hairline above, a strong rule below. Not sticky."),
    ("Rows", "Hairlines between rows, no zebra. Hover and focus-within take the muted fill."),
    ("Identity cell", "th scope=\"row\", weight 600, the link to the record. A second line in 13px secondary for the slug or email."),
    ("Numbers", "End-aligned, tabular figures, no wrap. Dates are absolute, medium form."),
    ("Absent value", "An aria-hidden en dash beside visually hidden words."),
    ("Row actions", "The row's one disclosure leads the row as a 44px icon button. Decisions live inside the expanded row, never in the collapsed one. A table with direct actions puts them last, end-aligned, as compact secondary or ghost buttons. Danger only on the confirm."),
    ("Selected", "The Forest-soft fill plus a ticked checkbox. The checkbox is the signal, not the fill."),
    ("Expanded", "The row and its detail row share the raised fill, with a strong rule under the pair. The chevron turns and aria-expanded is true."),
    ("Density", "Compact: 8px cells, 40px text rows, 45px rows with a 44px control. Comfortable: 12px cells, 49px and 52px."),
    ("Paging", "Previous and Next under the table with \"Page n of m · N rows\", for feeds and lookup screens (ADMIN_PANEL_SPEC.md §5.7). /admin/vendors keeps scroll-append."),
    ("Empty", "No table at all. One line of text where the table was, the filters stay."),
]

CHART_ROWS = [
    ("Identified automation (text-secondary)", "#52525B", "7.73", "7.41", "7.03", "6.91"),
    ("Suspected automation (border-input)", "#8A8A93", "3.42", "3.28", "3.11", "3.06"),
    ("Human evidence (Forest)", "#1E3A2F", "12.34", "11.82", "11.23", "11.03"),
    ("Unresolved (Clay deep)", "#A14D22", "5.83", "5.59", "5.31", "5.21"),
    (".aec-charts slot 1 blue", "#2a78d6", "4.42", "4.23", "4.02", "3.95"),
    (".aec-charts slot 2 orange", "#eb6834", "3.20", "3.07", "2.91 fails", "2.86 fails"),
    (".aec-charts slot 3 aqua", "#1baf7a", "2.82", "2.70", "2.56", "2.52"),
    (".aec-charts slot 4 yellow", "#eda100", "2.17", "2.07", "1.97", "1.94"),
    (".aec-charts slot 5 magenta", "#e87ba4", "2.69", "2.58", "2.45", "2.41"),
    (".aec-charts slot 6 green", "#008300", "4.95", "4.74", "4.50", "4.42"),
    (".aec-charts slot 7 violet", "#4a3aa7", "8.56", "8.20", "7.78", "7.65"),
    (".aec-charts slot 8 red", "#e34948", "3.95", "3.79", "3.60", "3.53"),
]


COUNT7 = '<span class="count">7</span>'


def legend_panel():
    tone_rows = "".join(
        f'<tr><th scope="row">{COUNT7 if t == "count" else chip(t.capitalize(), t)}</th><td>{e(look)}</td><td>{e(use)}</td><td>{e(st)}</td></tr>'
        for t, look, use, st in TONES
    )
    recipe_rows = "".join(f'<tr><th scope="row">{k}</th><td>{v}</td></tr>' for k, v in RECIPE)
    chart_rows = "".join(
        f'<tr><th scope="row"><span class="key" style="display:inline-block;vertical-align:-1px;margin-right:8px;background:{hx}" aria-hidden="true"></span>{e(n)}</th><td class="num">{a}</td><td class="num">{b}</td><td class="num">{c}</td><td class="num">{d}</td></tr>'
        for n, hx, a, b, c, d in CHART_ROWS
    )
    return f"""<section class="legend-panel" aria-labelledby="lg-h" id="legend">
  <div class="wrap">
    <span class="tag">Mock-up legend. Not part of the page</span>
    <h2 id="lg-h">The console table and the status chips</h2>
    <p>One table recipe and one chip tone mapping for every admin screen. The rows below are the proposal. Every status string is the one the code prints today.</p>

    <h3>One console table recipe</h3>
    <div class="tw" role="region" aria-labelledby="lr-cap" tabindex="0"><table class="ct" style="min-width:40rem"><caption id="lr-cap" class="sr">The console table recipe</caption>
      <thead><tr><th scope="col">Part</th><th scope="col">Rule</th></tr></thead><tbody>{recipe_rows}</tbody></table></div>

    <h3>One status-to-chip tone mapping</h3>
    <p>The dense pill chip (24px tall, 13px at 600) in every table. Words always carry the state, so colour is never the only signal.</p>
    <div class="tw" role="region" aria-labelledby="lt-cap" tabindex="0"><table class="ct" style="min-width:56rem"><caption id="lt-cap" class="sr">Status chip tones</caption>
      <thead><tr><th scope="col">Tone</th><th scope="col">Look</th><th scope="col">Use</th><th scope="col">Statuses shown today</th></tr></thead><tbody>{tone_rows}</tbody></table></div>

    <h3>Chart colours on the new surfaces</h3>
    <p>WCAG contrast of each fill against white (the reading area and a flat panel), raised (today's chart surface), sunken (the row hover) and Bone. A chart mark needs 3:1.</p>
    <div class="tw" role="region" aria-labelledby="lc-cap" tabindex="0"><table class="ct" style="min-width:44rem"><caption id="lc-cap" class="sr">Chart fill contrast by surface</caption>
      <thead><tr><th scope="col">Fill</th><th scope="col" class="num">White</th><th scope="col" class="num">Raised</th><th scope="col" class="num">Sunken</th><th scope="col" class="num">Bone</th></tr></thead><tbody>{chart_rows}</tbody></table></div>

    <h3>Findings for the build</h3>
    <ol class="find">
      <li>The review queue is a table here. DESIGN.md says moderation queues stay cards because a review body is long. The table keeps the body one click away in the expanded row. Chris decides.</li>
      <li>The review queue loads a capped set today, with a note. The mock-up shows Previous and Next, as ADMIN_PANEL_SPEC.md §5.7 rules for feeds and lookup screens.</li>
      <li>A sticky header cannot work inside a table that scrolls sideways, because the region has no vertical scroll. The recipe drops it.</li>
      <li>Operations has 15 entries. The mock-up splits its panel into two labelled columns, "Queues" and "Accounts and site". The code has one flat list.</li>
      <li>Two labels are in Title Case today: "View Page" and "Audit Trail". The mock-up prints them in sentence case.</li>
      <li>Slot 2 of .aec-charts (orange, bot page views) falls below 3:1 on sunken and Bone. Charts sit on white or raised only.</li>
    </ol>
  </div>
</section>"""

# ------------------------------------------------------------------ the harness

STRIP_GROUPS = [
    ("page", "Page", [("queue", "Queue"), ("detail", "Detail"), ("overview", "Overview")]),
    ("state", "State", [("populated", "Populated"), ("empty", "Empty"), ("expanded", "Row expanded"), ("error", "Refused")]),
    ("width", "Width", [("1440", "1440"), ("1024", "1024"), ("768", "768"), ("390", "390"), ("320", "320")]),
    ("panel", "Panels", [("flat", "Flat bordered*"), ("card", "Card shadow")]),
    ("density", "Density", [("compact", "Compact*"), ("comfortable", "Comfortable")]),
    ("labels", "Labels", [("role", "Label role*"), ("upper", "Today's uppercase")]),
    ("grace", "Menu close", [("260", "260ms grace*"), ("0", "At once")]),
    ("crumb", "Breadcrumb", [("shared", "Shared*"), ("today", "Today's")]),
]
DEFAULTS = {g: opts[0][0] for g, _, opts in STRIP_GROUPS}


def strip():
    groups = []
    for g, legend, opts in STRIP_GROUPS:
        labs = []
        for i, (v, lab) in enumerate(opts):
            star = lab.endswith("*")
            text = lab[:-1] + '<span class="rec" aria-label="recommended">*</span>' if star else lab
            labs.append(f'<label><input type="radio" name="{g}" value="{v}"{" checked" if i == 0 else ""}>{text}</label>')
        groups.append(f'<fieldset><legend>{legend}</legend>{"".join(labs)}</fieldset>')
    return f"""<div id="harness">
  <div class="strip" role="region" aria-label="Mock-up options">
    <span class="t">Mock-up 14 · admin console · * marks the recommendation</span>
    {"".join(groups)}
  </div>
  <div class="stage"><iframe id="frame" title="Admin console mock-up"></iframe></div>
</div>"""


SCRIPT = """<script>
(function () {
  var root = document.documentElement;
  var DEF = %s;
  function readHash() {
    var p = new URLSearchParams(location.hash.slice(1)), s = {};
    Object.keys(DEF).forEach(function (k) { s[k] = p.get(k) || DEF[k]; });
    return s;
  }
  function toHash(s) {
    return Object.keys(DEF).filter(function (k) { return s[k] !== DEF[k]; }).map(function (k) { return k + '=' + s[k]; }).join('&');
  }

  if (root.dataset.mode === 'harness') {
    var frame = document.getElementById('frame');
    var base = location.pathname + '?inner';
    function apply(first) {
      var s = readHash();
      document.querySelectorAll('.strip input').forEach(function (i) { i.checked = s[i.name] === i.value; });
      frame.style.width = s.width + 'px';
      var h = '#' + toHash(s);
      if (first) frame.src = base + h; else frame.contentWindow.location.hash = h;
    }
    document.querySelectorAll('.strip input').forEach(function (i) {
      i.addEventListener('change', function () {
        var s = readHash(); s[i.name] = i.value;
        history.replaceState(null, '', '#' + toHash(s));
        apply(false);
      });
    });
    window.addEventListener('hashchange', function () { apply(false); });
    apply(true);
    return;
  }

  // ---- the page itself
  function q(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function setOpen(btn, open) {
    var t = document.getElementById(btn.getAttribute('aria-controls'));
    btn.setAttribute('aria-expanded', String(open));
    t.hidden = !open;
    var row = btn.closest('tr');
    if (row && t.tagName === 'TR') row.classList.toggle('open', open);
  }
  function resetDemo() {
    q('[data-disc], [data-ictl]').forEach(function (b) { setOpen(b, false); });
    q('[data-reject-form]').forEach(function (f) { f.hidden = true; });
    q('[data-choose]').forEach(function (c) { c.hidden = false; });
    q('[data-demo-invalid]').forEach(function (f) { f.removeAttribute('aria-invalid'); });
  }
  function applyState() {
    var s = readHash();
    ['page', 'state', 'panel', 'density', 'labels', 'grace', 'crumb'].forEach(function (k) { root.dataset[k] = s[k]; });
    root.dataset.vtab = s.vtab || root.dataset.vtab || 'vendor';
    // #legend=off hides the legend panel, for pictures of the page alone.
    root.dataset.legend = new URLSearchParams(location.hash.slice(1)).get('legend') || 'on';
    q('[data-vtab-link]').forEach(function (a) { if (a.dataset.vtabLink === root.dataset.vtab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    document.title = { queue: 'Review queue', detail: 'Northbeam Software', overview: 'Overview' }[s.page] + ' · Admin · AEC Integrations (mock-up 14)';
    resetDemo();
    var cur = { queue: ['ops', 'Review queue'], detail: ['ops', 'Vendors'], overview: ['ins', 'Overview'] }[s.page];
    q('.sec-trigger').forEach(function (b) { if (b.dataset.groupBtn === cur[0]) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
    q('.menu a').forEach(function (a) { if (a.dataset.item === cur[1]) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    if (s.state === 'expanded' || s.state === 'error') {
      var pg = document.querySelector('section.pg-' + s.page);
      q('[data-demo-open]', pg).forEach(function (b) {
        if (b.closest('.tabpane') && !b.closest('.tab-' + root.dataset.vtab)) return;
        setOpen(b, true);
        var x = document.getElementById(b.getAttribute('aria-controls'));
        var rf = x.querySelector('[data-reject-form]');
        if (rf) { rf.hidden = false; x.querySelector('[data-choose]').hidden = true; }
        if (s.state === 'error') q('[data-demo-invalid]', x).forEach(function (f) { f.setAttribute('aria-invalid', 'true'); });
      });
    }
  }
  window.addEventListener('hashchange', applyState);

  // Disclosures: table rows, inline controls, panel forms.
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-disc], [data-ictl]');
    if (b) { setOpen(b, b.getAttribute('aria-expanded') !== 'true'); return; }
    var c = ev.target.closest('[data-close]');
    if (c) {
      var form = c.closest('form'), owner = document.querySelector('[aria-controls="' + (form.closest('tr.xrow') || form).id + '"]');
      if (owner) { setOpen(owner, false); owner.focus(); }
      return;
    }
    var r = ev.target.closest('[data-reject-open]');
    if (r) {
      var d = r.closest('.decide'); r.setAttribute('aria-expanded', 'true'); d.querySelector('[data-choose]').hidden = true;
      var f = d.querySelector('[data-reject-form]'); f.hidden = false; f.querySelector('textarea').focus(); return;
    }
    var rc = ev.target.closest('[data-reject-cancel]');
    if (rc) {
      var d2 = rc.closest('.decide'); d2.querySelector('[data-reject-form]').hidden = true;
      var ro = d2.querySelector('[data-reject-open]'); ro.setAttribute('aria-expanded', 'false');
      d2.querySelector('[data-choose]').hidden = false; ro.focus(); return;
    }
    var seg = ev.target.closest('.seg button');
    if (seg) { q('button', seg.parentNode).forEach(function (x) { x.setAttribute('aria-pressed', String(x === seg)); }); return; }
    var vt = ev.target.closest('[data-vtab-link]');
    if (vt) {
      ev.preventDefault(); root.dataset.vtab = vt.dataset.vtabLink;
      q('[data-vtab-link]').forEach(function (a) { if (a === vt) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
      return;
    }
    if (ev.target.closest('a[href="#"]')) ev.preventDefault();
  });
  document.addEventListener('submit', function (ev) { ev.preventDefault(); });

  // The section row: click toggles, hover opens, leaving closes after the grace.
  q('.dd').forEach(function (dd) {
    var btn = dd.querySelector('.sec-trigger'), panel = dd.querySelector('.dd-panel'), timer = null;
    function open() { clearTimeout(timer); q('.dd').forEach(function (o) { if (o !== dd) close(o); }); btn.setAttribute('aria-expanded', 'true'); panel.hidden = false; }
    function close(o) { var b = (o || dd).querySelector('.sec-trigger'); b.setAttribute('aria-expanded', 'false'); (o || dd).querySelector('.dd-panel').hidden = true; }
    btn.addEventListener('click', function () { if (btn.getAttribute('aria-expanded') === 'true') close(); else open(); });
    dd.addEventListener('pointerenter', function (ev) { if (ev.pointerType === 'mouse') open(); });
    dd.addEventListener('pointerleave', function (ev) {
      if (ev.pointerType !== 'mouse') return;
      var g = parseInt(root.dataset.grace, 10) || 0;
      clearTimeout(timer); if (g) timer = setTimeout(close, g); else close();
    });
    dd.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !panel.hidden) { close(); btn.focus(); } });
    dd.addEventListener('focusout', function (ev) { if (!dd.contains(ev.relatedTarget)) close(); });
  });
  document.addEventListener('click', function (ev) { if (!ev.target.closest('.dd')) q('.dd').forEach(function (dd) { dd.querySelector('.sec-trigger').setAttribute('aria-expanded', 'false'); dd.querySelector('.dd-panel').hidden = true; }); });
  if (new URLSearchParams(location.hash.slice(1)).get('menu')) {
    var m = document.querySelector('[data-group-btn="' + new URLSearchParams(location.hash.slice(1)).get('menu') + '"]');
    setTimeout(function () { m.click(); }, 0);
  }
  applyState();
})();
</script>""" % (
    str({**DEFAULTS, "vtab": "vendor"}).replace("'", '"')
)


def page():
    return f"""<!doctype html>
<html lang="en" data-mode="harness">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin console · AEC Integrations (mock-up 14)</title>
<script>if (location.search.indexOf('inner') !== -1) document.documentElement.dataset.mode = 'inner';</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,400..700;1,400..700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<!--
  Mock-up 14: the admin console in the new design language. AECI-1813, epic AECI-1729.
  GENERATED by src/14a-build.py from src/11.css (shared part) and src/14a.css. Edit those, then rebuild.
  Header and footer: copied from mock-ups 9 to 12, signed in.
  Labels, column names, statuses and messages: copied from apps/web/src/app/admin.
  Rows: invented. No real customer, reviewer or vendor data. No logos.
  The strip at the top switches the open choices. Each defaults to the recommendation (*).
  The legend panel at the bottom holds the table recipe, the chip tones and the findings.
-->
<style>
{CSS}</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
{WORDMARK}{ICONS}</svg>
{strip()}
<div class="site">
{HEADER}
<main id="main" tabindex="-1">
  <div class="wrap adm">
{SHELL_HEAD}
{QUEUE}
{DETAIL}
{OVERVIEW}
  </div>
</main>
{FOOTER}
{legend_panel()}
</div>
{SCRIPT}
</body>
</html>
"""


(HERE.parent / "14-admin-console.html").write_text(page())
print("wrote", HERE.parent / "14-admin-console.html")
