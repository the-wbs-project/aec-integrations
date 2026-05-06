import { Component, inject, signal, input, computed, effect } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GridModule, PageService, SortService, FilterService } from '@syncfusion/ej2-angular-grids';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import { RunDetailDialogComponent } from '../../components/run-detail-dialog/run-detail-dialog.component';
import { ApiService } from '../../services/api.service';
import { ModelService } from '../../services/model.service';
import { RunsService, type RecentRunRow } from '../../services/runs.service';
import { WORKFLOWS } from '../../workflows';
import { TagInputComponent } from '../../components/tag-input/tag-input.component';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { PromoteSplitButtonComponent } from '../../components/promote-split-button/promote-split-button.component';
import { TierDetailDialogComponent } from '../../components/tier-detail-dialog/tier-detail-dialog.component';
import { formatDate, formatDateWithRelative } from '../../utils/date';
import {
  IntegratedProductSummary,
  IntegrationSummary,
  LinkRef,
  MetaResponse,
  PromotionStatus,
  ProductDetail,
  ProductUsefulnessEntry,
  UpdateProductRequest,
} from '../../types';
import { tierMetaFor } from '../../components/tier-info/tier-info';
import { enrichmentVariant } from '../../utils/enrichment';

type IntegratedProductsSortKey =
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

function compareIntegratedProducts(
  a: IntegratedProductSummary,
  b: IntegratedProductSummary,
  key: IntegratedProductsSortKey,
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
  productRole: '' | 'application' | 'connector' | 'hybrid';
  extensionOfIds: string[];
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
  selector: 'app-product-detail',
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
  templateUrl: './product-detail.component.html',
  styleUrl: './product-detail.component.scss',
})
export class ProductDetailComponent {
  id = input.required<string>();
  tab = input<string>('details');

  private api = inject(ApiService);
  protected runs = inject(RunsService);
  private modelService = inject(ModelService);
  tool = signal<ProductDetail | null>(null);
  meta = signal<MetaResponse | null>(null);
  // Host-product picker options for the "Extension of" field. Excludes the
  // current product to prevent self-loops. Empty until meta resolves.
  hostProductOptions = computed<LinkRef[]>(() => {
    const all = this.meta()?.products ?? [];
    const selfId = this.id();
    return selfId ? all.filter((p) => p.id !== selfId) : all;
  });
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
  integratedProductsSearch = signal('');
  // Default sort: tier ascending (Tier 1 first), Unscored last.
  integratedProductsSortKey = signal<IntegratedProductsSortKey>('tier');
  integratedProductsSortDir = signal<'asc' | 'desc'>('asc');

  integratedProducts = computed<IntegratedProductSummary[]>(() => {
    return this.tool()?.integratedProducts ?? [];
  });

