  /* ---------- Browse mega-menu (header) ---------- */
  (function catMenu() {
    var trig = document.getElementById("cmTrigger"), panel = document.getElementById("catmenu"), scrim = document.getElementById("cmScrim");
    var mb = document.getElementById("mmBtn"), mm = document.getElementById("mmenu");
    if (!trig || !panel) return;
    var head = trig.closest(".site-head"), pinned = false, pressing = false, openT = 0, closeT = 0;
    function isOpen() { return trig.getAttribute("aria-expanded") === "true"; }
    function set(o) {
      clearTimeout(openT); clearTimeout(closeT);
      if (pinned && !o) return;
      trig.setAttribute("aria-expanded", String(o));
      panel.inert = !o;
      document.body.classList.toggle("cm-open", o);
    }
    function closeSoon() { clearTimeout(openT); clearTimeout(closeT); if (isOpen()) closeT = setTimeout(function () { set(false); }, 260); }
    function keep() { clearTimeout(closeT); }
    function inMenu(el) { return !!el && (el === trig || panel.contains(el)); }

    trig.addEventListener("mouseenter", function () { keep(); if (!isOpen()) openT = setTimeout(function () { set(true); }, 70); });
    trig.addEventListener("mouseleave", closeSoon);
    panel.addEventListener("mouseenter", keep);
    panel.addEventListener("mouseleave", closeSoon);
    trig.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); set(true); var first = panel.querySelector("a"); if (first) first.focus(); }
    });
    head.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (isOpen() && !pinned) { e.preventDefault(); var back = inMenu(document.activeElement); set(false); if (back) trig.focus(); }
      if (mm && !mm.hidden && !pinned) { setMM(false); mb.focus(); }
    });
    // A press inside the panel moves focus (or, in Safari, drops it to body) before the click lands.
    panel.addEventListener("pointerdown", function () { pressing = true; });
    document.addEventListener("pointerup", function () { setTimeout(function () { pressing = false; }, 0); });
    head.addEventListener("focusout", function (e) {
      if (!inMenu(e.target)) return;
      setTimeout(function () { if (!pressing && isOpen() && !inMenu(document.activeElement)) set(false); }, 0);
    });
    if (scrim) scrim.addEventListener("click", function () { set(false); setMM(false); });

    /* Mobile menu: one tap-to-expand section per facet */
    var dis = mm ? Array.prototype.slice.call(mm.querySelectorAll(".mm-dis")) : [];
    function setMM(o) {
      if (!mm || (pinned && !o)) return;
      mm.hidden = !o; mb.setAttribute("aria-expanded", String(o));
      document.body.classList.toggle("mm-open", o);
    }
    function setSec(b, o) { b.setAttribute("aria-expanded", String(o)); document.getElementById(b.getAttribute("aria-controls")).hidden = !o; }
    if (mb && mm) mb.addEventListener("click", function () { setMM(mm.hidden); });
    // Floor (30): while the mobile menu is open, Tab and Shift+Tab cycle through the toggle and the menu only.
    head.addEventListener("keydown", function (e) {
      if (e.key !== "Tab" || !mm || mm.hidden || getComputedStyle(mm).display === "none") return;
      var f = [mb].concat(Array.prototype.slice.call(mm.querySelectorAll("a[href], button:not([disabled])")).filter(function (el) { return el.offsetParent !== null; }));
      var i = f.indexOf(document.activeElement);
      if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === f.length - 1 || i === -1)) { e.preventDefault(); f[0].focus(); }
    });
    dis.forEach(function (b) { b.addEventListener("click", function () { setSec(b, b.getAttribute("aria-expanded") !== "true"); }); });

    /* Options: key categories (K) and items per column (N). Key categories past K are hidden. In each facet list,
       a category already shown as a key category is skipped, then terms past N are hidden; "See all" always stays last. */
    var K = 4, N = 7;
    function apply() {
      document.querySelectorAll(".cm-keys li[data-k], .mm-keys li[data-k]").forEach(function (li) { li.hidden = Number(li.getAttribute("data-k")) > K; });
      document.querySelectorAll(".cm-list, .mm-sec ul").forEach(function (ul) {
        var c = 0;
        ul.querySelectorAll("li[data-r]").forEach(function (li) {
          var k = Number(li.getAttribute("data-key") || 0);
          if (k && k <= K) { li.hidden = true; return; }
          li.hidden = ++c > N;
        });
      });
    }
    document.querySelectorAll('input[name="cmN"]').forEach(function (r) { r.addEventListener("change", function () { if (r.checked) { N = Number(r.value); apply(); } }); });
    document.querySelectorAll('input[name="cmK"]').forEach(function (r) { r.addEventListener("change", function () { if (r.checked) { K = Number(r.value); apply(); } }); });
    document.querySelectorAll('input[name="cmCard"]').forEach(function (r) { r.addEventListener("change", function () { if (r.checked) document.body.classList.toggle("cm-withcard", r.value === "on"); }); });

    /* Options: pin the menu open for review */
    var opt = document.getElementById("optCatMenu");
    if (opt) opt.addEventListener("change", function () {
      pinned = false;
      if (opt.checked) { set(true); setMM(true); if (dis[0]) setSec(dis[0], true); pinned = true; } else { set(false); setMM(false); dis.forEach(function (b) { setSec(b, false); }); }
    });
    function pick(name, value) { var r = document.querySelector('input[name="' + name + '"][value="' + value + '"]'); if (r) { r.checked = true; r.dispatchEvent(new Event("change")); } }
    window.__CM = {
      open: function () { if (!opt) return; opt.checked = true; opt.dispatchEvent(new Event("change")); },
      setN: function (n) { pick("cmN", String(n)); },
      setK: function (k) { pick("cmK", String(k)); },
      card: function (on) { pick("cmCard", on ? "on" : "off"); }
    };
  })();
