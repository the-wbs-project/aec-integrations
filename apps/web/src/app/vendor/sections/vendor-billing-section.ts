import { Component, LOCALE_ID, afterNextRender, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LEGAL_AGREEMENT_CURRENT_VERSIONS, type VendorAgreementAcceptance } from '@aeci/shared';

import {
  LEGAL_ARCHIVES,
  legalArchivePath,
  legalPath,
  type LegalSlug,
} from '../../legal/legal-manifest';
import { formatTermDate } from '../../shared/term-date/format-term-date';
import { VendorBillingEmailForm } from '../components/vendor-billing-email-form';
import { VendorBillingLicenses } from '../components/vendor-billing-licenses';
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
 * No buy button, no price, no Stripe: AECi grants licenses for pilots, and buying
 * arrives with E9.
 */
@Component({
  selector: 'aec-vendor-billing-section',
  imports: [RouterLink, VendorBillingEmailForm, VendorBillingLicenses],
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
          <div class="mt-3">
            <!-- E5.5 passes its row actions to this table through rowActions. -->
            <aec-vendor-billing-licenses
              [licenses]="b.licenses"
              [truncated]="b.licenses_truncated"
            />
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
  }

  protected retry(): void {
    void this.store.reload('billing');
  }
}
