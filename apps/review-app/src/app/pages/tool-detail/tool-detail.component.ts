import { Component, inject, signal, input, computed, effect } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GridModule, PageService, SortService, FilterService } from '@syncfusion/ej2-angular-grids';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import { RunDetailDialogComponent } from '../../components/run-detail-dialog/run-detail-dialog.component';
import { ApiService } from '../../services/api.service';
import { RunsService, type RecentRunRow } from '../../services/runs.service';
import { WORKFLOWS } from '../../workflows';
import { TagInputComponent } from '../../components/tag-input/tag-input.component';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { PromoteSplitButtonComponent } from '../../components/promote-split-button/promote-split-button.component';
import { TierDetailDialogComponent } from '../../components/tier-detail-dialog/tier-detail-dialog.component';
import { formatDate, formatDateWithRelative } from '../../utils/date';
import {
  IntegratedToolSummary,
  LinkRef,
  MetaResponse,
  PromotionStatus,
  ToolDetail,
  UpdateToolRequest,
} from '../../types';
import { tierMetaFor } from '../../components/tier-info/tier-info';
import { enrichmentVariant } from '../../utils/enrichment';

type IntegratedToolsSortKey =
  | 'name'
  | 'tier'
  | 'vendor'
  | 'researchStatus'
  | 'integrationCount'
  | 'connections';

// Tier sort: Tier 1 (best) is the smallest value, Unscored/missing is largest.
function tierSortValue(tier: string | undefined): number {
  if (!tier) return 999;
  if (tier === 'Unscored') return 998;
  const n = Number(tier);
  return Number.isFinite(n) ? n : 997;
}

function compareIntegratedTools(
  a: IntegratedToolSummary,
  b: IntegratedToolSummary,
  key: IntegratedToolsSortKey,
): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'tier': {
      const t = tierSortValue(a.priorityTier) - tierSortValue(b.priorityTier);
      if (t !== 0) return t;
      // Within the same tier, higher score first (so descend in score under
      // ascending tier).
      return (b.priorityScore ?? -Infinity) - (a.priorityScore ?? -Infinity);
    }
    case 'vendor': {
      const av = a.vendors[0]?.name ?? '';
      const bv = b.vendors[0]?.name ?? '';
      return av.localeCompare(bv);
    }
    case 'researchStatus':
      return (a.researchStatus ?? '').localeCompare(b.researchStatus ?? '');
    case 'integrationCount':
      return a.integrationCount - b.integrationCount;
    case 'connections':
      return a.integrationIds.length - b.integrationIds.length;
  }
}

type SectionKey =
  | 'header'
  | 'description'
  | 'taxonomy'
  | 'research'
  | 'integrationLinks'
  | 'researchNotes'
  | 'integrationCheckNotes'
  | 'adminNotes';

interface DraftState {
  // header
  name: string;
  website: string;
  vendorIds: string[];
  // description
  description: string;
  // taxonomy
  categoryIds: string[];
  disciplineIds: string[];
  phaseIds: string[];
  // research
  researchStatus: string;
  // integration links
  toolIntegrationsUrl: string;
  apiDocsUrl: string;
  hasApiDocs: boolean;
  // notes
  researchNotes: string;
  toolIntegrationCheckNotes: string;
  adminNotes: string;
}

type ToolTabKey = 'details' | 'integrations' | 'notes' | 'runs';
const TOOL_TABS: ReadonlySet<ToolTabKey> = new Set([
  'details',
  'integrations',
  'notes',
  'runs',
]);

@Component({
  selector: 'app-tool-detail',
  imports: [
    CommonModule,
    RouterLink,
    RouterLinkActive,
    DecimalPipe,
    FormsModule,
    GridModule,
    ButtonModule,
    TagInputComponent,
    EnrichSplitButtonComponent,
    PromoteSplitButtonComponent,
    RunDetailDialogComponent,
    TierDetailDialogComponent,
  ],
  providers: [PageService, SortService, FilterService],
  templateUrl: './tool-detail.component.html',
  styleUrl: './tool-detail.component.scss',
})
export class ToolDetailComponent {
  id = input.required<string>();
  tab = input<string>('details');

  private api = inject(ApiService);
  protected runs = inject(RunsService);
  tool = signal<ToolDetail | null>(null);
  meta = signal<MetaResponse | null>(null);
  recordIds = computed(() => (this.tool() ? [this.id()] : []));
  enrichmentVariant = enrichmentVariant;

  activeTab = computed<ToolTabKey>(() => {
    const t = this.tab();
    return TOOL_TABS.has(t as ToolTabKey) ? (t as ToolTabKey) : 'details';
  });

  // Tier-detail modal — opened from the headline tier badge.
  protected readonly tierModalToolId = signal<string | null>(null);
  openTierModal(): void {
    this.tierModalToolId.set(this.id());
  }
  closeTierModal(): void {
    this.tierModalToolId.set(null);
  }

