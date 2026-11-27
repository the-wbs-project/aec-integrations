/**
 * AECI-2039, AECI-2213 — the owner of a Sync Service pair maintains its data flows, on
 * the owned card and the detail page (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.15.3).
 *
 * What these pin:
 *   1. A removed flow (`answer = 'no'`) is not in the table, and the heading counts
 *      shown rows only. There are no Yes and No toggles.
 *   2. The "On the public page" cell reads the answer and the server's `public`, and
 *      mirrors the pair page badge for a public unanswered flow.
 *   3. Each row's Actions menu: Confirm only while unanswered, then Change direction,
 *      View history, Remove row. A row the owner cannot edit offers View history only.
 *   4. Remove row asks first. "Keep it" sends nothing. "Yes, remove it" sends No.
 *   5. Change direction opens the inline picker and sends the new direction.
 *   6. Add sends the data type and direction. It refuses a flow already shown and a
 *      new direction of a shown type, but sends a removed flow back (a restore).
 *   7. View history reads the route and names companies.
 *   8. AECI-2139: a flow AECi corrected stays as a locked row with the reason and the
 *      source, and offers no actions. Add refuses it.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OwnedFlow, OwnedIntegration, OwnerFlowHistory } from '@aeci/shared';

import { expectTitleFirstDialog } from '../../core/testing/title-first-dialog.harness';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE, VENDOR_OWNED_INTEGRATIONS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorOwnedFlows } from './vendor-owned-flows';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const CONFIRMED: OwnedFlow = {
  id: '00000000-0000-4000-8000-0000000061a1',
  data_object_slug: 'invoices',
  data_object_name: 'Invoices',
  direction: 'outbound',
  agreement: 'owner_confirmed',
  origin: 'aeci',
  answer: 'yes',
  public: true,
};
const UNANSWERED: OwnedFlow = {
  ...CONFIRMED,
  id: '00000000-0000-4000-8000-0000000061a2',
  data_object_slug: 'vendors',
  data_object_name: 'Vendors',
  direction: 'inbound',
  agreement: 'unverified',
  answer: null,
};
/** A previous owner's add, unanswered: not publicly backed. */
const VENDOR_MADE: OwnedFlow = {
  ...UNANSWERED,
  id: '00000000-0000-4000-8000-0000000061a3',
  data_object_slug: 'commitments',
  data_object_name: 'Commitments',
  origin: 'vendor',
  public: false,
};
/** Removed: not shown. */
const REMOVED: OwnedFlow = {
  ...CONFIRMED,
  id: '00000000-0000-4000-8000-0000000061a4',
  direction: 'both',
  agreement: 'unverified',
  answer: 'no',
  public: false,
};

const SYNCED: OwnedIntegration = {
  ...VENDOR_OWNED_INTEGRATIONS_FIXTURE[1]!,
  sync_service: true,
  flows_editable: true,
  flows: [CONFIRMED, UNANSWERED, VENDOR_MADE, REMOVED],
};

const HISTORY: OwnerFlowHistory = {
  data_object_slug: 'invoices',
  data_object_name: 'Invoices',
  events: [
    {
      at: '2026-10-02T00:00:00.000Z',
      kind: 'direction_changed',
      direction: 'outbound',
      previous_direction: 'both',
      actor: 'you',
    },
    { at: '2026-09-01T00:00:00.000Z', kind: 'removed', direction: 'both', actor: 'other_company' },
    { at: '2026-08-01T00:00:00.000Z', kind: 'listed', direction: 'both', actor: 'aeci' },
  ],
};

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    setOwnerFlowAnswer: vi.fn().mockResolvedValue({ integration_id: SYNCED.id, flows: [] }),
    clearOwnerFlowAnswer: vi.fn().mockResolvedValue(undefined),
    addOwnerFlow: vi.fn().mockResolvedValue({ integration_id: SYNCED.id, flows: [] }),
    changeOwnerFlow: vi.fn().mockResolvedValue({ integration_id: SYNCED.id, flows: [] }),
    getOwnerFlowHistory: vi.fn().mockResolvedValue(HISTORY),
    getDataObjects: vi.fn().mockResolvedValue({
      data_objects: [
        { slug: 'rfis', name: 'RFIs', description: null },
        { slug: 'invoices', name: 'Invoices', description: null },
      ],
    }),
    getIntegrations: vi.fn().mockResolvedValue({ integrations: [], owned: [SYNCED] }),
    getContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
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
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  document.querySelectorAll('aec-vendor-owned-flows').forEach((el) => el.remove());
});

