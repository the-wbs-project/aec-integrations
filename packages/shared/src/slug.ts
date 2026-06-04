/**
 * Canonical slug generator for products and vendors. Single source of truth so
 * the rules don't drift across the backfill script (Phase 2.7), the API
 * create-product / create-vendor paths, and admin tooling. Slug immutability
 * (Phase 2 Spec §6.2) is enforced at the *caller* layer — this module is
 * stateless and only produces or disambiguates slugs.
 */

/**
 * Slugs that must never be issued to a product or vendor because they collide
 * with reserved URL paths or static endpoints. Stored as final-form slugs;
 * `slugify` normalizes user input through the same pipeline before comparing,
 * so entries like `sitemap.xml` are kept verbatim — they match either a raw
 * `sitemap.xml` input or its slugified `sitemap-xml` form.
 */
export const DEFAULT_RESERVED_SLUGS: readonly string[] = Object.freeze([
  'api',
  'admin',
  'products',
  'vendors',
  'integrations',
  'categories',
  'audiences',
  // `disciplines` stays reserved: `/disciplines/:slug` permanently 301-redirects
  // to `/audiences/:slug` (AECI-121), so the namespace is still occupied.
  'disciplines',
  'phases',
  'claim',
  'correction',
  '404',
  'sitemap.xml',
  'robots.txt',
]);

/**
 * Thrown by `slugify` when the produced slug matches a reserved word. Caller
 * is expected to catch and disambiguate — typically by surfacing a validation
 * error to the user (e.g. "Pick a different name").
 */
export class SlugReservedError extends Error {
  readonly code = 'SLUG_RESERVED' as const;
  constructor(public readonly slug: string) {
    super(`Slug "${slug}" is reserved`);
    this.name = 'SlugReservedError';
  }
}

// Characters that NFKD does not decompose into ASCII. Applied before
// normalization so the regular combining-mark strip can do the rest.
const LATIN_COMPOUND_MAP: Record<string, string> = {
  ø: 'o',
  Ø: 'O',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ß: 'ss',
  ð: 'd',
  Ð: 'D',
  þ: 'th',
  Þ: 'Th',
  ł: 'l',
  Ł: 'L',
};

const COMBINING_MARKS = /[̀-ͯ]/g;
const NON_ALPHANUMERIC_RUN = /[^a-z0-9]+/g;
const LEADING_OR_TRAILING_HYPHENS = /^-+|-+$/g;

function asciiFold(input: string): string {
  let out = '';
  for (const ch of input) {
    out += LATIN_COMPOUND_MAP[ch] ?? ch;
  }
  return out.normalize('NFKD').replace(COMBINING_MARKS, '');
}

function toSlugBody(input: string): string {
  return asciiFold(input)
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RUN, '-')
    .replace(LEADING_OR_TRAILING_HYPHENS, '');
}

/**
 * Produce a URL-safe slug from a free-text name. Lowercases, ASCII-folds
 * (`Procoré` → `procore`, `Bjørn` → `bjorn`), collapses non-alphanumeric runs
 * to a single `-`, and trims hyphens at either end.
 *
 * Throws `SlugReservedError` if the result matches a reserved word. Throws
 * `TypeError` if the input produces an empty slug (e.g. `"!!!"`) — callers
 * passing garbage should fail loudly rather than receive `""`.
 *
 * `opts.reserved` *replaces* the default list. Spread `DEFAULT_RESERVED_SLUGS`
 * if you need to extend it:
 *
 * ```ts
 * slugify(name, { reserved: [...DEFAULT_RESERVED_SLUGS, 'internal'] });
 * ```
 */
export function slugify(name: string, opts?: { reserved?: string[] }): string {
  const slug = toSlugBody(name);
  if (slug === '') {
    throw new TypeError('slug input produced empty result');
  }

  const reservedSource = opts?.reserved ?? DEFAULT_RESERVED_SLUGS;
  const normalizedReserved = new Set(reservedSource.map(toSlugBody));
  if (normalizedReserved.has(slug)) {
    throw new SlugReservedError(slug);
  }

  return slug;
}

/**
 * Resolve a slug collision. If `base` is free, returns it unchanged. On a
 * single collision, appends `vendorSlug` (when provided and distinct from
 * `base`) — useful for products under different vendors that share a name.
 * On further collisions, falls back to numeric suffixes `-2`, `-3`, …
 *
 * Pure: the caller passes the list of slugs already in use.
 */
export function disambiguateSlug(base: string, existing: string[], vendorSlug?: string): string {
  const existingSet = new Set(existing);
  if (!existingSet.has(base)) {
    return base;
  }

  if (vendorSlug && vendorSlug !== base) {
    const withVendor = `${base}-${vendorSlug}`;
    if (!existingSet.has(withVendor)) {
      return withVendor;
    }
  }

  let n = 2;
  while (existingSet.has(`${base}-${n}`)) {
    n += 1;
  }
  return `${base}-${n}`;
}
