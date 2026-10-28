import { DestroyRef, Injectable, inject, signal } from '@angular/core';

import type { VendorBillingResponse } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorPortalStore } from '../vendor-portal-store';

/** How often the tab re-reads billing while it waits for Stripe's licenses. */
export const STRIPE_WATCH_INTERVAL_MS = 3_000;
/** How long it waits before saying the licenses have not arrived yet. */
export const STRIPE_WATCH_TIMEOUT_MS = 60_000;

/** What the owner just did with Stripe. */
export type StripeWatchKind = 'checkout' | 'add';

/** The banner the Billing tab shows after a Stripe round trip. */
export type StripeNotice =
  | { readonly kind: StripeWatchKind; readonly phase: 'waiting' | 'done' | 'timeout' }
  | { readonly kind: 'cancelled' };

/** Live licenses in a billing read. */
export function liveLicenseCount(billing: VendorBillingResponse | null): number {
  return billing?.licenses.filter((l) => l.live).length ?? 0;
}

/**
 * The Billing tab's wait for Stripe's licenses (AECI-1502, E9.4; ADR 0023: client
 * revalidation, never sockets).
 *
 * Checkout and add only ask Stripe for money. The licenses land when the webhook
 * syncs the subscription (E9.2), seconds later. So after a checkout return or an
 * accepted add, the tab re-reads `GET /api/vendor/billing` every
 * {@link STRIPE_WATCH_INTERVAL_MS} until the live license count rises above the
 * count it started from, or a checkout's subscription appears, for at most
 * {@link STRIPE_WATCH_TIMEOUT_MS}. Then it stops and says so. The realtime cursor
 * still picks the licenses up later if they land after that.
 *
 * Provided by `VendorBillingSection`, so the banner (in the section) and the add
 * dialog (in the panel) share one watch, and leaving the tab stops it.
 */
// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- one watch per Billing tab, provided by the section so leaving the tab destroys it
@Injectable()
export class VendorBillingStripeWatch {
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  private readonly noticeSig = signal<StripeNotice | null>(null);
  readonly notice = this.noticeSig.asReadonly();

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The last wait, for "Check again" after a timeout. */
  private last: { readonly kind: StripeWatchKind; readonly baseline: number } | null = null;
  /** Bumped by every start and stop, so a tick from an older watch never writes. */
  private generation = 0;

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(() => this.stop());
  }

  /** The owner came back from a cancelled checkout. Nothing to wait for. */
  cancelled(): void {
    this.stop();
    this.noticeSig.set({ kind: 'cancelled' });
  }

  /**
   * Start waiting. `baseline` is the live license count before the licenses could
   * have landed. The current read is checked first, so a webhook that beat the
   * redirect back ends the wait at once.
   */
  watch(kind: StripeWatchKind, baseline: number): void {
    this.stop();
    this.last = { kind, baseline };
    const generation = this.generation;
    const arrived = (billing: VendorBillingResponse | null): boolean =>
      liveLicenseCount(billing) > baseline || (kind === 'checkout' && !!billing?.stripe);
    if (arrived(this.store.billing())) {
      this.show({ kind, phase: 'done' });
      return;
    }
    this.show({ kind, phase: 'waiting' });
    const attempts = Math.floor(STRIPE_WATCH_TIMEOUT_MS / STRIPE_WATCH_INTERVAL_MS);
    let attempt = 0;
    const tick = async (): Promise<void> => {
      this.timer = null;
      attempt++;
      await this.store.reload('billing');
      if (generation !== this.generation) return;
      if (arrived(this.store.billing())) {
        this.show({ kind, phase: 'done' });
      } else if (attempt >= attempts) {
        this.show({ kind, phase: 'timeout' });
      } else {
        this.timer = setTimeout(() => void tick(), STRIPE_WATCH_INTERVAL_MS);
      }
    };
    this.timer = setTimeout(() => void tick(), STRIPE_WATCH_INTERVAL_MS);
  }

  /** "Check again" after a timeout: the same wait, from the same baseline. */
  retry(): void {
    if (this.last) this.watch(this.last.kind, this.last.baseline);
  }

  /** Close the banner, and stop any wait behind it. */
  dismiss(): void {
    this.stop();
    this.noticeSig.set(null);
  }

  /** Whether a re-read is still scheduled. For the specs. */
  get polling(): boolean {
    return this.timer !== null;
  }

  /** Set the banner, and say the changes a sighted owner would see happen. The
   *  checkout return's first banner is on the page as it loads, so it is not said. */
  private show(notice: StripeNotice): void {
    this.noticeSig.set(notice);
    if (notice.kind === 'cancelled') return;
    if (notice.phase === 'done') {
      this.announcer.announce(
        $localize`:@@vendor.billing.notice.done.announce:Your new licenses are here.`,
      );
    } else if (notice.phase === 'timeout') {
      this.announcer.announce(
        $localize`:@@vendor.billing.notice.timeout.announce:Your licenses have not arrived yet. Stripe can take a few minutes to confirm a payment.`,
      );
    } else if (notice.kind === 'add') {
      this.announcer.announce(
        $localize`:@@vendor.billing.notice.addWaiting.announce:Stripe accepted the change. Your new licenses appear as soon as Stripe confirms the payment.`,
      );
    }
  }

  private stop(): void {
    this.generation++;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
