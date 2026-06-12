import { Injectable, computed, signal } from '@angular/core';

import type { RequestKind, RequestTargetType } from '@aeci/shared';

/** The (entity, kind, slug) a drawer is showing — the same triple the routed
 *  `/products|vendors/:slug/{claim,correction}` page reads from its route. */
export interface RequestDrawerTarget {
  readonly entity: RequestTargetType;
  readonly kind: RequestKind;
  readonly slug: string;
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
