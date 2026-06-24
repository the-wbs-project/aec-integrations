import { Component, OnInit, inject, signal } from '@angular/core';
import { Tab, TabContent, TabList, TabPanel, Tabs } from '@angular/aria/tabs';
import { BrnButton } from '@spartan-ng/brain/button';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import type { VendorDetail as VendorDetailContract } from '@aeci/shared';

import { MetaService } from '../../core/meta.service';

import {
  CategoryRanking,
  PRODUCTS_FIXTURE,
  Product,
  StarBucket,
  VENDOR_FIXTURE,
} from './vendor-detail.fixtures';

/**
 * Adapts the local hand-rolled fixture (which predates the `@aeci/shared`
 * contracts) into the canonical `VendorDetail` shape so `MetaService` has a
 * spec-compliant payload to render JSON-LD from. Only the fields the service
 * actually reads are populated; the rest are placeholder zeros.
 */
const VENDOR_DETAIL_FIXTURE: VendorDetailContract = {
  id: '00000000-0000-0000-0000-00000000aaaa',
  slug: 'procore',
  company_name: VENDOR_FIXTURE.name,
  logo_url: null,
  verified: true,
  product_count: 0,
  integration_count: 0,
  review_count: 0,
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  description: VENDOR_FIXTURE.tagline,
  website: VENDOR_FIXTURE.website,
  headquarters: VENDOR_FIXTURE.hq,
  founded_year: VENDOR_FIXTURE.founded,
  linkedin_url: null,
  x_url: null,
  facebook_url: null,
  instagram_url: null,
  youtube_url: null,
  products: [],
};

@Component({
  selector: 'app-vendor-detail',
  imports: [
    BrnButton,
    BrnPopover,
    BrnPopoverContent,
    BrnPopoverTrigger,
    Tabs,
    TabList,
    Tab,
    TabPanel,
    TabContent,
  ],
  templateUrl: './vendor-detail.html',
})
export class VendorDetail implements OnInit {
  private readonly meta = inject(MetaService);

  // Two-way-bound to `ngTabList`'s `selectedTab` model (typed `string | undefined`),
  // seeded so the Overview panel renders on load. Spartan's `BrnTabs` needed a
  // separate `onTabChange()` writeback + a `tabTriggerClass()` method mirroring this
  // state for styling; Angular Aria drives both off the model + `[aria-selected]`.
  protected readonly selectedTab = signal<string | undefined>('overview');
  protected readonly stars = [1, 2, 3, 4, 5] as const;

  protected readonly vendor = VENDOR_FIXTURE;
  protected readonly products = PRODUCTS_FIXTURE;

  ngOnInit(): void {
    this.meta.setEntityMeta({
      entity: 'vendor',
      name: VENDOR_DETAIL_FIXTURE.company_name,
      description: VENDOR_DETAIL_FIXTURE.description,
      canonical: 'https://aecintegrations.com/preview/vendor-detail',
    });
    this.meta.setVendorJsonLd(VENDOR_DETAIL_FIXTURE);
  }

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

  protected roundedScore(score: number): number {
    return Math.round(score);
  }

  protected starClass(position: number, score: number): string {
    return position <= this.roundedScore(score)
      ? 'text-sm text-(--accent-rating)'
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
