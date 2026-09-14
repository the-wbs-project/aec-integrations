/**
 * The house email layout — the shared shell every transactional email renders into.
 *
 * WHY THIS EXISTS. Until now there were three unrelated email styles in the repo and
 * none of them agreed on a colour: `toHtml()` in `lib/email.ts` (a bare `<body>` of
 * `<p>` tags at `#27272a`, which is not a design token), the private card in
 * `lib/analytics-digest.ts` (its own `#2e4a3d` accent), and `docs/email-templates/
 * magic-link.html` (the only one built to DESIGN.md tokens, and the only one NOT sent
 * by `lib/email.ts`). This module is the magic-link design, ported to TypeScript so a
 * send can actually use it.
 *
 * TWIN FILE. `docs/email-templates/magic-link.html` is the Supabase/GoTrue sign-in
 * template. It is pasted into the Supabase dashboard and is never read at runtime, so
 * it cannot import this module — the two are hand-kept twins. **Change the shell here
 * and you change it there in the same PR**, or the sign-in email drifts from every
 * other email. `docs/email.md` (§House layout) is the contract.
 *
 * EMAIL-HTML CONSTRAINTS (why this looks like 2005): tables not flex/grid, inline
 * styles not classes, and a VML fallback so the button renders in Outlook for Windows.
 * No webfont — DESIGN.md's Source Serif 4 / Atkinson Hyperlegible Next do not survive
 * email clients, so the system stack stands in.
 *
 * COPY RULES (PRODUCT.md): product register, sentence case, no em dashes, no hyperbole.
 * There is deliberately NO "The AEC Integrations team" sign-off: the footer wordmark
 * names the sender, which is what the sign-off was for.
 *
 * Colours are DESIGN.md tokens: Forest #1E3A2F (the logo band and the CTA, per the
 * Forest-Anchor Rule), Bone #F5F2EA (on Forest), text-primary #0A0A0A,
 * text-secondary #52525B, text-tertiary #71717A, surface-sunken #F4F4F5,
 * border-strong #D4D4D8.
 */

/**
 * The logo banner, at a HARDCODED production URL rather than one derived from
 * `PUBLIC_SITE_URL`.
 *
 * Two reasons, and both are load-bearing. Non-production tiers sit behind Cloudflare
 * Access (`docs/access.md`), so a staging-derived URL would 403 in the recipient's mail
 * client and show nothing. And a mail client fetches this months after the send, from a
 * network that knows nothing about which tier produced it.
 *
 * PNG, not SVG: Outlook and Gmail do not render SVG at all, which is why the served
 * `monogram-light.svg` is unusable here.
 *
 * **The PNG has a TRANSPARENT background, and that is load-bearing (AECI-924).** It
 * shipped opaque, carrying its own Forest fill, and the header rendered as two
 * different greens in any client that applies a dark-mode transform: the client shifts
 * the `<td>`'s CSS `#1E3A2F` (measured: to `#334D42`) and cannot touch pixels inside an
 * image, so the logo sat in a visibly darker rectangle. `color-scheme: light only` below
 * is a hint those clients ignore. With alpha, whatever the band becomes shows through
 * and there is no seam to have. Keep any replacement transparent; a re-export with a
 * baked background brings the two-tone header straight back.
 *
 * The asset is `apps/web/public/branding/email-logo-banner.png`. It only resolves once
 * that build reaches production; until then the band degrades to its alt text, and the
 * wordmark row below it still names the sender. Renaming or moving that file breaks the
 * header of every email already in someone's inbox.
 */
export const EMAIL_LOGO_URL = 'https://www.aecintegrations.com/branding/email-logo-banner.png';

/** Source is 1120x182; 300x49 is the same ratio at a display size the card can hold. */
const LOGO_WIDTH = 300;
const LOGO_HEIGHT = 49;

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** The single Forest call to action. One per email, per the Forest-Anchor Rule. */
export interface EmailCta {
  /** Sentence case, no trailing punctuation. */
  label: string;
  /** Absolute URL. Also rendered as paste-able text beneath the button. */
  url: string;
}

