/**
 * The email delivery policy (AECI-1198): outside recipients get mail from production only.
 *
 * Every tier shares one Supabase auth project, and staging, demo and local Workers hold
 * a live `RESEND_API_KEY`. Without this gate a staging sweep emails real vendor seats.
 * The rule:
 *
 *   - **Production** sends to anyone.
 *   - **Staging redirects** (2026-10-09, the AECI-1103 rehearsal). Every recipient, internal
 *     or outside, is mailed at {@link STAGING_REDIRECT_RECIPIENT} instead, and the subject
 *     names the intended recipient. The ledger, dedupe keys and tokens stay keyed to the
 *     intended recipient, so only the envelope `to` differs from production. See
 *     {@link isRedirectTier}.
 *   - **Every other tier** sends only to an address in {@link INTERNAL_RECIPIENT_DOMAINS}.
 *     Anything else is suppressed by the transport (`lib/email.ts`), which logs it with
 *     a recipient hash and counts `aeci.email.send` with `outcome:suppressed`.
 *   - **Fail closed.** A missing or unknown `ENV` counts as non-production.
 *   - **Tier-limited entries** (AECI-1220). A registry entry with
 *     `envRule: 'production-only'` sends from production alone, and one with
 *     `'production-and-demo'` from production and demo. Every other tier suppresses it
 *     whatever the recipient, through {@link refusedByTierRule}.
 *
 * The allowlist and the staging redirect address are code constants, not env vars, so a
 * misconfigured var cannot widen either. Supabase sign-in mail is outside this gate because Supabase sends it itself.
 * `docs/email.md` (§Tier delivery policy) is the governing doc.
 */

/** The env slice the policy reads. Structural, so `Env` and `EmailEnv` both fit, and an
 *  out-of-union `ENV` value still type-checks in tests. */
export interface DeliveryPolicyEnv {
  ENV?: string;
}

/** Recipient domains that receive mail on every tier. Exact match, no subdomains. */
export const INTERNAL_RECIPIENT_DOMAINS = ['thewbsproject.com', 'aecintegrations.com'] as const;

/**
 * The one inbox every staging email is delivered to (2026-10-09). A code constant, so a
 * bad var cannot point staging mail at an outside inbox. It is internal, so the intended
 * recipient's raw address may appear in the subject.
 */
export const STAGING_REDIRECT_RECIPIENT = 'support@aecintegrations.com';

/** The non-production tiers that get a named subject prefix. Anything else is
 *  `[non-production]`. */
const NAMED_TIERS = new Set(['development', 'staging', 'demo']);

/** True only when `ENV` is exactly `'production'`. Missing or unknown is non-production. */
export function isProductionTier(env: DeliveryPolicyEnv): boolean {
  return env.ENV === 'production';
}

/** True only when `ENV` is exactly `'staging'`: the one tier that redirects every
 *  recipient to {@link STAGING_REDIRECT_RECIPIENT}. Demo, development and a
 *  missing or unknown `ENV` keep the allowlist. */
export function isRedirectTier(env: DeliveryPolicyEnv): boolean {
  return env.ENV === 'staging';
}

/** True when the entry's tier rule refuses this tier outright, before any recipient is
 *  looked at (AECI-1220): a `production-only` entry outside production, or a
 *  `production-and-demo` entry outside those two. */
export function refusedByTierRule(env: DeliveryPolicyEnv, envRule: string): boolean {
  if (envRule === 'production-only') return !isProductionTier(env);
  if (envRule === 'production-and-demo') return !isProductionTier(env) && env.ENV !== 'demo';
  return false;
}

/** The tier label for logs and the subject prefix. Unknown or missing is `non-production`. */
export function tierLabel(env: DeliveryPolicyEnv): string {
  if (isProductionTier(env)) return 'production';
  return env.ENV && NAMED_TIERS.has(env.ENV) ? env.ENV : 'non-production';
}

