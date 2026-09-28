import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
  provideBrnDialogDefaultOptions,
} from '@spartan-ng/brain/dialog';

import { ImAbout, ImLinks, ImRequests, ImRetire, ImShared } from './im-sections';
import { IM_STYLES, ImPill } from './im-ui';
import { ImRowSummary } from './im-row-summary';
import {
  VIEWER,
  integrationStatus,
  publicPageHref,
  type SectionKey,
} from './integration-manager.fixtures';
import { IntegrationManagerStore } from './integration-manager.store';

interface NavItem {
  readonly key: SectionKey;
  readonly label: string;
}

/**
 * Concept B, "Side panel". The list stays on the left. Selecting an integration
 * opens a sheet from the right with the same sections as the dialog, as one
 * scrollable page with a sticky section nav, and Previous / Next so a reviewer
 * can walk every integration without going back to the list. The anchor for
 * that is Shopify's order page, whose header carries up and down arrows to step
 * through orders.
 *
 * Built on BrnDialog like requests/request-drawer.ts: the transparent
 * aeci-drawer-backdrop keeps the list visible, and BrnDialog supplies the focus
 * trap, Escape and focus return. Unlike the drawer it opens from the click
 * handler, never from an effect (NG0602).
 */
@Component({
  selector: 'aec-im-concept-b',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BrnDialog,
    BrnDialogClose,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    ImAbout,
    ImLinks,
    ImRequests,
    ImRetire,
    ImShared,
    ImPill,
    ImRowSummary,
  ],
  providers: [provideBrnDialogDefaultOptions({ backdropClass: 'aeci-drawer-backdrop' })],
  styles: [IM_STYLES],
  template: `
    <h2 class="im-h2 text-(--text-primary)">Integrations</h2>
    <p class="mt-1 max-w-prose text-sm text-(--text-secondary)">
      Select an integration to review it. Use Next to move through them one after another.
    </p>

    <ul class="mt-6 max-w-[34rem] list-none space-y-2 p-0">
      @for (i of store.integrations(); track i.id) {
        <li>
          <button
            type="button"
            [class]="rowClass(i.id)"
            [attr.aria-current]="selectedId() === i.id ? 'true' : null"
            (click)="open(i.id)"
            [attr.data-testid]="'select-' + i.id"
          >
            <aec-im-row-summary [integration]="i" [compact]="true" [nameId]="'im-b-name-' + i.id" />
          </button>
        </li>
      }
    </ul>

    <brn-dialog (closed)="onClosed()">
      <ng-template brnDialogContent>
        @if (selected(); as i) {
          @let s = status();
          <div
            class="aeci-drawer-panel fixed inset-y-0 end-0 z-50 flex w-[min(46rem,100vw)] flex-col border-s border-(--border-default) bg-(--surface-base) text-(--text-primary) shadow-2xl"
          >
            <header class="shrink-0 border-b border-(--border-default) px-6 py-4">
              <div class="flex items-center justify-between gap-3">
                <p class="text-xs text-(--text-secondary)">
                  Integration {{ position() }} of {{ total() }}
                </p>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    [class]="iconButton"
                    (click)="step(-1)"
                    [disabled]="position() === 1"
                    aria-label="Previous integration"
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
                  </button>
                  <button
                    type="button"
                    [class]="iconButton"
                    (click)="step(1)"
                    [disabled]="position() === total()"
                    aria-label="Next integration"
                    data-testid="next"
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
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </button>
                  <button brnDialogClose type="button" [class]="iconButton" aria-label="Close">
                    <svg
                      aria-hidden="true"
                      class="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                    >
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <h2 brnDialogTitle class="im-h2 mt-2 text-(--text-primary)">
                {{ viewer }} and {{ i.other.name }}
              </h2>
              <div brnDialogDescription class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <aec-im-pill [label]="s.label" [tone]="s.tone" />
                <span class="text-sm text-(--text-secondary)">{{ s.explain }}</span>
              </div>
              <a
                [href]="publicHref()"
                target="_blank"
                rel="noopener"
                class="mt-2 inline-flex items-center gap-1 text-sm font-medium text-(--accent-primary) hover:underline"
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
            </header>

            <div #scroller class="min-h-0 flex-1 overflow-y-auto">
              <nav
                aria-label="Sections"
                class="sticky top-0 z-10 border-b border-(--border-default) bg-(--surface-base) px-6 py-2"
              >
                <ul class="flex list-none flex-wrap gap-1 p-0">
                  @for (n of nav(); track n.key) {
                    <li>
                      <button
                        type="button"
                        class="rounded-(--radius-sm) px-2.5 py-1.5 text-sm text-(--text-secondary) hover:bg-(--surface-sunken) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-(--accent-primary)"
                        [attr.aria-current]="active() === n.key ? 'true' : null"
                        [class.font-semibold]="active() === n.key"
                        (click)="jump(n.key)"
                      >
                        {{ n.label }}
                      </button>
                    </li>
                  }
                </ul>
              </nav>

              <div class="space-y-10 px-6 py-6">
                <section [id]="'im-b-overview'" aria-labelledby="im-b-h-overview">
                  <h3
                    id="im-b-h-overview"
                    tabindex="-1"
                    class="im-h3 scroll-mt-16 text-(--text-primary) focus:outline-none"
                  >
                    About this integration
                  </h3>
                  <div class="mt-3"><aec-im-about [integration]="i" (goTo)="jump($event)" /></div>
                </section>
                <section [id]="'im-b-shared'" aria-labelledby="im-b-h-shared">
                  <h3
                    id="im-b-h-shared"
                    tabindex="-1"
                    class="im-h3 scroll-mt-16 text-(--text-primary) focus:outline-none"
                  >
                    What's shared ({{ i.flows.length }})
                  </h3>
                  <div class="mt-2"><aec-im-shared [integration]="i" layout="list" /></div>
                </section>
                <section [id]="'im-b-links'" aria-labelledby="im-b-h-links">
                  <h3
                    id="im-b-h-links"
                    tabindex="-1"
                    class="im-h3 scroll-mt-16 text-(--text-primary) focus:outline-none"
                  >
                    Your links
                  </h3>
                  <div class="mt-2"><aec-im-links [integration]="i" /></div>
                </section>
                <section [id]="'im-b-requests'" aria-labelledby="im-b-h-requests">
                  <h3
                    id="im-b-h-requests"
                    tabindex="-1"
                    class="im-h3 scroll-mt-16 text-(--text-primary) focus:outline-none"
                  >
                    Change requests
                  </h3>
                  <div class="mt-2"><aec-im-requests [integration]="i" /></div>
                </section>
                @if (i.owner.state === 'you-claimed') {
                  <section [id]="'im-b-settings'" aria-labelledby="im-b-h-settings">
                    <h3
                      id="im-b-h-settings"
                      tabindex="-1"
                      class="im-h3 scroll-mt-16 text-(--text-primary) focus:outline-none"
                    >
                      Retire
                    </h3>
                    <div class="mt-3"><aec-im-retire [integration]="i" /></div>
                  </section>
                }
              </div>
            </div>
          </div>
        }
      </ng-template>
    </brn-dialog>
  `,
})
export class ConceptBPanel {
  protected readonly store = inject(IntegrationManagerStore);
  private readonly dialog = viewChild(BrnDialog);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly viewer = VIEWER.product;
  protected readonly selectedId = signal<string | null>(null);
  protected readonly active = signal<SectionKey>('overview');