/**
 * One `Key: value` row of a detail table.
 *
 * Both halves are plain strings and both are escaped by the renderer, because every
 * operator alert that uses this carries submitter-supplied text (name, role, email).
 */
export type EmailTableRow = readonly [label: string, value: string];

/** One headed group of rows, for an alert that is about N things rather than one. */
export interface EmailSection {
  /** Names the thing this group describes. Escaped by the renderer. */
  heading: string;
  rows: readonly EmailTableRow[];
}

export interface EmailLayout {
  /** Inbox preview line. Hidden in the body, shown in the client's message list. */
  preheader: string;
  /** The headline. Sentence case, no em dash. */
  heading: string;
  /** Body paragraphs. HTML for `renderEmailHtml`, plain text for `renderEmailText`. */
  blocks: string[];
  /**
   * An optional detail table, rendered after the blocks and before the CTA.
   *
   * This is what lets an OPERATOR alert use the house shell (AECI-924). Those emails
   * are a dozen labelled facts for one reader, not prose, and before this the layout
   * could only carry them as sentences — which is why they stayed on the unbranded
   * `opsTable()` when `claim-approved` migrated.
   */
  table?: readonly EmailTableRow[];
  /**
   * The same detail table, repeated under a heading per item.
   *
   * For the digest-shaped alerts that report N stuck rows rather than one event. Set
   * `table` OR `sections`, never both: they occupy the same slot and the renderer draws
   * `table` first, so setting both reads as two unrelated tables stacked.
   */
  sections?: readonly EmailSection[];
  /** Omitted when there is no link to offer (e.g. `PUBLIC_SITE_URL` is unset). */
  cta?: EmailCta;
  /** Small print below the hairline rule. */
  note?: string;
}

/**
 * Escape a value for interpolation into email HTML.
 *
 * Lives here rather than in `lib/email.ts` because the layout is what interpolates.
 * `email.ts` re-imports it, so its existing call sites are unchanged.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The plain-text half. Heading, blocks, the CTA as a labelled URL, then the note.
 *
 * The CTA's URL is spelled out because a text/plain part has no other way to carry it,
 * and because some recipients read only this part.
 */
export function renderEmailText(layout: EmailLayout): string {
  const parts = [layout.heading, ...layout.blocks];
  // One `Key: value` per line, in one paragraph, which is the shape every operator
  // already reads these in. `opsText()` produced exactly this, so a migrated template's
  // text part is unchanged and the specs that assert on it still hold.
  if (layout.table?.length) parts.push(layout.table.map(([k, v]) => `${k}: ${v}`).join('\n'));
  // Sections keep `opsSectionsText`'s two-space indent under each heading, which is
  // what makes a multi-row alert scannable in a plain-text client.
  for (const section of layout.sections ?? []) {
    parts.push(`${section.heading}\n${section.rows.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`);
  }
  if (layout.cta) parts.push(`${layout.cta.label}: ${layout.cta.url}`);
  if (layout.note) parts.push(layout.note);
  return parts.join('\n\n');
}

/**
 * The HTML half. Caller-supplied `blocks` are trusted as HTML (they carry `<strong>`
 * and `<a>`), so a caller escapes its own interpolations; `heading`, `table`, the CTA
 * and `note` are escaped here because they are always plain strings.
 */
export function renderEmailHtml(layout: EmailLayout): string {
  const rows = [
    logoBand(),
    wordmarkRow(),
    headingRow(layout.heading),
    // The first block sits tighter to the heading than the ones after it, matching the
    // twin (which only ever has one block, at 12px).
    ...layout.blocks.map((html, i) => blockRow(html, i === 0)),
    ...(layout.table?.length ? [tableRow(layout.table)] : []),
    ...(layout.sections ?? []).map(sectionRow),
    ...(layout.cta ? [ctaRow(layout.cta), pasteableUrlRow(layout.cta.url)] : []),
    ...(layout.note ? [hairlineRow(), noteRow(layout.note)] : [spacerRow()]),
  ].join('');

  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    // Light only, matching the Stage 1 app rule (AECI-226). A hint, not a guarantee:
    // some clients still auto-invert, which the near-black/white palette survives.
    `<meta name="color-scheme" content="light only" />` +
    `<meta name="supported-color-schemes" content="light only" />` +
    `<title>${escapeHtml(layout.heading)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background-color:#f4f4f5;-webkit-font-smoothing:antialiased">` +
    preheader(layout.preheader) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5">` +
    `<tr><td align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #d4d4d8;border-radius:6px;overflow:hidden">` +
    rows +
    `</table>` +
    footer() +
    `</td></tr></table></body></html>`
  );
}

