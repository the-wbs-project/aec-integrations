import { Injectable, computed, signal } from '@angular/core';

import type { PlanInterest, RequestTargetType } from '@aeci/shared';

import type { ClaimDialogEntry, PlanCtaPage } from '../../analytics/analytics';

/**
 * Where every claim dialog trigger points without JS, before hydration, on a page
 * with no host, or on a modified click (`VENDOR_PROGRAM_PAGE_SPEC.md` §15.1): the
 * search page, the same place the header search box falls back to. A visitor finds
 * the listing there, and the listing carries its own claim form. Changed from the
 * vendor program page's Find your product section when that section was removed
 * (2026-10-12).
 */
export const CLAIM_DIALOG_FALLBACK_HREF = '/search';

/** A catalog listing the visitor chose in step 1. */
export interface ClaimListing {
  readonly targetType: RequestTargetType;
  readonly slug: string;
  readonly name: string;
}

/** How the dialog was opened. */
export interface ClaimDialogOpening {
  readonly page: PlanCtaPage;
  readonly entry: ClaimDialogEntry;
  /** Seeds step 3: Managed from a Managed control, Free from the Free card. */
  readonly plan?: PlanInterest | null;
}

/**
 * Root state for the one claim dialog on a page (AECI-1293), the `PlanInquiryService`
 * pattern. Every "Claim your listing" and "Start with Managed" control opens it
 * through here; `ClaimDialogHost` mounts the dialog.
 *
 * **Why an opener callback, not an effect.** `BrnDialog.open()` throws NG0602 inside
 * an `effect()`. The dialog registers a plain callback, and `open()` calls it from the
 * click handler. The first click arrives before the `@defer`-loaded dialog exists, so
 * the dialog opens itself after its first render, because `isOpen()` is already true.
 *
 * SSR-neutral: a fresh service is closed and has no host, so cached HTML is the same
 * for every visitor.
 */
@Injectable({ providedIn: 'root' })
export class ClaimDialogService {
  private readonly active = signal<ClaimDialogOpening | null>(null);
  private readonly hosts = signal(0);
  private opener: (() => void) | null = null;

  /** How the open dialog was opened, or `null` when it is closed. */
  readonly opening = this.active.asReadonly();
  readonly isOpen = computed(() => this.active() !== null);
  /** Whether a `ClaimDialogHost` is mounted. With none, a trigger follows its link. */
  readonly hosted = computed(() => this.hosts() > 0);

  open(opening: ClaimDialogOpening): void {
    this.active.set(opening);
    this.opener?.();
  }

  /** Every close: Escape, the backdrop, the close button, Done. */
  close(): void {
    this.active.set(null);
  }

  /** A host mounts. Returns its unmount. */
  attachHost(): () => void {
    this.hosts.update((n) => n + 1);
    return () => {
      this.hosts.update((n) => n - 1);
      this.active.set(null);
    };
  }

  /** The dialog hands over its imperative `open()`. Returns its removal. */
  registerOpener(opener: () => void): () => void {
    this.opener = opener;
    return () => {
      if (this.opener === opener) this.opener = null;
    };
  }
}