  // Run dialog — same pattern as the /runs page.
  protected readonly selectedRunId = signal<string | null>(null);
  protected readonly selectedRun = computed<RecentRunRow | null>(() => {
    const id = this.selectedRunId();
    if (!id) return null;
    return this.runs.runs().find((r) => r.runId === id) ?? null;
  });

  /** Recent runs scoped to this tool record. */
  protected readonly toolRuns = computed(() => {
    const toolId = this.id();
    return this.runs
      .runs()
      .filter((r) => r.recordId === toolId)
      .map((r) => ({
        runId: r.runId,
        workflow: r.workflow,
        workflowTitle: WORKFLOWS.find((w) => w.slug === r.workflow)?.title ?? r.workflow,
        recordId: r.recordId,
        recordLabel: r.recordLabel ?? r.recordId,
        startedAt: new Date(r.startedAt),
        status: r.status,
        raw: r,
      }));
  });

  onRunRowSelected(args: { data?: { runId: string } }): void {
    const id = args.data?.runId;
    if (id) this.selectedRunId.set(id);
  }
  closeRunDialog(): void {
    this.selectedRunId.set(null);
  }
  editingSection = signal<SectionKey | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);
  reloading = signal(false);

  // Tools tab — list of distinct tools this one integrates with.
  integratedToolsSearch = signal('');
  // Default sort: tier ascending (Tier 1 first), Unscored last.
  integratedToolsSortKey = signal<IntegratedToolsSortKey>('tier');
  integratedToolsSortDir = signal<'asc' | 'desc'>('asc');

  integratedTools = computed<IntegratedToolSummary[]>(() => {
    return this.tool()?.integratedTools ?? [];
  });

  filteredIntegratedTools = computed<IntegratedToolSummary[]>(() => {
    const q = this.integratedToolsSearch().trim().toLowerCase();
    const all = this.integratedTools();
    const filtered = !q
      ? all
      : all.filter((t) => {
          const haystack = [
            t.name,
            t.researchStatus,
            ...t.vendors.map((v) => v.name),
            ...t.categories.map((c) => c.name),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(q);
        });

    const key = this.integratedToolsSortKey();
    const dir = this.integratedToolsSortDir() === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => compareIntegratedTools(a, b, key) * dir);
  });

  onIntegratedToolsSearch(event: Event): void {
    this.integratedToolsSearch.set((event.target as HTMLInputElement).value);
  }

  toggleIntegratedToolsSort(key: IntegratedToolsSortKey): void {
    if (this.integratedToolsSortKey() === key) {
      this.integratedToolsSortDir.set(
        this.integratedToolsSortDir() === 'asc' ? 'desc' : 'asc',
      );
    } else {
      this.integratedToolsSortKey.set(key);
      // Numeric/tier columns default to descending; text to ascending.
      this.integratedToolsSortDir.set(
        key === 'name' || key === 'vendor' || key === 'researchStatus'
          ? 'asc'
          : key === 'tier'
            ? 'asc'
            : 'desc',
      );
    }
  }

  integratedToolsSortAria(
    key: IntegratedToolsSortKey,
  ): 'ascending' | 'descending' | 'none' {
    if (this.integratedToolsSortKey() !== key) return 'none';
    return this.integratedToolsSortDir() === 'asc' ? 'ascending' : 'descending';
  }

  tierLabel(tier: string | undefined): string {
    if (!tier) return '—';
    if (tier === 'Unscored') return 'Unscored';
    return `Tier ${tier}`;
  }

  tierBlurb(tier: string | undefined): string {
    return tierMetaFor(tier).label;
  }

  // Mutable draft used by [(ngModel)] — replaced via Object.assign on each edit start.
  draft: DraftState = this.emptyDraft();

  constructor() {
    // React to id changes so navigating between /tools/A and /tools/B refetches
    // without remounting the page. Resets per-route UI state on each switch.
    effect(() => {
      const id = this.id();
      this.tool.set(null);
      this.editingSection.set(null);
      this.integratedToolsSearch.set('');
      this.saveError.set(null);
      this.api.getTool(id).subscribe((tool) => {
        if (this.id() === id) this.tool.set(tool);
      });
    });
    this.api.getMeta().subscribe((meta) => {
      this.meta.set(meta);
    });
  }

  // ------------------------------------------------------------------- edit
  startEdit(section: SectionKey, tool: ToolDetail): void {
    this.saveError.set(null);
    Object.assign(this.draft, this.toDraft(tool));
    this.editingSection.set(section);
  }

  cancelEdit(): void {
    this.editingSection.set(null);
    this.saveError.set(null);
  }

  protected readonly promoting = signal(false);

  onPromotionStatusChange(next: PromotionStatus): void {
    if (this.promoting()) return;
    const id = this.id();
    this.promoting.set(true);
    this.saveError.set(null);
    this.api.updateTool(id, { promotionStatus: next }).subscribe({
      next: (updated) => {
        if (this.id() === id) this.tool.set(updated);
        this.promoting.set(false);
      },
      error: (err) => {
        this.promoting.set(false);
        this.saveError.set(err?.error?.error ?? err?.message ?? 'Save failed');
      },
    });
  }

  reload(): void {
    if (this.reloading()) return;
    const id = this.id();
    this.reloading.set(true);
    this.api.getTool(id).subscribe({
      next: (tool) => {
        if (this.id() === id) this.tool.set(tool);
        this.reloading.set(false);
      },
      error: () => this.reloading.set(false),
    });
  }

  saveSection(section: SectionKey): void {
    const id = this.id();
    const patch = this.buildPatch(section);
    if (Object.keys(patch).length === 0) {
      this.editingSection.set(null);
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    this.api.updateTool(id, patch).subscribe({
      next: (updated) => {
        this.tool.set(updated);
        this.saving.set(false);
        this.editingSection.set(null);
      },
      error: (err) => {
        this.saving.set(false);
        this.saveError.set(err?.error?.error ?? err?.message ?? 'Save failed');
      },
    });
  }

  // ---- helpers ------------------------------------------------------------
  private emptyDraft(): DraftState {
    return {
      name: '',
      website: '',
      vendorIds: [],
      description: '',
      categoryIds: [],
      disciplineIds: [],
      phaseIds: [],
      researchStatus: '',
      toolIntegrationsUrl: '',
      apiDocsUrl: '',
      hasApiDocs: false,
      researchNotes: '',
      toolIntegrationCheckNotes: '',
      adminNotes: '',
    };
  }

  private toDraft(tool: ToolDetail): DraftState {
    return {
      name: tool.name,
      website: tool.website ?? '',
      vendorIds: tool.vendors.map((v) => v.id),
      description: tool.description ?? '',
      categoryIds: tool.categories.map((c) => c.id),
      disciplineIds: tool.disciplines.map((d) => d.id),
      phaseIds: tool.phases.map((p) => p.id),
      researchStatus: tool.researchStatus ?? '',
      toolIntegrationsUrl: tool.toolIntegrationsUrl ?? '',
      apiDocsUrl: tool.apiDocsUrl ?? '',
      hasApiDocs: tool.hasApiDocs ?? false,
      researchNotes: tool.researchNotes ?? '',
      toolIntegrationCheckNotes: tool.toolIntegrationCheckNotes ?? '',
      adminNotes: tool.adminNotes ?? '',
    };
  }

  private buildPatch(section: SectionKey): UpdateToolRequest {
    const d = this.draft;
    switch (section) {
      case 'header':
        return { name: d.name, website: d.website, vendors: d.vendorIds };
      case 'description':
        return { description: d.description };
      case 'taxonomy':
        return {
          categories: d.categoryIds,
          disciplines: d.disciplineIds,
          phases: d.phaseIds,
        };
      case 'research':
        return { researchStatus: d.researchStatus };
      case 'integrationLinks':
        return {
          toolIntegrationsUrl: d.toolIntegrationsUrl,
          apiDocsUrl: d.apiDocsUrl,
          hasApiDocs: d.hasApiDocs,
        };
      case 'researchNotes':
        return { researchNotes: d.researchNotes };
      case 'integrationCheckNotes':
        return { toolIntegrationCheckNotes: d.toolIntegrationCheckNotes };
      case 'adminNotes':
        return { adminNotes: d.adminNotes };
    }
  }

  // ---- pill overflow ------------------------------------------------------
  static readonly PILL_LIMIT = 3;
  visibleRefs(refs: LinkRef[]): LinkRef[] {
    return refs.slice(0, ToolDetailComponent.PILL_LIMIT);
  }
  overflowRefs(refs: LinkRef[]): LinkRef[] | null {
    if (refs.length <= ToolDetailComponent.PILL_LIMIT) return null;
    return refs.slice(ToolDetailComponent.PILL_LIMIT);
  }

  // ---- formatters / classes ----------------------------------------------
  statusBadgeClass(status: string): string {
    const lower = status.toLowerCase();
    if (lower.includes('complete') || lower.includes('done'))
      return 'badge--success';
    if (lower.includes('progress') || lower.includes('review'))
      return 'badge--warning';
    if (lower.includes('not started') || lower.includes('todo'))
      return 'badge--neutral';
    return 'badge--info';
  }

  tierBadgeClass(tier: string): string {
    switch (tier) {
      case '1':
        return 'badge--success';
      case '2':
        return 'badge--info';
      case '3':
        return 'badge--warning';
      default:
        return 'badge--neutral';
    }
  }

  confidenceBadgeClass(confidence: string): string {
    switch (confidence) {
      case 'high':
        return 'badge--success';
      case 'medium':
        return 'badge--warning';
      case 'low':
        return 'badge--neutral';
      default:
        return 'badge--neutral';
    }
  }

  formatPercent(v: number): string {
    const pct = v <= 1 ? v * 100 : v;
    return `${Math.round(pct)}%`;
  }

  formatDate(iso: string): string {
    return formatDate(iso);
  }

  formatDateWithRelative(iso: string): string {
    return formatDateWithRelative(iso);
  }

  googleTrendsUrl(name: string): string {
    return `https://trends.google.com/trends/explore?q=${encodeURIComponent(name)}&date=today%205-y`;
  }

}
