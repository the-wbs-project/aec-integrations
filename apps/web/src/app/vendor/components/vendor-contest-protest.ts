import { DatePipe, DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { CONTEST_PROTEST_MAX_EVIDENCE, isHttpUrl, type VendorContest } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  contestFieldLabel,
  protestErrorMessage,
  protestErrorReloads,
  protestStatusLabel,
} from './vendor-contest-labels';

type Side = 'submitted' | 'received';
type Busy = 'file' | 'reply' | 'withdraw' | null;

/**
 * One contest's protest to AECi, inside a row of the Field contests lists
 * (AECI-1009 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.12.12).
 *
 *  - **Submitted side.** While the contest can be protested, a disclosure opens an
 *    inline form: a required reason and up to three evidence links. Before day 30
 *    on an unanswered contest it says from when. An open protest can be withdrawn,
 *    with an inline confirmation, never `confirm()`.
 *  - **Received side.** The owner sees the whole protest and replies once, before
 *    the due date.
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
  imports: [DatePipe, NgTemplateOutlet, RouterLink],
  styles: [':host { display: block; }'],
  template: `
    @let c = contest();
    @let p = c.protest;
    @if (p) {
      <div
        class="mt-2 max-w-prose space-y-2 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-3"
        [attr.data-protest]="c.id"
      >
        <div class="flex flex-wrap items-start justify-between gap-2">
          <p
            class="font-label text-sm font-semibold text-(--text-primary)"
            i18n="@@vendor.protest.heading"
          >
            Review by AEC Integrations
          </p>
          <span [class]="pillClass(p.status)">{{ statusLabel(p.status) }}</span>
        </div>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
          <dt class="text-(--text-secondary)" i18n="@@vendor.protest.basis">Asked because</dt>
          <dd class="text-(--text-primary)">
            @if (p.basis === 'silence') {
              <ng-container i18n="@@vendor.protest.basis.silence"
                >The owner did not answer within 30 days</ng-container
              >
            } @else {
              <ng-container i18n="@@vendor.protest.basis.declined"
                >The owner declined the contest</ng-container
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
              <ul class="space-y-0.5">
                @for (url of p.evidence_urls; track url) {
                  <li class="break-all">
                    <a [href]="url" rel="noopener noreferrer" target="_blank" [class]="linkClass">{{
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
                <ul class="mt-1 space-y-0.5">
                  @for (url of p.reply_evidence_urls; track url) {
                    <li class="break-all">
                      <a
                        [href]="url"
                        rel="noopener noreferrer"
                        target="_blank"
                        [class]="linkClass"
                        >{{ url }}</a
                      >
                    </li>
                  }
                </ul>
              }
            } @else if (p.status === 'open' && replyOpen()) {
              <ng-container i18n="@@vendor.protest.reply.due"
                >Due {{ p.reply_due_at | date: 'mediumDate' }}</ng-container
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
                Withdraw this review request? You cannot ask again for this contest.
              </p>
              <button
                type="button"
                [id]="ids.withdrawConfirm"
                [class]="secondaryClass"
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
                type="button"
                [class]="secondaryClass"
                [disabled]="busy() !== null"
                (click)="cancelWithdraw()"
                i18n="@@vendor.protest.withdraw.keep"
              >
                Keep it
              </button>
            </div>
          } @else {
            <button
              type="button"
              [id]="ids.withdrawStart"
              [class]="secondaryClass"
              [disabled]="busy() !== null"
              (click)="startWithdraw()"
              i18n="@@vendor.protest.withdraw"
            >
              Withdraw review request
            </button>
          }
        }

        @if (side() === 'received' && canReply()) {
          <form class="space-y-2 pt-1" (submit)="$event.preventDefault(); reply()" novalidate>
            <label [for]="ids.replyText" [class]="labelClass" i18n="@@vendor.protest.reply.label"
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
            <p [id]="ids.replyHint" class="text-xs text-(--text-secondary)">
              <ng-container i18n="@@vendor.protest.reply.hint"
                >You can reply once, by {{ p.reply_due_at | date: 'mediumDate' }}. AEC Integrations
                and the vendor that sent the contest see it. Nothing about it is
                public.</ng-container
              >
            </p>
            <ng-container [ngTemplateOutlet]="evidenceFields" />
            <button type="submit" [class]="primaryClass" [disabled]="busy() !== null">
              @if (busy() === 'reply') {
                <span i18n="@@vendor.protest.reply.sending">Sending…</span>
              } @else {
                <span i18n="@@vendor.protest.reply.send">Send reply</span>
              }
            </button>
          </form>
        }
      </div>
    } @else if (side() === 'submitted') {
      @if (windowPhase() === 'not_yet') {
        <p class="text-xs text-(--text-secondary)">
          <ng-container i18n="@@vendor.protest.notYet"
            >You can ask AEC Integrations to review this from
            {{ c.protest_opens_at | date: 'mediumDate' }} if the owner has not
            answered.</ng-container
          >
        </p>
      } @else if (windowPhase() === 'open') {
        @if (!formOpen()) {
          <button
            type="button"
            [id]="ids.start"
            [class]="secondaryClass"
            [attr.aria-expanded]="false"
            [attr.aria-controls]="ids.form"
            (click)="openForm()"
            i18n="@@vendor.protest.start"
          >
            Ask AEC Integrations to review
          </button>
        } @else {
          <form
            [id]="ids.form"
            class="mt-2 max-w-prose space-y-2 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-3"
            (submit)="$event.preventDefault(); file()"
            novalidate
            [attr.aria-labelledby]="ids.formHeading"
          >
            <p
              [id]="ids.formHeading"
              class="font-label text-sm font-semibold text-(--text-primary)"
              i18n="@@vendor.protest.form.heading"
            >
              Ask AEC Integrations to review this contest
            </p>
            <p class="text-sm text-(--text-secondary)">
              @if (c.protest_basis === 'silence') {
                <ng-container i18n="@@vendor.protest.form.silence"
                  >The owner did not answer within 30 days, so this counts as a
                  decline.</ng-container
                >
              } @else {
                <ng-container i18n="@@vendor.protest.form.declined"
                  >The owner declined this contest.</ng-container
                >
              }
            </p>
            <p [id]="ids.formHelp" class="text-sm text-(--text-secondary)">
              <ng-container i18n="@@vendor.protest.form.help"
                >AEC Integrations reads both sides and says which it agrees with. Its view is
                advice. Only the owner can change the listing. The owner can reply once. Nothing
                about a review is public.</ng-container
              >
              @if (c.protest_closes_at; as closes) {
                <ng-container i18n="@@vendor.protest.form.deadline">
                  You can ask until {{ closes | date: 'mediumDate' }}.</ng-container
                >
              }
            </p>
            <label [for]="ids.reason" [class]="labelClass" i18n="@@vendor.protest.form.reason"
              >Why the proposed value is right</label
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
            <div class="flex flex-wrap items-center gap-2">
              <button type="submit" [class]="primaryClass" [disabled]="busy() !== null">
                @if (busy() === 'file') {
                  <span i18n="@@vendor.protest.form.sending">Sending…</span>
                } @else {
                  <span i18n="@@vendor.protest.form.send">Send to AEC Integrations</span>
                }
              </button>
              <button
                type="button"
                [class]="secondaryClass"
                [disabled]="busy() !== null"
                (click)="closeForm()"
                i18n="@@vendor.protest.form.cancel"
              >
                Cancel
              </button>
            </div>
          </form>
        }
      }
    }

    @if (side() === 'submitted' && c.cooldown_until; as until) {
      <p class="mt-2 text-xs text-(--text-secondary)">
        <ng-container i18n="@@vendor.protest.cooldown"
          >You can't contest this field again until {{ until | date: 'mediumDate' }}, unless its
          value changes.</ng-container
        >
      </p>
    }

    @if (error(); as message) {
      <p role="alert" class="mt-2 text-sm font-medium text-(--text-primary)">{{ message }}</p>
    }

    <ng-template #evidenceFields>
      <fieldset class="space-y-2">
        <legend [class]="labelClass" i18n="@@vendor.protest.links.legend">
          Supporting links (optional, up to three)
        </legend>
        @for (url of links(); track $index) {
          <div class="flex flex-wrap items-center gap-2">
            <label [for]="ids.link + $index" class="sr-only" i18n="@@vendor.protest.links.label"
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
              [class]="inputClass + ' flex-1'"
            />
            <button
              type="button"
              [class]="secondaryClass"
              (click)="removeLink($index)"
              i18n="@@vendor.protest.links.remove"
            >
              Remove <span class="sr-only">link {{ $index + 1 }}</span>
            </button>
          </div>
        }
        @if (links().length < maxLinks) {
          <button
            type="button"
            [class]="secondaryClass"
            (click)="addLink()"
            i18n="@@vendor.protest.links.add"
          >
            Add a link
          </button>
        }
      </fieldset>
    </ng-template>
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

  protected readonly maxLinks = CONTEST_PROTEST_MAX_EVIDENCE;
  protected readonly busy = signal<Busy>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly formOpen = signal(false);
  protected readonly confirmingWithdraw = signal(false);
  protected readonly text = signal('');
  protected readonly links = signal<readonly string[]>([]);
  protected readonly textError = signal(false);

  /** Element ids, derived from the contest id so two rows never collide. */
  protected get ids() {
    const id = this.contest().id;
    return {
      start: `vendor-protest-start-${id}`,
      form: `vendor-protest-form-${id}`,
      formHeading: `vendor-protest-form-heading-${id}`,
      formHelp: `vendor-protest-form-help-${id}`,
      reason: `vendor-protest-reason-${id}`,
      replyText: `vendor-protest-reply-${id}`,
      replyHint: `vendor-protest-reply-hint-${id}`,
      link: `vendor-protest-link-${id}-`,
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
        ? $localize`:@@vendor.protest.meaning.upheld.owner:AEC Integrations agrees with the contest. This is advice. The value on record stays unless you change it.`
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
    const index = this.links().length - 1;
    this.focusAfterRender(`${this.ids.link}${index}`);
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
          ? $localize`:@@vendor.protest.error.reasonRequired:Say why the proposed value is right.`
          : $localize`:@@vendor.protest.error.replyRequired:Write your reply before you send it.`,
      );
      return null;
    }
    if (evidence.some((u) => !isHttpUrl(u))) {
      this.error.set(
        $localize`:@@vendor.protest.error.link:Each link must be a full web address that starts with http:// or https://.`,
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
    const c = this.contest();
    try {
      await this.api.fileContestProtest(c.id, {
        reason: body.text,
        evidence_urls: body.evidence_urls,
      });
      const field = contestFieldLabel(c.field);
      this.announcer.announce(
        $localize`:@@vendor.protest.live.filed:Sent to AEC Integrations for review: ${field}:FIELD:. The owner can reply once.`,
      );
      this.formOpen.set(false);
      this.resetFields();
      await this.store.revalidate(['contests']);
    } catch (err) {
      await this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected async reply(): Promise<void> {
    if (this.busy()) return;
    this.error.set(null);
    const body = this.body();
    if (!body) return;
    this.busy.set('reply');
    try {
      await this.api.replyContestProtest(this.contest().id, {
        reply: body.text,
        evidence_urls: body.evidence_urls,
      });
      this.announcer.announce(
        $localize`:@@vendor.protest.live.replied:Reply sent. AEC Integrations and the vendor that sent the contest can read it.`,
      );
      this.resetFields();
      await this.store.revalidate(['contests']);
    } catch (err) {
      await this.fail(err);
    } finally {
      this.busy.set(null);
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
    if (protestErrorReloads(err)) {
      this.formOpen.set(false);
      await this.store.reload('contests');
    }
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

  protected pillClass(status: string): string {
    const base =
      'inline-flex shrink-0 items-center rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]';
    return status === 'open' || status === 'upheld'
      ? `${base} border-(--accent-primary) bg-(--surface-raised) text-(--accent-primary)`
      : `${base} border-(--border-strong) bg-(--surface-raised) text-(--text-primary)`;
  }

  protected readonly linkClass =
    'text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}