// ─── Rows ──────────────────────────────────────────────────────────────────────

/** Inbox preview line. Hidden in the body, shown in the client's message list. */
function preheader(text: string): string {
  return (
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#f4f4f5">` +
    `${escapeHtml(text)}</div>`
  );
}

/**
 * The Forest logo band. The `<td>` carries the Forest fill and Bone type styling so
 * that a client with images off renders the alt text legibly inside the band rather
 * than as a broken-image icon on nothing.
 */
function logoBand(): string {
  return (
    `<tr><td bgcolor="#1e3a2f" style="background-color:#1e3a2f;padding:24px 32px;font-family:${FONT};font-size:16px;font-weight:600;letter-spacing:0.01em;color:#f5f2ea">` +
    `<img src="${EMAIL_LOGO_URL}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="AEC Integrations" ` +
    `style="display:block;border:0;outline:none;text-decoration:none;width:${LOGO_WIDTH}px;height:auto;max-width:100%" />` +
    `</td></tr>`
  );
}

/**
 * The text wordmark, beneath the band. Redundant when images load, and the whole point
 * when they do not: an email that never names its sender in text reads as phishing, and
 * this audience sits behind aggressive corporate mail security that blocks images.
 */
function wordmarkRow(): string {
  return (
    `<tr><td style="padding:28px 32px 0 32px;font-family:${FONT};font-size:14px;font-weight:600;letter-spacing:0.01em;color:#1e3a2f">` +
    `AEC Integrations</td></tr>`
  );
}

function headingRow(heading: string): string {
  return (
    `<tr><td style="padding:20px 32px 0 32px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:600;color:#0a0a0a">` +
    `${escapeHtml(heading)}</td></tr>`
  );
}

function blockRow(html: string, first: boolean): string {
  return (
    `<tr><td style="padding:${first ? 12 : 16}px 32px 0 32px;font-family:${FONT};font-size:15px;line-height:1.6;color:#52525b">` +
    `${html}</td></tr>`
  );
}

/**
 * The detail table: one labelled fact per row, hairline-separated, no outer box.
 *
 * Deliberately NOT the `border="1"` grid `opsTable()` drew. That grid is the 1990s
 * default browsers render when nothing styles a table, and it is the single element
 * that made these alerts look unlike the product. Hairlines at `#D4D4D8` are the same
 * rule the card border and the `note` divider already use.
 *
 * Two columns rather than a stacked label/value pair because the reader scans the label
 * column to find one fact. `width="35%"` on the label and `valign="top"` on both keep
 * that column straight when a value wraps, which several of these do (a LinkedIn URL, a
 * Linear permalink). The percentage is not a pixel count precisely so the table survives
 * the phone width the support inbox is usually read at.
 *
 * A value that is an absolute `https://` URL renders as a link. The alternative is an
 * operator copy-pasting a Linear permalink out of an email by hand, and some clients
 * auto-link it anyway but in their own colour.
 */
function tableRow(rows: readonly EmailTableRow[]): string {
  return `<tr><td style="padding:20px 32px 0 32px">` + detailTable(rows) + `</td></tr>`;
}

/** The two-column grid itself, shared by the flat `table` and each `sections` group. */
function detailTable(rows: readonly EmailTableRow[]): string {
  const cells = rows
    .map(([label, value], i) => {
      const top = i === 0 ? '' : 'border-top:1px solid #d4d4d8;';
      const pad = i === 0 ? 0 : 10;
      return (
        `<tr>` +
        `<td valign="top" width="35%" style="padding:${pad}px 12px 10px 0;${top}font-family:${FONT};font-size:13px;line-height:1.5;color:#71717a">` +
        `${escapeHtml(label)}</td>` +
        `<td valign="top" style="padding:${pad}px 0 10px 0;${top}font-family:${FONT};font-size:14px;line-height:1.5;color:#0a0a0a;word-break:break-word">` +
        `${tableValue(value)}</td>` +
        `</tr>`
      );
    })
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cells}</table>`;
}

/**
 * One headed group, for the digest-shaped alerts.
 *
 * The heading is `#0A0A0A` at 15px/600, one step down from the email's own 22px
 * heading, so the hierarchy reads as "one alert, N items" rather than N emails glued
 * together. Groups after the first carry the top padding that separates them; the
 * first sits at the same 20px the flat table does, so a one-item alert is
 * indistinguishable from a flat one.
 */
