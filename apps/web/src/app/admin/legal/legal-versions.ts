import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  BrnDialog,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import {
  LEGAL_SUMMARY_BULLET_MAX,
  LEGAL_SUMMARY_MAX_BULLETS,
  LegalSummarySchema,
  legalVersionPagePath,
  type AdminLegalUpcomingEntry,
  type AdminLegalVersionsResponse,
  type LegalAgreementDocument,
  type LegalExpeditedReason,
} from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { AdminLegalApi } from './admin-legal-api';

/** A Yes/No answer. `null` until the operator picks one: neither question has a default. */
export type Answer = 'yes' | 'no' | null;

/** One entry's unsaved form. */
export interface LegalDraft {
  material: Answer;
  acceptance: Answer;
  summary: string;
  /** Has the summary field lost focus once? Its error shows from then on. */
  summaryTouched: boolean;
  expedited: LegalExpeditedReason | null;
}

const EMPTY_DRAFT: LegalDraft = {
  material: null,
  acceptance: null,
  summary: '',
  summaryTouched: false,
  expedited: null,
};

/** The bullets a summary textarea holds: one per non-blank line, trimmed. */
export function summaryBullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Why a summary cannot be published, or null when it can. Validity is decided by
 * `LegalSummarySchema`, the schema the API parses with, so the page and the server never
 * disagree. The sentence says which rule failed.
 */
export function summaryProblem(bullets: readonly string[]): string | null {
  if (LegalSummarySchema.safeParse(bullets).success) return null;
  if (bullets.length === 0) {
    return $localize`:@@admin.legal.summary.empty:Write at least one line.`;
  }
  if (bullets.length > LEGAL_SUMMARY_MAX_BULLETS) {
    const max = LEGAL_SUMMARY_MAX_BULLETS;
    return $localize`:@@admin.legal.summary.tooMany:Use at most ${max}:MAX: lines.`;
  }
  const long = bullets.findIndex((b) => b.length > LEGAL_SUMMARY_BULLET_MAX);
  if (long >= 0) {
    const n = long + 1;
    const max = LEGAL_SUMMARY_BULLET_MAX;
    return $localize`:@@admin.legal.summary.tooLong:Line ${n}:N: is longer than ${max}:MAX: characters.`;
  }
  return $localize`:@@admin.legal.summary.invalid:Check the summary. Each line must be plain text.`;
}

/** A byte count, in the largest unit that keeps it readable. */
export function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const n = (bytes / (1024 * 1024)).toFixed(1);
    return $localize`:@@admin.legal.size.mb:${n}:N: MB`;
  }
  if (bytes >= 1024) {
    const n = Math.round(bytes / 1024);
    return $localize`:@@admin.legal.size.kb:${n}:N: KB`;
  }
  if (bytes === 1) return $localize`:@@admin.legal.size.oneByte:1 byte`;
  return $localize`:@@admin.legal.size.bytes:${bytes}:N: bytes`;
}

/**
 * `/admin/legal` (AECI-1688). Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.22 and
 * `STAGE_1_SPEC.md` §27.5.
 *
 * One card per version in `LEGAL_AGREEMENT_UPCOMING_VERSIONS`. An unpublished card holds
 * the form: two Yes/No questions with no default, the summary lines and, for the Vendor
 * Terms only, the expedited reason. Publish stays off until both questions are answered
 * and the summary is valid. "Needs acceptance: Yes" can only be picked once "material"
 * is Yes. A published card shows what was recorded. The effective date is read-only: it
 * comes from the upcoming map. The text itself is not edited here.
 *
 * ─── Why it confirms ─────────────────────────────────────────────────────────
 * A publish cannot be undone, so it goes through a dialog that says, in plain words,
 * what each answer will cause. The dialog opens from the click handler, never from an
 * `effect()` (`email-switches.ts` documents the rule). While the request is in flight it
 * cannot be closed (`disableClose`: Escape, the backdrop and Cancel all refused). A
 * failure shows in the dialog and on the card, and the card's copy is an alert.
 *
 * Rendered in the `AdminShell` layout's outlet; the parent's `adminSummaryResolver` is the
 * gate. The frame paints during SSR and the data loads in `afterNextRender`.
 */
@Component({
  selector: 'aec-admin-legal-versions',
  imports: [
    AecSelect,
    BrnDialog,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    DatePipe,
    RouterLink,
  ],
  templateUrl: './legal-versions.html',
})
export class AdminLegalVersions {
  private readonly api = inject(AdminLegalApi);
  private readonly injector = inject(Injector);

