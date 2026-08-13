/**
 * Daily operator analytics digest (AECI-526).
 *
 * A queue-less daily cron (`scheduled.ts` `runAnalyticsDigestJob`) summarizes the
 * prior UTC day's site activity and emails it to the operator. Two layers, mirroring
 * the §23.1 data-quality digest split (`data-quality.ts` collects, `data-quality-email.ts`
 * formats):
 *
 *   - `collectAnalyticsMetrics(db, window)` — the read-only D1 aggregation.
 *   - `buildAnalyticsDigest(metrics, opts)` — a pure formatter → `{ subject, text, html }`.
 *
 * Human vs. bot (AECI-526 follow-up): the digest's headline "Page views" and "Most
 * viewed products" report HUMANS ONLY (`is_bot IS NOT 1`), and a "Crawler activity"
 * section lists every bot/crawler and its crawl count for the day (`is_bot = 1`,
 * grouped by `bot_name`). The `is_bot` / `bot_name` classification is written at
 * ingest by `lib/bot-classification.ts` (`page_views` route). Rows captured before
 * that column existed have `is_bot = NULL` and read as human until the one-time ASN
 * backfill runs — a safe degradation (matches the pre-split behavior) rather than
 * silently dropping rows.
 *
 * Every count is a report-only read (no `audit_log` row, no mutation — `page_views`
 * is analytics, not domain state). The day window is **UTC**: Cloudflare cron is
 * UTC-only / DST-unaware (see `scheduled.ts`), so bucketing the day in UTC avoids a
 * DST off-by-one; the email labels the window as UTC. Sources:
 *   - human page views + top products: `page_views` where `is_bot IS NOT 1`.
 *   - crawler activity: `page_views` where `is_bot = 1`, grouped by `bot_name`.
 *   - new users: `profiles.created_at` (a profile row is created on first sign-in).
 *   - total users: cumulative `COUNT(profiles)`.
 *   - pending moderation: `reviews` where `status='pending'` (a live snapshot).
 */

import { and, count, desc, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViews, products, profiles, reviews } from '../db/schema';

/** A single UTC-day window plus the immediately-preceding day (for day-over-day deltas). */
export interface DigestWindow {
  /** Inclusive start of the reported day (ISO 8601, UTC midnight). */
  startIso: string;
  /** Exclusive end of the reported day (== start of "today", UTC midnight). */
  endIso: string;
  /** Inclusive start of the prior day (== `startIso` − 24h) for the delta baseline. */
  priorStartIso: string;
  /** Human label for the reported day, e.g. `2026-07-23` (UTC). */
  dayLabel: string;
}

const DAY = 86_400_000;

/**
 * The window for an arbitrary UTC day, `YYYY-MM-DD`. Factored out of
 * {@link dailyWindows} so the admin panel can report any single day through the
 * exact same window arithmetic the 05:00 email uses — "identical to that day's
 * digest" is an AECI-574 acceptance criterion, and a second copy of this
 * arithmetic is precisely how the two would drift apart.
 */
export function windowsForDay(dayLabel: string): DigestWindow {
  const startDay = Date.parse(`${dayLabel}T00:00:00.000Z`);
  return {
    startIso: new Date(startDay).toISOString(),
    endIso: new Date(startDay + DAY).toISOString(),
    priorStartIso: new Date(startDay - DAY).toISOString(),
    dayLabel,
  };
}

/**
 * The prior *complete* UTC day relative to `now`, plus the day before it (delta
 * baseline). Run at ~05:00 UTC (noon Jakarta), this reports a full, already-closed calendar day —
 * never a partial one. ISO-8601 `text` timestamps sort lexicographically the same as
 * chronologically, so the `gte`/`lt` string range on `created_at` is exact.
 */
export function dailyWindows(now: Date): DigestWindow {
  const startToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return windowsForDay(new Date(startToday - DAY).toISOString().slice(0, 10));
}

/** A product and its human view count in the reported window. */
export interface TopProduct {
  name: string;
  slug: string;
  views: number;
}

