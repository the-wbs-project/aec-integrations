import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Tab, TabContent, TabList, TabPanel, Tabs } from '@angular/aria/tabs';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import { ImAbout, ImLinks, ImRequests, ImRetire, ImShared } from './im-sections';
import { BTN_SECONDARY, IM_STYLES, ImPairMark, ImPill } from './im-ui';
import { ImRowSummary } from './im-row-summary';
import {
  VIEWER,
  integrationStatus,
  openRequests,
  publicPageHref,
  type SectionKey,
} from './integration-manager.fixtures';
import { IntegrationManagerStore } from './integration-manager.store';

type DialogTab = 'overview' | 'shared' | 'requests';

/**
 * Concept A, "Tabbed dialog" (Chris's suggestion). The list is compact rows: the
 * product, one plain status, what is shared, and a Manage button. Manage opens a
 * large dialog with a header (both products, the status, View public page) and
 * three tabs: Overview, What's shared, Change requests.
 *
 * The dialog is opened from the click handler, never from an effect (NG0602, the
 * vendor-seat-invite-dialog note). BrnDialog gives the focus trap, Escape, and
 * focus return to the Manage button. The tabs are Angular Aria; ngTabContent does
 * not render during SSR (ADR 0010), which is fine for a dialog the client opens.
 */
@Component({
  selector: 'aec-im-concept-a',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BrnDialog,
    BrnDialogClose,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    Tab,
    TabContent,
    TabList,
    TabPanel,
    Tabs,
    ImAbout,
    ImLinks,
    ImRequests,
    ImRetire,
    ImShared,
    ImPairMark,
    ImPill,
    ImRowSummary,
  ],
  styles: [IM_STYLES],
  template: `
    <h2 class="im-h2 text-(--text-primary)">Integrations</h2>
    <p class="mt-1 max-w-prose text-sm text-(--text-secondary)">
      Every product {{ viewer }} connects to. Open one to check what is shared and fix anything that
      is wrong.
    </p>

    <ul class="im-card mt-6 list-none divide-y divide-(--border-default) p-0">
      @for (i of store.integrations(); track i.id) {
        <li class="flex flex-wrap items-center gap-4 px-5 py-4">
          <aec-im-row-summary class="flex-1" [integration]="i" [nameId]="'im-a-name-' + i.id" />
          <button
            type="button"
            [class]="secondary"
            [attr.aria-label]="'Manage ' + i.other.name"
            (click)="open(i.id)"
            [attr.data-testid]="'manage-' + i.id"
          >
            Manage
          </button>
        </li>
      }
    </ul>

    <brn-dialog (closed)="onClosed()">
      <ng-template brnDialogContent>
        @if (selected(); as i) {
          @let s = status();
          <div
            class="flex h-[min(88vh,52rem)] w-[min(94vw,62rem)] flex-col overflow-hidden rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) text-(--text-primary) shadow-xl"
          >
            <header class="shrink-0 px-6 pt-5 md:px-8">
              <div class="flex items-start justify-between gap-4">
                <div class="flex min-w-0 items-start gap-4">
                  <aec-im-pair-mark [left]="viewer" [right]="i.other.name" />
                  <div class="min-w-0">
                    <h2 brnDialogTitle class="im-h2 text-(--text-primary)">
                      {{ viewer }} and {{ i.other.name }}
                    </h2>
                    <div
                      brnDialogDescription
                      class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"
                    >
                      <aec-im-pill [label]="s.label" [tone]="s.tone" />
                      <span class="text-sm text-(--text-secondary)">{{ s.explain }}</span>
                    </div>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <a
                    [href]="publicHref()"
                    target="_blank"
                    rel="noopener"
                    class="inline-flex items-center gap-1 rounded-(--radius-sm) px-2 py-1 text-sm font-medium text-(--accent-primary) hover:underline focus-visible:outline-2 focus-visible:outline-(--accent-primary)"
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
                  <button
                    brnDialogClose
                    type="button"
                    aria-label="Close"
                    class="inline-flex h-9 w-9 items-center justify-center rounded-(--radius-md) border border-(--border-default) text-(--text-secondary) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
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
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            </header>

            <div ngTabs class="flex min-h-0 flex-1 flex-col">
              <ul
                ngTabList
                [selectedTab]="tab()"
                (selectedTabChange)="selectTab($event)"
                aria-label="Integration details"
                class="mt-5 flex shrink-0 list-none gap-6 border-b border-(--border-default) p-0 px-6 md:px-8"
              >
                <li
                  ngTab
                  value="overview"
                  class="im-tab cursor-pointer px-1 pb-3 text-sm font-medium text-(--text-secondary) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--accent-primary)"
                >
                  Overview
                </li>
                <li
                  ngTab
                  value="shared"
                  class="im-tab cursor-pointer px-1 pb-3 text-sm font-medium text-(--text-secondary) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--accent-primary)"
                >
                  What's shared ({{ i.flows.length }})
                </li>
                <li
                  ngTab
                  value="requests"
                  class="im-tab cursor-pointer px-1 pb-3 text-sm font-medium text-(--text-secondary) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--accent-primary)"
                >
                  Change requests
                  @if (openCount() > 0) {
                    <span
                      class="ms-1 rounded-(--radius-pill) bg-(--surface-sunken) px-1.5 py-0.5 text-xs text-(--text-primary)"
                      >{{ openCount() }} open</span
                    >
                  }
                </li>
              </ul>
              <div class="min-h-0 flex-1 overflow-y-auto px-6 py-6 md:px-8">
                <section ngTabPanel value="overview">
                  <ng-template ngTabContent>
                    <h3 class="im-h3 text-(--text-primary)">About this integration</h3>
                    <div class="mt-3"><aec-im-about [integration]="i" (goTo)="go($event)" /></div>
                    <h3 class="im-h3 mt-8 text-(--text-primary)">Your links</h3>
                    <div class="mt-3"><aec-im-links [integration]="i" /></div>
                    @if (i.owner.state === 'you-claimed') {
                      <h3 class="im-h3 mt-8 text-(--text-primary)">Retire</h3>
                      <div class="mt-3"><aec-im-retire [integration]="i" /></div>
                    }
                  </ng-template>
                </section>
                <section ngTabPanel value="shared">
                  <ng-template ngTabContent>
                    <h3 class="im-h3 text-(--text-primary)">
                      What's shared ({{ i.flows.length }})
                    </h3>
                    <div class="mt-2"><aec-im-shared [integration]="i" /></div>
                  </ng-template>
                </section>
                <section ngTabPanel value="requests">
                  <ng-template ngTabContent>
                    <h3 class="im-h3 text-(--text-primary)">Change requests</h3>
                    <div class="mt-2"><aec-im-requests [integration]="i" /></div>
                  </ng-template>
                </section>
              </div>
            </div>
          </div>
        }
      </ng-template>
    </brn-dialog>
  `,
})
export class ConceptADialog {
  protected readonly store = inject(IntegrationManagerStore);
  private readonly dialog = viewChild(BrnDialog);

