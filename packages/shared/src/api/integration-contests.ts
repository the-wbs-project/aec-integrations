import { z } from 'zod';

import { PageQuerySchema, ProductLinkSchema, paginatedResponseSchema } from './common';
import { ContextDirectionSchema, IntegrationMechanismKindSchema } from './integrations';

/**
 * Integration field contests (AECI-1008 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b).
 *
 * A seated endpoint vendor that does not own an integration can challenge one
 * field of it: "this is wrong, this is right, here is why". The contest routes to
 * the integration's owner when it is claimed, and to AECi otherwise.
 *
 *   POST /api/vendor/integrations/:id/contests   — submit (201).
 *   POST /api/vendor/evidenced-pairs/:id/contests — submit on an evidenced pair
 *                                                  (201, AECI-1092).
 *   GET  /api/vendor/contests                    — `{ submitted, received }`.
 *   POST /api/vendor/contests/:id/withdraw       — the submitter withdraws.
 *   POST /api/vendor/contests/:id/decision       — the owner accepts or declines.
 *   GET  /api/admin/contests                     — the AECi queue.
 *   PATCH /api/admin/contests/:id                — AECi accepts or declines.
 *
 * Four rules these schemas encode:
 *
 * 1. **No vendor id and no routing on any write shape.** Who may contest, and who
 *    decides, is derived server-side from `product_vendors` and
 *    `integrations.built_by_vendor_id`. The one client-supplied id that frames a
 *    write is `context_product_id`, and it only chooses the direction frame.
 * 2. **`direction` is caller-relative on the wire, canonical in the DB.** Every
 *    `direction` value on a vendor read is framed against that entry's
 *    `context_product`. The admin read carries the stored `a_to_b | b_to_a | both`
 *    plus both product names, because an operator has no frame.
 * 3. **`owner` values are vendor ids.** `null` as a PROPOSED owner means "neither
 *    endpoint vendor owns this". It is the only field where the proposal may be
 *    null. A proposed owner must be one of the integration's endpoint vendors; the
 *    server checks that, because the client cannot know the set.
 * 4. **Per-field validity is a business rule, not a shape rule.** The body shape
 *    (field name, reason, lengths) fails with a `400`; a value that is wrong for its
 *    field fails with a `422 CONTEST_INVALID_VALUE` naming `proposed_value`. The
 *    rule lives here in {@link contestValueProblem} so the portal form
 *    (`vendor-contest-form.ts`) runs the same check before it sends.
 *
 * i18n note: framework-agnostic package (no `$localize`). The messages below are
 * for API consumers and logs; the Angular surfaces render their own copy.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The twelve contestable fields: eleven `integrations` columns plus `owner`,
 * which names `built_by_vendor_id`. Mirrored by the D1 CHECK
 * `integration_field_challenges_field_check`; `integration-contests.spec.ts` in the
 * API Worker asserts the two agree.
 */
export const INTEGRATION_CONTEST_FIELDS = [
  'name',
  'mechanism_kind',
  'mechanism_name',
  'direction',
  'description',
  'listing_url',
  'docs_url',
  'website',
  'mechanism_url',
  'pricing_model',
  'maturity',
  'owner',
] as const;

export const IntegrationContestFieldSchema = z.enum(INTEGRATION_CONTEST_FIELDS);
export type IntegrationContestField = z.infer<typeof IntegrationContestFieldSchema>;

/**
 * What a contest sits on (AECI-1092 / §11b.13): an `integrations` row, or a
 * `connector_evidenced_pairs` row. On the wire a contest's `integration_id` is the
 * id of that row in either table, and `anchor` says which. Pair ids are unique
 * across both tables by construction (AECI-721 moves a row under its own id), so the
 * id alone never collides, but readers must not assume the `integrations` table.
 */
export const CONTEST_ANCHORS = ['integration', 'evidenced_pair'] as const;
export const ContestAnchorSchema = z.enum(CONTEST_ANCHORS);
export type ContestAnchorKind = z.infer<typeof ContestAnchorSchema>;

