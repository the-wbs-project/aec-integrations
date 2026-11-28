import { z } from 'zod';

import { isHttpUrl } from './https-url-rule';
import {
  OBJECTION_EXPLANATION_MAX,
  OBJECTION_GROUNDS,
  OBJECTION_STATUSES,
  REMOVAL_END_REASONS,
  REMOVAL_REASON_CODES,
  REMOVAL_REASON_UNRECOGNISED,
} from './sync-service-removal';

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

/**
 * The §11b.12.8 time rules and evidence cap, applied to a data flow report's protest
 * (AECI-2110). They equal `CONTEST_PROTEST_REPLY_DAYS`, `CONTEST_PROTEST_COOLDOWN_DAYS`
 * and `CONTEST_PROTEST_MAX_EVIDENCE` in `integration-contests.ts`, which imports this
 * module, so they are restated here rather than imported (a cycle). A spec holds them
 * equal.
 */
export const PAIR_PROTEST_REPLY_DAYS = 14;
export const PAIR_PROTEST_COOLDOWN_DAYS = 90;
export const PAIR_PROTEST_MAX_EVIDENCE = 3;

/** Up to three absolute `http(s)` URLs on a protest or a reply. The server deduplicates
 *  them. The same rule as `ProtestEvidenceSchema`. */
export const PairProtestEvidenceSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(isHttpUrl, 'Each evidence link must be an absolute http(s) URL'),
  )
  .max(PAIR_PROTEST_MAX_EVIDENCE)
  .default([]);

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

export const RemovalReasonCodeSchema = z.enum(REMOVAL_REASON_CODES);
/** A reason code as a reader receives it: a fixed code, or `unrecognised` for a stored
 *  value outside the list. Reads only: a write takes {@link RemovalReasonCodeSchema}. */
export const RemovalReasonWireCodeSchema = z.union([
  RemovalReasonCodeSchema,
  z.literal(REMOVAL_REASON_UNRECOGNISED),
]);
export const ObjectionGroundSchema = z.enum(OBJECTION_GROUNDS);
export const RemovalEndReasonSchema = z.enum(REMOVAL_END_REASONS);
export const ObjectionStatusSchema = z.enum(OBJECTION_STATUSES);

/**
 * `POST /api/vendor/integrations/:id/veto`. Since AECI-2192 (ruling 66) the vendor picks
 * one reason from the fixed list. There is no free-text reason: the code is what the
 * Sync Service is told, and it is never public. Strict, so the old `reason` key is a 400.
 */
export const FileVetoSchema = z.object({ reason_code: RemovalReasonCodeSchema }).strict();
export type FileVetoInput = z.infer<typeof FileVetoSchema>;

/**
 * `POST /api/admin/vetoes/:id/lift`. Since AECI-2192 the lift names why the removal
 * ends (`end_reason`, the five cases of ruling 66) as well as a note. Both are
 * required and both go to the vendors.
 */
export const AdminLiftVetoSchema = z
  .object({ end_reason: RemovalEndReasonSchema, note: ReasonSchema })
  .strict();
export type AdminLiftVetoInput = z.infer<typeof AdminLiftVetoSchema>;

const HttpsUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((v) => v.startsWith('https://'), { message: 'An https link is required' });

/**
 * `POST /api/vendor/vetoes/:id/objections` (AECI-2192). The Sync Service objects on one
 * of three grounds, with an explanation. The "plainly false" ground also needs an https
 * link to the removing vendor's own public material.
 */
export const FileVetoObjectionSchema = z
  .object({
    ground: ObjectionGroundSchema,
    explanation: z.string().trim().min(1).max(OBJECTION_EXPLANATION_MAX),
    source_url: HttpsUrlSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ground === 'reason_plainly_false' && !value.source_url) {
      ctx.addIssue({
        code: 'custom',
        path: ['source_url'],
        message: 'A link to the vendor’s own public material is required',
      });
    }
  });
export type FileVetoObjectionInput = z.infer<typeof FileVetoObjectionSchema>;

