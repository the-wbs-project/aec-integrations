/**
 * AECI-1810 — the Vendor Overview in the new design language (mock-up 13).
 *
 * The rules under test are layout rules the owner ruled on 2026-11-24: the
 * "What needs you" rows share ONE card divided by hairlines, each row carries a
 * dense `aec-chip`, and a vendor with nothing outstanding sees the all-clear card
 * and no list card. The row logic itself is `vendor-overview-model.spec.ts`.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorMeResponse } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorOverviewSection } from './vendor-overview-section';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const api = {
  getIntegrations: async () => ({ integrations: [], owned: [], counterpart_added_unanswered: 0 }),
  getSeats: async () => ({
    seats: [],
    pending_invites: [],
    can_manage_seats: true,
    pending_claims: [],
  }),
  getContests: async () => ({ submitted: [], received: [] }),
  getChecklist: async () => {
    throw new Error('not under test');
  },
  listReviews: async () => ({ items: [], total: 0, page: 1, per_page: 1 }),
};

/** Every gap the overview reports, filled: nothing is outstanding. */
const CLEAR_ME: VendorMeResponse = {
  ...VENDOR_ME_FIXTURE,
  requests: [],
  vendor: {
    ...VENDOR_ME_FIXTURE.vendor,
    description: 'A company.',
    website: 'https://example.com',
    logo_url: 'https://example.com/logo.png',
    headquarters: 'Austin, Texas',
  },
  products: VENDOR_ME_FIXTURE.products.map((p) => ({
    ...p,
    description: 'A product.',
    website: 'https://example.com',
    logo_url: 'https://example.com/logo.png',
    category_slugs: p.category_slugs.length > 0 ? p.category_slugs : ['bim-authoring'],
  })),
};

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: VendorApi, useValue: api },
      VendorPortalStore,
    ],
  });
});

async function render(me: VendorMeResponse): Promise<HTMLElement> {
  TestBed.inject(VendorPortalStore).seed(me);
  const fixture = TestBed.createComponent(VendorOverviewSection);
  fixture.detectChanges();
  for (let i = 0; i < 4; i++) {
    await flush();
    fixture.detectChanges();
    await fixture.whenStable();
  }
  return fixture.nativeElement as HTMLElement;
}

describe('VendorOverviewSection — the new design language (AECI-1810)', () => {
  it('puts every "What needs you" row in one card, each with a dense chip', async () => {
    const el = await render(VENDOR_ME_FIXTURE);
    const cards = el.querySelectorAll('[data-testid="needs-card"]');
    const rows = el.querySelectorAll('[data-item]');

    expect(cards.length).toBe(1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(cards[0]!.contains(row)).toBe(true);
      expect(row.querySelector('aec-chip [data-density="dense"]')).not.toBeNull();
    }
    expect(cards[0]!.classList.contains('aec-card')).toBe(true);
    // A chip with a clock on it (strong edge) carries the "!" mark, as on the
    // Integrations list. A quiet (sunken) chip carries none.
    const strong = el.querySelectorAll('[data-item] .aec-chip[data-tone="strong"]');
    expect(strong.length).toBeGreaterThan(0);
    for (const chip of strong) {
      expect(chip.hasAttribute('data-icon')).toBe(true);
      expect(chip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    for (const chip of el.querySelectorAll('[data-item] .aec-chip[data-tone="sunken"]')) {
      expect(chip.hasAttribute('data-icon')).toBe(false);
    }
    // No row is its own bordered box any more.
    expect(el.querySelector('[data-item].rounded-\\(--radius-md\\)')).toBeNull();
  });

  it('shows the all-clear card, and no list card, when nothing is outstanding', async () => {
    const el = await render(CLEAR_ME);
    const text = (el.textContent ?? '').replace(/\s+/g, ' ');

    expect(text).toContain('Nothing needs you right now.');
    expect(text).toContain('Nothing is outstanding.');
    expect(el.querySelector('[data-testid="needs-card"]')).toBeNull();
    expect(el.querySelectorAll('[data-item]').length).toBe(0);
  });

  it('keeps the glance band and the checklist before the list in the DOM, so phones read them first', async () => {
    const el = await render(VENDOR_ME_FIXTURE);
    const band = el.querySelector('aec-vendor-glance-band');
    const needs = el.querySelector('#vendor-overview-needs-h');
    expect(band && needs).toBeTruthy();
    expect(band!.compareDocumentPosition(needs!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
