import { DOCUMENT } from '@angular/common';
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';

import {
  THREAD_MESSAGE_BODY_MAX,
  type ThreadClosedReason,
  type ThreadCompany,
  type VendorThread,
  type VendorThreadMessage,
  type VendorThreadSummary,
} from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalStore } from '../vendor-portal-store';

import { companyMidSentence, formatDay } from './integration-detail-model';
import {
  ALERT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  HELP,
  ID_STYLES,
  LABEL,
  ROW_ACTION,
} from './integration-detail-styles';

/**
 * The private thread on one data row (AECI-1539, `STAGE_2_ATTESTATIONS_SPEC.md`
 * §15.11), shown inside a Change requests item where "Replies coming soon" used to
 * be: rows the other company added, disagreements, and rows the caller added.
 * Contests get no thread (§15.2).
 *
 * Messages read oldest first as "{Company} · {date}". A deleted message reads
 * "Message deleted", and a message whose author's account was erased reads "Former
 * member of {Company}" (§15.4, §15.5). **Message text is plain text**: it is
 * interpolated, never bound as HTML, and a URL in it is never linked (§15.4).
 *
 * Writes are pessimistic: each answers with the thread as it now stands, which
 * replaces the one on screen. Delete sits behind an inline confirmation, never a
 * browser dialog. "Ask AEC Integrations" shows as asked once `help_requested_at`
 * is set, for both companies (§15.3). A closed thread keeps its messages, loses the
 * composer, and says in one sentence why it closed (§15.10).
 *
 * The heading, the audience line and the composer name the server's
 * `counterparty`, the company the caller's messages actually go to (AECI-1545,
 * §15.6). On a co-owned endpoint that can differ from the page's endpoint list, so
 * the page's name is never used here. A row with no thread and no counterparty
 * cannot have one (§15.2): it shows one sentence and no composer.
 *
 * **The messages load only when the seat opens the thread** (AECI-1546). Until
 * then the row shows the page's one summary read (`GET /api/vendor/integrations/
 * :id/threads`, owned by `IntegrationChangeRequests`): the count, the latest date
 * and whether it is read-only. Opening reads `GET …/claims/:claimId/thread`, which
 * is what writes the seat's read marker, so a marker means the messages were shown.
 *
 * The `threads` cursor scope bumps `store.threadsRevision()` (AECI-1538). Each bump
 * re-reads an OPEN thread quietly. A closed row waits for the page's summary
 * re-read. The draft is separate state, so a re-read never replaces half-typed
 * text. A write emits `changed`, so the page re-reads its summary.
 */
