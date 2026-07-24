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
 * Every count is a report-only read (no `audit_log` row, no mutation — `page_views`
 * is analytics, not domain state). The day window is **UTC**: Cloudflare cron is
 * UTC-only / DST-unaware (see `scheduled.ts`), so bucketing the day in UTC avoids a
 * DST off-by-one; the email labels the window as UTC. Sources:
 *   - page views + top products: `page_views` (first-party capture, `POST /api/page-views`).
 *   - new users: `profiles.created_at` (a profile row is created on first sign-in).
 *   - total users: cumulative `COUNT(profiles)`.
 *   - pending moderation: `reviews` where `status='pending'` (a live snapshot).
 */

import { and, count, desc, eq, gte, isNotNull, lt } from 'drizzle-orm';

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

/**
 * The prior *complete* UTC day relative to `now`, plus the day before it (delta
 * baseline). Run at ~12:00 UTC, this reports a full, already-closed calendar day —
 * never a partial one. ISO-8601 `text` timestamps sort lexicographically the same as
 * chronologically, so the `gte`/`lt` string range on `created_at` is exact.
 */
export function dailyWindows(now: Date): DigestWindow {
  const DAY = 86_400_000;
  const startToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startDay = startToday - DAY;
  const priorStart = startDay - DAY;
  return {
    startIso: new Date(startDay).toISOString(),
    endIso: new Date(startToday).toISOString(),
    priorStartIso: new Date(priorStart).toISOString(),
    dayLabel: new Date(startDay).toISOString().slice(0, 10),
  };
}

/** A product and its view count in the reported window. */
export interface TopProduct {
  name: string;
  slug: string;
  views: number;
}

/** A count for the reported day and the day before (for the delta). */
export interface DailyCount {
  day: number;
  prior: number;
}

export interface AnalyticsMetrics {
  /** Page views (all routes) in the reported day / prior day. */
  pageViews: DailyCount;
  /** New accounts (profiles created) in the reported day / prior day. */
  newUsers: DailyCount;
  /** Cumulative registered users as of the run. */
  totalUsers: number;
  /** Reviews currently awaiting moderation (a live snapshot, not windowed). */
  pendingModeration: number;
  /** Top products by views in the reported day (up to 5; empty when no product views). */
  topProducts: TopProduct[];
}

const TOP_PRODUCTS_LIMIT = 5;

/** `COUNT(*)` of `page_views` in `[startIso, endIso)`. */
async function countPageViews(db: Db, startIso: string, endIso: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(pageViews)
    .where(and(gte(pageViews.createdAt, startIso), lt(pageViews.createdAt, endIso)));
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

/** Top products by `page_views` in `[startIso, endIso)`, joined to `products` for name/slug. */
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
      ),
    )
    .groupBy(products.id)
    .orderBy(desc(count()))
    .limit(TOP_PRODUCTS_LIMIT);
  return rows.map((r) => ({ name: r.name, slug: r.slug, views: r.views }));
}

