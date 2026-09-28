import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { ImAbout, ImLinks, ImRequests, ImRetire, ImShared } from './im-sections';
import { ImTip } from './im-tip';
import { BTN_LINK, IM_STYLES, ImPairMark } from './im-ui';
import { ImRowSummary } from './im-row-summary';
import {
  VIEWER,
  integrationStatus,
  isConnector,
  needs,
  publicPageHref,
  sharedIntro,
  type SectionKey,
} from './integration-manager.fixtures';
import { IntegrationManagerStore } from './integration-manager.store';

interface NavItem {
  readonly key: SectionKey;
  readonly label: string;
}

/** Height of the slim sticky bar plus a gap; nav `top` and heading scroll margins match it. */
const SPY_TOP_PX = 96;

/**
 * Concept C, "Detail page" (the PO's pick, round 2). Each list row links to a
 * full page for the integration (in the preview, `?concept=c&open=<id>`), laid
 * out like a Shopify admin settings page: a title block, a "Things that need
 * you" callout, a sticky section nav on the left and bordered section cards.
 *
 * Round 2:
 * - The nav scroll-spies. An IntersectionObserver (browser only; the effect
 *   returns early without it, so SSR renders the first item active) marks the
 *   first section inside a band below the sticky bar. A nav click locks the spy
 *   until the jump's scroll ends, so the highlight does not flicker through the
 *   sections it passes.
 * - Once the title block scrolls away, a slim bar pins to the top of the
 *   viewport. Jump targets carry scroll-margin for it (never a global viewport
 *   offset; CLAUDE.md).
 * - Flags and callout items jump to one element (a row or a change request),
 *   resetting the requests search first so the target is on the page.
 */
