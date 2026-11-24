"""Build mock-up 13, the vendor portal (AECI-1809, epic AECI-1729).

Usage, from this folder:  python3 -I 13p-build.py
Reads 11.css (its shared part, up to the "Mock-up 11" marker), 13p.css, 13p.js,
9w-harness.css and 10-wordmark.svg, and writes ../13-vendor-portal.html.

Every label, sentence and value comes from the portal code and its preview fixtures
(apps/web/src/app/vendor/, VENDOR_ME_FIXTURE "Summit BIM", the legal fixtures), read on
2026-11-24. The acceptance screen's words are copied from vendor-legal-acceptance.ts and
STAGE_2_VENDOR_PORTAL_SPEC.md section 6.24, unchanged. Two values have no fixture and
are marked "Illustrative" on the page: the listing-hidden date and reason (taken from
vendor-listing-hidden-banner.component.spec.ts) and the X (Twitter) value that shows
the error state.
"""

from html import escape
from pathlib import Path

HERE = Path(__file__).parent
BASE = (HERE / "11.css").read_text()
BASE = BASE[: BASE.index("/* ======================================================================\n   Mock-up 11")]
CSS = BASE + (HERE / "13p.css").read_text()
JS = (HERE / "13p.js").read_text()
HARNESS_CSS = (HERE / "9w-harness.css").read_text()
WORDMARK = (HERE / "10-wordmark.svg").read_text()

COMPANY = "Summit BIM"
PRODUCT = "Summit Model Coordination"
SUPPORT = "support@aecintegrations.com"


def e(s):
    return escape(str(s), quote=True)


ICONS = """
  <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></symbol>
  <symbol id="i-chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
  <symbol id="i-right" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></symbol>
  <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></symbol>
  <symbol id="i-ext" viewBox="0 0 24 24"><path d="M7 17 17 7M8 7h9v9"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></symbol>
  <symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4M12 17h.01"/></symbol>
  <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></symbol>
  <symbol id="i-pen" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></symbol>
  <symbol id="i-users" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.8.7 3 2.4 3.5 5.2"/></symbol>
  <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></symbol>
  <symbol id="i-alert" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/></symbol>
"""


def ico(name, size=""):
    cls = "ico" + (f" {size}" if size else "")
    return f'<svg class="{cls}" aria-hidden="true"><use href="#i-{name}"/></svg>'


NEW_TAB = '<span class="sr"> (opens in a new tab)</span>' + ico("ext", "xs")
ILLUS = '<span class="mock-tag" aria-hidden="true">Illustrative</span>'

# The site header, copied from mock-ups 9 to 12, signed in: the account menu trigger
# (layout/user-menu.ts, a 32px initial circle) replaces "Sign in".
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
      <button class="acct" type="button" aria-label="Account menu" aria-haspopup="dialog" aria-expanded="false"><span aria-hidden="true">P</span></button>
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

# ---------------------------------------------------------------- the shell

VENDOR_TABS = [
    ("Vendor Overview", "overview"), ("Profile", "form"), ("Products", ""), ("Messages", ""),
    ("Conversations", ""), ("Changes", ""), ("Seats", ""), ("Billing", ""), ("Proposed products", ""),
]
PRODUCT_TABS = [
    ("Product Overview", "overview"), ("Profile", "form"), ("Categories", ""), ("Trades", ""),
    ("Audiences", ""), ("Phases", ""), ("Integrations", ""), ("Reviews", ""),
]


def tabs(items, label, cls):
    lis = "".join(
        f'<li><a href="#" data-page="{p}" data-label="{e(t)}"><span>{e(t)}</span></a></li>' for t, p in items
    )
    return f'<nav class="tabs {cls}" aria-label="{e(label)}"><ul role="list">{lis}</ul></nav>'


def crumbs(items):
    lis = "".join(f'<li><a href="#">{e(t)}</a></li>' for t in items[:-1])
    lis += f'<li><span aria-current="page">{e(items[-1])}</span></li>'
    return f'<nav class="bc" aria-label="Breadcrumb"><ol>{lis}</ol></nav>'


