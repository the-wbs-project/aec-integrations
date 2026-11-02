import { describe, expect, it } from 'vitest';

import {
  identifyUserAgents,
  noMatchMessage,
  parseHashPrefix,
  summarizeIpSpread,
} from './traffic-client-identity';

const LINUX_CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

describe('parseHashPrefix', () => {
  it('normalizes case and whitespace', () => {
    expect(parseHashPrefix(' 7484A43E ')).toBe('7484a43e');
  });

  it.each(['7484a43', 'not-a-hash', 'g484a43e', 'a'.repeat(65)])('rejects %s', (value) => {
    expect(() => parseHashPrefix(value)).toThrow('--hash must be');
  });
});

describe('identifyUserAgents', () => {
  it('matches the production client this script was built to name', async () => {
    const [row] = await identifyUserAgents([{ userAgent: LINUX_CHROME, count: 608 }], '7484a43e');
    expect(row).toMatchObject({ count: 608, matches: true });
    expect(row?.hash).toMatch(/^7484a43e[0-9a-f]{56}$/);
  });

  it('keeps every user agent and marks only the match', async () => {
    const rows = await identifyUserAgents(
      [
        { userAgent: 'curl/8.0', count: 9 },
        { userAgent: LINUX_CHROME, count: 3 },
      ],
      '7484a43e',
    );
    expect(rows.map((row) => row.matches)).toEqual([false, true]);
  });

  it('marks nothing when no prefix is given', async () => {
    const rows = await identifyUserAgents([{ userAgent: LINUX_CHROME, count: 1 }], null);
    expect(rows[0]?.matches).toBe(false);
  });

  it('reports a blank user agent with a null hash, never as a match', async () => {
    const [row] = await identifyUserAgents([{ userAgent: '', count: 130 }], '7484a43e');
    expect(row).toEqual({ userAgent: '', count: 130, hash: null, matches: false });
  });
});

describe('noMatchMessage', () => {
  it('points at the inputs when the whole network was checked', () => {
    expect(noMatchMessage('7484a43e', 99, 100)).toBe(
      'No user agent on this network hashes to 7484a43e. Check the ASN and the day.',
    );
  });

  it('does not rule the client out when the list reached the row limit', () => {
    const message = noMatchMessage('7484a43e', 100, 100);
    expect(message).toContain('busiest 100');
    expect(message).toContain('does not rule it out');
    expect(message).not.toContain('Check the ASN');
  });
});

describe('summarizeIpSpread', () => {
  it('reports the IP count and the busiest IP', () => {
    expect(summarizeIpSpread([4, 1, 2], 1000)).toEqual({ ips: 3, capped: false, maxPerIp: 4 });
  });

  it('flags a count that reached the row limit as a floor', () => {
    expect(summarizeIpSpread([1, 1], 2).capped).toBe(true);
  });

  it('handles no rows', () => {
    expect(summarizeIpSpread([], 1000)).toEqual({ ips: 0, capped: false, maxPerIp: 0 });
  });
});
