/**
 * AECI-694 — `<aec-audit-trail>`.
 *
 * This is the platform's only read surface over `audit_log`, and the rows it
 * renders are free-form JSON written by ~34 call sites across three years of
 * schema, with no shared contract and no retention prune. So the cases that earn
 * their keep are the degradations: a scalar snapshot, an action this build has
 * never heard of, an actor that is a cron rather than a person, and the GoTrue
 * seam being down. Any of those rendering blank or throwing would take out the
 * whole screen.
 *
 * The vendor page's own spec covers the fetch/scope wiring around this
 * component; here the inputs are set directly.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminAuditRow } from '@aeci/shared';

import { AuditTrail } from './audit-trail';

const ROW_ID = '00000000-0000-4000-8000-0000000000a1';

function makeRow(over: Partial<AdminAuditRow> = {}): AdminAuditRow {
  return {
    id: ROW_ID,
    action: 'vendor_entitlement.set',
    actor: {
      id: '00000000-0000-4000-8000-0000000000b1',
      display_name: 'Ada Lovelace',
      email: 'ada@aecintegrations.com',
    },
    actor_type: 'admin',
    entity_type: 'vendor_entitlement',
    entity_id: '00000000-0000-4000-8000-0000000000c1',
    created_at: '2026-08-27T12:00:00.000Z',
    before_state: null,
    after_state: null,
    ...over,
  };
}

function setup(rows: AdminAuditRow[], over: Partial<Record<string, unknown>> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AuditTrail);
  const inputs: Record<string, unknown> = {
    rows,
    page: 1,
    perPage: 25,
    total: rows.length,
    loading: false,
    failed: false,
    emailsAvailable: true,
    ...over,
  };
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

describe('AuditTrail', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00.000Z'));
    TestBed.resetTestingModule();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders one table row per entry, with the row header as what happened', () => {
    const { el } = setup([makeRow()]);
    const header = el.querySelector('tbody th[scope="row"]');
    // Navigating a cell by screen reader announces the description, which is the
    // useful anchor; "2d" would not be.
    expect(header?.textContent).toContain('Entitlement set');
    expect(header?.textContent).toContain('vendor_entitlement.set');
  });

  it('stamps the time relatively, with the exact instant on the info control', () => {
    const { el } = setup([makeRow({ created_at: '2026-08-26T12:00:00.000Z' })]);
    expect(el.querySelector('time')?.textContent?.trim()).toBe('2d');
    expect(el.querySelector('aec-relative-time button')?.getAttribute('aria-label')).toContain(
      'UTC',
    );
  });

  it('names a system row "System", never "unknown"', () => {
    // A null actor is not a failed lookup: it is a cron or the promote Workflow.
    const { el } = setup([makeRow({ actor: null, actor_type: 'system' })]);
    expect(el.textContent).toContain('System');
    expect(el.textContent).not.toContain('unknown');
  });

  it('distinguishes a workflow actor from a plain system one', () => {
    const { el } = setup([makeRow({ actor: null, actor_type: 'workflow' })]);
    expect(el.textContent).toContain('Automated workflow');
  });

  it('says "details unavailable", not "unnamed", when the email seam is down', () => {
    // The 2026-08-24 distinction: an absent address because the seam could not be
    // reached says nothing about the account, and calling it "Unnamed account"
    // would assert something we do not know.
    const nameless = {
      id: '00000000-0000-4000-8000-0000000000b2',
      display_name: null,
      email: null,
    };
    const down = setup([makeRow({ actor: nameless })], { emailsAvailable: false });
    expect(down.el.textContent).toContain('Account details unavailable');

    const up = setup([makeRow({ actor: nameless })], { emailsAvailable: true });
    expect(up.el.textContent).toContain('Unnamed account');
  });

  it('humanises an action this build has never heard of', () => {
    // `audit_log.action` is a free `z.string()` by contract so a new writer
    // elsewhere cannot 500 this screen.
    const { el } = setup([makeRow({ action: 'data_object.created' })]);
    expect(el.textContent).toContain('Data object created');
  });

  it("expands a diff over the union of both sides' keys, in a row of its own", () => {
    const { fixture, el } = setup([
      makeRow({
        before_state: { status: 'active', payer: 'Acme' },
        after_state: { status: 'revoked', invoice_ref: 'PO-9' },
      }),
    ]);
    buttonByText(el, 'Show changes')!.click();
    fixture.detectChanges();

    const diff = el.querySelector(`#audit-diff-${ROW_ID}`);
    expect(diff?.closest('tr')).not.toBeNull();
    const text = diff?.textContent ?? '';
    expect(text).toContain('status');
    expect(text).toContain('changed');
    // A key present on only one side must still appear: dropping it would hide
    // exactly the field that moved.
    expect(text).toContain('payer');
    expect(text).toContain('removed');
    expect(text).toContain('invoice_ref');
    expect(text).toContain('added');
  });

  it('renders a SCALAR snapshot as a single value row instead of throwing', () => {
    const { fixture, el } = setup([makeRow({ before_state: 'a bare string', after_state: 42 })]);
    buttonByText(el, 'Show changes')!.click();
    fixture.detectChanges();
    const text = el.querySelector(`#audit-diff-${ROW_ID}`)?.textContent ?? '';
    expect(text).toContain('value');
    expect(text).toContain('a bare string');
    expect(text).toContain('42');
  });

  it('offers no diff toggle for a row with no snapshots', () => {
    const { el } = setup([makeRow()]);
    expect(buttonByText(el, 'Show changes')).toBeUndefined();
  });

  it('renders the loading, failure and empty states instead of a table', () => {
    expect(setup([], { loading: true }).el.querySelector('table')).toBeNull();
    expect(setup([], { failed: true }).el.querySelector('[role="alert"]')).not.toBeNull();
    expect(setup([]).el.textContent).toContain('Nothing recorded for this scope');
  });

  it('emits retry rather than refetching itself', () => {
    const { fixture, el } = setup([], { failed: true });
    const seen: unknown[] = [];
    fixture.componentInstance.retry.subscribe(() => seen.push(true));
    buttonByText(el, 'Try again')!.click();
    expect(seen).toHaveLength(1);
  });

  describe('accessibility (structural)', () => {
    it('names the table and scopes every header cell', () => {
      const { el } = setup([makeRow()]);
      expect(el.querySelector('caption')?.textContent?.trim()).toBeTruthy();
      for (const th of el.querySelectorAll('thead th')) {
        expect(th.getAttribute('scope')).toBe('col');
      }
      expect(el.querySelector('tbody th')?.getAttribute('scope')).toBe('row');
    });

    it('renders no heading of its own, so the host owns the section title', () => {
      // The vendor page's audit `h3` sits outside this component; a heading here
      // would land between it and whatever follows.
      const { el } = setup([makeRow()]);
      expect(el.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    });

    it('wires the diff toggle to what it controls', () => {
      const { el } = setup([makeRow({ after_state: { a: 1 } })]);
      const toggle = buttonByText(el, 'Show changes')!;
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-controls')).toBe(`audit-diff-${ROW_ID}`);
    });

    it('states the change in words, never by colour alone', () => {
      const { fixture, el } = setup([makeRow({ before_state: { a: 1 }, after_state: { a: 2 } })]);
      buttonByText(el, 'Show changes')!.click();
      fixture.detectChanges();
      expect(el.querySelector(`#audit-diff-${ROW_ID}`)?.textContent).toContain('changed');
    });
  });
});
