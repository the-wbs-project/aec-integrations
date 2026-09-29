import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { ConceptADialog } from './concept-a-dialog';
import { ConceptBPanel } from './concept-b-panel';
import { ConceptCPage } from './concept-c-page';
import { ConceptCurrent } from './concept-current';
import { ConceptDInline } from './concept-d-inline';
import { IM_STYLES } from './im-ui';
import { VIEWER } from './integration-manager.fixtures';
import { IntegrationManagerStore } from './integration-manager.store';

type Concept = 'current' | 'a' | 'b' | 'c' | 'd';

const CONCEPTS: ReadonlyArray<{ key: Concept; label: string }> = [
  { key: 'current', label: 'Current' },
  { key: 'a', label: 'A · Tabbed dialog' },
  { key: 'b', label: 'B · Side panel' },
  { key: 'c', label: 'C · Detail page' },
  { key: 'd', label: 'D · Organized inline' },
];

function conceptFrom(value: string | null): Concept {
  return CONCEPTS.some((c) => c.key === value) ? (value as Concept) : 'current';
}

/**
 * Dev-only design exploration for the vendor portal's per-integration panel
 * (`/vendor/:vendorSlug/products/:productSlug/integrations`). Chris found today's
 * panel unusable for its real audience, marketing and product people who manage a
 * company's listing, and asked to see several redesigns he can switch between
 * live. This is that, not a production change: nothing here calls the API, and
 * the real portal components are untouched.
 *
 * Route `/preview/integration-manager`, blocked on the public tiers by
 * `isPreviewPath` (`server-runtime.ts`). `?concept=` picks the concept
 * (current, a, b, c, d), and `?concept=c&open=<id>` opens C's detail page. The
 * top strip is a dev control, not part of the surface under review.
 *
 * Concepts: Current (a static recreation of today's Navisworks panel), A Tabbed
 * dialog, B Side panel, C Detail page, D Organized inline. A to D share one set
 * of plain-language copy and section components (`im-sections.ts`), so the
 * comparison is about organization, not wording.
 *
 * ── ANCHOR (the Anchor-Site Rule, DESIGN.md) ─────────────────────────────────
 * Shopify admin: an admin used daily by non-technical merchants and marketers,
 * which is this surface's audience. Screens referenced on Mobbin:
 *
 * - Settings, Checkout: a sectioned settings page with a left nav, bordered
 *   cards, an "Active" status pill and an "Added: date at time" line.
 *   https://mobbin.com/screens/ba4fab9c-c0f1-4d3c-95fc-e3da88b4ee7a
 *   Drives C's layout, the definition-list cards, and the dated lines.
 * - Order #1003 detail: a header with the title, status pills, actions, and up
 *   and down arrows that step to the previous or next order.
 *   https://mobbin.com/screens/c34ee356-bb38-4dac-9a12-a36c5e46194e
 *   Drives the dialog and sheet headers, and B's Previous / Next.
 * - Order timeline: a dated rail of events, each a plain sentence, with notes.
 *   https://mobbin.com/screens/dbc52bdd-959b-4832-8895-1c9e80e529a6
 *   Drives the Change requests history.
 *
 * The anchor supplies structure only. Tokens, type and colour stay AECi's
 * (light only, borders not shadows, Source Serif headings), so the portal still
 * reads as the same publication as the public directory.
 */
@Component({
  selector: 'app-integration-manager-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConceptADialog, ConceptBPanel, ConceptCPage, ConceptCurrent, ConceptDInline],
  styles: [IM_STYLES],
  template: `
    <!-- Dev-only controls. Not part of the surface under review. -->
    <div
      class="border-b border-(--border-default) bg-(--surface-sunken)"
      role="region"
      aria-label="Concept switcher (dev only)"
    >
      <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 md:px-8">
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Concept">
          <span class="aec-overline text-(--text-secondary)">Integration manager</span>
          @for (c of concepts; track c.key) {
            <button
              type="button"
              [class]="toggleClass(concept() === c.key)"
              [attr.aria-pressed]="concept() === c.key"
              (click)="setConcept(c.key)"
              [attr.data-testid]="'concept-' + c.key"
            >
              {{ c.label }}
            </button>
          }
        </div>
        @if (concept() !== 'current') {
          <div
            class="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Navisworks owner request"
          >
            <span class="aec-overline text-(--text-secondary)">Navisworks owner request</span>
            <button
              type="button"
              [class]="toggleClass(store.ownerRequestSent())"
              [attr.aria-pressed]="store.ownerRequestSent()"
              (click)="store.ownerRequestSent.set(true)"
            >
              Sent
            </button>
            <button
              type="button"
              [class]="toggleClass(!store.ownerRequestSent())"
              [attr.aria-pressed]="!store.ownerRequestSent()"
              (click)="store.ownerRequestSent.set(false)"
            >
              Not sent
            </button>
          </div>
        }
      </div>
    </div>

    <p role="status" class="sr-only">{{ store.announcement() }}</p>

    <div class="mx-auto max-w-7xl px-6 py-8 md:px-8 md:py-10">
      <nav aria-label="Breadcrumb" class="text-sm text-(--text-secondary)">
        <ol class="flex list-none flex-wrap items-center gap-2 p-0">
          <li>Vendor</li>
          <li aria-hidden="true">›</li>
          <li>{{ viewer.vendor }}</li>
          <li aria-hidden="true">›</li>
          <li>Products</li>
          <li aria-hidden="true">›</li>
          <li class="text-(--text-primary)" aria-current="page">{{ viewer.product }}</li>
        </ol>
      </nav>
      <h1 class="im-h1 mt-3 text-(--text-primary)">{{ viewer.product }}</h1>
      <div class="mt-4 flex gap-6 border-b border-(--border-default) text-sm" aria-hidden="true">
        <span class="pb-3 text-(--text-secondary)">Profile</span>
        <span class="pb-3 text-(--text-secondary)">Categories</span>
        <span class="pb-3 text-(--text-secondary)">Trades</span>
        <span
          class="-mb-px border-b-2 pb-3 font-semibold text-(--text-primary)"
          style="border-bottom-color: var(--accent-primary)"
          >Integrations</span
        >
      </div>

      <div class="mt-8">
        @switch (concept()) {
          @case ('a') {
            <aec-im-concept-a />
          }
          @case ('b') {
            <aec-im-concept-b />
          }
          @case ('c') {
            <aec-im-concept-c [openId]="openId()" />
          }
          @case ('d') {
            <aec-im-concept-d />
          }
          @default {
            <aec-im-concept-current />
          }
        }
      </div>
    </div>
  `,
})
export class IntegrationManagerPreview {
  protected readonly store = inject(IntegrationManagerStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  private readonly params = toSignal(this.route.queryParamMap, {
    initialValue: this.route.snapshot.queryParamMap,
  });

  protected readonly concepts = CONCEPTS;
  protected readonly viewer = VIEWER;
  protected readonly concept = computed(() => conceptFrom(this.params().get('concept')));
  protected readonly openId = toSignal(this.route.queryParamMap.pipe(map((p) => p.get('open'))), {
    initialValue: this.route.snapshot.queryParamMap.get('open'),
  });

  protected setConcept(key: Concept): void {
    this.store.requestFormFor.set(null);
    this.store.editingLinksFor.set(null);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { concept: key, open: null },
      queryParamsHandling: 'merge',
    });
  }

  protected toggleClass(active: boolean): string {
    const base =
      'rounded-(--radius-sm) border px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return active
      ? `${base} im-selected text-(--accent-primary)`
      : `${base} border-(--border-default) text-(--text-secondary) hover:text-(--text-primary)`;
  }
}
