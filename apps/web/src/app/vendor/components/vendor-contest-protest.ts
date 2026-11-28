import { DatePipe, DOCUMENT } from '@angular/common';
import {
  Component,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { CONTEST_PROTEST_MAX_EVIDENCE, type VendorContest } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  contestFieldLabel,
  protestErrorMessage,
  protestErrorReloads,
  protestStatusLabel,
} from './vendor-contest-labels';
import { AecButton } from '../../shared/button/button';
import { Chip, type ChipTone } from '../../shared/chip/chip';
import { FIELD_ERROR_CLASS } from '../../shared/form-field/form-field-classes';
import { IN_TEXT_LINK } from '../integration-detail/integration-detail-styles';
import { ProtestFormDialog, type ProtestFormValue } from './protest-form-dialog';

type Side = 'submitted' | 'received';

/**
 * One contest's protest to AECi, inside a row of the Field contests lists
 * (AECI-1009 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.12.12).
 *
 *  - **Submitted side.** While the contest can be protested, "Ask AEC Integrations to
 *    review" opens the request in a dialog (`ProtestFormDialog`, AECI-2110, `DESIGN.md`
 *    "The Detached-Form Rule"): a required reason and up to three evidence links.
 *    Escape, Cancel and the close button discard it. Before day 30
 *    on an unanswered contest it says from when. An open protest can be withdrawn,
 *    with an inline confirmation, never `confirm()`.
 *  - **Received side.** The owner sees the whole protest, and "Reply" opens its one
 *    reply in the same dialog, before the due date.
 *
 * Both sides see the whole record: each other's text and links, and AECi's note.
 * AECi's ruling is advice. Nothing here changes the public page, so no write here
 * revalidates `integrations`.
 *
 * The window comes from the server as timestamps (`protest_opens_at`,
 * `protest_closes_at`, `reply_due_at`) and is compared with the clock when the row
 * renders. Nothing is written when a window opens or closes, so the freshness
 * cursor does not move then; the server enforces every boundary again on write.
 *
 * Every write is pessimistic and re-read. A refusal that means the row moved (the
 * owner answered, the value changed, someone else decided) says so plainly and
 * reloads the list so the row shows the state that won.
 */
@Component({
  selector: 'aec-vendor-contest-protest',
  imports: [AecButton, Chip, DatePipe, ProtestFormDialog, RouterLink],
  styles: [':host { display: block; }'],
  template: `
    @let c = contest();
    @let p = c.protest;
    @if (p) {
      <div [class]="recordClass" [attr.data-protest]="c.id">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <p class="text-t-14 font-semibold text-(--text-primary)" i18n="@@vendor.protest.heading">
            Review by AEC Integrations
          </p>
          <aec-chip class="shrink-0" density="dense" [tone]="chipTone(p.status)">{{
            statusLabel(p.status)
          }}</aec-chip>
        </div>
        <dl class="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt class="text-(--text-secondary)" i18n="@@vendor.protest.basis">Asked because</dt>
          <dd class="text-(--text-primary)">
            @if (p.basis === 'silence') {
              <ng-container i18n="@@vendor.protest.basis.silence"
                >The owner did not answer within 30 days</ng-container
              >
            } @else {
              <ng-container i18n="@@vendor.protest.basis.declined"
                >The owner declined the request</ng-container
              >
            }
          </dd>
          <dt class="text-(--text-secondary)" i18n="@@vendor.protest.reason">
            Case for the change
          </dt>
          <dd class="break-words text-(--text-primary)">{{ p.reason }}</dd>
          @if (p.evidence_urls.length > 0) {
            <dt class="text-(--text-secondary)" i18n="@@vendor.protest.evidence">Links</dt>
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
          <dt class="text-(--text-secondary)" i18n="@@vendor.protest.reply">Owner's reply</dt>
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
              <ng-container i18n="@@vendor.protest.reply.due"
                >Due {{ p.reply_due_at | date: 'medium' }}</ng-container
              >
            } @else {
              <ng-container i18n="@@vendor.protest.reply.none">No reply</ng-container>
            }
          </dd>
          @if (p.decision_note; as note) {
            <dt class="text-(--text-secondary)" i18n="@@vendor.protest.note">
              AEC Integrations' note
            </dt>
            <dd class="break-words text-(--text-primary)">{{ note }}</dd>
          }
        </dl>

        @if (meaning(); as sentence) {
          <p class="text-sm text-(--text-primary)">{{ sentence }}</p>
        }
        @if (side() === 'received' && p.status === 'upheld') {
          <p class="text-sm">
            <a [routerLink]="editCommands()" [class]="linkClass" i18n="@@vendor.protest.editLink"
              >Edit the integration under {{ c.context_product.name }}</a
            >
          </p>
        }

        @if (side() === 'submitted' && p.status === 'open') {
          @if (confirmingWithdraw()) {
            <div class="flex flex-wrap items-center gap-2">
              <p class="text-sm text-(--text-primary)" i18n="@@vendor.protest.withdraw.confirm">
                Withdraw this review request? You cannot ask again for this change request.
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
                  <span i18n="@@vendor.protest.withdrawing">Withdrawing…</span>
                } @else {
                  <span i18n="@@vendor.protest.withdraw.yes">Withdraw request</span>
                }
              </button>
              <button
                aecButton
                variant="secondary"
                compact
                type="button"
                [disabled]="busy() !== null"
                (click)="cancelWithdraw()"
                i18n="@@vendor.protest.withdraw.keep"
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
              i18n="@@vendor.protest.withdraw"
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
            [id]="'vendor-protest-reply-start-' + c.id"
            (click)="replyDialog.open()"
            i18n="@@vendor.protest.reply.open"
          >
            Reply
          </button>
          <aec-protest-form-dialog
            #replyDialog
            [idPrefix]="'contest-protest-reply-' + c.id"
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
    } @else if (side() === 'submitted') {
      @if (windowPhase() === 'not_yet') {
        <p class="max-w-prose text-xs text-(--text-secondary)">
          <ng-container i18n="@@vendor.protest.notYet"
            >You can ask AEC Integrations to review this from
            {{ c.protest_opens_at | date: 'medium' }} if the owner has not answered.</ng-container
          >
        </p>
      } @else if (windowPhase() === 'open') {
        <button
          aecButton
          variant="secondary"
          compact
          type="button"
          [id]="'vendor-protest-start-' + c.id"
          (click)="requestDialog.open()"
          i18n="@@vendor.protest.start"
        >
          Ask AEC Integrations to review
        </button>
        <aec-protest-form-dialog
          #requestDialog
          [idPrefix]="'contest-protest-request-' + c.id"
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
    }

    @if (side() === 'submitted' && c.cooldown_until; as until) {
      <p class="mt-2 max-w-prose text-xs text-(--text-secondary)">
        <ng-container i18n="@@vendor.protest.cooldown"
          >You can't ask about this field again until {{ until | date: 'medium' }}, unless its value
          changes.</ng-container
        >
      </p>
    }

    @if (error(); as message) {
      <p role="alert" class="mt-2" [class]="errorClass">{{ message }}</p>
    }
  `,
})
export class VendorContestProtest {
  readonly contest = input.required<VendorContest>();
  readonly side = input.required<Side>();

  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  private readonly datePipe = new DatePipe(inject(LOCALE_ID));
  private readonly requestDialog = viewChild<ProtestFormDialog>('requestDialog');
  private readonly replyDialog = viewChild<ProtestFormDialog>('replyDialog');