/** Run every read for the digest concurrently. Report-only; never mutates. */
export async function collectAnalyticsMetrics(
  db: Db,
  window: DigestWindow,
): Promise<AnalyticsMetrics> {
  const [
    pageViewsDay,
    pageViewsPrior,
    newUsersDay,
    newUsersPrior,
    totalUsersRows,
    pendingRows,
    topProducts,
  ] = await Promise.all([
    countPageViews(db, window.startIso, window.endIso),
    countPageViews(db, window.priorStartIso, window.startIso),
    countNewProfiles(db, window.startIso, window.endIso),
    countNewProfiles(db, window.priorStartIso, window.startIso),
    db.select({ value: count() }).from(profiles),
    db.select({ value: count() }).from(reviews).where(eq(reviews.status, 'pending')),
    topProductsByViews(db, window.startIso, window.endIso),
  ]);
  return {
    pageViews: { day: pageViewsDay, prior: pageViewsPrior },
    newUsers: { day: newUsersDay, prior: newUsersPrior },
    totalUsers: totalUsersRows[0]?.value ?? 0,
    pendingModeration: pendingRows[0]?.value ?? 0,
    topProducts,
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

/** Human day-over-day delta, e.g. `+8 (+18%) vs 45 prior day`, `-3 (-7%) vs 45 prior
 *  day`, or `no change vs prior day`. Percentages are omitted when the prior day was 0
 *  (division would be meaningless). ASCII only, so it renders cleanly in plain text. */
function deltaText(c: DailyCount): string {
  const diff = c.day - c.prior;
  if (diff === 0) return 'no change vs prior day';
  const magnitude = Math.abs(diff);
  const sign = diff > 0 ? '+' : '-';
  const pct = c.prior > 0 ? ` (${sign}${Math.round((magnitude / c.prior) * 100)}%)` : '';
  return `${sign}${magnitude}${pct} vs ${c.prior} prior day`;
}

export function buildAnalyticsDigest(
  metrics: AnalyticsMetrics,
  opts: AnalyticsDigestOptions,
): EmailDigest {
  const { pageViews: pv, newUsers, totalUsers, pendingModeration, topProducts } = metrics;
  const topName = topProducts[0]?.name;

  const subject =
    `AECi daily digest (${opts.env}) — ${opts.dayLabel}: ` +
    `${pv.day} view${pv.day === 1 ? '' : 's'}, ${newUsers.day} new user${newUsers.day === 1 ? '' : 's'}` +
    (topName ? ` · top: ${topName}` : '');

  // ── plain text ──
  const t: string[] = [
    'AECi daily analytics digest',
    `Environment: ${opts.env}`,
    `Day (UTC): ${opts.dayLabel}`,
    `Generated: ${opts.generatedAt.toISOString()}`,
    '',
    '── Traffic ──',
    `Page views: ${pv.day} (${deltaText(pv)})`,
  ];
  if (topProducts.length > 0) {
    t.push('', 'Most viewed products:');
    topProducts.forEach((p, i) =>
      t.push(`  ${i + 1}. ${p.name} — ${p.views} view${p.views === 1 ? '' : 's'} (/${p.slug})`),
    );
  } else {
    t.push('Most viewed product: (no product page views)');
  }
  t.push(
    '',
    '── Sign-ins ──',
    `New sign-ins (new accounts): ${newUsers.day} (${deltaText(newUsers)})`,
    `Total sign-ins (registered users): ${totalUsers}`,
    '',
    '── Moderation ──',
    pendingModeration > 0
      ? `Reviews awaiting moderation: ${pendingModeration} — see /admin/reviews`
      : 'Reviews awaiting moderation: 0',
    '',
    'Report-only: counts are read from the app database; the window is the full prior UTC day.',
  );

  // ── html ──
  const topHtml =
    topProducts.length > 0
      ? `<ol>${topProducts
          .map(
            (p) =>
              `<li>${escapeHtml(p.name)} — ${p.views} view${p.views === 1 ? '' : 's'} <code>/${escapeHtml(p.slug)}</code></li>`,
          )
          .join('')}</ol>`
      : '<p>(no product page views)</p>';
  const h: string[] = [
    `<h2>AECi daily analytics digest</h2>`,
    `<p><strong>Environment:</strong> ${escapeHtml(opts.env)}<br>`,
    `<strong>Day (UTC):</strong> ${escapeHtml(opts.dayLabel)}<br>`,
    `<strong>Generated:</strong> ${escapeHtml(opts.generatedAt.toISOString())}</p>`,
    `<h3>Traffic</h3>`,
    `<p><strong>Page views:</strong> ${pv.day} <em>(${escapeHtml(deltaText(pv))})</em></p>`,
    `<p><strong>Most viewed products:</strong></p>`,
    topHtml,
    `<h3>Sign-ins</h3>`,
    `<p><strong>New sign-ins (new accounts):</strong> ${newUsers.day} <em>(${escapeHtml(deltaText(newUsers))})</em><br>`,
    `<strong>Total sign-ins (registered users):</strong> ${totalUsers}</p>`,
    `<h3>Moderation</h3>`,
    pendingModeration > 0
      ? `<p><strong>Reviews awaiting moderation:</strong> ${pendingModeration} — see <code>/admin/reviews</code></p>`
      : `<p><strong>Reviews awaiting moderation:</strong> 0</p>`,
    `<p><em>Report-only: counts are read from the app database; the window is the full prior UTC day.</em></p>`,
  ];

  return { subject, text: t.join('\n'), html: h.join('\n') };
}