PORTAL_HEADER = f"""<div class="ph">
  <div class="wrap">
    <div class="ph-row">
      <div class="ctx-company">{crumbs(["Vendor portal", COMPANY])}</div>
      <div class="ctx-product">{crumbs(["Vendor portal", COMPANY, "Products", PRODUCT])}</div>
      <a class="link back ctx-product" href="#">← Back to {COMPANY}</a>
    </div>
    <div class="ph-title">
      <span class="tile" aria-hidden="true">S</span>
      <h1 tabindex="-1"><span class="ctx-company">{COMPANY}</span><span class="ctx-product">{PRODUCT}</span></h1>
      <div class="ph-meta">
        <span class="ctx-product"><span class="chip plan managed">Managed</span></span>
        <a class="link" href="#" target="_blank" rel="noopener">View public page{NEW_TAB}</a>
      </div>
    </div>
  </div>
</div>"""

# ---------------------------------------------------------------- banners (exact copy)

PLAN_ENDED = f"""<section class="notice banner ended" aria-labelledby="vendor-plan-ended-h">
  <h2 id="vendor-plan-ended-h">Your Managed plan has ended</h2>
  <p class="lede-s">It ended on November 10, 2026. Your products are now on the Free plan. Ending a plan removes nothing you entered.</p>
  <div class="cols">
    <div>
      <h3 class="overline">Still works</h3>
      <ul class="dots">
        <li>Your listings stay published, exactly as they are</li>
        <li>Editing your company details</li>
        <li>Editing product descriptions, websites, logos and categories</li>
        <li>Seats and sign-in for you and your colleagues</li>
        <li>Marking details and integration lists as checked</li>
        <li>Claiming integrations, adding links and requesting corrections</li>
        <li>Adding a new integration</li>
      </ul>
    </div>
    <div>
      <h3 class="overline">Read-only now</h3>
      <ul class="dots">
        <li>"How teams use it", the integrations page URL and the API documentation URL</li>
        <li>Trades, audiences and phases</li>
        <li>Your data flow answers. They stay as you left them, and readers still see them.</li>
      </ul>
    </div>
  </div>
  <p class="foot-row"><a class="btn btn-primary" href="#">Go to Billing</a><span>A new subscription picks up from what your listings show now.</span></p>
</section>"""

LEGAL_PROMPT = f"""<section class="notice banner legal" aria-labelledby="lp-h">
  <div class="acc">
    <div>
      <h2 id="lp-h" tabindex="-1">Vendor Terms, version 1.3, is ready for you to accept</h2>
      <div class="lead">
        <p>Version 1.3 of the Vendor Terms takes effect on Jan 31, 2027.</p>
        <p>This version changes the liability, indemnity, disputes or content license sections in a way that reduces your rights. That change applies to {COMPANY} only after an owner seat accepts it. Until then the earlier version applies to you.</p>
      </div>
      <h3 class="what">What changes</h3>
      <ul class="dots"><li>The indemnity now covers content you upload, not content we write.</li></ul>
      <p class="read"><a class="inlink" href="#" target="_blank" rel="noopener">Read version 1.3 of the Vendor Terms<span class="sr"> (opens in a new tab)</span></a></p>
      <form method="dialog" novalidate>
        <div class="grid2">
          <div class="fld">
            <label class="field-label" for="lp-title">Your title</label>
            <input class="field" id="lp-title" type="text" autocomplete="organization-title" value="Head of Partnerships" aria-describedby="lp-title-hint">
            <p class="hint" id="lp-title-hint">We record your title with your acceptance.</p>
          </div>
          <div class="fld">
            <label class="field-label" for="lp-ln">Company legal name</label>
            <input class="field" id="lp-ln" type="text" autocomplete="organization" value="Northwind Software, Inc." aria-describedby="lp-ln-hint">
            <p class="hint" id="lp-ln-hint">The registered name of the company you accept for.</p>
          </div>
        </div>
        <div class="consent">
          <input id="lp-accept" type="checkbox">
          <label for="lp-accept">I have read and accept the Vendor Terms, version 1.3, on behalf of {COMPANY}, and I am authorized to bind that company.</label>
        </div>
        <div>
          <div class="acts">
            <button class="btn btn-primary" type="submit" disabled>Accept version 1.3</button>
            <button class="btn btn-secondary" type="button">Not now</button>
          </div>
          <p class="hint">You can keep using the portal. We ask again on your next visit.</p>
        </div>
      </form>
    </div>
    <div>
      <p class="hint">We record your name and title, the company's legal name, the time and the version. Owner seats can see the record on the Billing tab.</p>
    </div>
  </div>
</section>"""