/** One bot/crawler and how many page views (crawls) it made in the reported day. */
export interface BotActivity {
  name: string;
  crawls: number;
}

/** A human traffic source (e.g. LinkedIn, Google, Direct) and its view count. */
export interface ReferrerCount {
  source: string;
  views: number;
}

/** A count for the reported day and the day before (for the delta). */
export interface DailyCount {
  day: number;
  prior: number;
}

export interface AnalyticsMetrics {
  /** HUMAN page views (`is_bot IS NOT 1`) in the reported day / prior day. */
  pageViews: DailyCount;
  /** Bot/crawler page views (`is_bot = 1`) in the reported day / prior day. */
  botPageViews: DailyCount;
  /** New accounts (profiles created) in the reported day / prior day. */
  newUsers: DailyCount;
  /** Cumulative registered users as of the run. */
  totalUsers: number;
  /** Reviews currently awaiting moderation (a live snapshot, not windowed). */
  pendingModeration: number;
  /** Top products by HUMAN views in the reported day (up to 5; empty when none). */
  topProducts: TopProduct[];
  /** HUMAN traffic sources in the reported day (LinkedIn/Google/Direct/…), most first. */
  referrers: ReferrerCount[];
  /** Every bot/crawler active in the reported day, most crawls first. */
  botActivity: BotActivity[];
}

const TOP_PRODUCTS_LIMIT = 5;

/**
 * A row is "human" when it isn't flagged as a bot. `is_bot IS NOT 1` (NULL-safe) so
 * pre-classification rows (`is_bot = NULL`) count as human, not vanish.
 *
 * Exported because the admin panel (AECI-574) reads the SAME population — sharing
 * the predicate is what makes "the screen and the 05:00 email cannot disagree"
 * structural rather than a convention someone has to remember. The panel also
 * surfaces the resulting bias as a `bot_classification_incomplete` note.
 */
export const HUMAN = or(isNull(pageViews.isBot), eq(pageViews.isBot, false));
export const BOT = eq(pageViews.isBot, true);

/** `COUNT(*)` of human or bot `page_views` in `[startIso, endIso)`. */
async function countPageViews(
  db: Db,
  startIso: string,
  endIso: string,
  kind: 'human' | 'bot',
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
        kind === 'bot' ? BOT : HUMAN,
      ),
    );
  return row?.value ?? 0;
}

/** `COUNT(*)` of `profiles` created in `[startIso, endIso)` — new sign-ins. */
async function countNewProfiles(db: Db, startIso: string, endIso: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(profiles)
    .where(and(gte(profiles.createdAt, startIso), lt(profiles.createdAt, endIso)));
  return row?.value ?? 0;
}

/** Top products by HUMAN `page_views` in `[startIso, endIso)`, joined to `products`. */
async function topProductsByViews(db: Db, startIso: string, endIso: string): Promise<TopProduct[]> {
  const rows = await db
    .select({ name: products.name, slug: products.slug, views: count() })
    .from(pageViews)
    .innerJoin(products, eq(pageViews.productId, products.id))
    .where(
      and(
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
        isNotNull(pageViews.productId),
        HUMAN,
      ),
    )
    .groupBy(products.id)
    .orderBy(desc(count()))
    .limit(TOP_PRODUCTS_LIMIT);
  return rows.map((r) => ({ name: r.name, slug: r.slug, views: r.views }));
}

/** HUMAN traffic sources in `[startIso, endIso)`, grouped by `referrer_source`, most
 *  first. Rows captured before the referrer classifier shipped have a NULL
 *  `referrer_source` and are excluded (there's nothing to attribute). */
async function referrerBreakdown(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<ReferrerCount[]> {
  const rows = await db
    .select({ source: pageViews.referrerSource, views: count() })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
        HUMAN,
        isNotNull(pageViews.referrerSource),
      ),
    )
    .groupBy(pageViews.referrerSource)
    .orderBy(desc(count()));
  return rows.map((r) => ({ source: r.source ?? 'Direct', views: r.views }));
}

