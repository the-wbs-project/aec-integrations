import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  AcceptVendorProposalResponse,
  DroppedProposalTerm,
  ProposalTermFacet,
  VendorProposal,
} from '@aeci/shared';

import { VendorDocsLink } from '../components/vendor-docs-link';
import { VendorProposalCard } from '../components/vendor-proposal-card';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

/** The last accept, kept on screen so the owner sees what was left out. */
interface AcceptOutcome {
  readonly name: string;
  readonly slug: string;
  readonly dropped: readonly DroppedProposalTerm[];
}

function facetNoun(facet: ProposalTermFacet): string {
  switch (facet) {
    case 'category':
      return $localize`:@@vendor.proposals.dropped.category:Category`;
    case 'audience':
      return $localize`:@@vendor.proposals.dropped.audience:Audience`;
    case 'phase':
      return $localize`:@@vendor.proposals.dropped.phase:Phase`;
    case 'trade':
      return $localize`:@@vendor.proposals.dropped.trade:Trade`;
    case 'usefulness':
      return $localize`:@@vendor.proposals.dropped.usefulness:How teams use it`;
    case 'extension':
      return $localize`:@@vendor.proposals.dropped.extension:Built on`;
  }
}

/**
 * `…/proposals`: the owner-only "Proposed products" tab (AECI-1417, E6b.5;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.22, ADR 0042). Once a company owns its record,
 * a new product AEC Integrations finds for it is not added. It waits here until an
 * owner accepts it (the product is created exactly as shown) or declines it.
 *
 * ── OWNERS ONLY ─────────────────────────────────────────────────────────────
 * The Billing tab's rule. The nav drops the tab for a member seat on
 * `me.seat_owner`; a member who types the URL gets a short note here and NO request,
 * because the read answers `403` to a member. The API re-checks the bit.
 *
 * ── STATE ───────────────────────────────────────────────────────────────────
 * Section-local, loaded once from `afterNextRender` over `GET /api/vendor/proposals`.
 * No realtime scope carries proposals, so a colleague's decision shows on reload, or
 * as the `409` a stale card meets, after which the list is re-read.
 *
 * ── AFTER A DECISION ────────────────────────────────────────────────────────
 * The card leaves the list. An accept keeps a summary above the list: the new
 * product, a link to it in the portal, and every value it left out. It revalidates
 * the `products` scope, so `/me` (and the Products tab) gains the product. Focus
 * moves to the summary, or to the list heading after a decline, because the focused
 * button was just destroyed (WCAG 2.4.3). One announcement goes through the shell's
 * live region.
 */