  protected readonly data = signal<AdminLegalVersionsResponse | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  /** Unsaved form state, per document. */
  protected readonly drafts = signal<Partial<Record<LegalAgreementDocument, LegalDraft>>>({});
  /** The last failed publish, per document, shown on the card outside the dialog. */
  protected readonly cardErrors = signal<Partial<Record<LegalAgreementDocument, string>>>({});

  /** The entry the open dialog would publish. */
  protected readonly pending = signal<AdminLegalUpcomingEntry | null>(null);
  protected readonly submitting = signal(false);
  protected readonly failedMessage = signal('');
  /** After a publish: the card whose heading takes focus once the dialog has closed. */
  private focusAfterClose: LegalAgreementDocument | null = null;

  private readonly dialog = viewChild(BrnDialog);

  protected readonly publishEnabled = computed(() => this.data()?.publish_enabled ?? false);
  protected readonly maxBullets = LEGAL_SUMMARY_MAX_BULLETS;
  protected readonly maxBulletLength = LEGAL_SUMMARY_BULLET_MAX;

  protected readonly expeditedOptions: readonly AecSelectOption[] = [
    { value: null, label: $localize`:@@admin.legal.expedited.none:None` },
    { value: 'law', label: $localize`:@@admin.legal.expedited.law:The law requires the change` },
    { value: 'error', label: $localize`:@@admin.legal.expedited.error:It corrects an error` },
  ];

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  protected refresh(): void {
    void this.load();
  }

  // ── The form ───────────────────────────────────────────────────────────────

  protected draft(document: LegalAgreementDocument): LegalDraft {
    return this.drafts()[document] ?? EMPTY_DRAFT;
  }

  protected bullets(document: LegalAgreementDocument): string[] {
    return summaryBullets(this.draft(document).summary);
  }

  /** The summary's error, once the field was left or holds text. */
  protected summaryError(document: LegalAgreementDocument): string | null {
    const d = this.draft(document);
    if (!d.summaryTouched && d.summary.trim() === '') return null;
    return summaryProblem(this.bullets(document));
  }

  /** Both questions answered, a valid summary, and publishing on for the tier. */
  protected canPublish(document: LegalAgreementDocument): boolean {
    const d = this.draft(document);
    return (
      this.publishEnabled() &&
      d.material !== null &&
      d.acceptance !== null &&
      !(d.material === 'no' && d.acceptance === 'yes') &&
      summaryProblem(summaryBullets(d.summary)) === null
    );
  }

  protected onMaterial(document: LegalAgreementDocument, answer: 'yes' | 'no'): void {
    const d = this.draft(document);
    // "Needs acceptance: Yes" is only allowed on a material change. Taking material
    // back to No clears that answer, so the operator answers it again.
    const acceptance = answer === 'no' && d.acceptance === 'yes' ? null : d.acceptance;
    this.patch(document, { material: answer, acceptance });
  }

  protected onAcceptance(document: LegalAgreementDocument, answer: 'yes' | 'no'): void {
    if (answer === 'yes' && this.draft(document).material !== 'yes') return;
    this.patch(document, { acceptance: answer });
  }

  protected onSummary(document: LegalAgreementDocument, event: Event): void {
    this.patch(document, { summary: (event.target as HTMLTextAreaElement).value });
  }

  protected onSummaryBlur(document: LegalAgreementDocument): void {
    this.patch(document, { summaryTouched: true });
  }

  protected onExpedited(document: LegalAgreementDocument, value: string | null): void {
    this.patch(document, { expedited: (value as LegalExpeditedReason | null) ?? null });
  }

  // ── The dialog ─────────────────────────────────────────────────────────────

  /** Open the confirmation. Called from a click handler only, never from an effect. */
  protected openPublish(entry: AdminLegalUpcomingEntry): void {
    if (!this.canPublish(entry.document)) return;
    this.failedMessage.set('');
    this.pending.set(entry);
    this.dialog()?.open();
  }

  /** Cancel. Refused while the request is in flight. */
  protected cancelPublish(): void {
    if (this.submitting()) return;
    this.dialog()?.close();
  }

  /** The dialog closed: Cancel, Escape, the backdrop, or after a publish. */
  protected onDialogClosed(): void {
    this.pending.set(null);
    this.failedMessage.set('');
    const document = this.focusAfterClose;
    this.focusAfterClose = null;
    if (!document) return;
    // The dialog has just restored focus to the Publish button, which the published
    // card no longer has. Move it to the card heading once the card has re-rendered.
    afterNextRender(
      () => {
        globalThis.document?.getElementById(this.headingId(document))?.focus();
      },
      { injector: this.injector },
    );
  }

