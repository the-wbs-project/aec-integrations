import { Injectable, computed, signal } from '@angular/core';

import type { PlanCtaPage, PlanInquiryPlacement } from '../../analytics/analytics';

/**
 * Root state for the one plan inquiry dialog on a page (AECI-1279). Five "Talk to us
 * about Managed" buttons on the Plans page share one dialog, mounted by
 * `PlanInquiryHost`; this service is what connects them. Modelled on
 * `RequestDrawerService`.
 *
 * **Why an opener callback rather than an effect.** `BrnDialog.open()` throws NG0602
 * when called inside an `effect()`. So the dialog registers a plain callback here, and
 * `open()` calls it straight from the button's click handler. The first click happens
 * before the `@defer`-loaded dialog exists, so there is no callback yet: the dialog
 * then opens itself once, after its first render, because `isOpen()` is already true.
 *
 * The opening button's `placement` and `page` ride along, so the form can report
 * both on `plan_inquiry_submitted` (`VENDOR_PROGRAM_PAGE_SPEC.md` §9).
 *
 * SSR-neutral: a fresh service is closed and has no host, so the cached Plans-page
 * HTML is the same for every visitor.
 */
@Injectable({ providedIn: 'root' })
export class PlanInquiryService {
  private readonly active = signal<{
    placement: PlanInquiryPlacement;
    page: PlanCtaPage;
  } | null>(null);
  private readonly hosts = signal(0);
  private opener: (() => void) | null = null;

  /** The button that opened the dialog, or `null` when it is closed. */
  readonly placement = computed(() => this.active()?.placement ?? null);
  /** The page that button sits on, or `null` when the dialog is closed. */
  readonly page = computed(() => this.active()?.page ?? null);
  readonly isOpen = computed(() => this.active() !== null);
  /** Whether a `PlanInquiryHost` is mounted. With none, a trigger leaves the link alone. */
  readonly hosted = computed(() => this.hosts() > 0);

  open(placement: PlanInquiryPlacement, page: PlanCtaPage): void {
    this.active.set({ placement, page });
    this.opener?.();
  }

  /** Called on every close: Escape, the backdrop, the close button. */
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
