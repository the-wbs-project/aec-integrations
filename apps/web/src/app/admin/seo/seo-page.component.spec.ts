/**
 * AECI-822. `SeoPage` owns the one polite live region (§5.24.11).
 *
 * The case this spec exists for: copying the same URL twice must announce
 * twice. A live region bound to one signal string would set the same text and
 * change nothing in the DOM, so a screen reader would stay silent.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SeoFunnelResponse, SeoQueueResponse, SeoTrendResponse } from '@aeci/shared';

import { AdminSeoApi } from './admin-seo.api';
import { SeoPage } from './seo-page';

const QUEUE: SeoQueueResponse = {
  generated_at: '2027-01-12T09:00:00.000Z',
  window: {
    from: '2026-12-15T09:00:00.000Z',
    to: '2027-01-12T09:00:00.000Z',
    timezone: 'UTC',
    days: 28,
  },
  lanes: [
    {
      lane: 'reindex',
      engine: 'google',
      count: 1,
      oldest_tier12_age_days: 1,
      href: '/admin/reindex',
    },
    { lane: 'uncrawled', engine: 'google', count: 1, oldest_tier12_age_days: null, href: null },
    { lane: 'uncrawled', engine: 'bing', count: 0, oldest_tier12_age_days: null, href: null },
  ],
  items: {
    lane: 'uncrawled',
    engine: 'google',
    data: [
      {
        url: 'https://x.test/products/a',
        page_type: 'product',
        published_at: null,
        age_days: null,
        last_fetch_at: null,
      },
    ],
    page: 1,
    perPage: 25,
    total: 1,
  },
  notes: [],
};

const TREND: SeoTrendResponse = { generated_at: QUEUE.generated_at, weeks: [], notes: [] };

const FUNNEL: SeoFunnelResponse = {
  generated_at: QUEUE.generated_at,
  day: '2027-01-11',
  crawl_window: QUEUE.window,
  engines: [],
  notes: [],
};

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('SeoPage live region', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('announces the same message twice by replacing the node, not by setting equal text', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => undefined) } });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: AdminSeoApi,
          useValue: {
            queue: vi.fn(async () => QUEUE),
            trend: vi.fn(async () => TREND),
            funnel: vi.fn(async () => FUNNEL),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(SeoPage);
    fixture.detectChanges();
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const region = el.querySelector('[role="status"]')!;
    const copy = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Copy')!;

    copy.click();
    await settle();
    fixture.detectChanges();
    const first = region.querySelector('span');
    expect(first?.textContent).toBe('Copied https://x.test/products/a');

    copy.click();
    await settle();
    fixture.detectChanges();
    const second = region.querySelector('span');
    expect(second?.textContent).toBe('Copied https://x.test/products/a');
    // A new node, so assistive technology hears the repeat.
    expect(second).not.toBe(first);
    expect(region.querySelectorAll('span')).toHaveLength(1);
  });
});
