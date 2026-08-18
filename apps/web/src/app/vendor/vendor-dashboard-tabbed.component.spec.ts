/**
 * AECI-606 — the tabbed dashboard shell's new Integrations tab.
 *
 * The shell had no spec before this (it was covered only by the e2e). These
 * cases pin the three edit points §6 names — the `Tab` union, the `tabs` array,
 * and the `@switch` — plus the property that makes the whole surface work:
 * the shell stays presentational and passes the verified flag down rather than
 * gating anything itself.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorMeResponse } from '@aeci/shared';

import { VendorApi } from './vendor-api';
import { VENDOR_ME_FIXTURE, VENDOR_ME_UNVERIFIED_FIXTURE } from './vendor-fixtures';
import { VendorDashboardTabbed } from './vendor-dashboard-tabbed';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      {
        provide: VendorApi,
        useValue: {
          getSeats: vi.fn().mockResolvedValue({ seats: [] }),
          getTaxonomy: vi.fn().mockResolvedValue({
            categories: [],
            audiences: [],
            phases: [],
            trades: [],
          }),
          getIntegrations: vi.fn().mockResolvedValue({ integrations: [] }),
          getDataObjects: vi.fn().mockResolvedValue({ data_objects: [] }),
          listProductVersions: vi.fn().mockResolvedValue({ versions: [] }),
          getNotifications: vi.fn().mockResolvedValue({ notifications: [] }),
        } as Partial<VendorApi>,
      },
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

function create(me: VendorMeResponse = VENDOR_ME_FIXTURE): ComponentFixture<VendorDashboardTabbed> {
  const fixture = TestBed.createComponent(VendorDashboardTabbed);
  fixture.componentRef.setInput('me', me);
  fixture.detectChanges();
  return fixture;
}

function navButton(fixture: ComponentFixture<VendorDashboardTabbed>, label: string) {
  const el = fixture.nativeElement as HTMLElement;
  const button = [...el.querySelectorAll('nav button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no nav button "${label}"`);
  return button as HTMLButtonElement;
}

describe('VendorDashboardTabbed — the Integrations tab', () => {
  it('offers Integrations in the side nav, between Products and Seats', () => {
    const labels = [...(create().nativeElement as HTMLElement).querySelectorAll('nav button')].map(
      (b) => b.textContent?.trim(),
    );
    expect(labels).toEqual(['Overview', 'Profile', 'Products', 'Integrations', 'Seats']);
  });

  it('does not render the section until the tab is activated', () => {
    // `@switch` means the heavier read only happens when a vendor asks for it.
    const el = create().nativeElement as HTMLElement;
    expect(el.querySelector('aec-vendor-integrations-section')).toBeNull();
  });

  it('renders the section and moves aria-current on activation', async () => {
    const fixture = create();
    navButton(fixture, 'Integrations').click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('aec-vendor-integrations-section')).not.toBeNull();
    expect(navButton(fixture, 'Integrations').getAttribute('aria-current')).toBe('page');
    expect(navButton(fixture, 'Overview').getAttribute('aria-current')).toBeNull();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Integrations');
  });

  it('passes the verified flag down rather than gating in the shell', async () => {
    const fixture = create(VENDOR_ME_UNVERIFIED_FIXTURE);
    navButton(fixture, 'Integrations').click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    // The shell stays presentational: the section renders either way and
    // decides for itself what to withhold.
    expect(el.querySelector('aec-vendor-integrations-section')).not.toBeNull();
    expect(el.textContent).toContain('once your account is verified');
  });
});