@Component({
  selector: 'aec-im-concept-c',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    ImAbout,
    ImLinks,
    ImRequests,
    ImRetire,
    ImShared,
    ImPairMark,
    ImRowSummary,
    ImTip,
  ],
  styles: [IM_STYLES],
  template: `
    @if (selected(); as i) {
      @let s = status();
      @if (showSlim()) {
        <section
          aria-label="Current integration"
          class="fixed inset-x-0 top-0 z-30 border-b border-(--border-default) bg-(--surface-base)"
        >
          <div class="mx-auto flex h-14 max-w-7xl items-center gap-3 px-6 md:px-8">
            <aec-im-pair-mark [left]="viewer" [right]="i.other.name" [small]="true" />
            <p class="im-h3 truncate text-(--text-primary)">{{ viewer }} and {{ i.other.name }}</p>
            <span class="im-pill shrink-0" [attr.data-tone]="s.tone">{{ s.label }}</span>
            <a
              [href]="publicHref()"
              target="_blank"
              rel="noopener"
              [class]="link"
              class="ms-auto shrink-0"
            >
              View public page
              <svg
                aria-hidden="true"
                class="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M15 3h6v6M10 14 21 3M21 14v7H3V3h7" />
              </svg>
              <span class="sr-only">(opens in a new tab)</span>
            </a>
          </div>
        </section>
      }

      <nav aria-label="Breadcrumb">
        <a
          routerLink="."
          [queryParams]="{ concept: 'c', open: null }"
          queryParamsHandling="merge"
          [class]="link"
        >
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
          All integrations
        </a>
      </nav>

      <div #titleBlock class="im-card mt-4 flex flex-wrap items-start justify-between gap-4 p-6">
        <div class="flex min-w-0 items-start gap-4">
          <aec-im-pair-mark [left]="viewer" [right]="i.other.name" />
          <div class="min-w-0">
            <h2 class="im-h2 text-(--text-primary)">{{ viewer }} and {{ i.other.name }}</h2>
            <div class="mt-2">
              <aec-im-tip variant="pill" [label]="s.label" [tone]="s.tone" [lines]="[s.explain]" />
            </div>
          </div>
        </div>
        <a [href]="publicHref()" target="_blank" rel="noopener" [class]="link">
          View public page
          <svg
            aria-hidden="true"
            class="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M15 3h6v6M10 14 21 3M21 14v7H3V3h7" />
          </svg>
          <span class="sr-only">(opens in a new tab)</span>
        </a>
      </div>

      <section class="im-callout mt-4 p-5 text-sm" aria-labelledby="im-c-needs">
        <h3 id="im-c-needs" class="im-h3 text-(--text-primary)">
          {{ yours().length > 0 ? 'Things that need you' : 'Nothing needs you right now' }}
        </h3>
        @if (yours().length > 0) {
          <ul class="mt-2 list-none space-y-1.5 p-0">
            @for (n of yours(); track n.text) {
              <li class="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  class="h-2 w-2 shrink-0 rounded-full bg-(--accent-secondary-deep)"
                ></span>
                <button type="button" [class]="link" (click)="jumpTo(n.target)">
                  {{ n.text }}
                </button>
              </li>
            }
          </ul>
        }
        @if (waiting().length > 0) {
          <p class="mt-3 font-semibold text-(--text-secondary)">Waiting on someone else</p>
          <ul class="mt-1 list-none space-y-1.5 p-0">
            @for (n of waiting(); track n.text) {
              <li class="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  class="h-2 w-2 shrink-0 rounded-full bg-(--text-tertiary)"
                ></span>
                <button type="button" [class]="link" (click)="jumpTo(n.target)">
                  {{ n.text }}
                </button>
              </li>
            }
          </ul>
        }
      </section>

      <div class="mt-8 grid gap-8 lg:grid-cols-[13rem_1fr]">
        <nav aria-label="Integration sections" class="lg:sticky lg:top-24 lg:self-start">
          <ul class="list-none space-y-0.5 p-0">
            @for (n of nav(); track n.key) {
              <li>
                <button
                  type="button"
                  class="im-navlink block w-full rounded-e-(--radius-sm) px-3 py-2 text-start text-sm text-(--text-secondary) hover:bg-(--surface-sunken) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-(--accent-primary)"
                  [attr.aria-current]="active() === n.key ? 'true' : null"
                  (click)="jump(n.key)"
                  [attr.data-testid]="'nav-' + n.key"
                >
                  {{ n.label }}
                </button>
              </li>
            }
          </ul>
        </nav>

        <div class="min-w-0 space-y-6">
          <section
            #spy
            data-section="overview"
            class="im-card p-6"
            aria-labelledby="im-c-h-overview"
          >
            <h3
              id="im-c-h-overview"
              tabindex="-1"
              class="im-h3 scroll-mt-24 text-(--text-primary) focus:outline-none"
            >
              Overview
            </h3>
            <div class="mt-3">
              <aec-im-about [integration]="i" (goTo)="jump($event)" (goToItem)="jumpTo($event)" />
            </div>
          </section>

          <section #spy data-section="shared" class="im-card p-6" aria-labelledby="im-c-h-shared">
            <div class="flex items-center gap-1">
              <h3
                id="im-c-h-shared"
                tabindex="-1"
                class="im-h3 scroll-mt-24 text-(--text-primary) focus:outline-none"
              >
                Data that's shared ({{ i.flows.length }})
              </h3>
              <aec-im-tip label="About data that is shared" [lines]="[sharedTip()]" />
              @if (canAdd()) {
                <button
                  type="button"
                  class="ms-auto inline-flex h-8 w-8 items-center justify-center rounded-(--radius-md) border border-(--border-strong) text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  aria-label="Add data that's shared"
                  [attr.aria-expanded]="store.addingFlowFor() === i.id"
                  (click)="toggleAdd(i.id)"
                >
                  <svg
                    aria-hidden="true"
                    class="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                  >
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              }
            </div>
            <div class="mt-3"><aec-im-shared [integration]="i" (goToItem)="jumpTo($event)" /></div>
          </section>

          <section #spy data-section="links" class="im-card p-6" aria-labelledby="im-c-h-links">
            <div class="flex items-center gap-1">
              <h3
                id="im-c-h-links"
                tabindex="-1"
                class="im-h3 scroll-mt-24 text-(--text-primary) focus:outline-none"
              >
                Integration links
              </h3>
              <aec-im-tip label="About integration links" [lines]="[linksTip]" />
            </div>
            <div class="mt-3">
              <aec-im-links [integration]="i" (goTo)="jump($event)" (goToItem)="jumpTo($event)" />
            </div>
          </section>

          <section
            #spy
            data-section="requests"
            class="im-card p-6"
            aria-labelledby="im-c-h-requests"
          >
            <div class="flex items-center gap-1">
              <h3
                id="im-c-h-requests"
                tabindex="-1"
                class="im-h3 scroll-mt-24 text-(--text-primary) focus:outline-none"
              >
                Change requests
              </h3>
              <aec-im-tip label="About change requests" [lines]="[requestsTip]" />
            </div>
            <div class="mt-3"><aec-im-requests [integration]="i" /></div>
          </section>

          <section
            #spy
            data-section="settings"
            class="im-card p-6"
            aria-labelledby="im-c-h-settings"
          >
            <h3
              id="im-c-h-settings"
              tabindex="-1"
              class="im-h3 scroll-mt-24 text-(--text-primary) focus:outline-none"
            >
              Settings
            </h3>
            <div class="mt-3"><aec-im-retire [integration]="i" [showWhenNotOwner]="true" /></div>
          </section>
        </div>
      </div>
    } @else {
      <h2 class="im-h2 text-(--text-primary)">Integrations</h2>
      <p class="mt-1 max-w-prose text-sm text-(--text-secondary)">
        Every product {{ viewer }} connects to. Open one to check what is shared and fix anything
        that is wrong.
      </p>
      <ul class="im-card mt-6 list-none divide-y divide-(--border-default) p-0">
        @for (row of store.integrations(); track row.id) {
          <li>
            <a
              routerLink="."
              [queryParams]="{ concept: 'c', open: row.id }"
              queryParamsHandling="merge"
              class="flex items-center gap-4 px-5 py-4 text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
              [attr.data-testid]="'open-' + row.id"
            >
              <aec-im-row-summary class="flex-1" [integration]="row" />
              <svg
                aria-hidden="true"
                class="h-5 w-5 shrink-0 text-(--text-secondary) rtl:-scale-x-100"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </a>
          </li>
        }
      </ul>
    }
  `,
})
export class ConceptCPage {
  protected readonly store = inject(IntegrationManagerStore);
  private readonly document = inject(DOCUMENT);

