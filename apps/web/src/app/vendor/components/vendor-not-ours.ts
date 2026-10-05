import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import {
  SubmitIntegrationContestSchema,
  type ContestAnchorKind,
  type SubmitIntegrationContestInput,
  type VendorContest,
} from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { readVendorApiError } from '../vendor-api-error';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import { NO_OWNER } from './vendor-contest-form';
import { contestSubmitErrorMessage } from './vendor-contest-labels';

/**
 * The caller's newest "not ours" on one row (AECI-1225): an `owner` contest it filed
 * about itself, the vendor on file. `submitted` is newest first, so the first match
 * is the one that stands. A withdrawn one is ignored, as if it was never filed.
 */
export function selfDisclaimOn(
  submitted: readonly VendorContest[],
  integrationId: string,
  anchor: ContestAnchorKind,
): VendorContest | null {
  return (
    submitted.find(
      (c) =>
        c.integration_id === integrationId &&
        (c.anchor ?? 'integration') === anchor &&
        c.field === 'owner' &&
        c.status !== 'withdrawn' &&
        c.owner_vendor !== null &&
        c.submitter_vendor.id === c.owner_vendor.id,
    ) ?? null
  );
}

/** Does a "not ours" stand on this row, so the claim is not offered beside it? */
export function selfDisclaimStands(contest: VendorContest | null): boolean {
  return contest?.status === 'open' || contest?.status === 'accepted';
}

/**
 * "Not ours?" beside "Claim this integration" (AECI-1225, the checklist's "Claim or
 * say not ours" step, `STAGE_2_PAID_TIERS_SPEC.md` §13.10).
 *
 * The vendor named as owner of a seeded, unclaimed row says it is not its own. On
 * the wire that is an `owner` contest on its own row, which the server allows only
 * there (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.2). It always goes to AEC
 * Integrations. While it is open or accepted, the checklist no longer counts the row.
 *
 * ── STATES, READ FROM THE `contests` RESOURCE ─────────────────────────────
 * - Open: a line saying AECi is reviewing it, and Withdraw.
 * - Accepted: a line saying AECi agreed, and the listing changes on its next
 *   catalog update. Nothing to do.
 * - Declined: a line saying AECi kept the company as owner, the decision note if
 *   any, and the trigger again.
 * - None or withdrawn: the trigger.
 *
 * The form is pessimistic, like `vendor-contest-form.ts`: it parses the body with
 * the shared schema, waits for the `201`, announces, closes, and revalidates
 * `contests`, which also refetches the checklists.
 */
