/**
 * Whether the page's upcoming version is in force for this request (AECI-1689). The
 * `legalSwitched` route data every `/legal/*` route resolves. `LegalPage` renders from it
 * through `resolveLegalView` (`legal-in-force-state.ts`).
 *
 * ── SERVER: DECIDE PER REQUEST ───────────────────────────────────────────────────
 *   - No upcoming entry for the slug: `false`, nothing read, nothing transferred. With
 *     today's empty manifest every legal page takes this branch, so it renders as before.
 *   - The entry's moment has not come (the SSR clock): `false`. Nothing is read: a
 *     publish before the moment changes nothing before it.
 *   - It has come, and it is publishable (an agreement, since AECI-1637 the Terms of
 *     Service or the Privacy Policy, and since AECI-1969 the two policies): ask `GET /api/legal/published` over the
 *     service binding. Its row decides. If the read FAILS, fail safe: `false` (the old
 *     version stays current) and mark the request context, so the SSR Worker caches the
 *     page briefly instead of for a day (`server-runtime.ts`, `CACHE_STRATEGY.md` §4).
 *
 * The answer goes into `TransferState` under a key naming every axis it depends on: the
 * slug, the upcoming version and its day. The time is not an axis: it is what is being
 * decided, and the browser must not re-decide it with its own clock.
 *
 * ── BROWSER ──────────────────────────────────────────────────────────────────────
 *   - Hydration: the server's answer from `TransferState`, read once and removed.
 *   - An in-app navigation (no transferred answer): ask `/api/legal/published` and decide
 *     with ITS `now`, the API's clock, never the browser's. A failed read is `false`.
 *
 * Lazy-loaded from `app.routes.ts`, so the manifest stays out of the initial bundle.
 */
import { isPlatformServer } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState, inject, makeStateKey } from '@angular/core';
import type { ActivatedRouteSnapshot } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { legalPublishedLiteOf, type LegalPublishedLite } from '@aeci/shared/api/legal-in-force';
import type { LegalPublishedResponse } from '@aeci/shared/api/legal-versions';

import type { AeciRequestContext } from '../../server/request-context';
import {
  legalEntryMomentReached,
  legalEntrySwitched,
  publishableOfSlug,
} from './legal-in-force-state';
import type { LegalSlug, LegalUpcomingEntry } from './legal-manifest';
import { LEGAL_UPCOMING_ENTRIES } from './legal-upcoming-token';

/** The public read both sides ask. */
export const LEGAL_PUBLISHED_PATH = '/api/legal/published';

/** The `TransferState` key of one slug's answer: every axis it depends on. */
export function legalSwitchedKey(entry: LegalUpcomingEntry) {
  return makeStateKey<boolean>(
    `aeci.legal-switched:${entry.slug}:v${entry.version}:${entry.effectiveOn}`,
  );
}

/** The slug a `/legal/*` route renders: `data.slug`, or the version route's path param. */
function slugOf(route: ActivatedRouteSnapshot): string | null {
  return (route.data['slug'] as string | undefined) ?? route.paramMap.get('slug');
}

/**
 * The resolver body. Call it inside an injection context: every `inject` runs before
 * the first `await`.
 */
export function resolveLegalSwitched(route: ActivatedRouteSnapshot): Promise<boolean> {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const upcoming = inject(LEGAL_UPCOMING_ENTRIES);
  const entry = upcoming.find((u) => u.slug === slugOf(route));
  if (!entry) return Promise.resolve(false);
  const key = legalSwitchedKey(entry);

  if (!isPlatformServer(platformId)) {
    if (transferState.hasKey(key)) {
      const answer = transferState.get(key, false);
      transferState.remove(key);
      return Promise.resolve(answer);
    }
    const http = inject(HttpClient);
    return firstValueFrom(http.get<LegalPublishedResponse>(LEGAL_PUBLISHED_PATH)).then(
      (res) => legalEntrySwitched(entry, legalPublishedLiteOf(res.published), Date.parse(res.now)),
      () => false,
    );
  }

  const ctx = inject(REQUEST_CONTEXT, { optional: true }) as AeciRequestContext | null;
  return decideOnServer(entry, Date.now(), ctx).then((answer) => {
    transferState.set(key, answer);
    return answer;
  });
}

