import {
  Component,
  ElementRef,
  InjectionToken,
  Injector,
  afterNextRender,
  computed,
  type OnInit,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import type { VendorIntegration } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { vendorHasActiveEntitlement } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationEditForm } from './vendor-integration-edit-form';
import { claimErrorMessage } from './vendor-integration-ownership-labels';

/** The form's groups live with the form; re-exported for the create form. */
export { EDIT_GROUPS } from './vendor-integration-edit-form';

/**
 * Render one card's edit form open on first paint: the id of the integration
 * whose form starts open. Provided ONLY by the dev preview
 * (`/preview/vendor-dashboard/products/<slug>/integrations?edit=<integration id>`),
 * so `npx impeccable detect`, which reads the first render, can see the form.
 * Nothing in the product provides it.
 */
export const VENDOR_EDIT_FORM_START_OPEN = new InjectionToken<string | null>(
  'VENDOR_EDIT_FORM_START_OPEN',
);

/** Where the caller stands on this integration. See {@link VendorIntegrationOwnership}. */
export type OwnershipState =
  | 'owner-claimed'
  | 'owner-retired'
  | 'owner-unclaimed'
  // AECI-1089: the owner of a connector-delivered row. It may claim with an active
  // entitlement (`owner-connector-unclaimed`), and is told a plan is needed without
  // one (`owner-connector-locked`). Once claimed, an entitled owner gets the
  // ordinary `owner-claimed` edit (AECI-1090); `owner-connector-claimed` is the
  // claimed row whose vendor no longer holds an active entitlement.
  | 'owner-connector-unclaimed'
  | 'owner-connector-locked'
  | 'owner-connector-claimed'
  | 'other-owned'
  | 'other-unclaimed'
  | 'no-owner';

/**
 * Integration ownership on the card (AECI-1005 claim, AECI-1006 edit;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6 and §6.14).
 *
 * ── WHAT IT SHOWS ───────────────────────────────────────────────────────────
 * One line saying who offers the integration, and the one action the caller's
 * relationship to the row allows:
 *
 * - **the owner, unclaimed** — a Claim button. Editing is meaningless until the
 *   row is claimed, because promote still writes it;
 * - **the owner, claimed** — "Edit details", a disclosure over the edit form;
 * - **the owner of a connector-delivered row** (AECI-1089) — Claim when the vendor
 *   holds an active entitlement, and a sentence saying a plan is needed when it
 *   does not (AECI-1040 ruling 2). Once claimed (AECI-1090), "Edit details" with
 *   an active entitlement, with the frozen type left out of the form and named
 *   instead (ruling 5), and without one a sentence saying editing needs an active
 *   plan. `attestable` is the server's connector-powered verdict, read off the
 *   wire and never re-derived;
 * - **anyone else** — "Offered by {vendor}", and who reviews a contest on it.
 *   The contest form below the card is their recourse.
 *
 * A seat is the whole gate (decision 15), so nothing here reads `canWrite`. The
 * one exception is the connector-delivered row, which reads the resolved tier
 * through `vendorHasActiveEntitlement`, the client half of the server's gate.
 *
 * ── PESSIMISTIC, NOT OPTIMISTIC ─────────────────────────────────────────────
 * The realtime spec keeps forms pessimistic (`STAGE_2_REALTIME_SPEC.md` §4):
 * both writes wait for the server, then announce through the portal's one live
 * region and revalidate `integrations`. An edit goes live on the public page
 * with no review (decision 8), and the copy says so before the vendor saves.
 *
 * ── ONE RULE, SHARED ────────────────────────────────────────────────────────
 * Each value is checked with `integrationEditValueProblem`, the function the
 * handler runs, and the body is parsed with `UpdateVendorIntegrationSchema`
 * before it is sent. Only changed fields are sent. The type picker leaves out
 * the connector-delivered kinds, which the server refuses.
 */
