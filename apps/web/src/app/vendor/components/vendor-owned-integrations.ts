import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChildren,
} from '@angular/core';

import { RouterLink } from '@angular/router';

import { isSyncService, type OwnedIntegration } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationEditForm, type EditFormValues } from './vendor-integration-edit-form';
import { VENDOR_EDIT_FORM_START_OPEN } from './vendor-integration-edit-form';
import { VendorDocsLink } from './vendor-docs-link';
import { claimErrorMessage } from './vendor-integration-ownership-labels';
import { VendorNotOurs, selfDisclaimOn, selfDisclaimStands } from './vendor-not-ours';
import { VendorOwnedRetire } from './vendor-owned-retire';
import { VendorOwnedFlows } from './vendor-owned-flows';
import {
  ownedRowClaimedAnnouncement,
  ownedRowRoute,
  ownedRowState,
  ownedRowStatusLine,
  ownedRowTitle,
  type OwnedRowState,
} from './vendor-owned-row-model';

export type { OwnedRowState } from './vendor-owned-row-model';

/**
 * Which owned rows a product's tab lists: the rows that touch this product as an
 * endpoint or as the connector, plus the rows that touch none of the vendor's
 * products at all. The second group has no natural tab, so it is shown on every
 * tab rather than hidden on all of them.
 */
export function ownedRowsForProduct(
  rows: readonly OwnedIntegration[],
  contextProductId: string,
  vendorProductIds: ReadonlySet<string>,
): OwnedIntegration[] {
  return rows.filter((row) => {
    const touched = [row.product_a.id, row.product_b.id, row.connector?.id].filter(
      (id): id is string => typeof id === 'string',
    );
    if (touched.includes(contextProductId)) return true;
    return !touched.some((id) => vendorProductIds.has(id));
  });
}

/** Which owned rows one list on a tab shows (AECI-2045 QA). */
export type OwnedRowScope = 'all' | 'delivered' | 'others';

/** The rows a product delivers as their connector. */
export function isDeliveredBy(row: OwnedIntegration, productId: string): boolean {
  return row.connector?.id === productId;
}

/** `ownedRowsForProduct`'s rows narrowed to one scope. */
export function ownedRowsInScope(
  rows: readonly OwnedIntegration[],
  contextProductId: string,
  scope: OwnedRowScope,
): OwnedIntegration[] {
  if (scope === 'all') return [...rows];
  return rows.filter((row) => isDeliveredBy(row, contextProductId) === (scope === 'delivered'));
}

/**
 * The owner's own rows that the list above does not carry (AECI-1089 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5 and §6.15).
 *
 * `GET /api/vendor/integrations` returns them as `owned`: the vendor's evidenced
 * pairs, and any `integrations` row it owns on which it holds no endpoint. A
 * third-party owner, which sells the connector and makes neither product, sees its
 * rows only here. An endpoint vendor that owns an evidenced pair sees that pair here
 * too, because the attestable list never reads that table.
 *
 * ── WHAT EACH ROW OFFERS ────────────────────────────────────────────────────
 * One line of state and at most one action, like the ownership block on a card:
 *
 * - **unclaimed** — the claim hint and **Claim this integration**;
 * - **claimed** — a line saying the vendor owns it, and **Edit details** (AECI-1090),
 *   the card's edit form with the frozen type left out on a connector-delivered row.
 *   Below it, **Retire integration** (AECI-1091, `vendor-owned-retire.ts`);
 *
 * No plan is asked for on any of them, connector-delivered or not: the seat is the
 * whole gate (ruling 14, AECI-1663);
 * - **retired** — who retired it, and **Restore integration** when the owner
 *   retired it and may restore it (AECI-1091). An AECi retire offers no Restore.
 *
 * ── PESSIMISTIC ─────────────────────────────────────────────────────────────
 * The claim waits for the `200`, announces through the one live region, revalidates
 * `integrations` (which carries `owned`) and moves focus to the Edit trigger that
 * replaces the button, or to the row's status line when it offers none. A refusal renders its own sentence in a
 * `role="alert"`. No browser dialog: a claim is reversible by AECi and the hint says
 * what it does before the vendor presses it.
 */