/** The server branch (module header). Exported for its spec. */
export async function decideOnServer(
  entry: LegalUpcomingEntry,
  nowMs: number,
  ctx: AeciRequestContext | null,
): Promise<boolean> {
  const answers = await decideAllOnServer([entry], nowMs, ctx);
  return answers[entry.slug as LegalSlug] === true;
}

/** Each slug's answer. A slug with no upcoming entry is absent, which reads as `false`. */
export type LegalSwitchedMap = Readonly<Partial<Record<LegalSlug, boolean>>>;

/**
 * The server branch for several entries at once (AECI-2237, the `/legal` index). Each
 * entry is decided as {@link decideOnServer} decides it, and every entry that needs the
 * published rows shares one read. A failed read answers `false` for each of them and
 * flags the request, so the page is cached for a minute.
 */
export async function decideAllOnServer(
  entries: readonly LegalUpcomingEntry[],
  nowMs: number,
  ctx: AeciRequestContext | null,
): Promise<LegalSwitchedMap> {
  const answers: Partial<Record<LegalSlug, boolean>> = {};
  const needRead: LegalUpcomingEntry[] = [];
  for (const entry of entries) {
    const slug = entry.slug as LegalSlug;
    if (!legalEntryMomentReached(entry, nowMs)) answers[slug] = false;
    else if (publishableOfSlug(slug) === undefined) answers[slug] = true;
    else needRead.push(entry);
  }
  if (needRead.length === 0) return answers;
  let published: LegalPublishedLite[] | null = null;
  if (ctx) {
    try {
      const res = await ctx.api.request<LegalPublishedResponse>(LEGAL_PUBLISHED_PATH);
      published = legalPublishedLiteOf(res.published);
    } catch {
      // Fail safe: keep the old version current, and keep this page out of the long cache.
      ctx.legalStateUncertain = true;
    }
  }
  for (const entry of needRead) {
    answers[entry.slug as LegalSlug] =
      published !== null && legalEntrySwitched(entry, published, nowMs);
  }
  return answers;
}

/**
 * The `legalSwitched` data of the `/legal` index (AECI-2237): every slug's answer, decided
 * as each document page decides its own, under the same `TransferState` keys. Call it
 * inside an injection context: every `inject` runs before the first `await`.
 */
export function resolveLegalSwitchedAll(): Promise<LegalSwitchedMap> {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const upcoming = inject(LEGAL_UPCOMING_ENTRIES);
  if (upcoming.length === 0) return Promise.resolve({});

  if (!isPlatformServer(platformId)) {
    const answers: Partial<Record<LegalSlug, boolean>> = {};
    const missing: LegalUpcomingEntry[] = [];
    for (const entry of upcoming) {
      const key = legalSwitchedKey(entry);
      if (transferState.hasKey(key)) {
        answers[entry.slug as LegalSlug] = transferState.get(key, false);
        transferState.remove(key);
      } else {
        missing.push(entry);
      }
    }
    if (missing.length === 0) return Promise.resolve(answers);
    const http = inject(HttpClient);
    return firstValueFrom(http.get<LegalPublishedResponse>(LEGAL_PUBLISHED_PATH)).then(
      (res) => {
        const published = legalPublishedLiteOf(res.published);
        const nowMs = Date.parse(res.now);
        for (const entry of missing) {
          answers[entry.slug as LegalSlug] = legalEntrySwitched(entry, published, nowMs);
        }
        return answers;
      },
      () => {
        for (const entry of missing) answers[entry.slug as LegalSlug] = false;
        return answers;
      },
    );
  }

  const ctx = inject(REQUEST_CONTEXT, { optional: true }) as AeciRequestContext | null;
  return decideAllOnServer(upcoming, Date.now(), ctx).then((answers) => {
    for (const entry of upcoming) {
      transferState.set(legalSwitchedKey(entry), answers[entry.slug as LegalSlug] === true);
    }
    return answers;
  });
}