@Component({
  selector: 'aec-integration-row-thread',
  // The divider is component CSS: a layered border-color utility never applies
  // (see ID_STYLES).
  styles: [ID_STYLES, '.id-thread { border-top: 1px solid var(--border-default); }'],
  template: `
    <div class="id-thread mt-3 pt-3" [attr.data-testid]="'thread-' + claimId()">
      <h5 class="id-h4" [id]="baseId() + '-heading'">{{ heading() }}</h5>

      @if (summaryStatus() === 'loading' && !fetched()) {
        <p class="mt-1 text-(--text-secondary)" i18n="@@vendor.im.thread.loading">
          Loading the conversation.
        </p>
      } @else if (summaryStatus() === 'failed' && !fetched()) {
        <div class="mt-1 flex flex-wrap items-center gap-3">
          <p class="text-(--text-primary)" i18n="@@vendor.im.thread.failed">
            Could not load the conversation.
          </p>
          <button
            type="button"
            [class]="secondary"
            (click)="retrySummary.emit()"
            i18n="@@vendor.im.retry"
          >
            Try again
          </button>
        </div>
      } @else if (!hasRecipient()) {
        <p class="mt-1 max-w-prose text-(--text-secondary)" data-testid="thread-unavailable">
          {{ unavailableSentence }}
        </p>
      } @else {
        <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          @if (summary(); as s) {
            <p class="text-(--text-secondary)" data-testid="thread-summary">
              <span i18n="@@vendor.im.thread.summary.count">{s.message_count, plural,
                =1 {1 message}
                other {{{ s.message_count }} messages}
              }</span>
              @if (s.latest_message_at; as at) {
                <span aria-hidden="true"> · </span><span>{{ latestLine(at) }}</span>
              }
              @if (s.closed_at) {
                <span aria-hidden="true"> · </span
                ><span i18n="@@vendor.im.thread.summary.closed">Read-only</span>
              }
            </p>
          } @else {
            <p
              class="text-(--text-secondary)"
              data-testid="thread-summary"
              i18n="@@vendor.im.thread.summary.none"
            >
              No messages yet.
            </p>
          }
          @if (canOpen()) {
            <button
              type="button"
              [class]="rowAction"
              [attr.aria-expanded]="open()"
              [attr.aria-controls]="baseId() + '-panel'"
              (click)="toggle()"
              data-testid="thread-toggle"
            >
              {{ toggleLabel() }}
            </button>
          }
        </div>
      }

      <div [id]="baseId() + '-panel'">
        @if (open()) {
          @if (status() === 'loading') {
            <p class="mt-1 text-(--text-secondary)" i18n="@@vendor.im.thread.loading">
              Loading the conversation.
            </p>
          } @else if (status() === 'failed') {
            <div class="mt-1 flex flex-wrap items-center gap-3">
              <p class="text-(--text-primary)" i18n="@@vendor.im.thread.failed">
                Could not load the conversation.
              </p>
              <button type="button" [class]="secondary" (click)="reload()" i18n="@@vendor.im.retry">
                Try again
              </button>
            </div>
          } @else {
            @let t = thread();
            @if (t && t.messages.length > 0) {
              <ol
                class="mt-2 list-none space-y-2 p-0"
                [attr.aria-labelledby]="baseId() + '-heading'"
              >
                @for (m of t.messages; track m.id) {
                  <li
                    class="rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2"
                    [attr.data-testid]="'thread-message-' + m.id"
                  >
                    <p class="text-(--text-secondary)">{{ metaLine(m) }}</p>
                    @if (m.deleted_at) {
                      <p
                        class="mt-0.5 text-(--text-secondary) italic"
                        i18n="@@vendor.im.thread.deleted"
                      >
                        Message deleted
                      </p>
                    } @else {
                      <p
                        class="mt-0.5 max-w-prose break-words whitespace-pre-line text-(--text-primary)"
                      >
                        {{ m.body }}
                      </p>
                      @if (canDelete(m)) {
                        @if (confirming() === m.id) {
                          <div class="mt-2 flex flex-wrap items-center gap-3">
                            <span
                              class="text-(--text-primary)"
                              i18n="@@vendor.im.thread.deleteConfirm"
                              >Delete this message? It will read "Message deleted".</span
                            >
                            <button
                              type="button"
                              [id]="baseId() + '-delete-yes-' + m.id"
                              [class]="secondary"
                              [disabled]="busy() !== null"
                              (click)="remove(m)"
                              i18n="@@vendor.im.thread.deleteYes"
                            >
                              Yes, delete it
                            </button>
                            <button
                              type="button"
                              [class]="rowAction"
                              [disabled]="busy() !== null"
                              (click)="cancelDelete(m)"
                              i18n="@@vendor.im.thread.deleteKeep"
                            >
                              Keep it
                            </button>
                          </div>
                        } @else {
                          <button
                            type="button"
                            [id]="baseId() + '-delete-' + m.id"
                            [class]="rowAction"
                            class="mt-1"
                            [attr.aria-label]="deleteLabel(m)"
                            [disabled]="busy() !== null"
                            (click)="startDelete(m)"
                            [attr.data-testid]="'thread-delete-' + m.id"
                            i18n="@@vendor.im.thread.delete"
                          >
                            Delete
                          </button>
                        }
                      }
                    }
                  </li>
                }
              </ol>
            }

            @if (t?.closed_reason; as reason) {
              <p class="mt-2 max-w-prose text-(--text-primary)" data-testid="thread-closed">
                {{ closedSentence(reason) }}
              </p>
            }

            @if (t?.help_requested_at; as asked) {
              <p class="mt-2 text-(--text-secondary)" data-testid="thread-help-asked">
                {{ helpAskedLine(asked) }}
              </p>
            }

            @if (canWrite()) {
              <div class="mt-3">
                <label [for]="baseId() + '-body'" [class]="label">{{ composerLabel() }}</label>
                <p [id]="baseId() + '-audience'" [class]="help">{{ audience() }}</p>
                <textarea
                  [id]="baseId() + '-body'"
                  rows="3"
                  [attr.maxlength]="max"
                  class="id-input mt-1"
                  [attr.aria-describedby]="baseId() + '-audience ' + baseId() + '-count'"
                  [attr.aria-invalid]="error() ? 'true' : null"
                  [value]="draft()"
                  (input)="setDraft($event)"
                  data-testid="thread-composer"
                ></textarea>
                <p [id]="baseId() + '-count'" class="mt-1 text-xs text-(--text-secondary)">
                  {{ countLabel() }}
                </p>
                <div class="mt-2 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    [class]="primary"
                    [disabled]="busy() !== null || !canSend()"
                    (click)="send()"
                    data-testid="thread-send"
                    i18n="@@vendor.im.thread.send"
                  >
                    Send
                  </button>
                  @if (t && !t.help_requested_at) {
                    <button
                      type="button"
                      [class]="secondary"
                      [disabled]="busy() !== null"
                      (click)="askHelp()"
                      data-testid="thread-help"
                      i18n="@@vendor.im.thread.help"
                    >
                      Ask AEC Integrations
                    </button>
                  }
                </div>
              </div>
            }

            @if (error(); as message) {
              <p role="alert" [class]="alert" class="mt-2">{{ message }}</p>
            }
          }
        }
      </div>
    </div>
  `,
})
export class IntegrationRowThread {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  /** The data row (`claims.id`) the thread is on. */
  readonly claimId = input.required<string>();
  /** False on a retired integration: it takes no new message (§15.6). */
  readonly live = input(true);
  /** This row's entry in the page's summary read, or `null` when it has no thread
   *  the caller can read (AECI-1546). */
  readonly summary = input<VendorThreadSummary | null>(null);
  /** The summary read's `counterparty`: who a first post on this row would go to. */
  readonly firstPostTo = input<ThreadCompany | null>(null);
  /** The state of the page's summary read. */
  readonly summaryStatus = input<'loading' | 'loaded' | 'failed'>('loaded');
  /** "Try again" on a failed summary read. The page owns that read. */
  readonly retrySummary = output<void>();
  /** A write landed, so the page's summary is stale. */
  readonly changed = output<void>();

