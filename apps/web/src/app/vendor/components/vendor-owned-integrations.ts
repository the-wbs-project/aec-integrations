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

import type { OwnedIntegration } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { vendorHasActiveEntitlement } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationEditForm } from './vendor-integration-edit-form';
import { claimErrorMessage } from './vendor-integration-ownership-labels';

/** Where the owner stands on one owned row. `claimed-needs-plan` is a claimed
 *  connector-delivered row whose vendor no longer holds an active entitlement, so
 *  it cannot be edited (AECI-1090 / AECI-1040 ruling 2). */
export type OwnedRowState =
  | 'retired'
  | 'claimed'
  | 'claimed-needs-plan'
  | 'claimable'
  | 'needs-plan';

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
 * - **unclaimed, entitled** — the claim hint and **Claim this integration**;
 * - **unclaimed, no active plan** on a connector-delivered row — a sentence saying a
 *   plan is needed (AECI-1040 ruling 2). No button, so nothing collects a 403;
 * - **claimed** — a line saying the vendor owns it, and **Edit details** (AECI-1090),
 *   the card's edit form with the frozen type left out on a connector-delivered row.
 *   Without an active plan on such a row, a sentence saying one is needed instead.
 *   Retire is AECI-1091, so it is not offered yet;
 * - **retired** — who retired it. Restore is AECI-1091.
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
  imports: [VendorIntegrationEditForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (rows().length > 0) {
      <section
        class="mt-10 space-y-4"
        aria-labelledby="vendor-owned-heading"
        data-owned-integrations
      >
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
          <p
            class="max-w-prose text-sm text-(--text-secondary)"
            i18n="@@vendor.ownedIntegrations.intro"
          >
            Your company is recorded as the owner of these integrations. They are listed here,
            rather than with the integrations above, because they are delivered through a connector
            or connect products your company does not make.
          </p>
        </div>

        <ul class="m-0 list-none space-y-4 p-0">
          @for (row of rows(); track row.id) {
            <li
              class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised)"
              [attr.data-owned-row]="row.id"
            >
              <div class="px-4 py-3">
                <h3 class="m-0">
                  <span class="block font-display text-lg font-semibold text-(--text-primary)">{{
                    title(row)
                  }}</span>
                </h3>
                <p class="mt-1 text-sm text-(--text-secondary)" data-testid="owned-route">
                  {{ route(row) }}
                </p>
              </div>
              <div class="border-t border-(--border-default) px-4 py-3">
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
                    <div class="mt-3">
                      <button
                        #editTrigger
                        type="button"
                        [attr.data-edit-for]="row.id"
                        [attr.aria-expanded]="editingId() === row.id"
                        [attr.aria-controls]="formPrefix(row) + '-form'"
                        (click)="toggleEdit(row)"
                        [class]="triggerClass"
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
                        [values]="row.contestable_fields"
                        [connectorDelivered]="row.connector_powered"
                        [idPrefix]="formPrefix(row)"
                        (closed)="closeEdit(row)"
                      />
                    }
                  }
                  @case ('claimed-needs-plan') {
                    <p
                      class="mt-1 max-w-prose text-xs text-(--text-secondary)"
                      data-testid="edit-needs-plan"
                      i18n="@@vendor.ownedIntegrations.editNeedsPlan"
                    >
                      Editing an integration delivered through a connector product needs an active
                      plan. Contact AEC Integrations to activate or renew it.
                    </p>
                  }
                  @case ('needs-plan') {
                    <p
                      class="mt-1 max-w-prose text-xs text-(--text-secondary)"
                      data-testid="claim-needs-plan"
                      i18n="@@vendor.ownedIntegrations.needsPlan"
                    >
                      Claiming an integration delivered through a connector needs an active plan.
                      Contact AEC Integrations to activate it.
                    </p>
                  }
                  @case ('claimable') {
                    <!-- Who is told: every endpoint vendor except the owner. So when the
                         caller makes one of the two products, only the other side is. -->
                    @if (holdsEndpoint(row)) {
                      <p
                        class="mt-1 max-w-prose text-xs text-(--text-secondary)"
                        data-testid="claim-hint"
                        i18n="@@vendor.ownedIntegrations.claimHintOtherSide"
                      >
                        Claiming takes this integration over from AEC Integrations. Our catalogue
                        updates stop reaching it. The other product's vendor is told that you
                        claimed it.
                      </p>
                    } @else {
                      <p
                        class="mt-1 max-w-prose text-xs text-(--text-secondary)"
                        data-testid="claim-hint"
                        i18n="@@vendor.ownedIntegrations.claimHint"
                      >
                        Claiming takes this integration over from AEC Integrations. Our catalogue
                        updates stop reaching it. The vendors of both products are told that you
                        claimed it.
                      </p>
                    }
                    <div class="mt-3 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        [class]="primaryButtonClass"
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
                }
                @if (notice()?.id === row.id) {
                  <p role="alert" class="mt-3 text-sm font-medium text-(--text-primary)">
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

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  private readonly entitled = vendorHasActiveEntitlement(this.store);
  private readonly statusLines = viewChildren<ElementRef<HTMLParagraphElement>>('status');
  private readonly editTriggers = viewChildren<ElementRef<HTMLButtonElement>>('editTrigger');

  /** The one row whose edit form is open, or `null`. */
  protected readonly editingId = signal<string | null>(null);

  protected readonly claimingId = signal<string | null>(null);
  protected readonly notice = signal<{ id: string; message: string } | null>(null);

  private readonly vendorProducts = computed(
    () => new Set((this.store.me()?.products ?? []).map((p) => p.id)),
  );

  protected readonly rows = computed(() =>
    ownedRowsForProduct(
      this.store.ownedIntegrations(),
      this.contextProductId(),
      this.vendorProducts(),
    ),
  );

  /** Does the caller make one of the two products? Then the claim notifies only the
   *  other side, since the server never notifies the owner itself. */
  protected holdsEndpoint(row: OwnedIntegration): boolean {
    const mine = this.vendorProducts();
    return mine.has(row.product_a.id) || mine.has(row.product_b.id);
  }

  protected stateOf(row: OwnedIntegration): OwnedRowState {
    if (row.retired_at) return 'retired';
    if (row.claimed_at) {
      // AECI-1090: the edit needs the plan on a connector-delivered row only.
      return row.connector_powered && !this.entitled() ? 'claimed-needs-plan' : 'claimed';
    }
    // Only a connector-delivered row needs the plan (AECI-1040 ruling 2). An owned
    // row that is not one takes the seat as its whole gate, like any other claim.
    return row.connector_powered && !this.entitled() ? 'needs-plan' : 'claimable';
  }

  protected title(row: OwnedIntegration): string {
    return (
      row.name ??
      $localize`:@@vendor.ownedIntegrations.untitled:${row.product_a.name}:a: and ${row.product_b.name}:b:`
    );
  }

  /** Which two products it joins, and through what. */
  protected route(row: OwnedIntegration): string {
    const a = row.product_a.name;
    const b = row.product_b.name;
    const via = row.connector?.name ?? row.mechanism_name;
    return via
      ? $localize`:@@vendor.ownedIntegrations.routeVia:Connects ${a}:a: and ${b}:b: through ${via}:via:.`
      : $localize`:@@vendor.ownedIntegrations.route:Connects ${a}:a: and ${b}:b:.`;
  }

  protected statusLine(row: OwnedIntegration): string {
    switch (this.stateOf(row)) {
      case 'retired':
        return row.retired_by === 'aeci'
          ? $localize`:@@vendor.ownedIntegrations.retiredByAeci:AEC Integrations retired this integration. It is not shown on the public site.`
          : $localize`:@@vendor.ownedIntegrations.retired:Your company retired this integration. It is not shown on the public site.`;
      case 'claimed':
      case 'claimed-needs-plan':
        return $localize`:@@vendor.ownedIntegrations.claimed:Your company owns this integration. AEC Integrations no longer updates it.`;
      case 'claimable':
      case 'needs-plan':
        return $localize`:@@vendor.ownedIntegrations.unclaimed:Your company is recorded as the owner. AEC Integrations still maintains its details until you claim it.`;
    }
  }

  protected async onClaim(row: OwnedIntegration): Promise<void> {
    if (this.claimingId() !== null) return;
    this.claimingId.set(row.id);
    this.notice.set(null);
    try {
      await this.api.claimIntegration(row.id);
      this.announcer.announce(
        $localize`:@@vendor.ownedIntegrations.live.claimed:You claimed this integration. AEC Integrations no longer updates it.`,
      );
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

  protected readonly triggerClass =
    'inline-flex items-center rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}
