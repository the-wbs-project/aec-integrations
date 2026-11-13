import { z } from 'zod';

/**
 * ISO 3166-1 alpha-2 country codes (AECI-1705), the officially assigned set: 249 codes.
 * The listing request form asks for "Company country" from this list, and the
 * `listing-request-alert` email shows the name and the code.
 *
 * Codes only, no English names. A name comes from {@link countryName}, which asks the
 * runtime's `Intl.DisplayNames` in the reader's locale. So the picker needs no
 * hand-kept translation table, and the list cannot drift from a second copy of names.
 *
 * Keep the order alphabetical by code. A picker sorts by the displayed name itself.
 */
// prettier-ignore
export const ISO_COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;

export type IsoCountryCode = (typeof ISO_COUNTRY_CODES)[number];

const CODES: ReadonlySet<string> = new Set(ISO_COUNTRY_CODES);

/** True for an assigned ISO 3166-1 alpha-2 code, upper case. */
export function isIsoCountryCode(value: string): value is IsoCountryCode {
  return CODES.has(value);
}

/**
 * A required country, as the wire carries it: an assigned alpha-2 code. Lower case is
 * accepted and stored upper case. Anything else, the empty string included, fails.
 */
export const IsoCountryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isIsoCountryCode, 'Choose the country from the list.');

/**
 * The country's name in `locale`, from `Intl.DisplayNames`. Falls back to the code
 * when the runtime has no name for it, so a caller always has text to show.
 */
export function countryName(code: string, locale = 'en-US'): string {
  try {
    return regionNames(locale).of(code) ?? code;
  } catch {
    return code;
  }
}

/** One `Intl.DisplayNames` per locale: a picker names all 249 codes at once. */
const REGION_NAMES = new Map<string, Intl.DisplayNames>();
function regionNames(locale: string): Intl.DisplayNames {
  let names = REGION_NAMES.get(locale);
  if (!names) {
    names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'code' });
    REGION_NAMES.set(locale, names);
  }
  return names;
}
