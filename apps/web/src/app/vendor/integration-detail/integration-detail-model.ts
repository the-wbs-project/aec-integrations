import type {
  ContextDirection,
  IntegrationContestField,
  IntegrationEditField,
  IntegrationMechanismKind,
  ListVendorContestsResponse,
  VendorClaim,
  VendorContest,
  VendorIntegration,
} from '@aeci/shared';

import { noteAudienceHint } from '../components/vendor-attestation-labels';

/**
 * The rules behind the integration detail page (AECI-1149 to AECI-1153,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17): which status an integration is in, what
 * "Things that need you" lists, and the plain-language copy of §6.17.8.
 *
 * Pure functions over the wire shape. The list on the Integrations tab and the
 * page both read {@link integrationStatus}, so the two can never name one state
 * two ways (§6.17.1).
 *
 * ── NOTHING HERE RE-DERIVES AGREEMENT ───────────────────────────────────────
 * `claim.agreement` and `claim.disagreement` are read verbatim. A "disagreement"
 * is a claim whose agreement is `conflict`, never a comparison of the two
 * stances. §6.17.2: "derived from the wire only, never re-derived agreement".
 *
 * ── COPY ────────────────────────────────────────────────────────────────────
 * The page never says attestation, claim, provenance, data object, contest,
 * counterparty, mechanism or iPaaS (§6.17.8). It says "Company", not "vendor".
 * Sentence case, no em dashes, and no arrow glyph outside a data direction
 * (DESIGN.md, "The Arrow Rule"): a change is "from X to Y" in words.
 */

// ─── Anchors ─────────────────────────────────────────────────────────────────

/** The five section ids, in page order. `…/integrations/:id#change-requests`
 *  deep-links, and `InitialFragmentScroller` covers the first load. */
export const SECTION_IDS = [
  'overview',
  'data-shared',
  'links',
  'change-requests',
  'settings',
] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export function isSectionId(value: string): value is SectionId {
  return (SECTION_IDS as readonly string[]).includes(value);
}

/** A row of the Overview or the links section. */
export function rowTargetId(key: string): string {
  return `row-${key}`;
}

/** A row of "Data that's shared". */
export function dataRowId(claimId: string): string {
  return `data-${claimId}`;
}

/** One change request item. */
export function contestItemId(contestId: string): string {
  return `request-${contestId}`;
}

/** A disagreement item. The claim id is the disagreement id (`API_CONTRACTS.md` §6.14). */
export function disagreementItemId(claimId: string): string {
  return `disagreement-${claimId}`;
}

/** An added-row item, either side. */
export function addedItemId(claimId: string): string {
  return `added-${claimId}`;
}

// ─── Dates ───────────────────────────────────────────────────────────────────

const DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Sep 22, 2026". UTC, so SSR and the browser print the same day. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DAY.format(date);
}

// ─── Who is who ──────────────────────────────────────────────────────────────

/** Whether the caller holds both endpoints: one company, one voter, nobody to ask. */
export function ownsBoth(integration: Pick<VendorIntegration, 'slots'>): boolean {
  return integration.slots.length === 2;
}

/**
 * The other company's name: an endpoint vendor that is not the caller's. `null`
 * when the wire names none (an older API, or an endpoint with no vendor on
 * file), and copy then says "the other company".
 */
export function otherCompanyName(
  integration: Pick<VendorIntegration, 'endpoint_vendors' | 'slots'>,
  myVendorId: string | null,
): string | null {
  if (ownsBoth(integration)) return null;
  return integration.endpoint_vendors.find((v) => v.id !== myVendorId)?.name ?? null;
}

/** "{Company}" or "The other company", at the start of a sentence. */
export function companyOrFallback(name: string | null): string {
  return name ?? $localize`:@@vendor.im.company.fallback:The other company`;
}

/** "{Company}" or "the other company", mid-sentence. */
export function companyMidSentence(name: string | null): string {
  return name ?? $localize`:@@vendor.im.company.fallbackMid:the other company`;
}

/** "Procore's", "Summit BIM's". A name ending in s takes a bare apostrophe. */
export function possessive(name: string): string {
  return name.endsWith('s') ? `${name}’` : `${name}’s`;
}

// ─── Contests on this integration ────────────────────────────────────────────

/** A contest that still needs someone: open, or declined with an open protest. */
export function isContestOpen(contest: Pick<VendorContest, 'status' | 'protest'>): boolean {
  return contest.status === 'open' || contest.protest?.status === 'open';
}

/** The caller's open submitted request on one field, if any. */
export function openSubmittedOn(
  contests: ListVendorContestsResponse,
  field: IntegrationContestField,
): VendorContest | null {
  return contests.submitted.find((c) => c.field === field && isContestOpen(c)) ?? null;
}

/** An open request the caller is party to on one field: submitted, or received as
 *  owner. The Overview's flag (§6.17.3). */
export function openRequestOn(
  contests: ListVendorContestsResponse,
  field: IntegrationContestField,
): VendorContest | null {
  return (
    openSubmittedOn(contests, field) ??
    contests.received.find((c) => c.field === field && isContestOpen(c)) ??
    null
  );
}

/** Narrow a vendor-wide contests payload to one anchor row. The list uses the
 *  store's vendor-wide read; the page reads its own filtered one. */