LISTING_HIDDEN = f"""<section class="notice banner hidden" aria-labelledby="vendor-product-listing-hidden-h">
  <h2 id="vendor-product-listing-hidden-h">Hidden from the public site by AEC Integrations on November 20, 2026{ILLUS}</h2>
  <p class="reason">Reason: A complaint names this listing.</p>
  <p class="body-s">Your portal still works and your edits still save. To dispute this, email <a class="inlink ink" href="#">{SUPPORT}</a> and quote this message.</p>
</section>"""

# ---------------------------------------------------------------- Overview

NEEDS_NOW = [
    ("warn bad", f"{PRODUCT} has a data flow in conflict", "Another source describes the same flow differently. Both positions show on the public pair page until one changes.", "In conflict", "conflict"),
    ("clock", f"A correction was suggested to {COMPANY}", "Filed August 2, 2026. AEC Integrations reviews it and records the outcome in Messages.", "Open", ""),
    ("clock", f"A correction was suggested to {PRODUCT}", "Filed July 20, 2026. AEC Integrations reviews it and records the outcome in Messages.", "In review", ""),
    ("clock", "2 change requests are waiting for your decision", "Accept or decline them in Messages. An accepted request changes the public integration page.", "To decide", ""),
    ("clock", "A vendor asked AEC Integrations to review one of your change request decisions", "You can reply once to each, in Messages. AEC Integrations says which side it agrees with. Its view is advice, and nothing about it is public.", "Reply by the due date", ""),
    ("clock", "1 row another company added needs your answer", "Until you answer, the public page shows each one as confirmed by the company that added it.", "To answer", ""),
]
WORTH = [
    ("pen", f"Confirm what {PRODUCT} moves", "3 data flows on this product have no position from you yet.", "3 waiting"),
    ("pen", "Confirm what Summit Field Issues moves", "One data flow on this product has no position from you yet.", "1 waiting"),
    ("pen", "2 reviews of Summit Field Issues have no reply from you", "You can answer each review once, in public. AEC Integrations checks every reply before it shows.", "2 reviews"),
    ("pen", f"A review of {PRODUCT} has no reply from you", "You can answer each review once, in public. AEC Integrations checks every reply before it shows.", "1 review"),
    ("pen", f"{PRODUCT} is missing a logo", "Buyers compare listings side by side. An empty field reads as an unanswered question.", "1 field"),
    ("pen", "Summit Field Issues is missing a website and a logo", "Buyers compare listings side by side. An empty field reads as an unanswered question.", "2 fields"),
    ("pen", "Your company profile is missing a logo", "This is the company record behind every one of your product listings.", "1 field"),
    ("users", "3 seat invites are still unaccepted", "You can re-send or revoke invites from Seats.", "Not accepted"),
]


def row(icon, title, line, status, tone=""):
    name, *cls = icon.split()
    return f"""<li><a class="row" href="#">{ico(name, " ".join(cls))}<span><span class="row-t">{e(title)}</span><span class="row-d">{e(line)}</span></span><span class="chip st {tone}">{e(status)}</span>{ico("right", "s chev")}</a></li>"""