/** Every bot/crawler active in `[startIso, endIso)`, grouped by `bot_name`, most
 *  crawls first. A NULL `bot_name` (shouldn't occur for `is_bot = 1`) falls back to
 *  "Other bot" so the grouping stays labelled. */
async function botActivityInWindow(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<BotActivity[]> {
  const rows = await db
    .select({ name: pageViews.botName, crawls: count() })
    .from(pageViews)
    .where(and(gte(pageViews.createdAt, startIso), lt(pageViews.createdAt, endIso), BOT))
    .groupBy(pageViews.botName)
    .orderBy(desc(count()));
  return rows.map((r) => ({ name: r.name ?? 'Other bot', crawls: r.crawls }));
}

/** Run every read for the digest concurrently. Report-only; never mutates. */
export async function collectAnalyticsMetrics(
  db: Db,
  window: DigestWindow,
): Promise<AnalyticsMetrics> {
  const [
    humanViewsDay,
    humanViewsPrior,
    botViewsDay,
    botViewsPrior,
    newUsersDay,
    newUsersPrior,
    totalUsersRows,
    pendingRows,
    topProducts,
    referrers,
    botActivity,
  ] = await Promise.all([
    countPageViews(db, window.startIso, window.endIso, 'human'),
    countPageViews(db, window.priorStartIso, window.startIso, 'human'),
    countPageViews(db, window.startIso, window.endIso, 'bot'),
    countPageViews(db, window.priorStartIso, window.startIso, 'bot'),
    countNewProfiles(db, window.startIso, window.endIso),
    countNewProfiles(db, window.priorStartIso, window.startIso),
    db.select({ value: count() }).from(profiles),
    db.select({ value: count() }).from(reviews).where(eq(reviews.status, 'pending')),
    topProductsByViews(db, window.startIso, window.endIso),
    referrerBreakdown(db, window.startIso, window.endIso),
    botActivityInWindow(db, window.startIso, window.endIso),
  ]);
  return {
    pageViews: { day: humanViewsDay, prior: humanViewsPrior },
    botPageViews: { day: botViewsDay, prior: botViewsPrior },
    newUsers: { day: newUsersDay, prior: newUsersPrior },
    totalUsers: totalUsersRows[0]?.value ?? 0,
    pendingModeration: pendingRows[0]?.value ?? 0,
    topProducts,
    referrers,
    botActivity,
  };
}

// ─── Pure formatter ──────────────────────────────────────────────────────────────

export interface AnalyticsDigestOptions {
  /** Deployment env label for the subject + header (e.g. `production`). */
  env: string;
  /** The reported UTC day, e.g. `2026-07-23` (from `DigestWindow.dayLabel`). */
  dayLabel: string;
  /** When the run completed — rendered into the header. */
  generatedAt: Date;
}

export interface EmailDigest {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plural(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? '' : 's'}`;
}

/** The arithmetic behind {@link deltaText}, as structured data. */
export interface Delta {
  current: number;
  prior: number;
  /** `current - prior`. */
  diff: number;
  /** Rounded percentage change, or `null` when `prior` is 0 — a percentage
   *  against zero is meaningless, so the digest omits it in exactly that case. */
  pct: number | null;
}

/**
 * Period-over-period delta. Extracted from {@link deltaText} so the admin panel
 * (AECI-574) can return the SAME numbers as structured JSON: the panel must
 * localize its own prose (CLAUDE.md's i18n rule is unconditional), but it must
 * not re-derive the semantics — "identical to that day's digest email" is an
 * acceptance criterion, and sharing this function is what makes it true by
 * construction rather than by inspection.
 */
export function computeDelta(c: DailyCount): Delta {
  const diff = c.day - c.prior;
  // `|| 0` normalizes the `-0` that `Math.sign(-1) * 0` produces for a change too
  // small to round to a whole percent — `-0` serializes as `0` but fails a strict
  // `Object.is` assertion, which is exactly the kind of ghost a parity spec should
  // not have to chase.
  const pct =
    c.prior > 0 ? Math.round((Math.abs(diff) / c.prior) * 100) * Math.sign(diff) || 0 : null;
  return { current: c.day, prior: c.prior, diff, pct };
}

/** Human day-over-day delta, e.g. `+8 (+18%) vs 45 prior day`, `-3 (-7%) vs 45 prior
 *  day`, or `no change vs prior day`. Percentages are omitted when the prior day was 0
 *  (division would be meaningless). ASCII only, so it renders cleanly in plain text. */
function deltaText(c: DailyCount): string {
  const { diff, pct } = computeDelta(c);
  if (diff === 0) return 'no change vs prior day';
  const magnitude = Math.abs(diff);
  const sign = diff > 0 ? '+' : '-';
  const pctText = pct === null ? '' : ` (${sign}${Math.abs(pct)}%)`;
  return `${sign}${magnitude}${pctText} vs ${c.prior} prior day`;
}

export function buildAnalyticsDigest(
  metrics: AnalyticsMetrics,
  opts: AnalyticsDigestOptions,
): EmailDigest {
  return {
    subject: buildSubject(metrics, opts),
    text: buildText(metrics, opts),
    html: buildHtml(metrics, opts),
  };
}

function buildSubject(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string {
  const { pageViews: pv, botPageViews: bot, newUsers, topProducts } = metrics;
  const topName = topProducts[0]?.name;
  return (
    `AECi daily digest (${opts.env}) — ${opts.dayLabel}: ` +
    `${plural(pv.day, 'human view')}, ${plural(newUsers.day, 'new user')}` +
    (topName ? ` · top: ${topName}` : '') +
    (bot.day > 0 ? ` · ${plural(bot.day, 'crawl')}` : '')
  );
}

// ── plain text ──

function buildText(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string {
  const { pageViews: pv, botPageViews: bot, newUsers, totalUsers, pendingModeration } = metrics;
  const { topProducts, referrers, botActivity } = metrics;

  const t: string[] = [
    'AECi daily analytics digest',
    `Environment: ${opts.env}`,
    `Day (UTC): ${opts.dayLabel}`,
    `Generated: ${opts.generatedAt.toISOString()}`,
    '',
    '== Traffic (humans) ==',
    `Page views: ${pv.day} (${deltaText(pv)})`,
  ];
  if (bot.day > 0) {
    t.push(
      `  (${bot.day} bot/crawler view${bot.day === 1 ? '' : 's'} excluded — see Crawler activity)`,
    );
  }
  if (topProducts.length > 0) {
    t.push('', 'Most viewed products:');
    topProducts.forEach((p, i) =>
      t.push(`  ${i + 1}. ${p.name} — ${plural(p.views, 'view')} (/${p.slug})`),
    );
  } else {
    t.push('Most viewed product: (no human product page views)');
  }

  t.push('', '== Traffic sources (humans) ==');
  if (referrers.length > 0) {
    referrers.forEach((r, i) => t.push(`  ${i + 1}. ${r.source} — ${plural(r.views, 'view')}`));
  } else {
    t.push('(no referrer data yet)');
  }

  t.push(
    '',
    '== Sign-ins ==',
    `New sign-ins (new accounts): ${newUsers.day} (${deltaText(newUsers)})`,
    `Total sign-ins (registered users): ${totalUsers}`,
    '',
    '== Moderation ==',
    pendingModeration > 0
      ? `Reviews awaiting moderation: ${pendingModeration} — see /admin/reviews`
      : 'Reviews awaiting moderation: 0',
    '',
    '== Crawler activity ==',
  );
  if (botActivity.length > 0) {
    t.push(
      `Bot/crawler page views: ${bot.day} (${deltaText(bot)}) from ${plural(botActivity.length, 'source')}`,
    );
    botActivity.forEach((b, i) => t.push(`  ${i + 1}. ${b.name} — ${plural(b.crawls, 'crawl')}`));
  } else {
    t.push('No bot/crawler activity.');
  }

  t.push(
    '',
    'Human vs. bot is classified at capture from User-Agent + network (ASN) — a maintained heuristic, not exact.',
    'Traffic sources come from the Referer header (best-effort — privacy tools strip it, so external sources are under-counted; stripped arrivals fall into Direct).',
    'Report-only: counts are read from the app database; the window is the full prior UTC day.',
  );
  return t.join('\n');
}

// ── html ──

const HTML = {
  ink: '#27272a',
  muted: '#71717a',
  border: '#e4e4e7',
  accent: '#2e4a3d',
  accentSoft: '#eef2f0',
  danger: '#b91c1c',
  pageBg: '#f4f4f5',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function sectionTitle(label: string): string {
  return `<h3 style="margin:28px 0 10px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${HTML.accent}">${escapeHtml(label)}</h3>`;
}

/** A big primary number with a caption + a muted delta line beneath. */
function primaryStat(value: number, caption: string, delta: string): string {
  return (
    `<div style="margin:0 0 2px"><span style="font-size:34px;font-weight:700;color:${HTML.ink};line-height:1">${value}</span>` +
    ` <span style="font-size:14px;color:${HTML.muted}">${escapeHtml(caption)}</span></div>` +
    `<div style="font-size:13px;color:${HTML.muted}">${escapeHtml(delta)}</div>`
  );
}

/** A label:value row for the compact key/value tables (sign-ins, moderation). */
function kvRow(label: string, value: string, emphasize = false): string {
  const valColor = emphasize ? HTML.danger : HTML.ink;
  return (
    `<tr><td style="padding:7px 0;color:${HTML.muted};font-size:14px">${escapeHtml(label)}</td>` +
    `<td style="padding:7px 0;text-align:right;color:${valColor};font-weight:600;font-size:14px">${value}</td></tr>`
  );
}

function kvTable(rows: string[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows.join('')}</table>`;
}

/** A ranked data table: `#`, a left label, and a right-aligned count. */
function rankTable(
  labelHead: string,
  countHead: string,
  rows: ReadonlyArray<{ label: string; count: number }>,
): string {
  const th = `padding:6px 0;border-bottom:2px solid ${HTML.border};color:${HTML.muted};font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em`;
  const body = rows
    .map((r, i) => {
      const td = `padding:9px 0;border-bottom:1px solid ${HTML.border}`;
      return (
        `<tr><td style="${td};color:${HTML.muted};width:28px">${i + 1}</td>` +
        `<td style="${td};padding-left:8px;color:${HTML.ink}">${r.label}</td>` +
        `<td style="${td};text-align:right;color:${HTML.ink};font-weight:600">${r.count}</td></tr>`
      );
    })
    .join('');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">` +
    `<thead><tr><th style="${th};text-align:left;width:28px">#</th>` +
    `<th style="${th};text-align:left;padding-left:8px">${escapeHtml(labelHead)}</th>` +
    `<th style="${th};text-align:right">${escapeHtml(countHead)}</th></tr></thead>` +
    `<tbody>${body}</tbody></table>`
  );
}

