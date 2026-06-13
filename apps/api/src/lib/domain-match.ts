/**
 * Domain-match signal for vendor requests (AECI-215 / Phase 6.8 §7.1).
 *
 * On submit we compute whether the submitter's email domain matches the **target
 * vendor's** website domain, and persist the verdict on `vendor_requests.domain_match`
 * (was `'pending'`). Purely **informational** — a hint for the admin and, on a
 * mismatch, the `domain-check-pending` Linear label (`lib/linear.ts` `labelIdsFor`).
 * It NEVER auto-approves or auto-rejects (PO decision, 2026-06-10).
 *
 * Comparison is on the **registrable domain** (eTLD+1) via `tldts`, so it tolerates
 * subdomains (`jane@mail.acme.com` matches `https://www.acme.com` — both `acme.com`)
 * and is correct on multi-part TLDs (`acme.co.uk`, not `co.uk`).
 */

import { getDomain } from 'tldts';

/** The four states of `vendor_requests.domain_match` (DB CHECK; DATABASE_SCHEMA §8.1).
 *  `'pending'` is only the pre-compute default — this module never returns it. */
export type DomainMatch = 'pending' | 'match' | 'no_match' | 'manual_review';

/** The subset {@link computeDomainMatch} actually produces. */
export type ComputedDomainMatch = Exclude<DomainMatch, 'pending'>;

/** Registrable domain of an email address, or `null` if it has no `@` host or the
 *  host has no public-suffix domain (e.g. `localhost`, an IP, garbage). */
export function extractEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const host = email.slice(at + 1).trim();
  return host ? getDomain(host) : null;
}

/** Registrable domain of a website URL (or bare host), or `null` when absent /
 *  unparseable. `getDomain` accepts a full URL or a hostname. */
export function extractWebsiteDomain(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  return trimmed ? getDomain(trimmed) : null;
}

/**
 * Compute the domain-match verdict for a submit.
 *
 *   - `'match'`         — email and website resolve to the same registrable domain.
 *   - `'no_match'`      — both resolve, but differ (drives the Linear label).
 *   - `'manual_review'` — either side is missing/unparseable (no target website on
 *                          file, or a non-corporate email host). NOT a mismatch, so
 *                          it does NOT fire the label; surfaced to the admin to verify.
 */
export function computeDomainMatch(
  submitterEmail: string,
  websiteUrl: string | null | undefined,
): ComputedDomainMatch {
  const emailDomain = extractEmailDomain(submitterEmail);
  const websiteDomain = extractWebsiteDomain(websiteUrl);
  if (!emailDomain || !websiteDomain) return 'manual_review';
  return emailDomain === websiteDomain ? 'match' : 'no_match';
}
