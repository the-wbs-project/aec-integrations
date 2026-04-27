// ---------------------------------------------------------------------------
// Runs history — full list of recent workflow runs surfaced by RunsService.
//
// Uses Syncfusion Grid for sorting, filtering, and pagination. The grid is
// bound to the in-memory list maintained by RunsService (which polls
// /api/runs/recent in the background), so it stays live while the page is open.
// ---------------------------------------------------------------------------
import { Component, inject, signal, OnInit } from '@angular/core';
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
