import { describe, expect, it } from 'vitest';

import {
  contestValueProblem,
  DecideContestSchema,
  INTEGRATION_CONTEST_FIELDS,
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