/**
 * True when the value is ONE address whose domain is on the allowlist. Accepts
 * `Name <a@b.com>` or a bare address. The domain is everything after the `@`, compared
 * case-insensitively and exactly, so `x@evilthewbsproject.com` and
 * `x@thewbsproject.com.evil.io` are outside.
 *
 * **One address only.** Resend reads a `to` string as a list, so a value that smuggles a
 * second address past the allowlist would mail an outside inbox from a non-production
 * tier. Fail closed on anything that is not plainly one address:
 *
 *   - a `,` or `;` anywhere in the value (`x@gmail.com,support@aecintegrations.com`);
 *   - more than one `<` or `>`, or an `@` outside the angle brackets of a
 *     `Name <a@b.com>` value (a lax parser could read the display name as an address);
 *   - whitespace inside the bare address;
 *   - more than one `@` in the bare address (`"a@x.com"@aecintegrations.com`). A quoted
 *     local part with an `@` is legal RFC 5322, but no AECi recipient needs it.
 */
export function isInternalRecipient(address: string): boolean {
  if (/[,;]/.test(address)) return false;
  if ((address.match(/</g)?.length ?? 0) > 1 || (address.match(/>/g)?.length ?? 0) > 1) {
    return false;
  }
  const angle = address.indexOf('<');
  if (angle >= 0 && /@/.test(address.slice(0, angle) + address.slice(address.indexOf('>') + 1))) {
    return false;
  }
  const bare = bareAddress(address);
  if (/\s/.test(bare)) return false;
  const at = bare.indexOf('@');
  if (at <= 0 || at !== bare.lastIndexOf('@') || at === bare.length - 1) return false;
  const domain = bare.slice(at + 1);
  return (INTERNAL_RECIPIENT_DOMAINS as readonly string[]).includes(domain);
}

/** Split recipients into the ones this tier may mail and the ones it must suppress.
 *  Production allows everything. Staging allows everything too, because
 *  {@link envelopeRecipients} sends it all to {@link STAGING_REDIRECT_RECIPIENT}. Order is
 *  preserved within each list. */
export function partitionRecipients(
  env: DeliveryPolicyEnv,
  addresses: readonly string[],
): { allowed: string[]; suppressed: string[] } {
  if (isProductionTier(env) || isRedirectTier(env)) {
    return { allowed: [...addresses], suppressed: [] };
  }
  const allowed: string[] = [];
  const suppressed: string[] = [];
  for (const address of addresses) {
    (isInternalRecipient(address) ? allowed : suppressed).push(address);
  }
  return { allowed, suppressed };
}

/** Prefix a non-production subject with its tier, e.g. `[staging] …`. Production is
 *  unchanged. */
export function tierSubject(env: DeliveryPolicyEnv, subject: string): string {
  if (isProductionTier(env)) return subject;
  return `[${tierLabel(env)}] ${subject}`;
}

/** The Resend `to` for a send to these allowed recipients. Staging gives the one
 *  {@link STAGING_REDIRECT_RECIPIENT}, whoever was intended. Every other tier gives the
 *  list unchanged. */
export function envelopeRecipients(env: DeliveryPolicyEnv, intended: readonly string[]): string[] {
  return isRedirectTier(env) ? [STAGING_REDIRECT_RECIPIENT] : [...intended];
}

/**
 * The delivered subject. Staging names the intended recipients, so the shared inbox shows
 * who each mail was for: `[staging → x@gmail.com] Your claim …`. Several recipients are
 * joined with `, `. Every other tier is {@link tierSubject}. Line breaks in an address are
 * flattened to spaces, so a stored value cannot add a header line.
 */
export function deliverySubject(
  env: DeliveryPolicyEnv,
  subject: string,
  intended: readonly string[],
): string {
  if (!isRedirectTier(env)) return tierSubject(env, subject);
  const names = intended.map((a) => bareAddress(a).replace(/[\r\n]+/g, ' ')).join(', ');
  return `[${tierLabel(env)} → ${names}] ${subject}`;
}

/** `Name <a@b.com>` or `a@b.com` → `a@b.com`, trimmed and lowercased. */
function bareAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1]! : value).trim().toLowerCase();
}
