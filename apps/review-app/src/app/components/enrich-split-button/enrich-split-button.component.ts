// ---------------------------------------------------------------------------
// Enrich split-button.
//
// Used in two places:
//   1. Detail headers (vendor / tool) — `recordIds` is a 1-element array, the
//      button kicks off the orchestrator on that record. Caret reveals every
//      sub-workflow filtered to the current family.
//   2. List toolbars — `recordIds` is the user's row selection. If empty,
//      `filteredIds` is used instead and a confirmation dialog asks before
//      we run on every filtered row.
//
// Both modes route through the same RunsService.startRun() call so the bell
// picks up the new run IDs automatically.
// ---------------------------------------------------------------------------
import { Component, inject, input, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SplitButtonModule, type ItemModel } from '@syncfusion/ej2-angular-splitbuttons';
import { DialogModule } from '@syncfusion/ej2-angular-popups';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import { RunsService } from '../../services/runs.service';
import { WORKFLOWS, type WorkflowMeta } from '../../workflows';

export type EnrichFamily = 'vendor' | 'tool';

@Component({
  selector: 'app-enrich-split-button',
  imports: [CommonModule, SplitButtonModule, DialogModule, ButtonModule],
  template: `
    <ejs-splitbutton
      [content]="primaryLabel()"
      [items]="menuItems()"
      [disabled]="disabled()"
      cssClass="e-primary"
      (click)="runOrchestrator()"
      (select)="onMenuSelect($event)"
    ></ejs-splitbutton>

    <ejs-dialog
      [visible]="confirming() !== null"
      [isModal]="true"
      [closeOnEscape]="true"
      header="Confirm bulk run"
      width="420px"
      (close)="confirming.set(null)"
    >
      @if (confirming(); as c) {
        <p>Run <strong>{{ workflowTitle(c.slug) }}</strong> on <strong>{{ c.count }}</strong> {{ c.count === 1 ? 'record' : 'records' }}?</p>
        <div class="dlg-actions">
          <button ejs-button (click)="confirming.set(null)">Cancel</button>
          <button ejs-button cssClass="e-primary" (click)="confirmAndRun()">Run {{ c.count }}</button>
        </div>
      }
    </ejs-dialog>
  `,
  styles: `
    :host { display: inline-block; }
    .dlg-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  `,
})
export class EnrichSplitButtonComponent {
  private readonly runs = inject(RunsService);

  /** Workflow family — controls which sub-workflows show up in the dropdown. */
  family = input.required<EnrichFamily>();
  /** Selected / target record IDs. Primary action runs on these. */
  recordIds = input<string[]>([]);
  /** Fallback "all currently filtered" IDs when recordIds is empty (list mode). */
  filteredIds = input<string[]>([]);
  /** Confirm before running on more than this many records. */
  confirmThreshold = input<number>(2);

  protected readonly confirming = signal<
    { slug: string; count: number; ids: string[]; forceRefresh: boolean } | null
  >(null);

  /** Effective target IDs — selection wins, otherwise the filtered set. */
  private effectiveIds(): string[] {
    const sel = this.recordIds();
    return sel.length > 0 ? sel : this.filteredIds();
  }

  protected readonly disabled = computed(() => this.effectiveIds().length === 0);

  protected readonly primaryLabel = computed(() => {
    const ids = this.effectiveIds();
    if (ids.length <= 1) return 'Enrich';
    const using = this.recordIds().length > 0 ? 'selected' : 'filtered';
    return `Enrich ${ids.length} ${using}`;
  });

  protected readonly subWorkflows = computed<WorkflowMeta[]>(() =>
    WORKFLOWS.filter((w) => w.family === this.family() && !w.slug.endsWith('-orchestrator')),
  );

  protected readonly menuItems = computed<ItemModel[]>(() =>
    this.subWorkflows().map((w) => ({ id: w.slug, text: w.title })),
  );

  protected workflowTitle(slug: string): string {
    return WORKFLOWS.find((w) => w.slug === slug)?.title ?? slug;
  }

  runOrchestrator(): void {
    const slug = `${this.family()}-orchestrator`;
    // A manual click on "Enrich" is an explicit ask to refresh — bypass the
    // orchestrator's staleness filter so every leaf re-runs.
    this.run(slug, true);
  }

  onMenuSelect(args: { item?: ItemModel }): void {
    const slug = args.item?.id;
    // Sub-workflows don't honor force_refresh; they always run when invoked.
    if (typeof slug === 'string' && slug.length > 0) this.run(slug, false);
  }

  private run(slug: string, forceRefresh: boolean): void {
    const ids = this.effectiveIds();
    if (ids.length === 0) return;
    if (ids.length >= this.confirmThreshold()) {
      this.confirming.set({ slug, count: ids.length, ids, forceRefresh });
      return;
    }
    this.fire(slug, ids, forceRefresh);
  }

  protected confirmAndRun(): void {
    const c = this.confirming();
    if (!c) return;
    this.confirming.set(null);
    this.fire(c.slug, c.ids, c.forceRefresh);
  }

  private fire(slug: string, ids: string[], forceRefresh: boolean): void {
    this.runs.startRun(slug, {
      record_ids: ids,
      model: 'claude-haiku-4-5-20251001',
      force_refresh: forceRefresh,
    });
  }
}
