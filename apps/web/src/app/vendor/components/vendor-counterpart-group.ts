import { Component, computed, input, output, viewChildren } from '@angular/core';

import type { DataObjectOption, ProductVersion, VendorClaim } from '@aeci/shared';

import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { ViewPublicLink } from '../../shared/view-public-link/view-public-link';

import { healthCountsLine } from './vendor-attestation-labels';
import { VendorHealthPill } from './vendor-health-pill';
import { VendorIntegrationCard } from './vendor-integration-card';
import type { CounterpartGroup } from './vendor-integration-health';

/**
 * The FIRST level of the Integrations tab's drill-down (AECI-999 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §6.3): one collapsed row per product the
 * context product integrates with, showing its health at a glance.
 *
 * The row is the WAI-ARIA disclosure pattern written out, the same shape as the
 * public `integration-group-card.ts` (AECI-841) and for the same reason: the
 * Angular Aria accordion creates its panel in `afterRenderEffect`, which never
 * runs on the server (ADR 0010, deviation (c)). An `<h2>` (the page's `<h1>` is the product name) wrapping a
 * `<button aria-expanded aria-controls>`, panel as a named `role="region"`,
 * hidden with the `hidden` attribute. Content stays in the DOM when collapsed,
 * which is what keeps a half-typed note alive.
 *
 * The public-page link sits BESIDE the heading button, never inside it: a link
 * cannot nest in a button, and the heading is the region's accessible name, so
 * anything inside it is re-read on every entry (AECI-960, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.7). It points at the PAIR page, which is where the claims edited below
 * render, and its accessible name is destination-specific because the row
 * repeats.
 *
 * Fully controlled: the section owns which groups are open, because the open
 * set is shareable URL state.
 *
 * When the group has exactly one integration, its card renders in `direct` mode
 * and opening this row goes straight to the data flows (§6.3 "one integration
 * skips a level").
 */
@Component({
  selector: 'aec-vendor-counterpart-group',
  imports: [LogoOrInitial, ViewPublicLink, VendorHealthPill, VendorIntegrationCard],
  host: { class: 'block' },
  template: `
    <section
      class="overflow-hidden rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised)"
    >
      <div class="flex flex-wrap items-center gap-x-3 pe-4">
        <h2 [id]="headingId()" class="m-0 min-w-0 flex-1">
          <button
            type="button"
            [attr.aria-expanded]="expanded()"
            [attr.aria-controls]="panelId()"
            (click)="toggled.emit()"
            class="flex w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3
              text-start text-(--text-primary) transition-colors hover:bg-(--surface-sunken)
              focus-visible:outline-2 focus-visible:-outline-offset-2
              focus-visible:outline-(--accent-primary)"
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
              <aec-logo-or-initial
                [src]="group().otherProduct.logo_url"
                [name]="group().otherProduct.name"
                size="sm"
              />
              <span class="min-w-0">
                <!-- The size lives on the SPAN: styles.css sizes h2 outside any
                     cascade layer, so a text-* utility on the h2 is dead
                     (DESIGN.md §3, "The Unlayered-Heading Rule"). -->
                <span class="block truncate font-display text-lg font-semibold">{{
                  group().otherProduct.name
                }}</span>
                <span class="mt-0.5 block font-body text-xs font-normal text-(--text-secondary)">{{
                  subline()
                }}</span>
              </span>
            </span>
            <!-- font-body: the unlayered h2 rule sets the display face, and the
                 pill and count line inherit it without this. -->
            <span class="ps-7 font-body sm:ps-0"
              ><aec-vendor-health-pill [health]="group().health"
            /></span>
          </button>
        </h2>
        <aec-view-public-link [href]="pairPageHref()" [ariaLabel]="pairPageAriaLabel()" />
      </div>

      <div
        [id]="panelId()"
        role="region"
        [attr.aria-labelledby]="headingId()"
        [hidden]="!expanded()"
        class="border-t border-(--border-default) bg-(--surface-base)"
      >
        <div class="divide-y divide-(--border-default)">
          @for (integration of group().integrations; track integration.id) {
            <aec-vendor-integration-card
              [integration]="integration"
              [mode]="group().totalIntegrations === 1 ? 'direct' : 'nested'"
              [vendorName]="vendorName()"
              [canWrite]="canWrite()"
              [dataObjects]="dataObjects()"
              [versions]="versions()"
              (claimChanged)="claimChanged.emit($event)"
              (claimCreated)="claimCreated.emit($event)"
              (retracted)="retracted.emit($event)"
            />
          }
        </div>
      </div>
    </section>
  `,
})
export class VendorCounterpartGroup {
  readonly group = input.required<CounterpartGroup>();
  readonly expanded = input(false);
  readonly vendorName = input.required<string>();
  readonly canWrite = input.required<boolean>();
  readonly dataObjects = input.required<readonly DataObjectOption[]>();
  /** Versions of the caller's own endpoint product (`context_product`). */
  readonly versions = input.required<readonly ProductVersion[]>();

  readonly toggled = output<void>();
  readonly claimChanged = output<VendorClaim>();
  readonly claimCreated = output<VendorClaim>();
  readonly retracted = output<string>();

  private readonly cards = viewChildren(VendorIntegrationCard);

  protected readonly headingId = computed(
    () => `vendor-counterpart-${this.group().contextProduct.id}-${this.group().otherProduct.id}`,
  );
  protected readonly panelId = computed(() => `${this.headingId()}-panel`);

  /** Integration count (only when there is more than one), then the flow counts. */
  protected readonly subline = computed(() => {
    const group = this.group();
    const counts = healthCountsLine(group.counts);
    const n = group.integrations.length;
    return n > 1
      ? `${$localize`:@@vendor.attest.group.integrations:${n}:count: integrations`} · ${counts}`
      : counts;
  });

  /**
   * The public pair page, `/products/:contextSlug/integrations/:otherSlug`.
   * Context first, other second: the pair route's segments are positional, so
   * swapping them addresses the mirror page, which frames every direction the
   * other way round.
   */
  protected readonly pairPageHref = computed(() => {
    const group = this.group();
    return `/products/${group.contextProduct.slug}/integrations/${group.otherProduct.slug}`;
  });

  /** Built in TS: an interpolated `i18n-aria-label` emits no attribute at all in
   *  this toolchain. Starts with the visible text (WCAG 2.5.3 Label in Name). */
  protected readonly pairPageAriaLabel = computed(() => {
    const group = this.group();
    const context = group.contextProduct.name;
    const other = group.otherProduct.name;
    return $localize`:@@vendor.attest.card.viewPublic.aria:View public page: the ${context}:CONTEXT: and ${other}:OTHER: integration (opens in a new tab)`;
  });

  /** Whether any integration in this group holds the claim. */
  hasClaim(claimId: string): boolean {
    return this.group().integrations.some((i) => i.claims.some((c) => c.id === claimId));
  }

  focusClaim(claimId: string): void {
    for (const card of this.cards()) card.focusClaim(claimId);
  }
}