@Component({
  selector: 'aec-vendor-integration-ownership',
  imports: [VendorIntegrationEditForm],
  styles: [':host { display: block; }'],
  template: `
    <div class="border-t border-(--border-default) px-5 py-4" data-testid="integration-ownership">
      <p
        #line
        tabindex="-1"
        class="max-w-prose text-sm text-(--text-primary) focus:outline-none"
        data-testid="ownership-line"
      >
        {{ ownershipLine() }}
      </p>

      @if (state() === 'owner-connector-locked') {
        <p
          class="mt-1 max-w-prose text-xs text-(--text-secondary)"
          data-testid="claim-needs-plan"
          i18n="@@vendor.integrationClaim.needsPlan"
        >
          Claiming an integration delivered through a connector needs an active plan. Contact AEC
          Integrations to activate it.
        </p>
      }
      @if (state() === 'owner-unclaimed' || state() === 'owner-connector-unclaimed') {
        @if (state() === 'owner-connector-unclaimed') {
          <p
            class="mt-1 max-w-prose text-xs text-(--text-secondary)"
            i18n="@@vendor.integrationClaim.hintConnector"
          >
            Claiming takes this integration over from AEC Integrations. Our catalogue updates stop
            reaching it. The other product's vendor is told that you claimed it.
          </p>
        } @else {
          <p
            class="mt-1 max-w-prose text-xs text-(--text-secondary)"
            i18n="@@vendor.integrationClaim.hint"
          >
            Claiming takes this integration over from AEC Integrations. Our catalogue updates stop
            reaching it, and your edits go live on the public page with no review. The other
            product's vendor is told that you claimed it.
          </p>
        }
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            [class]="primaryButtonClass"
            [disabled]="claiming()"
            (click)="onClaim()"
            data-testid="claim-integration"
          >
            @if (claiming()) {
              <span i18n="@@vendor.integrationClaim.claiming">Claiming…</span>
            } @else {
              <span i18n="@@vendor.integrationClaim.button">Claim this integration</span>
            }
          </button>
        </div>
        @if (claimNotice(); as message) {
          <p role="alert" class="mt-3 text-sm font-medium text-(--text-primary)">
            {{ message }}
          </p>
        }
      } @else if (state() === 'owner-connector-claimed') {
        <p
          class="mt-1 max-w-prose text-xs text-(--text-secondary)"
          data-testid="ownership-entitlement-hint"
          i18n="@@vendor.integrationEdit.connectorEntitlementHint"
        >
          Editing an integration delivered through a connector product needs an active plan. Contact
          AEC Integrations to activate or renew it.
        </p>
      } @else if (state() === 'owner-claimed') {
        <div class="mt-3">
          <button
            #trigger
            type="button"
            [attr.aria-expanded]="editing()"
            [attr.aria-controls]="fieldId('form')"
            (click)="toggleEdit()"
            [class]="triggerClass"
            data-testid="edit-integration"
            i18n="@@vendor.integrationEdit.trigger"
          >
            Edit details
          </button>
        </div>

        @if (editing()) {
          <aec-vendor-integration-edit-form
            [integrationId]="integration().id"
            [contextProductId]="integration().context_product.id"
            [otherProductName]="integration().other_product.name"
            [values]="integration().contestable_fields"
            [connectorDelivered]="connectorDelivered()"
            [idPrefix]="idPrefix()"
            (closed)="closeEdit()"
          />
        }
      }
    </div>
  `,
})
export class VendorIntegrationOwnership implements OnInit {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  readonly integration = input.required<VendorIntegration>();

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly line = viewChild<ElementRef<HTMLParagraphElement>>('line');

  private readonly startOpenId = inject(VENDOR_EDIT_FORM_START_OPEN, { optional: true }) ?? null;

  /** The server's connector-powered verdict (AECI-705), read off the wire. */
  protected readonly connectorDelivered = computed(() => !this.integration().attestable);

  /** The field-id prefix the form uses, so the trigger's `aria-controls` names it. */
  protected readonly idPrefix = computed(
    () => `vendor-ownership-${this.integration().id}-${this.integration().context_product.id}`,
  );

  protected readonly claiming = signal(false);
  protected readonly claimNotice = signal<string | null>(null);

  protected readonly editing = signal(false);
  /** The client half of the carve-out's entitlement gate (AECI-1089). */
  private readonly entitled = vendorHasActiveEntitlement(this.store);

  readonly state = computed<OwnershipState>(() => {
    const integration = this.integration();
    if (integration.is_owner) {
      // `attestable` is the server's connector-powered verdict (AECI-705).
      const connector = !integration.attestable;
      if (!integration.claimed_at) {
        if (!connector) return 'owner-unclaimed';
        return this.entitled() ? 'owner-connector-unclaimed' : 'owner-connector-locked';
      }
      if (integration.retired_at) return 'owner-retired';
      // AECI-1090: a claimed connector-delivered row takes the ordinary edit from an
      // entitled owner, with its type frozen. Without an entitlement it says so.
      if (connector && !this.entitled()) return 'owner-connector-claimed';
      // AECI-1010: a retired row takes no edit. The server answers 409
      // INTEGRATION_RETIRED; the form is not offered. Restore is on the card's foot.
      return integration.retired_at ? 'owner-retired' : 'owner-claimed';
    }
    if (!integration.owner) return 'no-owner';
    return integration.claimed_at ? 'other-owned' : 'other-unclaimed';
  });