@Component({
  selector: 'aec-vendor-not-ours',
  styles: [':host { display: block; }'],
  template: `
    @switch (contest()?.status) {
      @case ('open') {
        <p class="text-sm text-(--text-secondary)" data-testid="not-ours-open">
          <span i18n="@@vendor.notOurs.open"
            >You told AEC Integrations this integration is not yours. It is reviewing that.</span
          >
          <button
            #withdrawButton
            type="button"
            [class]="linkButtonClass"
            class="ms-2"
            [disabled]="withdrawing()"
            (click)="withdraw()"
            [attr.aria-label]="withdrawLabel()"
            data-testid="not-ours-withdraw"
          >
            @if (withdrawing()) {
              <span i18n="@@vendor.notOurs.withdrawing">Withdrawing…</span>
            } @else {
              <span i18n="@@vendor.notOurs.withdraw">Withdraw</span>
            }
          </button>
        </p>
      }
      @case ('accepted') {
        <p
          class="text-sm text-(--text-secondary)"
          data-testid="not-ours-accepted"
          i18n="@@vendor.notOurs.accepted"
        >
          AEC Integrations agreed this integration is not yours. The listing changes at its next
          catalog update.
        </p>
      }
      @default {
        @if (contest()?.status === 'declined') {
          <p class="mb-2 text-sm text-(--text-secondary)" data-testid="not-ours-declined">
            <span i18n="@@vendor.notOurs.declined"
              >AEC Integrations kept your company as the owner of this integration.</span
            >
            @if (contest()?.decision_note; as note) {
              <span class="ms-1">{{ note }}</span>
            }
          </p>
        }
        <button
          #trigger
          type="button"
          [class]="linkButtonClass"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="fieldId('panel')"
          [attr.aria-label]="triggerLabel()"
          (click)="toggle()"
          data-testid="not-ours"
          i18n="@@vendor.notOurs.trigger"
        >
          Not ours?
        </button>
      }
    }

    @if (open()) {
      <form
        [id]="fieldId('panel')"
        class="mt-3 max-w-2xl space-y-4 rounded-(--radius-md) border border-(--border-default) p-4"
        novalidate
        (submit)="onSubmit($event)"
        [attr.aria-labelledby]="fieldId('title')"
        data-testid="not-ours-form"
      >
        <div class="max-w-prose space-y-1">
          <p
            [id]="fieldId('title')"
            class="text-sm font-semibold text-(--text-primary)"
            i18n="@@vendor.notOurs.form.title"
          >
            Tell AEC Integrations this is not yours
          </p>
          <p class="text-xs text-(--text-secondary)" i18n="@@vendor.notOurs.form.intro">
            Your company is listed as the vendor that offers this integration. If that is wrong, AEC
            Integrations reviews it and corrects the listing. Until it answers, this integration no
            longer counts against your checklist.
          </p>
        </div>

        <div class="max-w-sm space-y-2">
          <label [for]="fieldId('owner')" [class]="labelClass" i18n="@@vendor.notOurs.form.owner"
            >Who offers it?</label
          >
          <div class="relative">
            <select
              [id]="fieldId('owner')"
              (change)="owner.set(selectValue($event))"
              [class]="selectClass"
            >
              @for (option of ownerOptions(); track option.value) {
                <option [value]="option.value" [selected]="option.value === owner()">
                  {{ option.label }}
                </option>
              }
            </select>
            <svg
              class="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </div>
        </div>

        <div class="space-y-2">
          <label [for]="fieldId('reason')" [class]="labelClass" i18n="@@vendor.notOurs.form.reason"
            >Why</label
          >
          <textarea
            [id]="fieldId('reason')"
            rows="3"
            maxlength="2000"
            required
            [value]="reason()"
            (input)="reason.set(inputValue($event))"
            [attr.aria-invalid]="showReasonError() ? 'true' : null"
            [attr.aria-describedby]="
              fieldId('reason') +
              '-hint' +
              (showReasonError() ? ' ' + fieldId('reason') + '-error' : '')
            "
            [class]="inputClass"
          ></textarea>
          <p
            [id]="fieldId('reason') + '-hint'"
            class="text-xs text-(--text-secondary)"
            i18n="@@vendor.notOurs.form.reasonHint"
          >
            Required. Say who offers it if you know, and link to a source if you have one.
          </p>
          @if (showReasonError()) {
            <p
              [id]="fieldId('reason') + '-error'"
              role="alert"
              class="text-xs font-medium text-(--text-primary)"
            >
              {{ reasonRequiredMessage }}
            </p>
          }
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <button type="submit" [class]="primaryButtonClass" [disabled]="submitting()">
            @if (submitting()) {
              <span i18n="@@vendor.notOurs.form.sending">Sending…</span>
            } @else {
              <span i18n="@@vendor.notOurs.form.submit">Send to AEC Integrations</span>
            }
          </button>
          <button
            type="button"
            [class]="secondaryButtonClass"
            [disabled]="submitting()"
            (click)="close()"
            i18n="@@vendor.notOurs.form.cancel"
          >
            Cancel
          </button>
        </div>
      </form>
    }

    @if (notice(); as message) {
      <p role="alert" class="mt-2 text-sm font-medium text-(--text-primary)">{{ message }}</p>
    }
  `,
})
export class VendorNotOurs {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  /** The row's id, in whichever table `anchor` names. */
  readonly integrationId = input.required<string>();
  readonly anchor = input<ContestAnchorKind>('integration');
  /** The two product names, as the row is known on the page. */
  readonly productA = input.required<string>();
  readonly productB = input.required<string>();
  /** Endpoint vendors other than the caller, offered as who offers it instead. */
  readonly otherVendors = input<readonly { readonly id: string; readonly name: string }[]>([]);

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly withdrawButton = viewChild<ElementRef<HTMLButtonElement>>('withdrawButton');

  protected readonly open = signal(false);
  protected readonly submitting = signal(false);
  protected readonly withdrawing = signal(false);
  protected readonly attempted = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly owner = signal(NO_OWNER);
  protected readonly reason = signal('');

  protected readonly reasonRequiredMessage = $localize`:@@vendor.notOurs.error.reason:Say why this integration is not yours.`;

