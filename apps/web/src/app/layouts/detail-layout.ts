import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Detail layout shell — projected into by product, vendor, and integration
 * detail pages. Named slots only; no state, no inputs. Concrete page issues
 * project body content via `slot="*"` attributes (shadcn-style composition).
 *
 * Anchor: Stripe (inherited from AECi site chrome, `apps/web/src/app/layout/
 * site-header.ts`). See `DESIGN.md` §"Named Rules" → "The Anchor-Site Rule".
 *
 * Spec: Phase 2 Spec §11.1 (`docs/STAGE_1_PHASE_2_SPEC.md:423`).
 *
 * Slots:
 *   - `breadcrumbs` — top-of-page breadcrumb trail (optional)
 *   - `hero`        — name, vendor, key facts (required)
 *   - `metadata`    — right-column metadata sidebar (collapses below hero on
 *                     `< md`)
 *   - `body`        — vertically stacked body sections (required)
 *
 * Usage:
 * ```html
 * <aec-detail-layout>
 *   <nav slot="breadcrumbs">…</nav>
 *   <header slot="hero">…</header>
 *   <aside slot="metadata">…</aside>
 *   <section slot="body">…</section>
 * </aec-detail-layout>
 * ```
 */
@Component({
  selector: 'aec-detail-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
        <nav
          class="mb-6"
          i18n-aria-label="@@app.layouts.detail.breadcrumbs.aria"
          aria-label="Breadcrumb"
        >
          <ng-content select="[slot=breadcrumbs]" />
        </nav>

        <header class="mb-8 border-b border-(--border-default) pb-8 md:mb-12 md:pb-12">
          <ng-content select="[slot=hero]" />
        </header>

        <div class="grid gap-8 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] md:gap-12">
          <!-- Plain <div>: the app shell (app.ts) already provides <main id="main"> wrapping
               the router outlet. Using <main> here would create a duplicate main landmark. -->
          <div class="min-w-0 space-y-12">
            <ng-content select="[slot=body]" />
          </div>

          <aside
            class="space-y-6 md:sticky md:top-8 md:self-start"
            i18n-aria-label="@@app.layouts.detail.metadata.aria"
            aria-label="Metadata"
          >
            <ng-content select="[slot=metadata]" />
          </aside>
        </div>
      </div>
    </div>
  `,
})
export class DetailLayout {}
