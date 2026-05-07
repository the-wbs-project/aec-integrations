// ---------------------------------------------------------------------------
// Enrich split-button.
//
// Used in two places:
//   1. Detail headers (vendor / tool) — `recordIds` is a 1-element array, the
//      button enqueues a playbook job for that record. Caret reveals leaf
//      shortcuts (mapped to the playbook's `aspect` arg) and Force Refresh.
//   2. List toolbars — `recordIds` is the user's row selection. If empty,
//      `filteredIds` is used instead and a confirmation dialog asks before
//      we run on every filtered row.
//
// Both modes route through the prompt-queue producer (POST /api/prompt-queue).
// The scheduled dispatcher picks up the queued job on its next tick. Bell
// surfaces queued jobs alongside live workflow runs — see RunsHub queue poll.
// ---------------------------------------------------------------------------
import { Component, inject, input, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SplitButtonModule, type ItemModel } from '@syncfusion/ej2-angular-splitbuttons';
import { ApiService } from '../../services/api.service';

export type EnrichFamily = 'vendor' | 'tool';

interface LeafShortcut {
  /** id used as the dropdown item id; arbitrary string. */
  id: string;
  /** label shown to the user. */
  text: string;
  /** Aspect arg sent to the playbook. */
  aspect: string;
}

// Per-leaf shortcuts the dropdown offers, mapped to the playbook's `aspect` arg.
// We deliberately drop legacy workflow leaves that don't have a playbook
// equivalent (score is now synchronous; integration sub-source leaves are
// rolled into the single discover-product-integrations playbook).
const VENDOR_LEAVES: ReadonlyArray<LeafShortcut> = [
  { id: 'aspect:overview', text: 'V0R · Overview', aspect: 'overview' },
  { id: 'aspect:github', text: 'V02 · GitHub', aspect: 'github' },
  { id: 'aspect:funding', text: 'V04 · Funding', aspect: 'funding' },
];

const TOOL_LEAVES: ReadonlyArray<LeafShortcut> = [
  { id: 'aspect:research', text: 'TR · Research', aspect: 'research' },
  { id: 'aspect:overview', text: 'T0R · Overview', aspect: 'overview' },
  { id: 'aspect:api-check', text: 'T01 · API check', aspect: 'api-check' },
  { id: 'aspect:marketplace', text: 'T02 · Marketplace', aspect: 'marketplace' },
  { id: 'aspect:ipaas', text: 'T03 · iPaaS', aspect: 'ipaas' },
  { id: 'aspect:reviews', text: 'T04 · Reviews', aspect: 'reviews' },
  { id: 'aspect:search-demand', text: 'T05 · Search demand', aspect: 'search-demand' },
  { id: 'aspect:reddit', text: 'T06 · Reddit', aspect: 'reddit' },
];

@Component({
  selector: 'app-enrich-split-button',
  imports: [CommonModule, SplitButtonModule],
  templateUrl: './enrich-split-button.component.html',
  styleUrl: './enrich-split-button.component.scss',
})
export class EnrichSplitButtonComponent {
  private readonly api = inject(ApiService);

  /** Workflow family — controls which sub-leaf shortcuts show up in the dropdown. */
  family = input.required<EnrichFamily>();
  /** Selected / target record IDs. Primary action runs on these. */
  recordIds = input<string[]>([]);
  /** Fallback "all currently filtered" IDs when recordIds is empty (list mode). */
  filteredIds = input<string[]>([]);
  /** Confirm before running on more than this many records. */
  confirmThreshold = input<number>(2);

  protected readonly confirming = signal<
    {
      label: string;
      count: number;
      ids: string[];
      aspect?: string;
      forceRefresh: boolean;
    } | null
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

  // Sentinel id for the "Force Refresh" menu item.
  private static readonly FORCE_REFRESH_ID = '__force_refresh__';

  private leaves(): ReadonlyArray<LeafShortcut> {
    return this.family() === 'vendor' ? VENDOR_LEAVES : TOOL_LEAVES;
  }

  protected readonly menuItems = computed<ItemModel[]>(() => {
    const force: ItemModel = {
      id: EnrichSplitButtonComponent.FORCE_REFRESH_ID,
      text: 'Force Refresh',
    };
    const leaves = this.leaves().map((l) => ({ id: l.id, text: l.text }) as ItemModel);
    if (leaves.length === 0) return [force];
    return [force, { separator: true } as ItemModel, ...leaves];
  });

  /** Resolves an id from menuItems back to a label for the confirmation dialog. */
  protected workflowTitle(id: string): string {
    if (id === EnrichSplitButtonComponent.FORCE_REFRESH_ID) return 'Force Refresh';
    return this.leaves().find((l) => l.id === id)?.text ?? id;
  }

  private playbookSlug(): 'enrich-vendor' | 'enrich-product' {
    return this.family() === 'vendor' ? 'enrich-vendor' : 'enrich-product';
  }

  runOrchestrator(): void {
    // Primary click — full enrichment, no aspect, no force refresh.
    this.run('Enrich', undefined, false);
  }

  onMenuSelect(args: { item?: ItemModel }): void {
    const id = args.item?.id;
    if (typeof id !== 'string' || id.length === 0) return;
    if (id === EnrichSplitButtonComponent.FORCE_REFRESH_ID) {
      this.run('Force Refresh', undefined, true);
      return;
    }
    const leaf = this.leaves().find((l) => l.id === id);
    if (!leaf) return;
    this.run(leaf.text, leaf.aspect, false);
  }

  private run(label: string, aspect: string | undefined, forceRefresh: boolean): void {
    const ids = this.effectiveIds();
    if (ids.length === 0) return;
    if (ids.length >= this.confirmThreshold()) {
      this.confirming.set({ label, count: ids.length, ids, aspect, forceRefresh });
      return;
    }
    this.fire(ids, aspect, forceRefresh);
  }

  protected confirmAndRun(): void {
    const c = this.confirming();
    if (!c) return;
    this.confirming.set(null);
    this.fire(c.ids, c.aspect, c.forceRefresh);
  }

  private fire(ids: string[], aspect: string | undefined, forceRefresh: boolean): void {
    const playbookSlug = this.playbookSlug();
    for (const recordId of ids) {
      this.api
        .enqueuePromptJob({
          playbook_slug: playbookSlug,
          target_record_id: recordId,
          ...(aspect ? { aspect } : {}),
          force_refresh: forceRefresh,
        })
        .subscribe({
          next: () => undefined,
          error: (err) => console.error('[EnrichSplitButton] enqueue failed', err),
        });
    }
  }
}
