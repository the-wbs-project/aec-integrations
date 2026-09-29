import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';

import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { vendorProductContext } from '../sections/vendor-product-context';
import { VendorPortalStore } from '../vendor-portal-store';

import { IntegrationChangeRequests } from './integration-change-requests';
import {
  contestsFor,
  isSectionId,
  needsItems,
  possessive,
  statusExplain,
  statusLabel,
  statusTone,
  integrationStatus,
  type NeedItem,
  type SectionId,
} from './integration-detail-model';
import { IntegrationDetailState } from './integration-detail-state';
import { ID_STYLES, IN_TEXT_LINK } from './integration-detail-styles';
import { IntegrationLinksSection } from './integration-links';
import { IntegrationOverview } from './integration-overview';
import { IntegrationSettings } from './integration-settings';
import { IntegrationSharedData } from './integration-shared-data';
import { VendorTip } from './vendor-tip';

/**
 * The sticky bar's height plus a gap, in CSS pixels. The scroll-spy reads the
 * section under this line, and every jump target declares the same clearance as
 * `scroll-mt-20` (5rem). Never `ViewportScroller.setOffset()` (ANGULAR_STYLE_GUIDE.md §3).
 */
const SPY_TOP_PX = 80;

/**
 * `…/products/:productSlug/integrations/:integrationId`: one integration's page
 * (AECI-1149, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.1, §6.17.2).
 *
 * ── WHICH ENTRY ─────────────────────────────────────────────────────────────
 * The entry of the store's `integrations` whose `id` is `:integrationId` AND whose
 * `context_product` is the routed product. `id` alone is not unique (AECI-666): an
 * owns-both integration has a page under each of its products. No request carries
 * the id before the list says it is the caller's, so a foreign id cannot be
 * probed. "Not found" is decided only once the list has settled.
 *
 * ── SSR ─────────────────────────────────────────────────────────────────────
 * The store never fetches on the server, so SSR renders the loading state, and the
 * list lands after hydration. The sticky bar and the scroll-spy are browser-only;
 * SSR marks Overview current.
 *
 * ── THE FIRST LOAD OF A `#section` LINK ─────────────────────────────────────
 * `InitialFragmentScroller` scrolls on the first `NavigationEnd`, and this page's
 * sections do not exist yet then: they render once the list lands. So the page
 * lands the fragment itself, once, when its sections first render. That is the
 * same gap that scroller closes, one step later. It is not a second scroll model.
 */
