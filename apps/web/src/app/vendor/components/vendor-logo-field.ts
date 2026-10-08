import { NgOptimizedImage } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { LogoUrlSchema } from '@aeci/shared';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';
import type { Subscription } from 'rxjs';

import { pickLogoFile, uploadLogo } from '../../shared/logo-input/logo-upload';

/** Saves the logo and resolves to the value the server now holds. */
export type SaveLogo = (logoUrl: string | null) => Promise<string | null>;

/**
 * The vendor portal's Logo row (vendor profile and product Profile tab): the
 * current logo, an Edit button, and a dialog that saves on its own.
 *
 * ── ONE SOURCE, NOT TWO ─────────────────────────────────────────────────────
 * The old inline control showed a URL box and a drop zone together, which read
 * as two fields to fill. The dialog keeps them as two labelled sections with an
 * "or" between them, and only one can hold the new logo: typing a URL drops an
 * uploaded file, and uploading a file clears the URL. The preview at the top
 * always shows the one that will be saved.
 *
 * ── IT SAVES ITSELF ─────────────────────────────────────────────────────────
 * Save and Remove write straight away through {@link save}, which the parent
 * wires to its PATCH with `{ logo_url }` alone. A vendor who closed the dialog
 * expects the logo to be done; making them find the form's Save button too
 * would publish nothing. Unsaved edits in the rest of the form are untouched.
 * Saves are pessimistic: the dialog stays open on a failure and says why.
 * While a save is in flight nothing closes it, Escape and the backdrop
 * included (`disableClose`), so the outcome always lands in front of the
 * vendor: the dialog closes once the save succeeds, never before.
 *
 * Open is imperative, from the click handler, never from an `effect()` (NG0602,
 * see `vendor-seat-invite-dialog.ts`).
 */