async function render(row: OwnedIntegration): Promise<ComponentFixture<VendorOwnedFlows>> {
  const fixture = TestBed.createComponent(VendorOwnedFlows);
  fixture.componentRef.setInput('row', row);
  fixture.detectChanges();
  document.body.appendChild(fixture.nativeElement as HTMLElement);
  await fixture.whenStable();
  return fixture;
}

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await flush();
  }
  await fixture.whenStable();
}

/** Anywhere in the document: the menu and the dialogs render in the CDK overlay. */
const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Spartan closes after its 100 ms `closeDelay`. */
async function closed(fixture: ComponentFixture<unknown>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await settle(fixture);
}

async function openMenu(fixture: ComponentFixture<unknown>, flow: OwnedFlow): Promise<void> {
  q(`owned-flow-actions-${flow.id}-trigger`)!.click();
  await settle(fixture);
}

function menuItems(flow: OwnedFlow): string[] {
  const menu = q(`owned-flow-actions-${flow.id}-menu`);
  return [...(menu?.querySelectorAll('button') ?? [])].map((b) => b.textContent!.trim());
}

async function pick(
  fixture: ComponentFixture<unknown>,
  flow: OwnedFlow,
  item: 'confirm' | 'change' | 'history' | 'remove',
): Promise<void> {
  await openMenu(fixture, flow);
  q(`owned-flow-actions-${flow.id}-${item}`)!.click();
  await settle(fixture);
}

