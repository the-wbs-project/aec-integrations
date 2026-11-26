import { z } from 'zod';

/**
 * An endpoint vendor's three rights on a pair a Sync Service delivers (AECI-2042,
 * rulings 8, 9 and 10 on AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e,
 * `API_CONTRACTS.md` §6.15b).
 *
 * | Right | Decided by | Effect |
 * |---|---|---|
 * | Veto ("we do not authorise this on our product") | the endpoint vendor | the pair leaves the public site at once |
 * | Existence ("this does not exist or is no longer offered") | AECi | an accept retires the pair; filing hides nothing |
 * | Data flow ("this one flow is wrong") | the owner of a claimed pair, else AECi | an owner accept removes the flow or changes its direction |
 *
 * A veto applies only where the connector is a Sync Service (`isSyncService`). Native
 * rows, Integration platforms and unclassified connectors keep the field contests of
 * §11b. A protest to AECi after a data flow decline is advice only, as in §11b.12.
 *
 * Directions on the wire are the stored canonical frame (`a_to_b`, `b_to_a`, `both`)
 * against `pair.product_a`, which every view below carries.
 *
 * i18n note: framework-agnostic package (no `$localize`). The portal renders its own copy.
 */

export const PAIR_RIGHT_REASON_MAX = 1000;
export const PAIR_PROTEST_REASON_MAX = 2000;

/** The stored frame of a flow direction. */
export const PairFlowDirectionSchema = z.enum(['a_to_b', 'b_to_a', 'both']);
export type PairFlowDirection = z.infer<typeof PairFlowDirectionSchema>;

const ReasonSchema = z.string().trim().min(1).max(PAIR_RIGHT_REASON_MAX);

/** A product named by a veto or a report. `null` when the product row is gone. */
export const PairRightProductSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});
export type PairRightProduct = z.infer<typeof PairRightProductSchema>;

/** The pair a veto or a report is about, in canonical order (A sorts first by id). */
export const PairRightPairSchema = z.object({
  integration_id: z.string().uuid().nullable(),
  anchor: z.enum(['integration', 'evidenced_pair']).nullable(),
  name: z.string().nullable(),
  connector: PairRightProductSchema.nullable(),
  product_a: PairRightProductSchema.nullable(),
  product_b: PairRightProductSchema.nullable(),
});
export type PairRightPair = z.infer<typeof PairRightPairSchema>;

// ─── Veto ────────────────────────────────────────────────────────────────────

/** `POST /api/vendor/integrations/:id/veto`. The reason is required and goes to the
 *  pair's owner and to AECi. */
export const FileVetoSchema = z.object({ reason: ReasonSchema }).strict();
export type FileVetoInput = z.infer<typeof FileVetoSchema>;

/** `POST /api/admin/vetoes/:id/lift`. The note is required: it is the record of why a
 *  veto filed through a seat stopped counting, and the vetoing vendor sees it. */
export const AdminLiftVetoSchema = z.object({ note: ReasonSchema }).strict();
export type AdminLiftVetoInput = z.infer<typeof AdminLiftVetoSchema>;

export const VetoEndedHowSchema = z.enum(['withdrawn', 'lifted']);

export const SyncServicePairVetoSchema = z.object({
  id: z.string().uuid(),
  pair: PairRightPairSchema,
  vendor_id: z.string().uuid().nullable(),
  vendor_name: z.string().nullable(),
  reason: z.string(),
  filed_at: z.string(),
  in_force: z.boolean(),
  ended_at: z.string().nullable(),
  ended_how: VetoEndedHowSchema.nullable(),
  /** An admin's lift note. Shown to the vetoing vendor and the owner. */
  end_note: z.string().nullable(),
  /** Other vendors' vetoes still in force on the same pair: the pair returns only when
   *  this is 0 and this veto has ended. */
  other_vetoes_in_force: z.number().int().nonnegative(),
  updated_at: z.string(),
});
export type SyncServicePairVeto = z.infer<typeof SyncServicePairVetoSchema>;

/** `GET /api/vendor/vetoes`: the vetoes this vendor filed, and the vetoes on pairs this
 *  vendor owns (`built_by_vendor_id`). Newest first, 100 per side. */
export const VendorVetoesResponseSchema = z.object({
  filed: z.array(SyncServicePairVetoSchema),
  received: z.array(SyncServicePairVetoSchema),
});
export type VendorVetoesResponse = z.infer<typeof VendorVetoesResponseSchema>;

