import { Component, computed, inject, input, output, signal, viewChildren } from '@angular/core';

import type {
  DataObjectOption,
  ProductVersion,
  VendorClaim,
  VendorIntegration,
} from '@aeci/shared';

import { mechanismKindLabel } from '../../search/mechanism-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';

import { ViewPublicLink } from '../../shared/view-public-link/view-public-link';

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
  imports: [VendorAddClaimForm, VendorClaimLane, ViewPublicLink],
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
        <!--
          The link is a SIBLING of the h3, never inside it (AECI-960, section
          6.7). The h3 is this article's aria-labelledby target, so anything
          nested in it is re-read as part of the region name on every entry.

          It points at the PAIR page, not at the counterpart product. What a
          vendor edits on this card is claims and attestations, and those render
          on the pair route, not on the counterpart product page. Linking there
          would answer "see my change" with a page the change is not on. Both
          slugs are already on the wire.

          The accessible name is destination-specific BECAUSE this card repeats:
          one per integration, so N links sharing the name "View public page"
          reproduces ACCESSIBILITY_AUDIT.md finding A4 (WCAG 2.4.4) inside the
          portal. The two once-per-page portal links can and do stay uniform.
        -->
        <div class="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h3
            [id]="fieldId('heading')"
            class="font-display text-lg font-semibold text-(--text-primary)"
          >
            {{ integration().other_product.name }}
          </h3>
          <aec-view-public-link [href]="pairPageHref()" [ariaLabel]="pairPageAriaLabel()" />
        </div>
        <p class="mt-1 text-xs text-(--text-secondary)">
          <span>{{ mechanismLabel() }}</span>
          @if (ownsBothEndpoints()) {
            <span aria-hidden="true"> · </span>
            <span i18n="@@vendor.attest.ownsBoth">You own both sides of this integration</span>
          }
        </p>
        @if (connectorNotice(); as notice) {
          <p class="mt-2 max-w-prose text-xs text-(--text-secondary)">{{ notice }}</p>
        }
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
              [contextProductId]="integration().context_product.id"
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

  /**
   * The public pair page for this edge — `/products/:contextSlug/integrations/:otherSlug`
   * (`app.routes.ts`), which is where the claims and attestations authored on
   * this card actually render.
   *
   * Context first, other second, and the order is not cosmetic: the pair route's
   * two segments are positional, so swapping them addresses the mirror page,
   * which frames every direction the other way round. For an integration whose
   * endpoints this vendor owns BOTH, the list emits one card per endpoint and
   * each one links to its own framing — which is the correct answer, not a
   * duplicate.
   *
   * No published/unpublished guard, deliberately. `ProductLink` carries no
   * publication status, the public handlers do not filter on `promotion_status`,
   * and D1's catalog is written only by promote — so a product this card can see
   * always has a live page. A pair page with no edge on record renders `noindex`
   * rather than 404ing, so the link cannot land on a missing page either.
   */
  protected readonly pairPageHref = computed(() => {
    const integration = this.integration();
    return `/products/${integration.context_product.slug}/integrations/${integration.other_product.slug}`;
  });

  /**
   * Built in TS rather than as an interpolated `i18n-aria-label` — an
   * interpolated `i18n-*` attribute emits no attribute at all in this toolchain,
   * so the link would end up unnamed rather than merely uniform. The visible
   * text leads so WCAG 2.5.3 Label in Name holds and speech input can target it
   * (`DESIGN.md` §"Integration group card").
   */
  protected readonly pairPageAriaLabel = computed(() => {
    const integration = this.integration();
    const context = integration.context_product.name;
    const other = integration.other_product.name;
    return $localize`:@@vendor.attest.card.viewPublic.aria:View public page: the ${context}:CONTEXT: and ${other}:OTHER: integration (opens in a new tab)`;
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
  protected readonly canAttest = computed(() => this.canWrite() && this.integration().attestable);

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