/**
 * The eleven fields a contest on an evidenced pair may name: every field above
 * except `mechanism_kind`, because `connector_evidenced_pairs` has no such column
 * (`DATABASE_SCHEMA.md` §9a.6). `direction` there is in the pair's canonical A/B
 * frame, which the vendor wire re-frames per caller exactly as it does for an
 * `integrations` row.
 */
export const EVIDENCED_PAIR_CONTEST_FIELDS = INTEGRATION_CONTEST_FIELDS.filter(
  (field) => field !== 'mechanism_kind',
) as readonly Exclude<IntegrationContestField, 'mechanism_kind'>[];

/** The fields a contest on this anchor may name, in the §11b.3 order. */
export function contestFieldsFor(anchor: ContestAnchorKind): readonly IntegrationContestField[] {
  return anchor === 'evidenced_pair' ? EVIDENCED_PAIR_CONTEST_FIELDS : INTEGRATION_CONTEST_FIELDS;
}

/** The four fields that must carry an absolute `http(s)` URL. */
export const CONTEST_URL_FIELDS: ReadonlySet<IntegrationContestField> =
  new Set<IntegrationContestField>(['listing_url', 'docs_url', 'website', 'mechanism_url']);

/** Per-field length ceilings. `description` matches the other long-text vendor
 *  fields (2,000); a URL gets the practical browser ceiling. */
export const CONTEST_VALUE_MAX_LENGTH: Readonly<Record<IntegrationContestField, number>> = {
  name: 200,
  mechanism_kind: 50,
  mechanism_name: 200,
  direction: 20,
  description: 2000,
  listing_url: 2048,
  docs_url: 2048,
  website: 2048,
  mechanism_url: 2048,
  pricing_model: 200,
  maturity: 200,
  owner: 36,
};

export const CONTEST_STATUSES = ['open', 'accepted', 'declined', 'withdrawn'] as const;
export const ContestStatusSchema = z.enum(CONTEST_STATUSES);
export type ContestStatus = z.infer<typeof ContestStatusSchema>;

/** Who decides. Fixed at submit and stored on the row (§11b routing). */
export const CONTEST_ROUTES = ['owner', 'aeci'] as const;
export const ContestRouteSchema = z.enum(CONTEST_ROUTES);
export type ContestRoute = z.infer<typeof ContestRouteSchema>;

export const CONTEST_DECISIONS = ['accept', 'decline'] as const;
export const ContestDecisionSchema = z.enum(CONTEST_DECISIONS);
export type ContestDecision = z.infer<typeof ContestDecisionSchema>;

// ─── Protests (AECI-1009 / §11b.12) ──────────────────────────────────────────

/**
 * A protest's own state, beside the contest's `status` on the same row. A
 * protested contest's `status` stays `declined`: the `status` CHECK is closed and
 * opening it would recreate the table. Mirrored by the column-level CHECK
 * `integration_field_challenges_protest_status_check` (migration 0047).
 */
export const CONTEST_PROTEST_STATUSES = ['open', 'upheld', 'rejected', 'withdrawn'] as const;
export const ContestProtestStatusSchema = z.enum(CONTEST_PROTEST_STATUSES);
export type ContestProtestStatus = z.infer<typeof ContestProtestStatusSchema>;

/** What a protest protests: the owner's decline, or 30 days of the owner's silence. */
export const CONTEST_PROTEST_BASES = ['declined', 'silence'] as const;
export const ContestProtestBasisSchema = z.enum(CONTEST_PROTEST_BASES);
export type ContestProtestBasis = z.infer<typeof ContestProtestBasisSchema>;

export const CONTEST_PROTEST_DECISIONS = ['uphold', 'reject'] as const;
export const ContestProtestDecisionSchema = z.enum(CONTEST_PROTEST_DECISIONS);
export type ContestProtestDecision = z.infer<typeof ContestProtestDecisionSchema>;