export function contestsFor(
  contests: ListVendorContestsResponse,
  integrationId: string,
): ListVendorContestsResponse {
  return {
    submitted: contests.submitted.filter((c) => c.integration_id === integrationId),
    received: contests.received.filter((c) => c.integration_id === integrationId),
  };
}

// ─── Claims ──────────────────────────────────────────────────────────────────

export function isLive(integration: Pick<VendorIntegration, 'retired_at'>): boolean {
  return !integration.retired_at;
}

/** A row the other company added that the caller has not answered, on an
 *  attestable, live row (`API_CONTRACTS.md` §6.14). */
export function isCounterpartAddedUnanswered(
  integration: VendorIntegration,
  claim: VendorClaim,
): boolean {
  return (
    claim.added_by === 'counterpart' &&
    claim.mine.length === 0 &&
    integration.attestable &&
    isLive(integration)
  );
}

/** A row the caller added that the other company has not answered. Never on an
 *  owns-both row: there is nobody to wait for. */
export function isAddedByYouWaiting(integration: VendorIntegration, claim: VendorClaim): boolean {
  return (
    claim.added_by === 'you' &&
    claim.counterparty === null &&
    !ownsBoth(integration) &&
    integration.attestable &&
    isLive(integration)
  );
}

/** Whether the caller's own live answer carries a note. */
export function myNote(claim: VendorClaim): string | null {
  const note = claim.mine.find((m) => m.note && m.note.trim() !== '')?.note ?? null;
  return note && note.trim() !== '' ? note : null;
}

/** Disagreements: claims whose agreement is `conflict`, on a live, attestable row. */
export function disagreements(integration: VendorIntegration): readonly VendorClaim[] {
  if (!isLive(integration) || !integration.attestable) return [];
  return integration.claims.filter((c) => c.agreement === 'conflict');
}

/** Rows waiting on the caller's answer, other than counterpart-added rows and
 *  disagreements. */
export function rowsNeedingAnswer(integration: VendorIntegration): readonly VendorClaim[] {
  if (!isLive(integration) || !integration.attestable) return [];
  return integration.claims.filter(
    (c) => c.mine.length === 0 && c.added_by !== 'counterpart' && c.agreement !== 'conflict',
  );
}

/**
 * The version stamps a `PUT` must re-send so an answer does not erase them
 * (§6.17.4, `STAGE_2_ATTESTATIONS_SPEC.md` §5.4). The caller's own row for the
 * context product's slot. On an owns-both row the wire does not say which slot is
 * the context's, so the stamped row wins: a stamp on the other slot is lost, which
 * §6.17.4 accepts for v1.
 */
export function stampsToKeep(
  integration: Pick<VendorIntegration, 'slots'>,
  claim: VendorClaim,
): { introduced_version_id: string | null; deprecated_version_id: string | null } {
  const own =
    integration.slots.length === 1
      ? (claim.mine.find((m) => m.slot === integration.slots[0]) ?? claim.mine[0])
      : (claim.mine.find((m) => m.introduced_version_id || m.deprecated_version_id) ??
        claim.mine[0]);
  return {
    introduced_version_id: own?.introduced_version_id ?? null,
    deprecated_version_id: own?.deprecated_version_id ?? null,
  };
}

// ─── Status (§6.17.2) ────────────────────────────────────────────────────────

export const INTEGRATION_STATUS_KEYS = [
  'retired',
  'disagreement',
  'needs_answer',
  'needs_decision',
  'ready_to_claim',
  'no_owner',
  'waiting',
  'connector',
  'up_to_date',
] as const;
export type IntegrationStatusKey = (typeof INTEGRATION_STATUS_KEYS)[number];

export type Tone = 'ok' | 'attention' | 'conflict' | 'neutral';

export interface StatusContext {
  /** The integration's contests, both sides, already narrowed to it. */
  readonly contests: ListVendorContestsResponse;
  /** Whether the caller may claim a row it owns: an ordinary row always, a
   *  connector-powered one only with an active plan (§4.5.2). */
  readonly entitled: boolean;
  /** Holds `attestation.author` (AECI-623). Without it every Yes and No is
   *  disabled, so nothing may ask for an answer (the overview's `canAttest` rule). */
  readonly canAuthor: boolean;
  /** ISO now, for a protest reply that is still due. */
  readonly now: string;
}

/** Whether a claim is allowed here (§6.17.2, "You can claim this integration"). */
export function canClaim(integration: VendorIntegration, entitled: boolean): boolean {
  return (
    integration.is_owner &&
    integration.claimed_at === null &&
    isLive(integration) &&
    (integration.attestable || entitled)
  );
}

/** The caller's open request on the `owner` field, if any (AECI-1143). */
export function openOwnerRequest(contests: ListVendorContestsResponse): VendorContest | null {
  return openSubmittedOn(contests, 'owner');
}

/**
 * The one status of an integration, the first that applies (§6.17.2).
 *
 * One deviation, recorded in the PR: `ready_to_claim` also requires that a claim
 * is allowed. On a connector-powered row with no active plan there is no Claim
 * button, so "Ready to claim" would ask for something the page cannot do. That row
 * falls through to the next state that applies.
 */