  /** The `open` query param, from the preview root. */
  readonly openId = input<string | null>(null);

  private readonly titleBlock = viewChild<ElementRef<HTMLElement>>('titleBlock');
  private readonly spySections = viewChildren<ElementRef<HTMLElement>>('spy');

  protected readonly viewer = VIEWER.product;
  protected readonly link = BTN_LINK;
  protected readonly active = signal<SectionKey>('overview');
  protected readonly showSlim = signal(false);
  private spyLocked = false;
  /** Re-reads the section under the bar; set while the observer is live. */
  private recompute: (() => void) | null = null;
  private unlockTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly selected = computed(() => this.store.byId(this.openId()));
  protected readonly status = computed(() => {
    const i = this.selected();
    return i ? integrationStatus(i) : { label: '', tone: 'neutral' as const, explain: '' };
  });
  protected readonly publicHref = computed(() => {
    const i = this.selected();
    return i ? publicPageHref(i) : '#';
  });
  private readonly needList = computed(() => {
    const i = this.selected();
    return i ? needs(i) : [];
  });
  protected readonly yours = computed(() => this.needList().filter((n) => n.yours));
  protected readonly waiting = computed(() => this.needList().filter((n) => !n.yours));
  protected readonly canAdd = computed(() => {
    const i = this.selected();
    return !!i && !isConnector(i) && !i.retired;
  });
  protected readonly sharedTip = computed(() => {
    const i = this.selected();
    return i ? sharedIntro(i) : '';
  });
  protected readonly linksTip =
    'Every link shown on the public page for this integration, grouped by who provides it: the integration itself, your products, and the other company.';
  protected readonly requestsTip =
    'Corrections you asked for, and disagreements with the other company about the data that is shared. Nothing on the public page changes until a request is accepted.';

  protected readonly nav = computed<readonly NavItem[]>(() => [
    { key: 'overview', label: 'Overview' },
    { key: 'shared', label: "Data that's shared" },
    { key: 'links', label: 'Integration links' },
    { key: 'requests', label: 'Change requests' },
    { key: 'settings', label: 'Settings' },
  ]);