@Component({
  selector: 'aec-vendor-owned-integrations',
  imports: [
    AecButton,
    AecCard,
    RouterLink,
    VendorDocsLink,
    VendorIntegrationEditForm,
    VendorOwnedRetire,
    VendorNotOurs,
    VendorOwnedFlows,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (rows().length > 0) {
      <section
        [class]="labelledBy() ? 'mt-6 space-y-4' : 'mt-10 space-y-4'"
        [attr.aria-labelledby]="labelledBy() ?? 'vendor-owned-heading'"
        [attr.data-owned-integrations]="scope()"
      >
        @if (!labelledBy()) {
          <div class="space-y-2">
            <h2 id="vendor-owned-heading" class="m-0">
              <!-- The size lives on the span: styles.css sizes h2 outside any cascade
                 layer, so a text utility on the h2 itself is dead. -->
              <span
                class="block font-display text-xl font-semibold text-(--text-primary)"
                i18n="@@vendor.ownedIntegrations.heading"
                >Integrations your company offers</span
              >
            </h2>
            @if (onSyncService()) {
              <p
                class="text-sm text-(--text-secondary)"
                i18n="@@vendor.ownedIntegrations.intro.syncService"
              >
                Your company is recorded as the owner of these integrations. They are listed here,
                rather than with the integrations above, because your Sync Service delivers them or
                they connect products your company does not make.
              </p>
            } @else {
              <p class="text-sm text-(--text-secondary)" i18n="@@vendor.ownedIntegrations.intro">
                Your company is recorded as the owner of these integrations. They are listed here,
                rather than with the integrations above, because they are delivered through a
                connector or connect products your company does not make.
              </p>
            }
            <p class="m-0"><aec-vendor-docs-link page="owning-an-integration" /></p>
          </div>
        }

        <!-- AECI-1811: one card, the rows divided by hairlines. -->
        <ul aecCard class="m-0 list-none divide-y divide-(--border-default) p-0">
          @for (row of rows(); track row.id) {
            <li class="p-6" [attr.data-owned-row]="row.id">
              <div>
                <h3 class="m-0">{{ title(row) }}</h3>
                <p class="mt-1 text-sm text-(--text-secondary)" data-testid="owned-route">
                  {{ route(row) }}
                </p>
                <!-- AECI-2045: each owned row has its own page. -->
                <p class="mt-2">
                  <a
                    [routerLink]="detailLink(row)"
                    [attr.aria-label]="detailAria(row)"
                    [class]="detailLinkClass"
                    data-testid="owned-detail-link"
                    i18n="@@vendor.ownedIntegrations.openDetails"
                    >Open details</a
                  >
                </p>
              </div>
              <div class="mt-4">
                <p
                  #status
                  tabindex="-1"
                  [attr.data-status-for]="row.id"
                  class="max-w-prose text-sm text-(--text-primary) focus:outline-none"
                  data-testid="owned-status"
                >
                  {{ statusLine(row) }}
                </p>
                @switch (stateOf(row)) {
                  @case ('claimed') {
                    <div class="mt-4">
                      <button
                        #editTrigger
                        aecButton
                        variant="secondary"
                        compact
                        type="button"
                        [attr.data-edit-for]="row.id"
                        [attr.aria-expanded]="editingId() === row.id"
                        [attr.aria-controls]="formPrefix(row) + '-form'"
                        (click)="toggleEdit(row)"
                        data-testid="edit-owned-integration"
                        i18n="@@vendor.ownedIntegrations.edit"
                      >
                        Edit details
                      </button>
                    </div>
                    @if (editingId() === row.id) {
                      <aec-vendor-integration-edit-form
                        [integrationId]="row.id"
                        [contextProductId]="row.product_a.id"
                        [otherProductName]="row.product_b.name"
                        [values]="editValues(row)"
                        [connectorDelivered]="row.connector_powered"
                        [idPrefix]="formPrefix(row)"
                        [lockedFields]="row.locked_fields"
                        [hiddenFields]="row.hidden_fields"
                        (closed)="closeEdit(row)"
                      />
                    }
                  }
                  @case ('claimable') {
                    <!-- Who is told: every endpoint vendor except the owner. So when the
                         caller makes one of the two products, only the other side is. -->
                    @if (holdsEndpoint(row)) {
                      <p
                        class="mt-2 max-w-prose text-xs text-(--text-secondary)"
                        data-testid="claim-hint"
                        i18n="@@vendor.ownedIntegrations.claimHintOtherSide"
                      >
                        Claiming takes this integration over from AEC Integrations. Our catalog
                        updates stop reaching it. The other product's vendor is told that you
                        claimed it.
                      </p>
                    } @else {
                      <p
                        class="mt-2 max-w-prose text-xs text-(--text-secondary)"
                        data-testid="claim-hint"
                        i18n="@@vendor.ownedIntegrations.claimHint"
                      >
                        Claiming takes this integration over from AEC Integrations. Our catalog
                        updates stop reaching it. The vendors of both products are told that you
                        claimed it.
                      </p>
                    }
                    <!-- AECI-1225: while the vendor's own "not ours" stands, the claim
                         is not offered beside it. -->
                    @if (!notOursStands(row)) {
                      <div class="mt-4">
                        <button
                          aecButton
                          type="button"
                          [disabled]="claimingId() !== null"
                          (click)="onClaim(row)"
                          data-testid="claim-owned-integration"
                        >
                          @if (claimingId() === row.id) {
                            <span i18n="@@vendor.ownedIntegrations.claiming">Claiming…</span>
                          } @else {
                            <span i18n="@@vendor.ownedIntegrations.claim"
                              >Claim this integration</span
                            >
                          }
                        </button>
                      </div>
                    }
                    <!-- AECI-1225: the checklist's "say not ours". -->
                    <aec-vendor-not-ours
                      class="mt-4"
                      [integrationId]="row.id"
                      [anchor]="row.anchor"
                      [productA]="row.product_a.name"
                      [productB]="row.product_b.name"
                    />
                  }
                }
                <!-- AECI-2039: a Sync Service pair's data flows, which its owner maintains. -->
                @if (row.sync_service) {
                  <aec-vendor-owned-flows [row]="row" />
                }
                <!-- AECI-1091: retire and restore. Renders nothing on an unclaimed row. -->
                <aec-vendor-owned-retire [row]="row" [statusLine]="status" />
                @if (notice()?.id === row.id) {
                  <p role="alert" class="mt-4 text-sm font-semibold text-(--text-primary)">
                    {{ notice()!.message }}
                  </p>
                }
              </div>
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class VendorOwnedIntegrations {
  /** The product whose tab this renders on. Empty while the product context
   *  resolves, which lists only the rows that touch none of the vendor's products. */
  readonly contextProductId = input.required<string>();

  /**
   * AECI-2045 QA. Which of the tab's owned rows this instance lists. A Sync Service
   * tab leads with the pairs its product delivers (`delivered`: the rows whose
   * connector is this product), under the "Integrations {product} delivers" heading, and
   * lists the rest after (`others`). Every other tab lists them all (`all`).
   */
  readonly scope = input<OwnedRowScope>('all');

  /** The id of a heading outside that names the list. Then the section renders no
   *  heading or intro of its own (the `delivered` list sits under the Sync Service's). */
  readonly labelledBy = input<string | null>(null);

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  private readonly statusLines = viewChildren<ElementRef<HTMLParagraphElement>>('status');
  private readonly editTriggers = viewChildren<ElementRef<HTMLButtonElement>>('editTrigger');

  /** The one row whose edit form is open, or `null`. The dev preview's `?edit=<id>`
   *  (`VENDOR_EDIT_FORM_START_OPEN`) opens it on first paint, for the detector; a
   *  row that is not claimed and editable ignores it (the form renders only in the
   *  `claimed` state). */
  protected readonly editingId = signal<string | null>(
    inject(VENDOR_EDIT_FORM_START_OPEN, { optional: true }) ?? null,
  );

  protected readonly claimingId = signal<string | null>(null);
  protected readonly notice = signal<{ id: string; message: string } | null>(null);

  private readonly vendorProducts = computed(
    () => new Set((this.store.me()?.products ?? []).map((p) => p.id)),
  );

  /** AECI-2045: the tab is a Sync Service product's, so the intro names the kind. On
   *  the `others` list of such a tab the rows are not its pairs, so the plain intro. */
  protected readonly onSyncService = computed(() => {
    if (this.scope() === 'others') return false;
    const product = this.store.me()?.products.find((p) => p.id === this.contextProductId());
    return product ? isSyncService(product.product_role, product.connector_kind) : false;
  });

  /** The edit form's values on record, plus the edit-only `pricing_url` (AECI-1154). */
  protected editValues(row: OwnedIntegration): EditFormValues {
    return { ...row.contestable_fields, pricing_url: row.pricing_url };
  }

  protected readonly rows = computed(() =>
    ownedRowsInScope(
      ownedRowsForProduct(
        this.store.ownedIntegrations(),
        this.contextProductId(),
        this.vendorProducts(),
      ),
      this.contextProductId(),
      this.scope(),
    ),
  );

  /** Does the vendor's own "not ours" stand on this row (AECI-1225)? */
  protected notOursStands(row: OwnedIntegration): boolean {
    return selfDisclaimStands(selfDisclaimOn(this.store.contests().submitted, row.id, row.anchor));
  }

  /** Does the caller make one of the two products? Then the claim notifies only the
   *  other side, since the server never notifies the owner itself. */
  protected holdsEndpoint(row: OwnedIntegration): boolean {
    const mine = this.vendorProducts();
    return mine.has(row.product_a.id) || mine.has(row.product_b.id);
  }

  protected stateOf(row: OwnedIntegration): OwnedRowState {
    return ownedRowState(row);
  }

  protected title(row: OwnedIntegration): string {
    return ownedRowTitle(row);
  }

  protected route(row: OwnedIntegration): string {
    return ownedRowRoute(row);
  }

  protected statusLine(row: OwnedIntegration): string {
    return ownedRowStatusLine(row);
  }

  /** AECI-2045: the row's detail page, a sibling of this tab's route. */
  protected detailLink(row: OwnedIntegration): readonly string[] {
    return ['..', 'integrations', row.id];
  }

  /** Built in TS: an interpolated `i18n-aria-label` emits no attribute here. */
  protected detailAria(row: OwnedIntegration): string {
    const name = ownedRowTitle(row);
    return $localize`:@@vendor.ownedIntegrations.openDetails.aria:Open details: ${name}:name:`;
  }

  protected async onClaim(row: OwnedIntegration): Promise<void> {
    if (this.claimingId() !== null) return;
    this.claimingId.set(row.id);
    this.notice.set(null);
    try {
      await this.api.claimIntegration(row.id);
      this.announcer.announce(ownedRowClaimedAnnouncement());
      await this.store.revalidate(['integrations']);
      // The button is gone once the row reads as claimed. Move focus to the Edit
      // trigger that replaced it (AECI-1090), or to the row's status line when the
      // row offers none, so a keyboard user stays where they were.
      afterNextRender(
        () =>
          (
            this.editTriggers().find((b) => b.nativeElement.dataset['editFor'] === row.id) ??
            this.statusLines().find((line) => line.nativeElement.dataset['statusFor'] === row.id)
          )?.nativeElement.focus(),
        { injector: this.injector },
      );
    } catch (err) {
      this.notice.set({ id: row.id, message: claimErrorMessage(err) });
    } finally {
      this.claimingId.set(null);
    }
  }

  // ─── Edit (AECI-1090) ──────────────────────────────────────────────────────

  protected formPrefix(row: OwnedIntegration): string {
    return `vendor-owned-${row.id}`;
  }

  protected toggleEdit(row: OwnedIntegration): void {
    this.editingId.update((open) => (open === row.id ? null : row.id));
  }

  /** The form closed (saved or cancelled): return focus to its trigger so a
   *  keyboard user is not dropped at the top of the page. */
  protected closeEdit(row: OwnedIntegration): void {
    this.editingId.set(null);
    afterNextRender(
      () =>
        this.editTriggers()
          .find((b) => b.nativeElement.dataset['editFor'] === row.id)
          ?.nativeElement.focus(),
      { injector: this.injector },
    );
  }

  protected readonly detailLinkClass =
    'inline-flex min-h-6 items-center rounded-mark text-sm font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
}