/** `PATCH /api/admin/veto-objections/:id`. The note is required either way and goes to
 *  the vendors. An accept ends the removal with the objection's ground. */
export const AdminDecideVetoObjectionSchema = z
  .object({ decision: z.enum(['accept', 'decline']), note: ReasonSchema })
  .strict();
export type AdminDecideVetoObjectionInput = z.infer<typeof AdminDecideVetoObjectionSchema>;

/** The latest objection to a removal. Never public. */
export const VetoObjectionSchema = z.object({
  id: z.string().uuid(),
  ground: ObjectionGroundSchema,
  explanation: z.string(),
  source_url: z.string().nullable(),
  vendor_name: z.string().nullable(),
  status: ObjectionStatusSchema,
  decision_note: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
});
export type VetoObjection = z.infer<typeof VetoObjectionSchema>;

/** The answer of an objection write: the objection after it. */
export const VetoObjectionResponseSchema = z.object({ objection: VetoObjectionSchema });
export type VetoObjectionResponse = z.infer<typeof VetoObjectionResponseSchema>;

export const VetoEndedHowSchema = z.enum(['withdrawn', 'lifted']);

export const SyncServicePairVetoSchema = z.object({
  id: z.string().uuid(),
  pair: PairRightPairSchema,
  vendor_id: z.string().uuid().nullable(),
  vendor_name: z.string().nullable(),
  /** The fixed reason (AECI-2192). `null` on a removal filed before the fixed list.
   *  `unrecognised` on a stored code outside today's list. */
  reason_code: RemovalReasonWireCodeSchema.nullable(),
  /** The text on record. On a row with `reason_code` it is that code's English label.
   *  On an older row it is the vendor's own words, shown to the owner as recorded. */
  reason: z.string(),
  filed_at: z.string(),
  in_force: z.boolean(),
  ended_at: z.string().nullable(),
  ended_how: VetoEndedHowSchema.nullable(),
  /** Why AECi ended it (AECI-2192). `null` on a withdraw and on an older lift. */
  end_reason: RemovalEndReasonSchema.nullable(),
  /** An admin's lift note. Shown to the vetoing vendor and the owner. */
  end_note: z.string().nullable(),
  /** The latest objection, if any (AECI-2192). */
  objection: VetoObjectionSchema.nullable(),
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
  data: z.array(
    SyncServicePairVetoSchema.extend({
      owner_name: z.string().nullable(),
      /** When an open objection's answer is due: the moment its window of
       *  `OBJECTION_ANSWER_BUSINESS_DAYS` from `created_at` has fully passed. `null` when
       *  no objection is open. Admin only. */
      objection_answer_due: z.string().nullable(),
    }),
  ),
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
  .object({
    reason: z.string().trim().min(1).max(PAIR_PROTEST_REASON_MAX),
    evidence_urls: PairProtestEvidenceSchema,
  })
  .strict();
export type FilePairProtestInput = z.input<typeof FilePairProtestSchema>;

/** `POST /api/vendor/pair-contests/:id/protest/reply` (AECI-2110). The snapshot owner's
 *  one reply, before `reply_due_at`. */
export const ReplyPairProtestSchema = z
  .object({
    reply: z.string().trim().min(1).max(PAIR_PROTEST_REASON_MAX),
    evidence_urls: PairProtestEvidenceSchema,
  })
  .strict();
export type ReplyPairProtestInput = z.input<typeof ReplyPairProtestSchema>;

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
  /** AECI-2110. Default `[]` / `null` for deploy skew. */
  evidence_urls: z.array(z.string()).default([]),
  protested_at: z.string(),
  /** The owner's reply closes at this instant. `null` on a protest filed before
   *  AECI-2110, which had no reply step. */
  reply_due_at: z.string().nullable().default(null),
  reply: z.string().nullable().default(null),
  reply_evidence_urls: z.array(z.string()).default([]),
  replied_at: z.string().nullable().default(null),
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
  /** Submitted side only (AECI-2110): set on a rejected protest while it still bars a
   *  new data flow report on the same flow (§11b.12.8's cooldown). */
  cooldown_until: z.string().nullable().default(null),
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

/** `GET /api/admin/pair-contests?status=&protests=&retractions=`. */
export const ListAdminPairContestsQuerySchema = z.object({
  status: PairContestStatusSchema.default('open'),
  /** `true`: the open protests, whatever the report's status. */
  protests: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /** `true` (AECI-2170): accepted existence reports whose pair key still has a live
   *  row AEC Integrations holds, for retraction in the review app. Ignores `status`. */
  retractions: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/**
 * One row on a report's pair key (AECI-2170), on the ADMIN wire only: the connector and
 * both endpoints, either order, in both tables. `held` is who keeps the row: a vendor
 * (claimed, or added by a vendor), or AEC Integrations (promote writes it). An existence
 * accept retires every live vendor-held row; a live AECi-held row is retracted in the
 * review app. Vendor reads never carry it, so no vendor learns who owns another row.
 */
export const PairKeyRowWireSchema = z.object({
  id: z.string().uuid(),
  anchor: z.enum(['integration', 'evidenced_pair']),
  name: z.string().nullable(),
  owner_vendor_id: z.string().uuid().nullable(),
  owner_name: z.string().nullable(),
  held: z.enum(['vendor', 'aeci']),
  retired: z.boolean(),
});
export type PairKeyRowWire = z.infer<typeof PairKeyRowWireSchema>;

/** A report on the admin queue: the vendor shape plus the pair key's rows (AECI-2170). */
export const AdminPairContestSchema = PairContestSchema.extend({
  /** Every row on the pair key, on an existence report. `null` on a data flow report,
   *  and when the report's row is gone. */
  key_rows: z.array(PairKeyRowWireSchema).nullable(),
  /** On an accepted existence report with a live AECi-held row on its key: the moment
   *  the five business days to retract it have passed (`businessWindowEnd`). `null`
   *  otherwise. */
  retract_by: z.string().nullable(),
});
export type AdminPairContest = z.infer<typeof AdminPairContestSchema>;

export const AdminPairContestsResponseSchema = z.object({ data: z.array(AdminPairContestSchema) });
export type AdminPairContestsResponse = z.infer<typeof AdminPairContestsResponseSchema>;

/** `PATCH /api/admin/pair-contests/:id` answers the admin shape (AECI-2170). */
export const AdminPairContestResponseSchema = z.object({ contest: AdminPairContestSchema });
export type AdminPairContestResponse = z.infer<typeof AdminPairContestResponseSchema>;

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
  'protest_replied',
  'protest_withdrawn',
  'protest_decided',
  'objection_declined',
] as const;
export const PairRightNotificationEventSchema = z.enum(PAIR_RIGHT_NOTIFICATION_EVENTS);
export type PairRightNotificationEvent = z.infer<typeof PairRightNotificationEventSchema>;

/**
 * One veto or report event addressed to this vendor (`kind: 'pair_right'`) on
 * `GET /api/vendor/notifications`. Written in the same batch as the write, as a
 * `notification.sent` audit row. `by_vendor_name` names the vendor that acted, or
 * `null` for AECi. Since AECI-2192 a `vetoed` row to the owner carries the fixed
 * `reason_code` and no free text. `reason` is the admin's note on a lift and on an
 * `objection_declined` row, and an older removal's own words. Nothing else carries
 * free text.
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
  /** On a `vetoed` row to the owner: the vendor's fixed reason (AECI-2192), or
   *  `unrecognised` for a stored code outside today's list. */
  reason_code: RemovalReasonWireCodeSchema.nullable().optional(),
  /** On a `veto_lifted` row: why AECi ended the removal (AECI-2192). */
  end_reason: RemovalEndReasonSchema.nullable().optional(),
  /** True on a veto event when the pair is on the public site after it. */
  pair_public: z.boolean().nullable(),
  pair_path: z.string().nullable(),
  /** On a `protest_filed` row to the owner (AECI-2110): when its one reply closes. */
  reply_due_at: z.string().nullable().optional(),
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
