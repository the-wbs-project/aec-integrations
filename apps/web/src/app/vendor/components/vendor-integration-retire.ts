import { formatDate } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';

import type { VendorIntegration } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { vendorHasActiveEntitlement } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * The retire and restore section of one integration card (AECI-1010 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.6).
 *
 * Its own component, and its own section at the foot of the card, so the owner's
 * other card-level writes (the edit form, per-side links) can land beside it without
 * sharing template or state.
 *
 * Four states, decided from the wire and never re-derived beyond it:
 *
 * - **Live, owner, claimed, attestable** — a Retire button. Retiring needs a second,
 *   explicit step: the button opens an inline confirmation that says what happens,
 *   and only its own button sends the request. No browser `confirm()`: it cannot be
 *   styled or localized, and it blocks the page.
 * - **Retired, owner** — a status line and a Restore button. Restore is immediate: it
 *   puts back exactly what was there.
 * - **Retired by AEC Integrations** (AECI-1046, `retired_by = 'aeci'`) — "Retired by
 *   AEC Integrations", and no Restore for anyone: only an admin restores an admin
 *   retire (ruled 2026-09-22).
 * - **Retired, other endpoint vendor** — the status line only, read-only (ruled
 *   2026-09-22). It is what the retire notification lands on.
 * - **Anything else** — nothing. An unclaimed row cannot be retired, and saying so
 *   on every card would be noise.
 *
 * A claimed connector-powered row (`attestable` false) is retirable since AECI-1091
 * (the AECI-1040 carve-out), but only by an owner whose vendor holds an active
 * entitlement. Without one the Retire button is not offered (the ownership block
 * above says a plan is needed), and a retired row shows its status line with a
 * sentence in place of Restore.
 *
 * Writes are pessimistic, like every form here (`STAGE_2_REALTIME_SPEC.md`): the
 * section switches state only once the server has answered, then revalidates the
 * `integrations` scope (and `contests`, which a retire closes). Outcomes go through
 * the portal's one live region. Focus follows the change, so a keyboard user is never
 * left on a button that just disappeared.
 */
