import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

import type {
  AcceptVendorProposalResponse,
  ProposalTermFacet,
  VendorProposal,
  VendorProposalTerm,
} from '@aeci/shared';

import { RouterLink } from '@angular/router';

import { formatTermDate } from '../../shared/term-date/format-term-date';
import { readVendorApiError } from '../vendor-api-error';
import { VendorApi } from '../vendor-api';

/** Which decision the inline confirmation is for. */
type Decision = 'accept' | 'decline';

/** One facet's values, in the order the card lists them. */
interface TermGroup {
  readonly facet: ProposalTermFacet;
  readonly label: string;
  readonly terms: readonly VendorProposalTerm[];
}

const FACET_ORDER: readonly ProposalTermFacet[] = [
  'category',
  'audience',
  'phase',
  'trade',
  'usefulness',
  'extension',
];

function facetLabel(facet: ProposalTermFacet): string {
  switch (facet) {
    case 'category':
      return $localize`:@@vendor.proposals.facet.category:Categories`;
    case 'audience':
      return $localize`:@@vendor.proposals.facet.audience:Audiences`;
    case 'phase':
      return $localize`:@@vendor.proposals.facet.phase:Phases`;
    case 'trade':
      return $localize`:@@vendor.proposals.facet.trade:Trades`;
    case 'usefulness':
      return $localize`:@@vendor.proposals.facet.usefulness:How teams use it`;
    case 'extension':
      return $localize`:@@vendor.proposals.facet.extension:Built on`;
  }
}

/** What a stale or failed decision says (`API_CONTRACTS.md` §4). */
export function proposalDecisionErrorMessage(err: unknown, decision: Decision): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'PROPOSAL_ALREADY_DECIDED':
      return $localize`:@@vendor.proposals.error.decided:Another owner already decided this proposal. The list is up to date now.`;
    case 'VENDOR_NOT_OWNED':
      return $localize`:@@vendor.proposals.error.notOwned:Your company no longer owns its records, so this product cannot be added from here. Contact AEC Integrations.`;
    case 'PROPOSAL_VENDOR_MISSING':
      return $localize`:@@vendor.proposals.error.vendorMissing:A company this product would be listed under no longer exists, so it cannot be accepted. Decline it and contact us.`;
    case 'SLUG_CONFLICT':
      return $localize`:@@vendor.proposals.error.slug:Another product took this name at the same moment. Try again.`;
  }
  switch (info?.status) {
    case 403:
      return $localize`:@@vendor.proposals.error.forbidden:Only account owners can decide proposed products.`;
    case 404:
      return $localize`:@@vendor.proposals.error.notFound:This proposal is no longer open. The list is up to date now.`;
    case 429:
      return $localize`:@@vendor.proposals.error.rateLimited:Too many changes at once. Wait a minute and try again.`;
  }
  return decision === 'accept'
    ? $localize`:@@vendor.proposals.error.accept:Could not accept the proposal. Try again.`
    : $localize`:@@vendor.proposals.error.decline:Could not decline the proposal. Try again.`;
}

/** A `409` or `404`: our copy of the list is out of date, so the section re-reads it. */
export function proposalDecisionIsStale(err: unknown): boolean {
  return err instanceof HttpErrorResponse && (err.status === 409 || err.status === 404);
}

/**
 * One proposed product on the "Proposed products" tab (AECI-1417, E6b.5;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.22). It shows what an accept would create: the
 * name, the description, the companies it is listed under and every taxonomy value,
 * with the values that name no existing term marked "Not added". Then Accept and
 * Decline.
 *
 * ── NOTHING IS EDITED HERE (ruling B) ───────────────────────────────────────
 * Accept creates the product exactly as shown. An owner who sees something wrong
 * declines; once accepted, the product is theirs to edit like any other.
 *
 * ── CONFIRM INLINE ──────────────────────────────────────────────────────────
 * The Billing tab's pattern (`vendor-license-assign.ts`), never a modal: each button
 * opens an inline confirmation that says what happens, and only its own button
 * writes. Focus moves to that button, and back to the button that opened it on
 * Cancel or Escape (ignored while the write runs).
 *
 * ── PESSIMISTIC ─────────────────────────────────────────────────────────────
 * The write is awaited. A success emits `accepted` or `declined` and the section
 * removes the card. A `409` or `404` emits `stale`: another owner or tab decided
 * first, and the section re-reads the list. Any other failure stays on the card.
 */