/** Days an owner-routed contest may go unanswered before silence counts as a decline. */
export const CONTEST_OWNER_SILENCE_DAYS = 30;
/** Days after a decline (or the silence-decline date) in which a protest may be filed. */
export const CONTEST_PROTEST_FILING_DAYS = 30;
/** Days the owner has to reply, from the protest. Stored on the row as a date. */
export const CONTEST_PROTEST_REPLY_DAYS = 14;
/** Days a lost protest blocks re-contesting the field, unless its value changes. */
export const CONTEST_PROTEST_COOLDOWN_DAYS = 90;
/** Evidence links a protest or a reply may carry. */
export const CONTEST_PROTEST_MAX_EVIDENCE = 3;

const DAY_MS = 86_400_000;

/** `iso` plus whole 24-hour days, as an ISO string. No calendar, no time zone. */
export function addContestDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

/** The fields of a contest row the protest window depends on. */
export interface ContestProtestWindowInput {
  routed_to: string;
  owner_vendor_id: string | null;
  status: string;
  protest_status: string | null;
  created_at: string;
  decided_at: string | null;
}

/**
 * When a protest on this contest can be filed, ignoring the live-state checks
 * (owner and value unchanged), or `null` when it never can.
 *
 * - `declined`: an owner decline. Opens at `decided_at`, closes 30 days later.
 * - `silence`: an owner-routed contest still open. Silence counts as a decline on
 *   day 30 after `created_at` (the silence-decline date), and the 30-day filing
 *   window runs from there, so it closes on day 60.
 *
 * Both windows are half-open: protestable while `opens_at <= now < closes_at`.
 */
export function contestProtestWindow(
  row: ContestProtestWindowInput,
): { basis: ContestProtestBasis; opens_at: string; closes_at: string } | null {
  if (row.routed_to !== 'owner' || row.owner_vendor_id === null) return null;
  if (row.protest_status !== null) return null;
  if (row.status === 'declined' && row.decided_at) {
    return {
      basis: 'declined',
      opens_at: row.decided_at,
      closes_at: addContestDays(row.decided_at, CONTEST_PROTEST_FILING_DAYS),
    };
  }
  if (row.status === 'open') {
    const silenceAt = addContestDays(row.created_at, CONTEST_OWNER_SILENCE_DAYS);
    return {
      basis: 'silence',
      opens_at: silenceAt,
      closes_at: addContestDays(silenceAt, CONTEST_PROTEST_FILING_DAYS),
    };
  }
  return null;
}

/** Where `now` falls in a protest window. ISO strings compare by instant. */
export function contestProtestPhase(
  window: { opens_at: string; closes_at: string },
  now: string,
): 'not_yet' | 'open' | 'closed' {
  const at = Date.parse(now);
  if (at < Date.parse(window.opens_at)) return 'not_yet';
  if (at >= Date.parse(window.closes_at)) return 'closed';
  return 'open';
}

// ─── The per-field rule ──────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Why `value` is not a valid proposal for `field`, or `null` when it is.
 *
 * `value` is the WIRE form: `direction` is caller-relative
 * (`inbound | outbound | both`) and `owner` is a vendor id or `null`. Whether a
 * proposed owner is one of THIS integration's endpoint vendors is a server-side
 * check, because only the server knows the set.
 */
export function contestValueProblem(
  field: IntegrationContestField,
  value: string | null,
): string | null {
  if (value === null) {
    return field === 'owner' ? null : 'A proposed value is required for this field';
  }
  if (value.length === 0) return 'A proposed value is required for this field';
  if (value.length > CONTEST_VALUE_MAX_LENGTH[field]) {
    return `The proposed value is longer than ${CONTEST_VALUE_MAX_LENGTH[field]} characters`;
  }
  if (CONTEST_URL_FIELDS.has(field) && !isHttpUrl(value)) {
    return 'The proposed value must be an absolute http(s) URL';
  }
  if (field === 'mechanism_kind' && !IntegrationMechanismKindSchema.safeParse(value).success) {
    return `The proposed value must be one of: ${IntegrationMechanismKindSchema.options.join(', ')}`;
  }
  if (field === 'direction' && !ContextDirectionSchema.safeParse(value).success) {
    return 'The proposed value must be one of: inbound, outbound, both';
  }
  if (field === 'owner' && !UUID_RE.test(value)) {
    return 'The proposed owner must be a vendor id';
  }
  return null;
}

