import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';

import type { TermsPending } from '@aeci/shared';

import { AccountApi } from '../account/account-api';
import {
  BUTTON_PRIMARY_CLASS,
  CHOICE_CARD_CLASS,
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
} from '../shared/form-field/form-field-classes';
import { safeReturnPath } from './return-path';

/** A Terms version as `/auth/callback` writes it: dotted digits only. */
const VERSION_RE = /^\d{1,4}(?:\.\d{1,4}){0,3}$/;

/** The `?version=` value, or `null` when it is missing or malformed. */
export function termsAcceptVersion(raw: string | null): string | null {
  return raw && VERSION_RE.test(raw) ? raw : null;
}

/**
 * Where `/auth/terms` sends the reader afterwards: the `?next=` path, narrowed to a
 * same-origin path. A `next` that points back at `/auth/terms` collapses to `/`, so the
 * page can never loop on itself.
 */
export function termsAcceptNextPath(raw: string | null): string {
  const path = safeReturnPath(raw);
  return /^\/auth\/terms(?:[/?#]|$)/.test(path) ? '/' : path;
}

/** The text links' recipe, as on the login page's Terms line. */
const LINK_CLASS =
  'font-semibold text-(--text-primary) underline underline-offset-2 hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/**
 * `/auth/terms` (AECI-1637, counsel Q3 and Q63, ruling 53; `STAGE_1_SPEC.md` §27.4,
 * `AUTH_AND_RLS.md` §3.1b): the one tick box. `/auth/callback` sends a reader here only at
 * the first sign-in after a Terms version that reduces their rights, with
 * `?version=<v>&next=<path>`. Every other sign-in never sees it.
 *
 * Layout follows `/auth/login`, the screen before it: the centred mark and heading, the
 * same width. Anchor reference: Kraken "Accept terms" on Mobbin (a full page that says what
 * changes, one unticked box, Continue, and a visible way out).
 *
 * After hydration it reads `GET /api/auth/terms/pending` and shows what the reader accepts:
 * the version, its date, the published summary of its changes (the same bullets the
 * change email carried), and links to that version and to the version that applies until
 * then. Nothing pending (another tab ticked) goes straight to `next`. A failed read keeps
 * the page usable without the summary.
 *
 * The box starts unticked, and its label is `TERMS_CHANGE_BOX_LABEL` word for word
 * (`terms-accept.component.spec.ts` pins it). "Accept and continue" stays disabled until
 * hydration, as on the login form, so an early click cannot submit the form natively and
 * lose the version and `next`. After that it is never disabled except while sending.
 * Without the tick it shows the error, marks the box invalid and moves focus to it, and
 * nothing is sent. With the tick it posts `POST /api/auth/terms/accept` and goes to `next`.
 * A `422` means the version no longer waits for this reader, so it goes to `next` too. A
 * `401` goes back to sign-in with `next` as the return, so a destination such as a seat
 * invitation survives; that sign-in asks for the box again if it still waits.
 *
 * "Not now" (ruling of 2026-11-19, legal agent 2026-11-20): leaving is allowed, so the way
 * out is visible. It goes to `next` and posts nothing. The earlier version keeps applying,
 * and the next sign-in asks again. Ticking the box is the only way to accept. The analytics
 * consent banner is held off this page (`ConsentBanner`), so it has one "Accept".
 *
 * Auth and caching: the SSR Worker bounces a signed-out visitor to login
 * (`isTermsAcceptPath`), and `/auth/*` is `no-store`. SSR paints the header and the form
 * from the query string; the summary loads in the browser.
 */
@Component({
  selector: 'aec-terms-accept-page',
  imports: [DatePipe],
  template: `
    <section
      class="mx-auto w-full max-w-sm px-6 py-16 text-(--text-primary) md:py-24"
      aria-labelledby="terms-accept-title"
    >
      <!-- The login page's centred header, so the two screens of one flow match. The mark
           is decorative: the heading names the page. -->
      <div class="text-center">
        <span
          class="mx-auto inline-flex size-12 items-center justify-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) shadow-sm"
          aria-hidden="true"
        >
          <svg viewBox="0 0 64 64" class="size-9" xmlns="http://www.w3.org/2000/svg">
            <path
              transform="translate(23.33 50)"
              fill="var(--accent-secondary)"
              d="M2.21 0.00 6.31 -19.30H2.62L3.61 -23.81H13.17L8.08 0.00ZM11.40 -28.00Q9.87 -28.00 8.77 -29.10Q7.67 -30.20 7.67 -31.72Q7.67 -33.30 8.77 -34.38Q9.87 -35.46 11.39 -35.46Q12.97 -35.46 14.05 -34.38Q15.13 -33.29 15.13 -31.73Q15.13 -30.20 14.05 -29.10Q12.96 -28.00 11.40 -28.00Z"
            />
          </svg>
        </span>
        <h1
          id="terms-accept-title"
          class="mt-6 font-display text-2xl font-semibold tracking-tight text-balance"
          i18n="@@auth.terms.title"
        >
          We've updated our Terms of Service
        </h1>
      </div>

      @if (version(); as v) {
        <p
          class="mt-3 text-center text-sm leading-relaxed text-(--text-secondary)"
          i18n="@@auth.terms.body"
        >
          Version {{ v }} reduces some of your rights. It applies to your account only once you
          accept it.
        </p>

        @if (pending(); as p) {
          <div class="mt-8 space-y-3 text-sm leading-relaxed" data-testid="terms-accept-changes">
            <h2 class="text-balance" i18n="@@auth.terms.changesHeading">
              What changes on {{ p.effective_at | date: 'longDate' : 'UTC' }}
            </h2>
            @if (p.summary.length > 0) {
              <ul class="list-disc space-y-1.5 ps-5 text-(--text-secondary)">
                @for (item of p.summary; track $index) {
                  <li>{{ item }}</li>
                }
              </ul>
            }
          </div>
        }

        <ul class="mt-6 space-y-2 text-sm">
          <li>
            <a
              [href]="'/legal/terms/v' + v"
              target="_blank"
              rel="noopener"
              data-testid="terms-accept-read"
              [class]="linkClass"
              ><span i18n="@@auth.terms.readLink">Read version {{ v }} of the Terms of Service</span
              ><span class="sr-only" i18n="@@auth.terms.newTab"> (opens in a new tab)</span></a
            >
          </li>
          @if (pending()?.previous_version; as prev) {
            <li>
              <a
                [href]="'/legal/terms/v' + prev"
                target="_blank"
                rel="noopener"
                data-testid="terms-accept-read-previous"
                [class]="linkClass"
                ><span i18n="@@auth.terms.readPreviousLink"
                  >Read version {{ prev }}, the one that applies to you now</span
                ><span class="sr-only" i18n="@@auth.terms.newTabPrevious">
                  (opens in a new tab)</span
                ></a
              >
            </li>
          }
        </ul>

        <form class="mt-8 space-y-4" novalidate (submit)="onSubmit($event)">
          <div class="space-y-1.5">
            <label [class]="choiceCardClass" for="terms-accept-box">
              <input
                #box
                id="terms-accept-box"
                type="checkbox"
                data-testid="terms-accept-box"
                [checked]="ticked()"
                (change)="onTick($event)"
                [attr.aria-invalid]="showError() ? 'true' : null"
                [attr.aria-describedby]="showError() ? 'terms-accept-error' : null"
                [class]="choiceInputClass"
              />
              <span data-testid="terms-accept-label" i18n="@@auth.terms.boxLabel"
                >I have read and accept the updated Terms of Service.</span
              >
            </label>
            @if (showError()) {
              <p
                id="terms-accept-error"
                [class]="errorClass"
                role="alert"
                i18n="@@auth.terms.boxError"
              >
                Tick the box to accept the updated Terms and continue.
              </p>
            }
          </div>

          @if (failed()) {
            <p
              class="text-sm font-medium text-(--text-primary)"
              role="alert"
              i18n="@@auth.terms.failed"
            >
              Something went wrong. Please try again.
            </p>
          }

          <!-- Disabled until hydration, as the login form: an earlier click would submit
               the form natively and drop the version and next (no input has a name). -->
          <button
            type="submit"
            [disabled]="!hydrated() || saving()"
            data-testid="terms-accept-continue"
            [class]="primaryClass + ' w-full'"
          >
            @if (saving()) {
              <span i18n="@@auth.terms.saving">Saving…</span>
            } @else {
              <span i18n="@@auth.terms.continue">Accept and continue</span>
            }
          </button>
        </form>

        <!-- The visible way out (ruling of 2026-11-19): nothing is posted. -->
        <div class="mt-6 text-center text-sm">
          <button
            type="button"
            (click)="notNow()"
            [disabled]="!hydrated() || saving()"
            data-testid="terms-accept-not-now"
            [class]="linkClass + ' disabled:cursor-not-allowed'"
            i18n="@@auth.terms.notNow"
          >
            Not now
          </button>
          <p class="mt-2 text-(--text-secondary)" i18n="@@auth.terms.notNowNote">
            You stay on the version you have now, and we'll ask again the next time you sign in.
          </p>
        </div>
      } @else {
        <p
          class="mt-3 text-center text-sm leading-relaxed text-(--text-secondary)"
          role="status"
          i18n="@@auth.terms.nothing"
        >
          One moment.
        </p>
      }
    </section>
  `,
})
export class TermsAcceptPage {
  private readonly api = inject(AccountApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  private readonly box = viewChild<ElementRef<HTMLInputElement>>('box');

  /** The version to accept: the query's, replaced by the server's once read. */
  protected readonly version = signal(
    termsAcceptVersion(this.route.snapshot.queryParamMap.get('version')),
  );
  protected readonly next = termsAcceptNextPath(this.route.snapshot.queryParamMap.get('next'));

  protected readonly choiceCardClass = CHOICE_CARD_CLASS;
  protected readonly choiceInputClass = CHOICE_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly primaryClass = BUTTON_PRIMARY_CLASS;
  protected readonly linkClass = LINK_CLASS;

  /** False until the browser has hydrated. Continue stays disabled until then. */
  protected readonly hydrated = signal(false);
  /** What the server says waits: the date, summary and earlier version. */
  protected readonly pending = signal<TermsPending | null>(null);
  /** The box starts unticked (ruling 53). */
  protected readonly ticked = signal(false);
  protected readonly attempted = signal(false);
  protected readonly saving = signal(false);
  protected readonly failed = signal(false);
  protected readonly showError = computed(() => this.attempted() && !this.ticked());

  constructor() {
    this.titleSvc.setTitle(
      $localize`:@@auth.terms.metaTitle:Updated Terms of Service · AEC Integrations`,
    );
    // User-specific utility page. Never indexed.
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
    afterNextRender(() => {
      this.hydrated.set(true);
      // No version to accept: nothing waits for this reader, so go on.
      if (this.version() === null) void this.leave();
      else void this.load();
    });
  }

  private async load(): Promise<void> {
    let res;
    try {
      res = await this.api.getTermsPending();
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) this.toSignIn();
      // Any other failure: the page still works, without the summary.
      return;
    }
    if (!res.pending) {
      // Nothing waits any more (another tab ticked, or the version moved): go on.
      await this.leave();
      return;
    }
    this.version.set(res.pending.version);
    this.pending.set(res.pending);
  }

  protected onTick(event: Event): void {
    this.ticked.set((event.target as HTMLInputElement).checked);
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    const version = this.version();
    if (this.saving() || version === null) return;
    this.attempted.set(true);
    if (!this.ticked()) {
      this.box()?.nativeElement.focus();
      return;
    }
    this.saving.set(true);
    this.failed.set(false);
    try {
      await this.api.acceptTerms(version);
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.toSignIn();
        return;
      }
      // Nothing waits for this reader any more: another tab ticked, or the version moved.
      if (!(error instanceof HttpErrorResponse && error.status === 422)) {
        this.saving.set(false);
        this.failed.set(true);
        return;
      }
    }
    await this.leave();
  }

  /** "Not now": go on without accepting. Nothing is posted. */
  protected notNow(): void {
    void this.leave();
  }

  /**
   * Back to sign-in with the original destination, not this page: the next sign-in checks
   * the box afresh and sends the reader back here with `next` intact if it still waits.
   */
  private toSignIn(): void {
    this.hardNavigate(
      this.next === '/'
        ? '/auth/login'
        : `/auth/login?${new URLSearchParams({ return: this.next }).toString()}`,
    );
  }

  /** Go to `next`, by client navigation, else a full page load. */
  protected async leave(): Promise<void> {
    try {
      if (await this.router.navigateByUrl(this.next)) return;
    } catch {
      // Fall through to the full load.
    }
    this.hardNavigate(this.next);
  }

  /** The full-page fallback. A method so a test can stand in for it. */
  protected hardNavigate(url: string): void {
    globalThis.location.assign(url);
  }
}
