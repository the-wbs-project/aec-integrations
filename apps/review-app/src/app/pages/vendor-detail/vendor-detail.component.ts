import { Component, OnInit, inject, signal, input, computed } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { ApiService } from '../../services/api.service';
import { formatDate, formatDateWithRelative } from '../../utils/date';
import { VendorDetail } from '../../types';
import { EnrichSplitButtonComponent } from '../../components/enrich-split-button/enrich-split-button.component';
import { InfoTooltipComponent } from '../../components/info-tooltip/info-tooltip.component';
import { enrichmentVariant } from '../../utils/enrichment';

@Component({
  selector: 'app-vendor-detail',
  imports: [RouterLink, CurrencyPipe, DecimalPipe, EnrichSplitButtonComponent, InfoTooltipComponent],
  templateUrl: './vendor-detail.component.html',
  styleUrl: './vendor-detail.component.scss',
})
export class VendorDetailComponent implements OnInit {
  id = input.required<string>();

  private api = inject(ApiService);
  vendor = signal<VendorDetail | null>(null);
  logoFailed = signal(false);
  recordIds = computed(() => (this.vendor() ? [this.id()] : []));
  enrichmentVariant = enrichmentVariant;

  ngOnInit(): void {
    this.api.getVendor(this.id()).subscribe((vendor) => {
      this.vendor.set(vendor);
      this.logoFailed.set(false);
    });
  }

  vendorInitials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(w => w[0]?.toUpperCase() ?? '')
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
}