// ─── Write shapes ────────────────────────────────────────────────────────────

const contestText = z.string().trim().min(1).max(2000);

/**
 * `POST /api/vendor/integrations/:id/contests`.
 *
 * `proposed_value` is trimmed and otherwise free here; {@link contestValueProblem}
 * is the per-field rule the handler applies next. `context_product_id` names which
 * of the caller's endpoints a `direction` proposal is relative to. It is optional,
 * and omitted keeps the endpoint-A-first default `POST /api/vendor/claims` uses.
 */
export const SubmitIntegrationContestSchema = z.object({
  field: IntegrationContestFieldSchema,
  proposed_value: z.string().trim().max(2048).nullable(),
  reason: contestText,
  context_product_id: z.string().uuid().nullable().optional(),
});
export type SubmitIntegrationContestInput = z.infer<typeof SubmitIntegrationContestSchema>;

/** `POST /api/vendor/contests/:id/decision` and `PATCH /api/admin/contests/:id`. */
export const DecideContestSchema = z.object({
  decision: ContestDecisionSchema,
  note: contestText.nullable().optional(),
});
export type DecideContestInput = z.infer<typeof DecideContestSchema>;

/** Up to three absolute `http(s)` URLs. The server deduplicates them. */
export const ProtestEvidenceSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(isHttpUrl, 'Each evidence link must be an absolute http(s) URL'),
  )
  .max(CONTEST_PROTEST_MAX_EVIDENCE)
  .default([]);

/** `POST /api/vendor/contests/:id/protest`. The proposal is not in the body: it
 *  stays frozen at what the owner declined. */
export const FileContestProtestSchema = z.object({
  reason: contestText,
  evidence_urls: ProtestEvidenceSchema,
});
export type FileContestProtestInput = z.input<typeof FileContestProtestSchema>;

/** `POST /api/vendor/contests/:id/protest/reply`. Once per protest. */
export const ReplyContestProtestSchema = z.object({
  reply: contestText,
  evidence_urls: ProtestEvidenceSchema,
});
export type ReplyContestProtestInput = z.input<typeof ReplyContestProtestSchema>;

/** `PATCH /api/admin/contests/:id/protest`. The note is REQUIRED: an advisory
 *  ruling's reasons are the whole of what it gives either vendor. */
export const DecideContestProtestSchema = z.object({
  decision: ContestProtestDecisionSchema,
  note: contestText,
});
export type DecideContestProtestInput = z.infer<typeof DecideContestProtestSchema>;

// ─── Read shapes ─────────────────────────────────────────────────────────────

/** A vendor, as a contest names one. Not a `VendorLink`: no slug or logo is needed
 *  to render a contest, and a deleted vendor must still render by name. */
export const ContestVendorRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type ContestVendorRef = z.infer<typeof ContestVendorRefSchema>;

/**
 * A protest as either vendor and AECi see it (§11b.12.9). Both vendors see the
 * whole record, including each other's text and evidence. No profile id is sent.
 */
export const ContestProtestSchema = z.object({
  status: ContestProtestStatusSchema,
  basis: ContestProtestBasisSchema,
  reason: z.string(),
  evidence_urls: z.array(z.string()),
  protested_at: z.string(),
  reply_due_at: z.string(),
  reply: z.string().nullable(),
  reply_evidence_urls: z.array(z.string()),
  replied_at: z.string().nullable(),
  decision_note: z.string().nullable(),
  decided_at: z.string().nullable(),
});
export type ContestProtest = z.infer<typeof ContestProtestSchema>;

/**
 * One contest as a vendor sees it, either side.
 *
 * `context_product` is the caller's own endpoint when it owns one (endpoint A
 * first), and endpoint A otherwise. Every `direction` value below is framed
 * against it. `current_label` / `proposed_label` carry a display name for the
 * `owner` field (the vendor's name) and are `null` for every other field.
 */