  protected readonly maxLinks = CONTEST_PROTEST_MAX_EVIDENCE;
  protected readonly busy = signal<'withdraw' | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly confirmingWithdraw = signal(false);

  // ── The two dialogs' copy (AECI-2110, DESIGN.md "The Detached-Form Rule") ─────

  protected readonly requestHeading = $localize`:@@vendor.protest.form.heading:Ask AEC Integrations to review this request`;
  protected readonly requestLabel = $localize`:@@vendor.protest.form.reason:Why the proposed value is right`;
  protected readonly requestSend = $localize`:@@vendor.protest.form.send:Send to AEC Integrations`;
  protected readonly requestRequired = $localize`:@@vendor.protest.error.reasonRequired:Say why the proposed value is right.`;
  protected readonly replyHeading = $localize`:@@vendor.protest.reply.heading:Reply to the review request`;
  protected readonly replyLabel = $localize`:@@vendor.protest.reply.label:Your reply`;
  protected readonly replySend = $localize`:@@vendor.protest.reply.send:Send reply`;
  protected readonly replyRequired = $localize`:@@vendor.protest.error.replyRequired:Write your reply before you send it.`;

  protected readonly requestDescription = computed<readonly string[]>(() => {
    const c = this.contest();
    const why =
      c.protest_basis === 'silence'
        ? $localize`:@@vendor.protest.form.silence:The owner did not answer within 30 days, so this counts as a decline.`
        : $localize`:@@vendor.protest.form.declined:The owner declined this request.`;
    const help = $localize`:@@vendor.protest.form.help:AEC Integrations reads both sides and says which it agrees with. Its view is advice. Only the owner can change the listing. The owner can reply once. Nothing about a review is public.`;
    const closes = c.protest_closes_at ? this.day(c.protest_closes_at) : null;
    return closes
      ? [
          why,
          help,
          $localize`:@@vendor.protest.form.deadline.v2:You can ask until ${closes}:date:.`,
        ]
      : [why, help];
  });

  protected readonly replyDescription = computed<readonly string[]>(() => {
    const p = this.contest().protest;
    if (!p) return [];
    const due = this.day(p.reply_due_at);
    return [
      $localize`:@@vendor.protest.reply.intro:The vendor that sent the change request asked AEC Integrations to review your decision. Its case: ${p.reason}:case:`,
      $localize`:@@vendor.protest.reply.hint.v2:You can reply once, by ${due}:date:. AEC Integrations and the vendor that sent the change request see it. Nothing about it is public.`,
    ];
  });

