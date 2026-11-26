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
import { LogoPathSchema, LogoUrlSchema } from '@aeci/shared';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';
import type { Subscription } from 'rxjs';

import { pickLogoFile, uploadLogo } from '../../shared/logo-input/logo-upload';
import { AecButton } from '../../shared/button/button';
import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';

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
    AecButton,
    AecIcon,
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
      <!-- AECI-1810: the Label role, as every other field label. It read "LOGO" in
           capitals through CSS; the text was always "Logo". -->
      <span [id]="fieldId() + '-label'" [class]="labelClass" i18n="@@vendor.logo.label">Logo</span>
      <div class="flex flex-wrap items-center gap-4">
        <div
          class="flex size-16 shrink-0 items-center justify-center rounded-mark border border-(--border-default) bg-(--surface-base) p-1"
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
            aecButton
            variant="secondary"
            type="button"
            (click)="open()"
            [attr.aria-describedby]="fieldId() + '-label'"
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
        <!-- AECI-1810: plain text. The same sentence goes to the portal's one live
             region through (announce), which every host wires to the announcer. -->
        <p class="text-t-14 font-semibold text-(--accent-primary)">
          {{ confirmation() }}
        </p>
      }
    </div>

    <brn-dialog
      [role]="'alertdialog'"
      [autoFocus]="'first-heading'"
      [disableClose]="busy()"
      (closed)="onClosed()"
    >
      <ng-template brnDialogContent>
        <div
          class="max-h-[85vh] w-[min(92vw,34rem)] overflow-y-auto rounded-card border border-(--border-default) bg-(--surface-base) p-6 text-(--text-primary) shadow-card md:p-8"
        >
          <div class="flex items-start justify-between gap-4">
            <h2
              brnDialogTitle
              tabindex="-1"
              class="focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
              i18n="@@vendor.logo.dialog.heading"
            >
              Change logo
            </h2>
            <button
              aecButton
              variant="ghost"
              iconOnly
              brnDialogClose
              type="button"
              [disabled]="busy()"
              class="-me-3 -mt-2 shrink-0"
              i18n-aria-label="@@vendor.logo.dialog.close"
              aria-label="Close"
            >
              <aec-icon name="x" decorative />
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
              class="flex size-20 shrink-0 items-center justify-center rounded-mark border border-(--border-default) bg-(--surface-base) p-1"
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
              <p class="font-semibold text-(--text-primary)">
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
                } @else if (currentKind() === 'upload') {
                  <span i18n="@@vendor.logo.dialog.currentUploaded"
                    >Uploaded file. Paste a URL or upload a file to replace it.</span
                  >
                } @else if (currentKind() === 'url') {
                  <span i18n="@@vendor.logo.dialog.currentLinked"
                    >Linked from this URL. Paste a URL or upload a file to replace it.</span
                  >
                } @else {
                  <span i18n="@@vendor.logo.dialog.pickOne">Paste a URL or upload a file.</span>
                }
              </p>
            </div>
          </div>
          @if (currentKind() === 'url' && !draft()) {
            <div class="mt-3 flex items-center gap-2" data-testid="logo-current-url">
              <input
                type="text"
                readonly
                [value]="current()"
                i18n-aria-label="@@vendor.logo.dialog.currentUrlLabel"
                aria-label="Current logo URL"
                (focus)="selectAll($event)"
                [class]="currentUrlClass"
              />
              <button
                aecButton
                variant="secondary"
                compact
                type="button"
                (click)="copyCurrent()"
                data-testid="logo-copy-url"
              >
                @if (copied()) {
                  <span i18n="@@vendor.logo.dialog.copied">Copied</span>
                } @else {
                  <span i18n="@@vendor.logo.dialog.copy">Copy URL</span>
                }
              </button>
              <p class="sr-only" role="status" data-testid="logo-copy-status">
                @if (copied()) {
                  <span i18n="@@vendor.logo.copiedAnnounce">Logo URL copied.</span>
                }
              </p>
            </div>
          }

          <section
            class="mt-6 rounded-panel border p-4"
            [class]="source() === 'url' ? activeSection : idleSection"
            [attr.aria-labelledby]="fieldId() + '-url-heading'"
          >
            <h3 [id]="fieldId() + '-url-heading'" i18n="@@vendor.logo.dialog.urlHeading">
              Paste an image URL
            </h3>
            <label
              [for]="fieldId() + '-url'"
              [class]="'mt-1 block ' + hintClass"
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
              [class]="'mt-2 ' + inputClass"
            />
            @if (invalidUrl()) {
              <p
                [id]="fieldId() + '-url-error'"
                [class]="'mt-2 ' + errorClass"
                i18n="@@vendor.logo.dialog.urlInvalid"
              >
                Enter a URL that starts with https://
              </p>
            }
          </section>

          <div class="my-3 flex items-center gap-3" aria-hidden="true">
            <span class="h-px flex-1 bg-(--border-default)"></span>
            <span class="aec-overline text-(--text-secondary)" i18n="@@vendor.logo.dialog.or"
              >or</span
            >
            <span class="h-px flex-1 bg-(--border-default)"></span>
          </div>

          <section
            class="rounded-panel border p-4"
            [class]="source() === 'file' ? activeSection : idleSection"
            [attr.aria-labelledby]="fieldId() + '-file-heading'"
            (dragover)="dragOver($event)"
            (dragleave)="dragging.set(false)"
            (drop)="drop($event)"
            [class.border-dashed]="dragging()"
          >
            <h3 [id]="fieldId() + '-file-heading'" i18n="@@vendor.logo.dialog.fileHeading">
              Upload a file
            </h3>
            <label
              [for]="fieldId() + '-file'"
              [class]="'mt-1 block ' + hintClass"
              i18n="@@vendor.logo.dialog.fileHelp"
              >Choose an image from your computer, or drop it here.</label
            >
            <input
              [id]="fieldId() + '-file'"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              [disabled]="busy()"
              (change)="choose($event)"
              class="mt-2 block w-full text-sm text-(--text-secondary) file:me-3 file:min-h-11 file:cursor-pointer file:rounded-control file:border file:border-(--border-strong) file:bg-(--surface-base) file:px-4 file:py-2 file:font-semibold file:text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
            />
            @if (uploading()) {
              <p class="mt-2 text-xs text-(--text-secondary)" role="status" i18n="@@logo.uploading">
                Uploading logo…
              </p>
            }
          </section>

          @if (error()) {
            <p role="alert" class="mt-4 text-sm font-semibold text-(--text-primary)">
              {{ error() }}
            </p>
          }

          <div class="mt-6 flex flex-wrap items-center justify-between gap-3">
            @if (current()) {
              <button
                aecButton
                variant="ghost"
                type="button"
                [disabled]="busy()"
                (click)="remove()"
                class="-ms-4"
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
            <div class="flex flex-wrap items-center gap-3">
              <button
                aecButton
                variant="secondary"
                brnDialogClose
                type="button"
                [disabled]="busy()"
                i18n="@@vendor.logo.cancel"
              >
                Cancel
              </button>
              <button
                aecButton
                type="button"
                [disabled]="saveDisabled()"
                (click)="saveDraft()"
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
  /** A field's inline error: the shared recipe (AECI-1984). */
  protected readonly errorClass = FIELD_ERROR_CLASS;
  /** Prefix for every id this control renders. */
  readonly fieldId = input.required<string>();
  /** The saved logo, from the server. */
  readonly logoUrl = input<string | null>(null);
  readonly canEdit = input(true);
  readonly save = input.required<SaveLogo>();
  /** What Save and Remove confirm. A form that holds the logo until its own
   *  submit (the product create, AECI-1424) says so instead of "saved". */
  readonly savedMessage = input<string | null>(null);
  readonly removedMessage = input<string | null>(null);
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

  /** Where the saved logo came from: one of our uploads (`/api/logos/<hash>`,
   *  an opaque path not worth showing) or an external HTTPS link, which the
   *  dialog shows with a Copy button. */
  protected readonly currentKind = computed<'upload' | 'url' | null>(() => {
    const value = this.current();
    if (!value) return null;
    return LogoPathSchema.safeParse(value).success ? 'upload' : 'url';
  });
  protected readonly copied = signal(false);

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

  /** AECI-1810: the Label role (13px, 600, sentence case), as every field label. */
  protected readonly labelClass = FIELD_LABEL_CLASS;
  /** The help sentence that names each of the dialog's two inputs. */
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  /** The linked logo's URL: the field recipe, read-only on the sunken surface. */
  protected readonly currentUrlClass = `${FIELD_INPUT_CLASS} min-w-0 flex-1 truncate read-only:bg-(--surface-sunken)`;
  protected readonly activeSection = 'border-(--accent-primary) bg-(--surface-base)';
  protected readonly idleSection = 'border-(--border-default) bg-(--surface-sunken)';

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

  protected selectAll(event: Event): void {
    (event.target as HTMLInputElement).select();
  }

  /** Copy the linked logo's URL. The button label confirms it, and so does the
   *  dialog's own status region: the portal announcer sits behind the modal,
   *  which the CDK hides from screen readers while the dialog is open. */
  protected async copyCurrent(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      this.error.set(
        $localize`:@@vendor.logo.copyUnavailable:This browser will not let us copy. Select the URL and copy it by hand.`,
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(this.current());
      this.error.set('');
      this.copied.set(true);
    } catch {
      this.error.set(
        $localize`:@@vendor.logo.copyFailed:We could not copy the URL. Select it and copy it by hand.`,
      );
    }
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
      this.savedMessage() ?? $localize`:@@vendor.logo.saved:Logo saved. Your listing shows it now.`,
    );
  }

  protected remove(): Promise<void> {
    if (this.busy() || !this.current()) return Promise.resolve();
    return this.commit(
      null,
      'remove',
      this.removedMessage() ??
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
    this.copied.set(false);
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
