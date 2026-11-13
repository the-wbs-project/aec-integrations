  /* ---------- Shared additions for mock-ups 7 and 8 ---------- */
  IC["Daily logs"] = '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M7.5 14h5M7.5 17h8"/>';
  IC["Schedules"] = '<path d="M4 4v16h16"/><rect x="7" y="6.5" width="7" height="3" rx="1.2"/><rect x="10" y="11" width="8" height="3" rx="1.2"/><rect x="8" y="15.5" width="5" height="3" rx="1.2"/>';
  IC["Budgets"] = '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>';
  IC["Timesheets"] = '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>';
  IC["Equipment"] = '<path d="M15 4a5 5 0 0 0-4.7 6.7L4 17v3h3l6.3-6.3A5 5 0 0 0 20 9l-3 1-2-2 1-3z"/>';
  IC["Observations"] = '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>';
  IC["Models"] = '<path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z"/><path d="M4 7.4l8 4.6 8-4.6M12 12v9.2"/>';
  IC["Contacts"] = '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="2.3"/><path d="M5.5 16a3.5 3.5 0 0 1 7 0M15 10h3.5M15 13.5h3.5"/>';
  IC.calc = '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8 7h8M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01M8.5 15h.01M12 15h.01M15.5 15h.01M8.5 18h.01M12 18h3.5"/>';
  IC.chart = '<path d="M4 20h16"/><rect x="6" y="11" width="3" height="7" rx="1"/><rect x="11" y="6" width="3" height="12" rx="1"/><rect x="16" y="13" width="3" height="5" rx="1"/>';
  IC.unlink = '<path d="M9.5 14.5 7.2 16.8a3.3 3.3 0 0 1-4.7-4.7l2.3-2.3"/><path d="M14.5 9.5l2.3-2.3a3.3 3.3 0 0 1 4.7 4.7l-2.3 2.3"/><path d="M8.5 4v2.5M4 8.5h2.5M15.5 20v-2.5M20 15.5h-2.5"/>';
  IC.sort = '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M13 6h8M13 11h6M13 16h4"/>';
  IC.layers = '<path d="M12 3 3 7.5 12 12l9-4.5z"/><path d="m3 12 9 4.5 9-4.5"/>';
  IC.list = '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>';

  MARKS.siteledger = ["#3C7A68", "#163F33", '<rect x="12" y="11" width="24" height="27" rx="4" fill="#fff"/><path d="M17 18h14M17 23.5h14M17 29h8" stroke="#2C6455" stroke-width="2.6" stroke-linecap="round"/><circle cx="31" cy="31" r="3.4" fill="#F2B04A"/>'];

  /* Procedural marks: 14 glyphs x 14 colour pairs, stepped so neighbours never share either. */
  var GEN_PAL = [["#2F6FD0", "#163B7E", "#BFD5FF"], ["#E0663A", "#93300F", "#FFD9C4"], ["#1E9E8A", "#0A5A4F", "#B8F0E4"], ["#6B4FC8", "#382285", "#D9CEFF"],
    ["#7E8F2A", "#3F4B0E", "#E6F0A8"], ["#D23F55", "#83152A", "#FFC9D2"], ["#2C4A7A", "#111F3A", "#A9C4F0"], ["#E5A11F", "#A15C05", "#FFE7B0"],
    ["#2E8A4F", "#114727", "#BDEFCB"], ["#56657A", "#252D38", "#C9D5E3"], ["#B8478A", "#6B1A4D", "#F7C6E2"], ["#1798B8", "#0A5568", "#B5EBF7"],
    ["#9A6A3E", "#4F3216", "#F2D8BC"], ["#4256C9", "#1E2A7A", "#C8D0FF"]];
  var GEN_GLYPH = [
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
    '<circle cx="16" cy="32" r="4.2" fill="{a}"/><path d="M22 34 34 14" stroke="#fff" stroke-width="4.6" stroke-linecap="round"/><path d="M14 22 22 14" stroke="#fff" stroke-width="4.6" stroke-linecap="round" opacity=".6"/>'
  ];
  var genN = 0;
  function genMark() {
    var i = genN++, p = GEN_PAL[(i * 5 + Math.floor(i / 14) * 3 + 3) % 14];
    var key = "gen" + i;
    MARKS[key] = [p[0], p[1], GEN_GLYPH[i % 14].replace(/\{a\}/g, p[2]).replace(/\{d\}/g, p[1])];
    return key;
  }
  function cmpName(a, b) { return a.localeCompare(b, "en", { sensitivity: "base" }); }
