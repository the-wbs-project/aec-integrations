import { Component, inject, signal, input, computed, effect } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';
import { formatDate, formatDateWithRelative } from '../../utils/date';
import { UpdateVendorRequest, VendorDetail } from '../../types';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { InfoTooltipComponent } from '../../components/info-tooltip/info-tooltip.component';
import { enrichmentVariant } from '../../utils/enrichment';

type SectionKey = 'header' | 'links' | 'keyFacts' | 'description';

interface DraftState {
  // header
  companyName: string;
  website: string;
  // links
  linkedinUrl: string;
  crunchbaseUrl: string;
  githubOrg: string;
  sourceUrl: string;
  blogUrl: string;
  // key facts
  headquarters: string;
  foundedYear: string; // bound to <input type="number"> as string for empty handling
  publicPrivate: string;
  parentCompany: string;
  // description
  description: string;
}

const PUBLIC_PRIVATE_OPTIONS = ['', 'Public', 'Private', 'Subsidiary', 'Nonprofit'] as const;

@Component({
  selector: 'app-vendor-detail',
  imports: [
    RouterLink,
    CurrencyPipe,
    DecimalPipe,
    FormsModule,
    EnrichSplitButtonComponent,
    InfoTooltipComponent,
  ],
  templateUrl: './vendor-detail.component.html',
  styleUrl: './vendor-detail.component.scss',
})
export class VendorDetailComponent {
  id = input.required<string>();

  private api = inject(ApiService);
  vendor = signal<VendorDetail | null>(null);
  logoFailed = signal(false);
  recordIds = computed(() => (this.vendor() ? [this.id()] : []));
  enrichmentVariant = enrichmentVariant;

  editingSection = signal<SectionKey | null>(null);
  saving = signal(false);
  saveError = signal<string | null>(null);

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
      this.api.getVendor(id).subscribe((vendor) => {
        if (this.id() === id) this.vendor.set(vendor);
      });
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

  truncate(value: string, max: number): string {
    if (!value) return '';
    return value.length <= max ? value : value.slice(0, max - 1).trimEnd() + '…';
  }

  hasFreshness(v: VendorDetail): boolean {
    return !!(
      v.lastEnrichedAt ||
      v.githubCheckedAt ||
      v.fundingCheckedAt ||
      v.pressCheckedAt ||
      v.blogCheckedAt ||
      v.linkedinCheckedAt
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
      githubOrg: '',
      sourceUrl: '',
      blogUrl: '',
      headquarters: '',
      foundedYear: '',
      publicPrivate: '',
      parentCompany: '',
      description: '',
    };
  }

  private toDraft(v: VendorDetail): DraftState {
    return {
      companyName: v.companyName,
      website: v.website ?? '',
      linkedinUrl: v.linkedinUrl ?? '',
      crunchbaseUrl: v.crunchbaseUrl ?? '',
      githubOrg: v.githubOrg ?? '',
      sourceUrl: v.sourceUrl ?? '',
      blogUrl: v.blogUrl ?? '',
      headquarters: v.headquarters ?? '',
      foundedYear: v.foundedYear !== undefined ? String(v.foundedYear) : '',
      publicPrivate: v.publicPrivate ?? '',
      parentCompany: v.parentCompany ?? '',
      description: v.description ?? '',
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
          githubOrg: d.githubOrg.trim(),
          sourceUrl: d.sourceUrl.trim(),
          blogUrl: d.blogUrl.trim(),
        };
      case 'keyFacts': {
        const yearStr = d.foundedYear.trim();
        const year = yearStr === '' ? null : Number(yearStr);
        return {
          headquarters: d.headquarters.trim(),
          // Send null when blank; valid integer otherwise. Fall back to
          // current value if the user typed something non-numeric — server
          // will reject anyway and surface the message.
          foundedYear: yearStr === '' ? null : Number.isFinite(year) ? (year as number) : null,
          publicPrivate: d.publicPrivate === '' ? null : d.publicPrivate,
          parentCompany: d.parentCompany.trim(),
        };
      }
      case 'description':
        return { description: d.description };
    }
  }
}