function sectionRow(section: EmailSection, i: number): string {
  return (
    `<tr><td style="padding:${i === 0 ? 20 : 28}px 32px 0 32px">` +
    `<div style="font-family:${FONT};font-size:15px;line-height:1.4;font-weight:600;color:#0a0a0a;padding-bottom:10px">${escapeHtml(section.heading)}</div>` +
    detailTable(section.rows) +
    `</td></tr>`
  );
}

/** Escaped always; linked only when the whole value is an absolute `https://` URL, so
 *  a sentence that merely mentions one is never half-linked. */
function tableValue(value: string): string {
  const safe = escapeHtml(value);
  if (!/^https:\/\/\S+$/.test(value)) return safe;
  return `<a href="${safe}" style="color:#1e3a2f;text-decoration:underline">${safe}</a>`;
}

/** Forest fill, white label, plus the VML twin Outlook for Windows needs. */
function ctaRow(cta: EmailCta): string {
  const href = escapeHtml(cta.url);
  const label = escapeHtml(cta.label);
  return (
    `<tr><td align="left" style="padding:24px 32px 0 32px">` +
    `<!--[if mso]>` +
    `<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" ` +
    `href="${href}" style="height:44px;v-text-anchor:middle;width:220px" arcsize="14%" stroke="f" fillcolor="#1E3A2F">` +
    `<w:anchorlock /><center style="color:#ffffff;font-family:Segoe UI,Arial,sans-serif;font-size:15px;font-weight:600">${label}</center>` +
    `</v:roundrect>` +
    `<![endif]-->` +
    `<!--[if !mso]><!-- -->` +
    `<a href="${href}" style="display:inline-block;background-color:#1e3a2f;color:#ffffff;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;text-decoration:none;padding:15px 32px;border-radius:6px">${label}</a>` +
    `<!--<![endif]-->` +
    `</td></tr>`
  );
}

/**
 * The button's URL, spelled out. Corporate gateways rewrite or strip buttons routinely,
 * and some clients drop them entirely; this is the escape hatch.
 */
function pasteableUrlRow(url: string): string {
  const safe = escapeHtml(url);
  return (
    `<tr><td style="padding:24px 32px 0 32px;font-family:${FONT};font-size:13px;line-height:1.6;color:#71717a">` +
    `Or paste this into your browser:` +
    `<div style="margin-top:8px;padding:12px;background-color:#f4f4f5;border:1px solid #d4d4d8;border-radius:4px;font-size:12px;line-height:1.5;color:#52525b;word-break:break-all">${safe}</div>` +
    `</td></tr>`
  );
}

function hairlineRow(): string {
  return (
    `<tr><td style="padding:24px 32px 0 32px">` +
    `<div style="height:1px;background-color:#d4d4d8;line-height:1px">&nbsp;</div>` +
    `</td></tr>`
  );
}

function noteRow(note: string): string {
  return (
    `<tr><td style="padding:20px 32px 32px 32px;font-family:${FONT};font-size:13px;line-height:1.6;color:#71717a">` +
    `${escapeHtml(note)}</td></tr>`
  );
}

/** Closes the card when there is no note, so the last block is not flush to the border. */
function spacerRow(): string {
  return `<tr><td style="padding:0 32px 32px 32px;font-size:0;line-height:0">&nbsp;</td></tr>`;
}

function footer(): string {
  return (
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">` +
    `<tr><td align="center" style="padding:20px 32px 0 32px;font-family:${FONT};font-size:12px;line-height:1.5;color:#71717a">` +
    `AEC Integrations</td></tr></table>`
  );
}
