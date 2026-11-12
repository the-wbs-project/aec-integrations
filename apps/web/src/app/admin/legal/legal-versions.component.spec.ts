/**
 * `AdminLegalVersions` (`/admin/legal`) — AECI-1688. Source of truth:
 * `ADMIN_PANEL_SPEC.md` §5.22.
 *
 * What these tests hold in place:
 *
 *  1. **Neither question has a default**, and Publish stays off until both are answered
 *     and the summary is valid. "Needs acceptance: Yes" needs "material: Yes".
 *  2. **The summary is checked like the API checks it**, and its error is tied to the field.
 *  3. **Hints for one document never show on the other's card.** The expedited reason is
 *     on the Vendor Terms card only.
 *  4. **The dialog says what each answer causes**, in sentences that read right with the
 *     data in them, and cannot be closed while the request is in flight.
 *  5. **A failure shows on the card too**, as an alert. **A success moves focus** to the
 *     card heading and the card shows what was recorded.
 */

import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminLegalUpcomingEntry,
  AdminLegalVersionsResponse,
  LegalVersion,
  PublishLegalVersionRequest,
} from '@aeci/shared';

import { AdminLegalApi } from './admin-legal-api';
import { AdminLegalVersions, humanBytes, summaryBullets, summaryProblem } from './legal-versions';

const ADMIN = '49dd03ee-1111-4000-8000-000000000001';

const entry = (over: Partial<AdminLegalUpcomingEntry> = {}): AdminLegalUpcomingEntry => ({
  document: 'vendor_terms',
  version: '1.4',
  effective_on: '2027-01-15',
  effective_at: '2027-01-15T12:00:00.000Z',
  current_version: '1.3',
  published: null,
  ...over,
});

const published = (over: Partial<LegalVersion> = {}): LegalVersion => ({
  id: 'lv-1',
  document: 'vendor_terms',
  version: '1.4',
  effective_at: '2027-01-15T12:00:00.000Z',
  material: true,
  requires_acceptance: true,
  summary: ['Claims end after 90 days without a seat.', 'The notice address moves.'],
  expedited_reason: null,
  pdf_key: 'legal/vendor-terms/v1.4.pdf',
  pdf_sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  pdf_bytes: 146_448,
  published_by: ADMIN,
  published_at: '2026-11-12T14:03:00.000Z',
  notice_enqueued_at: null,
  notice_vendor_count: null,
  ...over,
});

const BOTH: AdminLegalVersionsResponse = {
  publish_enabled: true,
  upcoming: [
    entry(),
    entry({
      document: 'managed_plan',
      version: '1.2',
      current_version: '1.1',
      effective_on: '2027-02-01',
      effective_at: '2027-02-01T12:00:00.000Z',
    }),
  ],
};

const settle = () => new Promise((r) => setTimeout(r));
/** Spartan closes after its 100 ms `closeDelay`. */
const closeDelay = () => new Promise((r) => setTimeout(r, 150));

interface Opts {
  data?: AdminLegalVersionsResponse;
  /** What `publish` does: resolve, throw, or wait on a promise the test controls. */
  publish?: HttpErrorResponse | Promise<void>;
}