  /** Element ids, derived from the contest id so two rows never collide. */
  protected get ids() {
    const id = this.contest().id;
    return {
      withdrawStart: `vendor-protest-withdraw-start-${id}`,
      withdrawConfirm: `vendor-protest-withdraw-${id}`,
    };
  }

  /** Where the clock stands against the server's window, for the submitter. */
  protected readonly windowPhase = computed<'not_yet' | 'open' | 'none'>(() => {
    const c = this.contest();
    if (c.protest || !c.protest_opens_at) return 'none';
    const now = Date.now();
    if (now < Date.parse(c.protest_opens_at)) return 'not_yet';
    if (c.protest_closes_at && now >= Date.parse(c.protest_closes_at)) return 'none';
    return 'open';
  });

  protected readonly replyOpen = computed(() => {
    const p = this.contest().protest;
    return !!p && Date.now() < Date.parse(p.reply_due_at);
  });

  protected readonly canReply = computed(() => {
    const p = this.contest().protest;
    return !!p && p.status === 'open' && p.reply === null && this.replyOpen();
  });

  /** What a decided protest means, from this seat (§11b.12.10). */
  protected readonly meaning = computed<string | null>(() => {
    const c = this.contest();
    const p = c.protest;
    if (!p) return null;
    const owner = this.side() === 'received';
    if (p.status === 'upheld') {
      return owner
        ? $localize`:@@vendor.protest.meaning.upheld.owner:AEC Integrations agrees with the request. This is advice. The value on record stays unless you change it.`
        : $localize`:@@vendor.protest.meaning.upheld.submitter:AEC Integrations agrees with you. The owner has not changed the field. Only the owner can change it, so the value on record stays until it does.`;
    }
    if (p.status === 'rejected') {
      return owner
        ? $localize`:@@vendor.protest.meaning.rejected.owner:AEC Integrations agrees with your decision. The value on record stays.`
        : $localize`:@@vendor.protest.meaning.rejected.submitter:AEC Integrations agrees with the owner. The value on record stays.`;
    }
    return null;
  });

  protected editCommands(): readonly string[] {
    return ['..', 'products', this.contest().context_product.slug, 'integrations'];
  }

  protected statusLabel = protestStatusLabel;

  /** A deadline with its time of day (§11b.12.10). */
  private day(iso: string): string {
    return this.datePipe.transform(iso, 'medium') ?? iso;
  }

  protected announce(sentence: string): void {
    this.announcer.announce(sentence);
  }

  protected async file(body: ProtestFormValue): Promise<void> {
    const c = this.contest();
    const dialog = this.requestDialog();
    try {
      await this.api.fileContestProtest(c.id, {
        reason: body.text,
        evidence_urls: body.evidence_urls,
      });
      const field = contestFieldLabel(c.field);
      await dialog?.succeed(
        $localize`:@@vendor.protest.live.filed:Sent to AEC Integrations for review: ${field}:FIELD:. The owner can reply once.`,
      );
      await this.store.revalidate(['contests']);
    } catch (err) {
      await this.refused(dialog, err);
    }
  }

  protected async reply(body: ProtestFormValue): Promise<void> {
    const dialog = this.replyDialog();
    try {
      await this.api.replyContestProtest(this.contest().id, {
        reply: body.text,
        evidence_urls: body.evidence_urls,
      });
      await dialog?.succeed(
        $localize`:@@vendor.protest.live.replied:Reply sent. AEC Integrations and the company that sent the request can read it.`,
      );
      await this.store.revalidate(['contests']);
    } catch (err) {
      await this.refused(dialog, err);
    }
  }

  /** A refusal that means the row moved closes the dialog, says why on the row and
   *  reloads the list. Anything else keeps the draft and says why in the dialog. */
  private async refused(dialog: ProtestFormDialog | undefined, err: unknown): Promise<void> {
    const message = protestErrorMessage(err);
    if (protestErrorReloads(err)) {
      this.error.set(message);
      await dialog?.abandon();
      await this.store.reload('contests');
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
      await this.api.withdrawContestProtest(this.contest().id);
      this.confirmingWithdraw.set(false);
      this.announcer.announce(
        $localize`:@@vendor.protest.live.withdrawn:Review request withdrawn.`,
      );
      await this.store.revalidate(['contests']);
    } catch (err) {
      this.confirmingWithdraw.set(false);
      await this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  private async fail(err: unknown): Promise<void> {
    this.error.set(protestErrorMessage(err));
    if (protestErrorReloads(err)) await this.store.reload('contests');
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

  /** The review record: the sunken panel a note takes inside a row. */
  protected readonly recordClass =
    'mt-2 max-w-prose space-y-2 rounded-panel bg-(--surface-sunken) p-4';
  protected readonly linkClass = IN_TEXT_LINK;
  protected readonly errorClass = FIELD_ERROR_CLASS;
}
