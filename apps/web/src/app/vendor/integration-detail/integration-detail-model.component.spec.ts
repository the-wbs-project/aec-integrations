/**
 * AECI-1149 to AECI-1153 — the integration detail page's rules
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.2, §6.17.4, §6.17.8).
 *
 * A `.component.spec.ts` only so it runs under `ng test`, where `$localize` is
 * initialised. Nothing here needs a TestBed.
 */
import { describe, expect, it } from 'vitest';

import type { VendorClaim, VendorContest, VendorIntegration } from '@aeci/shared';

import {
  CONTEST_RECEIVED_ON_OWNED,
  INTEGRATION_OWNED_CLAIMED,
  INTEGRATION_PROCORE_DETAIL,
  VENDOR_CONTESTS_FIXTURE,
  VENDOR_INTEGRATIONS_FIXTURE,
} from '../vendor-fixtures';

import {
  contestChange,
  howYouGetIt,
  integrationStatus,
  needsItems,
  noteAudience,
  rowPill,
  sharedSummary,
  stampsToKeep,
  statusFromParam,
  statusLabel,
} from './integration-detail-model';
import { noteAudienceHint } from '../components/vendor-attestation-labels';

const NONE = { submitted: [], received: [] };
const ctx = (overrides: Partial<Parameters<typeof integrationStatus>[1]> = {}) => ({
  contests: NONE,
  entitled: true,
  ...overrides,
});

const BOTH = VENDOR_INTEGRATIONS_FIXTURE.integrations[1]!;
const VENDOR_B = VENDOR_INTEGRATIONS_FIXTURE.integrations[2]!;
const CONNECTOR = VENDOR_INTEGRATIONS_FIXTURE.integrations[4]!;

function withClaims(i: VendorIntegration, claims: VendorClaim[]): VendorIntegration {
  return { ...i, claims };
}

const answered = (claim: VendorClaim): VendorClaim => ({
  ...claim,
  agreement: 'single_source',
  mine: [
    {
      slot: 'vendor_a',
      asserted: true,
      note: null,
      introduced_version_id: null,
      deprecated_version_id: null,
      updated_at: '2026-09-01T00:00:00.000Z',
    },
  ],
});

describe('integrationStatus — the first that applies (§6.17.2)', () => {
  it('retired beats everything', () => {
    expect(
      integrationStatus(
        { ...INTEGRATION_PROCORE_DETAIL, retired_at: '2026-09-01T00:00:00Z' },
        ctx(),
      ),
    ).toBe('retired');
  });

  it('a conflict is a disagreement', () => {
    expect(integrationStatus(INTEGRATION_PROCORE_DETAIL, ctx())).toBe('disagreement');
  });

  it('an unanswered row, not added by the other company, needs an answer', () => {
    expect(integrationStatus(VENDOR_B, ctx())).toBe('needs_answer');
  });

  it('a counterpart-added row alone needs a decision, not an answer', () => {
    const only = withClaims(
      INTEGRATION_PROCORE_DETAIL,
      INTEGRATION_PROCORE_DETAIL.claims.filter((c) => c.added_by === 'counterpart'),
    );
    expect(integrationStatus(only, ctx())).toBe('needs_decision');
  });

  it('an open received request needs a decision', () => {
    const answeredOwned = withClaims(
      INTEGRATION_OWNED_CLAIMED,
      INTEGRATION_OWNED_CLAIMED.claims.map(answered),
    );
    expect(
      integrationStatus(
        answeredOwned,
        ctx({ contests: { submitted: [], received: [CONTEST_RECEIVED_ON_OWNED] } }),
      ),
    ).toBe('needs_decision');
    expect(integrationStatus(answeredOwned, ctx())).toBe('up_to_date');
  });

  it('an unclaimed owned row is ready to claim, but only when a claim is allowed', () => {
    const owned = withClaims(
      { ...INTEGRATION_OWNED_CLAIMED, claimed_at: null },
      INTEGRATION_OWNED_CLAIMED.claims.map(answered),
    );
    expect(integrationStatus(owned, ctx())).toBe('ready_to_claim');
    // A connector-powered row without a plan has no Claim, so it falls through.
    expect(integrationStatus({ ...owned, attestable: false }, ctx({ entitled: false }))).toBe(
      'connector',
    );
  });

  it('no owner, and no open owner request from the caller', () => {
    expect(integrationStatus(withClaims(BOTH, BOTH.claims), ctx())).toBe('no_owner');
    const ownerRequest = { ...VENDOR_CONTESTS_FIXTURE.submitted[0]!, field: 'owner' as const };
    expect(
      integrationStatus(BOTH, ctx({ contests: { submitted: [ownerRequest], received: [] } })),
    ).toBe('waiting');
  });

  it('a connector-powered row with nothing else is maintained by AEC Integrations', () => {
    const connector = { ...CONNECTOR, owner: { id: 'x', name: 'Agave' } };
    expect(integrationStatus(connector, ctx())).toBe('connector');
    expect(statusLabel('connector')).toBe('AEC Integrations maintained');
  });

  it('names who a waiting request is with', () => {
    const open: VendorContest = {
      ...VENDOR_CONTESTS_FIXTURE.submitted[0]!,
      routed_to: 'owner',
      status: 'open',
    };
    expect(statusLabel('waiting', { submitted: [open], received: [] })).toBe(
      'Waiting on Procore Technologies',
    );
    expect(
      statusLabel('waiting', { submitted: [{ ...open, routed_to: 'aeci' }], received: [] }),
    ).toBe('Waiting on AEC Integrations');
  });
});

