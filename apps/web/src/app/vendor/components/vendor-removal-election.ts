import { formatDate, isPlatformBrowser } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import type { RemovalElectionField, RemovalElectionResponse } from '@aeci/shared';

import {
  BUTTON_PRIMARY_CLASS,
  BUTTON_SECONDARY_CLASS,
} from '../../shared/form-field/form-field-classes';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

/** The field's name as the portal's own product form and plan lists say it. */
export function removalFieldLabel(field: RemovalElectionField): string {
  switch (field) {
    case 'description':
      return $localize`:@@vendor.removalElection.field.description:Description`;
    case 'usefulness':
      return $localize`:@@vendor.removalElection.field.usefulness:"How teams use it"`;
    case 'tool_integrations_url':
      return $localize`:@@vendor.removalElection.field.integrationsUrl:Integrations page URL`;
    case 'api_docs_url':
      return $localize`:@@vendor.removalElection.field.apiDocsUrl:API documentation URL`;
  }
}

/**
 * The removal election (AECI-1618, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18). For 30 days
 * after Managed ends on a product, an owner seat may blank the text it wrote. Tags,
 * catalog data and reviews stay.
 *
 * `VendorPlanPanel` mounts this in its `ended` state for an owner seat only, so a member
 * never sends the read. It reads in the browser only, because the read needs the session
 * cookie. The control shows only while the read says the window is open and a field
 * qualifies. A failed read says so and offers a retry, because hiding it would hide a
 * right the Vendor Terms promise.
 *
 * The dialog opens from the click handler, never from an effect (NG0602). A failed write
 * stays in the dialog with its reason, like the logo dialog. A `409` means the read was
 * stale, so the read runs again when the dialog closes.
 *
 * Mobbin anchor: Base44's "Delete your account" modal (screen
 * 6abe261c-e5ce-4cad-933f-a80daae66e7a), for the "What will be deleted" list. The shell is
 * the portal's own BrnDialog. No status colour, as on the rest of the plan panel.
 */
@Component({
  selector: 'aec-vendor-removal-election',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BrnDialog, BrnDialogClose, BrnDialogContent, BrnDialogDescription, BrnDialogTitle],
  template: `
    @if (loadFailed()) {
      <div class="mt-5 border-t border-(--border-default) pt-4" data-testid="removal-load-failed">
        <p
          class="text-sm text-(--text-primary)"
          role="alert"
          i18n="@@vendor.removalElection.loadFailed"
        >
          We could not check whether you can remove this product's text.
        </p>
        <button
          type="button"
          [class]="retryClass"
          (click)="load()"
          i18n="@@vendor.removalElection.retry"
        >
          Try again
        </button>
      </div>
    }

    @if (electedLine(); as line) {
      <p
        #electedLineEl
        tabindex="-1"
        class="mt-5 max-w-prose text-sm text-(--text-primary) outline-none"
        data-testid="removal-elected"
      >
        {{ line }}
      </p>
    }

    @if (windowOpen()) {
      <div class="mt-5 border-t border-(--border-default) pt-4" data-testid="removal-election">
        <h3 class="aec-overline text-(--text-secondary)" i18n="@@vendor.removalElection.heading">
          Remove the text you wrote
        </h3>
        <p class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)">
          {{ windowLine() }}
        </p>
        <button
          type="button"
          [class]="triggerClass"
          aria-haspopup="dialog"
          data-testid="removal-open"
          (click)="openDialog()"
          i18n="@@vendor.removalElection.open"
        >
          Remove my text
        </button>
      </div>
    }

    <brn-dialog [disableClose]="busy()" (closed)="onClosed()">
      <ng-template brnDialogContent>
        <div
          class="max-h-[85vh] w-[min(92vw,34rem)] overflow-y-auto rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-6 text-(--text-primary) md:p-8"
          data-testid="removal-dialog"
        >
          <div class="flex items-start justify-between gap-4">
            <h2
              brnDialogTitle
              class="font-display text-xl font-semibold text-(--text-primary)"
              i18n="@@vendor.removalElection.dialog.heading"
            >
              Remove the text you wrote?
            </h2>
            <button
              brnDialogClose
              type="button"
              [disabled]="busy()"
              class="-me-1 -mt-1 shrink-0 rounded-(--radius-sm) p-1 text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n-aria-label="@@vendor.removalElection.dialog.close"
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
            i18n="@@vendor.removalElection.dialog.undo"
          >
            This cannot be undone. These fields go blank in your portal and on the public page.
          </p>

          <h3
            class="aec-overline mt-5 text-(--text-secondary)"
            i18n="@@vendor.removalElection.dialog.listHeading"
          >
            What will be removed
          </h3>
          <ul
            class="mt-2 list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-(--text-primary)"
            data-testid="removal-fields"
          >
            @for (name of fieldNames(); track name) {
              <li>{{ name }}</li>
            }
          </ul>

          <p class="mt-5 text-sm leading-relaxed text-(--text-secondary)">{{ closesLine() }}</p>
          <p
            class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.removalElection.dialog.stays"
          >
            Catalog data and reviews stay. So do this product's tags and its listing.
          </p>

          @if (error(); as message) {
            <p class="mt-4 text-sm font-medium text-(--text-primary)" role="alert">{{ message }}</p>
          }

          <div class="mt-6 flex flex-wrap justify-end gap-3">
            <button
              brnDialogClose
              type="button"
              [disabled]="busy()"
              [class]="cancelClass"
              i18n="@@vendor.removalElection.dialog.cancel"
            >
              Keep my text
            </button>
            <button
              type="button"
              [disabled]="busy()"
              [class]="confirmClass"
              data-testid="removal-confirm"
              (click)="confirm()"
            >
              @if (busy()) {
                <span i18n="@@vendor.removalElection.dialog.pending">Removing…</span>
              } @else {
                <span i18n="@@vendor.removalElection.dialog.confirm">Remove my text</span>
              }
            </button>
          </div>
        </div>
      </ng-template>
    </brn-dialog>
  `,
  styles: [':host { display: block; }'],
})
export class VendorRemovalElection {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly dialog = viewChild(BrnDialog);
  private readonly electedLineEl = viewChild<ElementRef<HTMLElement>>('electedLineEl');

