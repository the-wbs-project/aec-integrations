import { NgOptimizedImage } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
} from '@angular/core';
import {
  LOGO_MAX_BYTES,
  LogoPathSchema,
  LogoUrlSchema,
  UploadLogoResponseSchema,
} from '@aeci/shared';
import type { Subscription } from 'rxjs';

/**
 * `LogoInput` (AECI-955) — the Logo URL field plus validated upload, shared by
 * the vendor profile/product forms and the admin console.
 *
 * ── THE URL TEXT STAYS READABLE IN EVERY STATE (AECI-982) ───────────────────
 * The 2026-09-16 UX review caught the disabled URL dimming to half opacity,
 * which took #0A0A0A over white down to ~3.7:1 — below the AA 4.5:1 floor —
 * and axe cannot see it: axe exempts disabled controls from color-contrast.
 * Disabled now uses the DESIGN.md Inputs/Fields disabled recipe (sunken
 * surface, text-secondary, 7.0:1) instead of an opacity dim; the rule bans
 * opacity as a disabled/read-only treatment for field text, because opacity
 * composites against whatever is behind the element and no token review can
 * pin its ratio. The browser-autofill state is pinned the same way by the
 * `:-webkit-autofill` guard in `styles.css`, which repaints the UA's autofill
 * background with `--surface-base` so the token text keeps its measured ratio.
 */
