import { Component, inject, signal, input, computed, effect } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { TagInputComponent } from '../../components/tag-input/tag-input.component';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { formatDate, formatDateWithRelative } from '../../utils/date';
import {
  IntegrationSummary,
  LinkRef,
  MetaResponse,
  ToolDetail,
  UpdateToolRequest,
} from '../../types';
import { enrichmentVariant } from '../../utils/enrichment';

interface CombinedIntegration {
  id: string;
  name: string;
  otherTool?: LinkRef;
  integrationType?: string;
  description?: string;
}

type SectionKey =
  | 'header'
  | 'description'
  | 'taxonomy'
  | 'research'
  | 'integrationLinks'
  | 'researchNotes'
  | 'integrationCheckNotes';

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
}

@Component({
  selector: 'app-tool-detail',
  imports: [RouterLink, DecimalPipe, FormsModule, TagInputComponent, EnrichSplitButtonComponent],
  templateUrl: './tool-detail.component.html',
  styleUrl: './tool-detail.component.scss',
})
export class ToolDetailComponent {
  id = input.required<string>();

  private api = inject(ApiService);
  tool = signal<ToolDetail | null>(null);
  meta = signal<MetaResponse | null>(null);
  recordIds = computed(() => (this.tool() ? [this.id()] : []));
  enrichmentVariant = enrichmentVariant;

  activeTab = signal<'details' | 'notes'>('details');
  editingSection = signal<SectionKey | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);
  integrationSearch = signal('');

  combinedIntegrations = computed<CombinedIntegration[]>(() => {
    const t = this.tool();
    if (!t) return [];
    const seen = new Set<string>();
    const out: CombinedIntegration[] = [];
    const push = (i: IntegrationSummary, otherTool: LinkRef | undefined) => {
      if (seen.has(i.id)) return;
      seen.add(i.id);
      out.push({
        id: i.id,
        name: i.name,
        otherTool,
        integrationType: i.integrationType,
        description: i.description,
      });
    };
    for (const i of t.integrationsAsSource) push(i, i.targetTool);
    for (const i of t.integrationsAsTarget) push(i, i.sourceTool);
    return out;
  });

  filteredIntegrations = computed<CombinedIntegration[]>(() => {
    const q = this.integrationSearch().trim().toLowerCase();
    const all = this.combinedIntegrations();
    if (!q) return all;
    return all.filter((i) => {
      const haystack = [
        i.name,
        i.otherTool?.name,
        i.integrationType,
        i.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  // Mutable draft used by [(ngModel)] — replaced via Object.assign on each edit start.
  draft: DraftState = this.emptyDraft();

  constructor() {
    // React to id changes so navigating between /tools/A and /tools/B refetches
    // without remounting the page. Resets per-route UI state on each switch.
    effect(() => {
      const id = this.id();
      this.tool.set(null);
      this.editingSection.set(null);
      this.integrationSearch.set('');
      this.saveError.set(null);
      this.api.getTool(id).subscribe((tool) => {
        if (this.id() === id) this.tool.set(tool);
      });
    });
    this.api.getMeta().subscribe((meta) => {
      this.meta.set(meta);
    });
  }

  onIntegrationSearch(event: Event): void {
    this.integrationSearch.set((event.target as HTMLInputElement).value);
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
}