  protected readonly viewer = VIEWER.product;
  protected readonly secondary = BTN_SECONDARY;
  protected readonly selectedId = signal<string | null>(null);
  protected readonly tab = signal<DialogTab>('overview');

  protected readonly selected = computed(() => this.store.byId(this.selectedId()));
  protected readonly status = computed(() => {
    const i = this.selected();
    return i ? integrationStatus(i) : { label: '', tone: 'neutral' as const, explain: '' };
  });
  protected readonly openCount = computed(() => {
    const i = this.selected();
    return i ? openRequests(i).length : 0;
  });
  protected readonly publicHref = computed(() => {
    const i = this.selected();
    return i ? publicPageHref(i) : '#';
  });

  /** Called from the Manage click handler only (NG0602). */
  protected open(id: string): void {
    this.selectedId.set(id);
    this.tab.set('overview');
    this.dialog()?.open();
  }

  protected selectTab(value: string | undefined): void {
    this.tab.set(value === 'shared' || value === 'requests' ? value : 'overview');
  }

  protected go(section: SectionKey): void {
    if (section === 'shared' || section === 'requests') this.tab.set(section);
    else this.tab.set('overview');
  }

  protected onClosed(): void {
    this.store.requestFormFor.set(null);
    this.store.editingLinksFor.set(null);
  }
}
