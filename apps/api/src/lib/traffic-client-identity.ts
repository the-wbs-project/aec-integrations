/**
 * The tested core of `scripts/identify-traffic-client.ts` (AECI-1580,
 * `POST_LAUNCH_MONITORING.md` §3b).
 *
 * `page_views` keeps only `sha256(user agent)`, so a stored hash names no client on
 * its own. Hashing each user agent Cloudflare saw on a network, the way ingest does
 * (`routes/page-views.ts`), turns the hash back into the string it came from.
 *
 * A blank user agent has no hash: ingest stores NULL for it. It is reported with a
 * null hash and never matches, so it stays visible rather than being dropped.
 */

import { sha256Hex } from './hash';

/** The shortest prefix accepted: the 8 characters the reports print. */
export const MIN_HASH_PREFIX_LENGTH = 8;

export interface UserAgentCount {
  userAgent: string;
  count: number;
}

export interface IdentifiedUserAgent extends UserAgentCount {
  /** Null for a blank user agent, matching the NULL ingest stores. */
  hash: string | null;
  matches: boolean;
}

export interface IpSpread {
  ips: number;
  /** True when the query's row limit was reached, so `ips` is a floor. */
  capped: boolean;
  maxPerIp: number;
}

/** Normalizes a stored hash or its prefix. Throws on anything else. */
export function parseHashPrefix(value: string): string {
  const prefix = value.trim().toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${MIN_HASH_PREFIX_LENGTH},64}$`).test(prefix)) {
    throw new Error(
      `--hash must be ${MIN_HASH_PREFIX_LENGTH} to 64 hex characters, got "${value}"`,
    );
  }
  return prefix;
}

/** Hashes each user agent and marks the ones matching `prefix`, keeping the order. */
export async function identifyUserAgents(
  groups: readonly UserAgentCount[],
  prefix: string | null,
): Promise<IdentifiedUserAgent[]> {
  return Promise.all(
    groups.map(async (group) => {
      const hash = group.userAgent ? await sha256Hex(group.userAgent) : null;
      return { ...group, hash, matches: Boolean(prefix && hash?.startsWith(prefix)) };
    }),
  );
}

/** The no-match line. A list that reached the row limit cannot rule the client out. */
export function noMatchMessage(prefix: string, checked: number, rowLimit: number): string {
  return checked >= rowLimit
    ? `No user agent among this network's busiest ${rowLimit} hashes to ${prefix}. A quieter client would not be on that list, so this does not rule it out.`
    : `No user agent on this network hashes to ${prefix}. Check the ASN and the day.`;
}

/** Reduces per-IP request counts to the spread. The IPs themselves never leave here. */
export function summarizeIpSpread(counts: readonly number[], rowLimit: number): IpSpread {
  return {
    ips: counts.length,
    capped: counts.length >= rowLimit,
    maxPerIp: counts.reduce((max, count) => Math.max(max, count), 0),
  };
}
