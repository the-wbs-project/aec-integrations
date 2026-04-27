// ---------------------------------------------------------------------------
// Runs history — full list of recent workflow runs surfaced by RunsService.
//
// Uses Syncfusion Grid for sorting, filtering, and pagination. The grid is
// bound to the in-memory list maintained by RunsService (which polls
// /api/runs/recent in the background), so it stays live while the page is open.
// ---------------------------------------------------------------------------
import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule, DatePipe, JsonPipe } from '@angular/common';
import { GridModule, PageService, SortService, FilterService } from '@syncfusion/ej2-angular-grids';
import { DialogModule } from '@syncfusion/ej2-angular-popups';
import { RunsService, type RecentRunRow } from '../../services/runs.service';
import { WORKFLOWS } from '../../workflows';

interface RunsRow {
  runId: string;
  workflow: string;
  workflowTitle: string;
  recordId: string;
  recordLabel?: string;
  startedAt: Date;
  status: string;
  raw: RecentRunRow;
}

@Component({
  selector: 'app-runs-page',
  imports: [CommonModule, GridModule, DialogModule, DatePipe, JsonPipe],
  providers: [PageService, SortService, FilterService],
  template: `
    <div class="page-container--wide">
      <div class="page-header">
        <h1 class="page-heading">Workflow runs</h1>
        <button class="btn btn--ghost btn--sm" (click)="runs.refresh()">Refresh</button>
      </div>

      <ejs-grid
        [dataSource]="rows()"
        [allowPaging]="true"
        [pageSettings]="{ pageSize: 25 }"
        [allowSorting]="true"
        [allowFiltering]="true"
        [filterSettings]="{ type: 'Excel' }"
        height="560"
        (rowSelected)="onRowSelected($event)"
      >
        <e-columns>
          <e-column field="workflowTitle" headerText="Workflow" width="220"></e-column>
          <e-column field="recordLabel" headerText="Record" width="220"></e-column>
          <e-column field="status" headerText="Status" width="120">
            <ng-template #template let-data>
              <span class="status-pill" [attr.data-status]="data.status">{{ data.status }}</span>
            </ng-template>
          </e-column>
          <e-column field="startedAt" headerText="Started" width="180" type="dateTime" format="MMM d, y, h:mm a"></e-column>
          <e-column field="runId" headerText="Run ID" width="280"></e-column>
        </e-columns>
      </ejs-grid>

      <ejs-dialog
        [visible]="!!selected()"
        [isModal]="true"
        [closeOnEscape]="true"
        header="Run details"
        width="640px"
        (close)="selected.set(null)"
      >
        @if (selected(); as s) {
          <div class="run-detail">
            <dl class="run-detail__grid">
              <dt>Workflow</dt><dd>{{ s.workflowTitle }}</dd>
              <dt>Record</dt><dd>{{ s.recordLabel || s.recordId }} <code>({{ s.recordId }})</code></dd>
              <dt>Started</dt><dd>{{ s.startedAt | date:'medium' }}</dd>
              <dt>Status</dt><dd><span class="status-pill" [attr.data-status]="s.status">{{ s.status }}</span></dd>
              <dt>Run ID</dt><dd><code>{{ s.runId }}</code></dd>
            </dl>

            @if (s.raw.error) {
              <h4 class="run-detail__h4">Error</h4>
              <pre class="run-detail__pre">{{ s.raw.error | json }}</pre>
            }
            @if (s.raw.output) {
              <h4 class="run-detail__h4">Output</h4>
              <pre class="run-detail__pre">{{ s.raw.output | json }}</pre>
            }
          </div>
        }
      </ejs-dialog>
    </div>
  `,
  styles: `
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-5);
    }
    .page-heading {
      font-size: var(--text-xl);
      font-weight: 500;
      color: var(--color-text-primary);
      margin: 0;
    }

    .status-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--color-bg-recessed);
      color: var(--color-text-secondary);
      border: 0.5px solid var(--color-border-default);
    }
    .status-pill[data-status='complete'] { background: var(--color-success-bg); color: var(--color-success); border-color: transparent; }
    .status-pill[data-status='running'],
    .status-pill[data-status='queued'],
    .status-pill[data-status='waiting'],
    .status-pill[data-status='paused'],
    .status-pill[data-status='waitingForPause'] { background: var(--color-info-bg); color: var(--color-info); border-color: transparent; }
    .status-pill[data-status='errored'],
    .status-pill[data-status='terminated'] { background: var(--color-danger-bg); color: var(--color-danger); border-color: transparent; }

    .run-detail__grid { display: grid; grid-template-columns: 100px 1fr; gap: 6px 12px; margin: 0 0 16px; }
    .run-detail__grid dt { color: var(--color-text-secondary); font-size: var(--text-xs, 12px); }
    .run-detail__grid dd { margin: 0; font-size: var(--text-sm, 13px); }
    .run-detail__h4 { margin: 12px 0 6px; font-size: var(--text-sm, 13px); }
    .run-detail__pre {
      background: var(--color-bg-recessed);
      border: 0.5px solid var(--color-border-default);
      border-radius: 6px;
      padding: 10px;
      font-size: 12px;
      overflow: auto;
      max-height: 220px;
    }
  `,
})
export class RunsPage implements OnInit {
  protected runs = inject(RunsService);

  protected readonly selected = signal<RunsRow | null>(null);

  /** Computed grid rows derived from the live RecentRunRow list. */
  protected readonly rows = (): RunsRow[] =>
    this.runs.runs().map((r) => ({
      runId: r.runId,
      workflow: r.workflow,
      workflowTitle: WORKFLOWS.find((w) => w.slug === r.workflow)?.title ?? r.workflow,
      recordId: r.recordId,
      recordLabel: r.recordLabel ?? r.recordId,
      startedAt: new Date(r.startedAt),
      status: r.status,
      raw: r,
    }));

  ngOnInit(): void {
    this.runs.start();
    this.runs.refresh();
  }

  onRowSelected(args: { data?: RunsRow }): void {
    if (args.data) this.selected.set(args.data);
  }
}