OVERVIEW = f"""<section class="page overview" aria-label="Vendor Overview">
  <div class="ov">
    <div class="ov-side">
      <div class="glance2">
        <a class="pc gl" href="#">
          <span class="gl-l">In conflict</span>
          <span class="gl-fig"><span class="badge bad">{ico("x", "s")}</span><b class="bad num">1</b></span>
          <span class="gl-s">On {PRODUCT}</span>
        </a>
        <a class="pc gl" href="#">
          <span class="gl-l">Suggestions about your listing</span>
          <span class="gl-fig"><span class="badge attn" aria-hidden="true">!</span><b class="num">2</b></span>
          <span class="gl-s">Newest filed August 2, 2026</span>
        </a>
      </div>
      <section class="pc pc-pad ck" aria-labelledby="ck-h">
        <div class="ck-h"><h2 id="ck-h">Getting started</h2><span class="score">1 of 2 done</span></div>
        <p class="lede-s">Your company, then each product. Each step finishes when you take the action.</p>
        <a class="learn" href="#" target="_blank" rel="noopener">Learn more<span class="sr">: Your checklists</span>{NEW_TAB}</a>
        <div class="bar" aria-hidden="true"><i class="on"></i><i></i></div>
        <ol class="steps">
          <li><span class="mk done" aria-hidden="true">{ico("check", "s")}</span><p class="st-t">Check your company details<span class="sr">Done</span></p><p class="st-d">Checked. To record a later check, save an edit on your profile.</p><p class="st-a"><a class="btn btn-secondary" href="#">Review company</a></p></li>
          <li><span class="mk" aria-hidden="true">2</span><p class="st-t">Finish each product checklist<span class="sr">Not done</span></p><p class="st-d">0 of 2 product checklists done.</p><p class="st-a"><a class="btn btn-secondary" href="#">Go to products</a></p></li>
          <li><span class="mk done" aria-hidden="true">{ico("check", "s")}</span><p class="st-t">Invite a colleague <span class="chip tag">Optional</span><span class="sr">Done</span></p><p class="st-d">Someone else can keep the listing current when you are away.</p></li>
        </ol>
      </section>
    </div>
    <div class="ov-main">
      <section aria-labelledby="nd-h">
        <h2 id="nd-h" class="nd-h">What needs you</h2>
        <div class="nd-intro"><p class="sub">14 things are outstanding.</p><a class="learn" href="#" target="_blank" rel="noopener">Learn more<span class="sr">: Your dashboard</span>{NEW_TAB}</a></div>
        <div class="pc nd">
          <section class="nd-g" aria-labelledby="nd-now"><h3 class="overline" id="nd-now">Needs you now</h3><ul role="list">{"".join(row(i, t, d, s, c) for i, t, d, s, c in NEEDS_NOW)}</ul></section>
          <section class="nd-g" aria-labelledby="nd-worth"><h3 class="overline" id="nd-worth">Worth doing</h3><ul role="list">{"".join(row(i, t, d, s) for i, t, d, s in WORTH)}</ul></section>
        </div>
      </section>
    </div>
  </div>
  <p class="prod-note">Mock-up note: this round draws the shell in a product's context. The product pages come in their own round.</p>
</section>"""

# ---------------------------------------------------------------- the company Profile form


def text_field(fid, label, value="", kind="text", auto=None, extra="", after="", span=False, readonly=False, invalid=False):
    a = f' autocomplete="{auto}"' if auto else ""
    ro = " readonly" if readonly else ""
    inv = ' aria-invalid="true"' if invalid else ""
    return f"""<div class="fld{' span2' if span else ''}">
  <label class="field-label" for="{fid}">{e(label)}</label>
  <input class="field" id="{fid}" type="{kind}" value="{e(value)}"{a}{ro}{inv}{extra}>
  {after}
</div>"""


def choice(fid, label, options, selected):
    opts = "".join(
        f'<li role="option" class="opt" tabindex="{0 if o == selected else -1}" aria-selected="{"true" if o == selected else "false"}">{ico("check", "xs tick")}{e(o)}</li>'
        for o in options
    )
    return f"""<div class="fld span2">
  <span class="field-label" id="{fid}-label">{e(label)}</span>
  <ul class="opts" role="listbox" aria-orientation="horizontal" aria-labelledby="{fid}-label">{opts}</ul>
</div>"""


LOCK = """<p class="lock" id="pf-phone-locked">""" + ico("lock", "s") + """<span><strong style="color:var(--text-primary);font-weight:600">Set by AEC Integrations.</strong> Reason: The value on file reaches a different company. We checked the company register. To dispute it, email support@aecintegrations.com and quote this reason.</span></p>"""

X_ERROR = (
    '<p class="ferr err-only" id="pf-x-error" role="alert">' + ico("alert", "s") + "<span>Enter a URL starting with http:// or https://</span></p>"
)

