import { DatePipe, DOCUMENT } from '@angular/common';
import {
  Component,
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

import { PAIR_PROTEST_MAX_EVIDENCE, type PairContest } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';

import { AecButton } from '../../shared/button/button';
import { Chip, type ChipTone } from '../../shared/chip/chip';
import { FIELD_ERROR_CLASS } from '../../shared/form-field/form-field-classes';
import { IN_TEXT_LINK } from '../integration-detail/integration-detail-styles';
import { ProtestFormDialog, type ProtestFormValue } from './protest-form-dialog';

type Side = 'submitted' | 'received';

/**
 * The protest to AECi on one Sync Service data flow report (AECI-2110,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.5), inside a row of the pair-rights lists. The
 * same behaviour as the field-contest protest (`vendor-contest-protest.ts`, §11b.12.12),
 * so the two read alike (the Same-Behavior Rule):
 *
 *  - **Submitted side.** While the report can be protested, "Ask AEC Integrations to
 *    review it" opens the request in a dialog (`ProtestFormDialog`, `DESIGN.md` "The
 *    Detached-Form Rule"): a required reason and up to three links. An open protest
 *    can be withdrawn behind an inline confirmation.
 *  - **Received side.** The owner sees the whole protest, and "Reply" opens its one
 *    reply in the same dialog, until the due date.
 *
 * AECi's answer is advice. Nothing here changes the public page. Every write is
 * pessimistic: `changed` tells the list to re-read, and a refusal reads as plain copy.
 */
@Component({
  selector: 'aec-vendor-pair-protest',
  imports: [AecButton, Chip, DatePipe, ProtestFormDialog],
  styles: [':host { display: block; }'],
  template: `
    @let r = report();
    @let p = r.protest;
    @if (p) {
      <div [class]="recordClass" [attr.data-pair-protest]="r.id">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <p
            class="text-t-14 font-semibold text-(--text-primary)"
            i18n="@@vendor.pairProtest.heading"
          >
            Review by AEC Integrations
          </p>
          <aec-chip class="shrink-0" density="dense" [tone]="chipTone(p.status)">{{
            statusLabel(p.status)
          }}</aec-chip>
        </div>
        <dl class="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt class="text-(--text-secondary)" i18n="@@vendor.pairProtest.basis">Asked because</dt>
          <dd class="text-(--text-primary)">
            @if (p.basis === 'silence') {
              <ng-container i18n="@@vendor.pairProtest.basis.silence"
                >The Sync Service did not answer within 30 days</ng-container
              >
            } @else {
              <ng-container i18n="@@vendor.pairProtest.basis.declined"
                >The Sync Service declined the report</ng-container
              >
            }
          </dd>
          <dt class="text-(--text-secondary)" i18n="@@vendor.pairProtest.reason">
            Case for the change
          </dt>
          <dd class="break-words text-(--text-primary)">{{ p.reason }}</dd>
          @if (p.evidence_urls.length > 0) {
            <dt class="text-(--text-secondary)" i18n="@@vendor.pairProtest.evidence">Links</dt>
            <dd class="text-(--text-primary)">
              <ul class="space-y-1">
                @for (url of p.evidence_urls; track url) {
                  <li class="break-all">
                    <a [href]="url" rel="noopener nofollow" target="_blank" [class]="linkClass">{{
                      url
                    }}</a>
                  </li>
                }
              </ul>
            </dd>
          }
          <dt class="text-(--text-secondary)" i18n="@@vendor.pairProtest.reply">
            Sync Service's reply
          </dt>
          <dd class="break-words text-(--text-primary)">
            @if (p.reply; as reply) {
              {{ reply }}
              @if (p.reply_evidence_urls.length > 0) {
                <ul class="mt-1 space-y-1">
                  @for (url of p.reply_evidence_urls; track url) {
                    <li class="break-all">
                      <a [href]="url" rel="noopener nofollow" target="_blank" [class]="linkClass">{{
                        url
                      }}</a>
                    </li>
                  }
                </ul>
              }
            } @else if (p.status === 'open' && replyOpen()) {
              <ng-container i18n="@@vendor.pairProtest.reply.due"
                >Due {{ p.reply_due_at | date: 'medium' }}</ng-container
              >
            } @else {
              <ng-container i18n="@@vendor.pairProtest.reply.none">No reply</ng-container>
            }
          </dd>
          @if (p.decision_note; as note) {
            <dt class="text-(--text-secondary)" i18n="@@vendor.pairProtest.note">
              AEC Integrations' note
            </dt>
            <dd class="break-words text-(--text-primary)">{{ note }}</dd>
          }
        </dl>

        @if (meaning(); as sentence) {
          <p class="text-sm text-(--text-primary)">{{ sentence }}</p>
        }

        @if (side() === 'submitted' && p.status === 'open') {
          @if (confirmingWithdraw()) {
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-sm text-(--text-primary)" i18n="@@vendor.pairProtest.withdraw.confirm">
                Withdraw this review request? You cannot ask again for this report.
              </p>
              <button
                aecButton
                variant="danger"
                compact
                type="button"
                [id]="ids.withdrawConfirm"
                [disabled]="busy() !== null"
                (click)="withdraw()"
              >
                @if (busy() === 'withdraw') {
                  <span i18n="@@vendor.pairProtest.withdrawing">Withdrawing…</span>
                } @else {
                  <span i18n="@@vendor.pairProtest.withdraw.yes">Withdraw request</span>
                }
              </button>
              <button
                aecButton
                variant="secondary"
                compact
                type="button"
                [disabled]="busy() !== null"
                (click)="cancelWithdraw()"
                i18n="@@vendor.pairProtest.withdraw.keep"
              >
                Keep it
              </button>
            </div>
          } @else {
            <button
              aecButton
              variant="secondary"
              compact
              type="button"
              [id]="ids.withdrawStart"
              [disabled]="busy() !== null"
              (click)="startWithdraw()"
              i18n="@@vendor.pairProtest.withdraw"
            >
              Withdraw review request
            </button>
          }
        }

        @if (side() === 'received' && canReply()) {
          <button
            aecButton
            compact
            type="button"
            [id]="'vendor-pair-protest-reply-start-' + r.id"
            (click)="replyDialog.open()"
            i18n="@@vendor.pairProtest.reply.open"
          >
            Reply
          </button>
          <aec-protest-form-dialog
            #replyDialog
            [idPrefix]="'pair-protest-reply-' + r.id"
            [heading]="replyHeading"
            [description]="replyDescription()"
            [label]="replyLabel"
            [sendLabel]="replySend"
            [requiredMessage]="replyRequired"
            [maxLinks]="maxLinks"
            (send)="reply($event)"
            (announce)="announce($event)"
          />
        }
      </div>
    } @else if (side() === 'submitted' && windowOpen()) {
      <button
        aecButton
        variant="secondary"
        compact
        type="button"
        [id]="'vendor-pair-protest-start-' + r.id"
        (click)="requestDialog.open()"
        i18n="@@vendor.pairProtest.start"
      >
        Ask AEC Integrations to review it
      </button>
      <aec-protest-form-dialog
        #requestDialog
        [idPrefix]="'pair-protest-request-' + r.id"
        [heading]="requestHeading"
        [description]="requestDescription()"
        [label]="requestLabel"
        [sendLabel]="requestSend"
        [requiredMessage]="requestRequired"
        [maxLinks]="maxLinks"
        (send)="file($event)"
        (announce)="announce($event)"
      />
    }

    @if (side() === 'submitted' && r.cooldown_until; as until) {
      <p class="mt-2 max-w-prose text-xs text-(--text-secondary)">
        <ng-container i18n="@@vendor.pairProtest.cooldown"
          >You can't report this data flow again until {{ until | date: 'medium' }}, unless its
          direction changes.</ng-container
        >
      </p>
    }

    @if (error(); as message) {
      <p role="alert" class="mt-2" [class]="errorClass">{{ message }}</p>
    }
  `,
})
export class VendorPairProtest {
  readonly report = input.required<PairContest>();
  readonly side = input.required<Side>();
  /** After any write, success or refusal: the list re-reads. */
  readonly changed = output<void>();

  private readonly api = inject(VendorApi);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly datePipe = new DatePipe(inject(LOCALE_ID));

  private readonly requestDialog = viewChild<ProtestFormDialog>('requestDialog');
  private readonly replyDialog = viewChild<ProtestFormDialog>('replyDialog');

  protected readonly maxLinks = PAIR_PROTEST_MAX_EVIDENCE;
  protected readonly busy = signal<'withdraw' | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly confirmingWithdraw = signal(false);

  /** Element ids, derived from the report id so two rows never collide. */
  protected get ids() {
    const id = this.report().id;
    return {
      withdrawStart: `vendor-pair-protest-withdraw-start-${id}`,
      withdrawConfirm: `vendor-pair-protest-withdraw-${id}`,
    };
  }

  // ── The two dialogs' copy (DESIGN.md "The Detached-Form Rule") ─────────────

  protected readonly requestHeading = $localize`:@@vendor.pairProtest.form.heading:Ask AEC Integrations to review this report`;
  protected readonly requestLabel = $localize`:@@vendor.pairProtest.form.reason:Why the data flow should change`;
  protected readonly requestSend = $localize`:@@vendor.pairProtest.form.send:Send to AEC Integrations`;
  protected readonly requestRequired = $localize`:@@vendor.pairProtest.error.reasonRequired:Say why the data flow should change.`;
  protected readonly replyHeading = $localize`:@@vendor.pairProtest.reply.heading:Reply to the review request`;
  protected readonly replyLabel = $localize`:@@vendor.pairProtest.reply.label:Your reply`;
  protected readonly replySend = $localize`:@@vendor.pairProtest.reply.send:Send reply`;
  protected readonly replyRequired = $localize`:@@vendor.pairProtest.error.replyRequired:Write your reply before you send it.`;

  protected readonly requestDescription = computed<readonly string[]>(() => {
    const r = this.report();
    const why =
      r.status === 'open'
        ? $localize`:@@vendor.pairProtest.form.silence:The Sync Service did not answer within 30 days, so this counts as a decline.`
        : $localize`:@@vendor.pairProtest.form.declined:The Sync Service declined this report.`;
    const help = $localize`:@@vendor.pairProtest.form.help:AEC Integrations reads both sides and says which it agrees with. Its view is advice. The Sync Service decides the listing of the data flow. It can reply once. Nothing about a review is public.`;
    const closes = r.protest_closes_at ? this.day(r.protest_closes_at) : null;
    return closes
      ? [
          why,
          help,
          $localize`:@@vendor.pairProtest.form.deadline.v2:You can ask until ${closes}:date:.`,
        ]
      : [why, help];
  });

  protected readonly replyDescription = computed<readonly string[]>(() => {
    const p = this.report().protest;
    const who =
      this.report().submitter_name ?? $localize`:@@vendor.pairProtest.reply.someone:A vendor`;
    const lines = [
      $localize`:@@vendor.pairProtest.reply.intro:${who}:vendor: asked AEC Integrations to review your answer on this data flow. Its case: ${p?.reason ?? ''}:case:`,
    ];
    if (p?.reply_due_at) {
      const due = this.day(p.reply_due_at);
      lines.push(
        $localize`:@@vendor.pairProtest.reply.hint.v2:You can reply once, by ${due}:date:. AEC Integrations and the vendor that sent the report see it. Nothing about it is public.`,
      );
    }
    return lines;
  });

  /** The server sends the window's close only while it is open; the clock checks it. */
  protected readonly windowOpen = computed(() => {
    const closes = this.report().protest_closes_at;
    return !!closes && Date.now() < Date.parse(closes);
  });

  protected readonly replyOpen = computed(() => {
    const due = this.report().protest?.reply_due_at;
    return !!due && Date.now() < Date.parse(due);
  });

  protected readonly canReply = computed(() => {
    const p = this.report().protest;
    return !!p && p.status === 'open' && p.reply === null && this.replyOpen();
  });

  /** What a decided protest means, from this seat. */
  protected readonly meaning = computed<string | null>(() => {
    const p = this.report().protest;
    if (!p) return null;
    const owner = this.side() === 'received';
    if (p.status === 'upheld') {
      return owner
        ? $localize`:@@vendor.pairProtest.meaning.upheld.owner:AEC Integrations agrees with the report. This is advice. The data flow stays as listed unless you change it.`
        : $localize`:@@vendor.pairProtest.meaning.upheld.submitter:AEC Integrations agrees with you. This is advice. The Sync Service decides the listing of that data flow.`;
    }
    if (p.status === 'rejected') {
      return owner
        ? $localize`:@@vendor.pairProtest.meaning.rejected.owner:AEC Integrations agrees with your answer. The data flow stays as listed.`
        : $localize`:@@vendor.pairProtest.meaning.rejected.submitter:AEC Integrations agrees with the Sync Service. The data flow stays as listed.`;
    }
    return null;
  });

  protected statusLabel(status: string): string {
    switch (status) {
      case 'open':
        return $localize`:@@vendor.pairProtest.status.open:With AEC Integrations`;
      case 'upheld':
        return $localize`:@@vendor.pairProtest.status.upheld:AEC Integrations agreed with the report`;
      case 'rejected':
        return $localize`:@@vendor.pairProtest.status.rejected:AEC Integrations agreed with the Sync Service`;
      default:
        return $localize`:@@vendor.pairProtest.status.withdrawn:Review request withdrawn`;
    }
  }

  /** A deadline with its time of day, as every protest deadline reads (§11b.12.10). */
  private day(iso: string): string {
    return this.datePipe.transform(iso, 'medium') ?? iso;
  }

  protected announce(sentence: string): void {
    this.announcer.announce(sentence);
  }

  protected async file(body: ProtestFormValue): Promise<void> {
    const dialog = this.requestDialog();
    try {
      await this.api.protestPairContest(this.report().id, {
        reason: body.text,
        evidence_urls: body.evidence_urls,
      });
      await dialog?.succeed(
        $localize`:@@vendor.pairProtest.live.filed:Sent to AEC Integrations for review. The Sync Service can reply once.`,
      );
      this.changed.emit();
    } catch (err) {
      await this.refused(dialog, err);
    }
  }

  protected async reply(body: ProtestFormValue): Promise<void> {
    const dialog = this.replyDialog();
    try {
      await this.api.replyPairProtest(this.report().id, {
        reply: body.text,
        evidence_urls: body.evidence_urls,
      });
      await dialog?.succeed(
        $localize`:@@vendor.pairProtest.live.replied:Reply sent. AEC Integrations and the company that sent the report can read it.`,
      );
      this.changed.emit();
    } catch (err) {
      await this.refused(dialog, err);
    }
  }

  /** A refusal that means the row moved closes the dialog, shows why on the row and
   *  re-reads the list. Anything else keeps the draft and says why in the dialog. */
  private async refused(dialog: ProtestFormDialog | undefined, err: unknown): Promise<void> {
    const code = (err as { error?: { error?: { code?: string } } }).error?.error?.code;
    const message = pairProtestErrorMessage(code);
    if (code && code !== 'VALIDATION_FAILED') {
      this.error.set(message);
      await dialog?.abandon();
      this.changed.emit();
    } else {
      dialog?.fail(message);
    }
  }

  protected startWithdraw(): void {
    this.error.set(null);
    this.confirmingWithdraw.set(true);
    this.focusAfterRender(this.ids.withdrawConfirm);
  }

  protected cancelWithdraw(): void {
    this.confirmingWithdraw.set(false);
    this.focusAfterRender(this.ids.withdrawStart);
  }

  protected async withdraw(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('withdraw');
    this.error.set(null);
    try {
      await this.api.withdrawPairProtest(this.report().id);
      this.announcer.announce(
        $localize`:@@vendor.pairProtest.live.withdrawn:Review request withdrawn.`,
      );
    } catch (err) {
      const code = (err as { error?: { error?: { code?: string } } }).error?.error?.code;
      this.error.set(pairProtestErrorMessage(code));
    } finally {
      this.confirmingWithdraw.set(false);
      this.busy.set(null);
      this.changed.emit();
    }
  }

  private focusAfterRender(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), {
      injector: this.injector,
    });
  }

  /** The review's status: Forest while it is open or AECi agreed, a strong edge otherwise. */
  protected chipTone(status: string): ChipTone {
    return status === 'open' || status === 'upheld' ? 'forest' : 'strong';
  }

  protected readonly recordClass =
    'mt-2 max-w-prose space-y-2 rounded-panel bg-(--surface-sunken) p-4';
  protected readonly linkClass = IN_TEXT_LINK;
  protected readonly errorClass = FIELD_ERROR_CLASS;
}

/** Plain copy for each refusal a protest step can meet. */
export function pairProtestErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'PAIR_PROTEST_NOT_ALLOWED':
      return $localize`:@@vendor.pairProtest.err.notAllowed:This report cannot be sent for review now. The Sync Service may have answered, or another report on this data flow is open. The list is reloaded.`;
    case 'PAIR_PROTEST_NOT_OPEN':
    case 'PROTEST_NOT_OPEN':
      return $localize`:@@vendor.pairProtest.err.notOpen:This review was already decided or withdrawn. The list is reloaded.`;
    case 'PROTEST_REPLY_EXISTS':
      return $localize`:@@vendor.pairProtest.err.replyExists:You already replied to this review.`;
    case 'PROTEST_REPLY_CLOSED':
      return $localize`:@@vendor.pairProtest.err.replyClosed:The time to reply has passed.`;
    default:
      return $localize`:@@vendor.pairProtest.err.generic:That did not go through. Try again.`;
  }
}
