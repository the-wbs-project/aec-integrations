import { Injectable, computed, signal } from '@angular/core';

import type { RequestKind, RequestTargetType } from '@aeci/shared';

/** The (entity, kind, slug) a drawer is showing — the same triple the routed
 *  `/products|vendors/:slug/{claim,correction}` page reads from its route.
 *
 *  There is no "already claimed" axis (AECI-1266). A claim drawer reads the same
 *  on every listing, whether nobody at the vendor holds a seat yet or a colleague
 *  already does: both cases POST the same `kind:'claim'` request, because seats
 *  are admin-granted and multi-seat (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11). A
 *  state-dependent wording would tell visitors which vendors hold a paid plan. */
export interface RequestDrawerTarget {
  readonly entity: RequestTargetType;
  readonly kind: RequestKind;
  readonly slug: string;
  /** Seed text for the free-text `body` field (AECI-967). DRAWER-ONLY and
   *  optional: it is context the *opening surface* knows and the request record
   *  does not. The submitted request already carries `(target_type, slug)`, so a
   *  trigger whose context is just "this product" passes nothing — the vendor
   *  portal's rename hint is exactly that case. The vendor-portal conflict lane
   *  is the case that earns it: which disputed data flow, and against which
   *  counterpart, is recorded nowhere in a correction.
   *
   *  It is a SEED, not a value. The vendor may edit or clear it, and it is
   *  validated like anything else the visitor typed.
   *
   *  The routed `/…/{claim,correction}` fallback page has no equivalent, and that
   *  is deliberate — see `RequestFormBody.bodyPrefill`. */
  readonly bodyPrefill?: string;
  /** AECI-1364: the company a claim is on, for the "Claim <Company>" title. The
   *  opening detail page already holds it (a product's vendor, or the vendor
   *  itself). Absent reads "Claim your company". Display only. */
  readonly company?: string;
  /** AECI-1364: the product page a claim was opened from, for "from the <Product>
   *  page". Absent on a company page. Display only: the API resolves the company. */
  readonly contextProduct?: string;
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
