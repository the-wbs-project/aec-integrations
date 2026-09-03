import { Injectable, computed, signal } from '@angular/core';

import type { RequestKind, RequestTargetType } from '@aeci/shared';

/** The (entity, kind, slug) a drawer is showing — the same triple the routed
 *  `/products|vendors/:slug/{claim,correction}` page reads from its route.
 *
 *  `claimed` is copy-only and `'claim'`-only: the detail page already holds the
 *  built-by vendor's `verified` bit, so it tells the drawer whether to open as a
 *  first claim ("Claim this listing") or as an access request against a listing a
 *  verified vendor already manages. It changes no field, no endpoint and no
 *  payload — both states POST the same `kind:'claim'` request, because seats are
 *  admin-granted and multi-seat (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11), so a
 *  second person at the vendor has no other route in. Optional and defaulting to
 *  false so the routed fallback page — which resolves no vendor data — keeps the
 *  neutral wording. */
export interface RequestDrawerTarget {
  readonly entity: RequestTargetType;
  readonly kind: RequestKind;
  readonly slug: string;
  readonly claimed?: boolean;
}

/**
 * Root state for the in-place claim/correction drawer (AECI-128). Holds the one
 * active target (or `null` when closed). Decouples the triggers — which can sit
 * anywhere on a detail page (the metadata-sidebar CTAs *and* the empty-state inline
 * link) — from the single `RequestDrawer` instance mounted once per page.
 *
 * SSR-neutral: a fresh service starts `null`, so cacheable detail-page HTML renders
 * with the drawer closed regardless of any later client interaction.
 */
@Injectable({ providedIn: 'root' })
export class RequestDrawerService {
  private readonly active = signal<RequestDrawerTarget | null>(null);

  /** The active target, or `null` when the drawer is closed. */
  readonly target = this.active.asReadonly();

  /** Drives `BrnDialog`'s controlled `state` input. */
  readonly isOpen = computed(() => this.active() !== null);

  open(target: RequestDrawerTarget): void {
    this.active.set(target);
  }

  close(): void {
    this.active.set(null);
  }
}