export function integrationStatus(
  integration: VendorIntegration,
  ctx: StatusContext,
): IntegrationStatusKey {
  if (integration.retired_at) return 'retired';
  if (integration.claims.some((c) => c.agreement === 'conflict')) return 'disagreement';
  const answerable = integration.attestable && ctx.canAuthor;
  if (answerable && rowsNeedingAnswer(integration).length > 0) return 'needs_answer';
  const receivedOpen = ctx.contests.received.some(
    (c) => c.status === 'open' || protestReplyDue(c, ctx.now),
  );
  const addedUnanswered =
    answerable && integration.claims.some((c) => isCounterpartAddedUnanswered(integration, c));
  if (receivedOpen || addedUnanswered) return 'needs_decision';
  if (canClaim(integration, ctx.entitled)) return 'ready_to_claim';
  if (integration.owner === null && openOwnerRequest(ctx.contests) === null) return 'no_owner';
  if (ctx.contests.submitted.some(isContestOpen)) return 'waiting';
  if (!integration.attestable) return 'connector';
  return 'up_to_date';
}

export function statusTone(key: IntegrationStatusKey): Tone {
  switch (key) {
    case 'disagreement':
      return 'conflict';
    case 'needs_answer':
    case 'needs_decision':
    case 'ready_to_claim':
    case 'no_owner':
      return 'attention';
    case 'up_to_date':
      return 'ok';
    default:
      return 'neutral';
  }
}

/** Who an open submitted request waits on: the owner, or AEC Integrations while
 *  the request routes there or a protest is open. */
export function waitingOn(contest: VendorContest): string | null {
  if (contest.routed_to === 'aeci' || contest.protest?.status === 'open') return null;
  return contest.owner_vendor?.name ?? null;
}

/** The pill's text. `waiting` names who, when the page knows. */
export function statusLabel(
  key: IntegrationStatusKey,
  contests?: ListVendorContestsResponse,
): string {
  switch (key) {
    case 'retired':
      return $localize`:@@vendor.im.status.retired:Retired`;
    case 'disagreement':
      return $localize`:@@vendor.im.status.disagreement:Disagreement open`;
    case 'needs_answer':
      return $localize`:@@vendor.im.status.needsAnswer:Needs your answer`;
    case 'needs_decision':
      return $localize`:@@vendor.im.status.needsDecision:Needs your decision`;
    case 'ready_to_claim':
      return $localize`:@@vendor.im.status.readyToClaim:Ready to claim`;
    case 'no_owner':
      return $localize`:@@vendor.im.status.noOwner:No owner yet`;
    case 'waiting': {
      const open = contests?.submitted.find(isContestOpen);
      const owner = open ? waitingOn(open) : null;
      return owner
        ? $localize`:@@vendor.im.status.waitingOn:Waiting on ${owner}:owner:`
        : $localize`:@@vendor.im.status.waitingAeci:Waiting on AEC Integrations`;
    }
    case 'connector':
      return $localize`:@@vendor.im.status.connector:AEC Integrations maintained`;
    case 'up_to_date':
      return $localize`:@@vendor.im.status.upToDate:All up to date`;
  }
}

/** The filter chip's text on the list, where no one integration is named. */
export function statusChipLabel(key: IntegrationStatusKey): string {
  return key === 'waiting'
    ? $localize`:@@vendor.im.status.chip.waiting:Waiting on others`
    : statusLabel(key);
}

/** What the status means, for its tooltip. */
export function statusExplain(key: IntegrationStatusKey, integration: VendorIntegration): string {
  switch (key) {
    case 'retired':
      return integration.retired_by === 'aeci'
        ? $localize`:@@vendor.im.status.explain.retiredAeci:AEC Integrations retired it. It is hidden from the public page and from search.`
        : $localize`:@@vendor.im.status.explain.retired:It is hidden from the public page and from search. Only its owner can restore it, from Settings.`;
    case 'disagreement':
      return $localize`:@@vendor.im.status.explain.disagreement:You and the other company answer a row of data differently. It is open in Change requests.`;
    case 'needs_answer':
      return $localize`:@@vendor.im.status.explain.needsAnswer:At least one row of data needs a Yes or a No from you.`;
    case 'needs_decision':
      return $localize`:@@vendor.im.status.explain.needsDecision:Another company asked you to decide something. It is open in Change requests.`;
    case 'ready_to_claim':
      return $localize`:@@vendor.im.status.explain.readyToClaim:Your company is recorded as the owner. Claim it to edit its details yourself.`;
    case 'no_owner':
      return $localize`:@@vendor.im.status.explain.noOwner:No company is recorded as the owner. If your company offers it, ask to be recorded as the owner.`;
    case 'waiting':
      return $localize`:@@vendor.im.status.explain.waiting:You asked for a correction and it is being reviewed. Nothing else needs you.`;
    case 'connector':
      return $localize`:@@vendor.im.status.explain.connector:It runs through a connector service, so AEC Integrations keeps its data up to date.`;
    case 'up_to_date':
      return $localize`:@@vendor.im.status.explain.upToDate:Nothing needs you right now.`;
  }
}

/**
 * `?status=` on the list. The keys are the §6.17.2 set. An old §6.3 value maps
 * to its nearest key rather than to an empty list (§6.17.1). Anything else is
 * "all".
 */
export function statusFromParam(value: string | null): IntegrationStatusKey | 'all' {
  if (!value) return 'all';
  if (value === 'conflict') return 'disagreement';
  if (value === 'needs_you') return 'needs_answer';
  if (value === 'confirmed' || value === 'responded') return 'up_to_date';
  if (value === 'empty') return 'up_to_date';
  return (INTEGRATION_STATUS_KEYS as readonly string[]).includes(value)
    ? (value as IntegrationStatusKey)
    : 'all';
}