  protected async confirmPublish(): Promise<void> {
    const entry = this.pending();
    if (!entry || this.submitting()) return;
    const d = this.draft(entry.document);
    this.submitting.set(true);
    this.failedMessage.set('');
    this.cardErrors.update((e) => ({ ...e, [entry.document]: undefined }));
    try {
      await this.api.publish({
        document: entry.document,
        version: entry.version,
        material: d.material === 'yes',
        requires_acceptance: d.acceptance === 'yes',
        summary: summaryBullets(d.summary),
        ...(entry.document === 'vendor_terms' ? { expedited_reason: d.expedited } : {}),
      });
      this.focusAfterClose = entry.document;
      const title = this.documentTitle(entry.document);
      const version = entry.version;
      this.liveMessage.set(
        $localize`:@@admin.legal.announce.published:Version ${version}:VERSION: of the ${title}:TITLE: is published.`,
      );
      // Stay "submitting" through the reload, so the confirm button cannot send the same
      // publish twice while the list catches up.
      await this.load();
      this.submitting.set(false);
      // `disableClose` reaches the open dialog through an effect, so a close issued now
      // would still be refused. Close after the render that lifts it.
      afterNextRender(() => this.dialog()?.close(), { injector: this.injector });
    } catch (err) {
      const message = messageForError(err);
      this.submitting.set(false);
      this.failedMessage.set(message);
      this.cardErrors.update((e) => ({ ...e, [entry.document]: message }));
      if (err instanceof HttpErrorResponse && err.status === 409) void this.load();
    }
  }

  // ── View helpers ───────────────────────────────────────────────────────────

  protected headingId(document: LegalAgreementDocument): string {
    return `admin-legal-${document}-heading`;
  }

  protected documentTitle(document: LegalAgreementDocument): string {
    return document === 'vendor_terms'
      ? $localize`:@@admin.legal.doc.vendorTerms:Vendor Terms`
      : $localize`:@@admin.legal.doc.managedPlan:Managed plan agreement`;
  }

  /** `/legal/<slug>/v<version>`, the version's own page. */
  protected versionPath(entry: AdminLegalUpcomingEntry): string {
    return legalVersionPagePath(entry.document, entry.version);
  }

  protected expeditedLabel(reason: LegalExpeditedReason | null): string {
    return this.expeditedOptions.find((o) => o.value === reason)?.label ?? '';
  }

  protected humanBytes(bytes: number): string {
    return humanBytes(bytes);
  }

  /** The first 12 characters of a hash, enough to compare by eye. */
  protected shortHash(hash: string): string {
    return hash.slice(0, 12);
  }

  /** The first 8 characters of an admin's profile id, for the "published by" link. */
  protected shortId(id: string): string {
    return id.slice(0, 8);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private patch(document: LegalAgreementDocument, next: Partial<LegalDraft>): void {
    this.drafts.update((d) => ({ ...d, [document]: { ...(d[document] ?? EMPTY_DRAFT), ...next } }));
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      this.data.set(await this.api.list());
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}

/** The API error code, when the body carries one. */
function errorCode(err: HttpErrorResponse): string | null {
  const body = err.error as { error?: { code?: unknown } } | null;
  return typeof body?.error?.code === 'string' ? body.error.code : null;
}

/** Each failure the operator can act on gets its own sentence. */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    switch (errorCode(err)) {
      case 'LEGAL_PUBLISH_DISABLED':
        return $localize`:@@admin.legal.error.disabled:Publishing is turned off on this tier. Nothing was recorded.`;
      case 'LEGAL_VERSION_EXISTS':
        return $localize`:@@admin.legal.error.exists:This version is already published. The page now shows what was recorded.`;
      case 'LEGAL_VERSION_NOT_UPCOMING':
        return $localize`:@@admin.legal.error.notUpcoming:This version is no longer listed as upcoming. Reload the page.`;
      case 'LEGAL_NOTICE_WINDOW':
        return $localize`:@@admin.legal.error.window:This version takes effect less than 30 days from now. Move its effective date, or for the Vendor Terms give an expedited reason.`;
      case 'LEGAL_PDF_MISSING':
        return $localize`:@@admin.legal.error.pdf:No valid PDF is stored for this version. Run the legal PDF workflow for it, then publish again.`;
    }
    if (err.status === 400) {
      return $localize`:@@admin.legal.error.invalid:The server refused the answers or the summary. Check them and try again.`;
    }
    if (err.status === 429) {
      return $localize`:@@admin.legal.error.rateLimited:Too many changes in a minute. Wait a moment and try again.`;
    }
    if (err.status === 401 || err.status === 403) {
      return $localize`:@@admin.legal.error.session:Your session may have expired. Sign in again and retry.`;
    }
  }
  return $localize`:@@admin.legal.error.failed:Something went wrong. Refresh the list to see whether the version was recorded.`;
}
