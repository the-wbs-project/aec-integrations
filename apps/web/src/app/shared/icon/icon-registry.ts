/* Lucide notice (ISC, with Feather portions under MIT)
 *
 * Some drawings in this file are derived from Lucide (https://lucide.dev),
 * marked "// Lucide" below. Its licence, verbatim from
 * the Lucide repository (LICENSE file on main).
 * The built app serves the same text at /third-party-notices.txt, from
 * apps/web/public/third-party-notices.txt. Keep the two in step.
 *
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 *
 * ---
 *
 * The following Lucide icons are derived from the Feather project:
 *
 * airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out
 *
 * The MIT License (MIT) (for the icons listed above)
 *
 * Copyright (c) 2013-present Cole Bemis
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * AECI-1753 - the `aec-icon` registry: the one place icon drawings live.
 *
 * Ruling 34 (ADR 0056) replaced "Lucide icons exclusively" with a custom icon
 * set drawn at 1.75 stroke in a 24 x 24 box. Every icon here is a list of
 * shapes, not an SVG string, so the component renders real elements and never
 * needs `innerHTML`.
 *
 * PROVENANCE
 * - Entries with no marker were drawn for the November 2026 mock-ups and are
 *   copied from the `IC` maps in `docs/design/mockups/redesign-2026-11/mockups/`
 *   (the 7 and 8 versions where the pages differ). They are repo-authored.
 * - `// Lucide` marks path data copied from Lucide inlined in the app.
 * - `// Lucide-identical geometry` marks a mock-up drawing that turned out to
 *   match Lucide exactly. Treat it as Lucide for the licence.
 * esbuild strips source comments from the bundle, so the shipped notice is the
 * public file above, not this block. Keep both for as long as any marked entry
 * remains.
 *
 * NAMING
 * An icon is named for what it draws, never for where it is used. The use lives
 * in a map: `DATA_OBJECT_ICONS` and `FACET_ICONS` in `icon-maps.ts`.
 *
 * ADDING AN ICON
 * Add one key (kebab-case, letters and hyphens only) with its shapes, in
 * alphabetical order. The `AecIconName` union follows the keys, so a template
 * that names an icon that is not here fails to compile. Drawings are
 * stroke-only (`fill="none"`, `currentColor`, 1.75): a filled glyph does not
 * belong in this set. Three shape kinds exist: `p` (path), `c` (circle) and
 * `r` (rounded rectangle). Express anything else as a path. A dot is a small
 * `c` shape, because a stroked zero-length path is not reliably round.
 */

/** A path. `d` is the SVG path data. */
interface PathShape {
  readonly k: 'p';
  readonly d: string;
}
/** A circle. */
interface CircleShape {
  readonly k: 'c';
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
}
/** A rectangle with rounded corners. */
interface RectShape {
  readonly k: 'r';
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rx: number;
}

export type IconShape = PathShape | CircleShape | RectShape;