  protected readonly ownershipLine = computed(() => {
    const owner = this.integration().owner?.name ?? '';
    switch (this.state()) {
      case 'owner-claimed':
        return $localize`:@@vendor.integrationOwnership.ownerClaimed:Your company owns this integration and keeps its details up to date.`;
      case 'owner-retired':
        // AECI-1046: an admin retire is AECi's to undo, not the owner's.
        return this.integration().retired_by === 'aeci'
          ? $localize`:@@vendor.integrationOwnership.ownerRetiredByAeci:Your company owns this integration. AEC Integrations retired it, so it cannot be edited or restored here.`
          : $localize`:@@vendor.integrationOwnership.ownerRetired:Your company owns this integration and has retired it. Restore it to edit its details.`;
      case 'owner-unclaimed':
        return $localize`:@@vendor.integrationOwnership.ownerUnclaimed:Your company is recorded as the owner of this integration. Claim it to edit its details.`;
      case 'owner-connector-unclaimed':
        return $localize`:@@vendor.integrationOwnership.ownerConnectorUnclaimed:Your company is recorded as the owner of this integration, which is delivered through a connector. Claim it to take over its details.`;
      case 'owner-connector-locked':
        // No Claim button renders here, so the line does not ask for one. The note
        // below says an active plan is needed (AECI-1089 review).
        return $localize`:@@vendor.integrationOwnership.ownerConnectorLocked:Your company is recorded as the owner of this integration, which is delivered through a connector. AEC Integrations maintains its details.`;
      case 'owner-connector-claimed':
        return $localize`:@@vendor.integrationOwnership.ownerConnectorClaimed:Your company owns this integration, which is delivered through a connector.`;
      case 'other-owned':
        return $localize`:@@vendor.integrationOwnership.otherOwned:Offered by ${owner}:owner:. ${owner}:owner: maintains its details, and reviews any contest you send about them. A contest about who owns it goes to AEC Integrations.`;
      case 'other-unclaimed':
        return $localize`:@@vendor.integrationOwnership.otherUnclaimed:Offered by ${owner}:owner:. ${owner}:owner: has not claimed it yet, so AEC Integrations reviews any contest you send about it.`;
      case 'no-owner':
        return $localize`:@@vendor.integrationOwnership.noOwner:No owner is on file for this integration. If your company offers it, contest the Owner field below and AEC Integrations will review it.`;
    }
  });

  /** The dev preview's `?edit=<id>` (see {@link VENDOR_EDIT_FORM_START_OPEN}).
   *  Inputs are set by now, and this runs before the first render, so the form is
   *  in the server-rendered HTML. */
  ngOnInit(): void {
    if (this.startOpenId !== null && this.startOpenId === this.integration().id) {
      if (this.state() === 'owner-claimed') this.openEdit();
    }
  }

  // ─── Claim (AECI-1005) ─────────────────────────────────────────────────────

  protected async onClaim(): Promise<void> {
    if (this.claiming()) return;
    this.claiming.set(true);
    this.claimNotice.set(null);
    // AECI-1089: the connector announcement names what the claim changed. Focus goes
    // to the Edit trigger (AECI-1090) when the row now offers one, else the status line.
    const connector = !this.integration().attestable;
    try {
      await this.api.claimIntegration(this.integration().id);
      this.announcer.announce(
        connector
          ? $localize`:@@vendor.integrationClaim.live.doneConnector:You claimed this integration. AEC Integrations no longer updates it.`
          : $localize`:@@vendor.integrationClaim.live.done:You claimed this integration. You can now edit its details.`,
      );
      await this.store.revalidate(['integrations']);
      // The Claim button is gone once the row reads as claimed. Hand focus to the
      // Edit trigger that replaced it (or the status line when there is none), so a
      // keyboard user is not dropped at the top of the page.
      afterNextRender(() => (this.trigger() ?? this.line())?.nativeElement.focus(), {
        injector: this.injector,
      });
    } catch (err) {
      this.claimNotice.set(claimErrorMessage(err));
    } finally {
      this.claiming.set(false);
    }
  }

  // ─── Edit (AECI-1006) ──────────────────────────────────────────────────────

  protected toggleEdit(): void {
    if (this.editing()) {
      this.closeEdit();
      return;
    }
    this.openEdit();
  }

  private openEdit(): void {
    this.editing.set(true);
  }

  /** Close and discard, returning focus to the trigger so a keyboard user is not
   *  dropped at the top of the page when the form unmounts. */
  closeEdit(): void {
    this.editing.set(false);
    this.trigger()?.nativeElement.focus();
  }

  protected fieldId(key: string): string {
    return `${this.idPrefix()}-${key}`;
  }

  protected readonly triggerClass =
    'inline-flex items-center rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}
