/**
 * AECI-1548 — the read-only thread page a close notice links to
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §15.10). It reads the thread by the route's
 * `:threadId`, names the row from `data_object`, and renders no composer.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VendorThreadById } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { el, settle, text } from './integration-detail-testing.harness';
import { VendorThreadPage } from './vendor-thread-page';

afterEach(() => vi.restoreAllMocks());

const THREAD_ID = '00000000-0000-4000-8000-000000000050';
const OWN = { id: VENDOR_ME_FIXTURE.vendor.id, name: VENDOR_ME_FIXTURE.vendor.company_name };
const OTHER = { id: '00000000-0000-4000-8000-000000000002', name: 'Procore Technologies' };

function detached(over: Partial<VendorThreadById> = {}): VendorThreadById {
  return {
    id: THREAD_ID,
    claim_id: null,
    data_object: { slug: 'rfis', name: 'RFIs' },
    vendor_a: OWN,
    vendor_b: OTHER,
    closed_at: '2026-10-30T00:00:00.000Z',
    closed_reason: 'claim_removed',
    help_requested_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    messages: [
      {
        id: '00000000-0000-4000-8000-000000000061',
        author_vendor: OTHER,
        author_removed: false,
        is_own: false,
        body: 'Do your RFIs carry a due date?',
        created_at: '2026-10-02T00:00:00.000Z',
        deleted_at: null,
      },
    ],
    ...over,
  };
}

async function mount(thread: VendorThreadById) {
  const getThreadById = vi.fn().mockResolvedValue({ thread });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      // The portal shape: the page is a section route under `:vendorSlug`.
      provideRouter([
        {
          path: 'vendor/:vendorSlug',
          children: [{ path: 'threads/:threadId', component: VendorThreadPage }],
        },
      ]),
      { provide: VendorApi, useValue: { getThreadById } as Partial<VendorApi> },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/vendor/summit-bim/threads/${THREAD_ID}`, VendorThreadPage);
  const fixture = harness.fixture;
  await settle(fixture);
  return { fixture, getThreadById };
}

describe('VendorThreadPage (AECI-1548)', () => {
  it('reads the thread by the route id and names the row from its snapshot', async () => {
    const { fixture, getThreadById } = await mount(detached());
    expect(getThreadById).toHaveBeenCalledWith(THREAD_ID);
    expect(el(fixture).querySelector('[data-testid="thread-page-title"]')?.textContent).toContain(
      'Conversation about RFIs',
    );
    expect(text(fixture)).toContain('Do your RFIs carry a due date?');
    expect(text(fixture)).toContain('closed when this row was removed from the directory');
    expect(el(fixture).querySelector('textarea')).toBeNull();
  });

  it('falls back to a plain title when the row has no name', async () => {
    const { fixture } = await mount(detached({ data_object: null }));
    expect(text(fixture)).toContain('Conversation about a data row');
  });

  it('links back to Messages', async () => {
    const { fixture } = await mount(detached());
    const back = el(fixture).querySelector('nav a');
    expect(back?.textContent).toContain('Back to Messages');
    expect(back?.getAttribute('href')).toBe('/vendor/summit-bim/messages');
  });
});
