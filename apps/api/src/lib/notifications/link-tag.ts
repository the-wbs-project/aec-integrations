/**
 * Email link tagging (AECI-1209, `docs/email.md` §Link tagging).
 *
 * Every link in a transactional email that points at our own site carries three
 * params, so a return visit can be traced to the email that caused it:
 *
 *   - `utm_source=email`
 *   - `utm_campaign=<registry id>`, the template that was sent
 *   - `n=<notification_sends.id>`, the ledger row of this one send (AECI-1202)
 *
 * The signed-in arrival beacon (`POST /api/activity/arrival`, AECI-1208) reads them
 * from the landing URL and stores them on that day's `user_activity_daily` row.
 * `ARRIVAL_QUERY_PARAMS` in `@aeci/shared` is the same list, on the reading side.
 *
 * **Tagging happens at render time, before escaping.** `sendTransactionalEmail`
 * reserves the ledger row, builds a tagger from the row id, and hands it to the
 * template's render callback. The template passes each site URL through the tagger,
 * so the button, its Outlook VML twin, the pasteable URL and the text part all show
 * the same tagged URL, escaped once by the layout. A post-render rewrite of the HTML
 * could not do that: the `href` values are escaped, and the pasteable row and the
 * text part carry the URL as visible text.
 *
 * **Never tagged.** The tagger returns these unchanged, whoever calls it:
 *
 *   - any URL off the `PUBLIC_SITE_URL` origin, including `mailto:` and the Linear
 *     permalinks in operator alerts
 *   - `/api/*`, which covers the one-click opt-out endpoints in `List-Unsubscribe`
 *   - the opt-out pages, `/unsubscribe` and `/notifications/mute`, so an opt-out
 *     click never counts as an arrival
 *
 * Image sources, such as the logo, never pass through it.
 *
 * **No ledger id.** When the ledger write failed open, or for the operator copy (one
 * Resend call to the operator list, with no per-recipient row before the send), the
 * tagger omits `n` and still adds the two `utm_*` params. A send is never blocked.
 */

/** The `utm_source` every email link carries. */
export const EMAIL_UTM_SOURCE = 'email';

/** The params the tagger owns, in the order it appends them. */
export const EMAIL_LINK_PARAMS = ['utm_source', 'utm_campaign', 'n'] as const;

/**
 * Site paths whose links are never tagged. A path matches when it equals an entry or
 * continues it with `/`. `/api` covers the `List-Unsubscribe` one-click endpoints.
 */
export const UNTAGGED_PATH_PREFIXES = ['/api', '/unsubscribe', '/notifications/mute'] as const;

/** Turn a URL into the tagged form for one send. Pure and idempotent. */
export type LinkTagger = (url: string) => string;

export interface LinkTagContext {
  /** `PUBLIC_SITE_URL`. `null` (unset) means no URL is on our origin, so none is tagged. */
  siteUrl: string | null | undefined;
  /** The registry id of the email being rendered. Becomes `utm_campaign`. */
  templateId: string;
  /** The `notification_sends.id` of this send, or `null` when there is none. */
  sendId: number | null;
}

/** Whether a site path is one the tagger leaves alone. */
export function isUntaggedPath(pathname: string): boolean {
  return UNTAGGED_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** The origin of `PUBLIC_SITE_URL`, or null when it is unset or does not parse. */
function siteOrigin(siteUrl: string | null | undefined): string | null {
  const trimmed = siteUrl?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/**
 * Tag one URL for one send. Returns `url` unchanged when it is off our origin, on an
 * untagged path, or does not parse. Otherwise sets the three params, replacing any
 * earlier value of each, so tagging twice gives the same URL. Every other query param
 * and the fragment are kept.
 */
export function tagLink(url: string, ctx: LinkTagContext): string {
  const origin = siteOrigin(ctx.siteUrl);
  if (!origin) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.origin !== origin || isUntaggedPath(parsed.pathname)) return url;

  // Delete first, then append in a fixed order, so the result never depends on what
  // the input already carried.
  for (const name of EMAIL_LINK_PARAMS) parsed.searchParams.delete(name);
  parsed.searchParams.append('utm_source', EMAIL_UTM_SOURCE);
  parsed.searchParams.append('utm_campaign', ctx.templateId);
  if (ctx.sendId !== null) parsed.searchParams.append('n', String(ctx.sendId));
  return parsed.toString();
}

/** A {@link LinkTagger} bound to one send. */
export function createLinkTagger(ctx: LinkTagContext): LinkTagger {
  return (url) => tagLink(url, ctx);
}