async function setup(opts: Opts = {}) {
  let data = structuredClone(opts.data ?? BOTH);
  const api = {
    list: vi.fn(async () => structuredClone(data)),
    publish: vi.fn(async (body: PublishLegalVersionRequest) => {
      if (opts.publish instanceof HttpErrorResponse) throw opts.publish;
      if (opts.publish) await opts.publish;
      const row = published({
        document: body.document,
        version: body.version,
        material: body.material,
        requires_acceptance: body.requires_acceptance,
        summary: body.summary,
      });
      data = {
        ...data,
        upcoming: data.upcoming.map((e) =>
          e.document === body.document ? { ...e, published: row } : e,
        ),
      };
      return { legal_version: row };
    }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminLegalApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(AdminLegalVersions);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rerender = async () => {
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { fixture, api, el, rerender };
}

const text = (node: Element | null | undefined) => node?.textContent?.replace(/\s+/g, ' ').trim();
const card = (el: HTMLElement, doc: string) =>
  el.querySelector<HTMLElement>(`[data-testid="legal-card"][data-document="${doc}"]`)!;
const radio = (scope: HTMLElement, doc: string, q: 'material' | 'acceptance', a: 'yes' | 'no') =>
  scope.querySelector<HTMLInputElement>(`#admin-legal-${doc}-${q}-${a}`)!;
const publishButton = (scope: HTMLElement) =>
  scope.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
const dialogEl = () => document.querySelector<HTMLElement>('[role="dialog"]');
const dialogButton = (label: string) =>
  [...(dialogEl()?.querySelectorAll('button') ?? [])].find((b) => text(b)?.startsWith(label))!;

async function choose(input: HTMLInputElement, rerender: () => Promise<void>) {
  input.click();
  await rerender();
}

async function type(scope: HTMLElement, doc: string, value: string, rerender: () => Promise<void>) {
  const ta = scope.querySelector<HTMLTextAreaElement>(`#admin-legal-${doc}-summary`)!;
  ta.value = value;
  ta.dispatchEvent(new Event('input'));
  ta.dispatchEvent(new Event('blur'));
  await rerender();
}

/** Fill one card's form and open the dialog. */
async function openDialog(
  ctx: Awaited<ReturnType<typeof setup>>,
  answers: { material: 'yes' | 'no'; acceptance: 'yes' | 'no'; doc?: string },
) {
  const doc = answers.doc ?? 'vendor_terms';
  const c = card(ctx.el, doc);
  await choose(radio(c, doc, 'material', answers.material), ctx.rerender);
  await choose(radio(c, doc, 'acceptance', answers.acceptance), ctx.rerender);
  await type(c, doc, 'Claims end after 90 days without a seat.', ctx.rerender);
  publishButton(c).click();
  await ctx.rerender();
  return c;
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('aec-admin-legal-versions').forEach((n) => n.remove());
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.replaceChildren());
});

describe('summary helpers', () => {
  it('split one bullet per non-blank line and check them like the API', () => {
    expect(summaryBullets(' a \n\n b \r\n')).toEqual(['a', 'b']);
    expect(summaryProblem([])).toBe('Write at least one line.');
    expect(summaryProblem(Array.from({ length: 11 }, (_, i) => `b${i}`))).toBe(
      'Use at most 10 lines.',
    );
    expect(summaryProblem(['ok', 'x'.repeat(301)])).toBe('Line 2 is longer than 300 characters.');
    expect(summaryProblem(['ok'])).toBeNull();
    for (const bad of ['tab\there', 'bidi \u202E', 'zero\u200Bwidth', 'sep\u2028x']) {
      expect(summaryProblem(['ok', bad])).toBe(
        'Line 2 contains a hidden or control character, such as a tab, a zero-width space or a text-direction mark. Retype the line as plain text.',
      );
    }
  });

  it('size a PDF for people', () => {
    expect(humanBytes(146_448)).toBe('143 KB');
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(humanBytes(812)).toBe('812 bytes');
    expect(humanBytes(1)).toBe('1 byte');
  });
});

describe('AdminLegalVersions', () => {
  it('shows an empty state when nothing is upcoming', async () => {
    const { el } = await setup({ data: { publish_enabled: true, upcoming: [] } });
    expect(text(el)).toContain('No version is waiting to be published');
    expect(el.querySelector('[data-testid="legal-card"]')).toBeNull();
  });

  it('starts with no answer chosen and Publish off', async () => {
    const { el } = await setup();
    const c = card(el, 'vendor_terms');
    const radios = [...c.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(4);
    expect(radios.some((r) => r.checked)).toBe(false);
    expect(publishButton(c).disabled).toBe(true);
    expect(text(c)).toContain('Answer both questions and write the summary to publish.');
    expect(text(c)).toContain('Takes effect January 15, 2027 at 12:00 UTC');
  });

  it('enables Publish only once both questions are answered and the summary is valid', async () => {
    const ctx = await setup();
    const c = card(ctx.el, 'vendor_terms');
    await type(c, 'vendor_terms', 'One change.', ctx.rerender);
    expect(publishButton(c).disabled).toBe(true);
    await choose(radio(c, 'vendor_terms', 'material', 'no'), ctx.rerender);
    expect(publishButton(c).disabled).toBe(true);
    await choose(radio(c, 'vendor_terms', 'acceptance', 'no'), ctx.rerender);
    expect(publishButton(c).disabled).toBe(false);
    await type(c, 'vendor_terms', '', ctx.rerender);
    expect(publishButton(c).disabled).toBe(true);
  });

  it('allows "Needs acceptance: Yes" only on a material change, and clears it when material goes to No', async () => {
    const ctx = await setup();
    const c = card(ctx.el, 'vendor_terms');
    expect(radio(c, 'vendor_terms', 'acceptance', 'yes').disabled).toBe(true);
    expect(text(c)).toContain('Yes is available once you answer Yes to the first question.');

    await choose(radio(c, 'vendor_terms', 'material', 'yes'), ctx.rerender);
    expect(radio(c, 'vendor_terms', 'acceptance', 'yes').disabled).toBe(false);
    await choose(radio(c, 'vendor_terms', 'acceptance', 'yes'), ctx.rerender);
    expect(radio(c, 'vendor_terms', 'acceptance', 'yes').checked).toBe(true);

    await choose(radio(c, 'vendor_terms', 'material', 'no'), ctx.rerender);
    expect(radio(c, 'vendor_terms', 'acceptance', 'yes').disabled).toBe(true);
    expect(radio(c, 'vendor_terms', 'acceptance', 'yes').checked).toBe(false);
    expect(radio(c, 'vendor_terms', 'acceptance', 'no').checked).toBe(false);
  });

  it('ties the summary error to the field', async () => {
    const ctx = await setup();
    const c = card(ctx.el, 'vendor_terms');
    await type(c, 'vendor_terms', `ok\n${'x'.repeat(301)}`, ctx.rerender);
    const ta = c.querySelector<HTMLTextAreaElement>('#admin-legal-vendor_terms-summary')!;
    const error = c.querySelector('[data-testid="legal-summary-error"]')!;
    expect(text(error)).toBe('Line 2 is longer than 300 characters.');
    expect(ta.getAttribute('aria-invalid')).toBe('true');
    expect(ta.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    expect(text(c)).toContain('2 of 10 lines used');
  });

  it("keeps each document's hints and the expedited reason on its own card", async () => {
    const { el } = await setup();
    const vt = card(el, 'vendor_terms');
    const mp = card(el, 'managed_plan');
    expect(text(vt)).toContain('liability, indemnity, disputes or the content license');
    expect(text(vt)).not.toContain('pay monthly');
    expect(text(mp)).toContain('Customers who pay monthly must then click to accept it');
    expect(text(mp)).not.toContain('indemnity');
    expect(vt.querySelector('aec-select')).not.toBeNull();
    expect(mp.querySelector('aec-select')).toBeNull();
    expect(text(mp)).not.toContain('Expedited reason');
  });

  it('says what material and acceptance mean for the Vendor Terms, in sentences that read right', async () => {
    const ctx = await setup();
    await openDialog(ctx, { material: 'yes', acceptance: 'yes' });
    const d = dialogEl()!;
    expect(text(d.querySelector('h2'))).toBe('Publish version 1.4 of the Vendor Terms?');
    expect(text(d)).toContain(
      'This records version 1.4, which takes effect on January 15, 2027 at 12:00 UTC, with your summary and the stored PDF.',
    );
    expect(text(d.querySelector('[data-testid="legal-dialog-material"]'))).toBe(
      'You said this is a material change. Once change emails are built, publishing a material change will email every affected company with your summary. For now nothing is sent.',
    );
    expect(text(d.querySelector('[data-testid="legal-dialog-acceptance"]'))).toBe(
      'You said it needs acceptance. An owner of each company will have to accept version 1.4 before it applies to that company.',
    );
    expect(text(d)).toContain('A publish cannot be undone.');
    expect(text(d)).not.toMatch(/\b1 bullets\b|goes to The/);
  });

  it('says what "not material, no acceptance" means', async () => {
    const ctx = await setup();
    await openDialog(ctx, { material: 'no', acceptance: 'no' });
    const d = dialogEl()!;
    expect(text(d.querySelector('[data-testid="legal-dialog-material"]'))).toBe(
      'You said this is not a material change. No company will be emailed about it.',
    );
    expect(text(d.querySelector('[data-testid="legal-dialog-acceptance"]'))).toBe(
      'You said it does not need acceptance, so no one will be asked to accept it.',
    );
  });

  it('says what acceptance means for the Managed plan agreement', async () => {
    const ctx = await setup();
    await openDialog(ctx, { material: 'yes', acceptance: 'yes', doc: 'managed_plan' });
    const d = dialogEl()!;
    expect(text(d.querySelector('h2'))).toBe('Publish version 1.2 of the Managed plan agreement?');
    expect(text(d.querySelector('[data-testid="legal-dialog-acceptance"]'))).toBe(
      'You said it needs acceptance. Customers who pay monthly will have to click to accept version 1.2 before it applies to them.',
    );
  });

  it('cannot be closed while the publish is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ctx = await setup({ publish: gate });
    await openDialog(ctx, { material: 'yes', acceptance: 'no' });
    dialogButton('Publish version').click();
    await ctx.rerender();
    expect(text(dialogEl())).toContain('Publishing…');

    expect(dialogButton('Cancel').disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    dialogEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.querySelector<HTMLElement>('.cdk-overlay-backdrop')?.click();
    await closeDelay();
    await ctx.rerender();
    expect(dialogEl()).not.toBeNull();

    release();
    await ctx.rerender();
    await closeDelay();
    await ctx.rerender();
    expect(dialogEl()).toBeNull();
  });

  it('shows a failure in the dialog and on the card, as an alert', async () => {
    const ctx = await setup({
      publish: new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'LEGAL_PDF_MISSING', message: 'x' } },
      }),
    });
    const c = await openDialog(ctx, { material: 'yes', acceptance: 'no' });
    dialogButton('Publish version').click();
    await ctx.rerender();
    await ctx.rerender();
    const expected =
      'No valid PDF is stored for this version. Run the legal PDF workflow for it, then publish again.';
    expect(text(dialogEl()!.querySelector('[data-testid="legal-dialog-error"]'))).toBe(expected);
    const cardError = card(ctx.el, 'vendor_terms').querySelector(
      '[data-testid="legal-card-error"]',
    );
    expect(c).toBeTruthy();
    expect(text(cardError)).toBe(expected);
    expect(cardError?.getAttribute('role')).toBe('alert');
  });

  it.each([
    [
      'passed',
      "This version's effective date has already passed. Move the effective date in the repository and deploy again. An expedited reason does not help.",
    ],
    [
      'too_soon',
      'This version takes effect less than 30 days from now. Move its effective date, or for the Vendor Terms give an expedited reason.',
    ],
  ])('gives the window advice for reason %s', async (reason, expected) => {
    const ctx = await setup({
      publish: new HttpErrorResponse({
        status: 422,
        error: { error: { code: 'LEGAL_NOTICE_WINDOW', message: 'x', details: { reason } } },
      }),
    });
    await openDialog(ctx, { material: 'yes', acceptance: 'no' });
    dialogButton('Publish version').click();
    await ctx.rerender();
    await ctx.rerender();
    expect(text(dialogEl()!.querySelector('[data-testid="legal-dialog-error"]'))).toBe(expected);
    expect(
      text(card(ctx.el, 'vendor_terms').querySelector('[data-testid="legal-card-error"]')),
    ).toBe(expected);
  });

  it('publishes the answers, then moves focus to the card heading and shows the record', async () => {
    const ctx = await setup();
    await openDialog(ctx, { material: 'yes', acceptance: 'yes' });
    dialogButton('Publish version').click();
    await ctx.rerender();
    await closeDelay();
    await ctx.rerender();
    await ctx.rerender();

    expect(ctx.api.publish).toHaveBeenCalledWith({
      document: 'vendor_terms',
      version: '1.4',
      material: true,
      requires_acceptance: true,
      summary: ['Claims end after 90 days without a seat.'],
      expedited_reason: null,
    });
    expect(dialogEl()).toBeNull();
    const c = card(ctx.el, 'vendor_terms');
    expect(document.activeElement?.id).toBe('admin-legal-vendor_terms-heading');
    expect(text(c)).toContain('Published November 12, 2026 at 14:03 UTC by admin 49dd03ee');
    expect(text(c.querySelector('[data-testid="legal-pdf"]'))).toBe(
      'legal/vendor-terms/v1.4.pdf, 143 KB, SHA-256 9f86d081884c',
    );
    expect(text(c)).toContain('Material change Yes');
    expect(text(c)).toContain('Needs acceptance Yes');
    expect(c.querySelector('form')).toBeNull();
    expect(text(ctx.el.querySelector('[role="status"]'))).toBe(
      'Version 1.4 of the Vendor Terms is published.',
    );
  });

  it('leaves out the expedited reason on a Managed plan publish', async () => {
    const ctx = await setup();
    await openDialog(ctx, { material: 'no', acceptance: 'no', doc: 'managed_plan' });
    dialogButton('Publish version').click();
    await ctx.rerender();
    expect(ctx.api.publish.mock.calls[0]?.[0]).not.toHaveProperty('expedited_reason');
  });

  it('keeps Publish off and says why when the tier has publishing turned off', async () => {
    const ctx = await setup({ data: { ...BOTH, publish_enabled: false } });
    const c = card(ctx.el, 'vendor_terms');
    await choose(radio(c, 'vendor_terms', 'material', 'no'), ctx.rerender);
    await choose(radio(c, 'vendor_terms', 'acceptance', 'no'), ctx.rerender);
    await type(c, 'vendor_terms', 'One change.', ctx.rerender);
    expect(publishButton(c).disabled).toBe(true);
    expect(text(c)).toContain('Publishing is turned off on this tier.');
    expect(text(ctx.el.querySelector('[data-testid="legal-publish-off"]'))).toContain(
      'Publishing is turned off on this tier',
    );
  });
});