@Component({
  selector: 'aec-vendor-proposals-section',
  imports: [RouterLink, VendorDocsLink, VendorProposalCard],
  template: `
    <h2
      #headingEl
      tabindex="-1"
      class="font-display text-xl font-semibold text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      i18n="@@vendor.section.proposals"
    >
      Proposed products
    </h2>
    @if (!isOwner()) {
      <p
        class="mt-2 max-w-[34rem] text-sm leading-relaxed text-(--text-secondary)"
        data-testid="proposals-owners-only"
        i18n="@@vendor.proposals.ownersOnly"
      >
        Only account owners decide proposed products. Ask an owner on the Seats tab if a product is
        missing from your listing.
      </p>
    } @else {
      <p
        class="mt-1 max-w-[34rem] text-sm leading-relaxed text-(--text-secondary)"
        i18n="@@vendor.proposals.intro"
      >
        Your company owns its listing, so AEC Integrations does not add products to it. When we find
        a new one, it waits here. Accept adds it exactly as shown, and you can edit it afterwards.
        Decline means it is not added.
      </p>
      <p class="mt-1"><aec-vendor-docs-link page="editing-profile-and-products" /></p>

      @if (outcome(); as done) {
        <section
          #outcomeEl
          tabindex="-1"
          class="mt-6 rounded-(--radius-md) border bg-(--surface-raised) p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          aria-labelledby="vendor-proposals-outcome-heading"
          data-testid="proposals-outcome"
        >
          <h3
            id="vendor-proposals-outcome-heading"
            class="font-label text-sm font-semibold text-(--text-primary)"
          >
            {{ outcomeHeading() }}
          </h3>
          @if (done.dropped.length === 0) {
            <p
              class="mt-1 text-sm text-(--text-secondary)"
              i18n="@@vendor.proposals.outcome.nothingDropped"
            >
              Every value was added.
            </p>
          } @else {
            <p
              class="mt-1 text-sm text-(--text-secondary)"
              i18n="@@vendor.proposals.outcome.droppedIntro"
            >
              These values name no existing term on AEC Integrations, so they were left out:
            </p>
            <ul
              class="mt-2 list-disc space-y-0.5 ps-5 text-sm text-(--text-primary)"
              data-testid="proposals-outcome-dropped"
            >
              @for (term of done.dropped; track $index) {
                <li>{{ facetNoun(term.facet) }}: {{ term.value }}</li>
              }
            </ul>
          }
          <p class="mt-3">
            <a
              [routerLink]="['../products', done.slug]"
              class="text-sm font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              data-testid="proposals-outcome-link"
              >{{ outcomeLinkLabel() }}</a
            >
          </p>
        </section>
      }

      @if (staleNotice(); as message) {
        <p
          #staleEl
          role="alert"
          tabindex="-1"
          class="mt-4 text-sm font-medium text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          data-testid="proposals-stale"
        >
          {{ message }}
        </p>
      }

      @if (loading()) {
        <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@vendor.proposals.loading">
          Loading proposed products…
        </p>
      } @else if (failed()) {
        <div class="mt-6 flex flex-wrap items-center gap-3">
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.proposals.error">
            Could not load proposed products.
          </p>
          <button
            type="button"
            [class]="retryClass"
            (click)="load()"
            i18n="@@vendor.proposals.retry"
          >
            Try again
          </button>
        </div>
      } @else if (proposals().length === 0) {
        <p
          class="mt-6 max-w-[34rem] text-sm text-(--text-secondary)"
          data-testid="proposals-empty"
          i18n="@@vendor.proposals.empty"
        >
          No products are waiting for a decision. When AEC Integrations finds a new product for your
          company, it appears here and every owner gets an email.
        </p>
      } @else {
        <ul class="mt-6 list-none space-y-4 p-0" data-testid="proposals-list">
          @for (proposal of proposals(); track proposal.id) {
            <li>
              <aec-vendor-proposal-card
                [proposal]="proposal"
                (accepted)="onAccepted(proposal, $event)"
                (declined)="onDeclined(proposal)"
                (stale)="onStale($event)"
              />
            </li>
          }
        </ul>
        @if (truncated()) {
          <p class="mt-3 text-xs text-(--text-secondary)" i18n="@@vendor.proposals.truncated">
            Showing the 100 oldest proposals. Decide these to see the rest.
          </p>
        }
      }
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProposalsSection {
  private readonly store = inject(VendorPortalStore);
  private readonly api = inject(VendorApi);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  /** Absent `me` (never on a real route) reads as a member: fail closed. */
  protected readonly isOwner = computed(() => this.store.me()?.seat_owner === true);

  protected readonly proposals = signal<readonly VendorProposal[]>([]);
  protected readonly truncated = signal(false);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);
  protected readonly outcome = signal<AcceptOutcome | null>(null);
  protected readonly staleNotice = signal<string | null>(null);

  private readonly headingEl = viewChild<ElementRef<HTMLElement>>('headingEl');
  private readonly outcomeEl = viewChild<ElementRef<HTMLElement>>('outcomeEl');
  private readonly staleEl = viewChild<ElementRef<HTMLElement>>('staleEl');

  protected readonly outcomeHeading = computed(() => {
    const name = this.outcome()?.name ?? '';
    return $localize`:@@vendor.proposals.outcome.heading:${name}:PRODUCT: was added to your listing.`;
  });
  protected readonly outcomeLinkLabel = computed(() => {
    const name = this.outcome()?.name ?? '';
    return $localize`:@@vendor.proposals.outcome.link:Open ${name}:PRODUCT:`;
  });

  protected readonly facetNoun = facetNoun;
  protected readonly retryClass =
    'rounded-(--radius-sm) border px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => {
      if (this.isOwner()) void this.load();
    });
  }

  /** Read the open proposals. Never rejects: a failure shows the retry line. */
  async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const { proposals, truncated } = await this.api.listProposals();
      this.proposals.set(proposals);
      this.truncated.set(truncated);
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected onAccepted(proposal: VendorProposal, result: AcceptVendorProposalResponse): void {
    this.staleNotice.set(null);
    this.remove(proposal.id);
    this.outcome.set({
      name: result.product.name,
      slug: result.product.slug,
      dropped: result.dropped,
    });
    // `/me` lists the company's products; the new one belongs there now.
    void this.store.revalidate(['products']);
    const name = result.product.name;
    this.announcer.announce(
      $localize`:@@vendor.proposals.accepted:${name}:PRODUCT: was added to your listing.`,
    );
    afterNextRender(() => this.outcomeEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected onDeclined(proposal: VendorProposal): void {
    this.staleNotice.set(null);
    this.remove(proposal.id);
    const name = proposal.product.name;
    this.announcer.announce(
      $localize`:@@vendor.proposals.declined:${name}:PRODUCT: was declined and not added.`,
    );
    afterNextRender(() => this.headingEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async onStale(message: string): Promise<void> {
    this.staleNotice.set(message);
    await this.load();
    afterNextRender(() => this.staleEl()?.nativeElement.focus(), { injector: this.injector });
  }

  private remove(id: string): void {
    this.proposals.update((list) => list.filter((p) => p.id !== id));
  }
}
