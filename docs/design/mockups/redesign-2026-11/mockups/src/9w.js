/* Mock-up 9w: the integration wheel in the product page hero (AECI-2018).
 *
 * One script, three roles:
 *   - render: pure data -> HTML. The build (9w-build.mjs) runs it in Node to write the
 *     server HTML of the default state into the page, so the file reads with no script.
 *   - enhance(): the hydrated behaviour (arrows, the jump list, the ring's arrow keys, the card).
 *   - harness(): when the file is opened on its own, it becomes a control strip with the
 *     page in a frame at 1440, 390 or 320 wide, so states can be toggled and compared.
 *
 * Every string that reaches markup goes through esc(). The data is the review app's own
 * records, built into the file; nothing comes from the URL but numbers and option keys.
 */
(function (root) {
  'use strict';
  var W = {};
  var DATA = root.WHEEL_DATA;

  /* ---------- Defaults: the recommended values ---------- */
  var DEFAULTS = {
    product: 'medium', // small | cc | revit | medium | live | large | full
    claim: 'claimed', // claimed | unclaimed (the page's own product)
    partners: 'mixed', // mixed | all | none (which partners show a logo)
    cut: 'fit', // fit | fixed: modes by what fits at the real width, or by the numbers below
    tmin: 28, // smallest tile beside the text (lg and up), px. Phones use 24.
    one: 30, // fixed: one ring up to this many partners
    two: 70, // fixed: two rings up to this many, dots above
    phone: 18, // fixed: phone, one ring up to this many, dots above
    base: 'inner', // inner | full: where the one-ring slides sit on desktop
    names: 'off', // on | off: names under tiles on slides of 8 or fewer
    first: 0, // boundary test: only the first N partners A to Z (0 = all)
    slide: 0,
  };
  W.DEFAULTS = DEFAULTS;

  var GAP = 8; // between tiles on a ring, px
  var EDGE = 6; // room for the 3px focus ring at the stage edge
  var RING_GAP = 12; // between the two rings
  var TMAX_DESK = 48;
  var TMAX_PHONE = 40;
  var TMAX_TWO = 40;
  var TMIN_PHONE = 24;
  var PHONE_BELOW = 320; // a stage narrower than this is a phone: one ring, no second ring

  /* ---------- Helpers ---------- */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function setHtml(el, s) {
    el.replaceChildren();
    el.insertAdjacentHTML('beforeend', s);
  }
  function cmp(a, b) {
    return a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
  }
  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function initial(name) {
    var m = String(name).match(/[A-Za-z0-9]/);
    return m ? m[0].toUpperCase() : '?';
  }
  function plural(n, one, many) {
    return n === 1 ? '1 ' + one : n + ' ' + many;
  }
  function slugify(s) {
    return s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /* Stand-in logos. No vendor logo is used: a claimed product shows one of these
     procedural marks (the palette and glyphs of mock-ups 7 and 8, src/shared.js). */
  var PAL = [['#2F6FD0', '#163B7E', '#BFD5FF'], ['#E0663A', '#93300F', '#FFD9C4'], ['#1E9E8A', '#0A5A4F', '#B8F0E4'], ['#6B4FC8', '#382285', '#D9CEFF'],
    ['#7E8F2A', '#3F4B0E', '#E6F0A8'], ['#D23F55', '#83152A', '#FFC9D2'], ['#2C4A7A', '#111F3A', '#A9C4F0'], ['#E5A11F', '#A15C05', '#FFE7B0'],
    ['#2E8A4F', '#114727', '#BDEFCB'], ['#56657A', '#252D38', '#C9D5E3'], ['#B8478A', '#6B1A4D', '#F7C6E2'], ['#1798B8', '#0A5568', '#B5EBF7'],
    ['#9A6A3E', '#4F3216', '#F2D8BC'], ['#4256C9', '#1E2A7A', '#C8D0FF']];
  var GLYPH = [
    '<circle cx="24" cy="24" r="11" fill="none" stroke="#fff" stroke-width="4"/><circle cx="24" cy="24" r="3.6" fill="{a}"/>',
    '<path d="M14 34 25 14M23 34l11-20" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/>',
    '<path d="m13 27 11-11 11 11" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/><path d="m17 35 7-7 7 7" fill="none" stroke="{a}" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>',
    '<path d="M24 10 38 24 24 38 10 24z" fill="#fff"/><path d="M24 18.5 29.5 24 24 29.5 18.5 24z" fill="{d}"/>',
    '<path d="M11 23a18 18 0 0 1 26 0" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/><path d="M16.5 29a10 10 0 0 1 15 0" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".75"/><circle cx="24" cy="34.5" r="3" fill="{a}"/>',
    '<g fill="#fff"><circle cx="15" cy="15" r="3"/><circle cx="24" cy="15" r="3"/><circle cx="33" cy="15" r="3"/><circle cx="15" cy="24" r="3"/><circle cx="33" cy="24" r="3"/><circle cx="15" cy="33" r="3"/><circle cx="24" cy="33" r="3"/><circle cx="33" cy="33" r="3"/></g><circle cx="24" cy="24" r="4.4" fill="{a}"/>',
    '<path d="M24 11 37.5 35h-27z" fill="#fff"/><path d="M24 24 30 35H18z" fill="{d}"/>',
    '<path d="M10 29c4.7-6 9.3-6 14 0s9.3 6 14 0" stroke="#fff" stroke-width="4.4" fill="none" stroke-linecap="round"/><path d="M10 20c4.7-6 9.3-6 14 0s9.3 6 14 0" stroke="{a}" stroke-width="4.4" fill="none" stroke-linecap="round"/>',
    '<rect x="12" y="12" width="24" height="24" rx="6" fill="#fff" transform="rotate(12 24 24)"/><circle cx="24" cy="24" r="5" fill="{d}"/>',
    '<path d="M24 10.5 35.7 17.25v13.5L24 37.5l-11.7-6.75v-13.5z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/><path d="M24 18v12" stroke="{a}" stroke-width="4" stroke-linecap="round"/>',
    '<path d="M24 12v24M12 24h24" stroke="#fff" stroke-width="5.6" stroke-linecap="round"/><circle cx="24" cy="24" r="3.2" fill="{d}"/>',
    '<path d="M12 36V24a12 12 0 0 1 12-12v24z" fill="#fff"/><path d="M26 36V26h10a10 10 0 0 1-10 10z" fill="{a}"/>',
    '<path d="M11 31a13 13 0 0 1 26 0z" fill="#fff"/><path d="M9 36h30" stroke="{a}" stroke-width="3.6" stroke-linecap="round"/>',
    '<circle cx="16" cy="32" r="4.2" fill="{a}"/><path d="M22 34 34 14" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/><path d="M14 22 22 14" stroke="#fff" stroke-width="4.6" stroke-linecap="round" opacity=".6"/>',
  ];
  function standInLogo(name) {
    var h = hash(name), p = PAL[h % 14], g = GLYPH[(h >>> 4) % 14];
    return '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><rect width="48" height="48" fill="' + p[0] + '"/>' +
      g.replace(/\{a\}/g, p[2]).replace(/\{d\}/g, p[1]) + '</svg>';
  }
  /* The logo rule: a claimed product's logo, else the initial tile. Both share the box. */
  function mark(name, claimed, size) {
    var cls = 'mk' + (size ? ' ' + size : '');
    if (claimed) return '<span class="' + cls + ' logo" aria-hidden="true">' + standInLogo(name) + '</span>';
    return '<span class="' + cls + '" aria-hidden="true"><span class="ini">' + esc(initial(name)) + '</span></span>';
  }
  W.mark = mark;

  /* ---------- The model: partners A to Z, and the slides ---------- */
  function partnerClaimed(name, mode) {
    if (mode === 'all') return true;
    if (mode === 'none') return false;
    return hash(name + '#claim') % 10 < 3; // stand-in: about 3 in 10 partners claimed
  }
  function model(state) {
    var raw = DATA.products[state.product] || DATA.products.medium;
    var rows = raw.partners || DATA.products[raw.sliceOf].partners.slice(0, raw.limit);
    var partners = rows.map(function (r) {
      return { name: r[0], slug: r[1], vendor: r[2], cats: r[3], n: r[4], claimed: partnerClaimed(r[0], state.partners) };
    });
    partners.sort(function (a, b) {
      return cmp(a.name, b.name) || cmp(a.slug, b.slug);
    });
    if (state.first > 0) partners = partners.slice(0, state.first);
    var byCat = {};
    partners.forEach(function (p) {
      p.cats.forEach(function (c) {
        (byCat[c] = byCat[c] || []).push(p);
      });
    });
    var cats = Object.keys(byCat).sort(cmp);
    var slides = [{ key: 'all', name: 'All partners', partners: partners }].concat(
      cats.map(function (c) {
        return { key: slugify(c), name: c, partners: byCat[c] };
      }),
    );
    slides.forEach(function (s) {
      s.integrations = s.partners.reduce(function (t, p) {
        return t + p.n;
      }, 0);
    });
    return { raw: raw, partners: partners, slides: slides, cats: cats.length, claimed: state.claim === 'claimed' };
  }
  W.model = model;

  /* ---------- Geometry ---------- */
  // The stage diameter for a viewport width, from the hero band's columns.
  function stageFor(vw) {
    if (vw >= 1280) return 476; // 540 panel less 2 x 32 padding
    if (vw >= 1024) return 336; // 400 panel less 2 x 32
    var gutter = vw >= 768 ? 32 : 24, pad = vw >= 768 ? 32 : 24;
    return Math.min(476, vw - 2 * gutter - 2 * pad);
  }
  W.stageFor = stageFor;
  function cap(r, t) {
    return Math.floor((2 * Math.PI * r) / (t + GAP));
  }
  function isPhone(D) {
    return D < PHONE_BELOW;
  }
  W.isPhone = isPhone;
  function radii(D, t, base, twoOk) {
    var R = D / 2 - EDGE;
    var outer = R - t / 2;
    var inner = outer - t - RING_GAP;
    return { outer: outer, inner: inner, one: twoOk && base === 'inner' ? inner : outer };
  }
  // The largest partner count one ring, or two, can hold at tile size t.
  function capacity(D, t, base) {
    var twoOk = !isPhone(D);
    var r = radii(D, t, base, twoOk);
    return { one: cap(r.one, t), two: twoOk ? cap(r.inner, t) + cap(r.outer, t) : 0 };
  }
  W.capacity = capacity;

  function layout(slide, D, state) {
    var n = slide.partners.length;
    var twoOk = !isPhone(D);
    var tmax = twoOk ? TMAX_DESK : TMAX_PHONE;
    var tmin = twoOk ? state.tmin : TMIN_PHONE;
    var mode;
    if (state.cut === 'fit') {
      // Whatever holds every tile at the smallest size, at this width.
      var cm = capacity(D, tmin, state.base);
      mode = n <= cm.one ? 'one' : twoOk && n <= cm.two ? 'two' : 'dots';
    } else if (!twoOk) mode = n <= state.phone ? 'one' : 'dots';
    else mode = n <= state.one ? 'one' : n <= state.two ? 'two' : 'dots';
    var out = { mode: mode, D: D, n: n, items: [], rings: [], warn: '' };
    if (mode === 'dots') return dotLayout(slide, D, out);
    // The largest tile in [tmin, tmax] that fits. At tmin they may not fit, which is warned.
    // Two rings cap the tile lower than one ring does, so a full wheel stays calm.
    var t = mode === 'two' ? Math.min(tmax, TMAX_TWO) : tmax;
    for (; t > tmin; t--) {
      var c = capacity(D, t, state.base);
      if (mode === 'one' ? n <= c.one : n <= c.two) break;
    }
    var rr = radii(D, t, state.base, twoOk);
    var c2 = capacity(D, t, state.base);
    if (mode === 'one' && n > c2.one) out.warn = 'Over capacity: ' + n + ' partners on one ring that holds ' + c2.one + ' at ' + t + 'px.';
    if (mode === 'two' && n > c2.two) out.warn = 'Over capacity: ' + n + ' partners on two rings that hold ' + c2.two + ' at ' + t + 'px.';
    out.t = t;
    var groups;
    if (mode === 'one') groups = [[rr.one, n]];
    else {
      // A to Z fills the inner ring, then continues on the outer ring. The split keeps
      // the same spacing on both rings, so neither looks emptier.
      var k = Math.min(cap(rr.inner, t), Math.round((n * rr.inner) / (rr.inner + rr.outer)));
      groups = [[rr.inner, k], [rr.outer, n - k]];
    }
    groups.forEach(function (g) {
      out.rings.push(g[0]);
      for (var j = 0; j < g[1]; j++) {
        var a = (j / g[1]) * 2 * Math.PI - Math.PI / 2; // 12 o'clock, clockwise
        out.items.push({ x: (Math.cos(a) * g[0] * 100) / D, y: (Math.sin(a) * g[0] * 100) / D });
      }
    });
    return out;
  }
  function dotLayout(slide, D, out) {
    var m = slide.integrations;
    var dd = D >= 400 ? 6 : 5, pitch = D >= 400 ? 10 : 8;
    if (D < 400) out.small = true;
    var R = D / 2 - EDGE - dd / 2;
    var caps = [], total = 0, k = 0;
    while (total < m) {
      var r = R - k * pitch;
      var c = Math.floor((2 * Math.PI * r) / pitch);
      caps.push([r, c]);
      total += c;
      k++;
    }
    // Spread the dots over the rings by circumference, outer ring first, A to Z clockwise.
    var sumR = caps.reduce(function (t, x) { return t + x[0]; }, 0), left = m;
    var dots = [];
    caps.forEach(function (rc, idx) {
      var cnt = idx === caps.length - 1 ? left : Math.min(rc[1], Math.round((m * rc[0]) / sumR));
      left -= cnt;
      for (var j = 0; j < cnt; j++) {
        var a = (j / cnt) * 2 * Math.PI - Math.PI / 2;
        dots.push([(Math.cos(a) * rc[0] * 100) / D, (Math.sin(a) * rc[0] * 100) / D]);
      }
    });
    out.dots = dots;
    out.dd = (dd * 100) / D;
    out.rings = caps.map(function (x) { return x[0]; });
    return out;
  }
  W.layout = layout;

  /* ---------- Rendering ---------- */
  function countLine(s) {
    return plural(s.partners.length, 'partner', 'partners');
  }
  function stageInner(m, s, L, state) {
    var p = m.raw;
    var h = '';
    // Guides: the orbit(s) the tiles sit on, and a dashed frame at the stage edge.
    h += '<svg class="guides" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">';
    var rf = 50 - (EDGE * 50) / L.D;
    h += '<circle class="frame" r="' + rf.toFixed(2) + '"/>';
    // A to Z starts at 12 o'clock: one short Clay stroke marks it.
    h += '<path class="start" d="M0 ' + (-rf - 1.4).toFixed(2) + 'V' + (-rf + 2.2).toFixed(2) + '"/>';
    if (L.mode !== 'dots') L.rings.forEach(function (r) { h += '<circle class="orbit" r="' + ((r * 100) / L.D).toFixed(2) + '"/>'; });
    h += '</svg>';
    // The ring: a real list of links, A to Z, one tab stop.
    var label = s.name + ', ' + countLine(s) + ', A to Z';
    var names = state.names === 'on' && s.partners.length <= 8;
    h += '<ul class="ring' + (names ? ' names' : '') + '" aria-label="' + esc(label) + '" style="--t:' + (((L.t || 0) * 100) / L.D).toFixed(3) + '">';
    if (L.mode !== 'dots') {
      s.partners.forEach(function (q, i) {
        var it = L.items[i];
        h += '<li style="--x:' + it.x.toFixed(2) + ';--y:' + it.y.toFixed(2) + '"><a class="tile" href="/products/' + esc(p.slug) + '/integrations/' + esc(q.slug) + '"' +
          ' data-i="' + i + '" tabindex="' + (i === 0 ? '0' : '-1') + '">' + mark(q.name, q.claimed) + '<span class="lbl">' + esc(q.name) + '</span></a></li>';
      });
    }
    h += '</ul>';
    // Dots: one per integration. Not links, so not in the list.
    if (L.mode === 'dots') {
      h += '<svg class="dotfield" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false">';
      var rr = (L.dd / 2).toFixed(2);
      L.dots.forEach(function (d) { h += '<circle cx="' + d[0].toFixed(2) + '" cy="' + d[1].toFixed(2) + '" r="' + rr + '"/>'; });
      h += '</svg>';
    }
    var where = s.key === 'all' ? 'in ' + plural(m.cats, 'category', 'categories') : 'in ' + s.name;
    h += '<div class="hub"><div class="hub-mark">' + mark(p.name, m.claimed, 'md') + '</div>' +
      '<p class="hub-count"><b>' + s.integrations + '</b><span>' + (s.integrations === 1 ? 'integration ' : 'integrations ') + esc(where) + '</span></p></div>';
    return h;
  }
  W.stageInner = stageInner;

  function renderWheel(m, state, D) {
    var i = Math.max(0, Math.min(state.slide, m.slides.length - 1));
    var s = m.slides[i];
    var L = layout(s, D, state);
    var h = '<section class="wheel" aria-labelledby="wheel-title" data-slide="' + i + '">';
    // With script: the arrows and the title that opens the list. Without: a static heading.
    h += '<div class="wheel-head">' +
      '<button type="button" class="wheel-step" data-step="-1" aria-label="Previous category"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg></button>' +
      '<h2 class="wheel-title" id="wheel-title"><button type="button" class="wheel-jump" aria-expanded="false" aria-controls="jump-list">' +
      '<span class="nm"><span>' + esc(s.name) + '</span><svg class="ico s" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>' +
      '<span class="sr">, </span><span class="ct">' + countLine(s) + '</span></button></h2>' +
      '<button type="button" class="wheel-step" data-step="1" aria-label="Next category"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg></button>' +
      '<ul class="jump-list" id="jump-list" aria-label="Jump to a category" hidden></ul></div>';
    h += '<h2 class="wheel-static-title">Integration partners<span class="ct">' + countLine(s) + ', ' + plural(m.cats, 'category', 'categories') + '</span></h2>';
    h += '<div class="stage' + (L.mode === 'dots' ? ' dots' : '') + '" data-mode="' + L.mode + '" data-d="' + D + '">' + stageInner(m, s, L, state) + '</div>';
    h += '<p class="wheel-foot" id="wheel-foot">Shown A to Z. Position is not a ranking.</p>';
    if (L.mode === 'dots') h += '<p class="wheel-more"><a href="#integrations">See all ' + s.integrations + ' in Integrations</a></p>';
    h += '<p class="sr" id="ring-hint">Arrow keys move between partners.</p>';
    h += '<p class="sr" aria-live="polite" id="wheel-live"></p>';
    // The card is fixed to the viewport, so it is never clipped by the hero; it lives here
    // so it stays inside the page's landmarks.
    h += '<div class="pcard" id="pcard" role="tooltip" hidden></div>';
    h += '</section>';
    return { html: h, layout: L, slide: s };
  }

  function renderPage(state, D) {
    var m = model(state);
    var p = m.raw;
    var claimed = m.claimed;
    var total = m.partners.reduce(function (t, q) { return t + q.n; }, 0);
    var wheel = renderWheel(m, state, D);
    var h = '';
    h += '<header class="site-head"><div class="wrap"><a href="#" aria-label="AEC Integrations home"><svg class="wm" viewBox="0 0 196 30" aria-hidden="true"><use href="#wm"/></svg></a>' +
      '<nav aria-label="Main"><a href="#">Browse</a><a href="#">Search</a><a href="#" class="keep">For vendors</a></nav></div></header>';
    h += '<main><section class="hero" aria-label="Product"><div class="wrap">';
    h += '<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="#">Home</a></li><li><a href="#">Products</a></li><li><span aria-current="page">' + esc(p.name) + '</span></li></ol></nav>';
    h += '<div class="hero-grid"><div class="hero-text">';
    h += '<div class="namerow"><div class="hmark">' + mark(p.name, claimed, 'big') + '</div><div><h1><span class="display">' + esc(p.name) + '</span></h1>';
    h += '<p class="byline">by <a href="#">' + esc(p.vendor) + '</a></p>';
    if (!claimed) h += '<div class="unclaimed">' + mark(p.name, true) + '<span>Unclaimed · not affiliated with or endorsed by this vendor</span></div>';
    h += '</div></div>';
    h += '<p class="lede" aria-hidden="true">' + esc(p.lede) + '</p>';
    h += '<p class="reviews-none">No reviews yet</p>';
    h += '<div class="hacts"><a class="btn btn-on-brand" href="#">Visit website <svg class="ico s" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg><span class="sr">(opens in a new tab)</span></a>' +
      '<a class="btn btn-on-brand-2" href="#">Write a review</a></div>';
    h += '</div><div class="panel">' + wheel.html + '</div></div></div></section>';
    h += '<div class="ground"><div class="wrap"><div class="facts">' +
      '<div class="stat"><div class="fig">' + total + '</div><div class="lab">integrations</div></div>' +
      '<div><p class="overline">Vendor</p><p>' + esc(p.vendor) + '</p></div>' +
      '<div><p class="overline">Categories</p><p>' + esc(p.categories.join(', ')) + '</p></div>' +
      '<div><p class="overline">Resources</p><p>Website</p></div></div></div></div>';
    h += '<section id="integrations" class="wrap body-band" aria-labelledby="int-h"><h2 id="int-h">Integrations</h2></section>';
    h += '</main>';
    return { html: h, model: m, wheel: wheel };
  }
  W.renderPage = renderPage;

  /* ---------- State in the URL ---------- */
  var KEYS = /^[a-z]+$/;
  function readState(search) {
    var q = new URLSearchParams(search || '');
    var s = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = q.has(k) ? q.get(k) : DEFAULTS[k];
      if (typeof DEFAULTS[k] === 'number') s[k] = Math.max(0, Math.min(400, Number(v) || 0));
      else s[k] = KEYS.test(String(v)) ? String(v) : DEFAULTS[k];
    });
    if (s.tmin < 16) s.tmin = DEFAULTS.tmin;
    if (!DATA.products[s.product]) s.product = DEFAULTS.product;
    return s;
  }
  W.readState = readState;
  function query(state) {
    var q = new URLSearchParams();
    Object.keys(DEFAULTS).forEach(function (k) {
      if (String(state[k]) !== String(DEFAULTS[k])) q.set(k, state[k]);
    });
    return q.toString();
  }
  W.query = query;

  /* ---------- Enhancement: the hydrated wheel ---------- */
  function enhance(doc, state) {
    var win = doc.defaultView;
    var page = doc.getElementById('page');
    var D = stageFor(win.innerWidth);
    var out = renderPage(state, D);
    setHtml(page, out.html);
    var m = out.model;
    var cur = Math.max(0, Math.min(state.slide, m.slides.length - 1));
    var section = page.querySelector('.wheel');
    var stage = section.querySelector('.stage');
    var jump = section.querySelector('.wheel-jump');
    var list = section.querySelector('.jump-list');
    var live = section.querySelector('#wheel-live');
    var card = doc.getElementById('pcard');
    var active = 0; // the ring's one tab stop
    var lastLayout = out.wheel.layout;

    function report() {
      if (win.parent !== win) {
        var s = m.slides[cur], L = lastLayout, c = capacity(L.D, isPhone(L.D) ? TMIN_PHONE : state.tmin, state.base);
        win.parent.postMessage({ wheel: { slide: s.name, i: cur, of: m.slides.length, n: s.partners.length, m: s.integrations, mode: L.mode, t: L.t, D: L.D, rings: L.rings.length, cap1: c.one, cap2: c.two, warn: L.warn } }, '*');
      }
      W.last = { slide: m.slides[cur].name, mode: lastLayout.mode, t: lastLayout.t, D: lastLayout.D, n: m.slides[cur].partners.length, warn: lastLayout.warn };
    }
    function names() {
      var n = m.slides.length;
      section.querySelector('[data-step="-1"]').setAttribute('aria-label', 'Previous category: ' + m.slides[(cur - 1 + n) % n].name);
      section.querySelector('[data-step="1"]').setAttribute('aria-label', 'Next category: ' + m.slides[(cur + 1) % n].name);
    }
    function show(i, announce) {
      var n = m.slides.length;
      cur = (i + n) % n;
      var s = m.slides[cur];
      var D2 = stage.getBoundingClientRect().width || D;
      var L = layout(s, Math.round(D2), state);
      lastLayout = L;
      hideCard();
      stage.className = 'stage' + (L.mode === 'dots' ? ' dots' : '');
      stage.dataset.mode = L.mode;
      setHtml(stage, stageInner(m, s, L, state));
      jump.querySelector('.nm span').textContent = s.name;
      jump.querySelector('.ct').textContent = countLine(s);
      section.dataset.slide = cur;
      var more = section.querySelector('.wheel-more');
      if (more) more.remove();
      active = 0;
      wireRing();
      names();
      if (announce) live.textContent = s.name + ', ' + countLine(s) + '. ' + (cur + 1) + ' of ' + n + '.';
      report();
    }
    W.show = show;

    /* The jump list */
    function openList() {
      setHtml(list, m.slides.map(function (s, i) {
        return '<li><button type="button" data-go="' + i + '"' + (i === cur ? ' aria-current="true"' : '') + '><span>' + esc(s.name) + '</span><span class="n">' + s.partners.length + '</span></button></li>';
      }).join(''));
      list.hidden = false;
      jump.setAttribute('aria-expanded', 'true');
      var b = list.querySelector('[aria-current]') || list.querySelector('button');
      b.focus();
      b.scrollIntoView({ block: 'nearest' });
    }
    function closeList(focus) {
      if (list.hidden) return;
      list.hidden = true;
      jump.setAttribute('aria-expanded', 'false');
      if (focus) jump.focus();
    }
    W.openList = openList;
    jump.addEventListener('click', function () {
      if (list.hidden) openList();
      else closeList(true);
    });
    list.addEventListener('click', function (e) {
      var b = e.target.closest('[data-go]');
      if (!b) return;
      closeList(true);
      show(Number(b.dataset.go), true);
    });
    list.addEventListener('keydown', function (e) {
      var bs = [].slice.call(list.querySelectorAll('button')), k = bs.indexOf(doc.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); bs[Math.min(bs.length - 1, k + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); bs[Math.max(0, k - 1)].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); bs[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); bs[bs.length - 1].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeList(true); }
      else if (e.key === 'Tab') closeList(false);
    });
    doc.addEventListener('click', function (e) {
      if (!list.hidden && !e.target.closest('.wheel-title') && !e.target.closest('.jump-list')) closeList(false);
    });

    /* The arrows: no auto-play, and they wrap from the last category back to All. */
    section.querySelectorAll('.wheel-step').forEach(function (b) {
      b.addEventListener('click', function () {
        closeList(false);
        show(cur + Number(b.dataset.step), true);
      });
    });

    /* The card: hover, keyboard focus and tap-and-hold. Hoverable, and Escape dismisses it. */
    var hideTimer = 0, holdTimer = 0, cardFor = null, held = false;
    function cardHtml(q) {
      return mark(q.name, q.claimed) + '<div><div class="nm">' + esc(q.name) + '</div>' + (q.vendor ? '<div class="by">by ' + esc(q.vendor) + '</div>' : '') + '</div>';
    }
    function showCard(a) {
      clearTimeout(hideTimer);
      var q = m.slides[cur].partners[Number(a.dataset.i)];
      if (!q) return;
      setHtml(card, cardHtml(q));
      card.hidden = false;
      if (cardFor && cardFor !== a) {
        cardFor.classList.remove('is-active');
        cardFor.removeAttribute('aria-describedby');
      }
      cardFor = a;
      a.classList.add('is-active');
      a.setAttribute('aria-describedby', 'pcard');
      place(a);
    }
    W.showCard = function (i) { showCard(stage.querySelectorAll('.tile')[i]); };
    function place(a) {
      var r = a.getBoundingClientRect(), st = stage.getBoundingClientRect();
      var cw = card.offsetWidth, ch = card.offsetHeight, vw = doc.documentElement.clientWidth, vh = win.innerHeight, M = 8;
      var cx = st.left + st.width / 2, cy = st.top + st.height / 2;
      var tx = r.left + r.width / 2, ty = r.top + r.height / 2;
      var dx = tx - cx, dy = ty - cy;
      var x, y;
      // Outward from the hub: beside the tile on its side of the circle, else above or below it.
      if (Math.abs(dx) >= Math.abs(dy) * 0.6) {
        x = dx >= 0 ? r.right + 12 : r.left - 12 - cw;
        y = ty - ch / 2;
        if (x + cw > vw - M || x < M) { x = tx - cw / 2; y = dy >= 0 ? r.bottom + 12 : r.top - 12 - ch; }
      } else {
        x = tx - cw / 2;
        y = dy >= 0 ? r.bottom + 12 : r.top - 12 - ch;
      }
      x = Math.max(M, Math.min(vw - M - cw, x));
      if (y < M) y = r.bottom + 12;
      if (y + ch > vh - M) y = Math.max(M, r.top - 12 - ch);
      card.style.left = Math.round(x) + 'px';
      card.style.top = Math.round(y) + 'px';
    }
    function hideCard() {
      clearTimeout(hideTimer);
      card.hidden = true;
      if (cardFor) {
        cardFor.classList.remove('is-active');
        cardFor.removeAttribute('aria-describedby');
      }
      cardFor = null;
    }
    function hideSoon() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hideCard, 120);
    }
    card.addEventListener('pointerenter', function () { clearTimeout(hideTimer); });
    card.addEventListener('pointerleave', function () {
      if (!(cardFor && cardFor === doc.activeElement)) hideSoon();
    });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !card.hidden) { e.preventDefault(); hideCard(); }
    });
    win.addEventListener('scroll', function () { if (cardFor) place(cardFor); }, { passive: true });

    function tiles() {
      return [].slice.call(stage.querySelectorAll('.tile'));
    }
    function focusTile(i) {
      var ts = tiles();
      if (!ts.length) return;
      i = (i + ts.length) % ts.length;
      ts.forEach(function (t, j) { t.tabIndex = j === i ? 0 : -1; });
      active = i;
      ts[i].focus();
    }
    function wireRing() {
      var ring = stage.querySelector('.ring');
      ring.setAttribute('aria-describedby', 'ring-hint wheel-foot');
      tiles().forEach(function (a) {
        a.addEventListener('pointerenter', function (e) { if (e.pointerType !== 'touch') showCard(a); });
        a.addEventListener('pointerleave', function (e) { if (e.pointerType !== 'touch' && a !== doc.activeElement) hideSoon(); });
        a.addEventListener('focus', function () {
          active = Number(a.dataset.i);
          tiles().forEach(function (t, j) { t.tabIndex = j === active ? 0 : -1; });
          showCard(a);
        });
        a.addEventListener('blur', function () { hideSoon(); });
        a.addEventListener('pointerdown', function (e) {
          if (e.pointerType !== 'touch') return;
          held = false;
          holdTimer = setTimeout(function () { held = true; showCard(a); }, 450);
        });
        ['pointerup', 'pointercancel'].forEach(function (ev) {
          a.addEventListener(ev, function () { clearTimeout(holdTimer); });
        });
        a.addEventListener('click', function (e) {
          e.preventDefault(); // mock-up: the pair pages are not in this file
          held = false; // a hold showed the card, so its release does not navigate
        });
        a.addEventListener('contextmenu', function (e) { if (held) e.preventDefault(); });
      });
      ring.addEventListener('keydown', function (e) {
        var k = e.key;
        if (k === 'ArrowRight' || k === 'ArrowDown') { e.preventDefault(); focusTile(active + 1); }
        else if (k === 'ArrowLeft' || k === 'ArrowUp') { e.preventDefault(); focusTile(active - 1); }
        else if (k === 'Home') { e.preventDefault(); focusTile(0); }
        else if (k === 'End') { e.preventDefault(); focusTile(tiles().length - 1); }
      });
    }
    wireRing();
    names();

    // Re-lay the ring when the stage width changes (a phone turned, a window resized).
    var lastD = Math.round(stage.getBoundingClientRect().width);
    if (win.ResizeObserver) {
      new win.ResizeObserver(function () {
        var d = Math.round(stage.getBoundingClientRect().width);
        if (d && Math.abs(d - lastD) > 1) { lastD = d; doc.documentElement.classList.add('no-entrance'); show(cur, false); }
      }).observe(stage);
    }
    stage.addEventListener('animationend', function () { doc.documentElement.classList.add('no-entrance'); }, { once: true });
    // The server laid the first slide out for its own guess of the width. Correct it now.
    if (lastD && lastD !== D) show(cur, false);
    else report();
  }
  W.enhance = enhance;

  /* ---------- The harness: a control strip and a frame ---------- */
  var CONTROLS = [
    ['product', 'Product', 'select', [['small', 'Small: ALICE Optimize, 6'], ['cc', 'CompanyCam, 26'], ['revit', 'Autodesk Revit, 38'], ['medium', 'Medium: Autodesk Forma, 54'], ['live', 'Procore Project Management, live, 57'], ['large', 'Large: Procore Project Management, 140'], ['full', 'Largest: Procore Project Management, 387']]],
    ['w', 'Width', 'radio', [['1440', '1440'], ['390', '390 phone'], ['320', '320']]],
    ['claim', 'This product', 'radio', [['claimed', 'Claimed'], ['unclaimed', 'Unclaimed']]],
    ['partners', 'Partner logos', 'radio', [['mixed', 'Mixed'], ['all', 'All claimed'], ['none', 'None claimed']]],
    ['cut', 'Cut-offs', 'radio', [['fit', 'Fit to the width'], ['fixed', 'Fixed numbers']]],
    ['tmin', 'Smallest tile beside the text', 'radio', [['24', '24'], ['28', '28'], ['32', '32']]],
    ['one', 'Fixed: one ring up to', 'number'],
    ['two', 'Fixed: two rings up to', 'number'],
    ['phone', 'Fixed: phone ring up to', 'number'],
    ['first', 'Only the first N partners', 'number'],
    ['base', 'One-ring slides sit', 'radio', [['inner', 'On the inner ring'], ['full', 'At full width']]],
    ['names', 'Names under tiles, 8 or fewer', 'radio', [['off', 'Off'], ['on', 'On']]],
    ['script', 'Script', 'radio', [['on', 'On'], ['off', 'Off: server HTML']]],
  ];
  function harness(doc, css, sprite) {
    var win = doc.defaultView;
    var q = new URLSearchParams(win.location.search);
    var state = readState(win.location.search);
    var w = ['1440', '390', '320'].indexOf(q.get('w')) >= 0 ? q.get('w') : '1440';
    var script = q.get('script') === 'off' ? 'off' : 'on';
    doc.title = 'Mock-up 9w: the integration wheel (AECI-2018)';
    doc.body.className = 'harness';
    var h = '<div class="h-strip" role="region" aria-label="Mock-up controls"><p class="h-title">Mock-up 9w, AECI-2018: the integration wheel. Every control is a state to compare. The defaults are the recommendation.</p><div class="h-groups">';
    CONTROLS.forEach(function (c) {
      var key = c[0], val = key === 'w' ? w : key === 'script' ? script : String(state[key]);
      h += '<fieldset class="h-g"><legend>' + c[1] + '</legend>';
      if (c[2] === 'select') {
        h += '<select name="' + key + '" aria-label="' + c[1] + '">' + c[3].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>';
      } else if (c[2] === 'radio') {
        h += c[3].map(function (o) { return '<label><input type="radio" name="' + key + '" value="' + o[0] + '"' + (o[0] === val ? ' checked' : '') + '> ' + o[1] + '</label>'; }).join('');
      } else {
        h += '<input type="number" min="0" max="400" name="' + key + '" value="' + esc(val) + '" aria-label="' + c[1] + '">';
      }
      h += '</fieldset>';
    });
    h += '</div><p class="h-read" id="h-read" aria-live="polite"></p></div>';
    h += '<div class="h-stage"><div class="h-device" id="h-device"><iframe id="h-frame" title="Product page"></iframe></div></div>';
    setHtml(doc.body, h);
    var frame = doc.getElementById('h-frame'), device = doc.getElementById('h-device'), read = doc.getElementById('h-read');
    function apply() {
      var width = Number(w);
      device.style.width = width + 'px';
      frame.style.height = (width >= 1024 ? 1000 : 1800) + 'px';
      var qs = query(state);
      history.replaceState(null, '', '?' + (qs ? qs + '&' : '') + 'w=' + w + (script === 'off' ? '&script=off' : ''));
      if (script === 'off') {
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.removeAttribute('src');
        frame.srcdoc = W.document(state, stageFor(width), css, sprite);
        read.textContent = 'Script off: the server HTML. The first slide only, placed by CSS, with no arrows and no title list.';
      } else {
        frame.removeAttribute('sandbox');
        frame.removeAttribute('srcdoc');
        frame.src = '?frame=1' + (qs ? '&' + qs : '');
      }
    }
    doc.querySelectorAll('.h-strip input, .h-strip select').forEach(function (el) {
      el.addEventListener('change', function () {
        var k = el.name, v = el.value;
        if (k === 'w') w = v;
        else if (k === 'script') script = v;
        else {
          state[k] = typeof DEFAULTS[k] === 'number' ? Math.max(0, Math.min(400, Number(v) || 0)) : v;
          state.slide = 0;
        }
        apply();
      });
    });
    win.addEventListener('message', function (e) {
      var r = e.data && e.data.wheel;
      if (!r || e.source !== frame.contentWindow) return;
      read.textContent = 'Slide ' + (r.i + 1) + ' of ' + r.of + ': ' + r.slide + '. ' + r.n + ' partners, ' + r.m + ' integrations. ' +
        (r.mode === 'dots' ? 'Dots on ' + r.rings + ' rings.' : (r.mode === 'two' ? 'Two rings' : 'One ring') + ', tiles ' + r.t + 'px.') +
        ' Stage ' + r.D + 'px. At the smallest tile this stage holds ' + r.cap1 + ' on one ring' + (r.cap2 ? ' and ' + r.cap2 + ' on two.' : '.') + (r.warn ? ' ' + r.warn : '');
    });
    apply();
  }
  W.harness = harness;

  /* A whole document for the page, as the server would send it, with no script. */
  W.document = function (state, D, css, sprite) {
    var out = renderPage(state, D);
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(out.model.raw.name) + ': integrations and reviews</title>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,400..700;1,400..700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">' +
      '<style>' + css + '</style></head><body>' + sprite + '<div id="page">' + out.html + '</div></body></html>';
  };

  root.Wheel = W;

  /* ---------- Boot ---------- */
  if (typeof document !== 'undefined' && document.getElementById('page')) {
    var params = new URLSearchParams(location.search);
    if (params.has('frame') || params.has('page')) {
      document.documentElement.classList.add('js');
      enhance(document, readState(location.search));
    } else {
      harness(document, document.getElementById('page-css').textContent, document.getElementById('sprite').outerHTML);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