export const VendorContestSchema = z.object({
  id: z.string().uuid(),
  /** The anchor row's id, in whichever table `anchor` names (AECI-1092). */
  integration_id: z.string().uuid(),
  /** AECI-1092. Defaulted for deploy skew: every earlier contest is an integration's. */
  anchor: ContestAnchorSchema.default('integration'),
  integration_name: z.string().nullable(),
  context_product: ProductLinkSchema,
  other_product: ProductLinkSchema,
  field: IntegrationContestFieldSchema,
  current_value: z.string().nullable(),
  proposed_value: z.string().nullable(),
  current_label: z.string().nullable(),
  proposed_label: z.string().nullable(),
  reason: z.string(),
  routed_to: ContestRouteSchema,
  status: ContestStatusSchema,
  submitter_vendor: ContestVendorRefSchema,
  owner_vendor: ContestVendorRefSchema.nullable(),
  decision_note: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** AECI-1009. The protest on this contest, on both sides. Defaulted for skew. */
  protest: ContestProtestSchema.nullable().default(null),
  /**
   * Submitted side only. The protest window (§11b.12.8) while this contest has
   * no protest and passes every other check (owner-routed, the same owner still
   * holds the claimed row, the value on record unchanged). `opens_at` may be in
   * the future (an open contest before day 30). Both `null` means the contest is
   * not protestable and will not become so by waiting.
   */
  protest_opens_at: z.string().nullable().default(null),
  protest_closes_at: z.string().nullable().default(null),
  protest_basis: ContestProtestBasisSchema.nullable().default(null),
  /** Submitted side only. Set while this row's lost protest blocks a new contest
   *  on the field (§11b.12.8). */
  cooldown_until: z.string().nullable().default(null),
});
export type VendorContest = z.infer<typeof VendorContestSchema>;

/**
 * `GET /api/vendor/contests`. `submitted` is what the caller's vendor filed;
 * `received` is what routes to it as the integration's owner. Newest first, each
 * list capped at {@link VENDOR_CONTEST_LIST_CAP}. A row appears in both lists only
 * if a vendor contests an integration it owns, which the submit path refuses.
 */
export const ListVendorContestsResponseSchema = z.object({
  submitted: z.array(VendorContestSchema),
  received: z.array(VendorContestSchema),
});
export type ListVendorContestsResponse = z.infer<typeof ListVendorContestsResponseSchema>;

/** Rows per list on `GET /api/vendor/contests`. A working list, not an archive. */
export const VENDOR_CONTEST_LIST_CAP = 100;

/** Every vendor contest write echoes the row's post-write state. */
export const VendorContestResponseSchema = z.object({ contest: VendorContestSchema });
export type VendorContestResponse = z.infer<typeof VendorContestResponseSchema>;

/**
 * The per-integration current values `GET /api/vendor/integrations` carries, so the
 * portal can prefill a contest. `direction` is framed against the entry's
 * `context_product`; `owner` is the owner's vendor id.
 */
export const ContestableFieldsSchema = z.record(
  IntegrationContestFieldSchema,
  z.string().nullable(),
);
export type ContestableFields = z.infer<typeof ContestableFieldsSchema>;

/** An all-`null` value set, the skew default for {@link ContestableFieldsSchema}. */
export const EMPTY_CONTESTABLE_FIELDS: ContestableFields = Object.fromEntries(
  INTEGRATION_CONTEST_FIELDS.map((field) => [field, null]),
) as ContestableFields;

/**
 * One connector-evidenced pair as the portal needs it to file a contest on it
 * (AECI-1092), carried on `GET /api/vendor/products/:id/connectors` beside each
 * `delivered` row. It is the evidenced-pair counterpart of the contest fields
 * `GET /api/vendor/integrations` carries per integration, framed the same way:
 * `context_product` is the owned product the connectors section is about, and
 * `contestable_fields.direction` is relative to it. `contestable_fields.mechanism_kind`
 * is always `null`: the column does not exist on the table, and the field is not
 * contestable there (`EVIDENCED_PAIR_CONTEST_FIELDS`). `is_owner` is true when the caller's vendor is the pair's
 * recorded owner, which may not contest it (§11b.2).
 */
