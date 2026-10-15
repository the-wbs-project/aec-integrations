/**
 * Free and personal mailbox domains, for the claim form's work-email nudge
 * (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.2). A claim from one of these is still
 * accepted. The form asks for a work address because a personal one cannot be
 * checked against the company's website, so the claim takes longer to confirm.
 *
 * Exact domain match only, lower-cased. Kept deliberately short: a domain that is
 * also a listed vendor's own (zoho.com, for one) stays off the list, because a
 * Zoho employee claiming Zoho is using a work address.
 */
export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com',
  'googlemail.com',
  // Yahoo
  'yahoo.com',
  'yahoo.ca',
  'yahoo.co.uk',
  'yahoo.co.in',
  'yahoo.com.au',
  'yahoo.de',
  'yahoo.fr',
  'ymail.com',
  'rocketmail.com',
  // AOL
  'aol.com',
  'aim.com',
  // Microsoft consumer
  'outlook.com',
  'outlook.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.ca',
  'hotmail.fr',
  'hotmail.de',
  'live.com',
  'live.co.uk',
  'live.ca',
  'msn.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // Others
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'mail.com',
  'zohomail.com',
  'yandex.com',
  'yandex.ru',
  'fastmail.com',
  'tutanota.com',
  'tuta.io',
  'hey.com',
  'qq.com',
  '163.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
]);

/**
 * True when `email` is a well-formed address at a free or personal mailbox
 * domain. Anything without a domain part returns false, so a half-typed address
 * never trips the nudge.
 */
export function isFreeEmailAddress(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.trim().lastIndexOf('@');
  if (at < 1) return false;
  const domain = email
    .trim()
    .slice(at + 1)
    .toLowerCase()
    .replace(/\.$/, '');
  return FREE_EMAIL_DOMAINS.has(domain);
}
