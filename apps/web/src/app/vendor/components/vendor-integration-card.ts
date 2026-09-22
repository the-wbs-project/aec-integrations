import { Component, computed, inject, input, output, signal, viewChildren } from '@angular/core';

import type {
  DataObjectOption,
  ProductVersion,
  VendorClaim,
  VendorIntegration,
} from '@aeci/shared';

import { mechanismKindLabel } from '../../search/mechanism-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorAddClaimForm, type DuplicateClaimHit } from './vendor-add-claim-form';
import { healthCountsLine } from './vendor-attestation-labels';
import { VendorClaimLane } from './vendor-claim-lane';
import { VendorContestForm } from './vendor-contest-form';
import { VendorHealthPill } from './vendor-health-pill';
import { summarizeIntegration } from './vendor-integration-health';
import { VendorIntegrationRetire } from './vendor-integration-retire';
import { VendorIntegrationOwnership } from './vendor-integration-ownership';
// AECI-1007: per-side links.
import { VendorIntegrationLinksForm } from './vendor-integration-links-form';

/**
 * One integration touching a product this vendor owns (AECI-606 / §6), rendered
 * as the SECOND level of the Integrations tab's drill-down (AECI-999 / §6.3):
 * its mechanism and source, its health, its data-flow lanes, and the
 * add-a-data-flow form.
 *
 * The counterpart product's name, logo and public-page link moved up a level to
 * `vendor-counterpart-group.ts`, which groups every integration with the same
 * counterpart. This card renders in one of two modes:
 *
 * - **`nested`** — the counterpart has more than one integration. The card is a
 *   disclosure: an `<h3>` wrapping a button that shows the mechanism, the source
 *   and the health, over a panel with the lanes.
 * - **`direct`** — the counterpart has exactly one integration. Opening the
 *   group opens this card too, so it renders no second disclosure. It still
 *   prints its mechanism and source, under a label that says it is the only
 *   integration on record, so a vendor knows the lanes below belong to one
 *   integration and there is nothing else to open.
 *
 * Panels are hidden with the `hidden` attribute, never removed with `@if`, for
 * the same reason as the lanes: collapsing must not destroy an attestation
 * control mid-edit.
 *
 * `@for` tracks lanes by `claim.id`, and that is load-bearing rather than
 * idiomatic: every write splices a replacement claim into the list, and tracking
 * by index or identity would destroy and rebuild the lane, discarding focus and
 * whatever the vendor had typed into the note editor.
 */
