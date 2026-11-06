/**
 * The removal election control (AECI-1618). What has to hold: only an owner seat reads the
 * window; the control shows only while it is open with a field to remove; the dialog names
 * the exact fields and the close date; a failed write stays in the dialog with its reason;
 * and a success revalidates the store and says what happened.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemovalElectionResponse, VendorEntitlementBlock } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorPlanPanel } from './vendor-plan-panel';

const ID = '00000000-0000-4000-8000-000000000001';
const OPEN: RemovalElectionResponse = {
  eligible_fields: ['description', 'usefulness', 'tool_integrations_url', 'api_docs_url'],
  closes_at: '2026-11-20T23:59:59.999Z',
  elected_at: null,
};
const ENDED: VendorEntitlementBlock = {
  tier: 'unclaimed',
  status: 'expired',
  period_end: '2026-10-21T00:00:00.000Z',
  ended_at: '2026-10-21T00:00:00.000Z',
  capabilities: [],
};

@Component({
  imports: [VendorPlanPanel],
  template: `<aec-vendor-plan-panel
    [plan]="plan()"
    [electionProductId]="owner() ? id : null"
    [now]="now"
  />`,
})
class Host {
  readonly id = ID;
  readonly now = Date.parse('2026-11-05T12:00:00.000Z');
  readonly plan = signal<VendorEntitlementBlock>(ENDED);
  readonly owner = signal(true);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function conflict(code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status: 409, error: { error: { code } } });
}

describe('VendorRemovalElection', () => {
  let api: {
    getRemovalElection: ReturnType<typeof vi.fn>;
    createRemovalElection: ReturnType<typeof vi.fn>;
  };
  let store: { revalidate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    api = {
      getRemovalElection: vi.fn(async () => OPEN),
      createRemovalElection: vi.fn(async () => ({
        removed_fields: OPEN.eligible_fields,
        elected_at: '2026-11-05T12:00:00.000Z',
      })),
    };
    store = { revalidate: vi.fn(async () => undefined) };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: VendorApi, useValue: api },
        { provide: VendorPortalStore, useValue: store },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  async function mount(setup?: (host: Host) => void) {
    const fixture = TestBed.createComponent(Host);
    setup?.(fixture.componentInstance);
    fixture.detectChanges();
    await settle();
    await fixture.whenStable();
    return fixture;
  }
  const q = <T extends Element>(selector: string) => document.querySelector(selector) as T | null;

  async function openDialog(fixture: Awaited<ReturnType<typeof mount>>) {
    q<HTMLButtonElement>('[data-testid="removal-open"]')!.click();
    await settle();
    await fixture.whenStable();
  }

  async function mountAttached(setup?: (host: Host) => void) {
    const fixture = await mount(setup);
    document.body.appendChild(fixture.nativeElement);
    return fixture;
  }

  it('an owner seat reads the window and sees the control with its close date', async () => {
    const fixture = await mountAttached();
    expect(api.getRemovalElection).toHaveBeenCalledWith(ID);
    const control = (fixture.nativeElement as HTMLElement).querySelector(
      '[data-testid="removal-election"]',
    );
    expect(control?.textContent).toContain('November 20, 2026');
    expect(control?.textContent).toContain('Catalog data and reviews stay.');
  });

  it('a member seat never sends the read and sees no control', async () => {
    const fixture = await mountAttached((host) => host.owner.set(false));
    expect(api.getRemovalElection).not.toHaveBeenCalled();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="removal-election"]'),
    ).toBeNull();
  });

  it('a plan that has not ended never sends the read', async () => {
    await mountAttached((host) =>
      host.plan.set({ ...ENDED, status: 'active', tier: 'verified', ended_at: null }),
    );
    expect(api.getRemovalElection).not.toHaveBeenCalled();
  });

  it('hides the control when the window is closed', async () => {
    api.getRemovalElection.mockResolvedValue({
      eligible_fields: [],
      closes_at: null,
      elected_at: null,
    });
    const fixture = await mountAttached();
    expect(api.getRemovalElection).toHaveBeenCalled();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="removal-election"]'),
    ).toBeNull();
  });

  it('hides the control when the window is open and no field qualifies', async () => {
    api.getRemovalElection.mockResolvedValue({ ...OPEN, eligible_fields: [] });
    const fixture = await mountAttached();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="removal-election"]'),
    ).toBeNull();
  });

  it('says so and retries when the read fails', async () => {
    api.getRemovalElection.mockRejectedValueOnce(new Error('boom'));
    const fixture = await mountAttached();
    const el = fixture.nativeElement as HTMLElement;
    const failed = el.querySelector('[data-testid="removal-load-failed"]');
    expect(failed?.querySelector('[role="alert"]')).not.toBeNull();
    failed!.querySelector('button')!.click();
    await settle();
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="removal-load-failed"]')).toBeNull();
    expect(el.querySelector('[data-testid="removal-election"]')).not.toBeNull();
  });

  it('the dialog lists the exact fields, the close date, and what stays', async () => {
    const fixture = await mountAttached();
    await openDialog(fixture);
    const items = [...document.querySelectorAll('[data-testid="removal-fields"] li')].map((li) =>
      li.textContent?.trim(),
    );
    expect(items).toEqual([
      'Description',
      '"How teams use it"',
      'Integrations page URL',
      'API documentation URL',
    ]);
    const dialog = q('[data-testid="removal-dialog"]')!.textContent;
    expect(dialog).toContain('cannot be undone');
    expect(dialog).toContain('November 20, 2026');
    expect(dialog).toContain('Catalog data and reviews stay.');
  });

  it('a success closes the dialog, revalidates the store and states the date', async () => {
    const fixture = await mountAttached();
    await openDialog(fixture);
    q<HTMLButtonElement>('[data-testid="removal-confirm"]')!.click();
    await settle();
    await fixture.whenStable();
    expect(api.createRemovalElection).toHaveBeenCalledWith(ID);
    expect(store.revalidate).toHaveBeenCalledWith(['products']);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="removal-elected"]')?.textContent).toContain(
      'You removed your text on November 5, 2026.',
    );
    expect(el.querySelector('[data-testid="removal-election"]')).toBeNull();
  });

  it.each([
    ['REMOVAL_ELECTION_CLOSED', 'The time to remove this text has ended'],
    ['REMOVAL_ELECTION_EMPTY', "None of this product's text can be removed now"],
  ])('a %s keeps the dialog open with its reason', async (code, message) => {
    const fixture = await mountAttached();
    await openDialog(fixture);
    api.createRemovalElection.mockRejectedValueOnce(conflict(code));
    q<HTMLButtonElement>('[data-testid="removal-confirm"]')!.click();
    await settle();
    await fixture.whenStable();
    expect(q('[data-testid="removal-dialog"] [role="alert"]')?.textContent).toContain(message);
    expect(store.revalidate).not.toHaveBeenCalled();
  });

  it('any other failure keeps the dialog open and the button usable', async () => {
    const fixture = await mountAttached();
    await openDialog(fixture);
    api.createRemovalElection.mockRejectedValueOnce(new Error('boom'));
    q<HTMLButtonElement>('[data-testid="removal-confirm"]')!.click();
    await settle();
    await fixture.whenStable();
    expect(q('[data-testid="removal-dialog"] [role="alert"]')?.textContent).toContain(
      'We could not remove your text.',
    );
    expect(q<HTMLButtonElement>('[data-testid="removal-confirm"]')!.disabled).toBe(false);
  });

  it('states an earlier election', async () => {
    api.getRemovalElection.mockResolvedValue({
      eligible_fields: [],
      closes_at: OPEN.closes_at,
      elected_at: '2026-10-30T09:00:00.000Z',
    });
    const fixture = await mountAttached();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="removal-elected"]')
        ?.textContent,
    ).toContain('You removed your text on October 30, 2026.');
  });
});