export const AEC_ICONS = {
  'alert-circle': [
    { k: 'c', cx: 12, cy: 12, r: 9 },
    { k: 'p', d: 'M12 7.5v5.5M12 16.5h.01' },
  ],
  'arrow-down': [
    { k: 'p', d: 'M12 5v14' },
    { k: 'p', d: 'm6 13 6 6 6-6' },
  ],
  'arrow-left': [
    { k: 'p', d: 'M19 12H5' },
    { k: 'p', d: 'm12 19-7-7 7-7' },
  ], // Lucide
  'arrow-right': [
    { k: 'p', d: 'M5 12h14' },
    { k: 'p', d: 'm13 6 6 6-6 6' },
  ],
  bell: [
    { k: 'p', d: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z' },
    { k: 'p', d: 'M10 20.5a2 2 0 0 0 4 0' },
  ],
  book: [
    { k: 'p', d: 'M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z' },
    { k: 'p', d: 'M4 20a2 2 0 0 0 2 2h13v-4' },
    { k: 'p', d: 'M9 7.5h6' },
  ],
  building: [
    { k: 'p', d: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16' },
    { k: 'p', d: 'M16 9h2a2 2 0 0 1 2 2v10M2.5 21h19' },
    { k: 'p', d: 'M8 7h4M8 11h4M8 15h4' },
  ],
  calculator: [
    { k: 'r', x: 5, y: 3, w: 14, h: 18, rx: 2.5 },
    {
      k: 'p',
      d: 'M8 7h8M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01M8.5 15h.01M12 15h.01M15.5 15h.01M8.5 18h.01M12 18h3.5',
    },
  ],
  'calendar-lines': [
    { k: 'r', x: 3.5, y: 5, w: 17, h: 15, rx: 2.5 },
    { k: 'p', d: 'M3.5 10h17M8 3v4M16 3v4M7.5 14h5M7.5 17h8' },
  ],
  chart: [
    { k: 'p', d: 'M4 20h16' },
    { k: 'r', x: 6, y: 11, w: 3, h: 7, rx: 1 },
    { k: 'r', x: 11, y: 6, w: 3, h: 12, rx: 1 },
    { k: 'r', x: 16, y: 13, w: 3, h: 5, rx: 1 },
  ],
  'chat-question': [
    { k: 'p', d: 'M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z' },
    { k: 'p', d: 'M10 9.6a2 2 0 1 1 2.9 1.8c-.6.3-.9.8-.9 1.4v.3' },
    { k: 'p', d: 'M12 15.8h.01' },
  ],
  check: [{ k: 'p', d: 'm5 12.5 4.5 4.5L19 7' }],
  checklist: [
    { k: 'r', x: 4, y: 3.5, w: 16, h: 17, rx: 2.5 },
    { k: 'p', d: 'm8 9 1.5 1.5L12 8M8 15l1.5 1.5L12 14M14.5 9.5H17M14.5 15.5H17' },
  ],
  'chevron-down': [{ k: 'p', d: 'm6 9 6 6 6-6' }], // Lucide-identical geometry
  'chevron-left': [{ k: 'p', d: 'm15 18-6-6 6-6' }], // Lucide
  'chevron-right': [{ k: 'p', d: 'm9 18 6-6-6-6' }], // Lucide
  'chevron-up': [{ k: 'p', d: 'm18 15-6-6-6 6' }], // Lucide
  'clasped-hands': [
    { k: 'p', d: 'M3 12.5 7 9l3 1.5L14 8l7 4.5' },
    { k: 'p', d: 'M7 9v6l5 4 5-4' },
    { k: 'p', d: 'm10 14 2 1.5' },
  ],
  clock: [
    { k: 'c', cx: 12, cy: 12, r: 9 },
    { k: 'p', d: 'M12 7v5l3 2' },
  ],
  code: [{ k: 'p', d: 'm8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14' }],
  columns: [
    { k: 'r', x: 3, y: 4, w: 7.5, h: 16, rx: 2 },
    { k: 'r', x: 13.5, y: 4, w: 7.5, h: 16, rx: 2 },
  ],
  compass: [
    { k: 'c', cx: 12, cy: 12, r: 9 },
    { k: 'p', d: 'm15.5 8.5-2 5-5 2 2-5z' },
  ],
  'contact-card': [
    { k: 'r', x: 3, y: 5, w: 18, h: 14, rx: 2.5 },
    { k: 'c', cx: 9, cy: 11, r: 2.3 },
    { k: 'p', d: 'M5.5 16a3.5 3.5 0 0 1 7 0M15 10h3.5M15 13.5h3.5' },
  ],
  'corner-down-right': [
    { k: 'p', d: 'm15 10 5 5-5 5' },
    { k: 'p', d: 'M4 4v7a4 4 0 0 0 4 4h12' },
  ], // Lucide
  cube: [
    { k: 'p', d: 'M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z' },
    { k: 'p', d: 'M4 7.4l8 4.6 8-4.6M12 12v9.2' },
  ],
  download: [
    { k: 'p', d: 'M12 3v12' },
    { k: 'p', d: 'm7 10 5 5 5-5' },
    { k: 'p', d: 'M5 21h14' },
  ], // Lucide
  external: [
    { k: 'p', d: 'M7 17 17 7' },
    { k: 'p', d: 'M8 7h9v9' },
  ],
  eye: [
    { k: 'p', d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z' },
    { k: 'c', cx: 12, cy: 12, r: 3 },
  ],
  'file-swap': [
    { k: 'p', d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' },
    { k: 'p', d: 'M14 3v5h5' },
    { k: 'p', d: 'M9 13.5h6l-2-2M15 17H9l2 2' },
  ],
  flag: [
    { k: 'p', d: 'M5 21V4' },
    { k: 'p', d: 'M5 4h12l-2.5 4L17 12H5' },
  ],
  gantt: [
    { k: 'p', d: 'M4 4v16h16' },
    { k: 'r', x: 7, y: 6.5, w: 7, h: 3, rx: 1.2 },
    { k: 'r', x: 10, y: 11, w: 8, h: 3, rx: 1.2 },
    { k: 'r', x: 8, y: 15.5, w: 5, h: 3, rx: 1.2 },
  ],
  gear: [
    { k: 'c', cx: 12, cy: 12, r: 3 },
    {
      k: 'p',
      d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1',
    },
  ],
  grid: [
    { k: 'r', x: 4, y: 4, w: 7, h: 7, rx: 1.6 },
    { k: 'r', x: 13, y: 4, w: 7, h: 7, rx: 1.6 },
    { k: 'r', x: 4, y: 13, w: 7, h: 7, rx: 1.6 },
    { k: 'r', x: 13, y: 13, w: 7, h: 7, rx: 1.6 },
  ],
  'grid-plus': [
    { k: 'r', x: 3, y: 3, w: 7, h: 7, rx: 1.6 },
    { k: 'r', x: 14, y: 3, w: 7, h: 7, rx: 1.6 },
    { k: 'r', x: 3, y: 14, w: 7, h: 7, rx: 1.6 },
    { k: 'p', d: 'M17.5 14v7M14 17.5h7' },
  ],
  hand: [
    { k: 'p', d: 'M7.5 11.5V6a1.5 1.5 0 0 1 3 0v5' },
    { k: 'p', d: 'M10.5 10V4.5a1.5 1.5 0 0 1 3 0V10' },
    { k: 'p', d: 'M13.5 10V5.5a1.5 1.5 0 0 1 3 0V11' },
    {
      k: 'p',
      d: 'M16.5 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7H12a7 7 0 0 1-5.6-2.8l-2.6-3.4a1.6 1.6 0 0 1 2.5-2l1.2 1.4',
    },
  ],
  handshake: [
    { k: 'p', d: 'm3 11 4-4 4 2 3-2 7 4' },
    { k: 'p', d: 'm7 7 7 7a1.5 1.5 0 0 1-2.1 2.1L8 12.3' },
    { k: 'p', d: 'm11 16 1.5 1.5a1.5 1.5 0 0 0 2.1-2.1M3 11l4 4M21 11l-3.5 3.5' },
  ],
  'hard-hat': [
    { k: 'p', d: 'M3 18.5h18' },
    { k: 'p', d: 'M5 18.5V15a7 7 0 0 1 14 0v3.5' },
    { k: 'p', d: 'M10 8.3V5h4v3.3' },
  ],
  hash: [{ k: 'p', d: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16' }],
  history: [
    { k: 'p', d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' },
    { k: 'p', d: 'M3 3v5h5' },
    { k: 'p', d: 'M12 7v5l4 2' },
  ], // Lucide
  'in-way': [
    { k: 'p', d: 'M20 12H5' },
    { k: 'p', d: 'm10 6-6 6 6 6' },
  ],
  info: [
    { k: 'c', cx: 12, cy: 12, r: 9 },
    { k: 'p', d: 'M12 11v5M12 7.8h.01' },
  ],
  layers: [
    { k: 'p', d: 'M12 3 3 7.5 12 12l9-4.5z' },
    { k: 'p', d: 'm3 12 9 4.5 9-4.5' },
  ],
  'layers-triple': [
    { k: 'p', d: 'M12 3 3 7.5 12 12l9-4.5z' },
    { k: 'p', d: 'm3 12 9 4.5 9-4.5' },
    { k: 'p', d: 'm3 16.5 9 4.5 9-4.5' },
  ],
  link: [
    { k: 'p', d: 'M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1' },
    { k: 'p', d: 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1' },
  ],
  list: [
    { k: 'p', d: 'M9 6h11M9 12h11M9 18h11' },
    { k: 'p', d: 'M4.5 6h.01M4.5 12h.01M4.5 18h.01' },
  ],
  lock: [
    { k: 'r', x: 5, y: 11, w: 14, h: 10, rx: 2 },
    { k: 'p', d: 'M8 11V7a4 4 0 0 1 8 0v4' },
  ], // Lucide
  mail: [
    { k: 'r', x: 3, y: 5, w: 18, h: 14, rx: 2 },
    { k: 'p', d: 'm3 7 9 6 9-6' },
  ], // Lucide
  meh: [
    { k: 'c', cx: 12, cy: 12, r: 9 },
    { k: 'p', d: 'M8.5 15h7M9 9.5h.01M15 9.5h.01' },
  ],
  menu: [{ k: 'p', d: 'M4 7h16M4 12h16M4 17h16' }],
  minus: [{ k: 'p', d: 'M5 12h14' }], // Lucide
  'minus-circle': [
    { k: 'c', cx: 12, cy: 12, r: 9 },
    { k: 'p', d: 'M8 12h8' },
  ],
  'more-vertical': [
    { k: 'c', cx: 12, cy: 5, r: 0.875 },
    { k: 'c', cx: 12, cy: 12, r: 0.875 },
    { k: 'c', cx: 12, cy: 19, r: 0.875 },
  ],
  'nodes-row': [
    { k: 'c', cx: 5, cy: 12, r: 2.2 },
    { k: 'c', cx: 12, cy: 12, r: 2.2 },
    { k: 'c', cx: 19, cy: 12, r: 2.2 },
    { k: 'p', d: 'M7.2 12h2.6M14.2 12h2.6' },
  ],
  'one-way': [
    { k: 'p', d: 'M4 12h15' },
    { k: 'p', d: 'm14 6 6 6-6 6' },
  ],
  'panel-left': [
    { k: 'r', x: 3, y: 3, w: 18, h: 18, rx: 2 },
    { k: 'p', d: 'M9 3v18' },
  ], // Lucide
  pen: [
    { k: 'p', d: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z' },
    { k: 'p', d: 'M14 20h6' },
  ],
  pencil: [
    { k: 'p', d: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z' },
    { k: 'p', d: 'm13.5 6.5 4 4' },
  ],
  'pie-chart': [
    { k: 'p', d: 'M12 3a9 9 0 1 0 9 9h-9z' },
    { k: 'p', d: 'M15 3.5A9 9 0 0 1 20.5 9H15z' },
  ],
  plug: [
    { k: 'p', d: 'M9 3v5M15 3v5' },
    { k: 'p', d: 'M6 8h12v3a6 6 0 0 1-12 0z' },
    { k: 'p', d: 'M12 17v4' },
  ],
  plus: [{ k: 'p', d: 'M12 5v14M5 12h14' }], // Lucide-identical geometry
  puzzle: [
    {
      k: 'p',
      d: 'M10 3.5a2 2 0 0 1 4 0V6h4v4h-1.5a2 2 0 0 0 0 4H18v4.5H6V14h1.5a2 2 0 0 0 0-4H6V6h4z',
    },
  ],
  receipt: [
    { k: 'p', d: 'M6 3h12v18l-3-2-3 2-3-2-3 2z' },
    { k: 'p', d: 'M9 8h6M9 12h6M9 16h3' },
  ],
  refresh: [
    { k: 'p', d: 'M20 11a8 8 0 0 0-14.5-4.5L4 8' },
    { k: 'p', d: 'M4 4v4h4' },
    { k: 'p', d: 'M4 13a8 8 0 0 0 14.5 4.5L20 16' },
    { k: 'p', d: 'M20 20v-4h-4' },
  ],
  reply: [
    { k: 'p', d: 'M9 7 4 12l5 5' },
    { k: 'p', d: 'M4 12h10a6 6 0 0 1 6 6v1' },
  ],
  route: [
    { k: 'c', cx: 6, cy: 18, r: 2.5 },
    { k: 'c', cx: 18, cy: 6, r: 2.5 },
    { k: 'p', d: 'M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5' },
  ],
  rows: [
    { k: 'r', x: 3.5, y: 4, w: 17, h: 4.5, rx: 1.4 },
    { k: 'r', x: 3.5, y: 10, w: 17, h: 4.5, rx: 1.4 },
    { k: 'r', x: 3.5, y: 16, w: 17, h: 4, rx: 1.4 },
  ],
  scale: [
    { k: 'p', d: 'm16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z' },
    { k: 'p', d: 'm2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z' },
    { k: 'p', d: 'M7 21h10' },
    { k: 'p', d: 'M12 3v18' },
    { k: 'p', d: 'M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2' },
  ], // Lucide
  seal: [
    { k: 'c', cx: 12, cy: 9, r: 5.5 },
    { k: 'p', d: 'm8.5 13.3-1.5 7.2 5-2.5 5 2.5-1.5-7.2' },
  ],
  search: [
    { k: 'c', cx: 11, cy: 11, r: 7 },
    { k: 'p', d: 'm20 20-4-4' },
  ],
  'sheet-grid': [
    { k: 'r', x: 3, y: 4, w: 18, h: 16, rx: 2 },
    { k: 'p', d: 'M3 9h18M9 9v11' },
    { k: 'p', d: 'M13 13h4M13 16.5h2.5' },
  ],
  shield: [
    { k: 'p', d: 'M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z' },
    { k: 'p', d: 'm9 12 2 2 4-4' },
  ],
  'shield-half': [
    { k: 'p', d: 'M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z' },
    { k: 'p', d: 'M12 3v18' },
  ],
  sort: [{ k: 'p', d: 'M7 4v16M3.5 16.5 7 20l3.5-3.5M13 6h8M13 11h6M13 16h4' }],
  spinner: [{ k: 'p', d: 'M21 12a9 9 0 1 1-6.219-8.56' }], // Lucide
  star: [
    { k: 'p', d: 'M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z' },
  ],
  stopwatch: [
    { k: 'c', cx: 12, cy: 13, r: 8 },
    { k: 'p', d: 'M12 9v4l2.5 2M9.5 2.5h5' },
  ],
  store: [
    { k: 'p', d: 'M4 9.5 5.5 4h13L20 9.5' },
    { k: 'p', d: 'M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0' },
    { k: 'p', d: 'M5.5 12v8h13v-8M10 20v-5h4v5' },
  ],
  tag: [
    { k: 'p', d: 'M3 12V4h8l10 10-8 8z' },
    { k: 'c', cx: 7.5, cy: 7.5, r: 1.4 },
  ],
  'thumb-down': [
    { k: 'p', d: 'M7 13V4H4v9z' },
    { k: 'p', d: 'M7 13l4 7a2 2 0 0 0 3-2l-1-4h5.5a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 17.3 4H7' },
  ],
  'thumb-up': [
    { k: 'p', d: 'M7 11v9H4v-9z' },
    { k: 'p', d: 'M7 11l4-7a2 2 0 0 1 3 2l-1 4h5.5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.3 20H7' },
  ],
  'two-way': [
    { k: 'p', d: 'M7 8h13l-4-4' },
    { k: 'p', d: 'M17 16H4l4 4' },
  ],
  unlink: [
    { k: 'p', d: 'M9.5 14.5 7.2 16.8a3.3 3.3 0 0 1-4.7-4.7l2.3-2.3' },
    { k: 'p', d: 'M14.5 9.5l2.3-2.3a3.3 3.3 0 0 1 4.7 4.7l-2.3 2.3' },
    { k: 'p', d: 'M8.5 4v2.5M4 8.5h2.5M15.5 20v-2.5M20 15.5h-2.5' },
  ],
  user: [
    { k: 'p', d: 'M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' },
    { k: 'c', cx: 12, cy: 7, r: 4 },
  ], // Lucide
  users: [
    { k: 'c', cx: 9, cy: 8, r: 3.5 },
    { k: 'p', d: 'M2.5 20a6.5 6.5 0 0 1 13 0' },
    { k: 'p', d: 'M16 4.6a3.5 3.5 0 0 1 0 6.8M21.5 20a6.5 6.5 0 0 0-4-6' },
  ],
  verified: [
    {
      k: 'p',
      d: 'm12 2.5 2.3 2 3.1-.3.8 3 2.8 1.6-1.2 2.9 1.2 2.9-2.8 1.6-.8 3-3.1-.3-2.3 2-2.3-2-3.1.3-.8-3-2.8-1.6 1.2-2.9-1.2-2.9 2.8-1.6.8-3 3.1.3z',
    },
    { k: 'p', d: 'm8.7 12 2.3 2.3 4.3-4.6' },
  ],
  warning: [
    { k: 'p', d: 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3' },
    { k: 'p', d: 'M12 9v4' },
    { k: 'p', d: 'M12 17h.01' },
  ], // Lucide
  wrench: [{ k: 'p', d: 'M15 4a5 5 0 0 0-4.7 6.7L4 17v3h3l6.3-6.3A5 5 0 0 0 20 9l-3 1-2-2 1-3z' }],
  x: [{ k: 'p', d: 'M6 6l12 12M18 6 6 18' }],
} as const satisfies Record<string, readonly IconShape[]>;

/** Every registered icon name, derived from the registry keys. */
export type AecIconName = keyof typeof AEC_ICONS;
