import { Component, computed, signal } from '@angular/core';

import { ConceptFlowCanvas } from './concept-flow-canvas';
import { buildPairView, PAIR_FIXTURE, type PairState } from './integration-pair.fixtures';

/**
 * Dev-only preview for the AECI-289 integration-pair redesign (Stage 1.5). It
 * renders BOTH layers of the redesigned surface — **Layer A** (the consolidated
 * pair page: context product left / other right, per-mechanism cards with their
 * description, breadcrumb `Home › {context} › {other}`, per-product reviews
 * recap — §7) and **Layer B** (the data-flow / claim section: `data_object` rows
 * grouped by context-relative direction, the `confirmed / total` sync headline,
 * neutral "Unverified · AECi" agreement badges, and the AECi-annotated provenance
 * popover — §8). It gates the production builds AECI-294 (Layer A) and AECI-300
 * (Layer B).
 *
 * **Direction: `b · Flow canvas`** — the PO's chosen concept (sign-off
 * 2026-07-01). The two other exploration concepts (Editorial ledger, Dense data
 * table) have been removed now that the direction is set; this is the reference
 * the production build implements against. See the AECI-289 Linear issue for the
 * screens of the concepts that were considered.
 *
 * Anchor: **GitBook** editorial integration-detail, with **Customer.io**
 * ("data in ← node → data out") as the sanctioned exception for the directional
 * rail, recorded per the Anchor-Site Rule (`DESIGN.md`).
 *
 * Two toggles remain for review: `contextIsA` mirrors the page (view-from
 * A ↔ B — the §3.2 direction flip), and `state` toggles the Layer-A-only empty
 * state (Layer A ships before Layer B has claims). Both feed ONE derived `view`
 * from `buildPairView(fixture, contextIsA, state)`.
 *
 * NOT production: hardcoded fixtures, no routing/301/SEO/resolvers, no real
 * claim API/`computeAgreement`/`defaultIntegrationContext` (sibling issues), no
 * i18n (preview is exempt; literal strings). Route `/preview/integration-pair`,
 * production-blocked by `isPreviewPath` (`server-runtime.ts`). Don't link to it
 * from product navigation. The control toolbar is a dev control strip, not part
 * of the reviewed surface.
 */
@Component({
  selector: 'app-integration-pair-preview',
  imports: [ConceptFlowCanvas],
  template: `
    <!-- Dev-only controls. Not part of the surface under review. -->
    <div
      class="border-b border-(--border-default) bg-(--surface-sunken)"
      role="region"
      aria-label="Prototype controls (dev only)"
    >
      <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3 md:px-8">
        <span class="aec-overline text-(--text-secondary)">AECI-289 · Flow canvas</span>

        <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Orientation">
          <span class="aec-overline text-(--text-secondary)">View from</span>
          <button
            type="button"
            [class]="orientationClass(true)"
            [attr.aria-pressed]="contextIsA()"
            (click)="contextIsA.set(true)"
          >
            {{ productA.name }}
          </button>
          <button
            type="button"
            [class]="orientationClass(false)"
            [attr.aria-pressed]="!contextIsA()"
            (click)="contextIsA.set(false)"
          >
            {{ productB.name }}
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Data state">
          <span class="aec-overline text-(--text-secondary)">Data</span>
          <button
            type="button"
            [class]="stateClass('populated')"
            [attr.aria-pressed]="state() === 'populated'"
            (click)="state.set('populated')"
          >
            Populated
          </button>
          <button
            type="button"
            [class]="stateClass('empty')"
            [attr.aria-pressed]="state() === 'empty'"
            (click)="state.set('empty')"
          >
            Empty (Layer A)
          </button>
        </div>
      </div>
    </div>

    <app-ip-concept-flow [view]="view()" />
  `,
})
export class IntegrationPairPreview {
  /** true = view from product A (Revit); false = product B (Procore). Drives the §3.2 mirror. */
  protected readonly contextIsA = signal(true);
  protected readonly state = signal<PairState>('populated');

  protected readonly productA = PAIR_FIXTURE.productA;
  protected readonly productB = PAIR_FIXTURE.productB;

  /** The single derived view — mirror + grouping live in the fixtures builder. */
  protected readonly view = computed(() =>
    buildPairView(PAIR_FIXTURE, this.contextIsA(), this.state()),
  );

  protected orientationClass(isA: boolean): string {
    return this.toggleClass(this.contextIsA() === isA);
  }
  protected stateClass(s: PairState): string {
    return this.toggleClass(this.state() === s);
  }

  /** Active/idle classes for a dev toggle (token classes can't be `[class.x]` keys). */
  private toggleClass(active: boolean): string {
    const base =
      'rounded-(--radius-sm) border px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return active
      ? `${base} border-(--accent-primary) text-(--accent-primary)`
      : `${base} border-(--border-default) text-(--text-secondary) hover:text-(--text-primary)`;
  }
}