// ─── Field labels (§6.17.8) ──────────────────────────────────────────────────

/** A field's name on this page. Not `contestFieldLabel`: the Messages tab still
 *  says "Integration type" and "Maturity", and §6.17.8's copy table does not. */
export function pageFieldLabel(field: IntegrationContestField | IntegrationEditField): string {
  switch (field) {
    case 'name':
      return $localize`:@@vendor.im.field.name:Name`;
    case 'description':
      return $localize`:@@vendor.im.field.description:Description`;
    case 'mechanism_kind':
      return $localize`:@@vendor.im.field.mechanismKind:How you get it`;
    case 'mechanism_name':
      return $localize`:@@vendor.im.field.mechanismName:Connection name`;
    case 'maturity':
      return $localize`:@@vendor.im.field.maturity:Release stage`;
    case 'pricing_model':
      return $localize`:@@vendor.im.field.pricingModel:Pricing`;
    case 'pricing_url':
      return $localize`:@@vendor.im.field.pricingUrl:Pricing page`;
    case 'listing_url':
      return $localize`:@@vendor.im.field.listingUrl:Listing page`;
    case 'docs_url':
      return $localize`:@@vendor.im.field.docsUrl:Documentation`;
    case 'owner':
      return $localize`:@@vendor.im.field.owner:Owner`;
    case 'direction':
      return $localize`:@@vendor.im.field.direction:Direction`;
    case 'website':
      return $localize`:@@vendor.im.field.website:Website`;
    case 'mechanism_url':
      return $localize`:@@vendor.im.field.mechanismUrl:Connection link`;
  }
}

/** The label lowercased for use mid-sentence ("asked to change release stage"). */
export function pageFieldLabelMid(field: IntegrationContestField): string {
  return pageFieldLabel(field).toLocaleLowerCase('en');
}

/** "How you get it", by value (§6.17.8). */
export function howYouGetIt(
  kind: IntegrationMechanismKind | string | null,
  connectorName: string | null,
): string {
  switch (kind) {
    case 'native':
      return $localize`:@@vendor.im.how.native:Built into the product`;
    case 'marketplace-app':
      return $localize`:@@vendor.im.how.marketplace:Marketplace app`;
    case 'api':
      return $localize`:@@vendor.im.how.api:Direct connection`;
    case 'iPaaS':
      return connectorName
        ? $localize`:@@vendor.im.how.connector:Through ${connectorName}:connector:`
        : $localize`:@@vendor.im.how.connectorUnnamed:Through a connector service`;
    case 'webhook':
      return $localize`:@@vendor.im.how.webhook:Webhook`;
    case 'partner':
      return $localize`:@@vendor.im.how.partner:Partner integration`;
    case 'integrator':
      return $localize`:@@vendor.im.how.integrator:Built by a consultancy`;
    default:
      return notSetLabel();
  }
}

export function notSetLabel(): string {
  return $localize`:@@vendor.im.value.notSet:Not set`;
}

export function noOwnerValueLabel(): string {
  return $localize`:@@vendor.im.value.noOwner:No owner`;
}

// ─── Direction and data sentences ────────────────────────────────────────────

/** "To Procore", "From Procore", "Both ways" (§6.17.8). */
export function directionShort(direction: ContextDirection, other: string): string {
  switch (direction) {
    case 'outbound':
      return $localize`:@@vendor.im.direction.outbound:To ${other}:other:`;
    case 'inbound':
      return $localize`:@@vendor.im.direction.inbound:From ${other}:other:`;
    case 'both':
      return $localize`:@@vendor.im.direction.both:Both ways`;
  }
}

/** "Models are sent to Procore". A data type name is a plural noun ("RFIs"). */
export function dataSentence(data: string, direction: ContextDirection, other: string): string {
  switch (direction) {
    case 'outbound':
      return $localize`:@@vendor.im.data.sentence.outbound:${data}:data: are sent to ${other}:other:`;
    case 'inbound':
      return $localize`:@@vendor.im.data.sentence.inbound:${data}:data: come from ${other}:other:`;
    case 'both':
      return $localize`:@@vendor.im.data.sentence.both:${data}:data: are shared both ways`;
  }
}

/**
 * The list row's one line saying what is shared (§6.17.1): "Models and drawings
 * are sent to Navisworks. RFIs are shared both ways."
 */
export function sharedSummary(integration: VendorIntegration): string {
  const claims = integration.claims;
  if (claims.length === 0) {
    return $localize`:@@vendor.im.data.summary.none:Nothing is listed as shared yet`;
  }
  const other = integration.other_product.name;
  const parts: string[] = [];
  for (const direction of ['outbound', 'inbound', 'both'] as const) {
    const names = claims.filter((c) => c.direction === direction).map((c) => c.data_object_name);
    if (names.length === 0) continue;
    parts.push(dataSentence(joinNames(names), direction, other));
  }
  return parts.join('. ');
}

function joinNames(names: readonly string[]): string {
  if (names.length === 1) return names[0];
  const head = names.slice(0, -1).join(', ');
  const last = names[names.length - 1];
  return $localize`:@@vendor.im.data.join:${head}:head: and ${last}:last:`;
}

// ─── Row status (§6.17.8) ────────────────────────────────────────────────────