  protected readonly max = THREAD_MESSAGE_BODY_MAX;

  /** Whether the messages are shown. They load only then (AECI-1546). */
  protected readonly open = signal(false);
  /** The state of this row's own `GET …/thread`, shown only while open. */
  protected readonly status = signal<'loading' | 'loaded' | 'failed'>('loading');
  /** True once `GET …/thread` answered. From then on it, not the summary, decides. */
  protected readonly fetched = signal(false);
  protected readonly thread = signal<VendorThread | null>(null);
  /** Who the caller's messages go to, from `GET …/thread` (AECI-1545). */
  protected readonly counterparty = signal<ThreadCompany | null>(null);
  protected readonly draft = signal('');
  protected readonly busy = signal<'send' | 'delete' | 'help' | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly baseId = computed(() => `thread-${this.claimId()}`);

  /** The server's recipient: from the row's own read once it answered, else from the
   *  summary. Never the page's endpoint list (AECI-1545). */
  private readonly recipient = computed(() =>
    this.fetched()
      ? this.counterparty()
      : (this.summary()?.counterparty ?? this.firstPostTo() ?? null),
  );

  private readonly other = computed(() => companyMidSentence(this.recipient()?.name ?? null));

  protected readonly heading = computed(() => {
    const who = this.other();
    return $localize`:@@vendor.im.thread.heading:Conversation with ${who}:company:`;
  });
  protected readonly audience = computed(() => {
    const who = this.other();
    return $localize`:@@vendor.im.thread.audience:Only ${who}:company: and AEC Integrations see this.`;
  });
  protected readonly composerLabel = computed(() => {
    const who = this.other();
    return $localize`:@@vendor.im.thread.composerLabel:Message to ${who}:company:`;
  });
  protected readonly unavailableSentence = $localize`:@@vendor.im.thread.error.notAttestable:This row cannot have a conversation. It needs two different companies, on an integration that does not run through a connector service.`;
  protected readonly countLabel = computed(() => {
    const n = this.draft().length;
    const max = THREAD_MESSAGE_BODY_MAX;
    return $localize`:@@vendor.im.thread.count:${n}:COUNT: of ${max}:MAX: characters`;
  });

