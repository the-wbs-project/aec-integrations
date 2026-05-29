/**
 * Resolver for `/categories` — the flat list of every category with product
 * counts (AECI-61, Phase 2 Spec §3.1). Mirrors the vendor/product detail
 * resolver SSR pattern but simpler: no slug, no 404 path (the list always
 * resolves), and no per-entity embedded tags — the `/categories` cache-tag set
 * (`route:index`, `index:categories`, `taxonomy`) is static and emitted by
 * `cacheTagInputsForPath`.
 *
 * Server flow: fetch `GET /api/categories` via the service binding, set the
 * index meta (`entity: 'index'` → `"Categories — AEC Integrations"`), store in
 * `TransferState`. Client flow: read the list back out of `TransferState`.
 */
import { isPlatformServer } from '@angular/common';
import {
  PLATFORM_ID,
  REQUEST,
  REQUEST_CONTEXT,
  TransferState,
  inject,
  makeStateKey,
} from '@angular/core';
import { ResolveFn } from '@angular/router';

import type { CategoriesListResponse } from '@aeci/shared';

import type { AeciRequestContext } from '../../server/request-context';
import { fetchCategoriesList } from '../core/api/taxonomy';
import { MetaService } from '../core/meta.service';

const STATE_KEY = makeStateKey<CategoriesListResponse | null>('aeci.categories-index');

export const categoriesIndexResolver: ResolveFn<CategoriesListResponse | null> = async () => {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);

  // Client hydration path — SSR populated TransferState; read it back.
  if (!isPlatformServer(platformId)) {
    return transferState.get(STATE_KEY, null);
  }

  // Server path.
  const meta = inject(MetaService);
  const request = inject(REQUEST, { optional: true });
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  const origin = request ? new URL(request.url).origin : 'https://aecintegrations.com';
  const canonical = `${origin}/categories`;

  if (!ctx) {
    transferState.set(STATE_KEY, null);
    return null;
  }

  const list = await fetchCategoriesList(ctx.api);
  transferState.set(STATE_KEY, list);

  meta.setEntityMeta({
    entity: 'index',
    name: $localize`:@@categories.index.metaName:Categories`,
    description: $localize`:@@categories.index.metaDescription:Browse every AEC software category on AEC Integrations, each with its live product count.`,
    canonical,
  });

  return list;
};
