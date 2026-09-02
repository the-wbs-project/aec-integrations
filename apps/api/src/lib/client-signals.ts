/**
 * Request-consistency classification for `page_views` (AECI-658).
 *
 * The problem this exists to attack: on 2026-08-23 the daily digest reported 48
 * "human" views. Those 48 spanned 44 ASNs and 31 countries but only 18
 * `user_agent_hash` values, one UA hash walked nine different pages from nine
 * different countries without repeating one, and **all 48 produced zero PostHog
 * events**. That is one crawler behind a rotating residential-proxy pool, and
 * neither of the two levers we already have can see it: `cf_bot_score` is
 * Enterprise-only (always null on Pro), and the ASNs are genuine consumer ISPs,
 * so `DATACENTER_ASNS` must not be widened to reach them — that map drives LIVE
 * ingest and a false positive silently deletes a real visitor
 * (`bot-classification.ts` header; AECI-582 hit exactly this with 885 Applebot
 * rows on Apple's AS714).
 *
 * What a rotating proxy cannot launder is the *shape of the request itself*. A
 * real browser doing a top-level navigation emits a characteristic header set;
 * an HTTP client pretending to be one usually does not bother. So we record how
 * browser-shaped each request was and let the read side decide what to do with
 * it.
 *
 * ─── This never writes `is_bot` ──────────────────────────────────────────────
 *
 * `client_verdict` is an **annotation**, exactly like `cf_as_organization`
 * (AECI-585 / §13 D10). It is computed at ingest because the headers are
 * unrecoverable afterwards, but nothing here feeds `classifyTraffic()` and no
 * value here changes a stored `is_bot`. That separation is deliberate and load
 * bearing: `is_bot` is decided once and costs a one-way backfill to revise,
 * whereas an annotation can be re-read, re-interpreted, and improved without
 * rewriting history. Audit this column against known-good traffic for a few
 * weeks before anyone proposes promoting it into a verdict.
 *
 * ─── Why these signals and not a fingerprint ────────────────────────────────
 *
 * Everything here is a **fact about the request**, carrying no identity: no
 * cookie, no canvas, no durable id. `page_views` holds no user linkage at all
 * (AECI-585 §13 D7 dropped `user_id` / `session_id` / `profile_role` and they
 * must not come back), and that is what keeps the write defensible as
 * consent-independent. A fingerprinting library would classify traffic better
 * and cost us that property; these headers do not.
 *
 * ─── Browser coverage — read before adding a check ──────────────────────────
 *
 *  - **`Sec-Fetch-*`** is the strong, browser-AGNOSTIC signal. Chrome, Edge,
 *    Firefox and Safari (16.4+) all send `Sec-Fetch-Dest: document` on a
 *    top-level navigation. Absence on an arrival is meaningful.
 *  - **`sec-ch-ua`** is **Chromium-only**. Firefox and Safari legitimately never
 *    send it, so a bare presence test would label every Safari visitor a bot.
 *    It is only ever consulted when the UA *claims* Chrome/Edge — that pairing
 *    (claims Chromium, omits Chromium's own client hint) is near-conclusive.
 *  - **`Accept-Language`** is near-universal in real browsers and routinely
 *    omitted by HTTP libraries. Weak on its own, useful in combination.
 *  - **`Accept`** on a document navigation always offers `text/html`. A bare
 *    wildcard on a top-level HTML load is a client library, not a browser.
 *
 * ─── Navigation awareness is mandatory ──────────────────────────────────────
 *
 * The two writers produce structurally different requests and must not be judged
 * by one rule. An SSR **arrival** is a document navigation
 * (`Sec-Fetch-Dest: document`). The browser tracker's **SPA** POST is a `fetch`
 * (`Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode: cors`) — applying arrival
 * expectations to it would mislabel every in-app hop. It also needs no test:
 * a same-origin `fetch` only happens because our JavaScript ran, which is itself
 * proof of a browser.
 */

/** How browser-shaped a request was. Ordered loosely from most to least trusted. */
export type ClientVerdict =
  /** Header set is consistent with a real browser. */
  | 'browser'
  /** Claims a browser UA but the headers contradict it — the interesting bucket. */
  | 'inconsistent'
  /** No browser pretence at all: none of the navigation headers a browser sends. */
  | 'non-browser'
  /** Not enough signal to say (e.g. a writer that forwarded nothing). */
  | 'unknown';

