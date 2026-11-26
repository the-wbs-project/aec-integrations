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

import { AecButton } from '../../shared/button/button';
import { BILLING_LINK_CLASS } from '../components/vendor-billing-styles';
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
 *
 * ── LOOK (AECI-1812) ────────────────────────────────────────────────────────
 * Each proposal is the shared white card. The accept summary is a Forest-soft panel,
 * the same as the Billing tab's accepted-grant notice.
 */
@Component({
  selector: 'aec-vendor-proposals-section',
  imports: [AecButton, RouterLink, VendorDocsLink, VendorProposalCard],
  template: `
    <h2
      #headingEl
      tabindex="-1"
      class="w-fit rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
      i18n="@@vendor.section.proposals"
    >
      Proposed products
    </h2>
    @if (!isOwner()) {
      <p
        class="mt-2 text-t-14 leading-[1.6] text-pretty text-(--text-secondary)"
        data-testid="proposals-owners-only"
        i18n="@@vendor.proposals.ownersOnly"
      >
        Only account owners decide proposed products. Ask an owner on the Seats tab if a product is
        missing from your listing.
      </p>
    } @else {
      <p
        class="mt-2 text-t-14 leading-[1.6] text-pretty text-(--text-secondary)"
        i18n="@@vendor.proposals.intro"
      >
        Your company owns its listing, so AEC Integrations does not add products to it. When we find
        a new one, it waits here. Accept adds it exactly as shown, and you can edit it afterwards.
        Decline means it is not added.
      </p>
      <p class="mt-2"><aec-vendor-docs-link page="editing-profile-and-products" /></p>

      @if (outcome(); as done) {
        <section
          #outcomeEl
          tabindex="-1"
          class="mt-6 rounded-panel border border-(--border-default) bg-(--accent-primary-soft) p-6 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
          aria-labelledby="vendor-proposals-outcome-heading"
          data-testid="proposals-outcome"
        >
          <h3 id="vendor-proposals-outcome-heading">
            {{ outcomeHeading() }}
          </h3>
          @if (done.dropped.length === 0) {
            <p
              class="mt-2 text-t-14 text-(--text-secondary)"
              i18n="@@vendor.proposals.outcome.nothingDropped"
            >
              Every value was added.
            </p>
          } @else {
            <p
              class="mt-2 text-t-14 text-(--text-secondary)"
              i18n="@@vendor.proposals.outcome.droppedIntro"
            >
              These values name no existing term on AEC Integrations, so they were left out:
            </p>
            <ul
              class="mt-2 list-disc space-y-1 ps-5 text-t-14 text-(--text-primary)"
              data-testid="proposals-outcome-dropped"
            >
              @for (term of done.dropped; track $index) {
                <li>{{ facetNoun(term.facet) }}: {{ term.value }}</li>
              }
            </ul>
          }
          <p class="mt-4">
            <a
              [routerLink]="['../products', done.slug]"
              [class]="linkClass + ' text-t-14 font-semibold'"
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
          class="mt-4 rounded-mark text-t-14 font-semibold text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
          data-testid="proposals-stale"
        >
          {{ message }}
        </p>
      }

      @if (loading()) {
        <p class="mt-6 text-t-14 text-(--text-secondary)" i18n="@@vendor.proposals.loading">
          Loading proposed products…
        </p>
      } @else if (failed()) {
        <div class="mt-6 flex flex-wrap items-center gap-4">
          <p class="text-t-14 text-(--text-primary)" i18n="@@vendor.proposals.error">
            Could not load proposed products.
          </p>
          <button
            aecButton
            variant="secondary"
            compact
            type="button"
            (click)="load()"
            i18n="@@vendor.proposals.retry"
          >
            Try again
          </button>
        </div>
      } @else if (proposals().length === 0) {
        <p
          class="mt-6 max-w-[32rem] text-t-14 leading-[1.6] text-pretty text-(--text-secondary)"
          data-testid="proposals-empty"
          i18n="@@vendor.proposals.empty"
        >
          No products are waiting for a decision. When AEC Integrations finds a new product for your
          company, it appears here and every owner gets an email.
        </p>
      } @else {
        <ul class="mt-6 list-none space-y-6 p-0" data-testid="proposals-list">
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
          <p class="mt-4 text-xs text-(--text-secondary)" i18n="@@vendor.proposals.truncated">
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
  protected readonly linkClass = BILLING_LINK_CLASS;

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