  /** A closed thread is read-only, and so is a retired row (§15.6, §15.10). */
  protected readonly canWrite = computed(
    () => this.live() && !this.thread()?.closed_at && this.hasRecipient(),
  );

  /** A thread, or a company the first post would open one with (§15.2). */
  protected readonly hasRecipient = computed(() =>
    this.fetched()
      ? this.thread() !== null || this.counterparty() !== null
      : this.summary() !== null || this.firstPostTo() !== null,
  );

  /** Something to open: a thread to read, or a live row to write the first message on. */
  protected readonly canOpen = computed(() => this.summary() !== null || this.live());

  protected readonly toggleLabel = computed(() => {
    if (this.open()) {
      return $localize`:@@vendor.im.thread.toggle.hide:Hide the conversation`;
    }
    return this.summary()
      ? $localize`:@@vendor.im.thread.toggle.show:Show the conversation`
      : $localize`:@@vendor.im.thread.toggle.write:Write a message`;
  });

  /** §15.4: 1 to 2,000 characters after trim. */
  protected readonly canSend = computed(() => {
    const n = this.draft().trim().length;
    return n >= 1 && n <= THREAD_MESSAGE_BODY_MAX;
  });

  constructor() {
    // A different row closes and resets. The cursor moved: re-read, but only while
    // open. A closed row shows the page's summary, which the page re-reads once for
    // every row (AECI-1546). The first run is the baseline.
    let seenId: string | null = null;
    let seenRevision: number | null = null;
    effect(() => {
      const id = this.claimId();
      const revision = this.store.threadsRevision();
      if (seenRevision === null) {
        seenId = id;
        seenRevision = revision;
        return;
      }
      if (id === seenId && revision === seenRevision) return;
      const rowChanged = id !== seenId;
      seenId = id;
      seenRevision = revision;
      untracked(() => {
        if (rowChanged) this.resetRowState();
        else if (this.open()) void this.load({ quiet: true });
      });
    });
  }

  // ── Copy ───────────────────────────────────────────────────────────────────

  protected metaLine(m: VendorThreadMessage): string {
    const date = formatDay(m.created_at);
    const company = m.author_vendor.name;
    return m.author_removed
      ? $localize`:@@vendor.im.thread.metaFormer:Former member of ${company}:company: · ${date}:date:`
      : $localize`:@@vendor.im.thread.meta:${company}:company: · ${date}:date:`;
  }

  protected latestLine(at: string): string {
    const date = formatDay(at);
    return $localize`:@@vendor.im.thread.summary.latest:latest ${date}:date:`;
  }

  protected deleteLabel(m: VendorThreadMessage): string {
    const date = formatDay(m.created_at);
    return $localize`:@@vendor.im.thread.deleteLabel:Delete your message from ${date}:date:`;
  }

  protected helpAskedLine(at: string): string {
    const date = formatDay(at);
    return $localize`:@@vendor.im.thread.helpAsked:AEC Integrations was asked to look at this conversation on ${date}:date:.`;
  }

  /** One sentence on why the thread closed (§15.10). */
  protected closedSentence(reason: ThreadClosedReason): string {
    switch (reason) {
      case 'retired':
        return $localize`:@@vendor.im.thread.closed.retired:This conversation closed when the integration was retired. It is read-only.`;
      case 'withdrawn':
        return $localize`:@@vendor.im.thread.closed.withdrawn:This conversation closed when the company that added this row withdrew it. It is read-only.`;
      case 'claim_removed':
        return $localize`:@@vendor.im.thread.closed.removed:This conversation closed when this row was removed from the directory. It is read-only.`;
      case 'not_attestable':
        return $localize`:@@vendor.im.thread.closed.notAttestable:This conversation closed when the integration moved to a connector service, which neither company builds. It is read-only.`;
    }
  }

  protected canDelete(m: VendorThreadMessage): boolean {
    return m.is_own && !m.deleted_at && this.canWrite();
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  protected setDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
    if (this.error()) this.error.set(null);
  }

  protected reload(): void {
    void this.load({ quiet: false });
  }

  /** Opening reads the messages, and that read marks them read (§15.8). A re-open
   *  keeps what it showed last while it re-reads. */
  protected toggle(): void {
    if (this.open()) {
      this.open.set(false);
      this.confirming.set(null);
      return;
    }
    this.open.set(true);
    void this.load({ quiet: this.fetched() });
  }