describe('statusFromParam — old §6.3 values map to their nearest key (§6.17.1)', () => {
  it('maps conflict and needs_you', () => {
    expect(statusFromParam('conflict')).toBe('disagreement');
    expect(statusFromParam('needs_you')).toBe('needs_answer');
    expect(statusFromParam('ready_to_claim')).toBe('ready_to_claim');
    expect(statusFromParam(null)).toBe('all');
    expect(statusFromParam('bogus')).toBe('all');
  });
});

describe('needsItems — "Things that need you" (§6.17.2)', () => {
  const now = '2026-09-28T00:00:00.000Z';

  it('lists the added row, the rows to answer, and waits on the reasoned disagreement', () => {
    const lists = needsItems(INTEGRATION_PROCORE_DETAIL, {
      ...ctx(),
      company: 'Procore Technologies',
      now,
    });
    const yours = lists.yours.map((i) => i.text);
    expect(yours).toContain('Procore Technologies added Documents. Is this right?');
    expect(yours).toContain('1 row of data needs your answer');
    // The caller's answer on Drawings carries a reason, so it waits.
    expect(lists.waiting.map((i) => i.text)).toContain(
      'Procore Technologies disagrees about Drawings. You gave your reason',
    );
    expect(lists.waiting.map((i) => i.text)).toContain(
      'You added RFIs. Waiting for Procore Technologies',
    );
  });

  it('asks for a reason on a disagreement the caller has not explained', () => {
    const noReason = withClaims(
      INTEGRATION_PROCORE_DETAIL,
      INTEGRATION_PROCORE_DETAIL.claims.map((c) =>
        c.agreement === 'conflict' ? { ...c, mine: c.mine.map((m) => ({ ...m, note: null })) } : c,
      ),
    );
    const lists = needsItems(noReason, { ...ctx(), company: 'Procore Technologies', now });
    expect(lists.yours.map((i) => i.text)).toContain(
      'Procore Technologies disagrees about Drawings',
    );
  });

  it('lists a received request and names the field in plain words', () => {
    const lists = needsItems(INTEGRATION_OWNED_CLAIMED, {
      ...ctx({ contests: { submitted: [], received: [CONTEST_RECEIVED_ON_OWNED] } }),
      company: 'Trimble',
      now,
    });
    expect(lists.yours.map((i) => i.text)).toContain('Trimble asked to change release stage');
  });

  it('lists nothing on a retired row', () => {
    const lists = needsItems(
      { ...INTEGRATION_PROCORE_DETAIL, retired_at: '2026-09-01T00:00:00Z' },
      { ...ctx(), company: null, now },
    );
    expect(lists.yours).toHaveLength(0);
    expect(lists.waiting).toHaveLength(0);
  });

  it('never prompts a second owner request (AECI-1143)', () => {
    const ownerRequest = { ...VENDOR_CONTESTS_FIXTURE.submitted[0]!, field: 'owner' as const };
    const lists = needsItems(BOTH, {
      ...ctx({ contests: { submitted: [ownerRequest], received: [] } }),
      company: null,
      now,
    });
    expect(lists.yours.map((i) => i.key)).not.toContain('no-owner');
    expect(lists.waiting.map((i) => i.text)).toContain(
      'Your request to change owner is with AEC Integrations',
    );
  });
});