@Component({
  selector: 'aec-vendor-proposal-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [RouterLink],
  template: `
    <article
      class="rounded-(--radius-md) border bg-(--surface-raised) p-5"
      [attr.aria-labelledby]="id('name')"
      data-testid="proposal-card"
    >
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 [id]="id('name')" class="font-display text-lg font-semibold text-(--text-primary)">
          {{ proposal().product.name }}
        </h3>
        <p class="text-xs text-(--text-secondary)">{{ proposedLabel() }}</p>
      </div>

      @if (proposal().product.description_excerpt; as description) {
        <p class="mt-2 max-w-[34rem] text-sm leading-relaxed text-(--text-primary)">
          {{ description }}
        </p>
      } @else {
        <p
          class="mt-2 text-sm text-(--text-secondary)"
          i18n="@@vendor.proposals.card.noDescription"
        >
          No description was sent.
        </p>
      }

      <dl class="mt-4 grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
        @if (proposal().product.website; as website) {
          <div>
            <dt [class]="dtClass" i18n="@@vendor.proposals.card.website">Website</dt>
            <dd class="mt-1 break-all text-(--text-primary)" data-testid="proposal-website">
              {{ website }}
            </dd>
          </div>
        }
        <div>
          <dt [class]="dtClass" i18n="@@vendor.proposals.card.companies">Listed under</dt>
          <dd class="mt-1">
            <ul class="m-0 list-none space-y-1 p-0" data-testid="proposal-vendors">
              @for (vendor of proposal().vendors; track vendor.id) {
                <li class="text-(--text-primary)">
                  {{ vendor.name }}
                  @if (vendor.is_primary) {
                    <span
                      class="text-xs text-(--text-secondary)"
                      i18n="@@vendor.proposals.card.primary"
                      >(primary)</span
                    >
                  }
                  @if (!vendor.exists) {
                    <span
                      class="text-xs font-semibold text-(--text-primary)"
                      i18n="@@vendor.proposals.card.vendorGone"
                      >(no longer exists)</span
                    >
                  }
                </li>
              }
            </ul>
          </dd>
        </div>
        @for (group of termGroups(); track group.facet) {
          <div>
            <dt [class]="dtClass">{{ group.label }}</dt>
            <dd class="mt-1">
              <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0">
                @for (term of group.terms; track $index) {
                  <li
                    [class]="term.exists ? keptClass : droppedClass"
                    [attr.data-testid]="term.exists ? 'proposal-term' : 'proposal-term-dropped'"
                  >
                    {{ term.name ?? term.value }}
                    @if (!term.exists) {
                      <span class="font-semibold" i18n="@@vendor.proposals.card.dropped"
                        >Not added</span
                      >
                    }
                  </li>
                }
              </ul>
            </dd>
          </div>
        }
      </dl>

      @if (droppedCount() > 0) {
        <p
          class="mt-3 max-w-[34rem] text-xs text-(--text-secondary)"
          data-testid="proposal-dropped-note"
        >
          {{ droppedNote() }}
        </p>
      }
      @if (vendorMissing()) {
        <p
          class="mt-3 max-w-[34rem] text-sm text-(--text-primary)"
          data-testid="proposal-vendor-missing"
        >
          <span i18n="@@vendor.proposals.card.vendorMissing"
            >A company this product would be listed under no longer exists, so it cannot be
            accepted. Decline it and
            <a
              routerLink="/contact"
              class="font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              data-testid="proposal-vendor-missing-contact"
              >contact us</a
            >.</span
          >
        </p>
      }

      @if (confirming(); as decision) {
        <div
          role="group"
          [attr.aria-labelledby]="id('confirm-title')"
          [attr.aria-describedby]="id('confirm-body')"
          class="mt-4 max-w-[34rem] rounded-(--radius-md) border bg-(--surface-sunken) p-4"
          (keydown.escape)="onEscape($event)"
          data-testid="proposal-confirm"
        >
          <p [id]="id('confirm-title')" class="text-sm font-semibold text-(--text-primary)">
            {{ decision === 'accept' ? acceptTitle() : declineTitle() }}
          </p>
          <p [id]="id('confirm-body')" class="mt-1 text-sm leading-relaxed text-(--text-secondary)">
            @if (decision === 'accept') {
              <span i18n="@@vendor.proposals.confirm.acceptBody"
                >The product is added to your listing exactly as shown, and you can edit it
                afterwards. Values marked Not added are left out.</span
              >
            } @else {
              <span i18n="@@vendor.proposals.confirm.declineBody"
                >The product is not added. AEC Integrations will not send it again.</span
              >
              <!-- AECI-1424 (vendor product create: an owner adds a product to its company)
                   decides this sentence. When it ships, keep it if the dashboard create exists
                   as described, or remove it. Ruled 2026-10-20. -->
              <span
                i18n="@@vendor.proposals.confirm.declineAddYourself"
                data-testid="proposal-decline-add-yourself"
              >
                You can add the product yourself from your dashboard.</span
              >
            }
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button
              #confirmEl
              type="button"
              [class]="decision === 'accept' ? primaryClass : secondaryClass"
              [disabled]="busy()"
              [attr.aria-busy]="busy() ? 'true' : null"
              (click)="decide(decision)"
              data-testid="proposal-confirm-submit"
            >
              @if (busy()) {
                <span i18n="@@vendor.proposals.confirm.saving">Saving…</span>
              } @else if (decision === 'accept') {
                <span i18n="@@vendor.proposals.confirm.accept">Accept and add product</span>
              } @else {
                <span i18n="@@vendor.proposals.confirm.decline">Decline product</span>
              }
            </button>
            <button
              type="button"
              [class]="secondaryClass"
              [disabled]="busy()"
              (click)="cancel()"
              data-testid="proposal-confirm-cancel"
              i18n="@@vendor.proposals.confirm.cancel"
            >
              Cancel
            </button>
          </div>
        </div>
      } @else {
        <div class="mt-5 flex flex-wrap gap-2">
          <button
            #acceptEl
            type="button"
            [class]="primaryClass"
            [disabled]="vendorMissing()"
            (click)="open('accept')"
            data-testid="proposal-accept"
          >
            <span i18n="@@vendor.proposals.accept">Accept</span>
          </button>
          <button
            #declineEl
            type="button"
            [class]="secondaryClass"
            (click)="open('decline')"
            data-testid="proposal-decline"
          >
            <span i18n="@@vendor.proposals.decline">Decline</span>
          </button>
        </div>
      }

      @if (notice(); as message) {
        <p
          role="alert"
          class="mt-3 max-w-[34rem] text-sm font-medium text-(--text-primary)"
          data-testid="proposal-error"
        >
          {{ message }}
        </p>
      }
    </article>
  `,
})
export class VendorProposalCard {
  private readonly api = inject(VendorApi);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);

  readonly proposal = input.required<VendorProposal>();
  /** The accept succeeded: the new product and every value it dropped. */
  readonly accepted = output<AcceptVendorProposalResponse>();
  /** The decline succeeded, with the proposal id. */
  readonly declined = output<string>();
  /** A stale refusal (`409`/`404`), with its message. The section re-reads the list. */
  readonly stale = output<string>();

  protected readonly confirming = signal<Decision | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);

  private readonly acceptEl = viewChild<ElementRef<HTMLButtonElement>>('acceptEl');
  private readonly declineEl = viewChild<ElementRef<HTMLButtonElement>>('declineEl');
  private readonly confirmEl = viewChild<ElementRef<HTMLButtonElement>>('confirmEl');

  protected readonly proposedLabel = computed(() => {
    const date = formatTermDate(this.proposal().proposed_at, this.locale);
    return $localize`:@@vendor.proposals.card.proposedAt:Proposed ${date}:DATE:`;
  });

  protected readonly termGroups = computed<readonly TermGroup[]>(() => {
    const terms = this.proposal().terms;
    return FACET_ORDER.map((facet) => ({
      facet,
      label: facetLabel(facet),
      terms: terms.filter((t) => t.facet === facet),
    })).filter((g) => g.terms.length > 0);
  });

  protected readonly droppedCount = computed(
    () => this.proposal().terms.filter((t) => !t.exists).length,
  );
  protected readonly droppedNote = computed(() => {
    const count = this.droppedCount();
    return count === 1
      ? $localize`:@@vendor.proposals.card.droppedOne:1 value names no existing term on AEC Integrations, so accepting leaves it out. Nothing new is created.`
      : $localize`:@@vendor.proposals.card.droppedMany:${count}:COUNT: values name no existing term on AEC Integrations, so accepting leaves them out. Nothing new is created.`;
  });
  protected readonly vendorMissing = computed(() => this.proposal().vendors.some((v) => !v.exists));

  protected readonly acceptTitle = computed(() => {
    const name = this.proposal().product.name;
    return $localize`:@@vendor.proposals.confirm.acceptTitle:Add ${name}:PRODUCT: to your listing?`;
  });
  protected readonly declineTitle = computed(() => {
    const name = this.proposal().product.name;
    return $localize`:@@vendor.proposals.confirm.declineTitle:Decline ${name}:PRODUCT:?`;
  });

  protected open(decision: Decision): void {
    this.notice.set(null);
    this.confirming.set(decision);
    afterNextRender(() => this.confirmEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected onEscape(event: Event): void {
    if (this.busy()) return;
    event.stopPropagation();
    this.cancel();
  }

  protected cancel(): void {
    const decision = this.confirming();
    this.confirming.set(null);
    this.focusTrigger(decision);
  }

  private focusTrigger(decision: Decision | null): void {
    afterNextRender(
      () => (decision === 'decline' ? this.declineEl() : this.acceptEl())?.nativeElement.focus(),
      { injector: this.injector },
    );
  }

  protected async decide(decision: Decision): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    const id = this.proposal().id;
    try {
      if (decision === 'accept') {
        const result = await this.api.acceptProposal(id);
        this.busy.set(false);
        this.accepted.emit(result);
      } else {
        await this.api.declineProposal(id);
        this.busy.set(false);
        this.declined.emit(id);
      }
    } catch (err) {
      this.busy.set(false);
      this.confirming.set(null);
      const message = proposalDecisionErrorMessage(err, decision);
      if (proposalDecisionIsStale(err)) {
        this.stale.emit(message);
        return;
      }
      this.notice.set(message);
      this.focusTrigger(decision);
    }
  }

  protected id(key: string): string {
    return `vendor-proposal-${this.proposal().id}-${key}`;
  }

  protected readonly dtClass =
    'text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly keptClass =
    'inline-flex items-center gap-1 rounded-(--radius-sm) border bg-(--surface-base) px-2 py-0.5 text-xs font-medium text-(--text-primary)';
  protected readonly droppedClass =
    'inline-flex items-center gap-1 rounded-(--radius-sm) border border-dashed bg-(--surface-sunken) px-2 py-0.5 text-xs text-(--text-secondary)';
  protected readonly primaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-4 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border bg-(--surface-base) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}