/** `GET /api/admin/vetoes?in_force=true|false`. */
export const ListAdminVetoesQuerySchema = z.object({
  in_force: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
export const AdminVetoesResponseSchema = z.object({
  data: z.array(SyncServicePairVetoSchema.extend({ owner_name: z.string().nullable() })),
});
export type AdminVetoesResponse = z.infer<typeof AdminVetoesResponseSchema>;
export type AdminVeto = AdminVetoesResponse['data'][number];

/** The answer of a veto, a withdraw and a lift: the veto after the write, and whether
 *  the pair is on the public site now. */
export const VetoWriteResponseSchema = z.object({
  veto: SyncServicePairVetoSchema,
  pair_public: z.boolean(),
});
export type VetoWriteResponse = z.infer<typeof VetoWriteResponseSchema>;

// ─── Existence and data flow reports ─────────────────────────────────────────

export const PAIR_CONTEST_KINDS = ['existence', 'data_flow'] as const;
export const PairContestKindSchema = z.enum(PAIR_CONTEST_KINDS);
export type PairContestKind = z.infer<typeof PairContestKindSchema>;

export const PairContestStatusSchema = z.enum(['open', 'accepted', 'declined', 'withdrawn']);
export type PairContestStatus = z.infer<typeof PairContestStatusSchema>;

export const PairContestRouteSchema = z.enum(['owner', 'aeci']);

/** `POST /api/vendor/integrations/:id/pair-contests`. */
export const SubmitPairContestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existence'), reason: ReasonSchema }).strict(),
  z
    .object({
      kind: z.literal('data_flow'),
      claim_id: z.string().uuid(),
      reason: ReasonSchema,
      /** The direction the flow should have, stored frame. Absent or `null`: the flow
       *  should not be listed at all. */
      proposed_direction: PairFlowDirectionSchema.nullable().optional(),
    })
    .strict(),
]);
export type SubmitPairContestInput = z.infer<typeof SubmitPairContestSchema>;

/** `POST /api/vendor/pair-contests/:id/decision` (the owner of a claimed pair). */
export const DecidePairContestSchema = z
  .object({
    decision: z.enum(['accept', 'decline']),
    note: z.string().trim().max(PAIR_RIGHT_REASON_MAX).optional(),
  })
  .strict();
export type DecidePairContestInput = z.infer<typeof DecidePairContestSchema>;

/**
 * `PATCH /api/admin/pair-contests/:id`. An accept needs a note, and an existence accept
 * also needs `source_url`: AECi retires on proof (ruling 9), and the proof is recorded.
 * The handler checks both, so the shape stays one schema.
 */
export const AdminDecidePairContestSchema = z
  .object({
    decision: z.enum(['accept', 'decline']),
    note: z.string().trim().max(PAIR_RIGHT_REASON_MAX).optional(),
    source_url: z
      .string()
      .trim()
      .url()
      .refine((v) => v.startsWith('https://'), { message: 'An https link is required' })
      .optional(),
  })
  .strict();
export type AdminDecidePairContestInput = z.infer<typeof AdminDecidePairContestSchema>;

/** `POST /api/vendor/pair-contests/:id/protest`. */
export const FilePairProtestSchema = z
  .object({ reason: z.string().trim().min(1).max(PAIR_PROTEST_REASON_MAX) })
  .strict();
export type FilePairProtestInput = z.infer<typeof FilePairProtestSchema>;

/** `PATCH /api/admin/pair-contests/:id/protest`. Advice only: the note is required and
 *  nothing on the listing changes. */
export const AdminDecidePairProtestSchema = z
  .object({ decision: z.enum(['upheld', 'rejected']), note: ReasonSchema })
  .strict();
export type AdminDecidePairProtestInput = z.infer<typeof AdminDecidePairProtestSchema>;

export const PairProtestSchema = z.object({
  status: z.enum(['open', 'upheld', 'rejected', 'withdrawn']),
  basis: z.enum(['declined', 'silence']),
  reason: z.string(),
  protested_at: z.string(),
  decision_note: z.string().nullable(),
  decided_at: z.string().nullable(),
});
export type PairProtest = z.infer<typeof PairProtestSchema>;

export const PairContestFlowSchema = z.object({
  claim_id: z.string().uuid(),
  data_object_slug: z.string(),
  data_object_name: z.string(),
  current_direction: PairFlowDirectionSchema,
  /** `null`: the submitter says the flow should not be listed. */
  proposed_direction: PairFlowDirectionSchema.nullable(),
});