type Answer = 'yes' | 'no' | null;

export function myAnswer(claim: VendorClaim): Answer {
  const mine = claim.mine[0];
  if (!mine) return null;
  return mine.asserted ? 'yes' : 'no';
}

export function theirAnswer(claim: VendorClaim): Answer {
  if (!claim.counterparty) return null;
  return claim.counterparty.asserted ? 'yes' : 'no';
}

export interface RowPill {
  readonly label: string;
  readonly tone: Tone;
}

/** The row's status pill, from the caller's seat. Portal labels, not the public
 *  badge's. */
export function rowPill(
  integration: VendorIntegration,
  claim: VendorClaim,
  company: string | null,
): RowPill {
  if (!integration.attestable) {
    return {
      label: $localize`:@@vendor.im.row.checkedByAeci:Checked by AEC Integrations`,
      tone: 'neutral',
    };
  }
  if (claim.agreement === 'conflict') {
    return { label: $localize`:@@vendor.im.row.disputed:Disputed`, tone: 'conflict' };
  }
  const mine = myAnswer(claim);
  const theirs = theirAnswer(claim);
  if (mine === null) return { label: needsAnswerLabel(), tone: 'attention' };
  if (ownsBoth(integration)) {
    return mine === 'yes'
      ? { label: $localize`:@@vendor.im.row.confirmedByYou:Confirmed by you`, tone: 'ok' }
      : { label: saidWrongLabel(), tone: 'neutral' };
  }
  if (mine === 'yes' && theirs === 'yes') {
    return {
      label: $localize`:@@vendor.im.row.confirmedBoth:Confirmed by both companies`,
      tone: 'ok',
    };
  }
  if (mine === 'yes' && theirs === null) {
    const who = companyMidSentence(company);
    return {
      label: $localize`:@@vendor.im.row.waitingFor:Waiting for ${who}:company:`,
      tone: 'neutral',
    };
  }
  if (mine === 'no' && theirs === 'no') {
    return {
      label: $localize`:@@vendor.im.row.bothWrong:Both companies said this is wrong`,
      tone: 'neutral',
    };
  }
  if (mine === 'no' && theirs === null) return { label: saidWrongLabel(), tone: 'neutral' };
  // yes/no or no/yes without the server calling it a conflict (a third voter):
  // the server's agreement is the truth, so this reads as the caller's own stance.
  return mine === 'yes'
    ? { label: $localize`:@@vendor.im.row.youSaidRight:You said this is right`, tone: 'neutral' }
    : { label: saidWrongLabel(), tone: 'neutral' };
}

function needsAnswerLabel(): string {
  return $localize`:@@vendor.im.row.needsAnswer:Needs your answer`;
}

function saidWrongLabel(): string {
  return $localize`:@@vendor.im.row.youSaidWrong:You said this is wrong`;
}

/**
 * "Only Procore Technologies and AEC Integrations see this." (AECI-1139). The
 * helper text under every note field on this page. It delegates to the shared
 * `noteAudienceHint`, so the portal has one rule for who reads a note: AECi only
 * when the caller owns both products, the other company by name when there is
 * exactly one, and the other product's company otherwise.
 */
export function noteAudience(integration: VendorIntegration, myVendorId: string | null): string {
  return noteAudienceHint(integration, myVendorId, integration.other_product.name);
}

// ─── "Things that need you" (§6.17.2) ────────────────────────────────────────

export interface NeedItem {
  readonly key: string;
  readonly text: string;
  /** The element id the item jumps to and focuses. */
  readonly target: string;
  /** A jump into Change requests clears its search and sets it to All first. */
  readonly inRequests: boolean;
}

export interface NeedLists {
  readonly yours: readonly NeedItem[];
  readonly waiting: readonly NeedItem[];
}

export interface NeedsContext extends StatusContext {
  readonly company: string | null;
}

/** A protest on a contest the caller decided, open, unreplied and not yet due:
 *  the caller owes AEC Integrations a reply (§11b.12). */
function protestReplyDue(contest: VendorContest, now: string): boolean {
  const protest = contest.protest;
  return (
    !!protest &&
    protest.status === 'open' &&
    protest.replied_at === null &&
    Date.parse(protest.reply_due_at) > Date.parse(now)
  );
}

/** The two lists under the title block. A retired row lists nothing; a
 *  connector-powered row lists ownership and change request items only. */
