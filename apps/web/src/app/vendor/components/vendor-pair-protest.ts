import { DatePipe, DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { PAIR_PROTEST_MAX_EVIDENCE, isHttpUrl, type PairContest } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';

import { AecButton } from '../../shared/button/button';
import { Chip, type ChipTone } from '../../shared/chip/chip';
import {
  FIELD_ERROR_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AecFormSubmit } from '../../shared/form-field/form-submit';
import { FORM_PANEL, IN_TEXT_LINK } from '../integration-detail/integration-detail-styles';
import { PORTAL_NESTED_SAVE_BAR_CLASS, PORTAL_SAVE_BUTTON_CLASS } from '../shared/portal-form';
import { CloseOnEscape } from '../shared/close-on-escape';
import { KeepClearOfSaveBar } from '../shared/keep-clear-of-save-bar';

type Side = 'submitted' | 'received';
type Busy = 'file' | 'reply' | 'withdraw' | null;

/**
 * The protest to AECi on one Sync Service data flow report (AECI-2110,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.5), inside a row of the pair-rights lists. The
 * same behaviour as the field-contest protest (`vendor-contest-protest.ts`, §11b.12.12),
 * so the two read alike (the Same-Behavior Rule):
 *
 *  - **Submitted side.** While the report can be protested, a disclosure opens an inline
 *    form: a required reason and up to three links. Cancel or Escape closes it and
 *    returns focus. An open protest can be withdrawn behind an inline confirmation.
 *  - **Received side.** The owner sees the whole protest and replies once, before the
 *    due date.
 *
 * AECi's answer is advice. Nothing here changes the public page. Every write is
 * pessimistic: `changed` tells the list to re-read, and a refusal reads as plain copy.
 */
@Component({
  selector: 'aec-vendor-pair-protest',
  imports: [
    KeepClearOfSaveBar,
    CloseOnEscape,
    AecButton,
    AecFormSubmit,
    Chip,
    DatePipe,
    NgTemplateOutlet,
  ],
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
          <form method="dialog" class="space-y-2 pt-2" (aecSubmit)="reply()" novalidate>
            <label
              [for]="ids.replyText"
              [class]="labelClass"
              i18n="@@vendor.pairProtest.reply.label"
              >Your reply</label
            >
            <textarea
              [id]="ids.replyText"
              rows="3"
              maxlength="2000"
              required
              [value]="text()"
              (input)="setText($event)"
              [attr.aria-describedby]="ids.replyHint"
              [attr.aria-invalid]="textError() ? 'true' : null"
              [class]="inputClass"
            ></textarea>
            <p [id]="ids.replyHint" class="max-w-prose text-xs text-(--text-secondary)">
              <ng-container i18n="@@vendor.pairProtest.reply.hint"
                >You can reply once, by {{ p.reply_due_at | date: 'medium' }}. AEC Integrations and
                the vendor that sent the report see it. Nothing about it is public.</ng-container
              >
            </p>
            <ng-container [ngTemplateOutlet]="evidenceFields" />
            <button aecButton compact type="submit" [disabled]="busy() !== null">
              @if (busy() === 'reply') {
                <span i18n="@@vendor.pairProtest.reply.sending">Sending…</span>
              } @else {
                <span i18n="@@vendor.pairProtest.reply.send">Send reply</span>
              }
            </button>
          </form>
        }
      </div>
    } @else if (side() === 'submitted' && windowOpen()) {
      @if (!formOpen()) {
        <button
          aecButton
          variant="secondary"
          compact
          type="button"
          [id]="ids.start"
          [attr.aria-expanded]="false"
          [attr.aria-controls]="ids.form"
          (click)="openForm()"
          i18n="@@vendor.pairProtest.start"
        >
          Ask AEC Integrations to review it
        </button>
      } @else {
        <form
          aecKeepClearOfSaveBar
          aecCloseOnEscape
          [escapeBusy]="busy() !== null"
          (escapeCancel)="closeForm()"
          method="dialog"
          [id]="ids.form"
          class="mt-2 max-w-prose space-y-2"
          [class]="formPanelClass"
          (aecSubmit)="file()"
          novalidate
          [attr.aria-labelledby]="ids.formHeading"
        >
          <p
            [id]="ids.formHeading"
            class="text-t-14 font-semibold text-(--text-primary)"
            i18n="@@vendor.pairProtest.form.heading"
          >
            Ask AEC Integrations to review this report
          </p>
          <p class="text-sm text-(--text-secondary)">
            @if (r.status === 'open') {
              <ng-container i18n="@@vendor.pairProtest.form.silence"
                >The Sync Service did not answer within 30 days, so this counts as a
                decline.</ng-container
              >
            } @else {
              <ng-container i18n="@@vendor.pairProtest.form.declined"
                >The Sync Service declined this report.</ng-container
              >
            }
          </p>
          <p [id]="ids.formHelp" class="text-sm text-(--text-secondary)">
            <ng-container i18n="@@vendor.pairProtest.form.help"
              >AEC Integrations reads both sides and says which it agrees with. Its view is advice.
              The Sync Service decides the listing of the data flow. It can reply once. Nothing
              about a review is public.</ng-container
            >
            @if (r.protest_closes_at; as closes) {
              <ng-container i18n="@@vendor.pairProtest.form.deadline">
                You can ask until {{ closes | date: 'medium' }}.</ng-container
              >
            }
          </p>
          <label [for]="ids.reason" [class]="labelClass" i18n="@@vendor.pairProtest.form.reason"
            >Why the data flow should change</label
          >
          <textarea
            [id]="ids.reason"
            rows="3"
            maxlength="2000"
            required
            [value]="text()"
            (input)="setText($event)"
            [attr.aria-describedby]="ids.formHelp"
            [attr.aria-invalid]="textError() ? 'true' : null"
            [class]="inputClass"
          ></textarea>
          <ng-container [ngTemplateOutlet]="evidenceFields" />
          <div [class]="saveBarClass">
            <button aecButton type="submit" [class]="saveButtonClass" [disabled]="busy() !== null">
              @if (busy() === 'file') {
                <span i18n="@@vendor.pairProtest.form.sending">Sending…</span>
              } @else {
                <span i18n="@@vendor.pairProtest.form.send">Send to AEC Integrations</span>
              }
            </button>
            <button
              aecButton
              variant="secondary"
              type="button"
              [class]="saveButtonClass"
              [disabled]="busy() !== null"
              (click)="closeForm()"
              i18n="@@vendor.pairProtest.form.cancel"
            >
              Cancel
            </button>
          </div>
        </form>
      }
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

    <ng-template #evidenceFields>
      <fieldset class="space-y-2">
        <legend [class]="labelClass" i18n="@@vendor.pairProtest.links.legend">
          Supporting links
        </legend>
        <p class="text-xs text-(--text-secondary)" i18n="@@vendor.pairProtest.links.hint">
          Optional. Up to three.
        </p>
        @for (url of links(); track $index) {
          <div class="flex flex-wrap items-center gap-2">
            <label [for]="ids.link + $index" class="sr-only" i18n="@@vendor.pairProtest.links.label"
              >Link {{ $index + 1 }}</label
            >
            <input
              [id]="ids.link + $index"
              type="url"
              inputmode="url"
              [value]="url"
              (input)="setLink($index, $event)"
              placeholder="https://"
              [attr.aria-invalid]="linkInvalid(url) ? 'true' : null"
              [class]="inputClass"
              class="flex-1"
            />
            <button
              aecButton
              variant="secondary"
              compact
              type="button"
              (click)="removeLink($index)"
              i18n="@@vendor.pairProtest.links.remove"
            >
              Remove <span class="sr-only">link {{ $index + 1 }}</span>
            </button>
          </div>
        }
        @if (links().length < maxLinks) {
          <button
            aecButton
            variant="secondary"
            compact
            type="button"
            (click)="addLink()"
            i18n="@@vendor.pairProtest.links.add"
          >
            Add a link
          </button>
        }
      </fieldset>
    </ng-template>
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

  protected readonly maxLinks = PAIR_PROTEST_MAX_EVIDENCE;
  protected readonly busy = signal<Busy>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly formOpen = signal(false);
  protected readonly confirmingWithdraw = signal(false);
  protected readonly text = signal('');
  protected readonly links = signal<readonly string[]>([]);
  protected readonly textError = signal(false);

  /** Element ids, derived from the report id so two rows never collide. */
  protected get ids() {
    const id = this.report().id;
    return {
      start: `vendor-pair-protest-start-${id}`,
      form: `vendor-pair-protest-form-${id}`,
      formHeading: `vendor-pair-protest-form-heading-${id}`,
      formHelp: `vendor-pair-protest-form-help-${id}`,
      reason: `vendor-pair-protest-reason-${id}`,
      replyText: `vendor-pair-protest-reply-${id}`,
      replyHint: `vendor-pair-protest-reply-hint-${id}`,
      link: `vendor-pair-protest-link-${id}-`,
      withdrawStart: `vendor-pair-protest-withdraw-start-${id}`,
      withdrawConfirm: `vendor-pair-protest-withdraw-${id}`,
    };
  }

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

  protected openForm(): void {
    this.error.set(null);
    this.formOpen.set(true);
    this.focusAfterRender(this.ids.reason);
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.resetFields();
    this.focusAfterRender(this.ids.start);
  }

  protected setText(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
    if (this.textError()) this.textError.set(false);
  }

  protected addLink(): void {
    if (this.links().length >= this.maxLinks) return;
    this.links.update((current) => [...current, '']);
    this.focusAfterRender(`${this.ids.link}${this.links().length - 1}`);
  }

  protected removeLink(index: number): void {
    this.links.update((current) => current.filter((_, i) => i !== index));
  }

  protected setLink(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.links.update((current) => current.map((u, i) => (i === index ? value : u)));
  }

  protected linkInvalid(url: string): boolean {
    const trimmed = url.trim();
    return trimmed !== '' && !isHttpUrl(trimmed);
  }

  /** The trimmed body, or `null` after setting an error the vendor can act on. */
  private body(): { text: string; evidence_urls: string[] } | null {
    const text = this.text().trim();
    const evidence = this.links()
      .map((u) => u.trim())
      .filter((u) => u !== '');
    if (text === '') {
      this.textError.set(true);
      this.error.set(
        this.side() === 'submitted'
          ? $localize`:@@vendor.pairProtest.error.reasonRequired:Say why the data flow should change.`
          : $localize`:@@vendor.pairProtest.error.replyRequired:Write your reply before you send it.`,
      );
      return null;
    }
    if (evidence.some((u) => !isHttpUrl(u))) {
      this.error.set(
        $localize`:@@vendor.pairProtest.error.link:Each link must be a full web address that starts with http:// or https://.`,
      );
      return null;
    }
    return { text, evidence_urls: evidence };
  }

  protected async file(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    const body = this.body();
    if (!body) return;
    this.busy.set('file');
    try {
      await this.api.protestPairContest(this.report().id, {
        reason: body.text,
        evidence_urls: body.evidence_urls,
      });
      this.announcer.announce(
        $localize`:@@vendor.pairProtest.live.filed:Sent to AEC Integrations for review. The Sync Service can reply once.`,
      );
      this.formOpen.set(false);
      this.resetFields();
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(null);
      this.changed.emit();
    }
  }

  protected async reply(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    const body = this.body();
    if (!body) return;
    this.busy.set('reply');
    try {
      await this.api.replyPairProtest(this.report().id, {
        reply: body.text,
        evidence_urls: body.evidence_urls,
      });
      this.announcer.announce(
        $localize`:@@vendor.pairProtest.live.replied:Reply sent. AEC Integrations and the company that sent the report can read it.`,
      );
      this.resetFields();
    } catch (err) {
      this.fail(err);
    } finally {
      this.busy.set(null);
      this.changed.emit();
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
      this.fail(err);
    } finally {
      this.confirmingWithdraw.set(false);
      this.busy.set(null);
      this.changed.emit();
    }
  }

  private fail(err: unknown): void {
    const code = (err as { error?: { error?: { code?: string } } }).error?.error?.code;
    this.error.set(pairProtestErrorMessage(code));
  }

  private resetFields(): void {
    this.text.set('');
    this.links.set([]);
    this.textError.set(false);
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
  protected readonly formPanelClass = FORM_PANEL;
  protected readonly saveBarClass = PORTAL_NESTED_SAVE_BAR_CLASS;
  protected readonly saveButtonClass = PORTAL_SAVE_BUTTON_CLASS;
  protected readonly linkClass = IN_TEXT_LINK;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
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
