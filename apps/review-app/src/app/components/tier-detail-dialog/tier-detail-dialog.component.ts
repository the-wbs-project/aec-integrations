// Full-page modal that explains how a vendor's VQS was computed.
// Lazily fetches VendorDetail (the list endpoint omits pillar scores and the
// raw inputs that drove them) and renders a 3-pillar breakdown with a tier
// reference table and human-readable flags.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import { DialogModule } from '@syncfusion/ej2-angular-popups';
import { ApiService } from '../../services/api.service';
import { VendorDetail } from '../../types';
import {
  PILLAR_META,
  TIER_ORDER,
  TIER_META,
  type PillarMeta,
  confidenceVariant,
  flagLabel,
  tierMetaFor,
} from '../tier-info/tier-info';

interface PillarRow {
  meta: PillarMeta;
  score: number | null | undefined;
  inputs: Array<{ label: string; value: string; missing: boolean }>;
}

@Component({
  selector: 'app-tier-detail-dialog',
  standalone: true,
  imports: [CommonModule, RouterLink, DialogModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './tier-detail-dialog.component.html',
  styleUrl: './tier-detail-dialog.component.scss',
})
export class TierDetailDialogComponent {
  private readonly api = inject(ApiService);

  /** Set to a vendor id to open the dialog; null to close. */
  readonly vendorId = input<string | null>(null);
  /** Optional fallback name shown in the header while the detail loads. */
  readonly vendorName = input<string>('');

  readonly closed = output<void>();

  protected readonly vendor = signal<VendorDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly errorMsg = signal<string | null>(null);

  protected readonly tierOrder = TIER_ORDER;
  protected readonly tierMetaMap = TIER_META;
  protected readonly flagLabel = flagLabel;

  protected readonly visible = computed(() => this.vendorId() !== null);

  protected readonly headerName = computed(
    () => this.vendor()?.companyName || this.vendorName() || 'Vendor',
  );

  protected readonly tierMeta = computed(() =>
    tierMetaFor(this.vendor()?.vqsTier),
  );

  protected readonly confidenceVariant = computed(() =>
    confidenceVariant(this.vendor()?.vqsConfidence),
  );

  /** The full pillar breakdown with the per-vendor inputs threaded in. */
  protected readonly pillars = computed<PillarRow[]>(() => {
    const v = this.vendor();
    return PILLAR_META.map((meta) => ({
      meta,
      score: this.scoreFor(v, meta.key),
      inputs: this.inputsFor(v, meta.key),
    }));
  });

  constructor() {
    // Whenever the vendor id changes, fetch the detail (or reset state on close).
    effect(() => {
      const id = this.vendorId();
      if (!id) {
        this.vendor.set(null);
        this.errorMsg.set(null);
        this.loading.set(false);
        return;
      }
      this.fetch(id);
    });

    // After the vendor detail loads, force the dialog body to scroll to the
    // top. Syncfusion otherwise preserves whatever scroll position the
    // browser last set when the modal grew taller than the viewport — which
    // tends to leave the user staring at the highlighted "current tier" row
    // near the bottom instead of the headline score.
    effect(() => {
      const v = this.vendor();
      if (!v) return;
      requestAnimationFrame(() => {
        const content = document.querySelector(
          '.tier-detail-dialog .e-dlg-content',
        ) as HTMLElement | null;
        if (content) content.scrollTop = 0;
      });
    });
  }

  protected onClose(): void {
    this.closed.emit();
  }

  protected retry(): void {
    const id = this.vendorId();
    if (id) this.fetch(id);
  }

  private fetch(id: string): void {
    this.loading.set(true);
    this.errorMsg.set(null);
    this.vendor.set(null);
    this.api.getVendor(id).subscribe({
      next: (detail) => {
        this.vendor.set(detail);
        this.loading.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.errorMsg.set("Couldn't load scoring details. Please try again.");
      },
    });
  }

  private scoreFor(
    v: VendorDetail | null,
    key: PillarMeta['key'],
  ): number | null | undefined {
    if (!v) return undefined;
    if (key === 'credibility') return v.vqsCredibility ?? null;
    if (key === 'momentum') return v.vqsMomentum ?? null;
    return v.vqsFit ?? null;
  }

  private inputsFor(
    v: VendorDetail | null,
    key: PillarMeta['key'],
  ): PillarRow['inputs'] {
    if (!v) return [];
    if (key === 'credibility') {
      return [
        labelFor('Public/private', v.publicPrivate),
        labelFor('Parent company', v.parentCompany),
        labelFor('Funding stage', v.fundingStage),
        labelFor(
          'Crunchbase rank',
          v.crunchbaseRank !== undefined ? `#${v.crunchbaseRank.toLocaleString()}` : undefined,
        ),
        labelFor('Founded', v.foundedYear),
      ];
    }
    if (key === 'momentum') {
      return [
        labelFor(
          'Growth score',
          v.crunchbaseGrowthScore !== undefined
            ? `${v.crunchbaseGrowthScore} / 100`
            : undefined,
        ),
        labelFor(
          'Heat score',
          v.crunchbaseHeatScore !== undefined ? `${v.crunchbaseHeatScore} / 100` : undefined,
        ),
        labelFor(
          'Monthly web visits',
          v.monthlyWebVisits !== undefined ? v.monthlyWebVisits.toLocaleString() : undefined,
        ),
        labelFor(
          'Last GitHub commit',
          v.githubLastCommitDaysAgo !== undefined
            ? `${v.githubLastCommitDaysAgo} days ago`
            : undefined,
        ),
      ];
    }
    // fit
    return [
      labelFor('Has SDK repo', boolText(v.hasSdkRepo)),
      labelFor('GitHub org verified', boolText(v.githubOrgVerified)),
      labelFor(
        'GitHub repos',
        v.githubRepoCount !== undefined ? v.githubRepoCount.toLocaleString() : undefined,
      ),
      labelFor(
        'GitHub stars (total)',
        v.githubStarsTotal !== undefined ? v.githubStarsTotal.toLocaleString() : undefined,
      ),
      labelFor(
        'AEC categories',
        v.crunchbaseCategories && v.crunchbaseCategories.length > 0
          ? `${v.crunchbaseCategories.length} listed`
          : undefined,
      ),
    ];
  }
}

function labelFor(
  label: string,
  value: string | number | undefined | null,
): { label: string; value: string; missing: boolean } {
  if (value === undefined || value === null || value === '') {
    return { label, value: '—', missing: true };
  }
  return { label, value: String(value), missing: false };
}

function boolText(v: boolean | null | undefined): string | undefined {
  if (v === undefined || v === null) return undefined;
  return v ? 'Yes' : 'No';
}
