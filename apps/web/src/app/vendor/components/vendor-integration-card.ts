import { Component, computed, inject, input, output, signal, viewChildren } from '@angular/core';

import type {
  DataObjectOption,
  ProductVersion,
  VendorClaim,
  VendorIntegration,
} from '@aeci/shared';

import { mechanismKindLabel } from '../../search/mechanism-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';

import { VendorAddClaimForm, type DuplicateClaimHit } from './vendor-add-claim-form';
import { VendorClaimLane } from './vendor-claim-lane';

/**
 * One integration touching a product this vendor owns (AECI-606 / §6): the
 * counterpart product, the mechanism, its claim lanes, and the add-a-data-flow
 * form.
 *
 * The header is eyebrow-then-heading — the vendor's own product above the
 * counterpart's name — matching `vendor-dashboard-tabbed.ts`'s own page header.
 * The tab inherits the dashboard's visual language rather than introducing a
 * second reference site (the Anchor-Site Rule; the same call the admin console
 * made in `ADMIN_PANEL_SPEC.md` §9.10).
 *
 * `@for` tracks lanes by `claim.id`, and that is load-bearing rather than
 * idiomatic: every write splices a replacement claim into the list, and tracking
 * by index or identity would destroy and rebuild the lane, discarding focus and
 * whatever the vendor had typed into the note editor.
 */
@Component({
  selector: 'aec-vendor-integration-card',
  imports: [VendorAddClaimForm, VendorClaimLane],
  styles: [':host { display: block; }'],
  template: `
    <article
      class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised)"
      [attr.aria-labelledby]="fieldId('heading')"
    >
      <header class="border-b border-(--border-default) px-5 py-4">
        <p class="aec-overline text-(--text-secondary)">
          {{ integration().context_product.name }}
        </p>
        <h3
          [id]="fieldId('heading')"
          class="mt-1 font-display text-lg font-semibold text-(--text-primary)"
        >
          {{ integration().other_product.name }}
        </h3>
        <p class="mt-1 text-xs text-(--text-secondary)">
          <span>{{ mechanismLabel() }}</span>
          @if (ownsBothEndpoints()) {
            <span aria-hidden="true"> · </span>
            <span i18n="@@vendor.attest.ownsBoth">You own both sides of this integration</span>
          }
        </p>
      </header>

      @if (pivotNotice(); as message) {
        <!--
          Visible copy, NOT a live region (AECI-631 / §6.3). It keeps its job for
          the sighted reader, telling them why their submission did not create a
          lane and where the existing one is. What it must not also be is a
          second role="status": this card renders once per integration, so a
          dashboard with four of them shipped four competing announcement
          channels, and the same event would queue two utterances against the
          shell's region. The sentence still reaches assistive tech, through the
          one channel, from onDuplicate below.
        -->
        <p class="px-5 pt-3 text-sm text-(--text-primary)">{{ message }}</p>
      }

      @if (integration().claims.length === 0) {
        <p class="px-5 py-4 text-sm text-(--text-secondary)" i18n="@@vendor.attest.card.empty">
          No data flows are on record for this integration yet.
        </p>
      } @else {
        <ul class="m-0 list-none p-0">
          @for (claim of integration().claims; track claim.id) {
            <li
              aec-vendor-claim-lane
              [claim]="claim"
              [otherProductName]="integration().other_product.name"
              [vendorName]="vendorName()"
              [canWrite]="canWrite()"
              [versions]="versions()"
              [highlighted]="highlightClaimId() === claim.id"
              (changed)="onClaimChanged($event)"
              (retracted)="retracted.emit($event)"
            ></li>
          }
        </ul>
      }

      @if (canWrite()) {
        <aec-vendor-add-claim-form
          [integrationId]="integration().id"
          [otherProductName]="integration().other_product.name"
          [dataObjects]="dataObjects()"
          [versions]="versions()"
          [existingClaims]="integration().claims"
          (created)="onCreated($event)"
          (duplicate)="onDuplicate($event)"
        />
      }
    </article>
  `,
})
export class VendorIntegrationCard {
  readonly integration = input.required<VendorIntegration>();
  readonly vendorName = input.required<string>();
  readonly canWrite = input.required<boolean>();
  readonly dataObjects = input.required<readonly DataObjectOption[]>();
  /** Versions of the caller's own endpoint product (`context_product`). */
  readonly versions = input.required<readonly ProductVersion[]>();

  readonly claimChanged = output<VendorClaim>();
  readonly claimCreated = output<VendorClaim>();
  readonly retracted = output<string>();

  private readonly announcer = inject(VendorPortalAnnouncer);

  private readonly lanes = viewChildren(VendorClaimLane);

  protected readonly highlightClaimId = signal<string | null>(null);
  protected readonly pivotNotice = signal<string | null>(null);

  protected readonly ownsBothEndpoints = computed(() => this.integration().slots.length === 2);

  protected readonly mechanismLabel = computed(() => {
    const { mechanism_kind, mechanism_name } = this.integration();
    const kind = mechanismKindLabel(mechanism_kind);
    if (kind && mechanism_name) return `${kind} · ${mechanism_name}`;
    return kind || mechanism_name || $localize`:@@vendor.attest.mechanism.unknown:Integration`;
  });

  protected fieldId(key: string): string {
    return `vendor-integration-${this.integration().id}-${key}`;
  }

  protected onClaimChanged(claim: VendorClaim): void {
    // A successful write on the pivoted-to lane retires the highlight.
    if (this.highlightClaimId() === claim.id) {
      this.highlightClaimId.set(null);
      this.pivotNotice.set(null);
    }
    this.claimChanged.emit(claim);
  }

  protected onCreated(claim: VendorClaim): void {
    this.highlightClaimId.set(null);
    this.pivotNotice.set(null);
    this.claimCreated.emit(claim);
  }

  /**
   * Route a duplicate submission to the lane that already exists, rather than
   * dead-ending the vendor with an error they cannot act on. Still three
   * signals, for three audiences: a highlight (sighted), the same sentence
   * announced politely (assistive), and focus on that lane's Affirm button
   * (keyboard).
   *
   * The middle one now goes through {@link VendorPortalAnnouncer} instead of a
   * `role="status"` on the paragraph above. Same words, same moment, one region
   * (§6.3) — and it is announced BEFORE focus moves, so the utterance is queued
   * against the lane the vendor is about to land on rather than the one they
   * just left.
   */
  protected onDuplicate(hit: DuplicateClaimHit): void {
    this.highlightClaimId.set(hit.claimId);
    const notice = $localize`:@@vendor.attest.card.pivot:You already have a ${hit.dataObjectName}:dataObject: data flow in that direction. It is highlighted below.`;
    this.pivotNotice.set(notice);
    this.announcer.announce(notice);
    this.lanes()
      .find((lane) => lane.claim().id === hit.claimId)
      ?.focusPosition();
  }

  /** Hand focus to a specific lane — used by the section after a new claim
   *  lands, once the list has re-rendered with it. */
  focusClaim(claimId: string): void {
    this.lanes()
      .find((lane) => lane.claim().id === claimId)
      ?.focusPosition();
  }
}
