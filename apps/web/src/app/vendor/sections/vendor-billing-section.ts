import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  afterRenderEffect,
  DOCUMENT,
  computed,
  inject,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  type VendorAgreementAcceptance,
  type VendorBillingResponse,
} from '@aeci/shared';

import {
  LEGAL_ARCHIVES,
  legalArchivePath,
  legalPath,
  type LegalSlug,
} from '../../legal/legal-manifest';
import { formatTermDate } from '../../shared/term-date/format-term-date';
import { VendorBillingEmailForm } from '../components/vendor-billing-email-form';
import { VendorBillingLicenses } from '../components/vendor-billing-licenses';
import { VendorBillingStripePanel } from '../components/vendor-billing-stripe-panel';
import {
  VendorBillingStripeWatch,
  liveLicenseCount,
} from '../components/vendor-billing-stripe-watch';
import { VendorBillingSummary } from '../components/vendor-billing-summary';
import { VendorDocsLink } from '../components/vendor-docs-link';
import { VendorLicenseActions } from '../components/vendor-license-actions';
import { VendorLicenseAssign } from '../components/vendor-license-assign';
import { VendorPortalStore } from '../vendor-portal-store';

/** One acceptance row, with its labels and its link built once. */
interface AcceptanceRow {
  readonly acceptance: VendorAgreementAcceptance;
  readonly documentLabel: string;
  /** Where that exact version is readable, or `null` when no page serves it. */
  readonly href: string | null;
  readonly acceptedLabel: string;
}

/** `agreement_acceptances.document` to its public `/legal/*` slug. */
const DOCUMENT_SLUG: Readonly<Record<string, LegalSlug>> = {
  vendor_terms: 'vendor-terms',
  managed_plan: 'managed-plan-agreement',
};

/**
 * Where the accepted version can be read. The current version lives at
 * `/legal/<slug>`; a superseded one at `/legal/<slug>/v<version>` only once it is
 * archived (`legal-manifest.ts`). Anything else has no page, so no link.
 */
function acceptanceHref(document: string, version: string): string | null {
  const slug = DOCUMENT_SLUG[document];
  if (!slug) return null;
  const current = (LEGAL_AGREEMENT_CURRENT_VERSIONS as Readonly<Record<string, string>>)[document];
  if (current === version) return legalPath(slug);
  return LEGAL_ARCHIVES.some((a) => a.slug === slug && a.version === version)
    ? legalArchivePath(slug, version)
    : null;
}

function documentLabel(document: string): string {
  switch (document) {
    case 'vendor_terms':
      return $localize`:@@vendor.billing.doc.vendorTerms:Vendor terms`;
    case 'managed_plan':
      return $localize`:@@vendor.billing.doc.managedPlan:Managed plan agreement`;
    default:
      return document;
  }
}

