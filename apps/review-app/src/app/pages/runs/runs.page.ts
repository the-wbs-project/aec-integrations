// ---------------------------------------------------------------------------
// Runs history — full list of recent workflow runs surfaced by RunsService.
//
// Uses Syncfusion Grid for sorting, filtering, and pagination. The grid is
// bound to the in-memory list maintained by RunsService (which subscribes to
// /api/runs/ws in the background), so it stays live while the page is open.
// ---------------------------------------------------------------------------
import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GridModule, PageService, SortService, FilterService } from '@syncfusion/ej2-angular-grids';
import { RunsService, type RecentRunRow } from '../../services/runs.service';
import { WORKFLOWS } from '../../workflows';
import { RunDetailDialogComponent } from '../../components/run-detail-dialog/run-detail-dialog.component';

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
  imports: [CommonModule, GridModule, RunDetailDialogComponent],
  providers: [PageService, SortService, FilterService],
  templateUrl: './runs.page.html',
  styleUrl: './runs.page.scss',
})
export class RunsPage implements OnInit {
  protected runs = inject(RunsService);

  // Track which run the dialog is bound to by id and resolve against the live
  // runs list so status / output deltas pushed over the WebSocket flow into
  // the open dialog without needing a per-run subscription.
  protected readonly selectedRunId = signal<string | null>(null);
  protected readonly selectedRun = computed<RecentRunRow | null>(() => {
    const id = this.selectedRunId();
    if (!id) return null;
    return this.runs.runs().find((r) => r.runId === id) ?? null;
  });

  /** Computed grid rows derived from the live RecentRunRow list. */
  protected readonly rows = computed<RunsRow[]>(() =>
    this.runs.runs().map((r) => ({
      runId: r.runId,
      workflow: r.workflow,
      workflowTitle: WORKFLOWS.find((w) => w.slug === r.workflow)?.title ?? r.workflow,
      recordId: r.recordId,
      recordLabel: r.recordLabel ?? r.recordId,
      startedAt: new Date(r.startedAt),
      status: r.status,
      raw: r,
    })),
  );

  ngOnInit(): void {
    this.runs.start();
  }

  onRowSelected(args: { data?: RunsRow }): void {
    if (args.data) this.selectedRunId.set(args.data.runId);
  }

  onDialogClosed(): void {
    this.selectedRunId.set(null);
  }
}
