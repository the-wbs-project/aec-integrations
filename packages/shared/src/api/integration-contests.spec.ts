import { describe, expect, it } from 'vitest';

import {
  addContestDays,
  contestProtestPhase,
  contestProtestWindow,
  contestValueProblem,
  DecideContestProtestSchema,
  DecideContestSchema,
  FileContestProtestSchema,
  INTEGRATION_CONTEST_FIELDS,
  ReplyContestProtestSchema,
  SubmitIntegrationContestSchema,
} from './integration-contests';
import { IntegrationMechanismKindSchema } from './integrations';

describe('INTEGRATION_CONTEST_FIELDS', () => {
  it('is the eleven content fields plus owner (AECI-1008)', () => {
    expect(INTEGRATION_CONTEST_FIELDS).toHaveLength(12);
    expect(INTEGRATION_CONTEST_FIELDS).toContain('owner');
    // `notes` is AECi's own curation column and is deliberately not contestable.
    expect(INTEGRATION_CONTEST_FIELDS).not.toContain('notes');
  });
});

describe('contestValueProblem', () => {
  it('requires a value for every field but owner', () => {
    expect(contestValueProblem('name', null)).not.toBeNull();
    expect(contestValueProblem('name', '')).not.toBeNull();
    expect(contestValueProblem('owner', null)).toBeNull();
  });

  it('holds the four URL fields to absolute http(s)', () => {
    for (const field of ['listing_url', 'docs_url', 'website', 'mechanism_url'] as const) {
      expect(contestValueProblem(field, 'https://example.test/x')).toBeNull();
      expect(contestValueProblem(field, 'example.test/x')).not.toBeNull();
      expect(contestValueProblem(field, 'javascript:alert(1)')).not.toBeNull();
    }
  });

  it('reuses the mechanism vocabulary instead of restating it', () => {
    for (const kind of IntegrationMechanismKindSchema.options) {
      expect(contestValueProblem('mechanism_kind', kind)).toBeNull();
    }
    expect(contestValueProblem('mechanism_kind', 'carrier-pigeon')).not.toBeNull();
  });

  it('takes direction in the caller-relative vocabulary, never the stored one', () => {
    expect(contestValueProblem('direction', 'inbound')).toBeNull();
    expect(contestValueProblem('direction', 'a_to_b')).not.toBeNull();
  });

  it('bounds lengths per field', () => {
    expect(contestValueProblem('name', 'x'.repeat(201))).not.toBeNull();
    expect(contestValueProblem('description', 'x'.repeat(2000))).toBeNull();
  });

  it('requires an owner proposal to look like a vendor id', () => {
    expect(contestValueProblem('owner', 'bentley')).not.toBeNull();
    expect(contestValueProblem('owner', '00000000-0000-4000-8000-000000000001')).toBeNull();
  });
});

describe('SubmitIntegrationContestSchema', () => {
  it('carries no routing, vendor id or status', () => {
    const parsed = SubmitIntegrationContestSchema.parse({
      field: 'name',
      proposed_value: '  New name ',
      reason: 'Because.',
      routed_to: 'owner',
      submitter_vendor_id: 'x',
      status: 'accepted',
    });
    expect(parsed).toEqual({ field: 'name', proposed_value: 'New name', reason: 'Because.' });
  });

  it('rejects an unknown field and an empty reason', () => {
    expect(
      SubmitIntegrationContestSchema.safeParse({ field: 'notes', proposed_value: 'x', reason: 'r' })
        .success,
    ).toBe(false);
    expect(
      SubmitIntegrationContestSchema.safeParse({ field: 'name', proposed_value: 'x', reason: ' ' })
        .success,
    ).toBe(false);
  });
});

describe('DecideContestSchema', () => {
  it('takes accept or decline, with an optional note', () => {
    expect(DecideContestSchema.parse({ decision: 'accept' })).toEqual({ decision: 'accept' });
    expect(DecideContestSchema.safeParse({ decision: 'withdraw' }).success).toBe(false);
  });
});

// ─── AECI-1009 protests ──────────────────────────────────────────────────────

describe('contestProtestWindow', () => {
  const base = {
    routed_to: 'owner',
    owner_vendor_id: 'v-owner',
    protest_status: null,
    created_at: '2026-08-01T00:00:00.000Z',
    decided_at: null,
  };

  it('opens at an owner decline and closes 30 days later', () => {
    const w = contestProtestWindow({
      ...base,
      status: 'declined',
      decided_at: '2026-08-10T00:00:00.000Z',
    });
    expect(w).toEqual({
      basis: 'declined',
      opens_at: '2026-08-10T00:00:00.000Z',
      closes_at: '2026-09-09T00:00:00.000Z',
    });
  });

  it('treats 30 days of silence as a decline, with the window closing on day 60', () => {
    const w = contestProtestWindow({ ...base, status: 'open' });
    expect(w).toEqual({
      basis: 'silence',
      opens_at: '2026-08-31T00:00:00.000Z',
      closes_at: '2026-09-30T00:00:00.000Z',
    });
  });

  it.each([
    ['an AECi-routed contest', { routed_to: 'aeci', status: 'declined', decided_at: 'x' }],
    ['a stranded contest', { owner_vendor_id: null, status: 'open' }],
    ['a protested contest', { protest_status: 'withdrawn', status: 'declined', decided_at: 'x' }],
    ['an accepted contest', { status: 'accepted', decided_at: 'x' }],
    ['a withdrawn contest', { status: 'withdrawn' }],
  ])('is null for %s', (_label, overrides) => {
    expect(contestProtestWindow({ ...base, ...overrides })).toBeNull();
  });
});

describe('contestProtestPhase', () => {
  const w = { opens_at: '2026-08-10T00:00:00.000Z', closes_at: '2026-09-09T00:00:00.000Z' };
  it('is half-open: open at opens_at, closed at closes_at', () => {
    expect(contestProtestPhase(w, '2026-08-09T23:59:59.999Z')).toBe('not_yet');
    expect(contestProtestPhase(w, '2026-08-10T00:00:00.000Z')).toBe('open');
    expect(contestProtestPhase(w, '2026-09-08T23:59:59.999Z')).toBe('open');
    expect(contestProtestPhase(w, '2026-09-09T00:00:00.000Z')).toBe('closed');
  });
});

describe('protest write shapes', () => {
  it('accepts up to three http(s) evidence links and defaults to none', () => {
    expect(FileContestProtestSchema.parse({ reason: 'x' }).evidence_urls).toEqual([]);
    expect(
      FileContestProtestSchema.safeParse({
        reason: 'x',
        evidence_urls: ['https://a.test', 'http://b.test', 'https://c.test'],
      }).success,
    ).toBe(true);
    expect(
      FileContestProtestSchema.safeParse({
        reason: 'x',
        evidence_urls: ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'],
      }).success,
    ).toBe(false);
    expect(
      ReplyContestProtestSchema.safeParse({ reply: 'x', evidence_urls: ['javascript:alert(1)'] })
        .success,
    ).toBe(false);
  });

  it('requires a note on an AECi ruling', () => {
    expect(DecideContestProtestSchema.safeParse({ decision: 'uphold' }).success).toBe(false);
    expect(DecideContestProtestSchema.safeParse({ decision: 'reject', note: 'why' }).success).toBe(
      true,
    );
  });

  it('adds whole 24-hour days with no calendar', () => {
    expect(addContestDays('2026-03-07T12:00:00.000Z', 1)).toBe('2026-03-08T12:00:00.000Z');
    expect(addContestDays('2026-09-22T00:00:00.000Z', -90)).toBe('2026-06-24T00:00:00.000Z');
  });
});
