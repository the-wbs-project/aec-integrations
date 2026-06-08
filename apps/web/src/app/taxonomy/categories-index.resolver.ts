/**
 * Resolver for `/categories` — the flat list of every category with product
 * counts (AECI-61, Phase 2 Spec §3.1). Mirrors the detail/browse resolver SSR
 * pattern but simpler: no slug, no 404 path (the list always resolves), and no
 * per-entity embedded tags — the `/categories` cache-tag set (`route:index`,
 * `index:categories`, `taxonomy`) is static and emitted by `cacheTagInputsForPath`.
 *
 * Server flow: fetch `GET /api/categories` via the service binding, set the
 * index meta, store in `TransferState`.
 *
 * Client flow (AECI-151): on hydration / back-nav read the list out of
 * `TransferState`; on a genuine client navigation (no key) fetch it from the
 * browser via the same-origin `/api/*` passthrough and set the index meta. Before
 * this fix the client branch returned `null` on a client nav → the page rendered
 * an empty category list (the surface AECI-151's scope undercounted).
 */
import { isPlatformServer } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState, inject, makeStateKey } from '@angular/core';
import { ResolveFn } from '@angular/router';

import type { CategoriesListResponse } from '@aeci/shared';

import type { AeciRequestContext } from '../../server/request-context';
import { httpGetOrNull } from '../core/api/http-get-or-null';
import { fetchCategoriesList } from '../core/api/taxonomy';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';

const STATE_KEY = makeStateKey<CategoriesListResponse | null>('aeci.categories-index');

/** Index head metadata. Shared by the server and client branches. */
function setIndexMeta(meta: MetaService, canonical: string): void {
  meta.setEntityMeta({
    entity: 'index',
    name: $localize`:@@categories.index.metaName:Categories`,
    description: $localize`:@@categories.index.metaDescription:Browse every AEC software category on AEC Integrations, each with its live product count.`,
    canonical,
  });
}

export const categoriesIndexResolver: ResolveFn<CategoriesListResponse | null> = async () => {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const meta = inject(MetaService);
  const canonical = canonicalUrl('/categories');

  // ── Client path: in-app navigation or initial hydration (AECI-151). ───────
  if (!isPlatformServer(platformId)) {
    // Hydration / back-nav → reuse the SSR-stored list. Genuine client nav (no
    // key) → fetch from the browser via the same-origin `/api/*` passthrough.
    const list = transferState.hasKey(STATE_KEY)
      ? transferState.get(STATE_KEY, null)
      : await httpGetOrNull<CategoriesListResponse>(inject(HttpClient), '/api/categories');
    // Re-apply index meta client-side (idempotent on hydration; the only meta
    // update on a client nav, since the server branch never ran).
    if (list) setIndexMeta(meta, canonical);
    return list;
  }

  // ── Server path. ──────────────────────────────────────────────────────────
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;

  if (!ctx) {
    transferState.set(STATE_KEY, null);
    return null;
  }

  const list = await fetchCategoriesList(ctx.api);
  transferState.set(STATE_KEY, list);
  setIndexMeta(meta, canonical);

  return list;
};