@Component({
  selector: 'aec-vendor-integration-card',
  imports: [
    VendorAddClaimForm,
    VendorClaimLane,
    VendorContestForm,
    VendorHealthPill,
    VendorIntegrationRetire,
    VendorIntegrationOwnership,
    VendorIntegrationLinksForm,
  ],
  styles: [':host { display: block; }'],
  template: `
    <article [attr.aria-labelledby]="fieldId('heading')">
      @if (mode() === 'nested') {
        <h3 [id]="fieldId('heading')" class="m-0">
          <button
            type="button"
            [attr.aria-expanded]="expanded()"
            [attr.aria-controls]="fieldId('panel')"
            (click)="toggle()"
            class="flex w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 font-body text-base font-normal
              text-start transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2
              focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
          >
            <span class="flex min-w-0 flex-1 items-center gap-3">
              <svg
                aria-hidden="true"
                class="h-4 w-4 shrink-0 text-(--text-secondary) transition-transform"
                [class.rotate-90]="expanded()"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              <span class="min-w-0">
                <span class="block text-sm font-semibold text-(--text-primary)">{{
                  mechanismLabel()
                }}</span>
                <span class="mt-0.5 block text-xs text-(--text-secondary)">{{ sourceLine() }}</span>
                <span class="mt-0.5 block text-xs text-(--text-secondary)">{{ countsLine() }}</span>
              </span>
            </span>
            @if (retired()) {
              <span [class]="retiredBadgeClass" i18n="@@vendor.retire.badge">Retired</span>
            }
            <span class="ps-7 sm:ps-0"><aec-vendor-health-pill [health]="summary().health" /></span>
          </button>
        </h3>
      } @else {
        <header class="border-b border-(--border-default) bg-(--surface-sunken) px-5 py-2.5">
          <p [id]="fieldId('heading')" class="text-xs text-(--text-secondary)">
            <span class="font-semibold text-(--text-primary)">{{ onlyIntegrationLabel() }}</span>
            <span aria-hidden="true"> · </span>
            <span>{{ mechanismLabel() }}</span>
            <span aria-hidden="true"> · </span>
            <span>{{ sourceLine() }}</span>
            @if (retired()) {
              <span aria-hidden="true"> · </span>
              <span class="font-semibold text-(--text-primary)" i18n="@@vendor.retire.badge"
                >Retired</span
              >
            }
          </p>
        </header>
      }

      <div
        [id]="fieldId('panel')"
        [attr.role]="mode() === 'nested' ? 'region' : null"
        [attr.aria-labelledby]="mode() === 'nested' ? fieldId('heading') : null"
        [hidden]="mode() === 'nested' && !expanded()"
        [class]="mode() === 'nested' ? nestedPanelClass : ''"
      >
        @if (connectorNotice(); as notice) {
          <p class="max-w-prose px-5 pt-3 text-xs text-(--text-secondary)">{{ notice }}</p>
        }

        @if (pivotNotice(); as message) {
          <!--
            Visible copy, NOT a live region (AECI-631 / §6.3). It keeps its job for
            the sighted reader, telling them why their submission did not create a
            lane and where the existing one is. The sentence reaches assistive
            tech through the shell's one channel, from onDuplicate below.
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
                [contextProductId]="integration().context_product.id"
                [contextProductSlug]="integration().context_product.slug"
                [vendorName]="vendorName()"
                [canWrite]="canAttest()"
                [versions]="versions()"
                [highlighted]="highlightClaimId() === claim.id"
                (changed)="onClaimChanged($event)"
                (retracted)="retracted.emit($event)"
              ></li>
            }
          </ul>
        }

        @if (canAttest()) {
          <aec-vendor-add-claim-form
            [integrationId]="integration().id"
            [contextProductId]="integration().context_product.id"
            [otherProductName]="integration().other_product.name"
            [dataObjects]="dataObjects()"
            [versions]="versions()"
            [existingClaims]="integration().claims"
            (created)="onCreated($event)"
            (duplicate)="onDuplicate($event)"
          />
        }

        <!--
          AECI-1005 / AECI-1006 (spec 4.5.6). Who offers this integration, and
          the owner's Claim or Edit action. Seat-only, like the contest form:
          never gated on canWrite.
        -->
        <aec-vendor-integration-ownership [integration]="integration()" />

        <!--
          AECI-1007 (spec 4.5.7): per-side links. Seat-only, like the contest
          form below: gated on the edge taking vendor writes (attestable is the
          server's connector-powered verdict, decision 9), never on canWrite.
          On a connector-powered row it renders only while the vendor still has
          a stored link, read-only with Remove (the links were stranded when
          promote made the row connector-powered in place). Hidden on a retired
          row (AECI-1010): the API refuses link writes there.
        -->
        @if (!retired() && (integration().attestable || hasOwnLinks())) {
          <aec-vendor-integration-links-form
            [integration]="integration()"
            [vendorName]="vendorName()"
          />
        }
        <!-- end AECI-1007 -->

        <!--
          AECI-1008 (spec 11b). Seat-only: gated on NOT being the owner, never
          on canWrite or the edge being attestable. A vendor without active
          access, or on a connector-powered edge, can still ask for a wrong
          public fact to be fixed.
        -->
        @if (!integration().is_owner && !retired()) {
          <aec-vendor-contest-form
            [integration]="integration()"
            [vendorId]="vendorId()"
            [vendorName]="vendorName()"
          />
        }

        <!--
          AECI-1010: retire and restore, in their own section at the foot of the
          card. The owner sees Retire (with a confirm step) or Restore. The other
          endpoint vendor sees a retired row read-only, marked retired. The
          component renders nothing in every other case.
        -->
        <aec-vendor-integration-retire [integration]="integration()" />
      </div>
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
  private readonly store = inject(VendorPortalStore);

  /** The caller's vendor id, for the contest form's owner picker fallback. */
  protected readonly vendorId = computed(() => this.store.me()?.vendor.id ?? '');

  private readonly lanes = viewChildren(VendorClaimLane);

  protected readonly highlightClaimId = signal<string | null>(null);
  protected readonly pivotNotice = signal<string | null>(null);

  /** `nested` under a counterpart with several integrations, `direct` when it is
   *  the only one. See the class header. */
  readonly mode = input<'nested' | 'direct'>('nested');

  /** Collapsed by default in `nested` mode (AECI-999). Local, because the group
   *  tracks cards by integration id, so the state survives every splice. */
  readonly expanded = signal(false);

  protected readonly ownsBothEndpoints = computed(() => this.integration().slots.length === 2);

  /** Indents a nested integration's flows under its own row, so three levels
   *  read as three levels rather than one long list. */
  protected readonly nestedPanelClass = 'ms-9 border-s border-t border-(--border-default)';

  protected readonly summary = computed(() => summarizeIntegration(this.integration()));
  protected readonly countsLine = computed(() => healthCountsLine(this.summary().counts));

  protected readonly onlyIntegrationLabel = computed(
    () =>
      $localize`:@@vendor.attest.card.only:The only integration on record with ${this.integration().other_product.name}:other:`,
  );

  /**
   * Where this integration comes from and who sits on each side. Integrations
   * are always put on record by AEC Integrations (a vendor adds data flows, not
   * integrations), so the source names the connector when there is one and
   * otherwise says so plainly.
   */
  protected readonly sourceLine = computed(() => {
    const integration = this.integration();
    const parts: string[] = [];
    const connector = integration.powered_by?.name ?? null;
    parts.push(
      connector
        ? $localize`:@@vendor.attest.card.source.via:Via ${connector}:connector:`
        : !integration.attestable
          ? $localize`:@@vendor.attest.card.source.connector:Via a connector`
          : $localize`:@@vendor.attest.card.source.aeci:On record from AEC Integrations`,
    );
    if (this.ownsBothEndpoints()) {
      parts.push($localize`:@@vendor.attest.ownsBoth:You own both sides of this integration`);
    }
    return parts.join(' · ');
  });

  /**
   * Whether this card may author at all: the vendor-level Verified capability
   * AND this edge being attestable (AECI-705 / §14).
   *
   * `attestable` is read straight off the wire and never re-derived here. The
   * server's predicate is a union over two columns that nothing cross-validates
   * (`apps/api/src/lib/connector-powered.ts`), so a browser-side copy would drift
   * and would show controls that collect a 403.
   */
  protected readonly canAttest = computed(
    () => this.canWrite() && this.integration().attestable && !this.retired(),
  );

  /**
   * Whether the owner has retired this integration (AECI-1010). A retired row is
   * read-only for everyone: no new data flow, no attestation, no contest. The only
   * write it takes is the owner's Restore, in the retire section.
   */
  protected readonly retired = computed(() => this.integration().retired_at !== null);
  /** AECI-1007: the caller still holds a link on this entry's side. */
  protected readonly hasOwnLinks = computed(() => {
    const links = this.integration().own_links;
    return links.listing_url !== null || links.docs_url !== null;
  });

  protected readonly retiredBadgeClass =
    'inline-flex items-center rounded-(--radius-sm) border border-(--border-strong) bg-(--surface-raised) px-2 py-0.5 text-xs font-semibold text-(--text-primary)';

  /**
   * Why this card is read-only when the vendor is otherwise able to write.
   *
   * Deliberately silent when the vendor cannot write for the ORDINARY reason
   * (unverified): the section already states that once, above the list, and
   * repeating a second explanation per card would read as two separate problems.
   * This line answers only the question the section cannot: why THIS integration
   * stays read-only even after verification.
   *
   * Names the connector when it is a promoted product, falls back to the
   * free-text `mechanism_name`, and stays generic otherwise. On production that
   * fallback carries 53 of the 132 powered edges, so it is the common path, not
   * an edge case.
   */
  protected readonly connectorNotice = computed(() => {
    const integration = this.integration();
    if (integration.attestable || !this.canWrite()) return null;
    const connector = integration.powered_by?.name ?? integration.mechanism_name;
    return connector
      ? $localize`:@@vendor.attest.card.connector.named:Delivered through ${connector}:connector:. AEC Integrations maintains these data flows, so neither product vendor confirms them.`
      : $localize`:@@vendor.attest.card.connector:Delivered through a connector. AEC Integrations maintains these data flows, so neither product vendor confirms them.`;
  });

  protected readonly mechanismLabel = computed(() => {
    const { mechanism_kind, powered_by } = this.integration();
    // The source line already says "Via {connector}", so a mechanism name that
    // IS the connector's name would print it twice.
    const mechanism_name =
      this.integration().mechanism_name === powered_by?.name
        ? null
        : this.integration().mechanism_name;
    const kind = mechanismKindLabel(mechanism_kind);
    if (kind && mechanism_name) return `${kind} · ${mechanism_name}`;
    return kind || mechanism_name || $localize`:@@vendor.attest.mechanism.unknown:Integration`;
  });

  protected toggle(): void {
    this.expanded.update((open) => !open);
  }

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
    this.expanded.set(true);
    this.lanes()
      .find((lane) => lane.claim().id === hit.claimId)
      ?.focusPosition();
  }

  /** Hand focus to a specific lane — used by the section after a new claim
   *  lands, once the list has re-rendered with it. */
  focusClaim(claimId: string): void {
    if (this.integration().claims.some((c) => c.id === claimId)) this.expanded.set(true);
    this.lanes()
      .find((lane) => lane.claim().id === claimId)
      ?.focusPosition();
  }
}
