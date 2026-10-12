/**
 * The listing request section of `/admin/requests` (AECI-1293,
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.5): what the visitor typed, who they are,
 * their plan answer and comments, Resolve and Reject, the badge decrement and the
 * 422 race.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { AdminListingRequest } from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { AdminRequestsApi } from './admin-requests-api';
import { ListingRequestQueue } from './listing-request-queue';

function row(over: Partial<AdminListingRequest> = {}): AdminListingRequest {
  return {
    id: 'lr-1',
    status: 'open',
    listing_name: 'Site Diary Pro',
    website: 'https://sitediary.example.com',
    submitter_email: 'pat@sitediary.example.com',
    submitter_name: 'Pat Lee',
    submitter_role: 'Founder',
    submitter_linkedin_url: null,
    plan_interest: 'managed',
    body: 'Two products.',
    created_at: '2026-10-12T08:00:00.000Z',
    resolved_at: null,
    resolved_by: null,
    ...over,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

async function setup(rows: AdminListingRequest[], moderate = vi.fn(async () => row())) {
  TestBed.resetTestingModule();
  const api = {
    listListingRequests: vi.fn(async () => ({
      data: rows,
      page: 1,
      perPage: 100,
      total: rows.length,
    })),
    moderateListingRequest: moderate,
  };
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminRequestsApi, useValue: api }],
  });
  const store = TestBed.inject(AdminSummaryStore);
  const decrement = vi.spyOn(store, 'decrement');
  const fixture = TestBed.createComponent(ListingRequestQueue);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, decrement, el: fixture.nativeElement as HTMLElement };
}

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => text(b) === label)!;

describe('ListingRequestQueue', () => {
  it('lists open requests with everything the operator needs to add the listing', async () => {
    const { el, api } = await setup([row()]);
    expect(api.listListingRequests).toHaveBeenCalledWith({ status: 'open', page: 1, perPage: 100 });
    expect(text(el.querySelector('h2'))).toBe('Listing requests');
    const card = el.querySelector('article')!;
    expect(text(card.querySelector('h3'))).toBe('Site Diary Pro');
    expect(text(card)).toContain('https://sitediary.example.com');
    expect(text(card)).toContain('pat@sitediary.example.com · Pat Lee · Founder');
    expect(text(card)).toMatch(/Plan interest\s*Managed/);
    expect(text(card)).toContain('Comments Two products.');
    const site = card.querySelector('a')!;
    expect(site.getAttribute('target')).toBe('_blank');
    expect(site.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });

  it('says so when the queue is empty', async () => {
    const { el } = await setup([]);
    expect(text(el)).toContain('No listing requests match this filter.');
  });

  it('resolves a request, drops it and ticks the Requests badge down', async () => {
    const moderate = vi.fn(async () => row({ status: 'resolved' }));
    const { el, fixture, decrement } = await setup([row()], moderate);
    button(el, 'Resolve').click();
    await settle();
    fixture.detectChanges();
    expect(moderate).toHaveBeenCalledWith('lr-1', { action: 'resolve' });
    expect(el.querySelector('article')).toBeNull();
    expect(decrement).toHaveBeenCalledWith('requests');
    expect(text(el.querySelector('[role="status"]'))).toBe('Listing request resolved.');
  });

  it('drops a row another admin already decided, without touching the badge', async () => {
    const moderate = vi.fn(async () => {
      throw new HttpErrorResponse({ status: 422 });
    });
    const { el, fixture, decrement } = await setup([row()], moderate);
    button(el, 'Reject').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).toBeNull();
    expect(decrement).not.toHaveBeenCalled();
  });

  it('keeps the row with a retry notice on any other failure', async () => {
    const moderate = vi.fn(async () => {
      throw new HttpErrorResponse({ status: 500 });
    });
    const { el, fixture } = await setup([row()], moderate);
    button(el, 'Resolve').click();
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('article')).not.toBeNull();
    expect(text(el.querySelector('[role="alert"]'))).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('re-fetches on a status filter and shows no actions on decided rows', async () => {
    const { el, fixture, api } = await setup([row({ status: 'resolved' })]);
    button(el, 'Resolved').click();
    await settle();
    fixture.detectChanges();
    expect(api.listListingRequests).toHaveBeenLastCalledWith({
      status: 'resolved',
      page: 1,
      perPage: 100,
    });
    expect(el.querySelector('article button')).toBeNull();
  });
  it('says how many it is not showing when the server caps the page', async () => {
    const { el, fixture, api } = await setup([]);
    api.listListingRequests.mockResolvedValueOnce({
      data: [row()],
      page: 1,
      perPage: 100,
      total: 140,
    });
    button(el, 'Resolved').click();
    await settle();
    fixture.detectChanges();
    expect(text(el.querySelector('[data-testid="listing-requests-capped"]'))).toBe(
      'Showing the first 1 of 140 listing requests. Moderate these to see the rest.',
    );
  });

  it('ignores a response for a filter the admin already left', async () => {
    const { el, fixture, api } = await setup([]);
    let releaseStale!: () => void;
    const stale = new Promise<void>((resolve) => (releaseStale = resolve)).then(() => ({
      data: [row({ id: 'lr-stale', listing_name: 'Stale', status: 'resolved' })],
      page: 1,
      perPage: 100,
      total: 1,
    }));
    api.listListingRequests
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce({ data: [row()], page: 1, perPage: 100, total: 1 });
    button(el, 'Resolved').click();
    button(el, 'Open').click();
    await settle();
    releaseStale();
    await settle();
    fixture.detectChanges();
    expect(text(el.querySelector('article h3'))).toBe('Site Diary Pro');
  });
});