export function needsItems(integration: VendorIntegration, ctx: NeedsContext): NeedLists {
  const yours: NeedItem[] = [];
  const waiting: NeedItem[] = [];
  if (integration.retired_at) return { yours, waiting };
  const company = companyOrFallback(ctx.company);
  const companyMid = companyMidSentence(ctx.company);

  if (integration.attestable) {
    for (const claim of disagreements(integration)) {
      const data = claim.data_object_name;
      if (myNote(claim)) {
        waiting.push({
          key: `disagreement-${claim.id}`,
          text: $localize`:@@vendor.im.needs.disagreeReasoned:${company}:company: disagrees about ${data}:data:. You gave your reason`,
          target: disagreementItemId(claim.id),
          inRequests: true,
        });
      } else {
        yours.push({
          key: `disagreement-${claim.id}`,
          text: $localize`:@@vendor.im.needs.disagree:${company}:company: disagrees about ${data}:data:`,
          target: disagreementItemId(claim.id),
          inRequests: true,
        });
      }
    }
    for (const claim of integration.claims) {
      if (!ctx.canAuthor || !isCounterpartAddedUnanswered(integration, claim)) continue;
      const data = claim.data_object_name;
      yours.push({
        key: `added-${claim.id}`,
        text: $localize`:@@vendor.im.needs.added:${company}:company: added ${data}:data:. Is this right?`,
        target: addedItemId(claim.id),
        inRequests: true,
      });
    }
  }

  for (const contest of ctx.contests.received) {
    const who = contest.submitter_vendor.name;
    if (contest.status === 'open') {
      const field = pageFieldLabelMid(contest.field);
      yours.push({
        key: `received-${contest.id}`,
        text: $localize`:@@vendor.im.needs.received:${who}:company: asked to change ${field}:field:`,
        target: contestItemId(contest.id),
        inRequests: true,
      });
    }
    const protest = contest.protest;
    if (protest && protestReplyDue(contest, ctx.now)) {
      const date = formatDay(protest.reply_due_at);
      yours.push({
        key: `protest-${contest.id}`,
        text: $localize`:@@vendor.im.needs.protest:${who}:company: asked AEC Integrations to review your decision. Reply by ${date}:date:`,
        target: contestItemId(contest.id),
        inRequests: true,
      });
    }
  }

  if (integration.attestable && ctx.canAuthor) {
    const rows = rowsNeedingAnswer(integration);
    if (rows.length > 0) {
      const n = rows.length;
      yours.push({
        key: 'rows',
        text:
          n === 1
            ? $localize`:@@vendor.im.needs.rows.one:1 row of data needs your answer`
            : $localize`:@@vendor.im.needs.rows:${n}:count: rows of data need your answer`,
        target: dataRowId(rows[0].id),
        inRequests: false,
      });
    }
  }

  if (canClaim(integration, ctx.entitled)) {
    yours.push({
      key: 'claim',
      text: $localize`:@@vendor.im.needs.claim:You can claim this integration`,
      target: rowTargetId('owner'),
      inRequests: false,
    });
  }
  if (integration.owner === null && openOwnerRequest(ctx.contests) === null) {
    yours.push({
      key: 'no-owner',
      text: $localize`:@@vendor.im.needs.noOwner:No owner is recorded. Ask to be recorded as the owner`,
      target: rowTargetId('owner'),
      inRequests: false,
    });
  }

  for (const contest of ctx.contests.submitted) {
    if (!isContestOpen(contest)) continue;
    const field = pageFieldLabelMid(contest.field);
    const owner = waitingOn(contest);
    waiting.push({
      key: `submitted-${contest.id}`,
      text: owner
        ? $localize`:@@vendor.im.needs.submitted:Your request to change ${field}:field: is with ${owner}:owner:`
        : $localize`:@@vendor.im.needs.submittedAeci:Your request to change ${field}:field: is with AEC Integrations`,
      target: contestItemId(contest.id),
      inRequests: true,
    });
  }

  if (integration.attestable) {
    for (const claim of integration.claims) {
      if (!isAddedByYouWaiting(integration, claim)) continue;
      const data = claim.data_object_name;
      waiting.push({
        key: `added-you-${claim.id}`,
        text: $localize`:@@vendor.im.needs.addedYou:You added ${data}:data:. Waiting for ${companyMid}:company:`,
        target: addedItemId(claim.id),
        inRequests: true,
      });
    }
  }

  return { yours, waiting };
}

// ─── Contest values and outcomes (§6.17.6) ───────────────────────────────────

/** One value of a contest as this page reads it. */
export function contestValue(contest: VendorContest, which: 'current' | 'proposed'): string {
  const value = which === 'current' ? contest.current_value : contest.proposed_value;
  const label = which === 'current' ? contest.current_label : contest.proposed_label;
  if (contest.field === 'owner') return value === null ? noOwnerValueLabel() : (label ?? value);
  if (value === null || value === '') return notSetLabel();
  if (contest.field === 'mechanism_kind') return howYouGetIt(value, null);
  if (contest.field === 'direction' && isDirection(value)) {
    return directionShort(value, contest.other_product.name);
  }
  return value;
}

function isDirection(value: string): value is ContextDirection {
  return value === 'inbound' || value === 'outbound' || value === 'both';
}

/** "Release stage: from Beta to Generally available". Words, never an arrow glyph. */
export function contestChange(contest: VendorContest): string {
  const field = pageFieldLabel(contest.field);
  const from = contestValue(contest, 'current');
  const to = contestValue(contest, 'proposed');
  return $localize`:@@vendor.im.request.change:${field}:field:: from ${from}:from: to ${to}:to:`;
}

export interface Outcome {
  readonly label: string;
  readonly tone: Tone;
  readonly explain: string;
}

