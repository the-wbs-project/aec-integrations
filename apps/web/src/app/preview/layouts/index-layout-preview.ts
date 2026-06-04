import { Component } from '@angular/core';

import { IndexLayout } from '../../layouts/index-layout';

/**
 * Dev-only preview for `IndexLayout`. Synthetic fixture rows for visual
 * review. Sort and pagination controls are static markup — interactivity
 * lives in the per-page issues.
 *
 * Route: `/preview/layouts/index`.
 */
@Component({
  selector: 'app-index-layout-preview',
  imports: [IndexLayout],
  template: `
    <aec-index-layout>
      <div slot="header" class="space-y-3">
        <p class="font-mono text-xs tracking-widest text-(--text-secondary) uppercase">Index</p>
        <h1 class="font-display text-4xl font-semibold tracking-tight md:text-5xl">Vendors</h1>
        <p class="text-(--text-secondary)">All vendors, sortable by column.</p>
      </div>

      <ng-container slot="table-header">
        <tr>
          <th scope="col" class="px-4 py-3">Name</th>
          <th scope="col" class="px-4 py-3">Category</th>
          <th scope="col" class="px-4 py-3">Integrations</th>
          <th scope="col" class="px-4 py-3 text-right">Updated</th>
        </tr>
      </ng-container>

      <ng-container slot="table-body">
        @for (row of rows; track row.name) {
          <tr class="text-(--text-primary)">
            <td class="px-4 py-3 font-medium">{{ row.name }}</td>
            <td class="px-4 py-3 text-(--text-secondary)">{{ row.category }}</td>
            <td class="px-4 py-3 text-(--text-secondary)">{{ row.count }}</td>
            <td class="px-4 py-3 text-right text-(--text-secondary)">{{ row.updated }}</td>
          </tr>
        }
      </ng-container>

      <ng-container slot="pagination">
        <p class="text-sm text-(--text-secondary)">Showing 1–4 of 4</p>
        <div class="flex gap-2 text-sm">
          <button
            type="button"
            class="rounded-md border border-(--border-default) px-3 py-1.5 text-(--text-secondary)"
            disabled
          >
            Previous
          </button>
          <button
            type="button"
            class="rounded-md border border-(--border-default) px-3 py-1.5 text-(--text-primary) hover:border-(--border-strong)"
          >
            Next
          </button>
        </div>
      </ng-container>
    </aec-index-layout>
  `,
})
export class IndexLayoutPreview {
  protected readonly rows = [
    { name: 'Acme Software', category: 'Design coordination', count: 12, updated: '2026-05-04' },
    { name: 'Beacon Labs', category: 'BIM', count: 8, updated: '2026-04-22' },
    { name: 'Cinder Tools', category: 'Estimating', count: 5, updated: '2026-03-18' },
    { name: 'Drift Studio', category: 'Field reporting', count: 3, updated: '2026-02-09' },
  ];
}