/**
 * `…/billing`: the owner-only Billing tab (AECI-1390, E5.4;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21). The billing email, the company's
 * licenses and the agreements it accepted. A summary card in a right-hand column
 * counts the licenses (`VendorBillingSummary`). A "Learn more" link under the
 * intro opens the Billing help page (AECI-1400, E8.3).
 *
 * ── OWNERS ONLY ─────────────────────────────────────────────────────────────
 * Billing is an owner's act (decision 10). The nav drops the tab for a member seat
 * on `me.seat_owner`; a member who types the URL gets a short note here and NO
 * request, because both reads answer `403` to a member. The bit is a display hint:
 * the API re-checks it through `requireSeatOwner()`.
 *
 * ── STATE ───────────────────────────────────────────────────────────────────
 * The payload lives in {@link VendorPortalStore} (`billing`), loaded once from
 * `afterNextRender` and refetched when the `entitlement` cursor moves, which every
 * license write moves. SSR paints the loading state, so nothing billing-related is
 * ever in server HTML.
 *
 * ── ROW ACTIONS (AECI-1391, E5.5) ───────────────────────────────────────────
 * The licenses table's `rowActions` template: a live pool license gets the assign
 * control, a live assigned one the actions menu ("Release license", at renewal or
 * now), an ended one nothing. Each action is pessimistic and re-reads billing.
 * A successful assign swaps its row's control for the actions menu, so the section
 * moves focus to its trigger once the re-read renders (WCAG 2.4.3).
 *
 * A stale refusal (`409`/`404`: another owner or tab acted first) is the section's,
 * not the control's. The re-read that follows can swap or remove the control that
 * was refused, taking its error line and focus with it. So the control emits
 * `stale`, the section shows the message above the table, re-reads billing, and
 * then moves focus to that message if focus was lost or still in this section.
 *
 * ── PAYING BY CARD (AECI-1502, E9.4) ────────────────────────────────────────
 * When the read says `stripe_checkout_available`, the owner gets the "Pay by card"
 * panel (`VendorBillingStripePanel`) under the billing email: buy through Stripe
 * Checkout with no subscription, or add licenses and open the Customer Portal with
 * one. When it is false (production until the E9 switch-on, amendment R2) the panel
 * is not rendered at all.
 *
 * Stripe sends the owner back to `…/billing?checkout=success` or `=cancelled`. The
 * section reads that from `location.search` once after the first render, drops the
 * parameter from the URL (replacing the history entry), and shows a banner. On
 * success, {@link VendorBillingStripeWatch} re-reads billing every 3 s for up to
 * 60 s until the licenses land (ADR 0023: client revalidation, not sockets).
 */