FORM = f"""<section class="page form" aria-labelledby="pf-h">
  <div class="pf">
    <div class="sec-h"><h2 id="pf-h">Vendor profile</h2><a class="learn" href="#" target="_blank" rel="noopener">Learn more<span class="sr">: Editing your profile and products</span>{NEW_TAB}</a></div>
    <div class="pf-hint"><p>Your company name and the address of your public listing are on record with AEC Integrations, so they are not editable here. To change either, <a class="inlink" href="#" target="_blank" rel="noopener">send us a correction request<span class="sr"> (opens in a new tab)</span></a>.</p></div>
    <form class="pc pc-pad roomy flush pf-form" method="dialog" novalidate aria-labelledby="pf-h">
      <fieldset class="fs">
        <legend class="overline">Profile details</legend>
        <div class="grid2">
          <div class="fld span2">
            <span class="field-label" id="pf-logo-label">Logo</span>
            <div class="logo-row"><span class="logo-box">No logo</span><button class="btn btn-secondary" type="button" aria-describedby="pf-logo-label pf-logo-hint">Add logo</button></div>
            <p class="hint" id="pf-logo-hint">PNG, JPEG or static WebP, up to 2 MiB and 2048 pixels per side. Logos are public.</p>
          </div>
          <div class="fld span2">
            <label class="field-label" for="pf-desc">Description</label>
            <textarea class="field" id="pf-desc" rows="4">Model coordination and field tooling for AEC teams. Founded by structural engineers.</textarea>
          </div>
          {text_field("pf-web", "Website", "https://summitbim.example.com", "url", "url")}
          {text_field("pf-hq", "Headquarters", "Denver, CO")}
          {text_field("pf-year", "Founded year", "2014", "text", None, ' inputmode="numeric"')}
          {text_field("pf-parent", "Parent company", "")}
          {text_field("pf-email", "Contact email", "hello@summitbim.example.com", "email", "email")}
          {text_field("pf-phone", "Phone number", "+1 303 555 0142", "tel", "tel", ' aria-describedby="pf-phone-locked"', LOCK, readonly=True)}
          {choice("pf-own", "Ownership", ["Not specified", "Public", "Private", "Subsidiary", "Nonprofit"], "Private")}
          {choice("pf-size", "Company size", ["Not specified", "1–10", "11–50", "51–200", "201–1,000", "1,001+"], "51–200")}
          {choice("pf-fund", "Funding stage", ["Not specified", "Bootstrapped", "Pre-seed", "Seed", "Series A", "Series B", "Series C", "Series D+", "Publicly traded"], "Series A")}
        </div>
      </fieldset>
      <fieldset class="fs">
        <legend class="overline">Links</legend>
        <div class="grid2">
          {text_field("pf-li", "LinkedIn", "https://www.linkedin.com/company/summit-bim", "url")}
          <div class="fld">
            <label class="field-label" for="pf-x">X (Twitter){ILLUS}</label>
            <input class="field err-only" id="pf-x" type="url" value="twitter.com/summitbim" aria-invalid="true" aria-describedby="pf-x-error">
            <input class="field saved-only" id="pf-x-saved" type="url" value="" aria-label="X (Twitter)">
            {X_ERROR}
          </div>
          {text_field("pf-fb", "Facebook", "", "url")}
          {text_field("pf-ig", "Instagram", "", "url")}
          {text_field("pf-yt", "YouTube", "", "url")}
        </div>
      </fieldset>
      <div class="savebar">
        <p class="msg ok saved-only" role="status">Profile updated. Your listing shows the change now. Search on AEC Integrations updates within a day. Google and other search engines update on their own schedule.</p>
        <button class="btn btn-primary" type="submit">Save changes</button>
      </div>
    </form>
  </div>
  <p class="prod-note">Mock-up note: this round draws the shell in a product's context. The product pages come in their own round.</p>
</section>"""

# ---------------------------------------------------------------- the acceptance screen (required, owner)

