import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { tap } from 'rxjs';

import type { ApiErrorCode } from '@aeci/shared';

/** Type-checked against the shared code, with no runtime import of the barrel. */
const LEGAL_ACCEPTANCE_REQUIRED: typeof ApiErrorCode.LEGAL_ACCEPTANCE_REQUIRED =
  'LEGAL_ACCEPTANCE_REQUIRED';

/** A `403 LEGAL_ACCEPTANCE_REQUIRED` from the vendor guard (AECI-1677, ruling 24). */
export function isLegalAcceptanceRequired(err: unknown): boolean {
  return (
    err instanceof HttpErrorResponse &&
    err.status === 403 &&
    (err.error as { error?: { code?: unknown } } | null)?.error?.code === LEGAL_ACCEPTANCE_REQUIRED
  );
}

/**
 * The portal hears that its company just became blocked (AECI-1677). A Vendor Terms version
 * can take effect while a seat has the portal open: the next write answers
 * `403 LEGAL_ACCEPTANCE_REQUIRED`. Each one bumps {@link count}, and
 * `VendorLegalAcceptanceState` re-reads the screen's state, so the acceptance screen
 * replaces the tabs instead of a section showing a generic refusal.
 */
@Injectable({ providedIn: 'root' })
export class VendorLegalRequiredEvents {
  readonly count = signal(0);

  notify(): void {
    this.count.update((n) => n + 1);
  }
}

/**
 * Registered on the `/vendor/:vendorSlug` route only (`vendor.routes.ts`), with
 * `withRequestsMadeViaParent()`, so it sees the portal's calls and nothing else, and the
 * app-wide interceptors still run. One place, not one per section.
 */
export const vendorLegalRequiredInterceptor: HttpInterceptorFn = (req, next) => {
  const events = inject(VendorLegalRequiredEvents);
  return next(req).pipe(
    tap({
      error: (err: unknown) => {
        if (req.url.startsWith('/api/vendor/') && isLegalAcceptanceRequired(err)) events.notify();
      },
    }),
  );
};