/** A request the caller sent, where it stands. */
export function submittedOutcome(contest: VendorContest): Outcome {
  const owner = contest.owner_vendor?.name ?? $localize`:@@vendor.im.request.theOwner:the owner`;
  const protest = contest.protest;
  if (protest) {
    switch (protest.status) {
      case 'open':
        return {
          label: $localize`:@@vendor.im.request.withAeci:With AEC Integrations`,
          tone: 'neutral',
          explain: $localize`:@@vendor.im.request.protestOpen:You asked AEC Integrations to review ${owner}:owner:’s answer. You will see its answer here.`,
        };
      case 'upheld':
        return {
          label: $localize`:@@vendor.im.request.upheld:AEC Integrations agreed with you`,
          tone: 'ok',
          explain: $localize`:@@vendor.im.request.upheld.explain:This is advice to ${owner}:owner:. The public page changes only if ${owner}:owner: updates it.`,
        };
      case 'rejected':
        return {
          label: $localize`:@@vendor.im.request.rejected:AEC Integrations kept the original`,
          tone: 'neutral',
          explain: contest.cooldown_until
            ? $localize`:@@vendor.im.request.rejected.cooldown:The public page stays as it is. You can ask about this detail again after ${formatDay(contest.cooldown_until)}:date:.`
            : $localize`:@@vendor.im.request.rejected.explain:The public page stays as it is.`,
        };
      case 'withdrawn':
        return {
          label: $localize`:@@vendor.im.request.protestWithdrawn:You cancelled the review`,
          tone: 'neutral',
          explain: $localize`:@@vendor.im.request.protestWithdrawn.explain:The public page stays as it is.`,
        };
    }
  }
  switch (contest.status) {
    case 'open':
      return contest.routed_to === 'aeci'
        ? {
            label: $localize`:@@vendor.im.request.withAeci:With AEC Integrations`,
            tone: 'neutral',
            explain: $localize`:@@vendor.im.request.openAeci:AEC Integrations is reviewing it. You will see the answer here.`,
          }
        : {
            label: $localize`:@@vendor.im.request.withOwner:With ${owner}:owner:`,
            tone: 'neutral',
            explain: $localize`:@@vendor.im.request.openOwner:${owner}:owner: decides. If they do not answer within 30 days, you can ask AEC Integrations to review it.`,
          };
    case 'accepted':
      return {
        label: $localize`:@@vendor.im.request.accepted:Accepted`,
        tone: 'ok',
        explain:
          contest.routed_to === 'owner'
            ? $localize`:@@vendor.im.request.accepted.owner:${owner}:owner: made the change.`
            : $localize`:@@vendor.im.request.accepted.aeci:AEC Integrations agreed with the change.`,
      };
    case 'declined': {
      const who = contest.routed_to === 'owner' ? owner : 'AEC Integrations';
      return {
        label:
          contest.routed_to === 'owner'
            ? $localize`:@@vendor.im.request.declinedBy:Declined by ${owner}:owner:`
            : $localize`:@@vendor.im.request.declinedByAeci:Declined by AEC Integrations`,
        tone: 'neutral',
        explain:
          contest.protest_closes_at && contest.routed_to === 'owner'
            ? $localize`:@@vendor.im.request.declined.protestable:The public page stays as it is. You can ask AEC Integrations to review ${who}:who:’s answer until ${formatDay(contest.protest_closes_at)}:date:.`
            : $localize`:@@vendor.im.request.declined.explain:The public page stays as it is.`,
      };
    }
    case 'withdrawn':
      return {
        label: $localize`:@@vendor.im.request.withdrawn:Withdrawn by you`,
        tone: 'neutral',
        explain: $localize`:@@vendor.im.request.withdrawn.explain:You cancelled this request. Nothing changed.`,
      };
  }
}

/** A request another company sent the caller, as owner. */
export function receivedOutcome(contest: VendorContest): Outcome {
  const who = contest.submitter_vendor.name;
  if (contest.protest) {
    const protest = contest.protest;
    if (protest.status === 'open') {
      return {
        label: $localize`:@@vendor.im.received.protestOpen:With AEC Integrations for review`,
        tone: 'attention',
        explain: $localize`:@@vendor.im.received.protestOpen.explain:${who}:company: asked AEC Integrations to review your decision. You can reply once.`,
      };
    }
    if (protest.status === 'upheld') {
      return {
        label: $localize`:@@vendor.im.received.upheld:AEC Integrations agreed with ${who}:company:`,
        tone: 'neutral',
        explain: $localize`:@@vendor.im.received.upheld.explain:This is advice. The public page stays as it is unless you change it.`,
      };
    }
    if (protest.status === 'rejected') {
      return {
        label: $localize`:@@vendor.im.received.rejected:AEC Integrations agreed with you`,
        tone: 'ok',
        explain: $localize`:@@vendor.im.received.rejected.explain:The public page stays as it is.`,
      };
    }
  }
  switch (contest.status) {
    case 'open':
      return {
        label: $localize`:@@vendor.im.received.open:Waiting for your decision`,
        tone: 'attention',
        explain: $localize`:@@vendor.im.received.open.explain:Accept it to change the public page now, or decline it with a note. If you do not answer within 30 days, ${who}:company: can ask AEC Integrations to review it.`,
      };
    case 'accepted':
      return {
        label: $localize`:@@vendor.im.received.accepted:You accepted it`,
        tone: 'ok',
        explain: $localize`:@@vendor.im.received.accepted.explain:The public page shows the new value.`,
      };
    case 'declined':
      return {
        label: $localize`:@@vendor.im.received.declined:You declined it`,
        tone: 'neutral',
        explain: $localize`:@@vendor.im.received.declined.explain:The public page stays as it is.`,
      };
    case 'withdrawn':
      return {
        label: $localize`:@@vendor.im.received.withdrawn:Withdrawn by ${who}:company:`,
        tone: 'neutral',
        explain: $localize`:@@vendor.im.received.withdrawn.explain:Nothing changed.`,
      };
  }
}

