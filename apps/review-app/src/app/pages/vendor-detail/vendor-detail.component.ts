import { Component, inject, signal, input, computed, effect, OnInit } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GridModule, PageService, SortService, FilterService } from '@syncfusion/ej2-angular-grids';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import {
  DropDownButtonModule,
  type ItemModel,
  type MenuEventArgs,
} from '@syncfusion/ej2-angular-splitbuttons';
import { ApiService } from '../../services/api.service';
import { RunsService, type RecentRunRow } from '../../services/runs.service';
import { formatDate, formatDateWithRelative } from '../../utils/date';
import { PlaybookSummary, UpdateVendorRequest, VendorDetail } from '../../types';
import { InfoTooltipComponent } from '../../components/info-tooltip/info-tooltip.component';
import { NewProductDialogComponent } from '../../components/new-product-dialog/new-product-dialog.component';
import { RunDetailDialogComponent } from '../../components/run-detail-dialog/run-detail-dialog.component';
import { TierCellComponent } from '../../components/tier-cell/tier-cell.component';
import { TierDetailDialogComponent } from '../../components/tier-detail-dialog/tier-detail-dialog.component';
import { enrichmentVariant } from '../../utils/enrichment';
import { WORKFLOWS } from '../../workflows';

type SectionKey = 'header' | 'links' | 'keyFacts' | 'description' | 'adminNotes';
type TabKey = 'details' | 'tools' | 'runs';
const VENDOR_TABS: ReadonlySet<TabKey> = new Set(['details', 'tools', 'runs']);

interface DraftState {
  // header
  companyName: string;
  website: string;
  // links
  linkedinUrl: string;
  crunchbaseUrl: string;
  wikiUrl: string;
  githubOrg: string;
  sourceUrl: string;
  // key facts
  headquarters: string;
  foundedYear: number | null; // bound to <input type="number">; ngModel writes number or null
  publicPrivate: string;
  parentCompany: string;
  phoneNumber: string;
  contactEmail: string;
  // description
  description: string;
  // admin notes
  adminNotes: string;
}

interface VendorRunRow {
  runId: string;
  workflow: string;
  workflowTitle: string;
  recordId: string;
  recordLabel?: string;
  startedAt: Date;
  status: string;
  raw: RecentRunRow;
}

const PUBLIC_PRIVATE_OPTIONS = ['', 'Public', 'Private', 'Subsidiary', 'Nonprofit'] as const;

/**
 * One entry in the Actions dropdown's "Enrichment" section. Covers both
 * whole-playbook copies and per-aspect slices that piggyback on the
 * enrich-vendor body with an extra `aspect:` arg.
 */
interface EnrichmentItem {
  /** Stable menu id; also used as the "copied" flash key. */
  id: string;
  /** Label shown to the user (without the "Copy: " prefix). */
  label: string;
  /** Playbook slug whose body is the prompt template. */
  slug: 'research-vendors' | 'enrich-vendor' | 'discover-vendor-products';
  /** Optional aspect arg appended to the structured-args block. */
  aspect?: string;
}

@Component({
  selector: 'app-vendor-detail',
  imports: [
    CommonModule,
    RouterLink,
    RouterLinkActive,
    DecimalPipe,
    FormsModule,
    GridModule,
    ButtonModule,
    DropDownButtonModule,
    InfoTooltipComponent,
    NewProductDialogComponent,
    RunDetailDialogComponent,
    TierCellComponent,
    TierDetailDialogComponent,
  ],
  providers: [PageService, SortService, FilterService],
  templateUrl: './vendor-detail.component.html',
  styleUrl: './vendor-detail.component.scss',
})
export class VendorDetailComponent implements OnInit {
  id = input.required<string>();
  tab = input<string>('details');

  private api = inject(ApiService);
  private router = inject(Router);
  protected runs = inject(RunsService);

  vendor = signal<VendorDetail | null>(null);
  logoFailed = signal(false);
  enrichmentVariant = enrichmentVariant;

