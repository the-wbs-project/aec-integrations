/**
 * Unit tests for `classifyTraffic` (AECI-526 follow-up) — the human/bot split written
 * onto each `page_views` row from the raw User-Agent + Cloudflare ASN.
 */

import { describe, expect, it } from 'vitest';

import { classifyTraffic } from './bot-classification';

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

  it('classifies a real browser on a residential ASN as human', () => {
    expect(classifyTraffic(CHROME, 7922)).toEqual({ isBot: false, botName: null });
    expect(classifyTraffic(CHROME, null)).toEqual({ isBot: false, botName: null });
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
