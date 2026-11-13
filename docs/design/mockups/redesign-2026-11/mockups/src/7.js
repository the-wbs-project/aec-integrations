  /* ---------- Data ---------- */
  var SELF = { name: "Procore Project Management", short: "Procore", vendor: "Procore" };
  var OBJECTS = ["RFIs", "Submittals", "Drawings", "Markups", "Punch lists", "Daily logs", "Schedules", "Budgets", "Cost codes", "Invoices", "Change orders", "Commitments", "Timesheets", "Equipment", "Observations", "Models", "Contacts"];
  var CATS = ["Accounting and ERP", "Scheduling", "Estimating", "BIM and design", "Document management", "Field and safety", "HR and payroll", "Analytics", "CRM", "Equipment"];
  var CAT_IC = { "Accounting and ERP": "Invoices", "Scheduling": "Schedules", "Estimating": "calc", "BIM and design": "Models", "Document management": "Drawings", "Field and safety": "trade", "HR and payroll": "Timesheets", "Analytics": "chart", "CRM": "Contacts", "Equipment": "Equipment" };
  var CAT_SHORT = { "Accounting and ERP": "Accounting", "Document management": "Documents", "Field and safety": "Field", "HR and payroll": "HR and payroll", "BIM and design": "BIM and design" };
  var MECH = { native: ["Native", "plug"], marketplace: ["Marketplace app", "store"], api: ["API", "code"], partner: ["Partner built", "handshake"] };
  // name, vendor, existing mark, categories (main first), data objects, direction, connection, attestation, short name
  var RAW = [
    ["Sage Intacct Construction", "Sage", "intacct", "Accounting and ERP", "Budgets|Cost codes|Invoices|Commitments|Change orders", "both", "marketplace", "both", "Sage Intacct"],
    ["Viewpoint Vista", "Trimble", "vista", "Accounting and ERP", "Invoices|Commitments|Change orders|Cost codes|Budgets", "both", "partner", "both", "Vista"],
    ["Spectrum", "Trimble", "spectrum", "Accounting and ERP", "Invoices|Cost codes|Commitments|Budgets", "both", "api", "both"],
    ["CMiC", "CMiC", "cmic", "Accounting and ERP", "Invoices|Commitments|Change orders|Contacts", "both", "api", "both"],
    ["Sage 300 CRE", "Sage", "", "Accounting and ERP", "Invoices|Commitments|Cost codes|Budgets", "both", "partner", "both"],
    ["Foundation Software", "Foundation Software", "foundation", "Accounting and ERP", "Commitments|Change orders|Invoices", "both", "partner", "self", "Foundation"],
    ["Jonas Premier", "Jonas", "jonas", "Accounting and ERP", "Invoices|Budgets|Cost codes", "both", "api", "other"],
    ["Penta", "Penta Technologies", "", "Accounting and ERP", "Invoices|Commitments", "both", "api", "other"],
    ["QuickBooks Online", "Intuit", "", "Accounting and ERP", "Invoices|Cost codes", "out", "marketplace", "self", "QuickBooks"],
    ["Oracle NetSuite", "Oracle", "", "Accounting and ERP", "Invoices|Budgets", "out", "marketplace", "none", "NetSuite"],
    ["Acumatica Construction", "Acumatica", "acumatica", "Accounting and ERP", "Invoices|Cost codes", "out", "via:Workato", "none", "Acumatica"],
    ["Dynamics 365 Business Central", "Microsoft", "d365", "Accounting and ERP", "Invoices|Budgets", "out", "via:Workato", "none", "Business Central"],
    ["Oracle Primavera P6", "Oracle", "", "Scheduling", "Schedules|Daily logs", "both", "native", "both", "Primavera P6"],
    ["Microsoft Project", "Microsoft", "", "Scheduling", "Schedules", "in", "native", "self", "MS Project"],
    ["Asta Powerproject", "Elecosoft", "", "Scheduling", "Schedules", "both", "marketplace", "other", "Powerproject"],
    ["SmartPM", "SmartPM Technologies", "", "Scheduling|Analytics", "Schedules|Daily logs", "in", "api", "both"],
    ["Touchplan", "Touchplan", "", "Scheduling", "Schedules|Daily logs|Observations", "both", "marketplace", "self"],
    ["ALICE", "ALICE Technologies", "", "Scheduling", "Schedules|Models", "in", "api", "none"],
    ["STACK", "STACK Construction Technologies", "", "Estimating", "Budgets|Cost codes|Drawings", "in", "marketplace", "both"],
    ["ProEst", "Autodesk", "", "Estimating", "Budgets|Cost codes", "in", "native", "both"],
    ["Sage Estimating", "Sage", "", "Estimating", "Budgets|Cost codes", "in", "partner", "self"],
    ["DESTINI Estimator", "Beck Technology", "", "Estimating|BIM and design", "Budgets|Cost codes|Models", "in", "api", "other", "DESTINI"],
    ["PlanSwift", "ConstructConnect", "", "Estimating", "Drawings|Budgets", "in", "marketplace", "none"],
    ["Togal.AI", "Togal", "", "Estimating", "Drawings", "in", "api", "none"],
    ["Bluebeam Revu", "Bluebeam", "revu", "BIM and design|Document management", "Drawings|Markups|RFIs|Submittals|Change orders", "both", "native", "both", "Revu"],
    ["Revizto", "Revizto", "", "BIM and design", "Models|RFIs|Observations", "both", "marketplace", "both"],
    ["Navisworks", "Autodesk", "", "BIM and design", "Models|Drawings", "in", "native", "self"],
    ["Trimble Connect", "Trimble", "", "BIM and design", "Models|Drawings|RFIs", "both", "api", "other"],
    ["Drawboard Projects", "Drawboard", "drawboard", "BIM and design", "Drawings|Markups", "both", "api", "self", "Drawboard"],
    ["Autodesk Docs", "Autodesk", "acc", "Document management|BIM and design", "Drawings|Models|RFIs|Submittals", "both", "native", "both"],
    ["Newforma Konekt", "Newforma", "newforma", "Document management|BIM and design", "Submittals|RFIs|Drawings", "both", "api", "other", "Newforma"],
    ["Egnyte", "Egnyte", "egnyte", "Document management", "Drawings|Submittals", "out", "native", "self"],
    ["Box", "Box", "", "Document management", "Drawings|Submittals", "out", "marketplace", "none"],
    ["SharePoint", "Microsoft", "", "Document management", "Drawings|Submittals|RFIs", "out", "marketplace", "self"],
    ["DocuSign", "DocuSign", "", "Document management", "Commitments|Change orders", "both", "native", "both"],
    ["Dropbox", "Dropbox", "", "Document management", "Drawings", "out", "marketplace", "none"],
    ["Acrobat Sign", "Adobe", "", "Document management", "Commitments|Change orders", "both", "marketplace", "other"],
    ["SafetyCulture", "SafetyCulture", "", "Field and safety", "Observations|Punch lists|Daily logs", "in", "marketplace", "both"],
    ["HammerTech", "HammerTech", "", "Field and safety", "Observations|Contacts|Daily logs", "both", "api", "both"],
    ["Raken", "Raken", "", "Field and safety|HR and payroll", "Daily logs|Timesheets|Observations", "in", "marketplace", "self"],
    ["OpenSpace", "OpenSpace", "", "Field and safety|BIM and design", "Drawings|Observations|Punch lists", "both", "native", "both"],
    ["Buildots", "Buildots", "", "Field and safety", "Schedules|Observations", "in", "api", "other"],
    ["Rhumbix", "Rhumbix", "", "Field and safety|HR and payroll", "Timesheets|Daily logs", "in", "api", "self"],
    ["Highwire", "Highwire", "", "Field and safety", "Contacts|Observations", "in", "api", "none"],
    ["ADP Workforce Now", "ADP", "", "HR and payroll", "Timesheets|Contacts", "out", "partner", "other", "ADP"],
    ["Paychex Flex", "Paychex", "", "HR and payroll", "Timesheets", "out", "api", "none", "Paychex"],
    ["LCPtracker", "LCPtracker", "", "HR and payroll", "Timesheets|Contacts", "out", "marketplace", "both"],
    ["Workday", "Workday", "", "HR and payroll", "Contacts|Timesheets", "in", "partner", "none"],
    ["ClockShark", "ClockShark", "", "HR and payroll", "Timesheets|Daily logs", "in", "marketplace", "self"],
    ["Power BI", "Microsoft", "", "Analytics", "Budgets|RFIs|Submittals|Change orders", "out", "native", "self"],
    ["Tableau", "Salesforce", "", "Analytics", "Budgets|RFIs", "out", "api", "none"],
    ["Snowflake", "Snowflake", "", "Analytics", "Budgets|Invoices|RFIs|Daily logs", "out", "api", "other"],
    ["Salesforce", "Salesforce", "", "CRM", "Contacts|Budgets", "both", "marketplace", "both"],
    ["HubSpot", "HubSpot", "", "CRM", "Contacts", "both", "via:Workato", "none"],
    ["Cosential", "Unanet", "", "CRM", "Contacts|Budgets", "both", "api", "other"],
    ["Tenna", "Tenna", "", "Equipment", "Equipment|Timesheets", "both", "marketplace", "both"],
    ["HCSS HeavyJob", "HCSS", "", "Equipment|HR and payroll", "Equipment|Timesheets|Daily logs", "both", "api", "self", "HeavyJob"],
    ["Trackunit", "Trackunit", "", "Equipment", "Equipment", "in", "api", "none"]
  ];
  var INTS = RAW.map(function (r) {
    var it = { name: r[0], vendor: r[1], logo: r[2] || genMark(), cats: r[3].split("|"), objs: r[4].split("|"), dir: r[5], att: r[7] };
    if (r[6].indexOf("via:") === 0) it.via = r[6].slice(4); else it.mech = r[6] || null;
    if (r[8]) it.short = r[8];
    return it;
  });
  var ATT_W = { both: 2, self: 1, other: 1, none: 0 };

  var USE = [
    { label: "By audience", ic: "users", groups: [
      { name: "General contractors", pts: ["Run RFIs and submittals with one ball-in-court list", "Keep the current drawing set on every phone in the field", "Track budget, commitments and change orders in one place"] },
      { name: "Owners", pts: ["See every project across a portfolio on one screen", "Approve pay applications with the backup attached", "Keep closeout documents for the life of the building"] },
      { name: "Specialty contractors", pts: ["Answer RFIs from the GC without a second login", "Log daily manpower and photos from site", "Send T and M tickets for signature the same day"] } ] },
    { label: "By phase", ic: "phase", groups: [
      { name: "Preconstruction", pts: ["Bid management with invited trade partners", "Turn an estimate into the project budget"] },
      { name: "Construction", pts: ["Daily logs, observations and inspections from the field", "RFI and submittal workflows with due dates", "Meeting minutes linked to open items"] },
      { name: "Closeout", pts: ["Punch lists assigned to the right trade", "Hand over a searchable record to the owner"] } ] }
  ];

  var EXT = [
    { name: "Spec Reader", vendor: "Northline Software", q: 4.5, o: 4.6, reviews: 38 },
    { name: "Meeting Minutes Plus", vendor: "Sitewise Apps", q: 4.2, o: 4.4, reviews: 21 },
    { name: "Closeout Binder", vendor: "Turnover Labs", q: 4.4, o: 4.1, reviews: 17 },
    { name: "Punch Sweep", vendor: "Fieldmark", q: 4.0, o: 4.3, reviews: 12 },
    { name: "Weather Delay Log", vendor: "Skyline Data", q: 3.9, o: 4.5, reviews: 8 },
    { name: "RFI Assistant", vendor: "Quillwork", q: null, o: null, reviews: 3 }
  ];
  EXT.forEach(function (x) { x.logo = genMark(); });

  var REL = [
    { name: "Autodesk Construction Cloud", vendor: "Autodesk", logo: "acc", q: 4.2, o: 3.7, reviews: 873, ints: 44 },
    { name: "Trimble ProjectSight", vendor: "Trimble", logo: "projectsight", q: 4.1, o: 3.9, reviews: 134, ints: 22 },
    { name: "Bluebeam Revu", vendor: "Bluebeam", logo: "revu", q: 4.5, o: 4.2, reviews: 212, ints: 14 },
    { name: "Newforma", vendor: "Newforma", logo: "newforma", q: 4.0, o: 3.9, reviews: 23, ints: 9 }
  ];
  // Sample unclaimed listings: about a third of partners, spread through every category and into the hero ring.
  unclaim(["Sage 300 CRE", "Penta", "Oracle NetSuite", "Acumatica Construction", "Asta Powerproject", "ALICE", "Sage Estimating", "PlanSwift", "Togal.AI",
    "Trimble Connect", "Box", "Dropbox", "Buildots", "Highwire", "Paychex Flex", "Workday", "Tableau", "Cosential", "Trackunit", "Trimble ProjectSight"], [INTS, REL]);

  var REVIEWS = [
    { t: "Everyone is finally on the same record", q: 5, o: 4, role: "Project manager, general contractor", yrs: 5, rec: "yes", d: "4 Nov 2026",
      b: "RFIs, submittals and drawings in one place means the owner, the architect and our trades are looking at the same thing. The ball-in-court view runs our weekly meeting." },
    { t: "Strong product, long rollout", q: 5, o: 2, role: "Director of operations, general contractor", yrs: 2, rec: "maybe", d: "30 Oct 2026",
      b: "The tool does what we need. Moving 40 active jobs across took a full quarter, and the permission templates needed far more setup than the sales team suggested.",
      reply: { d: "2 Nov 2026", b: "Thank you for the detail. Our implementation team now starts with a permission template workshop for companies moving more than 20 projects at once." } },
    { t: "The accounting link is the reason we stayed", q: 4, o: 4, role: "Controller, specialty contractor", yrs: 4, rec: "yes", d: "22 Oct 2026",
      b: "Commitments and change orders flow to our ERP without double entry. Cost code mapping took a week to get right, but it has not needed attention since." },
    { t: "Field team actually uses it", q: 5, o: 5, role: "Superintendent, general contractor", yrs: 3, rec: "yes", d: "15 Oct 2026",
      b: "Daily logs and photos from the phone take a few minutes. The crew picked it up in one morning, which is more than I can say for anything else we have tried." },
    { t: "Good, but priced for bigger firms", q: 4, o: 3, role: "Owner, design-build firm", yrs: 1, rec: "maybe", d: "7 Oct 2026",
      b: "For a firm our size the annual volume pricing is hard to justify. The software itself is solid.",
      upd: { d: "28 Oct 2026", b: "We moved to a smaller plan after a call with our account manager. Raising my onboarding score.", q: 4, o: 4 } },
    { t: "Too many places to click for simple things", q: 3, o: 3, role: "Project engineer, mechanical contractor", yrs: 2, rec: "no", d: "1 Oct 2026",
      b: "Finding a single submittal can take four screens. Search helps, but the menus feel built for the GC, not for the trades." }
  ];
  var MORE = [
    { t: "Owners portal saves us reporting time", q: 5, o: 4, role: "Owner's representative, healthcare system", yrs: 3, rec: "yes", d: "24 Sep 2026", b: "Portfolio dashboards replaced a monthly spreadsheet we built by hand. The project teams update it just by doing their work." },
    { t: "Reliable, with good support", q: 4, o: 4, role: "Document controller, construction manager", yrs: 6, rec: "yes", d: "16 Sep 2026", b: "Very little downtime in six years. When something breaks, support answers the same day." },
    { t: "Closeout is easier than it used to be", q: 4, o: 4, role: "Project coordinator, general contractor", yrs: 2, rec: "yes", d: "9 Sep 2026", b: "Closeout documents are already in one place by the end of the job. Handover went from weeks to days." }
  ];

  var state = { q: "", dir: "all", objs: [], cats: [], view: "cards", group: true, sort: "merit" };
  var DIRS = { out: "Sends to ", in: "Receives from ", both: "Syncs both ways" };

  function dirLabel(it) { return it.dir === "both" ? DIRS.both : DIRS[it.dir] + it.name; }
  function dirIcon(it) { return it.dir === "both" ? "twoway" : (it.dir === "out" ? "oneway" : "inway"); }
  function attLabel(it) {
    if (it.att === "both") return "Confirmed by both companies";
    if (it.att === "self") return "Confirmed by " + SELF.vendor;
    if (it.att === "other") return "Confirmed by " + it.vendor;
    return "Listed by AEC Integrations";
  }
  function attHtml(it) {
    var st = it.att === "both" ? "confirmed" : (it.att === "none" ? "unverified" : "single");
    var aria = st === "confirmed" ? "Confirmed by both companies." : (st === "single" ? attLabel(it) + ". The other company has not answered yet." : "Listed by AEC Integrations from public sources. Neither company has confirmed it yet.");
    return '<span class="agree ' + st + '" aria-label="' + aria + '"><span class="dot" aria-hidden="true"></span>' + attLabel(it) + "</span>";
  }
  function mechHtml(it) {
    if (it.via) return '<span class="mech">' + mark("workato") + "<span>Via <b>" + it.via + "</b></span></span>";
    if (!it.mech) return '<span class="mech">' + icon("gear") + "<span>Connection not listed</span></span>";
    var m = MECH[it.mech];
    return '<span class="mech">' + icon(m[1]) + "<span><b>" + m[0] + "</b></span></span>";
  }
  function hits(it) { return it.objs.filter(function (o) { return has(state.objs, o); }).length; }
  function matchesWith(it, s) {
    if (s.q && (it.name + " " + it.vendor + " " + (it.via || "") + " " + (it.mech ? MECH[it.mech][0] : "")).toLowerCase().indexOf(s.q.toLowerCase()) === -1) return false;
    if (s.dir !== "all" && it.dir !== s.dir) return false;
    if (!s.objs.every(function (o) { return has(it.objs, o); })) return false;
    if (s.cats.length && !it.cats.some(function (c) { return has(s.cats, c); })) return false;
    return true;
  }
  function matches(it) { return matchesWith(it, state); }
  function facet(over) {
    var s = { q: state.q, dir: state.dir, objs: state.objs, cats: state.cats };
    for (var k in over) s[k] = over[k];
    return INTS.filter(function (it) { return matchesWith(it, s); }).length;
  }
  function rank(items) {
    return items.slice().sort(function (a, b) {
      return (hits(b) - hits(a)) || (ATT_W[b.att] - ATT_W[a.att]) || (b.objs.length - a.objs.length) || cmpName(a.name, b.name);
    });
  }
  function merit(items) {
    return items.slice().sort(function (a, b) { return (ATT_W[b.att] - ATT_W[a.att]) || (b.objs.length - a.objs.length) || cmpName(a.name, b.name); });
  }
  function sortItems(items) { return state.sort === "az" ? items.slice().sort(function (a, b) { return cmpName(a.name, b.name); }) : rank(items); }
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-"); }

  /* ---------- Static fills ---------- */
  function fillStatic(root) {
    root.querySelectorAll("[data-icon]").forEach(function (el) {
      setMarkup(el, icon(el.getAttribute("data-icon"), el.getAttribute("data-icls") || ""));
      el.removeAttribute("data-icon");
    });
    root.querySelectorAll("[data-logo]").forEach(function (el) { setMarkup(el, markSvg(el.getAttribute("data-logo"))); });
    root.querySelectorAll("[data-stars]").forEach(function (el) {
      var v = parseFloat(el.getAttribute("data-stars")), lg = el.getAttribute("data-lg");
      setMarkup(el, stars(v, lg === "xl" ? "xl" : (lg ? "lg" : "")));
      el.removeAttribute("data-stars");
    });
  }
  fillStatic(document);
  document.getElementById("fBoth").textContent = INTS.filter(function (it) { return it.att === "both"; }).length;

  /* ---------- Hero hub ---------- */
  var heroMode = "orbit";
  var NOTES = {
    orbit: "Inner ring: the 8 with the most evidence. Outer ring: the other 50, by category.",
    cats: "Each partner counted once, under its main category.",
    ring: "The 8 with the most evidence, of 58. No vendor pays for a place."
  };
  function bez(t, a, q, b) { return (1 - t) * (1 - t) * a + 2 * (1 - t) * t * q + t * t * b; }
  function spoke(cx, cy, px, py, i, w, delay) {
    var mx = (cx + px) / 2, my = (cy + py) / 2;
    var nx = -(py - cy), ny = px - cx, len = Math.sqrt(nx * nx + ny * ny);
    var bend = (i % 2 ? 22 : -22);
    var qx = mx + nx / len * bend, qy = my + ny / len * bend;
    var d = "M" + cx + " " + cy + " Q" + qx.toFixed(1) + " " + qy.toFixed(1) + " " + px.toFixed(1) + " " + py.toFixed(1);
    return {
      qx: qx, qy: qy,
      rib: '<path d="' + d + '" fill="none" style="stroke:var(--hero-ribbon)" stroke-width="' + w + '" stroke-linecap="round"/>',
      dot: '<path class="ribbon-draw" d="' + d + '" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="0 9" style="stroke:var(--hero-accent);animation-delay:' + delay + 's"/>'
    };
  }
  function beadAt(x, y, inner, delay) {
    return '<g transform="translate(' + x.toFixed(1) + " " + y.toFixed(1) + ')"><g class="bead" style="animation-delay:' + delay + 's"><circle r="15" style="fill:var(--hero-bead)"/><circle r="15" fill="none" style="stroke:var(--hero-accent)" stroke-width="2" opacity=".6"/>' + inner + "</g></g>";
  }
  function glyphIn(name) { return '<g transform="translate(-7.5 -7.5) scale(.625)" fill="none" style="stroke:var(--hero-glyph)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + IC[name] + "</g>"; }
  function renderArt() {
    var cx = 280, cy = 262;
    var ribbons = "", dots = "", beads = "", tiles = "", outer = "";
    if (heroMode === "cats") {
      var groups = CATS.map(function (c) { return { c: c, n: INTS.filter(function (it) { return it.cats[0] === c; }).length }; });
      groups.forEach(function (g, i) {
        var a = (130 + i * (280 / 9)) * Math.PI / 180, px = cx + 214 * Math.cos(a), py = cy + 204 * Math.sin(a);
        var sp = spoke(cx, cy, px, py, i, (8 + g.n * 0.9).toFixed(1), i * .05);
        ribbons += sp.rib; dots += sp.dot;
        var t = .55, bx = bez(t, cx, sp.qx, px), by = bez(t, cy, sp.qy, py);
        beads += beadAt(bx, by, '<text y="4.6" text-anchor="middle" style="fill:var(--hero-glyph);font:700 13px var(--sans)">' + g.n + "</text>", .6 + i * .06);
        var s = 48;
        tiles += '<g class="pt" style="animation-delay:' + (.3 + i * .05) + 's"><rect x="' + (px - s / 2 - 5).toFixed(1) + '" y="' + (py - s / 2 - 5).toFixed(1) + '" width="' + (s + 10) + '" height="' + (s + 10) + '" rx="17" style="fill:var(--surface)" filter="url(#tsh)"/>' +
          '<g transform="translate(' + (px - 14).toFixed(1) + " " + (py - 14).toFixed(1) + ') scale(1.1667)" fill="none" style="stroke:var(--brand)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + IC[CAT_IC[g.c]] + "</g>" +
          '<text x="' + px.toFixed(1) + '" y="' + (py + s / 2 + 22).toFixed(1) + '" text-anchor="middle" style="paint-order:stroke;stroke:var(--hero-bg);stroke-width:4px;stroke-linejoin:round;fill:var(--hero-ink-2);font:600 12.5px var(--sans)">' + (CAT_SHORT[g.c] || g.c) + "</text></g>";
      });
    } else {
      var orbit = heroMode === "orbit";
      var RX = orbit ? 164 : 214, RY = orbit ? 158 : 206, s = orbit ? 46 : 50;
      var top = merit(INTS).slice(0, 8);
      top.forEach(function (it, i) {
        var a = (-67.5 + i * 45) * Math.PI / 180, px = cx + RX * Math.cos(a), py = cy + RY * Math.sin(a);
        var sp = spoke(cx, cy, px, py, i, orbit ? 14 : 16, i * .06);
        ribbons += sp.rib; dots += sp.dot;
        var t = orbit ? .5 : .56;
        beads += beadAt(bez(t, cx, sp.qx, px), bez(t, cy, sp.qy, py), glyphIn(it.objs[0]), .6 + i * .07);
        tiles += '<g class="pt" style="animation-delay:' + (.3 + i * .06) + 's"><rect x="' + (px - s / 2 - 5).toFixed(1) + '" y="' + (py - s / 2 - 5).toFixed(1) + '" width="' + (s + 10) + '" height="' + (s + 10) + '" rx="17" style="fill:var(--surface)" filter="url(#tsh)"/>' +
          markAt(it.logo, (px - s / 2).toFixed(1), (py - s / 2).toFixed(1), s) +
          '<text x="' + px.toFixed(1) + '" y="' + (py + s / 2 + 21).toFixed(1) + '" text-anchor="middle" style="paint-order:stroke;stroke:var(--hero-bg);stroke-width:4px;stroke-linejoin:round;fill:var(--hero-ink-2);font:600 12px var(--sans)">' + (it.short || it.name) + "</text></g>";
      });
      if (orbit) {
        var rest = INTS.filter(function (it) { return top.indexOf(it) === -1; });
        rest = merit(rest).sort(function (a, b) { return CATS.indexOf(a.cats[0]) - CATS.indexOf(b.cats[0]); });
        var groupsN = 0, prev = null;
        rest.forEach(function (it) { if (it.cats[0] !== prev) { groupsN++; prev = it.cats[0]; } });
        var R = 248, start = 90 + 24, span = 360 - 48, gap = 3, step = (span - gap * (groupsN - 1)) / (rest.length - 1), ang = start;
        prev = null;
        outer += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" style="stroke:var(--hero-ink)" stroke-opacity=".12" stroke-width="1.5" stroke-dasharray="2 6"/>';
        rest.forEach(function (it, i) {
          if (prev !== null && it.cats[0] !== prev) ang += gap;
          prev = it.cats[0];
          var a = ang * Math.PI / 180, x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
          outer += '<g class="pt" style="animation-delay:' + (.9 + i * .018).toFixed(3) + 's"><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="11" style="fill:var(--surface)" filter="url(#tsh2)"/>' + markAt(it.logo, (x - 8.5).toFixed(1), (y - 8.5).toFixed(1), 17) + "</g>";
          ang += step;
        });
      }
    }
    var center = markAt("procore", cx - 40, cy - 40, 80);
    var ringR = heroMode === "orbit" ? [164, 158] : [214, 206];
    setMarkup(document.getElementById("art"), '<svg viewBox="0 0 560 540"><defs><filter id="tsh" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="8" stdDeviation="8" flood-opacity=".28"/></filter><filter id="tsh2" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-opacity=".3"/></filter></defs>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="' + (heroMode === "orbit" ? 262 : 240) + '" style="fill:var(--hero-bg-2)" opacity=".3"/>' +
      (heroMode === "cats" ? "" : '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + ringR[0] + '" ry="' + ringR[1] + '" fill="none" style="stroke:var(--hero-ink)" stroke-opacity=".1" stroke-width="1.5" stroke-dasharray="3 7"/>') +
      '<circle cx="' + cx + '" cy="' + cy + '" r="118" style="fill:var(--hero-bg-2)" opacity=".55"/>' +
      outer + ribbons + dots +
      '<circle class="halo" cx="' + cx + '" cy="' + cy + '" r="66" fill="none" style="stroke:var(--hero-accent)" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="54" style="fill:var(--hero-bead)" filter="url(#tsh)"/>' + center +
      beads + tiles + "</svg>");
    document.getElementById("stageNote").textContent = NOTES[heroMode];
  }

  /* ---------- How teams use it ---------- */
  function renderUse() {
    setMarkup(document.getElementById("usefulness"), USE.map(function (row) {
      return '<div class="use-row"><div class="use-lab">' + icon(row.ic) + "<b>" + row.label + "</b></div>" +
        row.groups.map(function (g) {
          return '<article class="use-card"><h3><a href="#">' + g.name + "</a></h3><ul>" + g.pts.map(function (p) { return "<li>" + icon("check") + "<span>" + p + "</span></li>"; }).join("") + "</ul></article>";
        }).join("") + "</div>";
    }).join(""));
  }

  /* ---------- Integrations ---------- */
  var OBJ_ORDER = OBJECTS.slice().sort(function (a, b) {
    var na = INTS.filter(function (it) { return has(it.objs, a); }).length, nb = INTS.filter(function (it) { return has(it.objs, b); }).length;
    return (nb - na) || (OBJECTS.indexOf(a) - OBJECTS.indexOf(b));
  });
  var OBJ_VIS = 9, objsOpen = false;
  var PAGE = 12, flatLimit = PAGE, openGroups = {};
  function resetPaging() { flatLimit = PAGE; openGroups = {}; }
  function anyFilter() { return !!(state.q || state.dir !== "all" || state.objs.length || state.cats.length); }

  function renderFilters() {
    var dirs = [["all", "Any direction", null], ["out", "Procore sends", "oneway"], ["in", "Procore receives", "inway"], ["both", "Both ways", "twoway"]];
    setMarkup(document.getElementById("dirSeg"), dirs.map(function (d) {
      var n = facet({ dir: d[0] });
      return '<button type="button" data-dir="' + d[0] + '" aria-pressed="' + (state.dir === d[0]) + '">' + (d[2] ? icon(d[2]) : "") + d[1] + '<span class="n">' + n + "</span></button>";
    }).join(""));
    var vis = objsOpen ? OBJ_ORDER : OBJ_ORDER.filter(function (o, i) { return i < OBJ_VIS || has(state.objs, o); });
    var hidden = OBJ_ORDER.length - vis.length;
    setMarkup(document.getElementById("objRow"), '<span class="lead">Must move</span>' + vis.map(function (o) {
      var n = has(state.objs, o) ? facet({}) : facet({ objs: state.objs.concat([o]) });
      return '<button type="button" class="obj' + (n ? "" : " zero") + '" data-obj="' + o + '" aria-pressed="' + has(state.objs, o) + '"><span class="oi" style="display:inline-flex">' + icon(o) + '</span><span class="tick">' + icon("check") + "</span>" + o + '<span class="n">' + n + "</span></button>";
    }).join("") + (objsOpen || hidden ? '<button type="button" class="moreobj" id="objMore" aria-expanded="' + objsOpen + '">' + (objsOpen ? "Fewer data objects" : hidden + " more data objects") + icon("chev") + "</button>" : ""));
    setMarkup(document.getElementById("catRow"), '<span class="lead">Partner category</span>' + CATS.map(function (c) {
      var n = facet({ cats: [c] });
      return '<button type="button" class="cat' + (n ? "" : " zero") + '" data-cat="' + c + '" aria-pressed="' + has(state.cats, c) + '"><span class="on">' + icon("check", "s") + '</span><span class="off">' + icon("plus", "s") + "</span>" + c + '<span class="n">' + n + "</span></button>";
    }).join(""));
  }

  function card(it, i, hide, lead) {
    return '<a class="card' + (lead ? " lead" : "") + '" href="#" style="--i:' + i + '" data-name="' + it.name + '" aria-label="' + SELF.name + " and " + it.name + ' pair page"' + (hide ? " hidden" : "") + '>' +
      '<span class="top">' + mark(it.logo) + '<span><span class="nm">' + it.name + '</span><span class="vd">by ' + it.vendor + "</span></span></span>" +
      '<span class="minis">' + it.cats.map(function (c) { return '<span class="mini ct' + (has(state.cats, c) ? " hit" : "") + '">' + icon("tag") + c + "</span>"; }).join("") + "</span>" +
      '<span class="blk"><span class="lbl">What moves</span><span class="dir">' + icon(dirIcon(it)) + dirLabel(it) + '</span><span class="minis">' +
      it.objs.map(function (o) { return '<span class="mini ob' + (has(state.objs, o) ? " hit" : "") + '" title="' + o + '">' + icon(o) + '<span class="t">' + o + "</span></span>"; }).join("") + "</span></span>" +
      '<span class="blk"><span class="lbl">How it connects</span>' + mechHtml(it) + "</span>" +
      attHtml(it) +
      '<span class="go"><span>Procore and ' + (it.short || it.name) + '</span><span class="arr">' + icon("arrowR", "s") + "</span></span></a>";
  }
  function trow(it, i) {
    return '<tr style="--i:' + Math.min(i, 12) + '" data-name="' + it.name + '"><td><a class="tprod" href="#">' + mark(it.logo) + "<span><b>" + it.name + "</b><span>by " + it.vendor + "</span></span></a></td>" +
      '<td class="l"><span class="minis">' + it.cats.map(function (c) { return '<span class="mini ct' + (has(state.cats, c) ? " hit" : "") + '">' + c + "</span>"; }).join("") + "</span></td>" +
      '<td class="l"><span class="dir" style="margin:0">' + icon(dirIcon(it)) + dirLabel(it) + "</span></td>" +
      '<td class="l"><span class="minis">' + it.objs.map(function (o) { return '<span class="mini' + (has(state.objs, o) ? " hit" : "") + '">' + icon(o) + o + "</span>"; }).join("") + "</span></td>" +
      '<td class="l">' + mechHtml(it) + '</td><td class="l">' + attHtml(it, true) + "</td></tr>";
  }

  var EMPTY_ART = '<svg class="art" viewBox="0 0 110 90" aria-hidden="true"><rect x="8" y="14" width="56" height="62" rx="12" fill="var(--surface)" transform="rotate(-6 36 45)"/><rect x="40" y="10" width="58" height="66" rx="12" fill="var(--surface)" style="filter:drop-shadow(0 6px 10px var(--art-drop))"/><circle cx="69" cy="38" r="12" fill="none" stroke="var(--brand)" stroke-width="3"/><path d="m78 47 9 9" stroke="var(--brand)" stroke-width="3" stroke-linecap="round"/><path d="M52 64h30" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/></svg>';
  var REACH = '<div class="reach"><span class="ri">' + icon("route") + '</span><span><b>124 more pairs reachable via connectors</b><span>Products Procore could be joined to through a connector product. Not counted above.</span></span></div>' +
    '<p class="scope">Only partners listed on AEC Integrations appear here. If one is missing, <a href="#">suggest a correction</a>.</p>';

  function cols(grouped) {
    var w = window.innerWidth;
    if (w <= 760) return 1;
    if (w <= 1040) return 2;
    if (w <= 1260) return grouped ? 2 : 3;
    return 3;
  }
  function groupsOf(shown) {
    return CATS.map(function (c) { return { c: c, items: shown.filter(function (it) { return it.cats[0] === c; }) }; }).filter(function (g) { return g.items.length; });
  }
  function evCounts(list) {
    var r = { both: 0, one: 0, none: 0 };
    list.forEach(function (it) { if (it.att === "both") r.both++; else if (it.att === "none") r.none++; else r.one++; });
    return r;
  }

  function renderInts() {
    var all = INTS.filter(matches), shown = sortItems(all), total = INTS.length;
    var bits = [];
    if (state.objs.length) bits.push("that move " + state.objs.join(" and "));
    if (state.cats.length) bits.push("with " + state.cats.join(" or ") + " products");
    if (state.dir !== "all") bits.push(state.dir === "both" ? "that sync both ways" : (state.dir === "out" ? "where Procore sends" : "where Procore receives"));
    if (state.q) bits.push('matching "' + state.q + '"');
    document.getElementById("laneHeading").textContent = bits.length ? "Integrations " + bits.join(", ") : "All integrations on record";
    document.getElementById("resultCount").textContent = anyFilter() ? shown.length + " of " + total + " match" : total + " on record, no filters applied";
    setMarkup(document.getElementById("countBig"), shown.length + " <small>of " + total + "</small>");
    setMarkup(document.getElementById("clearWrap"), anyFilter() ? '<button class="linkbtn" type="button" data-clear="all">' + icon("x", "s") + "Clear filters</button>" : "");

    var list = document.getElementById("intList"), foot = document.getElementById("reachFoot");
    var expandAll = anyFilter() && shown.length <= PAGE;
    var groups = groupsOf(shown);

    // Rail and jump links (grouped only)
    var ev = evCounts(shown), mx = Math.max(shown.length, 1);
    setMarkup(document.getElementById("rail"), shown.length ? '<div class="rail-box"><h4>Jump to a category</h4><ul>' + groups.map(function (g) {
      return '<li><a href="#grp-' + slug(g.c) + '" data-jump="' + slug(g.c) + '"><span class="gi">' + icon(CAT_IC[g.c]) + "</span><span>" + g.c + '</span><span class="c">' + g.items.length + "</span></a></li>";
    }).join("") + "</ul></div>" +
      '<div class="rail-box"><h4>Evidence for these ' + shown.length + '</h4><ul class="evb" style="list-style:none;margin:0">' +
      '<li><span><span class="agree-dot confirmed" aria-hidden="true"></span>Confirmed by both companies</span><b>' + ev.both + '</b><span class="bar"><i style="width:' + (ev.both / mx * 100) + '%"></i></span></li>' +
      '<li class="half"><span><span class="agree-dot single" aria-hidden="true"></span>Confirmed by one company</span><b>' + ev.one + '</b><span class="bar"><i style="width:' + (ev.one / mx * 100) + '%"></i></span></li>' +
      '<li class="none"><span><span class="agree-dot" aria-hidden="true"></span>Listed by AEC Integrations</span><b>' + ev.none + '</b><span class="bar"><i style="width:' + (ev.none / mx * 100) + '%"></i></span></li></ul></div>' : "");
    setMarkup(document.getElementById("jump"), groups.map(function (g) {
      return '<a class="jchip" href="#grp-' + slug(g.c) + '">' + icon(CAT_IC[g.c]) + (CAT_SHORT[g.c] || g.c) + '<span class="n">' + g.items.length + "</span></a>";
    }).join(""));

    if (!shown.length) {
      setMarkup(list, '<div class="empty">' + EMPTY_ART + "<div><strong>No integration on record matches all of that.</strong><p>Remove a data object or widen the direction or category to see more.</p></div>" +
        '<button class="btn btn-primary" type="button" data-clear="all">Clear filters</button></div>');
      setMarkup(foot, REACH); foot.hidden = false;
      return;
    }

    if (state.view === "table") {
      var head = '<thead><tr><th scope="col">Partner</th><th scope="col" class="l">Categories</th><th scope="col" class="l">Direction</th><th scope="col" class="l">What moves</th><th scope="col" class="l">Connection</th><th scope="col" class="l">Confirmed by</th></tr></thead>';
      var bodyRows = state.group ? groups.map(function (g) {
        return '<tbody><tr class="gh"><th colspan="6" scope="colgroup" id="grp-' + slug(g.c) + '">' + icon(CAT_IC[g.c]) + g.c + "<span>" + g.items.length + "</span></th></tr>" + g.items.map(trow).join("") + "</tbody>";
      }).join("") : "<tbody>" + shown.map(trow).join("") + "</tbody>";
      setMarkup(list, '<p class="tnote">The table lists all ' + shown.length + ' at once, for side by side comparison.</p><div class="table-wrap"><table class="cmp"><caption class="sr">Procore Project Management integrations on record</caption>' + head + bodyRows + "</table></div>");
      setMarkup(foot, REACH); foot.hidden = false;
      return;
    }

    if (state.group) {
      var lim = cols(true) === 1 ? 1 : Math.max(cols(true), 2);
      setMarkup(list, groups.map(function (g) {
        var open = expandAll || openGroups[g.c] || g.items.length <= lim;
        var vis = open ? g.items : g.items.slice(0, lim), hid = g.items.slice(vis.length), nv = vis.length;
        var e = evCounts(g.items), s = slug(g.c);
        var more = hid.length
          ? '<div class="grp-more"><button type="button" class="peek" data-group="' + g.c + '" aria-expanded="false"><span class="stack" aria-hidden="true">' + hid.slice(0, 5).map(function (it) { return mark(it.logo); }).join("") + "</span>Show " + hid.length + " more in " + g.c + icon("chev") + "</button></div>"
          : (openGroups[g.c] && !expandAll ? '<div class="grp-more"><button type="button" class="linkbtn" data-group="' + g.c + '" aria-expanded="true">' + icon("chev") + "Show fewer</button></div>" : "");
        return '<section class="grp" id="grp-' + s + '" aria-labelledby="grph-' + s + '"><div class="grp-head"><span class="gi">' + icon(CAT_IC[g.c]) + '</span><h3 id="grph-' + s + '">' + g.c + '</h3><span class="gn">' + g.items.length + "</span>" +
          (e.both ? '<span class="gs">' + e.both + " confirmed by both companies</span>" : '<span class="gs">None confirmed by both companies yet</span>') + "</div>" +
          '<div class="cards all">' + g.items.map(function (it, i) { return card(it, i, i >= nv); }).join("") + "</div>" + more + "</section>";
      }).join(""));
      setMarkup(foot, REACH); foot.hidden = false;
      return;
    }

    // One list with progressive loading
    var c = cols(false);
    var n = expandAll ? shown.length : Math.min(flatLimit, shown.length);
    var vis = shown.slice(0, n), done = n >= shown.length, lead = c >= 3 && vis.length >= 3;
    var fill = "";
    if (done) { var rem = (vis.length + (lead ? 1 : 0)) % c, span = rem ? c - rem : c; fill = c > 1 ? '<div class="ifill' + (span >= 3 && span === c ? " row" : "") + '" style="--span:' + span + '">' + REACH + "</div>" : ""; }
    var bar = done ? "" : '<div class="loadbar"><span class="meter" aria-hidden="true"><span style="width:' + (n / shown.length * 100) + '%"></span></span><span class="st">Showing ' + n + " of " + shown.length + '</span><div class="row"><button class="btn btn-soft" type="button" data-more="page">Show ' + Math.min(PAGE, shown.length - n) + ' more</button><button class="linkbtn" type="button" data-more="all">Show all ' + shown.length + "</button></div></div>";
    setMarkup(list, '<div class="cards all" id="cards">' + shown.map(function (it, i) { return card(it, i, i >= n, lead && i === 0); }).join("") + fill + "</div>" + bar);
    foot.hidden = done && c > 1;
    setMarkup(foot, foot.hidden ? "" : REACH);
  }

  /* ---------- Extensions, reviews, related ---------- */
  function renderExt() {
    setMarkup(document.getElementById("ext"), EXT.map(function (x) {
      var r = x.q === null ? '<span class="mt">Not yet rated<span aria-hidden="true">·</span>' + x.reviews + " reviews</span>"
        : '<span class="mt">' + stars(x.q) + "<b>" + x.q.toFixed(1) + '</b><span aria-hidden="true">·</span>' + x.reviews + " reviews</span>";
      return '<a class="xt" href="#">' + mark(x.logo) + '<span><b>' + x.name + '</b><span class="vd">by ' + x.vendor + "</span>" + r + '<span class="inside">' + icon("puzzle") + "Runs inside Procore</span></span>" + '<span class="arr">' + icon("arrowR", "s") + "</span></a>";
    }).join(""));
  }
  var REC = { yes: ["thumbUp", "Would recommend", "rec-yes"], maybe: ["meh", "Might recommend", ""], no: ["thumbDown", "Would not recommend", "rec-no"] };
  function review(r, i) {
    var rec = REC[r.rec];
    return '<article class="rv" style="animation-delay:' + (i * 40) + 'ms">' +
      '<div class="rv-scores"><div class="rs"><span>Product quality</span><div class="row">' + stars(r.q) + "<b>" + r.q + '</b></div></div><div class="rs o"><span>Onboarding</span><div class="row">' + stars(r.o) + "<b>" + r.o + "</b></div></div></div>" +
      "<h4>" + r.t + '<span class="when">' + r.d + "</span></h4>" +
      '<p class="body">' + r.b + "</p>" +
      '<div class="who"><span class="mini">' + icon("users") + r.role + '</span><span class="mini">' + icon("clock") + "Using it " + r.yrs + " year" + (r.yrs === 1 ? "" : "s") + '</span><span class="mini ' + rec[2] + '">' + icon(rec[0]) + rec[1] + "</span></div>" +
      (r.upd ? '<div class="upd"><div class="rh">' + icon("refresh") + "Reviewer update<time>" + r.upd.d + "</time></div><p>" + r.upd.b + '</p><div class="nr"><span>New product quality <b>' + r.upd.q + "</b></span><span>New onboarding <b>" + r.upd.o + "</b></span></div></div>" : "") +
      (r.reply ? '<div class="reply"><div class="rh">' + mark("procore") + "Response from Procore<time>" + r.reply.d + "</time></div><p>" + r.reply.b + "</p></div>" : "") +
      "</article>";
  }
  var rvCount = REVIEWS.length;
  function renderReviews() {
    var list = REVIEWS.concat(MORE).slice(0, rvCount);
    setMarkup(document.getElementById("rvList"), list.map(review).join(""));
    document.getElementById("rvShown").textContent = "Showing " + list.length + " of 1,284";
  }
  function renderRel() {
    setMarkup(document.getElementById("rel"), REL.map(function (p, i) {
      return '<a class="card" href="#" style="--i:' + i + '">' + '<span class="top">' + mark(p.logo) + '<span><span class="nm">' + p.name + '</span><span class="vd">by ' + p.vendor + "</span></span></span>" +
        '<span class="rates"><span class="rate"><span>Product quality</span>' + stars(p.q) + "<b>" + p.q.toFixed(1) + "</b></span>" +
        '<span class="rate"><span>Onboarding</span>' + stars(p.o) + "<b>" + p.o.toFixed(1) + "</b></span>" +
        '<span class="rv2">' + icon("users", "s") + "<b>" + p.reviews.toLocaleString("en-US") + "</b> reviews<span aria-hidden=\"true\">·</span><b>" + p.ints + "</b> integrations</span></span>" +
        '<span class="go"><span>View product</span><span class="arr">' + icon("arrowR", "s") + "</span></span></a>";
    }).join(""));
  }

  /* ---------- Events ---------- */
  function refresh() { renderFilters(); renderInts(); }
  document.addEventListener("click", function (e) {
    var t;
    if ((t = e.target.closest("button[data-obj]"))) {
      var o = t.getAttribute("data-obj"), i = state.objs.indexOf(o);
      if (i === -1) state.objs.push(o); else state.objs.splice(i, 1);
      state.objs.sort(function (x, y) { return OBJECTS.indexOf(x) - OBJECTS.indexOf(y); });
      resetPaging(); refresh();
      document.querySelector('#objRow [data-obj="' + o + '"]').focus();
    } else if ((t = e.target.closest("button[data-cat]"))) {
      var c = t.getAttribute("data-cat"), j = state.cats.indexOf(c);
      if (j === -1) state.cats.push(c); else state.cats.splice(j, 1);
      state.cats.sort(function (x, y) { return CATS.indexOf(x) - CATS.indexOf(y); });
      resetPaging(); refresh();
      document.querySelector('#catRow [data-cat="' + c + '"]').focus();
    } else if ((t = e.target.closest("button[data-dir]"))) {
      state.dir = t.getAttribute("data-dir");
      resetPaging(); refresh();
      document.querySelector('#dirSeg [data-dir="' + state.dir + '"]').focus();
    } else if ((t = e.target.closest("#objMore"))) {
      objsOpen = !objsOpen; renderFilters();
      document.getElementById("objMore").focus();
    } else if ((t = e.target.closest("button[data-clear]"))) {
      state.q = ""; state.dir = "all"; state.objs = []; state.cats = [];
      document.getElementById("q").value = "";
      resetPaging(); refresh();
      document.getElementById("q").focus();
    } else if ((t = e.target.closest("button[data-group]"))) {
      var g = t.getAttribute("data-group"), wasOpen = !!openGroups[g];
      openGroups[g] = !wasOpen;
      renderInts();
      var sec = document.getElementById("grp-" + slug(g));
      if (!wasOpen) { var cs = sec.querySelectorAll(".card"), k = cols(true) === 1 ? 1 : Math.max(cols(true), 2); if (cs[k]) cs[k].focus(); }
      else { var b = sec.querySelector(".grp-more button"); if (b) b.focus(); sec.scrollIntoView({ block: "start" }); }
    } else if ((t = e.target.closest("button[data-more]"))) {
      var before = Math.min(flatLimit, INTS.filter(matches).length);
      flatLimit = t.getAttribute("data-more") === "all" ? INTS.length : flatLimit + PAGE;
      renderInts();
      var cards = document.querySelectorAll("#cards .card");
      if (cards[before]) cards[before].focus();
    } else if ((t = e.target.closest("a[href='#']"))) {
      e.preventDefault();
    }
  });
  var lastCols = cols(state.group);
  window.addEventListener("resize", function () { var c = cols(state.group); if (c !== lastCols) { lastCols = c; renderInts(); } });
  document.getElementById("q").addEventListener("input", function (e) { state.q = e.target.value.trim(); resetPaging(); refresh(); });
  /* Sort: a listbox select (24), keyboard per the listbox pattern */
  (function sortSelect() {
    var btn = document.getElementById("sortSel"), list = document.getElementById("sortList"), opts = Array.prototype.slice.call(list.querySelectorAll("[role=option]")), act = 0;
    function mark(i) { act = i; opts.forEach(function (o, j) { o.classList.toggle("active", j === i); }); list.setAttribute("aria-activedescendant", opts[i].id); }
    function open() { list.hidden = false; btn.setAttribute("aria-expanded", "true"); mark(Math.max(0, opts.findIndex(function (o) { return o.getAttribute("aria-selected") === "true"; }))); list.focus(); }
    function close(back) { list.hidden = true; btn.setAttribute("aria-expanded", "false"); if (back) btn.focus(); }
    function choose(i) {
      opts.forEach(function (o, j) { o.setAttribute("aria-selected", String(j === i)); });
      btn.value = opts[i].getAttribute("data-value"); btn.textContent = opts[i].textContent;
      state.sort = btn.value; close(true); renderInts();
    }
    btn.addEventListener("click", function () { if (list.hidden) open(); else close(true); });
    btn.addEventListener("keydown", function (e) { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); } });
    list.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); mark(Math.min(opts.length - 1, act + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); mark(Math.max(0, act - 1)); }
      else if (e.key === "Home") { e.preventDefault(); mark(0); }
      else if (e.key === "End") { e.preventDefault(); mark(opts.length - 1); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(act); }
      else if (e.key === "Escape" || e.key === "Tab") { close(e.key === "Escape"); }
    });
    opts.forEach(function (o, i) { o.addEventListener("click", function () { choose(i); }); });
    list.addEventListener("focusout", function (e) { if (!list.contains(e.relatedTarget) && e.relatedTarget !== btn) close(false); });
    window.__SORT = { pick: function (v) { var i = opts.findIndex(function (o) { return o.getAttribute("data-value") === v; }); if (i >= 0) choose(i); } };
  })();

  function setView(v) {
    state.view = v;
    document.body.classList.toggle("view-cards", v === "cards");
    document.body.classList.toggle("view-table", v === "table");
    document.getElementById("viewCards").setAttribute("aria-pressed", v === "cards");
    document.getElementById("viewTable").setAttribute("aria-pressed", v === "table");
    renderInts();
  }
  function setGroup(on) {
    state.group = on; resetPaging();
    document.body.classList.toggle("flat", !on);
    document.getElementById("grpOn").setAttribute("aria-pressed", on);
    document.getElementById("grpOff").setAttribute("aria-pressed", !on);
    var r = document.querySelector('input[name="grp"][value="' + (on ? "on" : "off") + '"]'); if (r) r.checked = true;
    lastCols = cols(on);
    renderInts();
  }
  document.getElementById("viewCards").onclick = function () { setView("cards"); };
  document.getElementById("viewTable").onclick = function () { setView("table"); };
  document.getElementById("grpOn").onclick = function () { setGroup(true); };
  document.getElementById("grpOff").onclick = function () { setGroup(false); };

  var moreBtn = document.getElementById("moreBtn");
  moreBtn.addEventListener("click", function () {
    var before = rvCount;
    rvCount = Math.min(rvCount + 3, REVIEWS.length + MORE.length);
    renderReviews();
    var items = document.querySelectorAll("#rvList .rv");
    if (items[before]) { items[before].setAttribute("tabindex", "-1"); items[before].focus({ preventScroll: false }); }
    if (rvCount >= REVIEWS.length + MORE.length) moreBtn.hidden = true;
  });

  document.getElementById("mailForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = document.getElementById("mailEmail"), m = document.getElementById("mailMsg");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.value.trim())) {
      f.setAttribute("aria-invalid", "true"); m.className = "msg err"; setMarkup(m, icon("alert", "s") + "<span>Enter an email address, like you@company.com.</span>");
      return;
    }
    f.removeAttribute("aria-invalid"); m.className = "msg ok";
    setMarkup(m, icon("check", "s") + "Subscribed. Look for the first email next month.");
  });

  /* Sticky nav: stuck state, current section, current group in the rail */
  var secnav = document.getElementById("secnav");
  new IntersectionObserver(function (en) { secnav.classList.toggle("stuck", !en[0].isIntersecting && en[0].boundingClientRect.top < 0); }).observe(document.getElementById("navSentinel"));
  var links = Array.prototype.slice.call(document.querySelectorAll("#snl a"));
  function spy() {
    var y = 120, cur = null;
    links.forEach(function (a) { var s = document.querySelector(a.getAttribute("href")); if (s && s.getBoundingClientRect().top <= y) cur = a; });
    links.forEach(function (a) { if (a === cur) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
    if (cur && secnav.classList.contains("stuck")) { var box = document.getElementById("snl"); var l = cur.offsetLeft - 16; if (l < box.scrollLeft || l + cur.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = l; }
    var rl = Array.prototype.slice.call(document.querySelectorAll("#rail a[data-jump]")), rc = null;
    rl.forEach(function (a) { var s = document.getElementById("grp-" + a.getAttribute("data-jump")); if (s && s.getBoundingClientRect().top <= 160) rc = a; });
    if (!rc && rl.length) rc = rl[0];
    rl.forEach(function (a) { if (a === rc) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
  }
  window.addEventListener("scroll", spy, { passive: true });

  /* Options */
  var mock = document.getElementById("mock");
  document.getElementById("mockToggle").onclick = function () { var o = mock.classList.toggle("open"); this.setAttribute("aria-expanded", o); };
  document.querySelectorAll('input[name="pal"]').forEach(function (r) { r.addEventListener("change", function () { document.documentElement.setAttribute("data-palette", r.value); }); });
  document.querySelectorAll('input[name="hero"]').forEach(function (r) { r.addEventListener("change", function () { heroMode = r.value; renderArt(); }); });
  document.querySelectorAll('input[name="grp"]').forEach(function (r) { r.addEventListener("change", function () { setGroup(r.value === "on"); }); });
  document.getElementById("optCompact").addEventListener("change", function (e) { document.body.classList.toggle("compact", e.target.checked); });

  renderArt(); renderUse(); refresh(); renderExt(); renderReviews(); renderRel(); spy();
  window.__MK = { INTS: INTS, state: state, OBJECTS: OBJECTS, CATS: CATS, setHero: function (m) { heroMode = m; renderArt(); }, setGroup: setGroup };
})();
</script>
</body>
</html>
