// Full-page modal that explains how a vendor's VQS or a tool's priority score
// was computed. Lazily fetches the detail (the list endpoints omit pillar
// scores and the raw inputs that drove them) and renders a pillar breakdown
// with a tier reference table and human-readable flags.
//
// Family-aware: vendor and tool surfaces share the same shell, the shape of
// their pillars and inputs is defined in tier-info + the per-family input
// list below.
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
import { ToolDetail, VendorDetail } from '../../types';
import {
  PILLAR_META,
  TIER_ORDER,
  type PillarMeta,
  type ScoreFamily,
  confidenceVariant,
  flagLabel,
  normalizeTierKey,
  pillarsFor,
  tierMapFor,
  tierMetaFor,
} from '../tier-info/tier-info';

interface PillarRow {
  meta: PillarMeta;
  score: number | null | undefined;
  inputs: Array<{ label: string; value: string; missing: boolean }>;
}

interface ScoreSubject {
  /** Title shown in the dialog header. */
  name: string;
  /** Composite 0–100 score for the entity. */
  score: number | null | undefined;
  /** Display tier like 'Tier 2' or 'Unscored'. */
  tier: string;
  confidence: string | undefined;
  flags: string[];
  pillars: PillarRow[];
  /** Footer link target. */
  recordRouterLink: unknown[];
  recordLinkLabel: string;
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

  /** Family controls which detail endpoint we fetch and which pillars render. */
  readonly family = input<ScoreFamily>('vendor');
  /** Set to a vendor or tool id to open the dialog; null to close. */
  readonly vendorId = input<string | null>(null);
  /** Optional fallback name shown in the header while the detail loads. */
  readonly vendorName = input<string>('');

  readonly closed = output<void>();

  protected readonly vendor = signal<VendorDetail | null>(null);
  protected readonly tool = signal<ToolDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly errorMsg = signal<string | null>(null);

  protected readonly tierOrder = TIER_ORDER;
  protected readonly tierMetaMap = computed(() => tierMapFor(this.family()));
  protected readonly flagLabel = flagLabel;

  protected readonly visible = computed(() => this.vendorId() !== null);

  /** Family-aware adapter that the template renders against. */
  protected readonly subject = computed<ScoreSubject | null>(() => {
    if (this.family() === 'tool') {
      const t = this.tool();
      if (!t) return null;
      return toolSubject(t, this.vendorName());
    }
    const v = this.vendor();
    if (!v) return null;
    return vendorSubject(v, this.vendorName());
  });

  protected readonly tierMeta = computed(() =>
    tierMetaFor(this.subject()?.tier, this.family()),
  );

  protected readonly confidenceVariant = computed(() =>
    confidenceVariant(this.subject()?.confidence),
  );

  protected readonly headerName = computed(
    () => this.subject()?.name || this.vendorName() || labelForFamily(this.family()),
  );

  /** Resolved tier key (e.g. 'Tier 2'); used by the reference-table highlight. */
  protected readonly currentTierKey = computed(
    () => normalizeTierKey(this.subject()?.tier) ?? 'Unscored',
  );