@Component({
  selector: 'aec-vendor-logo-field',
  imports: [
    NgOptimizedImage,
    BrnDialog,
    BrnDialogContent,
    BrnDialogClose,
    BrnDialogTitle,
    BrnDialogDescription,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-2">
      <span [id]="fieldId() + '-label'" [class]="labelClass" i18n="@@vendor.logo.label">Logo</span>
      <div class="flex flex-wrap items-center gap-4">
        <div
          class="flex size-16 shrink-0 items-center justify-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) p-1"
          data-testid="logo-current"
        >
          @if (current() && !currentFailed()) {
            <img
              [ngSrc]="current()"
              width="64"
              height="64"
              alt="Current logo"
              i18n-alt="@@vendor.logo.currentAlt"
              (error)="currentFailed.set(true)"
              class="size-full object-contain"
            />
          } @else if (current()) {
            <span
              class="px-1 text-center text-xs text-(--text-secondary)"
              i18n="@@vendor.logo.currentFailed"
              >Can't show</span
            >
          } @else {
            <span class="text-xs text-(--text-secondary)" i18n="@@vendor.logo.none">No logo</span>
          }
        </div>
        @if (canEdit()) {
          <button
            type="button"
            (click)="open()"
            [attr.aria-describedby]="fieldId() + '-label'"
            [class]="secondaryButtonClass"
            data-testid="logo-edit"
          >
            @if (current()) {
              <span i18n="@@vendor.logo.edit">Edit logo</span>
            } @else {
              <span i18n="@@vendor.logo.add">Add logo</span>
            }
          </button>
        }
      </div>
      @if (confirmation()) {
        <p class="text-sm font-medium text-(--accent-primary)" role="status">
          {{ confirmation() }}
        </p>
      }
    </div>

    <brn-dialog [disableClose]="busy()" (closed)="onClosed()">
      <ng-template brnDialogContent>
        <div
          class="max-h-[85vh] w-[min(92vw,34rem)] overflow-y-auto rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-6 text-(--text-primary) md:p-8"
        >
          <div class="flex items-start justify-between gap-4">
            <h2
              brnDialogTitle
              class="font-display text-xl font-semibold text-(--text-primary)"
              i18n="@@vendor.logo.dialog.heading"
            >
              Change logo
            </h2>
            <button
              brnDialogClose
              type="button"
              [disabled]="busy()"
              class="-me-1 -mt-1 shrink-0 rounded-(--radius-sm) p-1 text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n-aria-label="@@vendor.logo.dialog.close"
              aria-label="Close"
            >
              <svg
                class="size-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p
            brnDialogDescription
            class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.logo.dialog.hint"
          >
            Use one of the two options below. PNG, JPEG or static WebP, up to 2 MiB and 2048 pixels
            per side. Logos are public.
          </p>

          <div class="mt-6 flex items-center gap-4">
            <div
              class="flex size-20 shrink-0 items-center justify-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) p-1"
            >
              @if (previewSrc() && !previewFailed()) {
                <img
                  [ngSrc]="previewSrc()"
                  width="80"
                  height="80"
                  alt="Logo preview"
                  i18n-alt="@@logo.preview"
                  (error)="previewFailed.set(true)"
                  class="size-full object-contain"
                />
              } @else if (!previewSrc()) {
                <span class="text-xs text-(--text-secondary)" i18n="@@vendor.logo.none"
                  >No logo</span
                >
              }
            </div>
            <div class="min-w-0 text-sm">
              <p class="font-bold text-(--text-primary)">
                @if (draft()) {
                  <span i18n="@@vendor.logo.dialog.newLogo">New logo</span>
                } @else {
                  <span i18n="@@vendor.logo.dialog.currentLogo">Current logo</span>
                }
              </p>
              <p class="mt-1 text-(--text-secondary)">
                @if (previewFailed() && previewSrc()) {
                  <span i18n="@@logo.previewFailed"
                    >Preview unavailable. Check that the URL points to an image.</span
                  >
                } @else if (source() === 'file' && fileName()) {
                  <span i18n="@@vendor.logo.dialog.fromFile">From {{ fileName() }}</span>
                } @else if (source() === 'url' && draft()) {
                  <span i18n="@@vendor.logo.dialog.fromUrl">From the URL below</span>
                } @else {
                  <span i18n="@@vendor.logo.dialog.pickOne">Paste a URL or upload a file.</span>
                }
              </p>
            </div>
          </div>

          <section
            class="mt-6 rounded-(--radius-md) border p-4"
            [class]="source() === 'url' ? activeSection : idleSection"
            [attr.aria-labelledby]="fieldId() + '-url-heading'"
          >
            <h3
              [id]="fieldId() + '-url-heading'"
              class="text-sm font-bold text-(--text-primary)"
              i18n="@@vendor.logo.dialog.urlHeading"
            >
              Paste an image URL
            </h3>
            <label
              [for]="fieldId() + '-url'"
              class="mt-1 block text-xs text-(--text-secondary)"
              i18n="@@vendor.logo.dialog.urlHelp"
              >A link that starts with https:// and opens the image itself.</label
            >
            <input
              [id]="fieldId() + '-url'"
              type="text"
              inputmode="url"
              autocomplete="off"
              placeholder="https://"
              [value]="urlText()"
              [disabled]="busy()"
              (input)="onUrl($event)"
              [attr.aria-invalid]="invalidUrl() ? 'true' : null"
              [attr.aria-describedby]="invalidUrl() ? fieldId() + '-url-error' : null"
              class="mt-2 w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)"
            />
            @if (invalidUrl()) {
              <p
                [id]="fieldId() + '-url-error'"
                class="mt-2 text-xs font-medium text-(--text-primary)"
                i18n="@@vendor.logo.dialog.urlInvalid"
              >
                Enter a URL that starts with https://
              </p>
            }
          </section>

          <div class="my-3 flex items-center gap-3" aria-hidden="true">
            <span class="h-px flex-1 bg-(--border-default)"></span>
            <span
              class="text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
              i18n="@@vendor.logo.dialog.or"
              >or</span
            >
            <span class="h-px flex-1 bg-(--border-default)"></span>
          </div>

          <section
            class="rounded-(--radius-md) border p-4"
            [class]="source() === 'file' ? activeSection : idleSection"
            [attr.aria-labelledby]="fieldId() + '-file-heading'"
            (dragover)="dragOver($event)"
            (dragleave)="dragging.set(false)"
            (drop)="drop($event)"
            [class.border-dashed]="dragging()"
          >
            <h3
              [id]="fieldId() + '-file-heading'"
              class="text-sm font-bold text-(--text-primary)"
              i18n="@@vendor.logo.dialog.fileHeading"
            >
              Upload a file
            </h3>
            <label
              [for]="fieldId() + '-file'"
              class="mt-1 block text-xs text-(--text-secondary)"
              i18n="@@vendor.logo.dialog.fileHelp"
              >Choose an image from your computer, or drop it here.</label
            >
            <input
              [id]="fieldId() + '-file'"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              [disabled]="busy()"
              (change)="choose($event)"
              class="mt-2 block w-full text-sm text-(--text-secondary) file:me-3 file:rounded-(--radius-md) file:border file:border-(--border-default) file:bg-(--surface-base) file:px-3 file:py-2 file:font-medium file:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
            @if (uploading()) {
              <p class="mt-2 text-xs text-(--text-secondary)" role="status" i18n="@@logo.uploading">
                Uploading logo…
              </p>
            }
          </section>

          @if (error()) {
            <p role="alert" class="mt-4 text-sm font-medium text-(--text-primary)">{{ error() }}</p>
          }

          <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
            @if (current()) {
              <button
                type="button"
                [disabled]="busy()"
                (click)="remove()"
                class="rounded-(--radius-md) px-1 py-2 text-sm font-medium text-(--text-secondary) underline underline-offset-4 hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed"
                data-testid="logo-remove"
              >
                @if (saving() === 'remove') {
                  <span i18n="@@vendor.logo.removing">Removing…</span>
                } @else {
                  <span i18n="@@vendor.logo.remove">Remove logo</span>
                }
              </button>
            } @else {
              <span></span>
            }
            <div class="flex items-center gap-3">
              <button
                brnDialogClose
                type="button"
                [disabled]="busy()"
                [class]="secondaryButtonClass"
                i18n="@@vendor.logo.cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                [disabled]="saveDisabled()"
                (click)="saveDraft()"
                [class]="primaryButtonClass"
                data-testid="logo-save"
              >
                @if (saving() === 'save') {
                  <span i18n="@@vendor.logo.saving">Saving…</span>
                } @else {
                  <span i18n="@@vendor.logo.save">Save logo</span>
                }
              </button>
            </div>
          </div>
        </div>
      </ng-template>
    </brn-dialog>
  `,
  styles: [':host { display: block; }'],
})
export class VendorLogoField {
  /** Prefix for every id this control renders. */
  readonly fieldId = input.required<string>();
  /** The saved logo, from the server. */
  readonly logoUrl = input<string | null>(null);
  readonly canEdit = input(true);
  readonly save = input.required<SaveLogo>();
  readonly announce = output<string>();

  private readonly dialog = viewChild(BrnDialog);
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private upload?: Subscription;

  /** The saved logo. Follows the input, and takes a save's echo at once so the
   *  row is right before the store's copy catches up. */
  protected readonly current = linkedSignal(() => this.logoUrl()?.trim() ?? '');
  protected readonly currentFailed = linkedSignal({
    source: this.current,
    computation: () => false,
  });

  protected readonly source = signal<'url' | 'file' | null>(null);
  protected readonly urlText = signal('');
  protected readonly uploadedPath = signal('');
  protected readonly fileName = signal('');
  protected readonly uploading = signal(false);
  protected readonly saving = signal<'save' | 'remove' | null>(null);
  protected readonly error = signal('');
  protected readonly dragging = signal(false);
  protected readonly confirmation = signal('');

  /** The one value Save would write: the URL or the upload, never both. */
  protected readonly draft = computed(() =>
    this.source() === 'url'
      ? this.urlText().trim()
      : this.source() === 'file'
        ? this.uploadedPath()
        : '',
  );
  protected readonly invalidUrl = computed(
    () =>
      this.source() === 'url' && !!this.draft() && !LogoUrlSchema.safeParse(this.draft()).success,
  );
  protected readonly previewSrc = computed(() =>
    this.invalidUrl() ? '' : this.draft() || this.current(),
  );
  protected readonly previewFailed = linkedSignal({
    source: this.previewSrc,
    computation: () => false,
  });
  protected readonly busy = computed(() => this.saving() !== null);
  protected readonly saveDisabled = computed(
    () =>
      this.busy() ||
      this.uploading() ||
      !this.draft() ||
      this.invalidUrl() ||
      this.draft() === this.current(),
  );

  protected readonly labelClass =
    'block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';
  protected readonly activeSection = 'border-(--accent-primary) bg-(--surface-base)';
  protected readonly idleSection = 'border-(--border-default) bg-(--surface-sunken)';
  protected readonly secondaryButtonClass =
    'rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-4 py-2 text-sm font-bold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';

  constructor() {
    this.destroyRef.onDestroy(() => this.upload?.unsubscribe());
  }

  /** Called from the click handler only. See the NG0602 note in the docblock. */
  protected open(): void {
    this.reset();
    this.confirmation.set('');
    this.dialog()?.open();
  }

  /** Escape, the backdrop, Cancel and the close button all discard the draft.
   *  None of them can close the dialog while a save is in flight. */
  protected onClosed(): void {
    this.reset();
  }

  protected onUrl(event: Event): void {
    this.cancelUpload();
    this.error.set('');
    this.uploadedPath.set('');
    this.fileName.set('');
    this.urlText.set((event.target as HTMLInputElement).value);
    this.source.set(this.urlText().trim() ? 'url' : null);
  }

  protected dragOver(event: DragEvent): void {
    event.preventDefault();
    if (!this.busy()) this.dragging.set(true);
  }
  protected drop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    this.select(event.dataTransfer?.files ?? null);
  }
  protected choose(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.select(input.files);
    input.value = '';
  }

  private select(files: FileList | null): void {
    if (this.busy()) return;
    const picked = pickLogoFile(files);
    if (!picked) return;
    this.cancelUpload();
    this.error.set('');
    if ('error' in picked) {
      this.error.set(picked.error);
      return;
    }
    // Choosing a file is choosing the file option: the URL box empties now, so
    // the dialog never shows two candidate logos at once.
    this.urlText.set('');
    this.uploadedPath.set('');
    this.fileName.set(picked.file.name);
    this.source.set('file');
    this.uploading.set(true);
    this.announce.emit($localize`:@@logo.uploading:Uploading logo…`);
    this.upload = uploadLogo(this.http, '/api/vendor/logo', picked.file).subscribe({
      next: (path) => {
        this.uploading.set(false);
        this.uploadedPath.set(path);
        this.announce.emit($localize`:@@vendor.logo.uploaded:Image uploaded. Save to use it.`);
      },
      error: (error: Error) => {
        this.uploading.set(false);
        this.fileName.set('');
        this.source.set(null);
        this.error.set(error.message);
      },
    });
  }

  protected saveDraft(): Promise<void> {
    if (this.saveDisabled()) return Promise.resolve();
    return this.commit(
      this.draft(),
      'save',
      $localize`:@@vendor.logo.saved:Logo saved. Your listing shows it now.`,
    );
  }

  protected remove(): Promise<void> {
    if (this.busy() || !this.current()) return Promise.resolve();
    return this.commit(
      null,
      'remove',
      $localize`:@@vendor.logo.removed:Logo removed. Your listing shows the change now.`,
    );
  }

  private async commit(
    value: string | null,
    kind: 'save' | 'remove',
    confirmation: string,
  ): Promise<void> {
    this.cancelUpload();
    this.error.set('');
    this.saving.set(kind);
    try {
      const saved = await this.save()(value);
      this.current.set(saved?.trim() ?? '');
      this.saving.set(null);
      this.confirmation.set(confirmation);
      this.announce.emit(confirmation);
      // `disableClose` reaches the open dialog through an effect, so a close
      // issued now would still be refused. Close after the render that lifts it.
      afterNextRender(() => this.dialog()?.close(), { injector: this.injector });
    } catch (err) {
      this.saving.set(null);
      this.error.set(
        apiErrorCode(err) === 'FIELD_LOCKED_BY_AECI'
          ? $localize`:@@vendor.logo.locked:AEC Integrations has locked this logo, so nothing was saved.`
          : $localize`:@@vendor.logo.saveFailed:We couldn't save the logo. Please try again.`,
      );
    }
  }

  private reset(): void {
    this.cancelUpload();
    this.source.set(null);
    this.urlText.set('');
    this.uploadedPath.set('');
    this.fileName.set('');
    this.error.set('');
    this.dragging.set(false);
  }

  private cancelUpload(): void {
    this.upload?.unsubscribe();
    this.upload = undefined;
    this.uploading.set(false);
  }
}

/** The `code` from the API's `{ error: { code } }` envelope, read structurally. */
function apiErrorCode(err: unknown): string | null {
  const inner = (err as { error?: { error?: { code?: unknown } } } | null)?.error?.error;
  return typeof inner?.code === 'string' ? inner.code : null;
}
