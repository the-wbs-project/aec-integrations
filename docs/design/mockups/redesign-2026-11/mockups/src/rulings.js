/* ---------- Rulings: Options-panel comparisons and scoped smooth scrolling ---------- */
(function rulings() {
  var root = document.documentElement;
  function bind(name, fn) {
    document.querySelectorAll('input[name="' + name + '"]').forEach(function (r) { r.addEventListener("change", function () { if (r.checked) fn(r.value); }); });
  }
  bind("rType", function (v) { root.classList.toggle("r-type-orig", v === "orig"); });
  bind("rBtn", function (v) { root.classList.toggle("r-btn-orig", v === "orig"); });
  bind("rHero", function (v) { root.classList.toggle("r-hero-first", v === "first"); root.classList.toggle("r-solid", v === "solid"); });
  bind("rBar", function (v) { root.classList.toggle("r-bar-first", v === "first"); });

  /* 38: smooth scrolling only for in-page section links, never a global scroll-behavior, never under reduced motion.
     Turning it off (or reduced motion) leaves the browser's own instant jump, which is the shipped behaviour. */
  var smooth = true, reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var SECTION_LINKS = "#snl a, #rail a, #jump a, a.medal-label, a.hr-rv, .f-stat a, a.know-link, .picked a";
  bind("rScroll", function (v) { smooth = v === "on"; });
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href^='#']");
    if (!a || a.getAttribute("href").length < 2 || !a.matches(SECTION_LINKS)) return;
    var t = document.getElementById(a.getAttribute("href").slice(1));
    if (!t || !smooth || reduce.matches) return;
    e.preventDefault();
    t.scrollIntoView({ behavior: "smooth", block: "start" });
    if (history.pushState) history.pushState(null, "", a.getAttribute("href"));
    if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1");
    t.focus({ preventScroll: true });
  });
  window.__RUL = {
    set: function (name, v) { var r = document.querySelector('input[name="' + name + '"][value="' + v + '"]'); if (r) { r.checked = true; r.dispatchEvent(new Event("change")); } },
    smooth: function () { return smooth && !reduce.matches; }
  };
})();