@Component({
  selector: 'aec-vendor-integration-detail-page',
  imports: [
    RouterLink,
    LogoOrInitial,
    NewTabIcon,
    VendorTip,
    IntegrationOverview,
    IntegrationSharedData,
    IntegrationLinksSection,
    IntegrationChangeRequests,
    IntegrationSettings,
  ],
  providers: [IntegrationDetailState],
  styles: [ID_STYLES],
  template: `
    <nav
      i18n-aria-label="@@vendor.im.breadcrumb.aria"
      aria-label="Integration breadcrumb"
      class="mt-2"
    >
      <a routerLink=".." [class]="backLinkClass">
        <svg
          aria-hidden="true"
          class="h-4 w-4 rtl:-scale-x-100"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        <span i18n="@@vendor.im.back">All integrations</span>
      </a>
    </nav>

    @if (integration(); as i) {
      @if (showSlim()) {
        <section
          [attr.aria-label]="slimLabel()"
          data-testid="integration-sticky-bar"
          class="fixed inset-x-0 top-0 z-30 border-b border-(--border-default) bg-(--surface-base)"
        >
          <div class="mx-auto flex h-14 max-w-7xl items-center gap-3 px-6 md:px-8">
            <span aria-hidden="true" class="hidden shrink-0 items-center sm:flex">
              <aec-logo-or-initial
                [src]="i.context_product.logo_url"
                [name]="i.context_product.name"
                size="sm"
              />
              <span class="h-px w-3 bg-(--border-strong)"></span>
              <aec-logo-or-initial
                [src]="i.other_product.logo_url"
                [name]="i.other_product.name"
                size="sm"
              />
            </span>
            <p class="id-h3-slim min-w-0 truncate text-(--text-primary)">{{ title() }}</p>
            <aec-vendor-tip
              variant="pill"
              [label]="statusText()"
              [tone]="tone()"
              [lines]="[statusHelp()]"
            />
            <a
              [href]="publicHref()"
              target="_blank"
              rel="noopener"
              [attr.aria-label]="publicAria()"
              [class]="publicLinkClass"
              class="ms-auto shrink-0"
              ><span i18n="@@vendor.im.viewPublic">View public page</span>
              <aec-new-tab-icon [announce]="false"
            /></a>
          </div>
        </section>
      }

      <div
        #titleBlock
        class="id-card mt-4 flex flex-wrap items-start justify-between gap-4 p-5 sm:p-6"
      >
        <div class="flex min-w-0 items-start gap-4">
          <span aria-hidden="true" class="flex shrink-0 items-center pt-0.5">
            <aec-logo-or-initial
              [src]="i.context_product.logo_url"
              [name]="i.context_product.name"
              size="sm"
            />
            <span class="h-px w-3 bg-(--border-strong)"></span>
            <aec-logo-or-initial
              [src]="i.other_product.logo_url"
              [name]="i.other_product.name"
              size="sm"
            />
          </span>
          <div class="min-w-0">
            <h2 class="id-h2 break-words text-(--text-primary)" data-testid="integration-title">
              {{ title() }}
            </h2>
            <div class="mt-2">
              <aec-vendor-tip
                variant="pill"
                testId="integration-status"
                [label]="statusText()"
                [tone]="tone()"
                [lines]="[statusHelp()]"
              />
            </div>
          </div>
        </div>
        <a
          [href]="publicHref()"
          target="_blank"
          rel="noopener"
          [attr.aria-label]="publicAria()"
          [class]="publicLinkClass"
          ><span i18n="@@vendor.im.viewPublic">View public page</span>
          <aec-new-tab-icon [announce]="false"
        /></a>
      </div>

      <section
        class="id-callout mt-4 p-5 text-sm"
        aria-labelledby="integration-needs-heading"
        data-testid="integration-needs"
      >
        <h3 id="integration-needs-heading" class="id-h3-slim text-(--text-primary)">
          @if (needs().yours.length > 0) {
            <span i18n="@@vendor.im.needs.heading">Things that need you</span>
          } @else {
            <span i18n="@@vendor.im.needs.none">Nothing needs you right now</span>
          }
        </h3>
        @if (needs().yours.length > 0) {
          <ul class="mt-2 list-none space-y-1.5 p-0">
            @for (item of needs().yours; track item.key) {
              <li class="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  class="mt-2 h-2 w-2 shrink-0 rounded-full bg-(--accent-secondary-deep)"
                ></span>
                <button type="button" [class]="needLinkClass" (click)="jumpToItem(item)">
                  {{ item.text }}
                </button>
              </li>
            }
          </ul>
        }
        @if (needs().waiting.length > 0) {
          <h4 class="id-h4 mt-3 text-(--text-secondary)" i18n="@@vendor.im.needs.waiting">
            Waiting on someone else
          </h4>
          <ul class="mt-1 list-none space-y-1.5 p-0">
            @for (item of needs().waiting; track item.key) {
              <li class="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  class="mt-2 h-2 w-2 shrink-0 rounded-full bg-(--text-secondary)"
                ></span>
                <button type="button" [class]="needLinkClass" (click)="jumpToItem(item)">
                  {{ item.text }}
                </button>
              </li>
            }
          </ul>
        }
      </section>

      <div class="mt-8 grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          i18n-aria-label="@@vendor.im.sections.aria"
          aria-label="Integration sections"
          class="lg:sticky lg:top-20 lg:self-start"
        >
          <ul class="m-0 list-none space-y-0.5 p-0">
            @for (item of navItems; track item.id) {
              <li>
                <a
                  [href]="pagePath() + '#' + item.id"
                  class="id-navlink block rounded-e-(--radius-sm) px-3 py-2 text-sm text-(--text-secondary) no-underline hover:bg-(--surface-sunken) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                  [attr.aria-current]="active() === item.id ? 'location' : null"
                  [attr.data-testid]="'section-nav-' + item.id"
                  (click)="onNav(item.id)"
                  >{{ item.label }}</a
                >
              </li>
            }
          </ul>
        </nav>

        <div class="min-w-0 space-y-6">
          <section
            #spy
            id="overview"
            data-section="overview"
            class="id-card scroll-mt-20 p-5 sm:p-6"
            aria-labelledby="overview-heading"
          >
            <h3
              id="overview-heading"
              tabindex="-1"
              class="id-h3 text-(--text-primary) focus:outline-none"
              i18n="@@vendor.im.section.overview"
            >
              Overview
            </h3>
            <div class="mt-3"><aec-integration-overview [integration]="i" /></div>
          </section>

          <section
            #spy
            id="data-shared"
            data-section="data-shared"
            class="id-card scroll-mt-20 p-5 sm:p-6"
            aria-labelledby="data-shared-heading"
          >
            <aec-integration-shared-data [integration]="i" />
          </section>

          <section
            #spy
            id="links"
            data-section="links"
            class="id-card scroll-mt-20 p-5 sm:p-6"
            aria-labelledby="links-heading"
          >
            <aec-integration-links [integration]="i" />
          </section>

          <section
            #spy
            id="change-requests"
            data-section="change-requests"
            class="id-card scroll-mt-20 p-5 sm:p-6"
            aria-labelledby="change-requests-heading"
          >
            <aec-integration-change-requests [integration]="i" />
          </section>

          <section
            #spy
            id="settings"
            data-section="settings"
            class="id-card scroll-mt-20 p-5 sm:p-6"
            aria-labelledby="settings-heading"
          >
            <h3
              id="settings-heading"
              tabindex="-1"
              class="id-h3 text-(--text-primary) focus:outline-none"
              i18n="@@vendor.im.section.settings"
            >
              Settings
            </h3>
            <div class="mt-3"><aec-integration-settings [integration]="i" /></div>
          </section>
        </div>
      </div>
    } @else if (loading()) {
      <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@vendor.im.loading">
        Loading the integration…
      </p>
    } @else if (failed()) {
      <div class="mt-6 flex flex-wrap items-center gap-3">
        <p class="text-sm text-(--text-primary)" i18n="@@vendor.im.failed">
          Could not load this integration.
        </p>
        <button type="button" [class]="retryClass" (click)="retry()" i18n="@@vendor.im.retry">
          Try again
        </button>
      </div>
    } @else {
      <h2
        class="id-h2 mt-6 text-(--text-primary)"
        data-testid="integration-not-found"
        i18n="@@vendor.im.notFound.heading"
      >
        Integration not found
      </h2>
      <p
        class="mt-4 max-w-prose rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
      >
        <span i18n="@@vendor.im.notFound.body"
          >This integration is not one of {{ productPossessive() }} integrations. It may have been
          removed, or the link may be wrong.</span
        >
        {{ ' ' }}
        <a routerLink=".." [class]="inTextLink" i18n="@@vendor.im.notFound.link"
          >See {{ productPossessive() }} integrations</a
        >
      </p>
    }
  `,
})
export class VendorIntegrationDetailPage {
  private readonly store = inject(VendorPortalStore);
  private readonly state = inject(IntegrationDetailState);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly ctx = vendorProductContext();

