/**
 * Unit tests for `classifyTraffic` (AECI-526 follow-up) — the human/bot split written
 * onto each `page_views` row from the raw User-Agent + Cloudflare ASN.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { classifyTraffic, datacenterAsnEntries } from './bot-classification';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BINGBOT = 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)';
const APPLEBOT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)';

describe('classifyTraffic', () => {
  it('names common crawlers from the User-Agent', () => {
    expect(classifyTraffic(GOOGLEBOT, null)).toEqual({ isBot: true, botName: 'Googlebot' });
    expect(classifyTraffic(BINGBOT, null)).toEqual({ isBot: true, botName: 'Bingbot' });
    expect(classifyTraffic(APPLEBOT, 714)).toEqual({ isBot: true, botName: 'Applebot' });
    expect(classifyTraffic('GPTBot/1.2', null)).toEqual({
      isBot: true,
      botName: 'GPTBot (OpenAI)',
    });
    expect(classifyTraffic('ClaudeBot/1.0', null)).toEqual({
      isBot: true,
      botName: 'ClaudeBot (Anthropic)',
    });
  });

  it('falls back to a generic label for unnamed automation UAs', () => {
    expect(classifyTraffic('SomeRandomBot/3.0', null)).toEqual({
      isBot: true,
      botName: 'Other bot',
    });
    expect(classifyTraffic('python-requests/2.31', null)).toEqual({
      isBot: true,
      botName: 'Other bot',
    });
    expect(classifyTraffic('curl/8.4.0', null)).toEqual({ isBot: true, botName: 'Other bot' });
  });

  it('flags datacenter ASNs even when the UA looks like a real browser (headless scraper)', () => {
    expect(classifyTraffic(CHROME, 16509)).toEqual({ isBot: true, botName: 'Datacenter (AWS)' });
    expect(classifyTraffic(CHROME, 8075)).toEqual({
      isBot: true,
      botName: 'Datacenter (Microsoft)',
    });
    expect(classifyTraffic(CHROME, 396982)).toEqual({
      isBot: true,
      botName: 'Datacenter (Google Cloud)',
    });
  });

  it('flags the mid-tier hosting / VPN / scanner networks added in the 2026-08 census', () => {
    // The offenders that made the 2026-08-03 digest report 166 "humans": a colocation
    // provider, a Hetzner secondary ASN, and an internet-wide scanner.
    expect(classifyTraffic(CHROME, 47007)).toEqual({
      isBot: true,
      botName: 'Datacenter (Colocation America)',
    });
    expect(classifyTraffic(CHROME, 213230)).toEqual({
      isBot: true,
      botName: 'Datacenter (Hetzner)',
    });
    expect(classifyTraffic(CHROME, 213412)).toEqual({ isBot: true, botName: 'ONYPHE (scanner)' });
    expect(classifyTraffic(CHROME, 47583)).toEqual({
      isBot: true,
      botName: 'Datacenter (Hostinger)',
    });
  });

  it('classifies a real browser on a residential ASN as human', () => {
    expect(classifyTraffic(CHROME, 7922)).toEqual({ isBot: false, botName: null });
    expect(classifyTraffic(CHROME, null)).toEqual({ isBot: false, botName: null });
  });

  it('keeps the deliberately-excluded human-carrying networks human', () => {
    // Documented exclusions in bot-classification.ts — a false positive here deletes a
    // real visitor from the digest, which is worse than counting a crawler.
    expect(classifyTraffic(CHROME, 714)).toEqual({ isBot: false, botName: null }); // Apple / iCloud Private Relay
    expect(classifyTraffic(CHROME, 22616)).toEqual({ isBot: false, botName: null }); // Zscaler corporate proxy
    expect(classifyTraffic(CHROME, 3356)).toEqual({ isBot: false, botName: null }); // Lumen transit
    expect(classifyTraffic(CHROME, 16591)).toEqual({ isBot: false, botName: null }); // Google Fiber
    expect(classifyTraffic(CHROME, 23700)).toEqual({ isBot: false, botName: null }); // Linknet-Fastnet (ID)
  });

  it('does not misclassify Safari Technology Preview as a bot', () => {
    const stp =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/618.1 (KHTML, like Gecko) Version/18.0 Safari/618.1 (Safari Technology Preview)';
    expect(classifyTraffic(stp, 7922)).toEqual({ isBot: false, botName: null });
  });

  it('re-classifies historical rows by ASN alone (UA discarded)', () => {
    expect(classifyTraffic(null, 15169)).toEqual({ isBot: true, botName: 'Datacenter (Google)' });
    expect(classifyTraffic(null, 7922)).toEqual({ isBot: false, botName: null });
    expect(classifyTraffic(null, null)).toEqual({ isBot: false, botName: null });
  });
});

/**
 * Drift guard. `scripts/ops/backfill-page-view-bots.sql` re-classifies historical rows
 * by ASN alone and must stay a faithful mirror of `DATACENTER_ASNS` — otherwise a
 * widened list silently leaves old rows counted as human (which is exactly how the
 * 2026-08-03 digest came to report 166 "humans"). Parsing beats a comment.
 */
describe('backfill-page-view-bots.sql', () => {
  // cwd is the `apps/api` package when vitest runs (same assumption as src/test/d1.ts).
  const sql = readFileSync(
    join(process.cwd(), '../../scripts/ops/backfill-page-view-bots.sql'),
    'utf8',
  );

  /** Every `WHEN <asn> THEN '<label>'` arm of the CASE, in file order. */
  const caseArms = [...sql.matchAll(/WHEN (\d+) THEN '([^']+)'/g)].map(
    ([, asn, label]) => [Number(asn), label] as const,
  );
  /** The ASN list of the statement's `cf_asn IN (...)` predicate — anchored on the
   *  `WHERE is_bot IS NULL` guard so a `cf_asn IN (…)` inside a comment can't match. */
  const inList = [
    ...(sql.match(/WHERE is_bot IS NULL\s+AND cf_asn IN \(([\s\S]*?)\)/)?.[1] ?? '').matchAll(
      /\d+/g,
    ),
  ].map((m) => Number(m[0]));

  it('maps every classifier ASN to the same label', () => {
    expect(new Map(caseArms)).toEqual(new Map(datacenterAsnEntries()));
  });

  it('restricts the UPDATE to exactly those ASNs', () => {
    expect(new Set(inList)).toEqual(new Set(datacenterAsnEntries().map(([asn]) => asn)));
    expect(inList).toHaveLength(datacenterAsnEntries().length);
  });

  it('stays idempotent and leaves the rest human', () => {
    expect(sql).toContain('WHERE is_bot IS NULL');
    expect(sql).toContain('UPDATE page_views SET is_bot = 0 WHERE is_bot IS NULL;');
  });
});
