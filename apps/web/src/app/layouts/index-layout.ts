import { Component } from '@angular/core';

/**
 * Index layout shell — projected into by product, vendor, and integration
 * index pages (table-style listings). Named slots only; no state. Sort and
 * pagination interactivity live in the per-page issues.
 *
 * Anchor: Stripe (inherited from AECi site chrome). See `DESIGN.md`
 * §"Named Rules" → "The Anchor-Site Rule".
 *
 * Spec: Phase 2 Spec §11.1 (`docs/STAGE_1_PHASE_2_SPEC.md:423`).
 *
 * Slots:
 *   - `header`       — page title / counts / inline actions (required)
 *   - `table-header` — `<thead>` row with sortable column headers
 *   - `table-body`   — `<tbody>` of result rows
 *   - `pagination`   — pagination controls below the table
 *
 * The table is wrapped in a horizontally-scrollable container on `< md` so
 * column counts above ~5 stay legible on phones.
 *
 * Usage:
 * ```html
 * <aec-index-layout>
 *   <header slot="header">…</header>
 *   <ng-container slot="table-header">
 *     <tr><th scope="col">Name</th>…</tr>
 *   </ng-container>
 *   <ng-container slot="table-body">
 *     <tr><td>…</td></tr>
 *   </ng-container>
 *   <nav slot="pagination">…</nav>
 * </aec-index-layout>
 * ```
 */
@Component({
  selector: 'aec-index-layout',
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
        <header class="mb-8 border-b border-(--border-default) pb-6 md:mb-12 md:pb-8">
          <ng-content select="[slot=header]" />
        </header>

        <div class="-mx-6 overflow-x-auto md:mx-0">
          <table
            class="w-full min-w-[40rem] border-collapse text-start text-sm"
            i18n-aria-label="@@app.layouts.index.table.aria"
            aria-label="Results table"
          >
            <thead
              class="border-b border-(--border-default) text-xs font-medium tracking-wide text-(--text-secondary)"
            >
              <ng-content select="[slot=table-header]" />
            </thead>
            <tbody class="divide-y divide-(--border-default)">
              <ng-content select="[slot=table-body]" />
            </tbody>
          </table>
        </div>

        <nav
          class="mt-8 flex items-center justify-between border-t border-(--border-default) pt-6"
          i18n-aria-label="@@app.layouts.index.pagination.aria"
          aria-label="Pagination"
        >
          <ng-content select="[slot=pagination]" />
        </nav>
      </div>
    </div>
  `,
})
export class IndexLayout {}
