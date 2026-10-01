/**
 * The email delivery policy (AECI-1198): outside recipients get mail from production only.
 *
 * Every tier shares one Supabase auth project, and staging, demo and local Workers hold
 * a live `RESEND_API_KEY`. Without this gate a staging sweep emails real vendor seats.
 * The rule:
 *
 *   - **Production** sends to anyone.
 *   - **Every other tier** sends only to an address in {@link INTERNAL_RECIPIENT_DOMAINS}.
 *     Anything else is suppressed by the transport (`lib/email.ts`), which logs it with
 *     a recipient hash and counts `aeci.email.send` with `outcome:suppressed`.
 *   - **Fail closed.** A missing or unknown `ENV` counts as non-production.
 *
 * The allowlist is a code constant, not an env var, so a misconfigured var cannot widen
 * it. Supabase sign-in mail is outside this gate because Supabase sends it itself.
 * `docs/email.md` (§Tier delivery policy) is the governing doc.
 */

/** The env slice the policy reads. Structural, so `Env` and `EmailEnv` both fit, and an
 *  out-of-union `ENV` value still type-checks in tests. */
export interface DeliveryPolicyEnv {
  ENV?: string;
}

/** Recipient domains that receive mail on every tier. Exact match, no subdomains. */
export const INTERNAL_RECIPIENT_DOMAINS = ['thewbsproject.com', 'aecintegrations.com'] as const;

/** The non-production tiers that get a named subject prefix. Anything else is
 *  `[non-production]`. */
const NAMED_TIERS = new Set(['development', 'preview', 'staging', 'demo']);

/** True only when `ENV` is exactly `'production'`. Missing or unknown is non-production. */
export function isProductionTier(env: DeliveryPolicyEnv): boolean {
  return env.ENV === 'production';
}

/** The tier label for logs and the subject prefix. Unknown or missing is `non-production`. */
export function tierLabel(env: DeliveryPolicyEnv): string {
  if (isProductionTier(env)) return 'production';
  return env.ENV && NAMED_TIERS.has(env.ENV) ? env.ENV : 'non-production';
}

/**
 * True when the address's domain is on the allowlist. Accepts `Name <a@b.com>` or a bare
 * address. The domain is everything after the LAST `@`, compared case-insensitively and
 * exactly, so `x@evilthewbsproject.com` and `x@thewbsproject.com.evil.io` are outside.
 */
export function isInternalRecipient(address: string): boolean {
  const bare = bareAddress(address);
  const at = bare.lastIndexOf('@');
  if (at <= 0 || at === bare.length - 1) return false;
  const domain = bare.slice(at + 1);
  return (INTERNAL_RECIPIENT_DOMAINS as readonly string[]).includes(domain);
}

/** Split recipients into the ones this tier may mail and the ones it must suppress.
 *  Production allows everything. Order is preserved within each list. */
export function partitionRecipients(
  env: DeliveryPolicyEnv,
  addresses: readonly string[],
): { allowed: string[]; suppressed: string[] } {
  if (isProductionTier(env)) return { allowed: [...addresses], suppressed: [] };
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

/** `Name <a@b.com>` or `a@b.com` → `a@b.com`, trimmed and lowercased. */
function bareAddress(value: string): string {
  const match = value.match(/<([^>]+)>/);
  return (match ? match[1]! : value).trim().toLowerCase();
}
