import { Component, Injectable } from '@angular/core';

import type {
  AdminDecidePairProtestInput,
  AdminPairContest,
  AdminPairContestResponse,
  AdminPairContestsResponse,
  AdminVetoesResponse,
  AdminContest,
  ContestProtest,
  DecideContestInput,
  DecideContestProtestInput,
  ListAdminContestsQuery,
  ListAdminContestsResponse,
} from '@aeci/shared';

import { AdminContestsApi } from '../../admin/contests/admin-contests-api';
import { ContestQueue } from '../../admin/contests/contest-queue';

/**
 * AECI-1009 — the `/admin/contests` queue, fed synthetic rows through a
 * component-provided fake of {@link AdminContestsApi}, so the Protests view and
 * its decision form, and (AECI-2110) the Sync Service section's review of an owner's
 * answer, can be reviewed, axe-scanned and `impeccable detect`-ed
 * without an admin session (the real route is behind the SSR admin gate, which a
 * dev server cannot pass without minting a real session).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR
 * Worker (`isPreviewPath`). Decisions resolve locally and write nothing.
 */
const DAY = 86_400_000;
const days = (n: number): string => new Date(Date.now() + n * DAY).toISOString();
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const PROCORE = { id: uuid(11), name: 'Procore', slug: 'procore', logo_url: null };
const SUMMIT = {
  id: uuid(12),
  name: 'Summit Estimating',
  slug: 'summit-estimating',
  logo_url: null,
};

function contest(over: Partial<AdminContest> & { id: string }): AdminContest {
  return {
    integration: {
      id: uuid(20),
      name: 'Procore Sync for Summit',
      source_product: PROCORE,
      target_product: SUMMIT,
      pair_path: '/products/procore/integrations/summit-estimating',
      anchor: 'integration',
      connector: null,
    },
    field: 'docs_url',
    current_value: 'https://support.procore.com/old-guide',
    proposed_value: 'https://support.procore.com/summit-setup',
    current_label: null,
    proposed_label: null,
    live_value: 'https://support.procore.com/old-guide',
    live_label: null,
    value_stale: false,
    accept_note_required: false,
    accept_source_required: false,
    reason: 'The old guide was retired in August and now redirects to a blank page.',
    routed_to: 'aeci',
    status: 'open',
    submitter_vendor: { id: uuid(101), name: 'Summit Estimating' },
    owner_vendor: { id: uuid(102), name: 'Procore Technologies' },
    decision_note: null,
    decided_at: null,
    upstream_linear_issue_id: null,
    upstream_linear_issue_url: null,
    created_at: days(-2),
    updated_at: days(-2),
    protest: null,
    owner_changed: false,
    ...over,
  };
}

const OPEN_PROTEST: ContestProtest = {
  status: 'open',
  basis: 'declined',
  reason:
    'Both the App Store listing and the setup guide use the longer name, and customers search for it by that name.',
  evidence_urls: ['https://apps.example.com/summit-listing', 'https://docs.example.com/setup'],
  protested_at: days(-3),
  reply_due_at: days(11),
  reply: null,
  reply_evidence_urls: [],
  replied_at: null,
  decision_note: null,
  decided_at: null,
};

const PROTESTS: readonly AdminContest[] = [
  contest({
    id: uuid(301),
    field: 'name',
    current_value: 'Procore Sync',
    proposed_value: 'Procore Sync for Summit Estimating',
    live_value: 'Procore Sync',
    routed_to: 'owner',
    status: 'declined',
    decision_note: 'Our release notes use the short name.',
    decided_at: days(-5),
    created_at: days(-9),
    protest: OPEN_PROTEST,
  }),
  contest({
    id: uuid(302),
    field: 'maturity',
    current_value: 'Beta',
    proposed_value: 'Generally available',
    live_value: 'Beta',
    reason: 'It left beta in 2026.2.',
    routed_to: 'owner',
    status: 'declined',
    created_at: days(-50),
    decided_at: days(-20),
    protest: {
      ...OPEN_PROTEST,
      basis: 'silence',
      reason: 'Our release notes call it generally available, and the owner never answered.',
      evidence_urls: [],
      protested_at: days(-18),
      reply_due_at: days(-4),
      reply: 'The Procore half is still gated behind a beta flag.',
      replied_at: days(-10),
    },
  }),
];

