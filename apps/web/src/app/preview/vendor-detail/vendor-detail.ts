import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { BrnButton } from '@spartan-ng/brain/button';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';
import { BrnTabs, BrnTabsList, BrnTabsTrigger } from '@spartan-ng/brain/tabs';

import {
  CategoryRanking,
  PRODUCTS_FIXTURE,
  Product,
  StarBucket,
  VENDOR_FIXTURE,
} from './vendor-detail.fixtures';

@Component({
  selector: 'app-vendor-detail',
  imports: [
    BrnButton,
    BrnPopover,
    BrnPopoverContent,
    BrnPopoverTrigger,
    BrnTabs,
    BrnTabsList,
    BrnTabsTrigger,
  ],
  templateUrl: './vendor-detail.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VendorDetail {
  protected readonly activeTab = signal<'overview' | 'products'>('overview');
  protected readonly stars = [1, 2, 3, 4, 5] as const;

  protected readonly vendor = VENDOR_FIXTURE;
  protected readonly products = PRODUCTS_FIXTURE;

  protected sortedRankings(product: Product): ReadonlyArray<CategoryRanking> {
    return [...product.rankings].sort((a, b) => {
      if (a.rank === null && b.rank === null) return a.category.localeCompare(b.category);
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    });
  }

  protected sortedDistribution(product: Product): ReadonlyArray<StarBucket> {
    return [...product.distribution].sort((a, b) => b.stars - a.stars);
  }

  protected onTabChange(key: string | undefined): void {
    if (key === 'overview' || key === 'products') {
      this.activeTab.set(key);
    }
  }

  protected tabTriggerClass(key: 'overview' | 'products'): string {
    const base =
      '-mb-px cursor-pointer border-b-2 px-1 pb-3 text-sm font-medium tracking-wide transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--accent-primary)';
    const active = 'border-(--accent-primary) text-(--text-primary)';
    const inactive = 'border-transparent text-(--text-tertiary) hover:text-(--text-secondary)';
    return `${base} ${this.activeTab() === key ? active : inactive}`;
  }

  protected roundedScore(score: number): number {
    return Math.round(score);
  }

  protected starClass(position: number, score: number): string {
    return position <= this.roundedScore(score)
      ? 'text-sm text-(--accent-primary)'
      : 'text-sm text-(--border-strong)';
  }

  protected bucketPercent(product: Product, bucket: StarBucket): number {
    if (product.reviewCount === 0) return 0;
    return Math.round((bucket.count / product.reviewCount) * 100);
  }

  protected formatDate(iso: string): string {
    const date = new Date(iso + 'T00:00:00Z');
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
}
