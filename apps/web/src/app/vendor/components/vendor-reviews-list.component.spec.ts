/**
 * AECI-1179 — the portal Reviews tab (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.16):
 * every reply state, the gated (Free) product, reply / edit / resubmit / withdraw
 * against a mocked API, the server error map, and the `reviews` cursor tick.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorProduct, VendorReviewItem } from '@aeci/shared';
import { capabilitiesFor } from '@aeci/shared/entitlements';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VENDOR_REVIEWS_FIXTURE } from '../vendor-review-fixtures';

import { VendorReviewsList } from './vendor-reviews-list';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const MANAGED_PRODUCT: VendorProduct = VENDOR_ME_FIXTURE.products[0]!;
const FREE_PRODUCT: VendorProduct = {
  ...MANAGED_PRODUCT,
  plan: {
    tier: 'unclaimed',
    status: null,
    period_end: null,
    ended_at: null,
    capabilities: [...capabilitiesFor('unclaimed')],
  },
};

const PRIMARY_ITEMS = VENDOR_REVIEWS_FIXTURE.filter((i) => i.product.id === MANAGED_PRODUCT.id);
const byState = (state: string): VendorReviewItem =>
  PRIMARY_ITEMS.find((i) => (i.response?.status ?? 'none') === state)!;

function page(items: readonly VendorReviewItem[]) {
  return { data: [...items], page: 1, perPage: 10, total: items.length };
}

function httpError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: { error: { code, message: code }, trace_id: 't' },
  });
}

let api: {
  listReviews: ReturnType<typeof vi.fn>;
  submitReviewResponse: ReturnType<typeof vi.fn>;
  editReviewResponse: ReturnType<typeof vi.fn>;
  withdrawReviewResponse: ReturnType<typeof vi.fn>;
  getMe: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    listReviews: vi.fn().mockResolvedValue(page(PRIMARY_ITEMS)),
    submitReviewResponse: vi.fn(),
    editReviewResponse: vi.fn(),
    withdrawReviewResponse: vi.fn(),
    getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function create(product = MANAGED_PRODUCT): Promise<ComponentFixture<VendorReviewsList>> {
  const fixture = TestBed.createComponent(VendorReviewsList);
  fixture.componentRef.setInput('product', product);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const row = (fixture: ComponentFixture<unknown>, item: VendorReviewItem) =>
  el(fixture).querySelector<HTMLElement>(`[data-review="${item.review.id}"]`)!;
const button = (scope: HTMLElement, label: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(label));
const pill = (scope: HTMLElement) => scope.querySelector('[data-reply-pill]')!.textContent!.trim();

function type(scope: HTMLElement, text: string): void {
  const area = scope.querySelector('textarea')!;
  area.value = text;
  area.dispatchEvent(new Event('input'));
}

describe('VendorReviewsList — reading', () => {
  it('reads one page of this product only', async () => {
    await create();
    expect(api.listReviews).toHaveBeenCalledWith(
      expect.objectContaining({ productId: MANAGED_PRODUCT.id, page: 1, replyStatus: null }),
    );
  });

  it('renders each reply state distinctly, with its actions', async () => {
    const fixture = await create();

    const none = row(fixture, byState('none'));
    expect(pill(none)).toBe('No reply');
    expect(button(none, 'Reply')).toBeDefined();
    expect(button(none, 'Withdraw')).toBeUndefined();

    const pending = row(fixture, byState('pending'));
    expect(pill(pending)).toBe('Pending approval');
    expect(pending.textContent).toContain(byState('pending').response!.body);
    expect(button(pending, 'Edit')).toBeDefined();
    expect(button(pending, 'Withdraw')).toBeDefined();

    const published = row(fixture, byState('published'));
    expect(pill(published)).toBe('Published');
    expect(published.textContent).toContain('Published Sep 21, 2026');
    expect(button(published, 'Edit')).toBeDefined();
    expect(button(published, 'Withdraw')).toBeDefined();

    const rejected = row(fixture, byState('rejected'));
    expect(pill(rejected)).toBe('Rejected');
    expect(rejected.querySelector('[data-reply-reason]')!.textContent).toContain(
      byState('rejected').response!.rejection_reason!,
    );
    expect(button(rejected, 'Resubmit')).toBeDefined();
    expect(button(rejected, 'Withdraw')).toBeUndefined();

    const withdrawn = row(fixture, byState('withdrawn'));
    expect(pill(withdrawn)).toBe('Withdrawn');
    expect(button(withdrawn, 'Resubmit')).toBeDefined();

    const removed = row(fixture, byState('removed'));
    expect(pill(removed)).toBe('Removed');
    expect(removed.querySelector('[data-reply-reason]')!.textContent).toContain(
      byState('removed').response!.rejection_reason!,
    );
    // Final: no action at all.
    expect(removed.querySelectorAll('[data-own-reply] button')).toHaveLength(0);
  });

  it("shows a co-owner's published reply read-only", async () => {
    const fixture = await create();
    const other = row(fixture, byState('published')).querySelector('[data-other-response]')!;
    expect(other.textContent).toContain('Response from Northwind Estimating');
    expect(other.querySelector('button')).toBeNull();
  });

  it('explains an empty product and an empty filter', async () => {
    api.listReviews.mockResolvedValue(page([]));
    const fixture = await create();
    expect(el(fixture).querySelector('[data-reviews-empty]')!.textContent).toContain(
      'no approved reviews yet',
    );
  });

  it('offers a retry when the read fails', async () => {
    api.listReviews.mockRejectedValueOnce(new Error('offline'));
    const fixture = await create();
    expect(el(fixture).querySelector('[data-reviews-failed]')).not.toBeNull();
    button(el(fixture), 'Try again')!.click();
    await settle(fixture);
    expect(row(fixture, byState('none'))).not.toBeNull();
  });
});

describe('VendorReviewsList — the gate (Free product)', () => {
  it('keeps the list and the states, drops Reply / Edit / Resubmit, keeps Withdraw', async () => {
    const fixture = await create(FREE_PRODUCT);
    const notice = el(fixture).querySelector('#vendor-reviews-locked')!;
    expect(notice.textContent).toContain('part of Managed');

    for (const state of ['none', 'pending', 'published', 'rejected', 'withdrawn', 'removed']) {
      const scope = row(fixture, byState(state));
      expect(button(scope, 'Reply')).toBeUndefined();
      expect(button(scope, 'Edit')).toBeUndefined();
      expect(button(scope, 'Resubmit')).toBeUndefined();
      // The reason is tied to each reply block (§6.18).
      expect(scope.querySelector('[data-own-reply]')!.getAttribute('aria-describedby')).toBe(
        'vendor-reviews-locked',
      );
    }
    expect(button(row(fixture, byState('pending')), 'Withdraw')).toBeDefined();
    expect(button(row(fixture, byState('published')), 'Withdraw')).toBeDefined();
  });
});

describe('VendorReviewsList — writing', () => {
  it('replies: validates, posts the trimmed body, shows pending, announces', async () => {
    const item = byState('none');
    api.submitReviewResponse.mockResolvedValue({
      response: {
        id: '00000000-0000-4000-8000-000000005899',
        status: 'pending',
        body: 'Thanks for the detail.',
        rejection_reason: null,
        published_at: null,
        moderated_at: null,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
      },
    });
    const fixture = await create();
    button(row(fixture, item), 'Reply')!.click();
    await settle(fixture);

    // Empty is refused client-side, before any request.
    button(row(fixture, item), 'Send for approval')!.click();
    await settle(fixture);
    expect(row(fixture, item).querySelector('[data-reply-error]')!.textContent).toContain(
      'Write your reply',
    );
    expect(api.submitReviewResponse).not.toHaveBeenCalled();

    type(row(fixture, item), '   Thanks for the detail.  ');
    await settle(fixture);
    expect(row(fixture, item).querySelector('[data-reply-count]')!.textContent).toContain(
      '22 of 2000 characters',
    );
    button(row(fixture, item), 'Send for approval')!.click();
    await settle(fixture);

    expect(api.submitReviewResponse).toHaveBeenCalledWith(item.review.id, 'Thanks for the detail.');
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('for approval');
  });

  it('refuses a body over the limit without a request', async () => {
    const item = byState('none');
    const fixture = await create();
    button(row(fixture, item), 'Reply')!.click();
    await settle(fixture);
    type(row(fixture, item), 'x'.repeat(2001));
    await settle(fixture);
    button(row(fixture, item), 'Send for approval')!.click();
    await settle(fixture);
    expect(row(fixture, item).querySelector('[data-reply-error]')!.textContent).toContain(
      'The limit is 2000',
    );
    expect(api.submitReviewResponse).not.toHaveBeenCalled();
  });

  it('warns before an edit of a published reply, then PATCHes', async () => {
    const item = byState('published');
    api.editReviewResponse.mockResolvedValue({
      response: { ...item.response!, status: 'pending', body: 'New text', published_at: null },
    });
    const fixture = await create();
    button(row(fixture, item), 'Edit')!.click();
    await settle(fixture);

    const warn = row(fixture, item).querySelector('[data-reply-warning]')!;
    expect(warn.textContent).toContain('off the product page');
    const area = row(fixture, item).querySelector('textarea')!;
    expect(area.value).toBe(item.response!.body);
    expect(area.getAttribute('aria-describedby')).toContain(warn.id);

    type(row(fixture, item), 'New text');
    button(row(fixture, item), 'Save and send for approval')!.click();
    await settle(fixture);
    expect(api.editReviewResponse).toHaveBeenCalledWith(item.review.id, 'New text');
  });

  it('does not send an unchanged edit', async () => {
    const item = byState('pending');
    const fixture = await create();
    button(row(fixture, item), 'Edit')!.click();
    await settle(fixture);
    button(row(fixture, item), 'Save and send for approval')!.click();
    await settle(fixture);
    expect(api.editReviewResponse).not.toHaveBeenCalled();
    expect(row(fixture, item).textContent).toContain('nothing was saved');
  });

  it('resubmits a rejected reply through the POST', async () => {
    const item = byState('rejected');
    api.submitReviewResponse.mockResolvedValue({
      response: { ...item.response!, status: 'pending', rejection_reason: null, body: 'Better.' },
    });
    const fixture = await create();
    button(row(fixture, item), 'Resubmit')!.click();
    await settle(fixture);
    type(row(fixture, item), 'Better.');
    button(row(fixture, item), 'Resubmit for approval')!.click();
    await settle(fixture);
    expect(api.submitReviewResponse).toHaveBeenCalledWith(item.review.id, 'Better.');
  });

  it('withdraws behind an inline confirm', async () => {
    const item = byState('published');
    api.withdrawReviewResponse.mockResolvedValue({
      response: { ...item.response!, status: 'withdrawn', published_at: null },
    });
    const fixture = await create();
    button(row(fixture, item), 'Withdraw')!.click();
    await settle(fixture);
    const confirm = row(fixture, item).querySelector<HTMLElement>('[data-withdraw-confirm]')!;
    expect(confirm.textContent).toContain('comes off the product page');
    expect(api.withdrawReviewResponse).not.toHaveBeenCalled();

    button(confirm, 'Withdraw')!.click();
    await settle(fixture);
    expect(api.withdrawReviewResponse).toHaveBeenCalledWith(item.review.id);
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('withdrawn');
  });

  it('re-reads on a 409 and says why', async () => {
    const item = byState('none');
    api.submitReviewResponse.mockRejectedValue(httpError(409, 'REVIEW_RESPONSE_EXISTS'));
    const fixture = await create();
    button(row(fixture, item), 'Reply')!.click();
    await settle(fixture);
    type(row(fixture, item), 'Hello');
    api.listReviews.mockClear();
    button(row(fixture, item), 'Send for approval')!.click();
    await settle(fixture);
    expect(api.listReviews).toHaveBeenCalled();
    expect(row(fixture, item).textContent).toContain('already has your reply');
    expect(row(fixture, item).querySelector('textarea')).toBeNull();
  });

  it.each([
    ['REVIEW_RESPONSE_WRONG_STATE', 409, 'changed while you were working'],
    ['REVIEW_RESPONSE_REMOVED', 409, 'cannot be changed or replaced'],
    ['ENTITLEMENT_REQUIRED', 403, 'part of Managed'],
    ['RATE_LIMITED', 429, 'Wait a minute'],
  ])('maps %s to its message', async (code, status, text) => {
    const item = byState('pending');
    api.editReviewResponse.mockRejectedValue(httpError(status, code));
    const fixture = await create();
    button(row(fixture, item), 'Edit')!.click();
    await settle(fixture);
    type(row(fixture, item), 'Changed text');
    button(row(fixture, item), 'Save and send for approval')!.click();
    await settle(fixture);
    expect(row(fixture, item).textContent).toContain(text);
  });
});

describe('VendorReviewsList — live', () => {
  it('re-reads the open page on a reviews tick', async () => {
    const fixture = await create();
    api.listReviews.mockClear();
    await TestBed.inject(VendorPortalStore).revalidate(['reviews']);
    await settle(fixture);
    expect(api.listReviews).toHaveBeenCalledTimes(1);
  });

  it('holds a tick while a form is open, and offers a reload', async () => {
    const item = byState('none');
    const fixture = await create();
    button(row(fixture, item), 'Reply')!.click();
    await settle(fixture);
    api.listReviews.mockClear();
    await TestBed.inject(VendorPortalStore).revalidate(['reviews']);
    await settle(fixture);
    expect(api.listReviews).not.toHaveBeenCalled();
    expect(el(fixture).querySelector('[data-reviews-stale]')).not.toBeNull();
  });
});