const CONTESTS: readonly AdminContest[] = [
  contest({ id: uuid(201) }),
  // AECI-1191: the owner claimed this row, so an accept changes their listing and
  // the form requires a note.
  contest({
    id: uuid(203),
    field: 'name',
    current_value: 'Procore Sync',
    proposed_value: 'Procore Sync for Summit Estimating',
    live_value: 'Procore Sync',
    reason: 'Customers search for the integration by its full name.',
    accept_note_required: true,
    accept_source_required: true,
  }),
  // AECI-1092: a contest on a connector-evidenced pair, routed to AECi.
  contest({
    id: uuid(202),
    integration: {
      id: uuid(21),
      name: 'Procore to Summit via Kroo',
      source_product: PROCORE,
      target_product: SUMMIT,
      pair_path: '/products/procore/integrations/summit-estimating',
      anchor: 'evidenced_pair',
      connector: { id: uuid(13), name: 'Kroo Connector', slug: 'kroo-connector', logo_url: null },
    },
    field: 'direction',
    current_value: 'a_to_b',
    proposed_value: 'both',
    live_value: 'a_to_b',
    reason: 'Kroo syncs cost codes back from Summit too.',
    owner_vendor: { id: uuid(103), name: 'Kroo' },
  }),
];

/** AECI-2110: the Sync Service section's review of an owner's answer, reply still open. */
const PAIR = {
  integration_id: uuid(530),
  anchor: 'evidenced_pair' as const,
  name: 'Procore and Acumatica (Rivets Sync)',
  connector: { id: uuid(520), slug: 'rivets-sync', name: 'Rivets Sync' },
  product_a: { id: uuid(510), slug: 'procore', name: 'Procore' },
  product_b: { id: uuid(511), slug: 'acumatica', name: 'Acumatica' },
};
const PAIR_PROTESTS: readonly AdminPairContest[] = [
  {
    id: uuid(540),
    kind: 'data_flow',
    pair: PAIR,
    flow: {
      claim_id: uuid(541),
      data_object_slug: 'rfis',
      data_object_name: 'RFIs',
      current_direction: 'a_to_b',
      proposed_direction: null,
    },
    reason: 'We do not send RFIs to this product.',
    submitter_vendor_id: uuid(503),
    submitter_name: 'Acumatica Inc',
    routed_to: 'owner',
    owner_vendor_id: uuid(501),
    owner_name: 'Rivets',
    status: 'declined',
    decision_note: 'RFIs sync on the Pro plan.',
    decided_at: days(-3),
    accept_mode: null,
    protest: {
      status: 'open',
      basis: 'declined',
      reason: 'Rivets’ own help page lists RFIs as not supported.',
      evidence_urls: ['https://help.rivets.example/sync/rfis'],
      protested_at: days(-1),
      reply_due_at: days(13),
      reply: null,
      reply_evidence_urls: [],
      replied_at: null,
      decision_note: null,
      decided_at: null,
    },
    protest_closes_at: null,
    cooldown_until: null,
    created_at: days(-10),
    updated_at: days(-1),
    key_rows: null,
    retract_by: null,
  },
];

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminContestsApi extends AdminContestsApi {
  override async listContests(
    query: Partial<ListAdminContestsQuery> = {},
  ): Promise<ListAdminContestsResponse> {
    const rows =
      query.protest_status !== undefined
        ? PROTESTS.filter((c) => c.protest?.status === query.protest_status)
        : CONTESTS.filter((c) => c.status === (query.status ?? 'open'));
    return { data: structuredClone([...rows]), page: 1, perPage: 100, total: rows.length };
  }

  override async listPairContests(
    query: { protests?: boolean; retractions?: boolean } = {},
  ): Promise<AdminPairContestsResponse> {
    return { data: query.protests ? structuredClone([...PAIR_PROTESTS]) : [] };
  }

  override async listVetoes(): Promise<AdminVetoesResponse> {
    return { data: [] };
  }

  override async decidePairProtest(
    id: string,
    input: AdminDecidePairProtestInput,
  ): Promise<AdminPairContestResponse> {
    const row = PAIR_PROTESTS.find((c) => c.id === id) ?? PAIR_PROTESTS[0]!;
    return {
      contest: {
        ...row,
        protest: row.protest && {
          ...row.protest,
          status: input.decision,
          decision_note: input.note,
          decided_at: new Date().toISOString(),
        },
      },
    };
  }

  override async decide(id: string, input: DecideContestInput): Promise<AdminContest> {
    return contest({ id, status: input.decision === 'accept' ? 'accepted' : 'declined' });
  }

  override async decideProtest(
    id: string,
    input: DecideContestProtestInput,
  ): Promise<AdminContest> {
    const row = PROTESTS.find((c) => c.id === id) ?? contest({ id });
    return {
      ...row,
      protest: row.protest && {
        ...row.protest,
        status: input.decision === 'uphold' ? 'upheld' : 'rejected',
        decision_note: input.note,
        decided_at: new Date().toISOString(),
      },
    };
  }
}

@Component({
  selector: 'app-admin-contests-preview',
  imports: [ContestQueue],
  providers: [{ provide: AdminContestsApi, useClass: PreviewAdminContestsApi }],
  template: `
    <div class="mx-auto max-w-5xl px-6 py-10">
      <h1
        class="mb-6 text-2xl font-bold text-(--text-primary)"
        i18n="@@preview.adminContests.heading"
      >
        Admin: change requests (preview)
      </h1>
      <aec-contest-queue />
    </div>
  `,
})
export class AdminContestsPreview {}