export interface RailEvent {
  readonly at: string;
  readonly text: string;
  readonly noteBy: string | null;
  readonly note: string | null;
}

/** The dated rail of a closed request, built from the contest's own fields. */
export function contestEvents(contest: VendorContest, side: 'submitted' | 'received'): RailEvent[] {
  const submitter = contest.submitter_vendor.name;
  const owner = contest.owner_vendor?.name ?? $localize`:@@vendor.im.request.theOwner:the owner`;
  const decider = contest.routed_to === 'aeci' ? 'AEC Integrations' : owner;
  const events: RailEvent[] = [];
  events.push(
    side === 'submitted'
      ? {
          at: contest.created_at,
          text:
            contest.routed_to === 'aeci'
              ? $localize`:@@vendor.im.rail.sentAeci:You sent it to AEC Integrations.`
              : $localize`:@@vendor.im.rail.sentOwner:You sent it to ${owner}:owner:.`,
          noteBy: $localize`:@@vendor.im.rail.yourReason:Your reason`,
          note: contest.reason,
        }
      : {
          at: contest.created_at,
          text: $localize`:@@vendor.im.rail.receivedFrom:${submitter}:company: sent it to you.`,
          noteBy: $localize`:@@vendor.im.rail.theirReason:${possessive(submitter)}:company: reason`,
          note: contest.reason,
        },
  );
  if ((contest.status === 'accepted' || contest.status === 'declined') && contest.decided_at) {
    const accepted = contest.status === 'accepted';
    const silence = contest.status === 'declined' && contest.protest?.basis === 'silence';
    let text: string;
    if (silence) text = $localize`:@@vendor.im.rail.silence:No answer came within 30 days.`;
    else if (side === 'received') {
      text = accepted
        ? $localize`:@@vendor.im.rail.youAccepted:You accepted it.`
        : $localize`:@@vendor.im.rail.youDeclined:You declined it.`;
    } else {
      text = accepted
        ? $localize`:@@vendor.im.rail.theyAccepted:${decider}:who: accepted it.`
        : $localize`:@@vendor.im.rail.theyDeclined:${decider}:who: said no.`;
    }
    events.push({
      at: contest.decided_at,
      text,
      noteBy: contest.decision_note
        ? side === 'received'
          ? $localize`:@@vendor.im.rail.yourNote:Your note`
          : $localize`:@@vendor.im.rail.theirNote:${possessive(decider)}:who: note`
        : null,
      note: contest.decision_note,
    });
  }
  const protest = contest.protest;
  if (protest) {
    events.push({
      at: protest.protested_at,
      text:
        side === 'submitted'
          ? $localize`:@@vendor.im.rail.protested:You asked AEC Integrations to review the answer.`
          : $localize`:@@vendor.im.rail.protestedThem:${submitter}:company: asked AEC Integrations to review your answer.`,
      noteBy: $localize`:@@vendor.im.rail.reason:Reason`,
      note: protest.reason,
    });
    if (protest.replied_at) {
      events.push({
        at: protest.replied_at,
        text:
          side === 'submitted'
            ? $localize`:@@vendor.im.rail.ownerReplied:${owner}:owner: replied.`
            : $localize`:@@vendor.im.rail.youReplied:You replied.`,
        noteBy: $localize`:@@vendor.im.rail.reply:Reply`,
        note: protest.reply,
      });
    }
    if (protest.decided_at && (protest.status === 'upheld' || protest.status === 'rejected')) {
      events.push({
        at: protest.decided_at,
        text:
          protest.status === 'upheld'
            ? $localize`:@@vendor.im.rail.aeciUpheld:AEC Integrations agreed with the request.`
            : $localize`:@@vendor.im.rail.aeciRejected:AEC Integrations kept the original.`,
        noteBy: protest.decision_note
          ? $localize`:@@vendor.im.rail.aeciNote:AEC Integrations’ note`
          : null,
        note: protest.decision_note,
      });
    }
    if (protest.status === 'withdrawn') {
      events.push({
        at: contest.updated_at,
        text: $localize`:@@vendor.im.rail.protestWithdrawn:The review request was withdrawn.`,
        noteBy: null,
        note: null,
      });
    }
  }
  if (contest.status === 'withdrawn') {
    events.push({
      at: contest.updated_at,
      text:
        side === 'submitted'
          ? $localize`:@@vendor.im.rail.withdrawn:You withdrew it.`
          : $localize`:@@vendor.im.rail.withdrawnThem:${submitter}:company: withdrew it.`,
      noteBy: null,
      note: null,
    });
  }
  return events;
}

/** Everything a search over one contest matches (§6.17.6), lowercased. */
export function contestSearchText(contest: VendorContest): string {
  const protest = contest.protest;
  return [
    pageFieldLabel(contest.field),
    contestValue(contest, 'current'),
    contestValue(contest, 'proposed'),
    contest.reason,
    contest.decision_note,
    contest.submitter_vendor.name,
    contest.owner_vendor?.name,
    protest?.reason,
    protest?.reply,
    protest?.decision_note,
  ]
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .join(' ')
    .toLocaleLowerCase('en');
}

/** The newest-first comparator for items, `id` as the tiebreaker. ISO strings
 *  compare as instants, so a binary compare is right here (not display text). */
export function newestFirst(
  a: { readonly at: string; readonly id: string },
  b: { readonly at: string; readonly id: string },
): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