  // Flat, deduplicated list of every Integration record this tool participates
  // in (as source or target). Powers the per-integration cards on the
  // Integrations tab — distinct from `integratedProducts`, which collapses many
  // integrations per other-product into one row.
  allIntegrations = computed<IntegrationSummary[]>(() => {
    const t = this.tool();
    if (!t) return [];
    const seen = new Set<string>();
    const out: IntegrationSummary[] = [];
    for (const i of [...t.integrationsAsSource, ...t.integrationsAsTarget]) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      out.push(i);
    }
    return out;
  });

  // Reverse lookup: integrations whose `poweredByProduct` points at this tool.
  // Only meaningful to render when productRole is connector / hybrid, but the
  // template handles the empty case so we always expose the array.
  poweredIntegrations = computed<IntegrationSummary[]>(() => {
    return this.tool()?.poweredIntegrations ?? [];
  });

  /**
   * For each row in the Integrated-Products table, summarise *how* the two
   * products are wired by walking that row's integration ids and bucketing
   * each integration as either native (no connector) or routed through a
   * connector product. Lookup keyed by integratedProduct id; deduped per
   * connector so two Zapier-powered integrations show as one chip.
   */
  integratedConnectorBuckets = computed<
    Map<string, { nativeCount: number; connectors: LinkRef[] }>
  >(() => {
    const byIntegrationId = new Map<string, IntegrationSummary>();
    for (const i of this.allIntegrations()) byIntegrationId.set(i.id, i);
    const out = new Map<string, { nativeCount: number; connectors: LinkRef[] }>();
    for (const ip of this.integratedProducts()) {
      let nativeCount = 0;
      const connectors: LinkRef[] = [];
      const seen = new Set<string>();
      for (const integrationId of ip.integrationIds) {
        const integ = byIntegrationId.get(integrationId);
        if (!integ) continue;
        if (integ.poweredByProduct) {
          if (!seen.has(integ.poweredByProduct.id)) {
            seen.add(integ.poweredByProduct.id);
            connectors.push(integ.poweredByProduct);
          }
        } else {
          nativeCount += 1;
        }
      }
      out.set(ip.id, { nativeCount, connectors });
    }
    return out;
  });

  connectorChipsFor(productId: string): {
    nativeCount: number;
    connectors: LinkRef[];
  } {
    return (
      this.integratedConnectorBuckets().get(productId) ?? {
        nativeCount: 0,
        connectors: [],
      }
    );
  }

  // ---- Integration discovery (unresolved candidates) ---------------------
  protected readonly discoveryRunning = signal(false);

  startIntegrationsDiscovery(): void {
    if (this.discoveryRunning()) return;
    this.discoveryRunning.set(true);
    this.runs
      .startRun('product-integrations-discovery', {
        record_ids: [this.id()],
        model: this.modelService.selected(),
        force_refresh: true,
      })
      .subscribe({
        next: () => this.discoveryRunning.set(false),
        error: () => this.discoveryRunning.set(false),
      });
  }

  // The "other" endpoint of an integration relative to this tool.
  otherProductOf(integration: IntegrationSummary): LinkRef | undefined {
    const myId = this.id();
    if (integration.sourceProduct && integration.sourceProduct.id !== myId) {
      return integration.sourceProduct;
    }
    if (integration.targetProduct && integration.targetProduct.id !== myId) {
      return integration.targetProduct;
    }
    return undefined;
  }

  filteredIntegratedProducts = computed<IntegratedProductSummary[]>(() => {
    const q = this.integratedProductsSearch().trim().toLowerCase();
    const all = this.integratedProducts();
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

    const key = this.integratedProductsSortKey();
    const dir = this.integratedProductsSortDir() === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => compareIntegratedProducts(a, b, key) * dir);
  });

  onIntegratedProductsSearch(event: Event): void {
    this.integratedProductsSearch.set((event.target as HTMLInputElement).value);
  }

  toggleIntegratedProductsSort(key: IntegratedProductsSortKey): void {
    if (this.integratedProductsSortKey() === key) {
      this.integratedProductsSortDir.set(
        this.integratedProductsSortDir() === 'asc' ? 'desc' : 'asc',
      );
    } else {
      this.integratedProductsSortKey.set(key);
      // Numeric/tier columns default to descending; text to ascending.
      this.integratedProductsSortDir.set(
        key === 'name' || key === 'vendor' || key === 'researchStatus'
          ? 'asc'
          : key === 'tier'
            ? 'asc'
            : 'desc',
      );
    }
  }

  integratedProductsSortAria(
    key: IntegratedProductsSortKey,
  ): 'ascending' | 'descending' | 'none' {
    if (this.integratedProductsSortKey() !== key) return 'none';
    return this.integratedProductsSortDir() === 'asc' ? 'ascending' : 'descending';
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
      this.integratedProductsSearch.set('');
      this.saveError.set(null);
      this.usefulnessExpanded.set(false);
      this.api.getProduct(id).subscribe((tool) => {
        if (this.id() === id) this.tool.set(tool);
      });
    });
    this.api.getMeta().subscribe((meta) => {
      this.meta.set(meta);
    });
  }

  // ------------------------------------------------------------------- edit
  startEdit(section: SectionKey, tool: ProductDetail): void {
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
    this.api.updateProduct(id, { promotionStatus: next }).subscribe({
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
    this.api.getProduct(id).subscribe({
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
    this.api.updateProduct(id, patch).subscribe({
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
      productRole: '',
      extensionOfIds: [],
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

  private toDraft(tool: ProductDetail): DraftState {
    return {
      name: tool.name,
      website: tool.website ?? '',
      vendorIds: tool.vendors.map((v) => v.id),
      productRole: tool.productRole ?? '',
      extensionOfIds: tool.extensionOf?.map((p) => p.id) ?? [],
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

  private buildPatch(section: SectionKey): UpdateProductRequest {
    const d = this.draft;
    switch (section) {
      case 'header':
        return {
          name: d.name,
          website: d.website,
          vendors: d.vendorIds,
          // The dropdown's "—" option maps to '' which the route forwards to
          // Airtable as a single-select clear (back to the implicit
          // application). Real values pass through unchanged.
          productRole: d.productRole === '' ? undefined : d.productRole,
          extensionOf: d.extensionOfIds,
        };
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

  // ---- usefulness panel ---------------------------------------------------
  // Closed by default — opens on click. Resets per product so navigating
  // between products doesn't carry over the previous tool's open state.
  protected readonly usefulnessExpanded = signal(false);

  toggleUsefulness(): void {
    this.usefulnessExpanded.set(!this.usefulnessExpanded());
  }

  /**
   * Filter usefulness entries to disciplines/phases the product is currently
   * linked to. Curators may remove a discipline link without re-running
   * research; this hides the orphaned bullets until research is re-run.
   */
  filteredUsefulnessDisciplines = computed<ProductUsefulnessEntry[]>(() => {
    const t = this.tool();
    if (!t?.usefulness) return [];
    const linked = new Set(t.disciplines.map((d) => d.id));
    return t.usefulness.disciplines.filter((e) => linked.has(e.id));
  });

  filteredUsefulnessPhases = computed<ProductUsefulnessEntry[]>(() => {
    const t = this.tool();
    if (!t?.usefulness) return [];
    const linked = new Set(t.phases.map((p) => p.id));
    return t.usefulness.phases.filter((e) => linked.has(e.id));
  });

  hasUsefulness = computed<boolean>(
    () =>
      this.filteredUsefulnessDisciplines().length > 0 ||
      this.filteredUsefulnessPhases().length > 0,
  );

  // ---- pill overflow ------------------------------------------------------
  static readonly PILL_LIMIT = 3;
  visibleRefs(refs: LinkRef[]): LinkRef[] {
    return refs.slice(0, ProductDetailComponent.PILL_LIMIT);
  }
  overflowRefs(refs: LinkRef[]): LinkRef[] | null {
    if (refs.length <= ProductDetailComponent.PILL_LIMIT) return null;
    return refs.slice(ProductDetailComponent.PILL_LIMIT);
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
