/**
 * The held regions (AECI-1581 for Turnstile, ruling 21 for the browser report,
 * AECI-1713). One list owns the hold. Two readers use it:
 *
 * - the SSR gateway, which stamps `Server-Timing: geo;desc="eu"` so the browser
 *   skips Turnstile and the browser report (`isTurnstileExcludedRegion` in
 *   `apps/web/src/server-runtime.ts`). It also trusts `cf.isEUCountry`;
 * - the API, which sees only the forwarded `cf_country`, and must never store a
 *   browser report on a held-region row (`routes/page-views.ts`).
 *
 * Because the API has no `isEUCountry`, the list names the EU member states itself.
 * Kept in its own module, with no imports, so nothing else rides along with it into
 * a bundle.
 */

/** The 27 EU member states, by ISO 3166-1 alpha-2 code. */
const EU_MEMBER_STATES = [
  'AT',
  'BE',
  'BG',
  'CY',
  'CZ',
  'DE',
  'DK',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'HR',
  'HU',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SE',
  'SI',
  'SK',
] as const;

/**
 * Codes held beyond the member states: the UK, Switzerland and the non-EU EEA
 * states; the codes that give no location (`XX` unknown, `T1` Tor); and EU territory
 * with its own ISO code, which Cloudflare's docs do not say `isEUCountry` covers.
 */
const HELD_BEYOND_EU = [
  'GB',
  'CH',
  'IS',
  'LI',
  'NO',
  'XX',
  'T1',
  'AX',
  'GF',
  'GP',
  'MF',
  'MQ',
  'RE',
  'YT',
] as const;

/**
 * Canonical. Every country code whose visitors are held: no Turnstile check, no
 * browser report. Uppercase, as Cloudflare sends `cf.country`. A missing or empty
 * country is held too, but by `isHeldRegionCountry`, not by a member of this set.
 */
export const HELD_REGION_COUNTRIES: ReadonlySet<string> = new Set<string>([
  ...EU_MEMBER_STATES,
  ...HELD_BEYOND_EU,
]);

/**
 * Alias of `HELD_REGION_COUNTRIES`, the same set, kept under the name the gateway
 * used before AECI-1713 moved the list here. Lifting the Turnstile hold
 * (AECI-1529) stops the gateway reading it for Turnstile. It does not lift the
 * browser report's hold, which is a separate ruling.
 */
export const TURNSTILE_EXCLUDED_COUNTRIES: ReadonlySet<string> = HELD_REGION_COUNTRIES;

/**
 * Whether a visitor from this country is held. Fails closed: a null, undefined or
 * empty country is held, because the privacy policy promises the hold and an
 * unknown location cannot be shown to fall outside it. Matches the gateway's
 * `!cf.country || set.has(cf.country)` rule.
 */
export function isHeldRegionCountry(country: string | null | undefined): boolean {
  const code = country?.trim().toUpperCase();
  return !code || HELD_REGION_COUNTRIES.has(code);
}