  constructor() {
    // Scroll-spy. Browser only: there is no IntersectionObserver on the server.
    // The observer's root is a one-pixel line just below the sticky bar, so it
    // fires the moment any section's top or bottom crosses that line. The active
    // section is then read from positions: the last one whose top has passed the
    // line. A second observer watches the last section fully in view, because a
    // short final section can never reach the line at the foot of the page.
    effect((onCleanup) => {
      const sections = this.spySections().map((r) => r.nativeElement);
      const win = this.document.defaultView;
      if (sections.length === 0 || !win || typeof IntersectionObserver === 'undefined') return;
      let line: IntersectionObserver | null = null;
      let lastFull = false;
      const recompute = () => {
        if (this.spyLocked) return;
        const atBottom =
          win.innerHeight + win.scrollY >= this.document.documentElement.scrollHeight - 4;
        this.active.set(this.sectionAtBar(sections, atBottom && lastFull));
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
        ([e]) => {
          lastFull = e.intersectionRatio >= 0.99;
          recompute();
        },
        { threshold: [0, 0.99] },
      );
      end.observe(sections[sections.length - 1]);
      observeLine();
      // The line is in pixels, so it has to move when the viewport does.
      win.addEventListener('resize', observeLine, { passive: true });
      this.recompute = () => recompute();
      onCleanup(() => {
        line?.disconnect();
        end.disconnect();
        win.removeEventListener('resize', observeLine);
        this.recompute = null;
      });
    });

    // The slim bar shows once the title block has scrolled above the viewport.
    effect((onCleanup) => {
      const el = this.titleBlock()?.nativeElement;
      if (!el || typeof IntersectionObserver === 'undefined') {
        this.showSlim.set(false);
        return;
      }
      const observer = new IntersectionObserver(([e]) =>
        this.showSlim.set(!e.isIntersecting && e.boundingClientRect.top < 0),
      );
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });
  }

  /**
   * The section under the sticky bar: the last one whose top has scrolled up to
   * the bar, else the first. At the foot of the page, the last one in view (a
   * short final section can never reach the bar).
   */
  private sectionAtBar(sections: readonly HTMLElement[], lastInFullView: boolean): SectionKey {
    const keyOf = (el: HTMLElement) => (el.dataset['section'] ?? 'overview') as SectionKey;
    if (lastInFullView) return keyOf(sections[sections.length - 1]);
    let current = sections[0];
    for (const el of sections) {
      if (el.getBoundingClientRect().top <= SPY_TOP_PX + 1) current = el;
    }
    return keyOf(current);
  }

  protected toggleAdd(id: string): void {
    this.store.addingFlowFor.set(this.store.addingFlowFor() === id ? null : id);
  }

  /** Nav click: jump to a section heading, and hold the spy until the scroll ends. */
  protected jump(key: SectionKey): void {
    this.active.set(key);
    this.lockSpy();
    requestAnimationFrame(() => {
      const heading = this.document.getElementById(`im-c-h-${key}`);
      heading?.scrollIntoView({ block: 'start' });
      // A request form that just opened takes focus itself, so leave it there.
      if (!(key === 'requests' && this.store.requestFormFor())) {
        heading?.focus({ preventScroll: true });
      }
    });
  }

  /** Flag or callout: jump to one element, with the requests search cleared so it is on the page. */
  protected jumpTo(id: string): void {
    this.store.requestQuery.set('');
    this.store.requestFilter.set('all');
    this.lockSpy();
    requestAnimationFrame(() => {
      const el = this.document.getElementById(id);
      if (!el) return;
      const section = el.closest<HTMLElement>('[data-section]')?.dataset['section'];
      if (section) this.active.set(section as SectionKey);
      el.scrollIntoView({ block: 'start' });
      el.focus({ preventScroll: true });
    });
  }

  private lockSpy(): void {
    this.spyLocked = true;
    if (this.unlockTimer) clearTimeout(this.unlockTimer);
    const release = () => {
      this.spyLocked = false;
      this.recompute?.();
      if (this.unlockTimer) clearTimeout(this.unlockTimer);
      this.unlockTimer = null;
    };
    this.document.defaultView?.addEventListener('scrollend', release, { once: true });
    this.unlockTimer = setTimeout(release, 1200);
  }
}