@Component({
  selector: 'aec-vendor-integration-retire',
  styles: [':host { display: block; }'],
  template: `
    @if (retiredAt(); as when) {
      <section
        class="border-t border-(--border-default) px-5 py-4"
        [attr.aria-labelledby]="fieldId('status')"
        data-testid="retire-section"
      >
        <p
          #status
          [id]="fieldId('status')"
          tabindex="-1"
          class="max-w-prose text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >
          {{ retiredLine(when) }}
        </p>
        @if (isOwner() && retiredByAeci()) {
          <p
            class="mt-1 max-w-prose text-xs text-(--text-secondary)"
            i18n="@@vendor.retire.retired.aeciOwnerHelp"
          >
            Its data flows and confirmations are kept. Only AEC Integrations can restore it.
          </p>
        } @else if (isOwner() && !canRestore()) {
          <p
            class="mt-1 max-w-prose text-xs text-(--text-secondary)"
            data-testid="retire-restore-needs-plan"
            i18n="@@vendor.retire.retired.needsPlan"
          >
            Its data flows and confirmations are kept. Restoring an integration delivered through a
            connector needs an active plan. Contact AEC Integrations to activate or renew it.
          </p>
        } @else if (isOwner()) {
          <p
            class="mt-1 max-w-prose text-xs text-(--text-secondary)"
            i18n="@@vendor.retire.retired.ownerHelp"
          >
            Its data flows and confirmations are kept. Restoring puts it back on the public site as
            it was.
          </p>
          <div class="mt-3">
            <button
              type="button"
              [class]="secondaryButtonClass"
              [disabled]="busy()"
              (click)="onRestore()"
            >
              @if (busy()) {
                <span i18n="@@vendor.retire.restoring">Restoring…</span>
              } @else {
                <span i18n="@@vendor.retire.restore">Restore integration</span>
              }
            </button>
          </div>
        }
        @if (notice(); as message) {
          <p role="alert" class="mt-2 text-sm font-medium text-(--text-primary)">{{ message }}</p>
        }
      </section>
    } @else if (canRetire()) {
      <section
        class="border-t border-(--border-default) px-5 py-4"
        [attr.aria-label]="sectionLabel"
        data-testid="retire-section"
      >
        @if (!confirming()) {
          <button
            #trigger
            type="button"
            [class]="secondaryButtonClass"
            (click)="openConfirm()"
            i18n="@@vendor.retire.trigger"
          >
            Retire integration
          </button>
        } @else {
          <div
            [id]="fieldId('confirm')"
            role="group"
            [attr.aria-labelledby]="fieldId('confirm-title')"
            [attr.aria-describedby]="fieldId('confirm-body')"
            class="rounded-(--radius-md) border border-(--border-strong) bg-(--surface-sunken) p-4"
          >
            <p
              [id]="fieldId('confirm-title')"
              class="text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.retire.confirm.title"
            >
              Retire this integration?
            </p>
            <p
              [id]="fieldId('confirm-body')"
              class="mt-1 max-w-prose text-sm text-(--text-secondary)"
            >
              {{ confirmBody() }}
            </p>
            <div class="mt-3 flex flex-wrap gap-3">
              <button
                #confirm
                type="button"
                [class]="primaryButtonClass"
                [disabled]="busy()"
                (click)="onRetire()"
              >
                @if (busy()) {
                  <span i18n="@@vendor.retire.retiring">Retiring…</span>
                } @else {
                  <span i18n="@@vendor.retire.confirm.submit">Retire integration</span>
                }
              </button>
              <button
                type="button"
                [class]="secondaryButtonClass"
                [disabled]="busy()"
                (click)="cancelConfirm()"
                i18n="@@vendor.retire.confirm.cancel"
              >
                Keep it live
              </button>
            </div>
          </div>
        }
        @if (notice(); as message) {
          <p role="alert" class="mt-2 text-sm font-medium text-(--text-primary)">{{ message }}</p>
        }
      </section>
    }
  `,
})
export class VendorIntegrationRetire {
  readonly integration = input.required<VendorIntegration>();

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);

  private readonly statusEl = viewChild<ElementRef<HTMLElement>>('status');
  private readonly triggerEl = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly confirmEl = viewChild<ElementRef<HTMLButtonElement>>('confirm');

  /**
   * The row's retire state: the wire value, overridden by this section's own write
   * until the revalidated list arrives. `linkedSignal`, so a new `integration` input
   * (the store's refetch) always wins over the local value.
   */
  protected readonly retiredAt = linkedSignal(() => this.integration().retired_at);
  /** Who retired it (AECI-1046), tracked with `retiredAt`. On `'aeci'` the owner gets
   *  no Restore: only an admin restores an admin retire. */
  protected readonly retiredBy = linkedSignal(() => this.integration().retired_by);
  protected readonly retiredByAeci = computed(
    () => this.retiredAt() !== null && this.retiredBy() === 'aeci',
  );

  protected readonly confirming = signal(false);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);

  protected readonly isOwner = computed(() => this.integration().is_owner);

  /** Does the caller's vendor hold an active entitlement? The same test the
   *  server's `hasActiveEntitlement` makes, so the button and the 403 agree. */
  private readonly entitled = vendorHasActiveEntitlement(this.store);

  /** Owner and claimed. On a connector-powered row (`attestable` false, the
   *  server's answer read off the wire), also entitled: the AECI-1040 carve-out
   *  opens retire there only with an active plan (AECI-1091, ruling 2). Unentitled,
   *  the ownership block above already says a plan is needed. */
  protected readonly canRetire = computed(() => {
    const integration = this.integration();
    if (!integration.is_owner || integration.claimed_at === null) return false;
    return integration.attestable || this.entitled();
  });

  /** Restore follows the same rule: an unentitled owner of a connector-powered row
   *  sees the retired line and no button, rather than a button that answers 403. */
  protected readonly canRestore = computed(() => this.integration().attestable || this.entitled());

  protected readonly sectionLabel = $localize`:@@vendor.retire.section:Retire this integration`;

  protected readonly confirmBody = computed(() => {
    const other = this.integration().other_product.name;
    return $localize`:@@vendor.retire.confirm.body:It leaves the public site and search, and stops counting on your product and on ${other}:other:. ${other}:other:’s vendor is told. Open contests on it close as withdrawn, and restoring it does not reopen them. Its data flows and confirmations are kept, and you can restore it at any time.`;
  });

  protected retiredLine(when: string): string {
    const date = this.formatDay(when);
    if (this.retiredByAeci()) {
      return this.isOwner()
        ? $localize`:@@vendor.retire.retired.aeciOwner:Retired by AEC Integrations on ${date}:DATE:. It is hidden from the public site, from search and from every count.`
        : $localize`:@@vendor.retire.retired.aeciOther:Retired by AEC Integrations on ${date}:DATE:. It no longer appears on the public site. You can read it here, but not change it.`;
    }
    if (this.isOwner()) {
      return $localize`:@@vendor.retire.retired.owner:You retired this integration on ${date}:DATE:. It is hidden from the public site, from search and from every count.`;
    }
    const owner = this.integration().owner?.name;
    return owner
      ? $localize`:@@vendor.retire.retired.other:${owner}:OWNER: retired this integration on ${date}:DATE:. It no longer appears on the public site. You can read it here, but not change it.`
      : $localize`:@@vendor.retire.retired.otherUnnamed:Its owner retired this integration on ${date}:DATE:. It no longer appears on the public site. You can read it here, but not change it.`;
  }

  protected openConfirm(): void {
    this.notice.set(null);
    this.confirming.set(true);
    afterNextRender(() => this.confirmEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancelConfirm(): void {
    this.confirming.set(false);
    this.notice.set(null);
    afterNextRender(() => this.triggerEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected async onRetire(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const { integration, withdrawn_contest_ids } = await this.api.retireIntegration(
        this.integration().id,
      );
      this.busy.set(false);
      this.confirming.set(false);
      this.retiredAt.set(integration.retired_at);
      this.retiredBy.set(integration.retired_by);
      this.announcer.announce(
        withdrawn_contest_ids.length > 0
          ? $localize`:@@vendor.retire.live.retiredContests:Integration retired. Its open contests were closed as withdrawn.`
          : $localize`:@@vendor.retire.live.retired:Integration retired. It no longer appears on the public site.`,
      );
      afterNextRender(() => this.statusEl()?.nativeElement.focus(), { injector: this.injector });
      void this.store.revalidate(['integrations', 'contests']);
    } catch (err) {
      this.busy.set(false);
      this.notice.set(retireErrorMessage(err));
    }
  }

  protected async onRestore(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    try {
      const { integration } = await this.api.restoreIntegration(this.integration().id);
      this.busy.set(false);
      this.retiredAt.set(integration.retired_at);
      this.retiredBy.set(integration.retired_by);
      this.announcer.announce(
        $localize`:@@vendor.retire.live.restored:Integration restored. It is back on the public site.`,
      );
      afterNextRender(() => this.triggerEl()?.nativeElement.focus(), { injector: this.injector });
      void this.store.revalidate(['integrations']);
    } catch (err) {
      this.busy.set(false);
      this.notice.set(retireErrorMessage(err));
    }
  }

  protected fieldId(key: string): string {
    return `vendor-retire-${this.integration().id}-${this.integration().context_product.id}-${key}`;
  }

  /** Server timestamps are UTC, and so is this, so SSR and the browser agree. */
  private formatDay(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : formatDate(date, 'MMMM d, y', this.locale, 'UTC');
  }

  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}

/** One message per refusal the two routes can answer. */
export function retireErrorMessage(err: unknown): string {
  switch (readVendorApiError(err)?.code) {
    case 'INTEGRATION_RETIRED':
      return $localize`:@@vendor.retire.error.retired:This integration is already retired. Reload to see its current state.`;
    case 'INTEGRATION_NOT_RETIRED':
      return $localize`:@@vendor.retire.error.notRetired:This integration is already live. Reload to see its current state.`;
    case 'INTEGRATION_CHANGED_WHILE_SAVING':
      return $localize`:@@vendor.retire.error.changed:This integration changed while you were saving. Reload and try again.`;
    case 'INTEGRATION_NOT_CLAIMED':
      return $localize`:@@vendor.retire.error.notClaimed:Claim this integration before retiring it.`;
    case 'INTEGRATION_RETIRED_BY_AECI':
      return $localize`:@@vendor.retire.error.retiredByAeci:AEC Integrations retired this integration, so only AEC Integrations can restore it. Reload to see its current state.`;
    case 'INTEGRATION_NOT_OWNER':
      return $localize`:@@vendor.retire.error.notOwner:Only the company that owns this integration can retire or restore it.`;
    case 'INTEGRATION_CONNECTOR_POWERED':
      return $localize`:@@vendor.retire.error.connector:Integrations delivered through a connector cannot be retired yet.`;
    case 'INTEGRATION_ENTITLEMENT_REQUIRED':
      return $localize`:@@vendor.retire.error.entitlement:Retiring or restoring an integration delivered through a connector needs an active plan. Contact AEC Integrations to activate or renew it.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.retire.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.retire.error.generic:Could not save the change. Try again.`;
  }
}