  protected async send(): Promise<void> {
    if (this.busy() || !this.canSend()) return;
    this.busy.set('send');
    this.error.set(null);
    try {
      const first = this.thread() === null;
      const { thread } = await this.api.postThreadMessage(this.claimId(), this.draft().trim());
      this.thread.set(thread);
      // The first post stamps the pair. Re-read so the recipient is the stamped one.
      if (first) void this.load({ quiet: true });
      this.changed.emit();
      this.draft.set('');
      const who = this.other();
      this.announcer.announce(
        $localize`:@@vendor.im.thread.live.sent:Message sent to ${who}:company:.`,
      );
      this.focusId(`${this.baseId()}-body`);
    } catch (err) {
      await this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected startDelete(m: VendorThreadMessage): void {
    this.error.set(null);
    this.confirming.set(m.id);
    this.focusId(`${this.baseId()}-delete-yes-${m.id}`);
  }

  protected cancelDelete(m: VendorThreadMessage): void {
    this.confirming.set(null);
    this.focusId(`${this.baseId()}-delete-${m.id}`);
  }

  protected async remove(m: VendorThreadMessage): Promise<void> {
    if (this.busy()) return;
    this.busy.set('delete');
    this.error.set(null);
    try {
      const { thread } = await this.api.deleteThreadMessage(this.claimId(), m.id);
      this.thread.set(thread);
      this.confirming.set(null);
      this.changed.emit();
      this.announcer.announce($localize`:@@vendor.im.thread.live.deleted:Message deleted.`);
      this.focusId(`${this.baseId()}-heading`);
    } catch (err) {
      this.confirming.set(null);
      await this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  protected async askHelp(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('help');
    this.error.set(null);
    try {
      const { thread } = await this.api.requestThreadHelp(this.claimId());
      this.thread.set(thread);
      this.changed.emit();
      this.announcer.announce(
        $localize`:@@vendor.im.thread.live.help:AEC Integrations was asked to look at this conversation.`,
      );
    } catch (err) {
      await this.fail(err);
    } finally {
      this.busy.set(null);
    }
  }

  // ── Loads ──────────────────────────────────────────────────────────────────

  private async load({ quiet }: { quiet: boolean }): Promise<void> {
    if (!quiet || this.status() === 'failed') this.status.set('loading');
    try {
      const { thread, counterparty } = await this.api.getThread(this.claimId());
      this.thread.set(thread);
      this.counterparty.set(counterparty ?? null);
      this.fetched.set(true);
      this.status.set('loaded');
    } catch {
      // A quiet re-read that fails keeps what is on screen.
      if (!quiet || this.status() !== 'loaded') this.status.set('failed');
    }
  }

  private resetRowState(): void {
    this.open.set(false);
    this.fetched.set(false);
    this.status.set('loading');
    this.thread.set(null);
    this.counterparty.set(null);
    this.draft.set('');
    this.confirming.set(null);
    this.error.set(null);
  }

  /** A lost race is not a failure to retry: say so, then re-read. */
  private async fail(err: unknown): Promise<void> {
    const info = readVendorApiError(err);
    let message: string;
    switch (info?.code) {
      case 'THREAD_CLOSED':
        message = $localize`:@@vendor.im.thread.error.closed:This conversation closed. It is read-only now.`;
        await this.load({ quiet: true });
        break;
      case 'THREAD_NOT_ATTESTABLE':
        message = $localize`:@@vendor.im.thread.error.notAttestable:This row cannot have a conversation. It needs two different companies, on an integration that does not run through a connector service.`;
        break;
      case 'INTEGRATION_RETIRED':
        message = $localize`:@@vendor.im.thread.error.retired:This integration was retired, so it takes no new messages.`;
        break;
      case 'VALIDATION_FAILED':
        message = $localize`:@@vendor.im.thread.error.length:Write a message of 1 to 2,000 characters.`;
        break;
      case 'RATE_LIMITED':
        message = $localize`:@@vendor.im.error.rate:Too many requests in a short time. Wait a minute and try again.`;
        break;
      default:
        message = $localize`:@@vendor.im.thread.error.generic:Could not save that. Try again.`;
    }
    this.error.set(message);
  }

  private focusId(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }

  protected readonly label = LABEL;
  protected readonly help = HELP;
  protected readonly alert = ALERT;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
  protected readonly rowAction = ROW_ACTION;
}