function emptyNote(text: string): string {
  return `<p style="margin:8px 0 0;font-size:14px;color:${HTML.muted}">${escapeHtml(text)}</p>`;
}

function buildHtml(metrics: AnalyticsMetrics, opts: AnalyticsDigestOptions): string {
  const { pageViews: pv, botPageViews: bot, newUsers, totalUsers, pendingModeration } = metrics;
  const { topProducts, referrers, botActivity } = metrics;

  const header =
    `<div style="border-top:4px solid ${HTML.accent};background:${HTML.accentSoft};padding:20px 24px">` +
    `<div style="font-size:18px;font-weight:700;color:${HTML.ink}">AECi daily analytics digest</div>` +
    `<div style="margin-top:6px;font-size:13px;color:${HTML.muted}">` +
    `<span style="display:inline-block;background:${HTML.accent};color:#fff;border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600;letter-spacing:.03em">${escapeHtml(opts.env)}</span>` +
    `&nbsp; · &nbsp;${escapeHtml(opts.dayLabel)} (UTC)&nbsp; · &nbsp;generated ${escapeHtml(opts.generatedAt.toISOString())}</div></div>`;

  const traffic =
    sectionTitle('Traffic (humans)') +
    primaryStat(pv.day, pv.day === 1 ? 'human page view' : 'human page views', deltaText(pv)) +
    (bot.day > 0
      ? `<p style="margin:6px 0 0;font-size:13px;color:${HTML.muted}">${bot.day} bot/crawler view${bot.day === 1 ? '' : 's'} excluded — see <strong>Crawler activity</strong> below.</p>`
      : '');

  const productLabel = (p: TopProduct): string =>
    `${escapeHtml(p.name)} <span style="color:${HTML.muted};font-size:12px">/${escapeHtml(p.slug)}</span>`;
  const productsSection =
    sectionTitle('Most viewed products (humans)') +
    (topProducts.length > 0
      ? rankTable(
          'Product',
          'Views',
          topProducts.map((p) => ({ label: productLabel(p), count: p.views })),
        )
      : emptyNote('No human product page views.'));

  const referrersSection =
    sectionTitle('Traffic sources (humans)') +
    (referrers.length > 0
      ? rankTable(
          'Source',
          'Views',
          referrers.map((r) => ({ label: escapeHtml(r.source), count: r.views })),
        )
      : emptyNote('No referrer data yet.'));

  const signIns =
    sectionTitle('Sign-ins') +
    kvTable([
      kvRow(
        'New sign-ins (new accounts)',
        `${newUsers.day} <span style="font-weight:400;color:${HTML.muted}">(${escapeHtml(deltaText(newUsers))})</span>`,
      ),
      kvRow('Total registered users', String(totalUsers)),
    ]);

  const moderation =
    sectionTitle('Moderation') +
    kvTable([
      pendingModeration > 0
        ? kvRow('Reviews awaiting moderation', `${pendingModeration} · /admin/reviews`, true)
        : kvRow('Reviews awaiting moderation', '0'),
    ]);

  const crawlers =
    sectionTitle('Crawler activity') +
    (botActivity.length > 0
      ? `<p style="margin:0 0 8px;font-size:14px;color:${HTML.muted}">${bot.day} bot/crawler page view${bot.day === 1 ? '' : 's'} <span style="color:${HTML.ink}">(${escapeHtml(deltaText(bot))})</span> from ${botActivity.length} source${botActivity.length === 1 ? '' : 's'}.</p>` +
        rankTable(
          'Bot / crawler',
          'Crawls',
          botActivity.map((b) => ({ label: escapeHtml(b.name), count: b.crawls })),
        )
      : emptyNote('No bot/crawler activity.'));

  const footer =
    `Human vs. bot is classified at capture from User-Agent + network (ASN) — a maintained heuristic, not exact. ` +
    `Traffic sources come from the Referer header (best-effort — privacy tools strip it, so external sources are under-counted; stripped arrivals fall into Direct). ` +
    `Report-only: counts are read from the app database; the window is the full prior UTC day.`;

  return (
    `<!doctype html><html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light">` +
    `<title>AECi daily analytics digest — ${escapeHtml(opts.dayLabel)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${HTML.pageBg}">` +
    `<div style="max-width:640px;margin:0 auto;padding:24px 12px">` +
    `<div style="background:#fff;border:1px solid ${HTML.border};border-radius:10px;overflow:hidden;font-family:${FONT};color:${HTML.ink}">` +
    header +
    `<div style="padding:4px 24px 24px">${traffic}${productsSection}${referrersSection}${signIns}${moderation}${crawlers}</div>` +
    `</div>` +
    `<div style="max-width:640px;margin:12px auto 0;padding:0 4px;font-size:12px;line-height:1.5;color:${HTML.muted};font-family:${FONT}">${footer}</div>` +
    `</div></body></html>`
  );
}
