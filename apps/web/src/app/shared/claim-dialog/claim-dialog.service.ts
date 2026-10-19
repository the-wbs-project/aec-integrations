import { Injectable, computed, signal } from '@angular/core';

import type { RequestTargetType } from '@aeci/shared';

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
  /**
   * The company the claim is on (AECI-1364, `docs/VENDOR_SIGNUP_PROCESS.md`
   * decision 1). A vendor hit is the company itself. A product hit carries its
   * vendor's name from the search record (`vendor_name`) but no vendor slug, so the
   * dialog shows the name and the API resolves the id. `null` when a product hit has
   * no vendor name.
   */
  readonly company: string | null;
  /** The product a claim was started from ("from the <Product> page"), or `null`
   *  for a company hit. */
  readonly product: string | null;
}

/** How the dialog was opened. */
export interface ClaimDialogOpening {
  readonly page: PlanCtaPage;
  readonly entry: ClaimDialogEntry;
}

/**
 * Root state for the one claim dialog on a page (AECI-1293): a root service that
 * holds the open state and the opener the dialog registers. Every "Claim your listing" control opens it
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
  private readonly companyName = signal<string | null>(null);
  private opener: (() => void) | null = null;

  /** How the open dialog was opened, or `null` when it is closed. */
  readonly opening = this.active.asReadonly();
  readonly isOpen = computed(() => this.active() !== null);
  /** Whether a `ClaimDialogHost` is mounted. With none, a trigger follows its link. */
  readonly hosted = computed(() => this.hosts() > 0);
  /**
   * The company the open dialog is claiming, for its "Claim <Company>" title
   * (AECI-1364). `null` on the Find step and on the typed-in path, which read
   * "Claim your company". The flow sets it; the shell reads it.
   */
  readonly company = this.companyName.asReadonly();

  open(opening: ClaimDialogOpening): void {
    this.companyName.set(null);
    this.active.set(opening);
    this.opener?.();
  }

  /** Every close: Escape, the backdrop, the close button, Done. */
  close(): void {
    this.active.set(null);
    this.companyName.set(null);
  }

  /** The flow names the company once it is known, and clears it on the Find step. */
  setCompany(name: string | null): void {
    this.companyName.set(name);
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