ACCEPT = f"""<section class="page accept" aria-labelledby="acc-h" data-mode="required">
  <div class="acc">
    <div class="pc pc-pad roomy flush">
      <h2 id="acc-h" tabindex="-1">Accept the Vendor Terms, version 1.3</h2>
      <div class="lead">
        <p>Version 1.3 of the Vendor Terms took effect on Dec 15, 2026. Your company has not accepted a version that is in force yet, so the portal opens once an owner seat accepts this one. Any owner seat can accept for {COMPANY}.</p>
        <p>Your listing stays claimed in the meantime. There is no deadline.</p>
      </div>
      <h3 class="what">What changes</h3>
      <ul class="dots">
        <li>The liability cap counts the fees you paid in the 12 months before a claim.</li>
        <li>Disputes go to the courts named in the terms, with a jury waiver.</li>
      </ul>
      <p class="read"><a class="inlink" href="#" target="_blank" rel="noopener">Read version 1.3 of the Vendor Terms<span class="sr"> (opens in a new tab)</span></a></p>
      <form method="dialog" novalidate>
        <div class="grid2">
          <div class="fld">
            <label class="field-label" for="acc-title">Your title</label>
            <input class="field" id="acc-title" type="text" autocomplete="organization-title" value="Head of Partnerships" aria-describedby="acc-title-hint">
            <p class="hint" id="acc-title-hint">We record your title with your acceptance.</p>
          </div>
          <div class="fld">
            <label class="field-label" for="acc-ln">Company legal name</label>
            <input class="field" id="acc-ln" type="text" autocomplete="organization" value="Northwind Software, Inc." aria-describedby="acc-ln-hint">
            <p class="hint" id="acc-ln-hint">The registered name of the company you accept for.</p>
          </div>
        </div>
        <div class="consent">
          <input id="acc-accept" type="checkbox">
          <label for="acc-accept">I have read and accept the Vendor Terms, version 1.3, on behalf of {COMPANY}, and I am authorized to bind that company.</label>
        </div>
        <div class="acts"><button class="btn btn-primary" type="submit" disabled>Accept version 1.3</button></div>
      </form>
    </div>
    <div class="pc pc-pad aside">
      <h3 id="acc-aside">What happens when an owner accepts</h3>
      <ul class="dots">
        <li>The portal opens for every seat at {COMPANY}.</li>
        <li>We record the owner's name and title, the company's legal name, the time and the version. Owner seats can see the record on the Billing tab.</li>
        <li>Questions about these terms go to {SUPPORT}.</li>
      </ul>
      <div class="bill">
        <p>You can still manage or cancel your billing.</p>
        <button class="btn btn-secondary" type="button">Manage billing in Stripe</button>
      </div>
    </div>
  </div>
</section>"""

# ---------------------------------------------------------------- the page

BODY = f"""{HEADER}

<main id="main">
{PORTAL_HEADER}
<div class="wrap pbody">
  <div class="slot">
{PLAN_ENDED}
{LEGAL_PROMPT}
{LISTING_HIDDEN}
  </div>
  <div class="ctx-company">{tabs(VENDOR_TABS, "Portal sections", "")}</div>
  <div class="ctx-product">{tabs(PRODUCT_TABS, f"{PRODUCT} sections", "")}</div>
{OVERVIEW}
{FORM}
{ACCEPT}
  <p class="sr" role="status"></p>
</div>
</main>

{FOOTER}"""

HTML = f"""<!doctype html>
<html lang="en" data-head="plain" data-cards="card" data-tabs="underline" data-crumb="shared" data-page="overview" data-banner="none" data-ctx="company" data-fstate="error">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vendor Overview · Summit BIM · Vendor portal | AEC Integrations</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,400..700;1,400..700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<!--
  Mock-up 13: the vendor portal, /vendor/:vendorSlug, in the November 2026 design language
  (AECI-1809, epic AECI-1729). The shell plus three pages: Overview, the company Profile
  form and the acceptance screen. Opened on its own, the file shows a control strip and
  the page in a frame. Each control's default is the recommendation, not a decision.
  With ?frame=1 the file is the page alone; every control is a URL parameter.

  GENERATED by src/13p-build.py from src/13p.css, src/13p.js, src/11.css (shared part),
  src/9w-harness.css and src/10-wordmark.svg. Edit those, then rebuild.
  Header and footer: copied from mock-ups 9 to 12, with the signed-in account trigger.
  Content: the portal code and its preview fixtures (Summit BIM), read 2026-11-24.
-->
<style>
{CSS}</style>
<style id="harness-css" media="not all">
{HARNESS_CSS}</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
{WORDMARK}{ICONS}</svg>

{BODY}

<script>
{JS}</script>
</body>
</html>
"""

out = HERE.parent / "13-vendor-portal.html"
out.write_text(HTML)
print("wrote", out, len(HTML))
