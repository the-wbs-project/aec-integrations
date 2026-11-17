  /* ---------- Data ---------- */
  var USE = [
    { label: "By audience", ic: "users", groups: [
      { name: "Specialty contractors", pts: ["Bill monthly progress against the schedule of values", "Track retainage held on every job until release", "See job profit before the job is closed"] },
      { name: "Subcontractors", pts: ["Collect conditional and final lien waivers with each payment", "Answer the GC's pay application format without retyping", "Send cost reports to the bonding agent each quarter"] } ] },
    { label: "By phase", ic: "phase", groups: [
      { name: "Construction", pts: ["Post labour and material cost to cost codes as it happens", "Compare earned revenue with billed to catch over billing", "Log change orders against the original contract"] },
      { name: "Closeout", pts: ["Bill final retainage once the punch list is signed", "Keep every waiver and pay application with the job record"] } ] }
  ];

  var BARS = [["Project management", "Submittals", 38], ["Payroll", "Timesheets", 29], ["Estimating", "calc", 21], ["Field and time tracking", "trade", 17], ["Document management", "Drawings", 12]];
  var PEERS = 46;

  var REL = [
    { name: "Sage Intacct Construction", vendor: "Sage", logo: "intacct", q: 4.3, o: 3.8, reviews: 64, ints: 27 },
    { name: "Viewpoint Vista", vendor: "Trimble", logo: "vista", q: 3.9, o: 3.4, reviews: 96, ints: 24 },
    { name: "Foundation Software", vendor: "Foundation Software", logo: "foundation", q: 4.2, o: 4.0, reviews: 41, ints: 18 },
    { name: "Jonas Premier", vendor: "Jonas", logo: "jonas", q: 4.1, o: 3.9, reviews: 18, ints: 11 }
  ];
  // Sample unclaimed listings among the similar products.
  unclaim(["Viewpoint Vista", "Jonas Premier"], [REL]);

  var REVIEWS = [
    { t: "Finally billing the way GCs ask for it", q: 4, o: 5, role: "Office manager, electrical contractor", yrs: 2, rec: "yes", d: "29 Oct 2026",
      b: "Pay applications come out in the format our general contractors want, with the waivers attached. Setup was one call and a spreadsheet import." },
    { t: "Simple, and the support is quick", q: 4, o: 5, role: "Controller, mechanical contractor", yrs: 1, rec: "yes", d: "12 Oct 2026",
      b: "We moved off a desktop accounting package in a week. When we had a question about retainage, someone answered the same afternoon." },
    { t: "Good for billing, thin on reporting", q: 3, o: 4, role: "Owner, drywall contractor", yrs: 3, rec: "maybe", d: "25 Sep 2026",
      b: "Billing and waivers are solid. Reports are fixed, so anything custom still goes through a spreadsheet export." },
    { t: "Over and under billing at a glance", q: 5, o: 5, role: "Project accountant, plumbing contractor", yrs: 2, rec: "yes", d: "8 Sep 2026",
      b: "The work in progress report is the one our bonding agent asks for. It is right without us touching it." },
    { t: "We still key time in twice", q: 4, o: 4, role: "Payroll lead, electrical contractor", yrs: 1, rec: "maybe", d: "19 Aug 2026",
      b: "Job costing is accurate once the hours are in. Getting field hours in still means typing them from our time app." },
    { t: "Right size for a small shop", q: 4, o: 5, role: "Owner, specialty contractor", yrs: 4, rec: "yes", d: "2 Aug 2026",
      b: "We are twelve people. It does what we need without the price or the training of the big construction ERPs." }
  ];
  var MORE = [
    { t: "Lien waivers alone were worth it", q: 5, o: 4, role: "Office manager, mechanical contractor", yrs: 2, rec: "yes", d: "21 Jul 2026", b: "We used to chase waivers by email. Now they sit with each payment and we can see what is missing." }
  ];

  /* ---------- Static fills ---------- */
  function fillStatic(root) {
    root.querySelectorAll("[data-icon]").forEach(function (el) { setMarkup(el, icon(el.getAttribute("data-icon"))); el.removeAttribute("data-icon"); });
    root.querySelectorAll("[data-logo]").forEach(function (el) { setMarkup(el, markSvg(el.getAttribute("data-logo"))); });
    root.querySelectorAll("[data-stars]").forEach(function (el) {
      var v = parseFloat(el.getAttribute("data-stars")), lg = el.getAttribute("data-lg");
      setMarkup(el, stars(v, lg === "xl" ? "xl" : (lg ? "lg" : "")));
      el.removeAttribute("data-stars");
    });
  }
  fillStatic(document);

  /* ---------- Hero: the medallion with open slots ---------- */
  var heroMode = "plain";
  var NOTES = {
    plain: "Open slots: no partner products on record yet.",
    hints: "Slots show where other construction accounting products connect. None on record for SiteLedger."
  };
  var HALO = "paint-order:stroke;stroke:var(--hero-bg);stroke-width:4px;stroke-linejoin:round;";
  function renderArt() {
    var cx = 280, cy = 258, RX = 210, RY = 180, s = 60;
    var lines = "", slots = "";
    var angles = [-60, 0, 60, 120, 180, 240];
    angles.forEach(function (deg, i) {
      var a = deg * Math.PI / 180, px = cx + RX * Math.cos(a), py = cy + RY * Math.sin(a);
      var ux = Math.cos(a), uy = Math.sin(a) * RY / RX;
      var x1 = cx + 72 * Math.cos(a), y1 = cy + 72 * Math.sin(a), x2 = px - ux * 40, y2 = py - uy * 40;
      var flag = i === 0;
      lines += '<path ' + (flag ? 'class="ribbon-draw" ' : "") + 'd="M' + x1.toFixed(1) + " " + y1.toFixed(1) + " L" + x2.toFixed(1) + " " + y2.toFixed(1) + '" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="0 9" style="stroke:var(--' + (flag ? "hero-accent" : "hero-ink") + ')" ' + (flag ? "" : 'stroke-opacity=".26"') + "/>";
      var hint = BARS[i - 1];
      var glyph = flag ? IC.flag : (heroMode === "hints" ? IC[hint[1]] : "");
      var label = flag ? "Know of one?" : (heroMode === "hints" ? hint[0].replace(" and time tracking", "").replace("Document management", "Documents") : "");
      slots += '<g class="pt" style="animation-delay:' + (.35 + i * .08) + 's">' +
        '<rect x="' + (px - s / 2).toFixed(1) + '" y="' + (py - s / 2).toFixed(1) + '" width="' + s + '" height="' + s + '" rx="18" style="fill:var(--' + (flag ? "hero-accent" : "hero-bg-2") + ')" fill-opacity="' + (flag ? ".14" : ".45") + '"/>' +
        '<rect x="' + (px - s / 2).toFixed(1) + '" y="' + (py - s / 2).toFixed(1) + '" width="' + s + '" height="' + s + '" rx="18" fill="none" stroke-width="1.8" stroke-dasharray="6 6" style="stroke:var(--' + (flag ? "hero-accent" : "hero-ink") + ')" ' + (flag ? "" : 'stroke-opacity=".34"') + "/>" +
        (glyph ? '<g transform="translate(' + (px - 12).toFixed(1) + " " + (py - 12).toFixed(1) + ')" fill="none" style="stroke:var(--' + (flag ? "hero-accent" : "hero-ink-2") + ')" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"' + (flag ? "" : ' opacity=".85"') + ">" + glyph + "</g>" : "") +
        (label ? '<text x="' + px.toFixed(1) + '" y="' + (flag ? py - s / 2 - 12 : py + s / 2 + 21).toFixed(1) + '" text-anchor="middle" style="' + HALO + "fill:var(--" + (flag ? "hero-accent" : "hero-ink-2") + ');font:' + (flag ? 700 : 600) + ' 12.5px var(--sans)">' + label + "</text>" : "") + "</g>";
    });
    setMarkup(document.getElementById("art"), '<svg viewBox="0 0 560 540"><defs><filter id="tsh" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="8" stdDeviation="8" flood-opacity=".28"/></filter></defs>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="240" style="fill:var(--hero-bg-2)" opacity=".3"/>' +
      '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + RX + '" ry="' + RY + '" fill="none" style="stroke:var(--hero-ink)" stroke-opacity=".12" stroke-width="1.5" stroke-dasharray="3 7"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="118" style="fill:var(--hero-bg-2)" opacity=".55"/>' +
      lines +
      '<circle class="halo" cx="' + cx + '" cy="' + cy + '" r="66" fill="none" style="stroke:var(--hero-accent)" stroke-width="2" stroke-dasharray="2 7" stroke-linecap="round"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="54" style="fill:var(--hero-bead)" filter="url(#tsh)"/>' +
      '<text x="' + cx + '" y="' + (cy + 11) + '" text-anchor="middle" style="fill:var(--hero-glyph);font:600 32px var(--serif)">SL</text>' +
      '<g transform="translate(' + (cx + 40) + " " + (cy + 38) + ')"><g class="bead" style="animation-delay:.9s"><circle r="17" style="fill:var(--hero-accent)"/><circle r="17" fill="none" style="stroke:var(--hero-bead)" stroke-width="3"/>' +
      '<g transform="translate(-9 -9) scale(.75)" fill="none" style="stroke:var(--hero-accent-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + IC.unlink + "</g></g></g>" +
      slots + "</svg>");
    document.getElementById("stageNote").textContent = NOTES[heroMode];
  }

  function renderKnowArt() {
    var y = 59;
    setMarkup(document.getElementById("knowArt"), '<svg viewBox="0 0 420 118" style="display:block;width:100%;height:100%">' +
      '<path d="M86 ' + y + ' L300 ' + y + '" stroke-width="3" stroke-linecap="round" stroke-dasharray="0 9" style="stroke:var(--hero-accent)"/>' +
      '<path d="M84 46 L214 20 M84 72 L214 98" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="0 8" style="stroke:var(--hero-ink)" stroke-opacity=".25"/>' +
      '<rect x="214" y="4" width="32" height="32" rx="10" fill="none" stroke-dasharray="5 5" stroke-width="1.6" style="stroke:var(--hero-ink)" stroke-opacity=".34"/>' +
      '<rect x="214" y="82" width="32" height="32" rx="10" fill="none" stroke-dasharray="5 5" stroke-width="1.6" style="stroke:var(--hero-ink)" stroke-opacity=".34"/>' +
      '<rect x="302" y="29" width="60" height="60" rx="18" style="fill:var(--hero-accent)" fill-opacity=".14"/><rect x="302" y="29" width="60" height="60" rx="18" fill="none" stroke-dasharray="6 6" stroke-width="1.8" style="stroke:var(--hero-accent)"/>' +
      '<g transform="translate(320 47)" fill="none" style="stroke:var(--hero-accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + IC.flag + "</g>" +
      '<circle cx="50" cy="' + y + '" r="40" style="fill:var(--hero-bead)"/>' + markAt("siteledger", 26, y - 24, 48) + "</svg>");
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

  /* ---------- Integrations: none on record ---------- */
  function renderBars() {
    setMarkup(document.getElementById("bars"), BARS.map(function (b) {
      return '<li><span class="gi">' + icon(b[1]) + "</span><span>" + b[0] + "</span><b>" + b[2] + " <small>of " + PEERS + '</small></b><span class="bar" aria-hidden="true"><i style="width:' + (b[2] / PEERS * 100).toFixed(1) + '%"></i></span></li>';
    }).join(""));
  }
  function renderRel() {
    setMarkup(document.getElementById("rel"), REL.map(function (p, i) {
      return '<a class="card" href="#" style="--i:' + i + '">' + '<span class="top">' + mark(p.logo) + '<span><span class="nm">' + p.name + '</span><span class="vd">by ' + p.vendor + "</span></span></span>" +
        '<span class="icount"><b class="num">' + p.ints + "</b><span>integrations on record</span></span>" +
        '<span class="rates"><span class="rate"><span>Product quality</span>' + stars(p.q) + "<b>" + p.q.toFixed(1) + "</b></span>" +
        '<span class="rate"><span>Onboarding</span>' + stars(p.o) + "<b>" + p.o.toFixed(1) + "</b></span>" +
        '<span class="rv2">' + icon("users", "s") + "<b>" + p.reviews + "</b> reviews</span></span>" +
        '<span class="go"><span>View product</span><span class="arr">' + icon("arrowR", "s") + "</span></span></a>";
    }).join(""));
  }

  /* ---------- Reviews ---------- */
  var REC = { yes: ["thumbUp", "Would recommend", "rec-yes"], maybe: ["meh", "Might recommend", ""], no: ["thumbDown", "Would not recommend", "rec-no"] };
  function review(r, i) {
    var rec = REC[r.rec];
    return '<article class="rv" style="animation-delay:' + (i * 40) + 'ms">' +
      '<div class="rv-scores"><div class="rs"><span>Product quality</span><div class="row">' + stars(r.q) + "<b>" + r.q + '</b></div></div><div class="rs o"><span>Onboarding</span><div class="row">' + stars(r.o) + "<b>" + r.o + "</b></div></div></div>" +
      "<h4>" + r.t + '<span class="when">' + r.d + "</span></h4>" +
      '<p class="body">' + r.b + "</p>" +
      '<div class="who"><span class="mini">' + icon("users") + r.role + '</span><span class="mini">' + icon("clock") + "Using it " + r.yrs + " year" + (r.yrs === 1 ? "" : "s") + '</span><span class="mini ' + rec[2] + '">' + icon(rec[0]) + rec[1] + "</span></div>" +
      "</article>";
  }
  var rvCount = REVIEWS.length;
  function renderReviews() {
    var list = REVIEWS.concat(MORE).slice(0, rvCount);
    setMarkup(document.getElementById("rvList"), list.map(review).join(""));
    document.getElementById("rvShown").textContent = "Showing " + list.length + " of 7";
  }

  /* ---------- Events ---------- */
  document.addEventListener("click", function (e) {
    var t = e.target.closest("a[href='#']");
    if (t) e.preventDefault();
  });
  var moreBtn = document.getElementById("moreBtn");
  moreBtn.addEventListener("click", function () {
    var before = rvCount;
    rvCount = REVIEWS.length + MORE.length;
    renderReviews();
    var items = document.querySelectorAll("#rvList .rv");
    if (items[before]) { items[before].setAttribute("tabindex", "-1"); items[before].focus(); }
    moreBtn.hidden = true;
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

  var secnav = document.getElementById("secnav");
  new IntersectionObserver(function (en) { secnav.classList.toggle("stuck", !en[0].isIntersecting && en[0].boundingClientRect.top < 0); }).observe(document.getElementById("navSentinel"));
  var links = Array.prototype.slice.call(document.querySelectorAll("#snl a"));
  function spy() {
    var y = 120, cur = null;
    links.forEach(function (a) { var s = document.querySelector(a.getAttribute("href")); if (s && s.getBoundingClientRect().top <= y) cur = a; });
    links.forEach(function (a) { if (a === cur) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current"); });
  }
  window.addEventListener("scroll", spy, { passive: true });

  var mock = document.getElementById("mock");
  document.getElementById("mockToggle").onclick = function () { var o = mock.classList.toggle("open"); this.setAttribute("aria-expanded", o); };
  document.querySelectorAll('input[name="pal"]').forEach(function (r) { r.addEventListener("change", function () { document.documentElement.setAttribute("data-palette", r.value); }); });
  document.querySelectorAll('input[name="hero"]').forEach(function (r) { r.addEventListener("change", function () { heroMode = r.value; renderArt(); }); });

  renderArt(); renderKnowArt(); renderUse(); renderBars(); renderRel(); renderReviews(); spy();
  window.__MK = { setHero: function (m) { heroMode = m; renderArt(); } };
})();
</script>
</body>
</html>
