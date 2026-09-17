/**
 * `VendorGlanceBand` (AECI-983). Pins the three rules the band adds to the home
 * cards' vocabulary: a zero is a sentence, red appears only for a real conflict,
 * and each tile routes to where the vendor can act. The retry's announcement is
 * owned by the overview section and pinned in the dashboard spec.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProductClaimCount } from '../overview/vendor-overview-model';

import { VendorGlanceBand } from './vendor-glance-band';

const SUMMIT: ProductClaimCount = {
  product: { id: 'p1', slug: 'summit-model-coordination', name: 'Summit Model Coordination' },
  count: 2,
};
const FIELD: ProductClaimCount = {
  product: { id: 'p2', slug: 'summit-field-issues', name: 'Summit Field Issues' },
  count: 1,
};

@Component({
  imports: [VendorGlanceBand],
  template: `<aec-vendor-glance-band
    [conflictTotal]="total()"
    [conflictProducts]="products()"
    [conflictsLoading]="loading()"
    [conflictsFailed]="failed()"
    [openCorrections]="corrections()"
    [newestCorrectionAt]="newest()"
    (retry)="retries.set(retries() + 1)"
  />`,
})
class Host {
  readonly total = signal(0);
  readonly products = signal<readonly ProductClaimCount[]>([]);
  readonly loading = signal(false);
  readonly failed = signal(false);
  readonly corrections = signal(0);
  readonly newest = signal<string | null>(null);
  readonly retries = signal(0);
}

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: 'vendor/:slug/overview', component: Host }]),
    ],
  });
});

async function create(set: (h: Host) => void = () => undefined): Promise<ComponentFixture<Host>> {
  const fixture = TestBed.createComponent(Host);
  set(fixture.componentInstance);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

const el = (f: ComponentFixture<Host>) => f.nativeElement as HTMLElement;
const tile = (f: ComponentFixture<Host>, name: string) =>
  el(f).querySelector<HTMLAnchorElement>(`[data-tile="${name}"]`);
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

describe('VendorGlanceBand — zero states', () => {
  it('renders sentences, never a bare 0, and no red', async () => {
    const fixture = await create();

    const conflict = tile(fixture, 'conflict');
    const suggestions = tile(fixture, 'suggestions');
    expect(clean(conflict?.textContent)).toContain('No conflicts');
    expect(clean(suggestions?.textContent)).toContain('None open');
    expect(clean(el(fixture).textContent)).not.toMatch(/\b0\b/);
    expect(el(fixture).querySelector('.text-\\(--status-error\\)')).toBeNull();
  });

  it('labels the region and each tile link', async () => {
    const fixture = await create();
    expect(el(fixture).querySelector('section')?.getAttribute('aria-label')).toBe(
      'Your account at a glance',
    );
    expect(tile(fixture, 'conflict')?.getAttribute('aria-label')).toBe(
      'No data flows in conflict. Open your products.',
    );
  });
});

describe('VendorGlanceBand — populated', () => {
  it('shows the conflict figure in the error token, naming the one product', async () => {
    const fixture = await create((h) => {
      h.total.set(2);
      h.products.set([SUMMIT]);
    });
    const conflict = tile(fixture, 'conflict');
    const figure = conflict?.querySelector('.text-5xl');

    expect(figure?.textContent?.trim()).toBe('2');
    expect(figure?.classList.contains('text-(--status-error)')).toBe(true);
    expect(clean(conflict?.textContent)).toContain('On Summit Model Coordination');
  });

  it('says "Across N products" when conflicts span several', async () => {
    const fixture = await create((h) => {
      h.total.set(3);
      h.products.set([SUMMIT, FIELD]);
    });
    expect(clean(tile(fixture, 'conflict')?.textContent)).toContain('Across 2 products');
  });

  it('shows open suggestions with the newest filing date, in UTC', async () => {
    const fixture = await create((h) => {
      h.corrections.set(2);
      h.newest.set('2026-08-02T23:30:00.000Z');
    });
    const suggestions = tile(fixture, 'suggestions');
    expect(suggestions?.querySelector('.text-5xl')?.textContent?.trim()).toBe('2');
    expect(clean(suggestions?.textContent)).toContain('Newest filed August 2, 2026');
    expect(clean(suggestions?.textContent)).not.toMatch(/repl/i);
  });
});

describe('VendorGlanceBand — links', () => {
  it('routes conflicts to the first conflicted product, and suggestions to Messages', async () => {
    const harnessUrl = '/vendor/summit-bim/overview';
    const harness = await RouterTestingHarness.create(harnessUrl);
    const host = harness.routeDebugElement!.componentInstance as Host;
    host.total.set(2);
    host.products.set([SUMMIT, FIELD]);
    harness.detectChanges();
    await harness.fixture.whenStable();

    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('[data-tile="conflict"]')?.getAttribute('href')).toBe(
      '/vendor/summit-bim/products/summit-model-coordination/integrations?status=conflict',
    );
    expect(root.querySelector('[data-tile="suggestions"]')?.getAttribute('href')).toBe(
      '/vendor/summit-bim/messages',
    );

    host.total.set(0);
    host.products.set([]);
    harness.detectChanges();
    expect(root.querySelector('[data-tile="conflict"]')?.getAttribute('href')).toBe(
      '/vendor/summit-bim/products',
    );
  });
});

describe('VendorGlanceBand — loading and failure', () => {
  it('marks the conflict tile busy while the integrations read settles', async () => {
    const fixture = await create((h) => h.loading.set(true));
    const busy = el(fixture).querySelector('[aria-busy="true"]');
    expect(clean(busy?.textContent)).toContain('Checking your data flows');
    expect(tile(fixture, 'conflict')).toBeNull();
    expect(el(fixture).querySelector('[role="status"]')).toBeNull();
  });

  it('offers Try again on failure and emits retry', async () => {
    const fixture = await create((h) => h.failed.set(true));
    expect(clean(el(fixture).textContent)).toContain('Could not load your data flows.');

    const button = [...el(fixture).querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Try again',
    );
    button!.click();
    expect(fixture.componentInstance.retries()).toBe(1);
  });
});
