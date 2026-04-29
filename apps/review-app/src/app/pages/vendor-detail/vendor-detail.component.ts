import { Component, inject, signal, input, computed, effect, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GridModule, PageService, SortService, FilterService } from '@syncfusion/ej2-angular-grids';
import { ButtonModule } from '@syncfusion/ej2-angular-buttons';
import { ApiService } from '../../services/api.service';
import { RunsService, type RecentRunRow } from '../../services/runs.service';
import { formatDate, formatDateWithRelative } from '../../utils/date';
import { UpdateVendorRequest, VendorDetail } from '../../types';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { InfoTooltipComponent } from '../../components/info-tooltip/info-tooltip.component';
import { RunDetailDialogComponent } from '../../components/run-detail-dialog/run-detail-dialog.component';
import { TierCellComponent } from '../../components/tier-cell/tier-cell.component';
import { TierDetailDialogComponent } from '../../components/tier-detail-dialog/tier-detail-dialog.component';
import { enrichmentVariant } from '../../utils/enrichment';
import { WORKFLOWS } from '../../workflows';

type SectionKey = 'header' | 'links' | 'keyFacts' | 'description' | 'adminNotes';
type TabKey = 'details' | 'tools' | 'runs';

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

@Component({
  selector: 'app-vendor-detail',
  imports: [
    CommonModule,
    RouterLink,
    DecimalPipe,
    FormsModule,
    GridModule,
    ButtonModule,
    EnrichSplitButtonComponent,
    InfoTooltipComponent,
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

  private api = inject(ApiService);
  protected runs = inject(RunsService);

  vendor = signal<VendorDetail | null>(null);
  logoFailed = signal(false);
  recordIds = computed(() => (this.vendor() ? [this.id()] : []));
  enrichmentVariant = enrichmentVariant;

  editingSection = signal<SectionKey | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);
  reloading = signal(false);

  activeTab = signal<TabKey>('details');

  // Tier-detail modal — opened from the headline tier cell. Set to a vendor id
  // to show; null to close.
  protected readonly tierModalVendorId = signal<string | null>(null);

  openTierModal(): void {
    this.tierModalVendorId.set(this.id());
  }
  closeTierModal(): void {
    this.tierModalVendorId.set(null);
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

  constructor() {
    // React to id changes so navigating between /vendors/A and /vendors/B refetches
    // without remounting the page. Resets per-route UI state on each switch.
    effect(() => {
      const id = this.id();
      this.vendor.set(null);
      this.logoFailed.set(false);
      this.editingSection.set(null);
      this.saveError.set(null);
      this.activeTab.set('details');
      this.selectedRunId.set(null);
      this.api.getVendor(id).subscribe((vendor) => {
        if (this.id() === id) this.vendor.set(vendor);
      });
    });
  }

  ngOnInit(): void {
    this.runs.start();
  }

  setTab(tab: TabKey): void {
    this.activeTab.set(tab);
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
