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
import { RunsService } from '../../services/runs.service';
import { ModelService } from '../../services/model.service';
import { WORKFLOWS, type WorkflowMeta } from '../../workflows';

export type EnrichFamily = 'vendor' | 'tool';

@Component({
  selector: 'app-enrich-split-button',
  imports: [CommonModule, SplitButtonModule],
  templateUrl: './enrich-split-button.component.html',
  styleUrl: './enrich-split-button.component.scss',
})
export class EnrichSplitButtonComponent {
  private readonly runs = inject(RunsService);
  private readonly modelService = inject(ModelService);

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

  // Sentinel id for the vendor "Force Refresh" menu item — distinguishes it
  // from real workflow slugs in onMenuSelect.
  private static readonly FORCE_REFRESH_ID = '__force_refresh__';

  protected readonly menuItems = computed<ItemModel[]>(() => {
    const force: ItemModel = {
      id: EnrichSplitButtonComponent.FORCE_REFRESH_ID,
      text: 'Force Refresh',
    };
    if (this.family() === 'vendor') return [force];
    // Tools: Force Refresh first, then per-leaf shortcuts. Separator keeps
    // the orchestrator-level action visually distinct from individual leaves.
    return [
      force,
      { separator: true } as ItemModel,
      ...this.subWorkflows().map((w) => ({ id: w.slug, text: w.title })),
    ];
  });

  protected workflowTitle(slug: string): string {
    if (slug === EnrichSplitButtonComponent.FORCE_REFRESH_ID) return 'Force Refresh';
    return WORKFLOWS.find((w) => w.slug === slug)?.title ?? slug;
  }

  // Server workflow slugs use 'product-*' for the tool family (rename in #58).
  private slugPrefix(): string {
    return this.family() === 'tool' ? 'product' : this.family();
  }

  runOrchestrator(): void {
    const slug = `${this.slugPrefix()}-orchestrator`;
    // Primary click runs the orchestrator under its normal staleness rules.
    // The "Force Refresh" dropdown item is the explicit re-run-everything path.
    this.run(slug, false);
  }

  onMenuSelect(args: { item?: ItemModel }): void {
    const slug = args.item?.id;
    if (typeof slug !== 'string' || slug.length === 0) return;
    if (slug === EnrichSplitButtonComponent.FORCE_REFRESH_ID) {
      this.run(`${this.slugPrefix()}-orchestrator`, true);
      return;
    }
    // Sub-workflows don't honor force_refresh; they always run when invoked.
    this.run(slug, false);
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
      model: this.modelService.selected(),
      force_refresh: forceRefresh,
    });
  }
}