describe('VendorOwnedFlows', () => {
  it('shows only what is true now: removed rows leave the table and the count', async () => {
    const fixture = await render(SYNCED);
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(q(`owned-flow-public-${REMOVED.id}`)).toBeNull();
    expect(host.querySelector('h4')?.textContent?.trim()).toBe("Data that's shared (3)");
    // No Yes and No toggles any more.
    expect(host.querySelector('[aria-pressed]')).toBeNull();
    const headers = [...host.querySelectorAll('thead th')].map((th) => th.textContent!.trim());
    expect(headers).toEqual(['Data', 'Direction', 'On the public page', 'Actions']);
  });

  it('frames directions against product_a and reads the public cell from answer and origin', async () => {
    const fixture = await render(SYNCED);
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    const a = SYNCED.product_a.name;
    const b = SYNCED.product_b.name;
    expect(text).toContain(`From ${a} to ${b}`);
    expect(text).toContain(`From ${b} to ${a}`);
    expect(q(`owned-flow-public-${CONFIRMED.id}`)?.textContent?.trim()).toBe(
      'Confirmed by your company',
    );
    expect(q(`owned-flow-public-${UNANSWERED.id}`)?.textContent?.trim()).toBe(
      'Listed by AEC Integrations',
    );
    expect(q(`owned-flow-public-${VENDOR_MADE.id}`)?.textContent?.trim()).toBe(
      'Not shown on the public page',
    );
  });

  // AECI-2213 review: the server decides whether the public page shows a flow.
  it('reads a public vendor-made flow from the server, in the pair badge wording', async () => {
    const backed = { ...VENDOR_MADE, public: true, agreement: 'single_source' as const };
    const aeciBacked = {
      ...VENDOR_MADE,
      id: '00000000-0000-4000-8000-0000000061a6',
      data_object_slug: 'rfis',
      data_object_name: 'RFIs',
      public: true,
    };
    const both = {
      ...UNANSWERED,
      id: '00000000-0000-4000-8000-0000000061a7',
      data_object_slug: 'drawings',
      data_object_name: 'Drawings',
      agreement: 'confirmed' as const,
    };
    await render({ ...SYNCED, flows: [backed, aeciBacked, both] });
    expect(q(`owned-flow-public-${backed.id}`)?.textContent?.trim()).toBe(
      'Confirmed by one company',
    );
    expect(q(`owned-flow-public-${aeciBacked.id}`)?.textContent?.trim()).toBe(
      'Listed by AEC Integrations',
    );
    expect(q(`owned-flow-public-${both.id}`)?.textContent?.trim()).toBe(
      'Confirmed by both companies',
    );
  });

  it('falls back to the origin rule when an older API sends no public field', async () => {
    const older = [
      { ...UNANSWERED, public: null },
      { ...VENDOR_MADE, public: null },
    ];
    await render({ ...SYNCED, flows: older });
    expect(q(`owned-flow-public-${UNANSWERED.id}`)?.textContent?.trim()).toBe(
      'Listed by AEC Integrations',
    );
    expect(q(`owned-flow-public-${VENDOR_MADE.id}`)?.textContent?.trim()).toBe(
      'Not shown on the public page',
    );
  });

  it('shows two live directions of one data type as two rows', async () => {
    const both = {
      ...UNANSWERED,
      id: '00000000-0000-4000-8000-0000000061a5',
      direction: 'both' as const,
    };
    const fixture = await render({ ...SYNCED, flows: [UNANSWERED, both] });
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('labels each row menu and lists its items by state', async () => {
    const fixture = await render(SYNCED);
    expect(q(`owned-flow-actions-${CONFIRMED.id}-trigger`)?.getAttribute('aria-label')).toBe(
      'Actions for Invoices',
    );
    await openMenu(fixture, CONFIRMED);
    expect(menuItems(CONFIRMED)).toEqual(['Change direction', 'View history', 'Remove row']);
  });

  it('offers Confirm first on an unanswered row', async () => {
    const fixture = await render(SYNCED);
    await openMenu(fixture, UNANSWERED);
    expect(menuItems(UNANSWERED)).toEqual([
      'Confirm',
      'Change direction',
      'View history',
      'Remove row',
    ]);
  });

  it('offers View history only on a row the owner cannot edit', async () => {
    const fixture = await render({ ...SYNCED, claimed_at: null, flows_editable: false });
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Claim this integration to confirm, change or remove them');
    expect(q('owned-flow-add-toggle')).toBeNull();
    await openMenu(fixture, UNANSWERED);
    expect(menuItems(UNANSWERED)).toEqual(['View history']);
  });

  it('says every row is on the public page when claimed', async () => {
    const fixture = await render(SYNCED);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      "Each row says what the public page shows. Add a row to list more data. Use a row's Actions to confirm, change or remove it.",
    );
  });

  it('Confirm sends Yes, refetches and announces', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await render(SYNCED);
    await pick(fixture, UNANSWERED, 'confirm');
    expect(api['setOwnerFlowAnswer']).toHaveBeenCalledWith(UNANSWERED.id, true);
    expect(api['getIntegrations']).toHaveBeenCalled();
    expect(announce).toHaveBeenCalledWith('You confirmed Vendors.');
    expect(api['clearOwnerFlowAnswer']).not.toHaveBeenCalled();
  });

  it('Remove row asks first, and Keep it sends nothing', async () => {
    const fixture = await render(SYNCED);
    await pick(fixture, CONFIRMED, 'remove');
    expectTitleFirstDialog('Remove Invoices from the public page?');
    expect(q('owned-flow-remove-dialog')?.textContent).toContain(
      'It leaves this table and the public page. You can add it again with Add a row.',
    );
    q('owned-flow-remove-keep')!.click();
    await closed(fixture);
    expect(q('owned-flow-remove-dialog')).toBeNull();
    expect(api['setOwnerFlowAnswer']).not.toHaveBeenCalled();
  });

  it('"Yes, remove it" sends No, closes the dialog and announces', async () => {
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await render(SYNCED);
    await pick(fixture, CONFIRMED, 'remove');
    q('owned-flow-remove-submit')!.click();
    await closed(fixture);
    expect(api['setOwnerFlowAnswer']).toHaveBeenCalledWith(CONFIRMED.id, false);
    expect(q('owned-flow-remove-dialog')).toBeNull();
    expect(announce).toHaveBeenCalledWith('You removed Invoices from the public page.');
  });

  it('keeps a failed remove in the dialog', async () => {
    api['setOwnerFlowAnswer']!.mockRejectedValueOnce(new Error('500'));
    const fixture = await render(SYNCED);
    await pick(fixture, CONFIRMED, 'remove');
    q('owned-flow-remove-submit')!.click();
    await settle(fixture);
    expect(q('owned-flow-remove-error')?.getAttribute('role')).toBe('alert');
    expect(q('owned-flow-remove-dialog')).not.toBeNull();
  });

  it('Change direction opens the inline picker on its select and sends the new direction', async () => {
    const fixture = await render(SYNCED);
    await pick(fixture, CONFIRMED, 'change');
    const select = q(`owned-flow-direction-${CONFIRMED.id}`) as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(document.activeElement).toBe(select);
    select!.value = 'both';
    select!.dispatchEvent(new Event('change'));
    q(`owned-flow-direction-save-${CONFIRMED.id}`)!.click();
    await settle(fixture);
    expect(api['changeOwnerFlow']).toHaveBeenCalledWith(CONFIRMED.id, { direction: 'both' });
  });

  it('closes the direction change on Escape and hands focus back to the row menu (AECI-2133)', async () => {
    const fixture = await render(SYNCED);
    await pick(fixture, CONFIRMED, 'change');
    q(`owned-flow-direction-save-${CONFIRMED.id}`)!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle(fixture);
    expect(q(`owned-flow-direction-${CONFIRMED.id}`)).toBeNull();
    expect(document.activeElement).toBe(q(`owned-flow-actions-${CONFIRMED.id}-trigger`));
    expect(api['changeOwnerFlow']).not.toHaveBeenCalled();
  });

  it('adds a row with the data type and the direction', async () => {
    const fixture = await render(SYNCED);
    q('owned-flow-add-toggle')!.click();
    await settle(fixture);
    const select = q('owned-flow-add-form')!.querySelector('select')!;
    select.value = 'rfis';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(q('owned-flow-add-duplicate')).toBeNull();
    const form = q('owned-flow-add-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(fixture);
    expect(api['addOwnerFlow']).toHaveBeenCalledWith(SYNCED.id, {
      data_object: 'rfis',
      direction: 'outbound',
    });
  });

  /** Open the add form and pick a data type and a direction. */
  async function pickToAdd(
    fixture: ComponentFixture<unknown>,
    data: string,
    direction: 'outbound' | 'both' | 'inbound',
  ): Promise<HTMLSelectElement> {
    q('owned-flow-add-toggle')!.click();
    await settle(fixture);
    const [dataSelect, dirSelect] = [...q('owned-flow-add-form')!.querySelectorAll('select')];
    dataSelect!.value = data;
    dataSelect!.dispatchEvent(new Event('change'));
    dirSelect!.value = direction;
    dirSelect!.dispatchEvent(new Event('change'));
    await settle(fixture);
    return dataSelect!;
  }

  async function submitAdd(fixture: ComponentFixture<unknown>): Promise<void> {
    q('owned-flow-add-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(fixture);
  }

  it('refuses an exact duplicate: the data type is already shown in that direction', async () => {
    const fixture = await render(SYNCED);
    const select = await pickToAdd(fixture, 'invoices', 'outbound');
    expect(q('owned-flow-add-duplicate')?.textContent?.trim()).toBe(
      'Invoices is already listed in this direction.',
    );
    expect(select.getAttribute('aria-invalid')).toBe('true');
    await submitAdd(fixture);
    expect(api['addOwnerFlow']).not.toHaveBeenCalled();
  });

  it('refuses a new third direction of a shown data type, and points at Change direction', async () => {
    // Invoices: outbound shown, both removed. Inbound is neither, so it is a new row.
    const fixture = await render({ ...SYNCED, flows: [CONFIRMED, REMOVED] });
    await pickToAdd(fixture, 'invoices', 'inbound');
    expect(q('owned-flow-add-duplicate')?.textContent?.trim()).toBe(
      'Invoices is already listed. Use Change direction on its row.',
    );
    await submitAdd(fixture);
    expect(api['addOwnerFlow']).not.toHaveBeenCalled();
  });

  // AECI-2213 review, blocker: a surviving direction must not lock out the restore.
  it('sends back a removed direction while another direction of the type survives', async () => {
    const fixture = await render({ ...SYNCED, flows: [CONFIRMED, REMOVED] });
    await pickToAdd(fixture, 'invoices', 'both');
    expect(q('owned-flow-add-duplicate')).toBeNull();
    await submitAdd(fixture);
    expect(api['addOwnerFlow']).toHaveBeenCalledWith(SYNCED.id, {
      data_object: 'invoices',
      direction: 'both',
    });
  });

  it('lets a removed data type be added again', async () => {
    const fixture = await render({ ...SYNCED, flows: [REMOVED] });
    q('owned-flow-add-toggle')!.click();
    await settle(fixture);
    const select = q('owned-flow-add-form')!.querySelector('select')!;
    select.value = 'invoices';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(q('owned-flow-add-duplicate')).toBeNull();
  });

  it('closes the add form on Escape as Cancel does (AECI-2133)', async () => {
    const fixture = await render(SYNCED);
    q('owned-flow-add-toggle')!.click();
    await settle(fixture);
    q('owned-flow-add-form')!
      .querySelector('select')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    await settle(fixture);
    expect(q('owned-flow-add-form')).toBeNull();
    expect(api['addOwnerFlow']).not.toHaveBeenCalled();
  });

  it('Cancel and Escape on the add form return focus to Add a row (AECI-2191)', async () => {
    const fixture = await render(SYNCED);
    q('owned-flow-add-toggle')!.click();
    await settle(fixture);
    const cancel = [...q('owned-flow-add-form')!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Cancel',
    )!;
    cancel.click();
    await settle(fixture);
    expect(q('owned-flow-add-form')).toBeNull();
    expect(document.activeElement).toBe(q('owned-flow-add-toggle'));

    q('owned-flow-add-toggle')!.click();
    await settle(fixture);
    q('owned-flow-add-form')!
      .querySelector('select')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    await settle(fixture);
    expect(document.activeElement).toBe(q('owned-flow-add-toggle'));
  });

  // AECI-2139: AECi corrected one flow on a public source.
  const CORRECTED: OwnedFlow = {
    ...CONFIRMED,
    id: '00000000-0000-4000-8000-0000000061a9',
    data_object_slug: 'rfis',
    data_object_name: 'RFIs',
    direction: 'outbound',
    public: false,
    aeci_correction: {
      reason: 'The Sync Service page lists no RFI sync.',
      source_url: 'https://rivets.example/docs',
      created_at: '2026-11-26T09:00:00.000Z',
    },
  };

  it('shows a corrected flow as a locked row with the reason and the source', async () => {
    const fixture = await render({ ...SYNCED, flows: [CONFIRMED, CORRECTED] });
    const cell = q(`owned-flow-public-${CORRECTED.id}`)!;
    expect(cell.textContent).toContain(
      'AEC Integrations removed this data flow on November 26, 2026',
    );
    expect(cell.textContent).toContain('Reason: The Sync Service page lists no RFI sync.');
    const source = q(`owned-flow-source-${CORRECTED.id}`) as HTMLAnchorElement;
    expect(source.href).toBe('https://rivets.example/docs');
    expect(source.rel).toBe('noopener nofollow');
    expect(q(`owned-flow-actions-${CORRECTED.id}-trigger`)).toBeNull();
    expect(q(`owned-flow-locked-${CORRECTED.id}`)?.textContent?.trim()).toBe('No actions');
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it("keeps a corrected flow in the table even under the owner's No", async () => {
    const fixture = await render({ ...SYNCED, flows: [{ ...CORRECTED, answer: 'no' }] });
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('refuses to add a flow AECi corrected back', async () => {
    const fixture = await render({ ...SYNCED, flows: [CORRECTED] });
    await pickToAdd(fixture, 'rfis', 'outbound');
    expect(q('owned-flow-add-duplicate')?.textContent?.trim()).toBe(
      'AEC Integrations removed RFIs in this direction. You cannot add it back.',
    );
    await submitAdd(fixture);
    expect(api['addOwnerFlow']).not.toHaveBeenCalled();
  });

  it('View history reads one data type and names companies, newest first', async () => {
    const fixture = await render(SYNCED);
    await pick(fixture, CONFIRMED, 'history');
    expect(api['getOwnerFlowHistory']).toHaveBeenCalledWith(SYNCED.id, 'invoices');
    expectTitleFirstDialog('History of Invoices', { described: false });
    const rows = [...q('owned-flow-history')!.querySelectorAll('tbody tr')].map((tr) =>
      tr.textContent!.replace(/\s+/g, ' ').trim(),
    );
    const a = SYNCED.product_a.name;
    const b = SYNCED.product_b.name;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Direction changed by your company');
    expect(rows[0]).toContain(`From ${a} to ${b}`);
    expect(rows[0]).toContain('Before: Both ways');
    expect(rows[1]).toContain('Removed by another company');
    expect(rows[2]).toContain('Listed by AEC Integrations');
  });

  it('opens history on a row the owner cannot edit', async () => {
    const fixture = await render({
      ...SYNCED,
      retired_at: '2026-10-01T00:00:00.000Z',
      flows_editable: false,
    });
    await pick(fixture, CONFIRMED, 'history');
    expect(api['getOwnerFlowHistory']).toHaveBeenCalledWith(SYNCED.id, 'invoices');
  });

  it('says so when the history cannot be loaded', async () => {
    api['getOwnerFlowHistory']!.mockRejectedValueOnce(new Error('500'));
    const fixture = await render(SYNCED);
    await pick(fixture, CONFIRMED, 'history');
    expect(q('owned-flow-history-error')?.textContent?.trim()).toBe(
      'The history could not be loaded. Close this and try again.',
    );
  });
});