  private readonly titleBlock = viewChild<ElementRef<HTMLElement>>('titleBlock');
  private readonly spySections = viewChildren<ElementRef<HTMLElement>>('spy');

  private readonly integrationId = toSignal(
    this.route.paramMap.pipe(map((p) => p.get('integrationId'))),
    { initialValue: this.route.snapshot.paramMap.get('integrationId') },
  );

  /** The entry the page is about, or `null`. */
  protected readonly integration = computed(() => {
    const id = this.integrationId();
    const product = this.ctx.product();
    if (!id || !product) return null;
    return (
      this.store.integrations().find((i) => i.id === id && i.context_product.id === product.id) ??
      null
    );
  });

  protected readonly loading = this.store.integrationsLoading;
  protected readonly failed = this.store.integrationsFailed;
  protected readonly productPossessive = computed(() => possessive(this.ctx.product()?.name ?? ''));

  /** The path without query or fragment, for the native section anchors. */
  protected readonly pagePath = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => pathOnly(this.router.url)),
    ),
    { initialValue: pathOnly(this.router.url) },
  );

  protected readonly title = computed(() => {
    const i = this.integration();
    if (!i) return '';
    const a = i.context_product.name;
    const b = i.other_product.name;
    return $localize`:@@vendor.im.title:${a}:context: and ${b}:other:`;
  });

  private readonly statusKey = computed(() => {
    const i = this.integration();
    if (!i) return 'up_to_date' as const;
    return integrationStatus(i, {
      contests: this.pageContests(),
      entitled: this.state.entitled(),
      canAuthor: this.state.canAuthor(),
      now: new Date().toISOString(),
    });
  });

  /** The page's own contest read, narrowed to this row as a guard. */
  private readonly pageContests = computed(() => {
    const i = this.integration();
    return i ? contestsFor(this.state.contests(), i.id) : { submitted: [], received: [] };
  });

  protected readonly statusText = computed(() =>
    statusLabel(this.statusKey(), this.pageContests()),
  );
  protected readonly tone = computed(() => statusTone(this.statusKey()));
  protected readonly statusHelp = computed(() => {
    const i = this.integration();
    return i ? statusExplain(this.statusKey(), i) : '';
  });

  protected readonly needs = computed(() => {
    const i = this.integration();
    if (!i) return { yours: [], waiting: [] };
    return needsItems(i, {
      contests: this.pageContests(),
      entitled: this.state.entitled(),
      canAuthor: this.state.canAuthor(),
      company: this.state.company(),
      now: new Date().toISOString(),
    });
  });

  protected readonly publicHref = computed(() => {
    const i = this.integration();
    return i ? `/products/${i.context_product.slug}/integrations/${i.other_product.slug}` : '/';
  });

  /** Built in TS: an interpolated `i18n-aria-label` emits no attribute here. It
   *  starts with the visible text (WCAG 2.5.3) and names the destination (§6.7). */
  protected readonly publicAria = computed(() => {
    const i = this.integration();
    if (!i) return null;
    const context = i.context_product.name;
    const other = i.other_product.name;
    return $localize`:@@vendor.attest.card.viewPublic.aria:View public page: the ${context}:CONTEXT: and ${other}:OTHER: integration (opens in a new tab)`;
  });

  protected readonly slimLabel = computed(
    () => $localize`:@@vendor.im.sticky.aria:Current integration: ${this.title()}:title:`,
  );

  protected readonly navItems: readonly { id: SectionId; label: string }[] = [
    { id: 'overview', label: $localize`:@@vendor.im.section.overview:Overview` },
    { id: 'data-shared', label: $localize`:@@vendor.im.section.dataShared:Data that's shared` },
    { id: 'links', label: $localize`:@@vendor.im.section.links:Integration links` },
    {
      id: 'change-requests',
      label: $localize`:@@vendor.im.section.changeRequests:Change requests`,
    },
    { id: 'settings', label: $localize`:@@vendor.im.section.settings:Settings` },
  ];

  /** The section under the sticky bar. SSR marks Overview. */
  protected readonly active = signal<SectionId>('overview');
  protected readonly showSlim = signal(false);

  private spyLocked = false;
  private unlockTimer: ReturnType<typeof setTimeout> | null = null;
  private recompute: (() => void) | null = null;
  private fragmentHandled = false;
  /** The pending `scrollend` and `hashchange` listeners, removed on release and on
   *  destroy so a page left mid-jump leaves nothing on the window. */
  private spyListeners: AbortController | null = null;
  private navListeners: AbortController | null = null;

  constructor() {
    this.state.bind(this.integration);
    this.state.setJumpHandler((target) => this.jump(target));
    this.destroyRef.onDestroy(() => {
      this.state.setJumpHandler(null);
      if (this.unlockTimer) clearTimeout(this.unlockTimer);
      this.spyListeners?.abort();
      this.navListeners?.abort();
    });

    afterNextRender(() => void this.store.ensure('integrations'));

    // The page's one extra read (§6.17.6), once the entry is known to be the
    // caller's: no request carries an id the list has not vouched for.
    effect(() => {
      const i = this.integration();
      if (!i || !this.isBrowser) return;
      untracked(() => void this.state.ensureContests(i.id));
    });

    // The slim bar shows once the title block has scrolled above the viewport.
    effect((onCleanup) => {
      const el = this.titleBlock()?.nativeElement;
      if (!el || !this.isBrowser || typeof IntersectionObserver === 'undefined') {
        this.showSlim.set(false);
        return;
      }
      const observer = new IntersectionObserver(([entry]) =>
        this.showSlim.set(!entry.isIntersecting && entry.boundingClientRect.top < 0),
      );
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });

    // Scroll-spy (§6.17.2). An observer whose root is a one-pixel line just below
    // the sticky bar fires whenever a section edge crosses it; the current section
    // is then read from positions. A second observer watches the last section,
    // because a short last section can never reach the line at the foot of the page.
    effect((onCleanup) => {
      const sections = this.spySections().map((r) => r.nativeElement);
      const win = this.document.defaultView;
      if (
        sections.length === 0 ||
        !win ||
        !this.isBrowser ||
        typeof IntersectionObserver === 'undefined'
      ) {
        return;
      }
      let line: IntersectionObserver | null = null;
      let lastFull = false;
      const recompute = () => {
        if (this.spyLocked) return;
        const atBottom =
          win.innerHeight + win.scrollY >= this.document.documentElement.scrollHeight - 4;
        this.active.set(sectionAtBar(sections, atBottom && lastFull));
      };
      const observeLine = () => {
        line?.disconnect();
        const below = Math.max(0, win.innerHeight - SPY_TOP_PX - 1);
        line = new IntersectionObserver(recompute, {
          rootMargin: `-${SPY_TOP_PX}px 0px -${below}px 0px`,
        });
        sections.forEach((el) => line?.observe(el));
      };
      const end = new IntersectionObserver(
        ([entry]) => {
          lastFull = entry.intersectionRatio >= 0.99;
          recompute();
        },
        { threshold: [0, 0.99] },
      );
      end.observe(sections[sections.length - 1]);
      observeLine();
      win.addEventListener('resize', observeLine, { passive: true });
      this.recompute = recompute;
      onCleanup(() => {
        line?.disconnect();
        end.disconnect();
        win.removeEventListener('resize', observeLine);
        this.recompute = null;
      });
    });

    // Land a `#section` or `#item` deep link once the sections exist (see the
    // header). Once per page.
    effect(() => {
      const sections = this.spySections();
      if (sections.length === 0 || this.fragmentHandled || !this.isBrowser) return;
      this.fragmentHandled = true;
      const hash = this.document.defaultView?.location.hash.replace(/^#/, '') ?? '';
      if (!hash) return;
      untracked(() =>
        afterNextRender(
          () => {
            const el = this.document.getElementById(safeDecode(hash));
            if (!el) return;
            if (isSectionId(hash)) this.active.set(hash);
            this.lockSpy();
            el.scrollIntoView?.({ block: 'start', behavior: 'instant' });
          },
          { injector: this.injector },
        ),
      );
    });
  }

  /**
   * A nav item was chosen. The anchor's native behaviour does the scroll (and the
   * router's re-scroll honours `scroll-margin`); this only holds the spy on the
   * chosen item until the scroll ends and moves focus to the section's heading.
   */
  protected onNav(id: SectionId): void {
    this.active.set(id);
    this.lockSpy();
    const heading = this.document.getElementById(`${id}-heading`);
    const focus = () => heading?.focus({ preventScroll: true });
    focus();
    // The anchor's own fragment navigation (and the router's follow-up) can move
    // focus back to the document after this handler, so focus again once it has
    // landed. Never a scroll: the anchor already did that.
    this.navListeners?.abort();
    const listeners = new AbortController();
    this.navListeners = listeners;
    this.document.defaultView?.addEventListener(
      'hashchange',
      () => {
        listeners.abort();
        setTimeout(focus);
      },
      { once: true, signal: listeners.signal },
    );
    setTimeout(focus, 50);
  }

  protected jumpToItem(item: NeedItem): void {
    this.state.jumpTo(item.target, item.inRequests);
  }

  /** Scroll to one element and focus it. Instant, so reduced motion is respected. */
  private jump(target: string): void {
    this.lockSpy();
    afterNextRender(
      () => {
        const el = this.document.getElementById(target);
        if (!el) return;
        const section = el.closest<HTMLElement>('[data-section]')?.dataset['section'];
        if (section && isSectionId(section)) this.active.set(section);
        el.scrollIntoView?.({ block: 'start', behavior: 'instant' });
        const focusable = el.matches('[tabindex], button, a, input, select, textarea')
          ? el
          : el.querySelector<HTMLElement>('[tabindex="-1"]');
        (focusable ?? el).focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  private lockSpy(): void {
    this.spyLocked = true;
    if (this.unlockTimer) clearTimeout(this.unlockTimer);
    this.spyListeners?.abort();
    const listeners = new AbortController();
    this.spyListeners = listeners;
    const release = () => {
      this.spyLocked = false;
      if (this.unlockTimer) clearTimeout(this.unlockTimer);
      this.unlockTimer = null;
      listeners.abort();
      this.recompute?.();
    };
    this.document.defaultView?.addEventListener('scrollend', release, {
      once: true,
      signal: listeners.signal,
    });
    this.unlockTimer = setTimeout(release, 1200);
  }

  protected retry(): void {
    void this.store.reload('integrations');
  }

  protected readonly backLinkClass =
    'inline-flex min-h-6 items-center gap-1 rounded-(--radius-sm) text-sm font-medium text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly publicLinkClass =
    'inline-flex min-h-6 items-center gap-1.5 rounded-(--radius-md) px-3 py-1.5 text-xs font-medium text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly needLinkClass =
    'cursor-pointer rounded-(--radius-sm) text-start text-sm font-medium text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly inTextLink = IN_TEXT_LINK;
  protected readonly retryClass =
    'id-btn-secondary rounded-(--radius-sm) px-3 py-1.5 text-sm font-medium text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}

/** The last section whose top has reached the bar, else the first. At the foot
 *  of the page, the last one when it is fully in view. */
function sectionAtBar(sections: readonly HTMLElement[], lastInFullView: boolean): SectionId {
  const keyOf = (el: HTMLElement): SectionId => {
    const key = el.dataset['section'] ?? 'overview';
    return isSectionId(key) ? key : 'overview';
  };
  if (lastInFullView) return keyOf(sections[sections.length - 1]);
  let current = sections[0];
  for (const el of sections) {
    if (el.getBoundingClientRect().top <= SPY_TOP_PX + 1) current = el;
  }
  return keyOf(current);
}

function pathOnly(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