  constructor() {
    // The state line reads the contests resource. Load-once, after hydration.
    afterNextRender(() => void this.store.ensure('contests'));
  }

  protected readonly contest = computed(() =>
    selfDisclaimOn(this.store.contests().submitted, this.integrationId(), this.anchor()),
  );

  protected readonly ownerOptions = computed(() => [
    ...this.otherVendors().map((v) => ({ value: v.id, label: v.name })),
    {
      value: NO_OWNER,
      label: $localize`:@@vendor.notOurs.form.owner.unknown:Someone else, or we don't know`,
    },
  ]);

  protected readonly showReasonError = computed(
    () => this.attempted() && this.reason().trim() === '',
  );

  /** Several rows per page, so the name says which integration. */
  protected readonly triggerLabel = computed(
    () =>
      $localize`:@@vendor.notOurs.aria:Not ours? Tell AEC Integrations you do not offer the integration between ${this.productA()}:A: and ${this.productB()}:B:`,
  );
  protected readonly withdrawLabel = computed(
    () =>
      $localize`:@@vendor.notOurs.withdraw.aria:Withdraw your "not ours" on the integration between ${this.productA()}:A: and ${this.productB()}:B:`,
  );

  protected toggle(): void {
    if (this.open()) this.close();
    else {
      this.notice.set(null);
      this.open.set(true);
    }
  }

  /** Close and reset, returning focus to the trigger. */
  close(): void {
    this.open.set(false);
    this.owner.set(NO_OWNER);
    this.reason.set('');
    this.attempted.set(false);
    this.trigger()?.nativeElement.focus();
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.submitting()) return;
    this.attempted.set(true);
    this.notice.set(null);
    if (this.reason().trim() === '') return;

    const parsed = SubmitIntegrationContestSchema.safeParse({
      field: 'owner',
      proposed_value: this.owner() === NO_OWNER ? null : this.owner(),
      reason: this.reason(),
      context_product_id: null,
    } satisfies SubmitIntegrationContestInput);
    if (!parsed.success) {
      this.notice.set($localize`:@@vendor.notOurs.error.shape:Check the reason, then try again.`);
      return;
    }

    this.submitting.set(true);
    try {
      await this.api.submitContest(this.integrationId(), parsed.data, this.anchor());
      this.announcer.announce(
        $localize`:@@vendor.notOurs.live.sent:Sent to AEC Integrations. This integration no longer counts against your checklist while it reviews it.`,
      );
      this.submitting.set(false);
      this.open.set(false);
      this.owner.set(NO_OWNER);
      this.reason.set('');
      this.attempted.set(false);
      await this.store.revalidate(['contests']);
      // The trigger is gone once the state line shows, so keep focus on that line.
      this.focusAfterRender(() => this.withdrawButton() ?? this.trigger());
    } catch (err) {
      this.notice.set(contestSubmitErrorMessage(err));
      this.submitting.set(false);
    }
  }

  protected async withdraw(): Promise<void> {
    const contest = this.contest();
    if (!contest || this.withdrawing()) return;
    this.withdrawing.set(true);
    this.notice.set(null);
    try {
      await this.api.withdrawContest(contest.id);
      this.announcer.announce(
        $localize`:@@vendor.notOurs.live.withdrawn:Withdrawn. This integration counts against your checklist again.`,
      );
    } catch (err) {
      this.notice.set(
        readVendorApiError(err)?.code === 'CONTEST_NOT_OPEN'
          ? $localize`:@@vendor.notOurs.error.notOpen:AEC Integrations already answered this.`
          : $localize`:@@vendor.notOurs.error.withdraw:Could not withdraw it. Try again.`,
      );
    } finally {
      this.withdrawing.set(false);
      await this.store.revalidate(['contests']);
      this.focusAfterRender(() => this.trigger() ?? this.withdrawButton());
    }
  }

  /** Move focus once the state the last write produced has rendered, so a keyboard
   *  user is not dropped at the top of the page when the control they used unmounts. */
  private focusAfterRender(target: () => ElementRef<HTMLButtonElement> | undefined): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }

  protected fieldId(key: string): string {
    return `vendor-not-ours-${this.anchor()}-${this.integrationId()}-${key}`;
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected readonly linkButtonClass =
    'text-sm font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:rounded-(--radius-sm) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly selectClass =
    'w-full cursor-pointer appearance-none rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) py-2 pe-9 ps-3 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}
