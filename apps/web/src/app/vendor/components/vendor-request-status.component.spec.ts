/**
 * `VendorRequestStatus` (AECI-522) — the order of the list (AECI-1243).
 *
 * The API ships requests newest first. The component sorts again so the list
 * reads newest first whatever the caller passes, with `id` settling a
 * same-millisecond tie.
 */

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { VendorRequestSummary } from '@aeci/shared';

import { VendorRequestStatus } from './vendor-request-status';

const request = (id: string, createdAt: string): VendorRequestSummary => ({
  id,
  kind: 'correction',
  target_type: 'product',
  target_id: '00000000-0000-4000-8000-000000000001',
  status: 'open',
  created_at: createdAt,
  resolved_at: null,
});

async function render(requests: VendorRequestSummary[]) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(VendorRequestStatus);
  fixture.componentRef.setInput('requests', requests);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('VendorRequestStatus order (AECI-1243)', () => {
  it('lists the newest filed first whatever the input order', async () => {
    const el = await render([
      request('00000000-0000-4000-8000-00000000000a', '2026-07-01T12:00:00.000Z'),
      request('00000000-0000-4000-8000-00000000000b', '2026-09-01T12:00:00.000Z'),
      request('00000000-0000-4000-8000-00000000000c', '2026-09-01T12:00:00.000Z'),
    ]);
    const filed = [...el.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(filed).toHaveLength(3);
    expect(filed[0]).toContain('Sep 1, 2026');
    expect(filed[1]).toContain('Sep 1, 2026');
    expect(filed[2]).toContain('Jul 1, 2026');
  });
});
