import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';

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
import { VendorLicenseAssign } from '../components/vendor-license-assign';
import { VendorLicenseReleaseRequest } from '../components/vendor-license-release-request';
import { VendorLicenseReleaseSwitch } from '../components/vendor-license-release-switch';
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
 * licenses and the agreements it accepted.
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
 * control, a live assigned one the release-at-renewal switch and the early-unassign
 * request, an ended one nothing. Each action is pessimistic and re-reads billing.
 * A successful assign swaps its row's control for the switch, so the section moves
 * focus to that switch once the re-read renders (WCAG 2.4.3).
 *
 * A stale refusal (`409`/`404`: another owner or tab acted first) is the section's,
 * not the control's. The re-read that follows can swap or remove the control that
 * was refused, taking its error line and focus with it. So the control emits
 * `stale`, the section shows the message above the table, re-reads billing, and
 * then moves focus to that message if focus was lost or still in this section.
 *
 * No buy button, no price, no Stripe: AECi grants licenses for pilots, and buying
 * arrives with E9.
 */
@Component({
  selector: 'aec-vendor-billing-section',
  imports: [
    RouterLink,
    VendorBillingEmailForm,
    VendorBillingLicenses,
    VendorLicenseAssign,
    VendorLicenseReleaseRequest,
    VendorLicenseReleaseSwitch,
  ],
  template: `
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
        Only account owners manage billing. Ask an owner on the Seats tab if something here needs to
        change.
      </p>
    } @else {
      <p class="mt-1 text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.billing.intro">
        A license covers one product. Plans change what a listing can show, never where it ranks.
      </p>

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
                  <div class="flex flex-col items-end gap-3">
                    <aec-vendor-license-release-switch
                      [license]="row.license"
                      (stale)="onStale($event)"
                    />
                    <aec-vendor-license-release-request
                      [license]="row.license"
                      (stale)="onStale($event)"
                    />
                  </div>
                } @else {
                  <aec-vendor-license-assign
                    [license]="row.license"
                    [products]="b.assignable_products"
                    (assigned)="focusSwitchAfterAssign($event)"
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
            <p
              class="mt-3 text-sm text-(--text-secondary)"
              i18n="@@vendor.billing.agreements.empty"
            >
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
                    <th
                      scope="col"
                      [class]="thClass"
                      i18n="@@vendor.billing.agreements.col.version"
                    >
                      Version
                    </th>
                    <th
                      scope="col"
                      [class]="thClass"
                      i18n="@@vendor.billing.agreements.col.accepted"
                    >
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
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorBillingSection {
  private readonly store = inject(VendorPortalStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
  /** Declared in this template, so the query sees switches stamped into the table. */
  private readonly releaseSwitches = viewChildren(VendorLicenseReleaseSwitch);

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

  protected readonly thClass = 'py-2 pe-4 font-label font-semibold';
  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => {
      if (this.isOwner()) void this.store.ensure('billing');
    });
    afterRenderEffect(() => {
      const pending = this.pendingFocus();
      if (!pending || this.billing() === pending.before) return;
      const target = this.releaseSwitches().find((s) => s.license().id === pending.licenseId);
      this.pendingFocus.set(null);
      // Only take focus back from <body> or this section. If the vendor moved on
      // while the re-read ran, leave them where they are.
      const doc = this.host.nativeElement.ownerDocument;
      const active = doc.activeElement;
      const lost = !active || active === doc.body || !active.isConnected;
      if (target && (lost || this.host.nativeElement.contains(active))) target.focus();
    });
  }

  protected focusSwitchAfterAssign(licenseId: string): void {
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

  protected retry(): void {
    void this.store.reload('billing');
  }
}