export const PairContestSchema = z.object({
  id: z.string().uuid(),
  kind: PairContestKindSchema,
  pair: PairRightPairSchema,
  flow: PairContestFlowSchema.nullable(),
  reason: z.string(),
  submitter_vendor_id: z.string().uuid(),
  submitter_name: z.string().nullable(),
  routed_to: PairContestRouteSchema,
  owner_vendor_id: z.string().uuid().nullable(),
  owner_name: z.string().nullable(),
  status: PairContestStatusSchema,
  decision_note: z.string().nullable(),
  decided_at: z.string().nullable(),
  accept_mode: z.string().nullable(),
  protest: PairProtestSchema.nullable(),
  /** When the submitter may protest now: the window's close. `null` otherwise. */
  protest_closes_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PairContest = z.infer<typeof PairContestSchema>;

/** `GET /api/vendor/pair-contests`: filed by this vendor, and owner-routed reports on
 *  its pairs. Newest first, 100 per side. */
export const VendorPairContestsResponseSchema = z.object({
  submitted: z.array(PairContestSchema),
  received: z.array(PairContestSchema),
});
export type VendorPairContestsResponse = z.infer<typeof VendorPairContestsResponseSchema>;

/** `GET /api/admin/pair-contests?status=&protests=`. */
export const ListAdminPairContestsQuerySchema = z.object({
  status: PairContestStatusSchema.default('open'),
  /** `true`: the open protests, whatever the report's status. */
  protests: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export const AdminPairContestsResponseSchema = z.object({ data: z.array(PairContestSchema) });
export type AdminPairContestsResponse = z.infer<typeof AdminPairContestsResponseSchema>;

export const PairContestResponseSchema = z.object({ contest: PairContestSchema });
export type PairContestResponse = z.infer<typeof PairContestResponseSchema>;

/**
 * What an endpoint vendor may file on one delivered pair, on the Connectors section's
 * contest target (`EvidencedPairContestTarget.sync_service_rights`). `null` there when
 * the connector is not a Sync Service, or the caller is its owner.
 */
export const SyncServiceRightsSchema = z.object({
  /** The caller's veto in force on this pair, if any. */
  veto_id: z.string().uuid().nullable(),
  /** The kinds the caller has an open report of. */
  open_reports: z.array(PairContestKindSchema),
  /** The claims with an open data flow report by the caller. */
  open_flow_claim_ids: z.array(z.string().uuid()),
  /** The flows a data flow report may name: every claim on the pair, including one the
   *  owner already answered No to (it is off the public page, and a report on it is moot
   *  but harmless). */
  flows: z.array(
    z.object({
      claim_id: z.string().uuid(),
      data_object_name: z.string(),
      direction: PairFlowDirectionSchema,
    }),
  ),
  /** True when a data flow report goes to the owner; false when AECi decides it. */
  flows_decided_by_owner: z.boolean(),
});
export type SyncServiceRights = z.infer<typeof SyncServiceRightsSchema>;

// ─── The portal feed ─────────────────────────────────────────────────────────

/** What happened, from the recipient's seat. */
export const PAIR_RIGHT_NOTIFICATION_EVENTS = [
  'vetoed',
  'veto_withdrawn',
  'veto_lifted',
  'report_submitted',
  'report_withdrawn',
  'report_accepted',
  'report_declined',
  'protest_filed',
  'protest_decided',
] as const;
export const PairRightNotificationEventSchema = z.enum(PAIR_RIGHT_NOTIFICATION_EVENTS);
export type PairRightNotificationEvent = z.infer<typeof PairRightNotificationEventSchema>;

/**
 * One veto or report event addressed to this vendor (`kind: 'pair_right'`) on
 * `GET /api/vendor/notifications`. Written in the same batch as the write, as a
 * `notification.sent` audit row. `by_vendor_name` names the vendor that acted, or
 * `null` for AECi. `reason` is the veto's reason on a `vetoed` row to the owner, and
 * the admin's note on a lift; nothing else carries free text.
 */
export const VendorPairRightNotificationSchema = z.object({
  kind: z.literal('pair_right'),
  id: z.string().uuid(),
  event: PairRightNotificationEventSchema,
  integration_id: z.string().uuid(),
  integration_name: z.string().nullable(),
  report_kind: PairContestKindSchema.nullable(),
  by_vendor_name: z.string().nullable(),
  reason: z.string().nullable(),
  /** True on a veto event when the pair is on the public site after it. */
  pair_public: z.boolean().nullable(),
  pair_path: z.string().nullable(),
  created_at: z.string(),
});
export type VendorPairRightNotification = z.infer<typeof VendorPairRightNotificationSchema>;

/** The days a protest may be filed after a decline, and the silence that counts as one
 *  (§11b.12.2, unchanged). */
export const PAIR_PROTEST_WINDOW_DAYS = 30;

/**
 * When the submitter of a data flow report may protest, or `null`. The §11b.12.2 rule:
 * an owner-routed report the owner declined within the last 30 days, or that it left
 * open for 30 to 60 days. One protest per report.
 */
export function pairProtestWindow(
  row: {
    readonly kind: string;
    readonly routedTo: string;
    readonly ownerVendorId: string | null;
    readonly status: string;
    readonly decidedAt: string | null;
    readonly createdAt: string;
    readonly protestStatus: string | null;
  },
  now: Date,
): { basis: 'declined' | 'silence'; closesAt: string } | null {
  if (row.kind !== 'data_flow' || row.routedTo !== 'owner' || row.ownerVendorId === null) {
    return null;
  }
  if (row.protestStatus !== null) return null;
  const day = 24 * 60 * 60 * 1000;
  const t = now.getTime();
  if (row.status === 'declined' && row.decidedAt) {
    const opens = Date.parse(row.decidedAt);
    const closes = opens + PAIR_PROTEST_WINDOW_DAYS * day;
    return t >= opens && t < closes
      ? { basis: 'declined', closesAt: new Date(closes).toISOString() }
      : null;
  }
  if (row.status === 'open') {
    const filed = Date.parse(row.createdAt);
    const opens = filed + PAIR_PROTEST_WINDOW_DAYS * day;
    const closes = filed + 2 * PAIR_PROTEST_WINDOW_DAYS * day;
    return t >= opens && t < closes
      ? { basis: 'silence', closesAt: new Date(closes).toISOString() }
      : null;
  }
  return null;
}