/** The raw signals worth storing beside the verdict, plus the verdict itself. */
export interface ClientSignals {
  /** `Sec-Fetch-Dest` verbatim (`document` / `empty` / …), or null when absent. */
  secFetchDest: string | null;
  /** Did the request carry `Accept-Language` at all? */
  hasAcceptLanguage: boolean;
  /** Did it carry `sec-ch-ua`? Only meaningful against a Chromium UA claim. */
  hasSecChUa: boolean;
  /** Negotiated TLS version (`TLSv1.3`), or null. Low entropy — see below. */
  tlsVersion: string | null;
  /** Negotiated protocol (`HTTP/2`), or null. Low entropy — see below. */
  httpProtocol: string | null;
  /** The derived annotation. Never feeds `is_bot`. */
  verdict: ClientVerdict;
}

/**
 * A UA that claims to be Chromium-family (Chrome, Edge, Opera, Brave…).
 *
 * Deliberately NOT matched against Safari's UA, which also contains the literal
 * token `Chrome/` in some embedded contexts — hence the `Chrome/<digits>` shape
 * plus an explicit exclusion of the Safari-only `Version/… Safari/` form below.
 */
const CHROMIUM_UA = /\bChrome\/\d+|\bChromium\/\d+|\bEdg\/\d+|\bOPR\/\d+/i;

/** Desktop/mobile Safari, which carries `Safari/` but never `sec-ch-ua`. */
const SAFARI_UA = /\bVersion\/[\d.]+ (Mobile\/\S+ )?Safari\//i;

/** Whether the UA is Chromium-family and therefore OWES a `sec-ch-ua` header. */
export function claimsChromium(ua: string | null): boolean {
  if (!ua) return false;
  if (SAFARI_UA.test(ua)) return false;
  return CHROMIUM_UA.test(ua);
}

/** Whether `Accept` looks like a real document navigation rather than a library. */
function acceptLooksLikeDocument(accept: string | null): boolean {
  if (!accept) return false;
  return accept.toLowerCase().includes('text/html');
}

/**
 * Classify one capture's request shape.
 *
 * `navigation` comes from the payload and decides which rule set applies —
 * `'spa'` is judged as a same-origin fetch, everything else as a document
 * arrival. A null `navigation` (every row written before AECI-585, and any
 * writer that omits it) is treated as an arrival, which is what the SSR path
 * always is.
 */
export function classifyClientSignals(
  headers: Headers,
  ua: string | null,
  navigation: string | null,
  cf: { tlsVersion?: string | null; httpProtocol?: string | null } = {},
): ClientSignals {
  const secFetchDest = headers.get('sec-fetch-dest');
  const hasAcceptLanguage = Boolean(headers.get('accept-language'));
  const hasSecChUa = Boolean(headers.get('sec-ch-ua'));
  const accept = headers.get('accept');

  const base = {
    secFetchDest,
    hasAcceptLanguage,
    hasSecChUa,
    tlsVersion: cf.tlsVersion || null,
    httpProtocol: cf.httpProtocol || null,
  };

  // An in-app hop is a same-origin `fetch` issued by our own bundle. Reaching
  // this code path at all means JavaScript executed in a real engine, which is a
  // stronger statement than any header test — so do not apply the arrival rules,
  // which it would fail by construction (`Sec-Fetch-Dest: empty`).
  if (navigation === 'spa') {
    return { ...base, verdict: 'browser' };
  }

  // A document navigation. `Sec-Fetch-Dest: document` is sent by every modern
  // browser; combined with `Accept-Language` and an HTML `Accept` it is a
  // consistent picture.
  const looksLikeNavigation = secFetchDest === 'document';
  const hasAnyBrowserSignal = Boolean(secFetchDest) || hasAcceptLanguage || hasSecChUa;

  // Nothing a browser sends. Not "suspicious" — simply not a browser.
  if (!hasAnyBrowserSignal && !acceptLooksLikeDocument(accept)) {
    // Distinguish "we were told nothing" from "we were told it isn't a browser":
    // a writer that forwards no headers at all must not manufacture a verdict.
    return { ...base, verdict: headers.get('user-agent') ? 'non-browser' : 'unknown' };
  }

  // The Chromium tell: claims Chrome/Edge, omits Chromium's own client hint.
  if (claimsChromium(ua) && !hasSecChUa) {
    return { ...base, verdict: 'inconsistent' };
  }

  // Claims a browser navigation but is missing the header set that accompanies
  // one. Firefox and Safari are covered here too — both send `Sec-Fetch-Dest`
  // and `Accept-Language`, so neither lands in this branch legitimately.
  if (!looksLikeNavigation || !hasAcceptLanguage || !acceptLooksLikeDocument(accept)) {
    return { ...base, verdict: 'inconsistent' };
  }

  return { ...base, verdict: 'browser' };
}