export const EvidencedPairContestTargetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  context_product: ProductLinkSchema,
  other_product: ProductLinkSchema,
  connector: ProductLinkSchema,
  contestable_fields: ContestableFieldsSchema,
  endpoint_vendors: z.array(ContestVendorRefSchema),
  owner: ContestVendorRefSchema.nullable(),
  is_owner: z.boolean(),
  retired: z.boolean(),
});
export type EvidencedPairContestTarget = z.infer<typeof EvidencedPairContestTargetSchema>;

// ─── Admin ───────────────────────────────────────────────────────────────────

/**
 * `GET /api/admin/contests`. Defaults to the AECi queue's open rows. `routed_to =
 * owner` shows the rows a vendor decides, read-only, so an operator can see a
 * dispute it does not own.
 */
export const ListAdminContestsQuerySchema = PageQuerySchema.extend({
  status: ContestStatusSchema.default('open'),
  routed_to: ContestRouteSchema.default('aeci'),
  /**
   * AECI-1009. When present the list is the Protests view: it filters on
   * `protest_status` alone and ignores `status` and `routed_to` (every protested
   * row is `declined` and owner-routed), newest protest first.
   */
  protest_status: ContestProtestStatusSchema.optional(),
});
export type ListAdminContestsQuery = z.infer<typeof ListAdminContestsQuerySchema>;

/**
 * One contest as an operator sees it. `current_value` / `proposed_value` are in
 * STORAGE form, so `direction` reads `a_to_b | b_to_a | both` with A =
 * `source_product` and B = `target_product`.
 */
export const AdminContestSchema = z.object({
  id: z.string().uuid(),
  /**
   * The row the contest sits on. On an evidenced pair (`anchor = 'evidenced_pair'`,
   * AECI-1092) `source_product` is endpoint A and `target_product` endpoint B of the
   * canonical order, which is the frame a stored `direction` is in, and `connector`
   * names the product that delivers the pair. Both default for deploy skew.
   */
  integration: z.object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    source_product: ProductLinkSchema,
    target_product: ProductLinkSchema,
    pair_path: z.string(),
    anchor: ContestAnchorSchema.default('integration'),
    connector: ProductLinkSchema.nullable().default(null),
  }),
  field: IntegrationContestFieldSchema,
  current_value: z.string().nullable(),
  proposed_value: z.string().nullable(),
  current_label: z.string().nullable(),
  proposed_label: z.string().nullable(),
  /**
   * The field's value on the row NOW, in storage form (AECI-1006), beside
   * `current_value`, which is the value recorded at submit. `live_label` is the
   * vendor name for an `owner` value. Defaulted for deploy skew.
   */
  live_value: z.string().nullable().default(null),
  live_label: z.string().nullable().default(null),
  /**
   * True when an accept would be refused with `409 CONTEST_VALUE_STALE`: a content
   * contest on a claimed row whose live value differs from `current_value`. The
   * server computes it with the same rule the accept enforces.
   */
  value_stale: z.boolean().default(false),
  reason: z.string(),
  routed_to: ContestRouteSchema,
  status: ContestStatusSchema,
  submitter_vendor: ContestVendorRefSchema,
  owner_vendor: ContestVendorRefSchema.nullable(),
  decision_note: z.string().nullable(),
  decided_at: z.string().nullable(),
  upstream_linear_issue_id: z.string().nullable(),
  upstream_linear_issue_url: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** AECI-1009. Defaulted for deploy skew. */
  protest: ContestProtestSchema.nullable().default(null),
  /** True when the integration is no longer claimed by `owner_vendor.id`. */
  owner_changed: z.boolean().default(false),
});
export type AdminContest = z.infer<typeof AdminContestSchema>;

export const ListAdminContestsResponseSchema = paginatedResponseSchema(AdminContestSchema);
export type ListAdminContestsResponse = z.infer<typeof ListAdminContestsResponseSchema>;