  editingSection = signal<SectionKey | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);
  reloading = signal(false);
  deleting = signal(false);
  deleteError = signal<string | null>(null);

  activeTab = computed<TabKey>(() => {
    const t = this.tab();
    return VENDOR_TABS.has(t as TabKey) ? (t as TabKey) : 'details';
  });

  // Tier-detail modal — opened from the headline tier cell. Set to a vendor id
  // to show; null to close.
  protected readonly tierModalVendorId = signal<string | null>(null);

  openTierModal(): void {
    this.tierModalVendorId.set(this.id());
  }
  closeTierModal(): void {
    this.tierModalVendorId.set(null);
  }

  // New-product dialog state.
  protected readonly newProductDialogOpen = signal(false);

  openNewProductDialog(): void {
    this.newProductDialogOpen.set(true);
  }

  closeNewProductDialog(): void {
    this.newProductDialogOpen.set(false);
  }

  onProductCreated(event: { id: string }): void {
    this.newProductDialogOpen.set(false);
    this.router.navigate(['/products', event.id]);
  }

  // Run dialog — same pattern as the /runs page so live deltas flow into the
  // open dialog without per-run subscriptions.
  protected readonly selectedRunId = signal<string | null>(null);
  protected readonly selectedRun = computed<RecentRunRow | null>(() => {
    const id = this.selectedRunId();
    if (!id) return null;
    return this.runs.runs().find((r) => r.runId === id) ?? null;
  });

  /** Recent runs scoped to this vendor record. */
  protected readonly vendorRuns = computed<VendorRunRow[]>(() => {
    const vendorId = this.id();
    return this.runs
      .runs()
      .filter((r) => r.recordId === vendorId)
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

  draft: DraftState = this.emptyDraft();

  readonly publicPrivateOptions = PUBLIC_PRIVATE_OPTIONS;

  // ---- Actions dropdown ---------------------------------------------------
  // Single Syncfusion DropDownButton in the header. Only Refresh Score
  // executes server-side (recomputes VQS via POST /vendors/:id/rescore).
  // Every other item copies a prompt to the clipboard — the curator pastes it
  // into Claude to run the workflow externally, keeping the LLM execution
  // boundary explicit and avoiding background enrich jobs from the UI.
  //
  // `EnrichmentItem` (declared at module scope above) covers both
  // whole-playbook copies (research/enrich) and per-aspect copies that append
  // an `aspect:` arg to the enrich-vendor body. The aspect items intentionally
  // piggyback on enrich-vendor since each aspect is just a scoped slice of
  // that same playbook.
  private static readonly ENRICHMENT_ITEMS: ReadonlyArray<EnrichmentItem> = [
    { id: 'pb:research-vendors', label: 'Research vendor', slug: 'research-vendors' },
    { id: 'pb:enrich-vendor', label: 'Enrich vendor (full)', slug: 'enrich-vendor' },
    { id: 'pb:enrich-vendor:overview', label: 'Enrich · Overview', slug: 'enrich-vendor', aspect: 'overview' },
    { id: 'pb:enrich-vendor:github', label: 'Enrich · GitHub', slug: 'enrich-vendor', aspect: 'github' },
    { id: 'pb:enrich-vendor:funding', label: 'Enrich · Funding', slug: 'enrich-vendor', aspect: 'funding' },
    { id: 'pb:discover-vendor-products', label: 'Discover products', slug: 'discover-vendor-products' },
  ];

  protected readonly playbooks = signal<PlaybookSummary[]>([]);
  /** Id of the most recently copied item — drives the "Copied" flash. */
  protected readonly copiedItemId = signal<string | null>(null);
  protected readonly clipboardError = signal<string | null>(null);
  protected readonly rescoring = signal(false);

  protected readonly actionsMenuItems = computed<ItemModel[]>(() => {
    const items: ItemModel[] = [
      {
        id: 'refresh-score',
        text: 'Refresh Score',
        iconCss: 'e-icons e-redo',
      },
      {
        id: 'header-enrichment',
        text: 'Enrichment',
        iconCss: 'menu-header',
        disabled: true,
      },
    ];
    const bySlug = new Map(this.playbooks().map((p) => [p.slug, p]));
    for (const item of VendorDetailComponent.ENRICHMENT_ITEMS) {
      const pb = bySlug.get(item.slug);
      if (!pb) continue;
      const isCopied = this.copiedItemId() === item.id;
      items.push({
        id: item.id,
        text: isCopied ? `Copied: ${item.label}` : `Copy: ${item.label}`,
        iconCss: isCopied ? 'e-icons e-circle-check' : 'e-icons e-copy',
      });
    }
    return items;
  });

  onActionsSelect(args: MenuEventArgs): void {
    const id = args.item?.id;
    if (!id) return;
    if (id === 'refresh-score') return this.runRescore();
    const item = VendorDetailComponent.ENRICHMENT_ITEMS.find(
      (i) => i.id === id,
    );
    if (item) void this.copyEnrichmentPrompt(item);
  }

  runRescore(): void {
    if (this.rescoring()) return;
    const id = this.id();
    this.rescoring.set(true);
    this.saveError.set(null);
    this.api.rescoreVendor(id).subscribe({
      next: (res) => {
        if (this.id() === id) {
          this.vendor.set(res.vendor);
          this.logoFailed.set(false);
        }
        this.rescoring.set(false);
      },
      error: (err) => {
        this.rescoring.set(false);
        this.saveError.set(err?.error?.error ?? err?.message ?? 'Rescore failed');
      },
    });
  }

  /**
   * Render the playbook body with a target_record_id arg (and optional aspect)
   * appended in the structured-args style used by renderPlaybookPrompt, then
   * copy to clipboard. Mirrors product-detail's clipboard pattern.
   */
  async copyEnrichmentPrompt(item: EnrichmentItem): Promise<void> {
    this.clipboardError.set(null);
    const pb = this.playbooks().find((p) => p.slug === item.slug);
    if (!pb) return;
    const args = [`- target_record_id: ${this.id()}`];
    if (item.aspect) args.push(`- aspect: ${item.aspect}`);
    const text = `${pb.body.trimEnd()}\n\n${args.join('\n')}\n`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      this.clipboardError.set(
        'Clipboard write failed — your browser may require HTTPS or a permission grant.',
      );
      return;
    }
    this.copiedItemId.set(item.id);
    setTimeout(() => {
      if (this.copiedItemId() === item.id) this.copiedItemId.set(null);
    }, 2000);
  }

  constructor() {
    // React to id changes so navigating between /vendors/A and /vendors/B refetches
    // without remounting the page. Resets per-route UI state on each switch.
    effect(() => {
      const id = this.id();
      this.vendor.set(null);
      this.logoFailed.set(false);
      this.editingSection.set(null);
      this.saveError.set(null);
      this.selectedRunId.set(null);
      this.api.getVendor(id).subscribe((vendor) => {
        if (this.id() === id) this.vendor.set(vendor);
      });
    });
    this.api.getPlaybooks().subscribe((rows) => {
      this.playbooks.set(rows);
    });
  }

  ngOnInit(): void {
    this.runs.start();
  }

  reload(): void {
    if (this.reloading()) return;
    const id = this.id();
    this.reloading.set(true);
    this.api.getVendor(id).subscribe({
      next: (vendor) => {
        if (this.id() === id) {
          this.vendor.set(vendor);
          this.logoFailed.set(false);
        }
        this.reloading.set(false);
      },
      error: () => this.reloading.set(false),
    });
  }

  vendorInitials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('');
  }

  hasFreshness(v: VendorDetail): boolean {
    return !!(
      v.lastEnrichedAt ||
      v.githubCheckedAt ||
      v.fundingCheckedAt ||
      v.crunchbaseCheckedAt
    );
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

  freshnessTooltip(iso: string): string {
    return `Updated ${formatDateWithRelative(iso)}`;
  }

  // ---- runs --------------------------------------------------------------
  onRunRowSelected(args: { data?: VendorRunRow }): void {
    if (args.data) this.selectedRunId.set(args.data.runId);
  }

  onRunDialogClosed(): void {
    this.selectedRunId.set(null);
  }

  // ---- edit -----------------------------------------------------------------
  startEdit(section: SectionKey, vendor: VendorDetail): void {
    this.saveError.set(null);
    Object.assign(this.draft, this.toDraft(vendor));
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
    this.api.updateVendor(id, patch).subscribe({
      next: (updated) => {
        this.vendor.set(updated);
        this.logoFailed.set(false);
        this.saving.set(false);
        this.editingSection.set(null);
      },
      error: (err) => {
        this.saving.set(false);
        this.saveError.set(err?.error?.error ?? err?.message ?? 'Save failed');
      },
    });
  }

  // ---- delete ---------------------------------------------------------------
  deleteVendor(vendor: VendorDetail): void {
    if (this.deleting()) return;
    const linkedCount = vendor.toolCount ?? 0;
    const warning =
      linkedCount > 0
        ? `${vendor.companyName} is linked to ${linkedCount} product${linkedCount === 1 ? '' : 's'}. ` +
          `Those products will lose their vendor link but otherwise stay intact.\n\n`
        : '';
    const confirmed = window.confirm(
      `${warning}Permanently delete ${vendor.companyName}? This cannot be undone.`,
    );
    if (!confirmed) return;

    const id = this.id();
    this.deleting.set(true);
    this.deleteError.set(null);
    this.api.deleteVendor(id).subscribe({
      next: () => {
        this.deleting.set(false);
        this.router.navigate(['/vendors']);
      },
      error: (err) => {
        this.deleting.set(false);
        this.deleteError.set(err?.error?.error ?? err?.message ?? 'Delete failed');
      },
    });
  }

  // ---- helpers --------------------------------------------------------------
  private emptyDraft(): DraftState {
    return {
      companyName: '',
      website: '',
      linkedinUrl: '',
      crunchbaseUrl: '',
      wikiUrl: '',
      githubOrg: '',
      sourceUrl: '',
      headquarters: '',
      foundedYear: null,
      publicPrivate: '',
      parentCompany: '',
      phoneNumber: '',
      contactEmail: '',
      description: '',
      adminNotes: '',
    };
  }

  private toDraft(v: VendorDetail): DraftState {
    return {
      companyName: v.companyName,
      website: v.website ?? '',
      linkedinUrl: v.linkedinUrl ?? '',
      crunchbaseUrl: v.crunchbaseUrl ?? '',
      wikiUrl: v.wikiUrl ?? '',
      githubOrg: v.githubOrg ?? '',
      sourceUrl: v.sourceUrl ?? '',
      headquarters: v.headquarters ?? '',
      foundedYear: typeof v.foundedYear === 'number' ? v.foundedYear : null,
      publicPrivate: v.publicPrivate ?? '',
      parentCompany: v.parentCompany ?? '',
      phoneNumber: v.phoneNumber ?? '',
      contactEmail: v.contactEmail ?? '',
      description: v.description ?? '',
      adminNotes: v.adminNotes ?? '',
    };
  }

  private buildPatch(section: SectionKey): UpdateVendorRequest {
    const d = this.draft;
    switch (section) {
      case 'header':
        return {
          companyName: d.companyName.trim(),
          website: d.website.trim(),
        };
      case 'links':
        return {
          linkedinUrl: d.linkedinUrl.trim(),
          crunchbaseUrl: d.crunchbaseUrl.trim(),
          wikiUrl: d.wikiUrl.trim(),
          githubOrg: d.githubOrg.trim(),
          sourceUrl: d.sourceUrl.trim(),
        };
      case 'keyFacts': {
        const year = d.foundedYear;
        return {
          headquarters: d.headquarters.trim(),
          foundedYear: typeof year === 'number' && Number.isFinite(year) ? year : null,
          publicPrivate: d.publicPrivate === '' ? null : d.publicPrivate,
          parentCompany: d.parentCompany.trim(),
          phoneNumber: d.phoneNumber.trim(),
          contactEmail: d.contactEmail.trim(),
        };
      }
      case 'description':
        return { description: d.description };
      case 'adminNotes':
        return { adminNotes: d.adminNotes };
    }
  }
}