  /** The owned product. The API refuses a member, and the host never mounts this for one. */
  readonly productId = input.required<string>();

  protected readonly election = signal<RemovalElectionResponse | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  /** A `409` means our read went stale. Re-read on close, so the dialog does not change
   *  under the reader. */
  private reloadOnClose = false;
  private focusElectedOnClose = false;

  protected readonly windowOpen = computed(() => {
    const e = this.election();
    return !!e && e.closes_at !== null && e.eligible_fields.length > 0;
  });

  protected readonly fieldNames = computed(() =>
    (this.election()?.eligible_fields ?? []).map(removalFieldLabel),
  );

  protected readonly windowLine = computed(() => {
    const date = this.format(this.election()?.closes_at);
    return $localize`:@@vendor.removalElection.window:You can remove the text you wrote on this product until ${date}:DATE:. Catalog data and reviews stay.`;
  });

  protected readonly closesLine = computed(() => {
    const date = this.format(this.election()?.closes_at);
    return $localize`:@@vendor.removalElection.dialog.closes:You can do this until ${date}:DATE:. After that the option closes.`;
  });

  protected readonly electedLine = computed(() => {
    const at = this.election()?.elected_at;
    if (!at) return null;
    const date = this.format(at);
    return $localize`:@@vendor.removalElection.elected:You removed your text on ${date}:DATE:.`;
  });

  protected readonly retryClass =
    'mt-3 inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-3 py-1.5 text-sm font-semibold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly triggerClass =
    'mt-3 inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-4 py-2 text-sm font-semibold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly cancelClass = `${BUTTON_SECONDARY_CLASS} disabled:cursor-not-allowed disabled:opacity-50`;
  protected readonly confirmClass = BUTTON_PRIMARY_CLASS;

  constructor() {
    // Moving between products reuses this component through the host's route, so the id
    // is tracked rather than read once. Browser only: the read needs the session cookie.
    effect(() => {
      const id = this.productId();
      if (!this.browser) return;
      untracked(() => {
        this.election.set(null);
        void this.load(id);
      });
    });
  }

  /** "Try again" passes no id, and reads the current product. */
  protected async load(id: string = this.productId()): Promise<void> {
    this.loadFailed.set(false);
    try {
      const election = await this.api.getRemovalElection(id);
      if (id === this.productId()) this.election.set(election);
    } catch {
      if (id === this.productId()) this.loadFailed.set(true);
    }
  }

  /** Called from the click handler only. `BrnDialog.open()` throws NG0602 in an effect. */
  protected openDialog(): void {
    this.error.set('');
    this.dialog()?.open();
  }

  protected onClosed(): void {
    this.error.set('');
    if (this.reloadOnClose) {
      this.reloadOnClose = false;
      void this.load();
    }
    if (this.focusElectedOnClose) {
      // The trigger left with the window, so the CDK has nothing to hand focus back to.
      this.focusElectedOnClose = false;
      afterNextRender(() => this.electedLineEl()?.nativeElement.focus(), {
        injector: this.injector,
      });
    }
  }

  protected async confirm(): Promise<void> {
    if (this.busy()) return;
    const id = this.productId();
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.api.createRemovalElection(id);
      this.focusElectedOnClose = true;
      this.election.update((e) => ({
        closes_at: e?.closes_at ?? null,
        eligible_fields: [],
        elected_at: result.elected_at,
      }));
      this.busy.set(false);
      this.dialog()?.close();
      void this.store.revalidate(['products']);
    } catch (err) {
      this.error.set(this.messageFor(err));
      if (err instanceof HttpErrorResponse && err.status === 409) this.reloadOnClose = true;
    } finally {
      this.busy.set(false);
    }
  }

  /** Formatted in UTC: the window is counted in UTC days, and the API closes it at the end
   *  of the last one. */
  private format(raw: string | null | undefined): string {
    return raw ? formatDate(raw, 'MMMM d, y', this.locale, 'UTC') : '';
  }

  private messageFor(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
      const code = (err.error as { error?: { code?: unknown } } | null)?.error?.code;
      if (code === 'REMOVAL_ELECTION_CLOSED') {
        return $localize`:@@vendor.removalElection.error.closed:The time to remove this text has ended, so nothing was removed.`;
      }
      if (code === 'REMOVAL_ELECTION_EMPTY') {
        return $localize`:@@vendor.removalElection.error.empty:None of this product's text can be removed now, so nothing changed.`;
      }
      if (err.status === 403) {
        return $localize`:@@vendor.removalElection.error.forbidden:Only an owner seat can remove this text.`;
      }
      if (err.status === 404) {
        return $localize`:@@vendor.removalElection.error.notFound:We could not find this product. Reload the page.`;
      }
    }
    return $localize`:@@vendor.removalElection.error.failed:We could not remove your text. Please try again.`;
  }
}