@Component({
  selector: 'aec-vendor-billing-section',
  imports: [
    RouterLink,
    VendorBillingEmailForm,
    VendorBillingLicenses,
    VendorBillingStripePanel,
    VendorBillingSummary,
    VendorDocsLink,
    VendorLicenseActions,
    VendorLicenseAssign,
  ],
  providers: [VendorBillingStripeWatch],
  template: `
    <div [class]="topGridClass()">
      <div>
        <h2
          class="font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.section.billing"
        >
          Billing
        </h2>
        @if (!isOwner()) {
          <p
            class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
            data-testid="billing-owners-only"
            i18n="@@vendor.billing.ownersOnly"
          >
            Only account owners manage billing. Ask an owner on the Seats tab if something here
            needs to change.
          </p>
        } @else {
          <p
            class="mt-1 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.billing.intro"
          >
            Your company's Managed licenses are held here. Assign each one to a product to put it on
            Managed. Plans change what a listing can show, never where it ranks.
          </p>
          <p class="mt-1"><aec-vendor-docs-link page="billing" /></p>

          @if (stripeNotice(); as notice) {
            <div
              class="mt-4 flex items-start justify-between gap-4 rounded-(--radius-md) border border-(--border-default) p-4 text-sm"
              [class]="
                notice.kind === 'cancelled' ? 'bg-(--surface-raised)' : 'bg-(--accent-primary-soft)'
              "
              data-testid="billing-checkout-notice"
            >
              <div class="space-y-2">
                <p
                  class="font-semibold text-(--text-primary)"
                  data-testid="billing-checkout-notice-title"
                >
                  @switch (noticeKey()) {
                    @case ('cancelled') {
                      <ng-container i18n="@@vendor.billing.notice.cancelled.title"
                        >Checkout cancelled</ng-container
                      >
                    }
                    @case ('checkout-waiting') {
                      <ng-container i18n="@@vendor.billing.notice.checkoutWaiting.title"
                        >Checkout complete</ng-container
                      >
                    }
                    @case ('add-waiting') {
                      <ng-container i18n="@@vendor.billing.notice.addWaiting.title"
                        >Stripe accepted the change</ng-container
                      >
                    }
                    @case ('done') {
                      <ng-container i18n="@@vendor.billing.notice.done.title"
                        >Your new licenses are here</ng-container
                      >
                    }
                    @case ('timeout') {
                      <ng-container i18n="@@vendor.billing.notice.timeout.title"
                        >Your licenses have not arrived yet</ng-container
                      >
                    }
                  }
                </p>
                <p class="text-(--text-secondary)">
                  @switch (noticeKey()) {
                    @case ('cancelled') {
                      <ng-container i18n="@@vendor.billing.notice.cancelled.body"
                        >Nothing was charged. Your licenses are as they were.</ng-container
                      >
                    }
                    @case ('checkout-waiting') {
                      <ng-container i18n="@@vendor.billing.notice.waiting.body"
                        >Your new licenses appear below as soon as Stripe confirms the payment. This
                        usually takes a few seconds.</ng-container
                      >
                    }
                    @case ('add-waiting') {
                      <ng-container i18n="@@vendor.billing.notice.waiting.body"
                        >Your new licenses appear below as soon as Stripe confirms the payment. This
                        usually takes a few seconds.</ng-container
                      >
                    }
                    @case ('done') {
                      <ng-container i18n="@@vendor.billing.notice.done.body"
                        >Each new license is in the pool. Assign one to a product to put it on
                        Managed.</ng-container
                      >
                    }
                    @case ('timeout') {
                      <ng-container i18n="@@vendor.billing.notice.timeout.body"
                        >Stripe can take a few minutes to confirm a payment. They will appear here
                        when it does. If they have not arrived within an hour, contact AEC
                        Integrations.</ng-container
                      >
                    }
                  }
                </p>
                @if (noticeKey() === 'timeout') {
                  <button
                    type="button"
                    [class]="retryClass"
                    data-testid="billing-checkout-notice-retry"
                    (click)="watch.retry()"
                    i18n="@@vendor.billing.notice.timeout.retry"
                  >
                    Check again
                  </button>
                }
              </div>
              <button
                type="button"
                class="-me-1 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-(--radius-sm) text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n-aria-label="@@vendor.billing.notice.dismiss"
                aria-label="Dismiss"
                data-testid="billing-checkout-notice-dismiss"
                (click)="watch.dismiss()"
              >
                <svg
                  class="size-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          }

          @if (loading()) {
            <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@vendor.billing.loading">
              Loading billing…
            </p>
          } @else if (failed() && !billing()) {
            <div class="mt-4 flex flex-wrap items-center gap-3">
              <p class="text-sm text-(--text-primary)" i18n="@@vendor.billing.error">
                Could not load billing.
              </p>
              <button
                type="button"
                [class]="retryClass"
                (click)="retry()"
                i18n="@@vendor.billing.retry"
              >
                Try again
              </button>
            </div>
          } @else if (billing(); as b) {
            <section class="mt-6" aria-labelledby="vendor-billing-email-heading">
              <h3
                id="vendor-billing-email-heading"
                class="font-label text-sm font-semibold text-(--text-primary)"
                i18n="@@vendor.billing.email.heading"
              >
                Billing email
              </h3>
              <div class="mt-2">
                @if (b.billing_account; as account) {
                  <aec-vendor-billing-email-form [current]="account.billing_email" />
                } @else {
                  <p class="text-sm text-(--text-secondary)" i18n="@@vendor.billing.noAccount">
                    Your company has no billing account yet. Contact AEC Integrations to set one up.
                  </p>
                }
              </div>
            </section>
            @if (b.stripe_checkout_available && b.billing_account) {
              <aec-vendor-billing-stripe-panel class="mt-6" [billing]="b" />
            }
          }
        }
      </div>
      @if (isOwner() && !loading() && billing(); as b) {
        <aec-vendor-billing-summary
          [licenses]="b.licenses"
          [productsOnFree]="b.assignable_products.length"
          [truncated]="b.licenses_truncated"
        />
      }
    </div>

    @if (isOwner() && !loading() && billing(); as b) {
      <section class="mt-8" aria-labelledby="vendor-billing-licenses-heading">
        <h3
          id="vendor-billing-licenses-heading"
          class="font-label text-sm font-semibold text-(--text-primary)"
          i18n="@@vendor.billing.licenses.heading"
        >
          Licenses
        </h3>
        @if (staleNotice(); as message) {
          <p
            #staleNoticeEl
            role="alert"
            tabindex="-1"
            class="mt-2 text-sm font-medium text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            data-testid="billing-stale-notice"
          >
            {{ message }}
          </p>
        }
        <div class="mt-3">
          <aec-vendor-billing-licenses
            [licenses]="b.licenses"
            [truncated]="b.licenses_truncated"
            [rowActions]="licenseActions"
          />
          <ng-template #licenseActions let-row>
            @if (row.license.live) {
              @if (row.license.assigned_product) {
                <aec-vendor-license-actions [license]="row.license" (stale)="onStale($event)" />
              } @else {
                <aec-vendor-license-assign
                  [license]="row.license"
                  [products]="b.assignable_products"
                  (assigned)="focusActionsAfterAssign($event)"
                  (stale)="onStale($event)"
                />
              }
            }
          </ng-template>
        </div>
      </section>

      <section class="mt-8" aria-labelledby="vendor-billing-agreements-heading">
        <h3
          id="vendor-billing-agreements-heading"
          class="font-label text-sm font-semibold text-(--text-primary)"
          i18n="@@vendor.billing.agreements.heading"
        >
          Agreements
        </h3>
        <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@vendor.billing.agreements.intro">
          These are the agreements your company accepted.
        </p>
        @if (acceptanceRows().length === 0) {
          <p class="mt-3 text-sm text-(--text-secondary)" i18n="@@vendor.billing.agreements.empty">
            No agreements accepted yet.
          </p>
        } @else {
          <div class="mt-3 overflow-x-auto">
            <table class="w-full min-w-[32rem] border-collapse text-start text-sm">
              <caption class="sr-only" i18n="@@vendor.billing.agreements.caption">
                Accepted agreements
              </caption>
              <thead>
                <tr class="border-b border-(--border-default) text-(--text-secondary)">
                  <th scope="col" [class]="thClass" i18n="@@vendor.billing.agreements.col.doc">
                    Document
                  </th>
                  <th scope="col" [class]="thClass" i18n="@@vendor.billing.agreements.col.version">
                    Version
                  </th>
                  <th scope="col" [class]="thClass" i18n="@@vendor.billing.agreements.col.accepted">
                    Accepted
                  </th>
                  <th scope="col" [class]="thClass" i18n="@@vendor.billing.agreements.col.by">
                    By
                  </th>
                </tr>
              </thead>
              <tbody>
                @for (row of acceptanceRows(); track row.acceptance.id) {
                  <tr
                    class="border-b border-(--border-default) last:border-0"
                    data-testid="acceptance-row"
                  >
                    <td class="py-3 pe-4 text-(--text-primary)">{{ row.documentLabel }}</td>
                    <td class="py-3 pe-4">
                      @if (row.href; as href) {
                        <a
                          [routerLink]="href"
                          class="text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                          >{{ row.acceptance.version }}</a
                        >
                      } @else {
                        <span class="text-(--text-secondary)">{{ row.acceptance.version }}</span>
                      }
                    </td>
                    <td class="py-3 pe-4 text-(--text-secondary)">{{ row.acceptedLabel }}</td>
                    <td class="py-3 pe-4 text-(--text-secondary)">
                      {{ row.acceptance.email }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorBillingSection {
  private readonly store = inject(VendorPortalStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);
  protected readonly watch = inject(VendorBillingStripeWatch);
  protected readonly stripeNotice = this.watch.notice;
  /** The banner's copy key: the phases of a checkout and an add share their lines. */
  protected readonly noticeKey = computed(() => {
    const notice = this.stripeNotice();
    if (!notice) return null;
    if (notice.kind === 'cancelled') return 'cancelled';
    if (notice.phase === 'waiting')
      return notice.kind === 'checkout' ? 'checkout-waiting' : 'add-waiting';
    return notice.phase;
  });

  /**
   * After an assign: the license to focus, and the billing payload the write saw.
   * Focus moves once a newer payload has rendered, then this clears either way.
   */
  private readonly pendingFocus = signal<{
    readonly licenseId: string;
    readonly before: VendorBillingResponse | null;
  } | null>(null);
  /** A stale refusal's message, above the licenses table. It says what happened;
   *  the table below shows the current state. Replaced by the next refusal, and
   *  cleared by a successful assign. */
  protected readonly staleNotice = signal<string | null>(null);
  private readonly staleNoticeEl = viewChild<ElementRef<HTMLElement>>('staleNoticeEl');
  private readonly injector = inject(Injector);
  /** Declared in this template, so the query sees controls stamped into the table. */
  private readonly licenseActions = viewChildren(VendorLicenseActions);

  /** Absent `me` (never on a real route) reads as a member: fail closed. */
  protected readonly isOwner = computed(() => this.store.me()?.seat_owner === true);
  protected readonly billing = this.store.billing;
  protected readonly loading = this.store.billingLoading;
  protected readonly failed = this.store.billingFailed;

  protected readonly acceptanceRows = computed<readonly AcceptanceRow[]>(() =>
    this.store.acceptances().map((acceptance) => ({
      acceptance,
      documentLabel: documentLabel(acceptance.document),
      href: acceptanceHref(acceptance.document, acceptance.version),
      acceptedLabel: formatTermDate(acceptance.accepted_at, this.locale),
    })),
  );

  /** The summary card's column exists only when the card renders, so a member's
   *  note and the loading line keep the full width. */
  protected readonly topGridClass = computed(() =>
    this.isOwner() && !this.loading() && this.billing()
      ? 'grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-10'
      : 'block',
  );
  protected readonly thClass = 'py-2 pe-4 font-label font-semibold';
  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => {
      if (!this.isOwner()) return;
      const checkout = this.takeCheckoutParam();
      void this.store.ensure('billing').then(() => {
        if (checkout === 'success') this.watch.watch('checkout', liveLicenseCount(this.billing()));
        else if (checkout === 'cancelled') this.watch.cancelled();
      });
    });
    afterRenderEffect(() => {
      const pending = this.pendingFocus();
      if (!pending || this.billing() === pending.before) return;
      const target = this.licenseActions().find((s) => s.license().id === pending.licenseId);
      this.pendingFocus.set(null);
      // Only take focus back from <body> or this section. If the vendor moved on
      // while the re-read ran, leave them where they are.
      const doc = this.host.nativeElement.ownerDocument;
      const active = doc.activeElement;
      const lost = !active || active === doc.body || !active.isConnected;
      if (target && (lost || this.host.nativeElement.contains(active))) target.focus();
    });
  }

  protected focusActionsAfterAssign(licenseId: string): void {
    this.staleNotice.set(null);
    this.pendingFocus.set({ licenseId, before: this.billing() });
  }

  protected async onStale(message: string): Promise<void> {
    this.staleNotice.set(message);
    await this.store.reload('billing');
    afterNextRender(
      () => {
        const doc = this.host.nativeElement.ownerDocument;
        const active = doc.activeElement;
        const lost = !active || active === doc.body || !active.isConnected;
        if (lost || this.host.nativeElement.contains(active)) {
          this.staleNoticeEl()?.nativeElement.focus();
        }
      },
      { injector: this.injector },
    );
  }

  /**
   * Stripe's return marker, read once from `location.search` and then dropped from
   * the URL so a reload or a shared link never replays the banner. The router does
   * the drop, with `replaceUrl`, so its own URL state stays in step.
   */
  private takeCheckoutParam(): 'success' | 'cancelled' | null {
    const search = this.document.defaultView?.location.search ?? '';
    const value = new URLSearchParams(search).get('checkout');
    if (value === null) return null;
    const tree = this.router.parseUrl(this.router.url);
    delete tree.queryParams['checkout'];
    void this.router.navigateByUrl(tree, { replaceUrl: true });
    return value === 'success' || value === 'cancelled' ? value : null;
  }

  protected retry(): void {
    void this.store.reload('billing');
  }
}