  constructor() {
    // Fetch detail when the id changes, or reset state on close. Re-runs when
    // family flips so a tool ID + vendor family doesn't accidentally try to
    // load a vendor.
    effect(() => {
      const id = this.vendorId();
      const fam = this.family();
      if (!id) {
        this.vendor.set(null);
        this.tool.set(null);
        this.errorMsg.set(null);
        this.loading.set(false);
        return;
      }
      this.fetch(id, fam);
    });

    // After the detail loads, force the dialog body to scroll to the top.
    // Syncfusion otherwise preserves the browser's last scroll position when
    // the modal grew taller than the viewport — leaving the user staring at
    // the highlighted "current tier" row near the bottom instead of the
    // headline score.
    effect(() => {
      const ready = this.subject() !== null;
      if (!ready) return;
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
    if (id) this.fetch(id, this.family());
  }

  private fetch(id: string, family: ScoreFamily): void {
    this.loading.set(true);
    this.errorMsg.set(null);
    this.vendor.set(null);
    this.tool.set(null);
    if (family === 'tool') {
      this.api.getTool(id).subscribe({
        next: (detail) => {
          this.tool.set(detail);
          this.loading.set(false);
        },
        error: () => {
          this.loading.set(false);
          this.errorMsg.set("Couldn't load scoring details. Please try again.");
        },
      });
    } else {
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
  }
}

// ---------------------------------------------------------------------------
// Family adapters
// ---------------------------------------------------------------------------

function vendorSubject(v: VendorDetail, fallbackName: string): ScoreSubject {
  return {
    name: v.companyName || fallbackName,
    score: v.vqsScore,
    tier: v.vqsTier ?? 'Unscored',
    confidence: v.vqsConfidence,
    flags: v.vqsFlags ?? [],
    pillars: PILLAR_META.map((meta) => ({
      meta,
      score: vendorScoreFor(v, meta.key),
      inputs: vendorInputsFor(v, meta.key),
    })),
    recordRouterLink: ['/vendors', v.id],
    recordLinkLabel: 'View full vendor record',
  };
}

function toolSubject(t: ToolDetail, fallbackName: string): ScoreSubject {
  return {
    name: t.name || fallbackName,
    score: t.priorityScore,
    // ToolDetail.priorityTier is plain '1'..'5' or 'Unscored' — normalize to
    // the 'Tier N' form the dialog expects.
    tier: t.priorityTier ? normalizeTierKey(t.priorityTier) ?? 'Unscored' : 'Unscored',
    confidence: t.priorityConfidence,
    flags: t.priorityFlags ?? [],
    pillars: pillarsFor('tool').map((meta) => ({
      meta,
      score: toolScoreFor(t, meta.key),
      inputs: toolInputsFor(t, meta.key),
    })),
    recordRouterLink: ['/tools', t.id],
    recordLinkLabel: 'View full tool record',
  };
}

function vendorScoreFor(
  v: VendorDetail,
  key: PillarMeta['key'],
): number | null | undefined {
  if (key === 'credibility') return v.vqsCredibility ?? null;
  if (key === 'momentum') return v.vqsMomentum ?? null;
  if (key === 'fit') return v.vqsFit ?? null;
  return undefined;
}

function vendorInputsFor(
  v: VendorDetail,
  key: PillarMeta['key'],
): PillarRow['inputs'] {
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
  if (key === 'fit') {
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
  return [];
}

function toolScoreFor(
  t: ToolDetail,
  key: PillarMeta['key'],
): number | null | undefined {
  if (key === 'integration') return t.integrationScore ?? null;
  if (key === 'demand') return t.demandScore ?? null;
  return undefined;
}

function toolInputsFor(
  t: ToolDetail,
  key: PillarMeta['key'],
): PillarRow['inputs'] {
  if (key === 'integration') {
    return [
      labelFor('Has API docs', boolText(t.hasApiDocs)),
      labelFor(
        'AEC marketplaces',
        t.marketplaceCount !== undefined ? `${t.marketplaceCount} of 4` : undefined,
      ),
      labelFor(
        'Integrations',
        t.integrationCount !== undefined ? t.integrationCount.toLocaleString() : undefined,
      ),
      labelFor(
        'iPaaS platforms',
        t.ipaasCount !== undefined ? `${t.ipaasCount} of 3` : undefined,
      ),
    ];
  }
  if (key === 'demand') {
    const totalReviews =
      (t.g2ReviewCount ?? 0) + (t.capterraReviewCount ?? 0);
    const reviewsPresent =
      t.g2ReviewCount !== undefined || t.capterraReviewCount !== undefined;
    const bestRating = t.g2Rating ?? t.capterraRating;
    return [
      labelFor(
        'Total reviews',
        reviewsPresent ? totalReviews.toLocaleString() : undefined,
      ),
      labelFor(
        'Best rating',
        bestRating !== undefined ? `${bestRating.toFixed(1)} / 5` : undefined,
      ),
      labelFor(
        'Search volume / mo',
        t.searchVolumeMonthly !== undefined
          ? t.searchVolumeMonthly.toLocaleString()
          : undefined,
      ),
      labelFor(
        'Google Trends',
        t.googleTrendsIndex !== undefined ? `${t.googleTrendsIndex} / 100` : undefined,
      ),
      labelFor(
        'Reddit mentions (24mo)',
        t.redditMentions24mo !== undefined
          ? t.redditMentions24mo.toLocaleString()
          : undefined,
      ),
    ];
  }
  return [];
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

function labelForFamily(family: ScoreFamily): string {
  return family === 'tool' ? 'Tool' : 'Vendor';
}
