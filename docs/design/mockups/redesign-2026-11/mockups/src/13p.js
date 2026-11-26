/* Mock-up 13 (AECI-1809): the vendor portal. Two modes in one file.
 *   - Opened on its own, the file is a control strip (mock-up chrome) and a frame.
 *   - With ?frame=1 it is the page. Each state is a URL parameter, copied onto <html>
 *     as a data attribute; CSS draws the state. So a picture is a URL:
 *     13-vendor-portal.html?frame=1&page=form&head=forest
 * The harness reloads the frame on every change. Nothing here is part of the design
 * except the tab row's edge fades and the option chips' keyboard model.
 */
(function () {
  var CONTROLS = [
    ['head', 'Page header', [['plain', 'Plain white header *'], ['forest', 'Forest hero band']]],
    ['cards', 'Content cards', [['card', 'Shared white card, card shadow, 24px *'], ['flat', 'Flat bordered panels, 24px']]],
    ['tabs', 'Tab row', [['underline', 'Forest underline, 600, like /search *'], ['clay', 'Clay bar, like the product section nav']]],
    ['crumb', 'Breadcrumb', [['shared', 'Shared, underline on hover *'], ['today', "Today's hand-rolled trail"]]],
    ['w', 'Width', [['1440', '1440'], ['768', '768'], ['390', '390'], ['320', '320']]],
    ['page', 'Page', [['overview', 'Overview'], ['form', 'Form: company profile'], ['accept', 'Legal acceptance']]],
    ['banner', 'Banner', [['none', 'None'], ['ended', 'Plan ended'], ['legal', 'Legal acceptance asked'], ['hidden', 'Listing hidden']]],
    ['ctx', 'Shell context', [['company', 'Company'], ['product', 'A product, with its plan badge']]],
    ['fstate', 'Form state', [['error', 'Edited, one error'], ['saved', 'Saved']]],
  ];
  var DEFAULTS = { head: 'plain', cards: 'card', tabs: 'underline', crumb: 'shared', w: '1440', page: 'overview', banner: 'none', ctx: 'company', fstate: 'error' };

  function read(search) {
    var q = new URLSearchParams(search);
    var s = {};
    CONTROLS.forEach(function (c) {
      var v = q.get(c[0]);
      s[c[0]] = c[2].some(function (o) { return o[0] === v; }) ? v : DEFAULTS[c[0]];
    });
    return s;
  }
  function query(s, withW) {
    return CONTROLS.filter(function (c) { return (withW || c[0] !== 'w') && s[c[0]] !== DEFAULTS[c[0]]; })
      .map(function (c) { return c[0] + '=' + s[c[0]]; }).join('&');
  }

  if (new URLSearchParams(location.search).has('frame')) page(read(location.search));
  else harness(read(location.search));

  function page(s) {
    var root = document.documentElement;
    Object.keys(s).forEach(function (k) { if (k !== 'w') root.dataset[k] = s[k]; });
    var titles = { overview: 'Vendor Overview', form: 'Profile', accept: 'Accept the Vendor Terms' };
    document.title = titles[s.page] + ' · Summit BIM · Vendor portal | AEC Integrations';
    // The current tab. Only one row is visible at a time, so both rows can mark it.
    document.querySelectorAll('.tabs a').forEach(function (a) {
      if (a.dataset.page === s.page) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    // The tab row's edge fades: one class per edge with more tabs past it.
    document.querySelectorAll('.tabs').forEach(function (nav) {
      var ul = nav.querySelector('ul');
      function edges() {
        nav.classList.toggle('more-start', ul.scrollLeft > 2);
        nav.classList.toggle('more-end', ul.scrollLeft + ul.clientWidth < ul.scrollWidth - 2);
      }
      ul.addEventListener('scroll', edges, { passive: true });
      window.addEventListener('resize', edges);
      // A tab that takes focus scrolls fully into the row, clear of the fades.
      ul.addEventListener('focusin', function (e) {
        var a = e.target, l = a.offsetLeft - 40, r = a.offsetLeft + a.offsetWidth + 40 - ul.clientWidth;
        if (ul.scrollLeft > l) ul.scrollLeft = Math.max(0, l);
        else if (ul.scrollLeft < r) ul.scrollLeft = r;
      });
      var cur = ul.querySelector('[aria-current]');
      if (cur && cur.offsetLeft + cur.offsetWidth > ul.clientWidth) ul.scrollLeft = cur.offsetLeft - 40;
      edges();
    });
    // Option chips: an Angular Aria single-select listbox, horizontal. Arrows move,
    // Space or Enter selects, Tab leaves. Roving tabindex.
    document.querySelectorAll('[role="listbox"]').forEach(function (lb) {
      var opts = Array.prototype.slice.call(lb.querySelectorAll('[role="option"]'));
      function focus(i) { opts.forEach(function (o, j) { o.tabIndex = j === i ? 0 : -1; }); opts[i].focus(); }
      function pick(o) { opts.forEach(function (x) { x.setAttribute('aria-selected', String(x === o)); }); }
      opts.forEach(function (o, i) {
        o.addEventListener('click', function () { pick(o); focus(i); });
        o.addEventListener('keydown', function (e) {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); focus((i + 1) % opts.length); }
          else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); focus((i - 1 + opts.length) % opts.length); }
          else if (e.key === 'Home') { e.preventDefault(); focus(0); }
          else if (e.key === 'End') { e.preventDefault(); focus(opts.length - 1); }
          else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pick(o); }
        });
      });
    });
    // Nothing submits and no link leaves the mock-up.
    document.addEventListener('submit', function (e) { e.preventDefault(); });
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href="#"]');
      if (a) e.preventDefault();
    });
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (k) { n.appendChild(k); });
    return n;
  }

  function harness(s) {
    document.documentElement.removeAttribute('data-page');
    document.title = 'Mock-up 13: the vendor portal (AECI-1809)';
    var style = el('style', { text: document.getElementById('harness-css').textContent });
    var groups = el('div', { class: 'h-groups' }, CONTROLS.map(function (c) {
      return el('fieldset', { class: 'h-g' }, [el('legend', { text: c[1] })].concat(c[2].map(function (o) {
        var input = el('input', { type: 'radio', name: c[0], value: o[0] });
        input.checked = s[c[0]] === o[0];
        return el('label', {}, [input, document.createTextNode(' ' + o[1])]);
      })));
    }));
    var open = el('a', { id: 'h-open', href: '#', text: 'Open this state on its own' });
    var strip = el('div', { class: 'h-strip', role: 'region', 'aria-label': 'Mock-up controls' }, [
      el('p', { class: 'h-title', text: 'Mock-up 13, AECI-1809: the vendor portal shell, Overview, company Profile and the acceptance screen. * marks the recommendation, which is each default.' }),
      groups,
      el('p', { class: 'h-read' }, [open]),
    ]);
    var frame = el('iframe', { id: 'h-frame', title: 'Vendor portal mock-up' });
    var device = el('div', { class: 'h-device', id: 'h-device' }, [frame]);
    document.body.className = 'harness';
    document.body.replaceChildren(style, strip, el('div', { class: 'h-stage' }, [device]));
    function apply() {
      var qs = query(s, false);
      device.style.width = s.w + 'px';
      frame.style.height = (Number(s.w) >= 1024 ? 1100 : 1800) + 'px';
      frame.src = '?frame=1' + (qs ? '&' + qs : '');
      open.href = '?frame=1' + (qs ? '&' + qs : '');
      var all = query(s, true);
      history.replaceState(null, '', all ? '?' + all : location.pathname);
    }
    strip.querySelectorAll('input').forEach(function (input) {
      input.addEventListener('change', function () { s[input.name] = input.value; apply(); });
    });
    apply();
  }
})();