  protected readonly selected = computed(() => this.store.byId(this.selectedId()));
  protected readonly status = computed(() => {
    const i = this.selected();
    return i ? integrationStatus(i) : { label: '', tone: 'neutral' as const, explain: '' };
  });
  protected readonly publicHref = computed(() => {
    const i = this.selected();
    return i ? publicPageHref(i) : '#';
  });
  protected readonly total = computed(() => this.store.integrations().length);
  protected readonly position = computed(
    () => this.store.integrations().findIndex((i) => i.id === this.selectedId()) + 1,
  );
  protected readonly nav = computed<readonly NavItem[]>(() => {
    const items: NavItem[] = [
      { key: 'overview', label: 'About' },
      { key: 'shared', label: "What's shared" },
      { key: 'links', label: 'Your links' },
      { key: 'requests', label: 'Change requests' },
    ];
    if (this.selected()?.owner.state === 'you-claimed')
      items.push({ key: 'settings', label: 'Retire' });
    return items;
  });

  protected readonly iconButton =
    'inline-flex h-9 w-9 items-center justify-center rounded-(--radius-md) border border-(--border-default) text-(--text-secondary) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  protected rowClass(id: string): string {
    const base =
      'im-card block w-full cursor-pointer px-4 py-3 text-start transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return this.selectedId() === id ? `${base} im-selected` : base;
  }

  /** Called from the row click handler only (NG0602). */
  protected open(id: string): void {
    this.selectedId.set(id);
    this.active.set('overview');
    this.dialog()?.open();
  }

  protected step(delta: number): void {
    const rows = this.store.integrations();
    const next = rows[this.position() - 1 + delta];
    if (!next) return;
    this.selectedId.set(next.id);
    this.active.set('overview');
    this.store.requestFormFor.set(null);
    this.store.editingLinksFor.set(null);
    this.scroller()?.nativeElement.scrollTo({ top: 0 });
  }

  protected jump(key: SectionKey): void {
    this.active.set(key);
    // The section may have just been rendered (a form opened), so wait a frame.
    requestAnimationFrame(() => {
      const heading = this.scroller()?.nativeElement.querySelector<HTMLElement>(`#im-b-h-${key}`);
      heading?.scrollIntoView({ block: 'start' });
      // A request form that just opened takes focus itself, so leave it there.
      if (!(key === 'requests' && this.store.requestFormFor())) {
        heading?.focus({ preventScroll: true });
      }
    });
  }

  protected onClosed(): void {
    this.store.requestFormFor.set(null);
    this.store.editingLinksFor.set(null);
  }
}
