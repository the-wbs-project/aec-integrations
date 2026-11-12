import { isPlatformServer } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState, inject, makeStateKey } from '@angular/core';
import type { ResolveFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { VendorLegalAcceptanceResponse } from '@aeci/shared';

import type { AeciRequestContext } from '../../server/request-context';

const PATH = '/api/vendor/legal-acceptance';
const STATE_KEY = makeStateKey<VendorLegalAcceptanceResponse | null>('aeci.vendor-legal');

/**
 * `/vendor/:vendorSlug/**` (AECI-1677): what this session must or may accept, read beside
 * `vendorMeResolver` so the first render, SSR included, already knows whether the portal
 * opens only the acceptance screen. Never a flash of tabs for a blocked company.
 *
 * FAIL OPEN. Any failure (a 403 for a non-vendor, a suspension, a 5xx) resolves `null`,
 * and `null` shows no screen and blocks nothing in the shell. The gate that matters is
 * the API's: it refuses a blocked company's writes whatever the shell shows
 * (`apps/api/src/lib/authz.ts`). The portal is never edge-cached, so this per-seat value
 * never reaches a cached page.
 */
export const vendorLegalResolver: ResolveFn<VendorLegalAcceptanceResponse | null> = async () => {
  const transferState = inject(TransferState);
  if (!isPlatformServer(inject(PLATFORM_ID))) {
    if (transferState.hasKey(STATE_KEY)) {
      const cached = transferState.get(STATE_KEY, null);
      transferState.remove(STATE_KEY);
      return cached;
    }
    try {
      return await firstValueFrom(inject(HttpClient).get<VendorLegalAcceptanceResponse>(PATH));
    } catch {
      return null;
    }
  }
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  let value: VendorLegalAcceptanceResponse | null = null;
  if (ctx) {
    try {
      value = await ctx.api.request<VendorLegalAcceptanceResponse>(PATH);
    } catch {
      value = null;
    }
  }
  transferState.set(STATE_KEY, value);
  return value;
};