describe('row pills and copy (§6.17.8)', () => {
  const claims = INTEGRATION_PROCORE_DETAIL.claims;
  const byName = (name: string) => claims.find((c) => c.data_object_name === name)!;

  it('reads each row from the caller’s seat', () => {
    const co = 'Procore Technologies';
    expect(rowPill(INTEGRATION_PROCORE_DETAIL, byName('Models'), co).label).toBe(
      'Needs your answer',
    );
    expect(rowPill(INTEGRATION_PROCORE_DETAIL, byName('RFIs'), co).label).toBe(
      'Waiting for Procore Technologies',
    );
    expect(rowPill(INTEGRATION_PROCORE_DETAIL, byName('Submittals'), co).label).toBe(
      'Confirmed by both companies',
    );
    const disputed = rowPill(INTEGRATION_PROCORE_DETAIL, byName('Drawings'), co);
    expect(disputed).toEqual({ label: 'Disputed', tone: 'conflict' });
    expect(rowPill(BOTH, BOTH.claims[0]!, null).label).toBe('Confirmed by you');
    expect(rowPill(CONNECTOR, CONNECTOR.claims[0]!, null).label).toBe(
      'Checked by AEC Integrations',
    );
  });

  it('says what is shared in one line, by direction', () => {
    expect(sharedSummary(INTEGRATION_OWNED_CLAIMED)).toBe(
      'Models are sent to Trimble Connect. RFIs are shared both ways',
    );
  });

  it('writes a change in words, never with an arrow glyph', () => {
    const line = contestChange(CONTEST_RECEIVED_ON_OWNED);
    expect(line).toBe('Release stage: from Beta to Generally available');
    expect(line).not.toMatch(/[→←⇄]/);
  });

  it('names how you get it in plain words', () => {
    expect(howYouGetIt('native', null)).toBe('Built into the product');
    expect(howYouGetIt('iPaaS', 'Zapier')).toBe('Through Zapier');
    expect(howYouGetIt('iPaaS', null)).toBe('Through a connector service');
    expect(howYouGetIt('integrator', null)).toBe('Built by a consultancy');
  });
});

describe('stampsToKeep — a PUT re-sends the caller’s version stamps (§6.17.4)', () => {
  it('re-sends the stamps from the caller’s own row', () => {
    const drawings = INTEGRATION_PROCORE_DETAIL.claims.find(
      (c) => c.data_object_slug === 'drawings',
    )!;
    expect(stampsToKeep(INTEGRATION_PROCORE_DETAIL, drawings)).toEqual({
      introduced_version_id: drawings.mine[0]!.introduced_version_id,
      deprecated_version_id: null,
    });
  });

  it('on an owns-both row, keeps the stamped slot', () => {
    const claim = BOTH.claims[0]!;
    expect(stampsToKeep(BOTH, claim).introduced_version_id).toBe(
      claim.mine[0]!.introduced_version_id,
    );
  });
});

// AECI-1139: who reads a note. Ported from the retired inline panel's spec, so
// the shared rule keeps its coverage now that only this page renders note fields.
describe('noteAudienceHint (AECI-1139)', () => {
  const ME = { id: 'me', name: 'Summit BIM' };
  const THEM = { id: 'them', name: 'Procore Technologies' };
  const ALSO = { id: 'also', name: 'Autodesk' };

  it('names the one other company', () => {
    expect(
      noteAudienceHint({ slots: ['vendor_a'], endpoint_vendors: [ME, THEM] }, 'me', 'Procore'),
    ).toBe('Only Procore Technologies and AEC Integrations see this.');
  });

  it('is AECi-only when the caller owns both products and no one else is on file', () => {
    expect(
      noteAudienceHint({ slots: ['vendor_a', 'vendor_b'], endpoint_vendors: [ME] }, 'me', 'X'),
    ).toBe('Only AEC Integrations sees this.');
    // Also before the session's own vendor id is known.
    expect(
      noteAudienceHint({ slots: ['vendor_a', 'vendor_b'], endpoint_vendors: [ME] }, null, 'X'),
    ).toBe('Only AEC Integrations sees this.');
  });

  it('does NOT say AECi-only when a second company co-owns one of the products', () => {
    // `toCounterparty` shows a co-owner the caller's note, so it is an audience.
    expect(
      noteAudienceHint(
        { slots: ['vendor_a', 'vendor_b'], endpoint_vendors: [ME, ALSO] },
        'me',
        'X',
      ),
    ).toBe('Only Autodesk and AEC Integrations see this.');
  });

  it('falls back to the other product when no single company can be named', () => {
    expect(noteAudienceHint({ slots: ['vendor_a'], endpoint_vendors: [ME] }, 'me', 'Procore')).toBe(
      'Only the company behind Procore and AEC Integrations see this.',
    );
    expect(
      noteAudienceHint(
        { slots: ['vendor_a'], endpoint_vendors: [ME, THEM, ALSO] },
        'me',
        'Procore',
      ),
    ).toBe('Only the company behind Procore and AEC Integrations see this.');
  });

  it('is what the note fields on the page render', () => {
    const integration = {
      ...BOTH,
      slots: ['vendor_a'],
      endpoint_vendors: [ME, THEM],
    } as VendorIntegration;
    expect(noteAudience(integration, 'me')).toBe(
      'Only Procore Technologies and AEC Integrations see this.',
    );
  });
});
