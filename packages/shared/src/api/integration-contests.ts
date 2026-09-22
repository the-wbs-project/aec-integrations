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

// ─── The per-field rule ──────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isHttpUrl(value: string): boolean {
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

// ─── Read shapes ─────────────────────────────────────────────────────────────

/** A vendor, as a contest names one. Not a `VendorLink`: no slug or logo is needed
 *  to render a contest, and a deleted vendor must still render by name. */
export const ContestVendorRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});
export type ContestVendorRef = z.infer<typeof ContestVendorRefSchema>;

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
  integration_id: z.string().uuid(),
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

// ─── Admin ───────────────────────────────────────────────────────────────────

/**
 * `GET /api/admin/contests`. Defaults to the AECi queue's open rows. `routed_to =
 * owner` shows the rows a vendor decides, read-only, so an operator can see a
 * dispute it does not own.
 */
export const ListAdminContestsQuerySchema = PageQuerySchema.extend({
  status: ContestStatusSchema.default('open'),
  routed_to: ContestRouteSchema.default('aeci'),
});
export type ListAdminContestsQuery = z.infer<typeof ListAdminContestsQuerySchema>;

/**
 * One contest as an operator sees it. `current_value` / `proposed_value` are in
 * STORAGE form, so `direction` reads `a_to_b | b_to_a | both` with A =
 * `source_product` and B = `target_product`.
 */
export const AdminContestSchema = z.object({
  id: z.string().uuid(),
  integration: z.object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    source_product: ProductLinkSchema,
    target_product: ProductLinkSchema,
    pair_path: z.string(),
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
});
export type AdminContest = z.infer<typeof AdminContestSchema>;

export const ListAdminContestsResponseSchema = paginatedResponseSchema(AdminContestSchema);
export type ListAdminContestsResponse = z.infer<typeof ListAdminContestsResponseSchema>;