@Component({
  selector: 'aec-logo-input',
  imports: [NgOptimizedImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-3">
      @if (uploaded() && !readOnly()) {
        <div class="flex items-center gap-4">
          @if (!previewFailed()) {
            <img
              [ngSrc]="value()"
              width="64"
              height="64"
              alt="Logo preview"
              i18n-alt="@@logo.preview"
              (error)="previewFailed.set(true)"
              class="size-16 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) object-contain p-1"
            />
          } @else {
            <p class="text-xs text-(--text-secondary)" i18n="@@logo.uploadedPreviewFailed">
              Uploaded image preview unavailable.
            </p>
          }
          <p class="text-sm font-bold text-(--text-primary)" i18n="@@logo.uploadedImage">
            Uploaded image
          </p>
        </div>
      } @else {
        <label [for]="inputId()" class="block text-sm font-bold text-(--text-primary)">
          @if (uploaded()) {
            <span i18n="@@logo.uploadedReference">Uploaded image reference</span>
          } @else {
            <span i18n="@@logo.label">Logo URL</span>
          }
        </label>
        <input
          [id]="inputId()"
          type="text"
          inputmode="url"
          autocomplete="off"
          [value]="value()"
          [readOnly]="readOnly()"
          [disabled]="disabled()"
          (input)="changeUrl($event)"
          [attr.aria-describedby]="
            invalidUrl() ? inputId() + '-help ' + inputId() + '-error' : inputId() + '-help'
          "
          [attr.aria-invalid]="invalidUrl() ? 'true' : null"
          class="w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)"
        />
        <p [id]="inputId() + '-help'" class="text-xs leading-relaxed text-(--text-secondary)">
          @if (uploaded()) {
            <span i18n="@@logo.uploadedReferenceHelp">
              This stored reference is read-only and can be copied.
            </span>
          } @else {
            <span i18n="@@logo.help">
              Paste an HTTPS image URL or upload a PNG, JPEG or static WebP. Maximum 2 MiB and 2048
              pixels per side. Uploaded logos are public.
            </span>
          }
        </p>
        @if (!readOnly()) {
          <div
            (dragover)="dragOver($event)"
            (dragleave)="dragging.set(false)"
            (drop)="drop($event)"
            [class.border-(--accent-primary)]="dragging()"
            class="rounded-(--radius-md) border border-dashed border-(--border-strong) bg-(--surface-sunken) p-4"
          >
            <label
              [for]="inputId() + '-file'"
              class="mb-2 block text-sm font-medium text-(--text-primary)"
              i18n="@@logo.drop"
              >Drop an image here or choose a file</label
            >
            <input
              [id]="inputId() + '-file'"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              [disabled]="disabled()"
              (change)="choose($event)"
              class="block w-full text-sm text-(--text-secondary) file:me-3 file:rounded-(--radius-md) file:border file:border-(--border-default) file:bg-(--surface-base) file:px-3 file:py-2 file:font-medium file:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
          </div>
        }
        @if (preview(); as src) {
          <div class="flex items-center gap-4">
            @if (!previewFailed()) {
              <img
                [ngSrc]="src"
                width="64"
                height="64"
                alt="Logo preview"
                i18n-alt="@@logo.preview"
                (error)="previewFailed.set(true)"
                class="size-16 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) object-contain p-1"
              />
            } @else if (uploaded()) {
              <p class="text-xs text-(--text-secondary)" i18n="@@logo.uploadedPreviewFailed">
                Uploaded image preview unavailable.
              </p>
            } @else {
              <p class="text-xs text-(--text-secondary)" i18n="@@logo.previewFailed">
                Preview unavailable. Check that the URL points to an image.
              </p>
            }
          </div>
        }
      }
      @if (!readOnly() && (value() || pending())) {
        <button
          type="button"
          [disabled]="disabled()"
          (click)="setValue('')"
          class="rounded-(--radius-md) px-1 py-2 text-sm font-medium text-(--text-secondary) underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          i18n="@@logo.remove"
        >
          Remove logo
        </button>
      }
      @if (status()) {
        <p class="text-xs text-(--text-secondary)">{{ status() }}</p>
      }
      @if (error()) {
        <p role="alert" class="text-sm font-medium text-(--text-primary)">{{ error() }}</p>
      }
      @if (invalidUrl()) {
        <p
          [id]="inputId() + '-error'"
          role="alert"
          class="text-xs text-(--text-primary)"
          i18n="@@logo.invalidUrl"
        >
          Enter an HTTPS image URL or upload a file.
        </p>
      }
    </div>
  `,
})
export class LogoInput {
  readonly inputId = input.required<string>();
  readonly value = model('');
  readonly readOnly = input(false);
  readonly disabled = input(false);
  readonly uploadEndpoint = input<'/api/vendor/logo' | '/api/admin/logo'>('/api/vendor/logo');
  readonly pendingChange = output<boolean>();
  readonly announce = output<string>();
  protected readonly pending = signal(false);
  protected readonly dragging = signal(false);
  protected readonly previewFailed = signal(false);
  protected readonly error = signal('');
  protected readonly status = signal('');
  protected readonly uploaded = computed(
    () => LogoPathSchema.safeParse(this.value().trim()).success,
  );
  protected readonly invalidUrl = computed(
    () => !!this.value().trim() && !LogoUrlSchema.safeParse(this.value().trim()).success,
  );
  protected readonly preview = computed(() =>
    this.invalidUrl() ? null : this.value().trim() || null,
  );
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private upload?: Subscription;

  constructor() {
    effect(() => {
      this.value();
      this.readOnly();
      this.disabled();
      this.inputId();
      this.uploadEndpoint();
      this.cancel();
      this.previewFailed.set(false);
    });
    this.destroyRef.onDestroy(() => this.upload?.unsubscribe());
  }

  private cancel(): void {
    this.upload?.unsubscribe();
    this.upload = undefined;
    this.pending.set(false);
    this.pendingChange.emit(false);
  }

  protected changeUrl(event: Event): void {
    this.setValue((event.target as HTMLInputElement).value);
  }
  protected setValue(value: string): void {
    if (this.readOnly() || this.disabled()) return;
    this.cancel();
    this.error.set('');
    this.status.set('');
    this.previewFailed.set(false);
    this.value.set(value);
  }
  protected dragOver(event: DragEvent): void {
    event.preventDefault();
    if (!this.readOnly() && !this.disabled()) this.dragging.set(true);
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
    if (this.readOnly() || this.disabled() || !files?.length) return;
    this.cancel();
    this.error.set('');
    this.status.set('');
    const file = files.item(0);
    if (files.length !== 1 || !file) {
      this.error.set($localize`:@@logo.oneFile:Choose one image at a time.`);
      return;
    }
    if (!file.size || file.size > LOGO_MAX_BYTES) {
      this.error.set($localize`:@@logo.size:Choose an image no larger than 2 MiB.`);
      return;
    }
    const body = new FormData();
    body.append('file', file);
    this.pending.set(true);
    this.pendingChange.emit(true);
    this.status.set($localize`:@@logo.uploading:Uploading logo…`);
    this.announce.emit(this.status());
    this.upload = this.http.post<unknown>(this.uploadEndpoint(), body).subscribe({
      next: (response) => {
        const result = UploadLogoResponseSchema.safeParse(response);
        this.pending.set(false);
        this.pendingChange.emit(false);
        if (!result.success) {
          this.error.set($localize`:@@logo.invalidResponse:Upload failed. Please try again.`);
          this.status.set('');
          return;
        }
        this.value.set(result.data.logo_url);
        this.status.set(
          $localize`:@@logo.uploaded:Logo uploaded. Save your changes to publish it.`,
        );
        this.announce.emit(this.status());
      },
      error: (error: unknown) => {
        this.pending.set(false);
        this.pendingChange.emit(false);
        this.status.set('');
        this.error.set(
          error instanceof HttpErrorResponse && error.status === 429
            ? $localize`:@@logo.rateLimited:Too many uploads. Wait a moment and try again.`
            : $localize`:@@logo.uploadFailed:We couldn't upload this image. Check the format, size and dimensions, then try again.`,
        );
      },
    });
  }
}
