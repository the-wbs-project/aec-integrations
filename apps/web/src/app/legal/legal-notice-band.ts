import { DOCUMENT, isPlatformBrowser, isPlatformServer } from '@angular/common';
import {
  Component,
  InjectionToken,
  PLATFORM_ID,
  TransferState,
  afterNextRender,
  computed,
  inject,
  makeStateKey,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  LEGAL_NOTICES,
  type LegalNotice,
  activeLegalNotices,
  legalNoticeHref,
  legalNoticeId,
} from './legal-notices';

/** The entries the band reads. A token so specs can set them. */
export const LEGAL_NOTICES_DATA = new InjectionToken<readonly LegalNotice[]>('LEGAL_NOTICES_DATA', {
  factory: () => LEGAL_NOTICES,
});

/** The server's clock. A token so specs can set it. */
export const LEGAL_NOTICE_NOW = new InjectionToken<() => number>('LEGAL_NOTICE_NOW', {
  factory: () => Date.now,
});

/** TransferState key for the ids the server found active. */
export const LEGAL_NOTICE_ACTIVE_IDS = makeStateKey<string[]>('aeci.legal-notices');

/** localStorage key holding a JSON array of dismissed notice ids. */
export const LEGAL_NOTICE_DISMISSED_KEY = 'aeci_legal_notice_dismissed';

function readDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      globalThis.localStorage?.getItem(LEGAL_NOTICE_DISMISSED_KEY) ?? '[]',
    );
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: readonly string[]): void {
  try {
    if (ids.length === 0) globalThis.localStorage?.removeItem(LEGAL_NOTICE_DISMISSED_KEY);
    else globalThis.localStorage?.setItem(LEGAL_NOTICE_DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked or full. The dismissal lasts until the next full page load.
  }
}

/**
 * The site-wide legal notice (AECI-1592, `STAGE_1_SPEC.md` §27.4). The Privacy
 * Policy promises a notice on every page for 30 days before a material change
 * takes effect, naming what changes and linking to the new version.
 *
 * Rendered once in the app shell, by SSR, so it is in the cached HTML. The HTML
 * depends on the date and never on the visitor. `capTtlAtLegalNoticeBoundary`
 * (`server-runtime.ts`) stops a cached page outliving a window boundary.
 *
 * The server decides which notices are active and passes their ids through
 * `TransferState`. The browser never reads its own clock, so a wrong clock cannot
 * cause a hydration mismatch. When none is active no key is written, and the HTML
 * is what it would be without this component.
 *
 * A dismissal is client-only. It is read after hydration and stored per notice,
 * so a dismissed notice shows briefly on a full page load. The same pass removes
 * the id of any notice that has ended, which is what the Privacy Policy's "Cookies
 * and similar technologies" section says we do.
 *
 * Calm, like the plan-ended banners: no status colour, no `role="alert"`, no live
 * region. Light only.
 */
@Component({
  selector: 'aec-legal-notice-band',
  imports: [RouterLink],
  template: `
    @for (notice of visible(); track id(notice)) {
      <div
        role="region"
        [attr.aria-label]="regionLabel(notice)"
        class="aec-notice-neutral border-b bg-(--accent-warm)"
        data-testid="legal-notice"
      >
        <div class="mx-auto flex max-w-7xl items-start justify-between gap-4 px-6 py-3 md:px-8">
          <p class="min-w-0 text-sm/6 text-(--text-primary)">
            <span class="font-semibold" i18n="@@legal.notice.lead"
              >Changes to the {{ notice.title }} take effect on
              {{ notice.effectiveDateLabel }}.</span
            >
            {{ notice.summary }}
            <a
              [routerLink]="href(notice)"
              class="text-(--accent-primary) underline underline-offset-2
                hover:text-(--accent-primary-hover)"
              i18n="@@legal.notice.readNewVersion"
              >Read the new version</a
            >
          </p>
          <button
            type="button"
            (click)="dismiss(notice)"
            [attr.aria-label]="dismissLabel(notice)"
            class="-my-1 inline-flex size-8 shrink-0 items-center justify-center
              rounded-(--radius-md) text-(--text-secondary) transition-colors
              hover:bg-(--surface-sunken) hover:text-(--text-primary)
              focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-(--accent-primary)"
            data-testid="legal-notice-dismiss"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              class="size-4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class LegalNoticeBand {
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly notices = inject(LEGAL_NOTICES_DATA);
  private readonly now = inject(LEGAL_NOTICE_NOW);
  private readonly transferState = inject(TransferState);

  private readonly active = this.resolveActive();

  /** Empty until read after hydration, so the first client render matches the HTML. */
  private readonly dismissed = signal<readonly string[]>([]);

  protected readonly visible = computed(() =>
    this.active.filter((notice) => !this.dismissed().includes(legalNoticeId(notice))),
  );

  protected readonly id = legalNoticeId;
  protected readonly href = legalNoticeHref;

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      afterNextRender(() => this.reconcileDismissed());
    }
  }

  protected regionLabel(notice: LegalNotice): string {
    return $localize`:@@legal.notice.regionLabel:Notice of changes to the ${notice.title}:TITLE:`;
  }

  protected dismissLabel(notice: LegalNotice): string {
    return $localize`:@@legal.notice.dismiss:Dismiss the notice about the ${notice.title}:TITLE:`;
  }

  protected dismiss(notice: LegalNotice): void {
    const next = [...this.dismissed(), legalNoticeId(notice)];
    this.dismissed.set(next);
    writeDismissed(next);
    this.focusMain();
  }

  private resolveActive(): readonly LegalNotice[] {
    if (isPlatformServer(this.platformId)) {
      const active = activeLegalNotices(this.now(), this.notices);
      if (active.length > 0) {
        this.transferState.set(LEGAL_NOTICE_ACTIVE_IDS, active.map(legalNoticeId));
      }
      return active;
    }
    const activeIds = this.transferState.get(LEGAL_NOTICE_ACTIVE_IDS, []);
    return this.notices.filter((notice) => activeIds.includes(legalNoticeId(notice)));
  }

  /** Runs on every full page load, even with no notice active, so an ended id goes. */
  private reconcileDismissed(): void {
    const stored = readDismissed();
    const kept = stored.filter((id) => this.active.some((notice) => legalNoticeId(notice) === id));
    if (kept.length !== stored.length) writeDismissed(kept);
    this.dismissed.set(kept);
  }

  /** The button that had focus is gone. Keep a keyboard user's place. */
  private focusMain(): void {
    const main = this.document.getElementById('main');
    if (!main) return;
    // A programmatic target, like the skip link's, so no ring around the whole page.
    main.setAttribute('tabindex', '-1');
    main.style.outline = 'none';
    main.addEventListener(
      'blur',
      () => {
        main.removeAttribute('tabindex');
        main.style.removeProperty('outline');
      },
      { once: true },
    );
    main.focus({ preventScroll: true });
  }
}
