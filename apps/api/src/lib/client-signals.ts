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
 * ─── Writer awareness is mandatory, and it is NOT the body's to declare ─────
 *
 * The two writers produce structurally different requests and must not be judged
 * by one rule. An SSR **arrival** is a document navigation
 * (`Sec-Fetch-Dest: document`). The browser tracker's **SPA** POST is a `fetch`
 * (`Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode: cors`) — applying arrival
 * expectations to it would mislabel every in-app hop.
 *
 * Which writer it was comes from {@link PAGE_VIEW_WRITER_HEADER}, set by the SSR
 * Worker, which strips any client copy first. **Until AECI-871 it came from the
 * body's `navigation` field**, on the reasoning that "a same-origin `fetch` only
 * happens because our JavaScript ran, which is itself proof of a browser". The
 * premise was sound and the inference was not: nothing established that the request
 * *was* a same-origin fetch except the request's own say-so. Any HTTP client could
 * POST `{ route, navigation: 'spa' }` through the SSR `/api/*` passthrough and be
 * handed `browser` — the strongest verdict the system issues — with every
 * header check skipped. Since AECI-744 (§13 D16) that verdict is also what keeps a
 * row OUT of the digest's automation exclusion, so the shortcut was a free upgrade
 * on the one column built to catch exactly this traffic.
 *
 * So provenance is now trusted transport and `navigation` is what the writer
 * *claimed*, kept for the arrival-vs-hop breakdown it was added for and read by
 * nothing here except as a reason to WITHHOLD a verdict. A body that says `'spa'`
 * with no trusted provenance gets `unknown`: we were told nothing we can act on, and
 * "told nothing" is not "told it is a bot". `non-browser` would be the same
 * manufacture-a-verdict-from-an-omission error the empty-header branch below avoids.
 *
 * ─── What a `browser` SPA row now requires ──────────────────────────────────
 *
 * Provenance alone is not enough either — it says our Worker proxied a POST, not
 * that a browser issued it. The write must ALSO carry what a same-origin `fetch`
 * from our bundle sends: {@link looksLikeSameOriginFetch}. Those ride through the
 * passthrough untouched (`PAGE_VIEW_CLIENT_SIGNAL_HEADERS`), so their absence is
 * meaningful rather than an artifact of the hop.
 *
 * ─── And what it still cannot do ────────────────────────────────────────────
 *
 * A real headless browser passes every check here, on both paths. That is correct
 * rather than a gap: `client_verdict` names EVIDENCE about a request, never an
 * identity. Automating Chrome to walk the catalog produces genuine browser headers
 * because it genuinely is a browser. What this column catches is the cheap client
 * that does not bother, which is the majority (§13 D18).
 */

import { readPageViewWriter, type PageViewWriter } from '@aeci/shared';

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
  /**
   * Which of our two writers originated this write, from the SSR-Worker-set
   * {@link PAGE_VIEW_WRITER_HEADER} (AECI-871). `null` = no trusted statement:
   * the header was absent or carried a value outside the closed vocabulary.
   *
   * Persisted as `page_views.writer_provenance`. Null on every row written before
   * AECI-871 and NOT backfillable, the same property `client_verdict` itself has —
   * and read the same way, as no evidence.
   */
  writerProvenance: PageViewWriter | null;
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
 * Whether the request carries what a same-origin `fetch` from our own bundle sends
 * (AECI-871). Applied only to a write the SSR Worker stamped `browser-spa`.
 *
 * Three requirements, and each is here for a stated reason:
 *
 *  - **`Sec-Fetch-Site: same-origin`** is the load-bearing one. A browser computes
 *    it from the initiator, a script cannot set it (it is a forbidden header name),
 *    and the tracker's POST to a relative `/api/page-views` always earns it.
 *  - **`Sec-Fetch-Dest: empty` OR `Sec-Fetch-Mode: cors`** — the fetch/XHR shape.
 *    Either, not both, because the pair is what the platform emits and a single
 *    missing value is not worth a downgrade; the discrimination is in the line
 *    above.
 *  - **`Accept-Language`** — near-universal in real browsers, routinely omitted by
 *    HTTP libraries. Weak alone, cheap here.
 *
 * Deliberately NOT tested: `Accept`. Angular's `HttpClient` sends
 * `application/json, text/plain, *&#47;*`, so the document-navigation rule
 * `acceptLooksLikeDocument` applies is exactly wrong for this path, and pinning the
 * literal Angular default would couple the verdict to an HTTP-client implementation
 * detail that a version bump can change under us. `Origin` is likewise skipped: it
 * is genuinely sent on every same-origin POST, but it says the same thing
 * `Sec-Fetch-Site` already said, and a second way to fail is a second way to
 * silently downgrade a real visitor.
 *
 * A browser too old to send `Sec-Fetch-*` at all (Safari before 16.4) lands on
 * `unknown` here rather than `browser`. That costs positive evidence and nothing
 * else — `unknown` is not in `NON_BROWSER_VERDICTS`, so such a row is never flagged
 * as automation (§13 D16).
 */
function looksLikeSameOriginFetch(headers: Headers): boolean {
  if (headers.get('sec-fetch-site') !== 'same-origin') return false;
  const isFetchShaped =
    headers.get('sec-fetch-dest') === 'empty' || headers.get('sec-fetch-mode') === 'cors';
  return isFetchShaped && Boolean(headers.get('accept-language'));
}

/**
 * Classify one capture's request shape.
 *
 * Which rule set applies is decided by the TRUSTED writer-provenance header, read
 * off `headers` (AECI-871) — never by the payload. `browser-spa` is judged as a
 * same-origin fetch; `ssr-arrival` and "no trusted provenance" are judged as a
 * document arrival, which is what the SSR path always is and what every row written
 * before AECI-585 implicitly was.
 *
 * `navigation` is still accepted because it is still a real field — it is the
 * writer's own CLAIM about the hop, stored for the arrival-vs-SPA breakdown. Here it
 * can only ever WITHHOLD a verdict: a body claiming `'spa'` that no trusted header
 * corroborates yields `unknown`. It can no longer grant one.
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
  const writerProvenance = readPageViewWriter(headers);

  const base = {
    secFetchDest,
    hasAcceptLanguage,
    hasSecChUa,
    tlsVersion: cf.tlsVersion || null,
    httpProtocol: cf.httpProtocol || null,
    writerProvenance,
  };

  // An in-app hop, vouched for by the SSR Worker rather than by the body. Judged
  // as the same-origin `fetch` it claims to be: the arrival rules below would fail
  // it by construction (`Sec-Fetch-Dest: empty`), and waving it through on the
  // strength of the claim alone is the defect AECI-871 closes. Failing the shape
  // test is `unknown`, never `non-browser` — an in-app hop that reached our Worker
  // and then lost its headers is an absence of evidence, not evidence of a bot.
  if (writerProvenance === 'browser-spa') {
    return { ...base, verdict: looksLikeSameOriginFetch(headers) ? 'browser' : 'unknown' };
  }

  // The body claims an in-app hop and nothing trusted agrees. Judging it by the
  // arrival rules would be wrong (a genuine SPA hop fails them by construction) and
  // trusting it is exactly what this issue removed, so decline to rule.
  if (navigation === 'spa' && writerProvenance !== 'ssr-arrival') {
    return { ...base, verdict: 'unknown' };
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
