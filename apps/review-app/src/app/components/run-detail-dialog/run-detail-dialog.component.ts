// ---------------------------------------------------------------------------
// Shared "Run details" dialog used by the notifications bell and the /runs page.
//
// Inputs: a RecentRunRow (or null to hide). Emits `closed` when the user
// dismisses the dialog. Renders the run's metadata, links the record to its
// detail page, and pretty-prints any error / output payload.
// ---------------------------------------------------------------------------
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule, DatePipe, JsonPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DialogModule } from '@syncfusion/ej2-angular-popups';
import { RunsService, type RecentRunRow } from '../../services/runs.service';
import { ModelService, MODEL_OPTIONS } from '../../services/model.service';
import { WORKFLOWS } from '../../workflows';

interface NormalizedError {
  name?: string;
  message?: string;
  stack?: string;
  raw?: unknown;
}

@Component({
  selector: 'app-run-detail-dialog',
  standalone: true,
  imports: [CommonModule, RouterLink, DialogModule, DatePipe, JsonPipe],
  templateUrl: './run-detail-dialog.component.html',
  styleUrl: './run-detail-dialog.component.scss',
})
export class RunDetailDialogComponent {
  private readonly runs = inject(RunsService);
  private readonly modelService = inject(ModelService);

  readonly run = input<RecentRunRow | null>(null);
  readonly closed = output<void>();

  protected readonly rerunning = signal(false);

  protected readonly workflowTitle = computed(() => {
    const slug = this.run()?.workflow;
    if (!slug) return '';
    return WORKFLOWS.find((w) => w.slug === slug)?.title ?? slug;
  });

  protected readonly currentModelLabel = computed(() => {
    const id = this.modelService.selected();
    return MODEL_OPTIONS.find((m) => m.id === id)?.label ?? id;
  });

  /** /vendors/:id or /tools/:id, or null if the workflow family is unknown. */
  protected readonly recordLink = computed<string[] | null>(() => {
    const r = this.run();
    if (!r) return null;
    const family = WORKFLOWS.find((w) => w.slug === r.workflow)?.family;
    if (family === 'vendor') return ['/vendors', r.recordId];
    if (family === 'tool') return ['/tools', r.recordId];
    return null;
  });

  protected readonly normalizedError = computed<NormalizedError | null>(() => {
    const e = this.run()?.error;
    if (e == null) return null;
    if (typeof e === 'string') return { message: e };
    if (typeof e === 'object') {
      const obj = e as Record<string, unknown>;
      const name = typeof obj['name'] === 'string' ? (obj['name'] as string) : undefined;
      const message = typeof obj['message'] === 'string' ? (obj['message'] as string) : undefined;
      const stack = typeof obj['stack'] === 'string' ? (obj['stack'] as string) : undefined;
      if (name || message || stack) return { name, message, stack, raw: e };
      return { raw: e };
    }
    return { message: String(e) };
  });

  protected onClose(): void {
    this.closed.emit();
  }

  protected runAgain(): void {
    const r = this.run();
    if (!r || this.rerunning()) return;
    this.rerunning.set(true);
    this.runs.startRun(r.workflow, {
      record_ids: [r.recordId],
      model: this.modelService.selected(),
      // Mirror the original run's force_refresh; orchestrator runs on detail
      // pages used true to bypass staleness, so preserving the flag matches
      // the user's last intent.
      force_refresh: r.forceRefresh === true,
    });
    // Close so the bell / runs list takes over; the new run streams in via WS.
    this.closed.emit();
  }
}
