/**
 * `VendorPage` — the vendor-group analytics wiring (AECI-649 / §AW8;
 * `docs/ANALYTICS.md` §8).
 *
 * The page had no spec before this; these cases cover only the group call,
 * because that is what AECI-649 added. The property under test is WHICH seam
 * fires it: the group must be asserted from the resolved `GET /api/vendor/me`
 * payload — the one `requireVendor()` gated — and never from the fact that the
 * URL happened to be `/vendor`. So it fires on the success branch and stays
 * silent on the 404 branch, where the resolver returned `null` because the
 * caller is anonymous, a reviewer, a banned seat, or a site admin.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorMeResponse } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { VendorApi } from './vendor-api';
import { VENDOR_ME_FIXTURE } from './vendor-fixtures';
import { VendorLiveSync } from './vendor-live-sync';
import { VendorPage } from './vendor-page';
import { VendorPortalStore } from './vendor-portal-store';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

function apiStub(): Partial<VendorApi> {
  return {
    getSeats: vi
      .fn()
      .mockResolvedValue({ seats: [], pending_invites: [], can_manage_seats: false }),
    getTaxonomy: vi
      .fn()
      .mockResolvedValue({ categories: [], audiences: [], phases: [], trades: [] }),
    getIntegrations: vi.fn().mockResolvedValue({ integrations: [] }),
    getDataObjects: vi.fn().mockResolvedValue({ data_objects: [] }),
    listProductVersions: vi.fn().mockResolvedValue({ versions: [] }),
    getNotifications: vi.fn().mockResolvedValue({ notifications: [] }),
  };
}

async function create(me: VendorMeResponse | null) {
  const groupVendor = vi.fn();

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: apiStub() },
      { provide: Analytics, useValue: { groupVendor } },
      {
        provide: ActivatedRoute,
        useValue: { data: of({ me }), snapshot: { data: { me } } },
      },
    ],
  });
  // The live sync holds a timer and polls; it is not what this spec is about.
  TestBed.overrideComponent(VendorPage, {
    set: {
      providers: [VendorPortalStore, { provide: VendorLiveSync, useValue: { start: vi.fn() } }],
    },
  });

  const fixture = TestBed.createComponent(VendorPage);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  return { fixture, groupVendor };
}

describe('VendorPage — vendor group (§AW8)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('groups the resolved vendor by id and company name on dashboard entry', async () => {
    const { groupVendor } = await create(VENDOR_ME_FIXTURE);
    expect(groupVendor).toHaveBeenCalledExactlyOnceWith({
      id: VENDOR_ME_FIXTURE.vendor.id,
      name: VENDOR_ME_FIXTURE.vendor.company_name,
    });
  });

  it('does NOT group on the not-found branch (the caller is not a vendor)', async () => {
    const { groupVendor } = await create(null);
    expect(groupVendor).not.toHaveBeenCalled();
  });
});
