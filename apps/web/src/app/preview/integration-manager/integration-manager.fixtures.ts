import {
  OPEN_CONFLICT_DAYS,
  SILENT_COUNTERPARTY_DAYS,
  STALE_VERSION_MONTHS,
  type ContestVendorRef,
  type IntegrationContestField,
  type ProductLink,
  type VendorContest,
} from '@aeci/shared';

/**
 * Fixtures and plain-language copy for the integration-manager design exploration
 * (`/preview/integration-manager`). Dev only: nothing here calls the API, and
 * nothing in the product imports it.
 *
 * The viewer is Autodesk, managing its product AutoCAD Architecture. Four
 * integrations cover the states the redesign has to explain:
 *
 * - Navisworks: the screenshot case. Autodesk owns both products, the reader is
 *   built into Navisworks, AEC Integrations added it, no owner is on file, and it
 *   carries a full correction-request history.
 * - Procore: another company owns it and disagrees about one item.
 * - Bluebeam Revu: Autodesk is the recorded owner but has not claimed it, and one
 *   item waits for Autodesk's answer.
 * - Smartsheet: runs through Zapier, so AEC Integrations maintains it.
 *
 * Correction requests reuse the real wire type (`VendorContest`), so a
 * productionized concept reads the same shape `GET /api/vendor/contests` returns.
 * The copy helpers below are the plain-language layer the four concepts share.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type Answer = 'yes' | 'no' | null;
export type FlowDirection = 'outbound' | 'inbound' | 'both';
export type Tone = 'ok' | 'attention' | 'conflict' | 'neutral';

export interface StatusCopy {
  readonly label: string;
  readonly tone: Tone;
  /** One line: what the status means and what, if anything, to do. */
  readonly explain: string;
}

/** One type of information that moves between the two products (a claim). */
export interface ImFlow {
  readonly id: string;
  /** The type of information, as a label ("Models"). */
  readonly what: string;
  /** The same, as it reads mid-sentence ("models"). */
  readonly whatInSentence: string;
  readonly direction: FlowDirection;
  /** The viewer's answer. Owning both products writes both sides at once. */
  readonly mine: Answer;
  /** The other company's answer. Always null when the viewer owns both. */
  readonly theirs: Answer;
  readonly theirNote: string | null;
  /** Set while the two companies disagree (a claim whose agreement is conflict). */
  readonly disputedAt?: string;
  /** What the other company says instead, as it reads after its name. */
  readonly disputeSummary?: string;
  /** Local only: the viewer chose to keep its answer. */
  readonly kept?: boolean;
  /** The viewer's note on its answer (the attestation note: optional, max 2000). */
  readonly myNote?: string | null;
  /** Preview only: what the viewer said is wrong. Not in the attestation model. */
  readonly myReason?: WrongReason | null;
  /**
   * Who added the row, when a company did (a vendor-created claim, origin 'vendor').
   * 'them' puts an "added a row, is this right?" item in the viewer's open items.
   */
  readonly addedBy?: 'you' | 'them';
  readonly addedAt?: string;
  /** NEW FIELD: the private note left when adding the row, for the other company. */
  readonly addedNote?: string | null;
}

/** What is wrong with a row of data, when the viewer answers No. Preview only. */
export interface WrongReason {
  readonly kind: 'not-shared' | 'direction' | 'other';
  /** The direction the viewer says is right, for kind 'direction'. */
  readonly suggested?: FlowDirection;
}

export type OwnerState =
  | 'none'
  | 'you-unclaimed'
  | 'you-claimed'
  | 'other-claimed'
  | 'other-unclaimed';

export interface ImLinks {
  readonly listing: string | null;
  readonly docs: string | null;
}

/** One endpoint product's own links on the integration (own_links, AECI-1007). */
export interface ImSide {
  readonly product: string;
  readonly vendor: string;
  /** The viewer's company owns this product, so it can edit these links. */
  readonly mine: boolean;
  readonly links: ImLinks;
}

/** Contestable integration fields not held elsewhere on {@link ImIntegration}. */
export interface ImDetails {
  readonly name: string | null;
  readonly description: string | null;
  /** The integration's overall direction, framed from the viewer's product. */
  readonly direction: FlowDirection | null;
  readonly maturity: string | null;
  readonly pricing: string | null;
  readonly listingUrl: string | null;
  readonly docsUrl: string | null;
  readonly website: string | null;
  readonly mechanismUrl: string | null;
  /** NEW FIELD, needs a new column: an optional link to the pricing page. */
  readonly pricingUrl: string | null;
}

export interface ImIntegration {
  /** Short id, used in the preview URL (`?open=navisworks`). */
  readonly id: string;
  /** The wire id a contest points at. */
  readonly uuid: string;
  readonly other: { readonly name: string; readonly vendor: string; readonly slug: string };
  readonly ownsBoth: boolean;
  readonly how: {
    readonly kind: 'native' | 'marketplace-app' | 'api' | 'iPaaS';
    /** The mechanism name ("Navisworks DWG file reader"). */
    readonly name: string | null;
    /** Set when the integration runs through a connector product. */
    readonly connector: string | null;
  };
  readonly addedAt: string;
  /** The rest of the contestable fields (INTEGRATION_CONTEST_FIELDS), as on record. */
  readonly details: ImDetails;
  readonly owner: { readonly state: OwnerState; readonly name: string | null };
  /** Both endpoints' own links, the viewer's product first. Empty on a connector row. */
  readonly sides: readonly ImSide[];
  readonly flows: readonly ImFlow[];
  readonly contests: readonly VendorContest[];
  readonly retired: boolean;
}

// ─── The viewer ──────────────────────────────────────────────────────────────

export const VIEWER = {
  vendor: 'Autodesk',
  product: 'AutoCAD Architecture',
  productSlug: 'autocad-architecture',
} as const;

/** "Now" is fixed so every date sentence renders the same on the server and in the browser. */
export const PREVIEW_NOW = '2026-09-25T12:00:00.000Z';

const AUTODESK: ContestVendorRef = { id: '00000000-0000-4000-8000-00000000a001', name: 'Autodesk' };
const IDEATE: ContestVendorRef = {
  id: '00000000-0000-4000-8000-00000000a002',
  name: 'Ideate Software',
};

const TRIMBLE: ContestVendorRef = { id: '00000000-0000-4000-8000-00000000a003', name: 'Trimble' };
const TRIMBLE_CONNECT: ProductLink = {
  id: '00000000-0000-4000-8000-00000000b003',
  name: 'Trimble Connect',
  slug: 'trimble-connect',
  logo_url: null,
};

const ACA: ProductLink = {
  id: '00000000-0000-4000-8000-00000000b001',
  name: VIEWER.product,
  slug: VIEWER.productSlug,
  logo_url: null,
};
const NAVISWORKS: ProductLink = {
  id: '00000000-0000-4000-8000-00000000b002',
  name: 'Navisworks',
  slug: 'navisworks',
  logo_url: null,
};

/** The one open request, so the dev strip can show Navisworks with and without it. */
export const NAVISWORKS_OWNER_REQUEST_ID = '00000000-0000-4000-8000-00000000c001';

function contest(
  partial: Partial<VendorContest> &
    Pick<
      VendorContest,
      'id' | 'field' | 'current_value' | 'proposed_value' | 'reason' | 'routed_to' | 'status'
    >,
): VendorContest {
  return {
    integration_id: '00000000-0000-4000-8000-00000000d001',
    anchor: 'integration',
    integration_name: null,
    context_product: ACA,
    other_product: NAVISWORKS,
    current_label: null,
    proposed_label: null,
    submitter_vendor: AUTODESK,
    owner_vendor: null,
    decision_note: null,
    decided_at: null,
    created_at: PREVIEW_NOW,
    updated_at: PREVIEW_NOW,
    protest: null,
    protest_opens_at: null,
    protest_closes_at: null,
    protest_basis: null,
    cooldown_until: null,
    ...partial,
  };
}

const NAVISWORKS_CONTESTS: readonly VendorContest[] = [
  contest({
    id: NAVISWORKS_OWNER_REQUEST_ID,
    field: 'owner',
    current_value: null,
    current_label: null,
    proposed_value: AUTODESK.id,
    proposed_label: AUTODESK.name,
    reason: 'The DWG file reader ships inside Navisworks, and both products are ours.',
    routed_to: 'aeci',
    status: 'open',
    created_at: '2026-09-18T10:02:00.000Z',
    updated_at: '2026-09-18T10:02:00.000Z',
  }),
  contest({
    id: '00000000-0000-4000-8000-00000000c002',
    field: 'mechanism_name',
    current_value: 'Navisworks DWG file reader',
    proposed_value: 'Navisworks DWG and DXF file reader',
    reason: 'The reader opens DXF files as well.',
    routed_to: 'aeci',
    status: 'withdrawn',
    created_at: '2026-08-11T14:48:00.000Z',
    updated_at: '2026-08-12T08:30:00.000Z',
  }),
  contest({
    id: '00000000-0000-4000-8000-00000000c003',
    field: 'description',
    current_value:
      'An Ideate Software add-in that exports AutoCAD Architecture drawings to Navisworks.',
    proposed_value:
      'Navisworks opens AutoCAD Architecture drawings directly with its built-in DWG file reader.',
    reason: 'No add-in is needed. The reader is part of Navisworks itself.',
    routed_to: 'owner',
    owner_vendor: IDEATE,
    status: 'declined',
    decision_note: 'Our description matches the listing on our own website.',
    decided_at: '2026-06-27T11:22:00.000Z',
    created_at: '2026-06-20T09:05:00.000Z',
    updated_at: '2026-07-09T15:02:00.000Z',
    protest: {
      status: 'upheld',
      basis: 'declined',
      reason:
        'Customers do not need the add-in. Navisworks reads the DWG files on its own, so the description sends them to the wrong product.',
      evidence_urls: ['https://help.autodesk.com/view/NAV/2026/ENU/'],
      protested_at: '2026-07-01T13:30:00.000Z',
      reply_due_at: '2026-07-15T13:30:00.000Z',
      reply: 'We still think our wording is clearer for our customers.',
      reply_evidence_urls: [],
      replied_at: '2026-07-04T09:12:00.000Z',
      decision_note:
        'We agree with Autodesk. The DWG reader ships inside Navisworks, so the description should say it is built in. Ideate Software decides whether to update it.',
      decided_at: '2026-07-09T15:02:00.000Z',
    },
  }),
  contest({
    id: '00000000-0000-4000-8000-00000000c004',
    field: 'maturity',
    current_value: 'Beta',
    proposed_value: 'Generally available',
    reason: 'It left beta with the 2026 release.',
    routed_to: 'owner',
    owner_vendor: IDEATE,
    status: 'accepted',
    decision_note: 'Right, thanks. Updated.',
    decided_at: '2026-06-05T16:40:00.000Z',
    created_at: '2026-06-02T10:14:00.000Z',
    updated_at: '2026-06-05T16:40:00.000Z',
  }),
];

/** Requests Trimble sent to Autodesk as the owner of the Trimble Connect integration. */
const TRIMBLE_RECEIVED: readonly VendorContest[] = [
  contest({
    id: '00000000-0000-4000-8000-00000000c101',
    integration_id: '00000000-0000-4000-8000-00000000d005',
    other_product: TRIMBLE_CONNECT,
    field: 'maturity',
    current_value: 'Beta',
    proposed_value: 'Generally available',
    reason:
      'The Trimble Connect side left beta in March 2026. Our release notes for 2026.1 say so.',
    routed_to: 'owner',
    status: 'open',
    submitter_vendor: TRIMBLE,
    owner_vendor: AUTODESK,
    created_at: '2026-09-22T14:10:00.000Z',
    updated_at: '2026-09-22T14:10:00.000Z',
  }),
  contest({
    id: '00000000-0000-4000-8000-00000000c102',
    integration_id: '00000000-0000-4000-8000-00000000d005',
    other_product: TRIMBLE_CONNECT,
    field: 'description',
    current_value: 'Opens Trimble Connect projects inside AutoCAD Architecture.',
    proposed_value:
      'Opens Trimble Connect projects inside AutoCAD Architecture and publishes sheets back.',
    reason: 'Publishing sheets back has worked since the 2025 release.',
    routed_to: 'owner',
    status: 'accepted',
    submitter_vendor: TRIMBLE,
    owner_vendor: AUTODESK,
    decision_note: 'Right, thanks. Updated.',
    decided_at: '2026-08-14T11:05:00.000Z',
    created_at: '2026-08-12T16:30:00.000Z',
    updated_at: '2026-08-14T11:05:00.000Z',
  }),
];

export const IM_INTEGRATIONS: readonly ImIntegration[] = [
  {
    id: 'navisworks',
    uuid: '00000000-0000-4000-8000-00000000d001',
    other: { name: 'Navisworks', vendor: 'Autodesk', slug: 'navisworks' },
    ownsBoth: true,
    how: { kind: 'native', name: 'Navisworks DWG file reader', connector: null },
    addedAt: '2026-03-04T15:20:00.000Z',
    details: {
      name: null,
      description:
        'Navisworks opens AutoCAD Architecture drawings directly with its built-in DWG file reader.',
      direction: 'outbound',
      maturity: 'Generally available',
      pricing: 'Included with Navisworks',
      listingUrl: 'https://www.autodesk.com/products/navisworks',
      docsUrl: 'https://help.autodesk.com/view/NAV/2026/ENU/',
      website: null,
      mechanismUrl: null,
      pricingUrl: null,
    },
    owner: { state: 'none', name: null },
    sides: [
      {
        product: 'AutoCAD Architecture',
        vendor: 'Autodesk',
        mine: true,
        links: { listing: 'https://www.autodesk.com/products/autocad-architecture', docs: null },
      },
      {
        product: 'Navisworks',
        vendor: 'Autodesk',
        mine: true,
        links: {
          listing: 'https://www.autodesk.com/products/navisworks',
          docs: 'https://help.autodesk.com/view/NAV/2026/ENU/?guid=dwg-reader',
        },
      },
    ],
    flows: [
      {
        id: 'nw-models',
        what: 'Models',
        whatInSentence: 'models',
        direction: 'outbound',
        mine: 'yes',
        theirs: null,
        theirNote: null,
      },
      {
        id: 'nw-drawings',
        what: 'Drawings',
        whatInSentence: 'drawings',
        direction: 'outbound',
        mine: 'yes',
        theirs: null,
        theirNote: null,
      },
    ],
    contests: NAVISWORKS_CONTESTS,
    retired: false,
  },
  {
    id: 'procore',
    uuid: '00000000-0000-4000-8000-00000000d002',
    other: { name: 'Procore', vendor: 'Procore Technologies', slug: 'procore' },
    ownsBoth: false,
    how: { kind: 'marketplace-app', name: 'Procore App Marketplace listing', connector: null },
    addedAt: '2026-02-11T09:45:00.000Z',
    details: {
      name: 'Procore for AutoCAD Architecture',
      description:
        'Publishes drawings and documents from AutoCAD Architecture into Procore projects.',
      direction: 'both',
      maturity: 'Generally available',
      pricing: 'Free with a Procore subscription',
      listingUrl: 'https://marketplace.procore.com/apps/autocad-architecture',
      docsUrl: null,
      website: 'https://www.procore.com',
      mechanismUrl: null,
      pricingUrl: null,
    },
    owner: { state: 'other-claimed', name: 'Procore Technologies' },
    sides: [
      {
        product: 'AutoCAD Architecture',
        vendor: 'Autodesk',
        mine: true,
        links: { listing: null, docs: null },
      },
      {
        product: 'Procore',
        vendor: 'Procore Technologies',
        mine: false,
        links: {
          listing: 'https://marketplace.procore.com/apps/autocad-architecture',
          docs: 'https://support.procore.com/integrations/autocad-architecture',
        },
      },
    ],
    flows: [
      {
        id: 'pc-documents',
        what: 'Documents',
        whatInSentence: 'documents',
        direction: 'outbound',
        mine: 'yes',
        theirs: 'yes',
        theirNote: null,
      },
      {
        id: 'pc-rfis',
        what: 'RFIs',
        whatInSentence: 'RFIs',
        direction: 'both',
        mine: 'yes',
        theirs: 'no',
        theirNote: 'We receive RFIs, but nothing is sent back to AutoCAD Architecture.',
        disputedAt: '2026-09-21T16:40:00.000Z',
        disputeSummary: 'says RFIs are only sent to Procore',
        myNote: 'RFI responses come back into the drawing set through the Procore sync.',
      },
      {
        id: 'pc-submittals',
        what: 'Submittals',
        whatInSentence: 'submittals',
        direction: 'inbound',
        mine: null,
        theirs: 'yes',
        theirNote: null,
        addedBy: 'them',
        addedAt: '2026-09-26T09:40:00.000Z',
        addedNote:
          'Submittal packages from Procore now land in the AutoCAD Architecture sheet set. Can you confirm from your side?',
      },
    ],
    contests: [],
    retired: false,
  },
  {
    id: 'bluebeam',
    uuid: '00000000-0000-4000-8000-00000000d003',
    other: { name: 'Bluebeam Revu', vendor: 'Bluebeam', slug: 'bluebeam-revu' },
    ownsBoth: false,
    how: {
      kind: 'marketplace-app',
      name: 'AutoCAD Architecture add-in for Revu',
      connector: null,
    },
    addedAt: '2026-04-22T13:05:00.000Z',
    details: {
      name: null,
      description: 'Sends drawings to Revu for markup and brings the markups back.',
      direction: 'both',
      maturity: 'Beta',
      pricing: 'Free',
      listingUrl: 'https://apps.autodesk.com/ACD/en/Detail/revu-add-in',
      docsUrl: null,
      website: null,
      mechanismUrl: null,
      pricingUrl: null,
    },
    owner: { state: 'you-unclaimed', name: 'Autodesk' },
    sides: [
      {
        product: 'AutoCAD Architecture',
        vendor: 'Autodesk',
        mine: true,
        links: { listing: 'https://apps.autodesk.com/ACD/en/Detail/revu-add-in', docs: null },
      },
      {
        product: 'Bluebeam Revu',
        vendor: 'Bluebeam',
        mine: false,
        links: { listing: null, docs: 'https://support.bluebeam.com/revu/autocad-architecture' },
      },
    ],
    flows: [
      {
        id: 'bb-markups',
        what: 'Markups',
        whatInSentence: 'markups',
        direction: 'inbound',
        mine: null,
        theirs: 'yes',
        theirNote: null,
      },
      {
        id: 'bb-drawings',
        what: 'Drawings',
        whatInSentence: 'drawings',
        direction: 'outbound',
        mine: 'yes',
        theirs: null,
        theirNote: null,
      },
    ],
    contests: [],
    retired: false,
  },
  {
    // Owned: Autodesk offers this integration and has claimed it, so it edits the
    // details directly and decides the requests other companies send.
    id: 'trimble-connect',
    uuid: '00000000-0000-4000-8000-00000000d005',
    other: { name: 'Trimble Connect', vendor: 'Trimble', slug: 'trimble-connect' },
    ownsBoth: false,
    how: {
      kind: 'marketplace-app',
      name: 'Trimble Connect for AutoCAD Architecture',
      connector: null,
    },
    addedAt: '2026-01-15T10:00:00.000Z',
    details: {
      name: null,
      description:
        'Opens Trimble Connect projects inside AutoCAD Architecture and publishes sheets back. Linked models load as external references, so project teams see the latest coordination model without leaving the drawing. Markups made in Trimble Connect appear on the matching sheet, and publishing a sheet set updates the project folder in one step.',
      direction: 'both',
      maturity: 'Beta',
      pricing: 'Included with AutoCAD Architecture',
      pricingUrl: 'https://www.autodesk.com/products/autocad-architecture/pricing',
      listingUrl: 'https://apps.autodesk.com/ACD/en/Detail/trimble-connect',
      docsUrl: 'https://help.autodesk.com/view/ACD/2026/ENU/?guid=trimble-connect',
      website: null,
      mechanismUrl: null,
    },
    owner: { state: 'you-claimed', name: 'Autodesk' },
    sides: [
      {
        product: 'AutoCAD Architecture',
        vendor: 'Autodesk',
        mine: true,
        links: { listing: 'https://apps.autodesk.com/ACD/en/Detail/trimble-connect', docs: null },
      },
      {
        product: 'Trimble Connect',
        vendor: 'Trimble',
        mine: false,
        links: {
          listing: 'https://connect.trimble.com/integrations/autocad-architecture',
          docs: null,
        },
      },
    ],
    flows: [
      {
        id: 'tc-drawings',
        what: 'Drawings',
        whatInSentence: 'drawings',
        direction: 'outbound',
        mine: 'yes',
        theirs: 'yes',
        theirNote: null,
      },
      {
        id: 'tc-models',
        what: 'Models',
        whatInSentence: 'models',
        direction: 'inbound',
        mine: 'yes',
        theirs: null,
        theirNote: null,
        addedBy: 'you',
        addedAt: '2026-09-20T08:15:00.000Z',
        addedNote: 'Linked Trimble Connect models now load as xrefs. Can you confirm?',
      },
    ],
    contests: TRIMBLE_RECEIVED,
    retired: false,
  },
  {
    id: 'smartsheet',
    uuid: '00000000-0000-4000-8000-00000000d004',
    other: { name: 'Smartsheet', vendor: 'Smartsheet Inc.', slug: 'smartsheet' },
    ownsBoth: false,
    how: { kind: 'iPaaS', name: 'Zapier', connector: 'Zapier' },
    addedAt: '2026-05-30T08:10:00.000Z',
    details: {
      name: null,
      description: 'A Zapier workflow that copies project schedules into Smartsheet.',
      direction: 'outbound',
      maturity: null,
      pricing: 'Needs a paid Zapier plan',
      listingUrl: 'https://zapier.com/apps/smartsheet/integrations',
      docsUrl: 'https://help.zapier.com/hc/en-us/articles/smartsheet-integration',
      website: null,
      mechanismUrl: null,
      pricingUrl: null,
    },
    owner: { state: 'other-unclaimed', name: 'Zapier' },
    sides: [],
    flows: [
      {
        id: 'ss-schedules',
        what: 'Project schedules',
        whatInSentence: 'project schedules',
        direction: 'outbound',
        mine: null,
        theirs: null,
        theirNote: null,
      },
    ],
    contests: [],
    retired: false,
  },
];

/** Types of information the add form offers (a small slice of the real vocabulary). */
export const IM_INFO_TYPES: ReadonlyArray<{ what: string; whatInSentence: string }> = [
  { what: 'Models', whatInSentence: 'models' },
  { what: 'Drawings', whatInSentence: 'drawings' },
  { what: 'Sheets', whatInSentence: 'sheets' },
  { what: 'Markups', whatInSentence: 'markups' },
  { what: 'Issues', whatInSentence: 'issues' },
  { what: 'RFIs', whatInSentence: 'RFIs' },
  { what: 'Documents', whatInSentence: 'documents' },
  { what: 'Project schedules', whatInSentence: 'project schedules' },
];

// ─── Dates ───────────────────────────────────────────────────────────────────

// UTC, and said so, so the server render and the browser agree.
const WHEN = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

export function formatWhen(iso: string): string {
  return `${WHEN.format(new Date(iso))} UTC`;
}

export function formatDay(iso: string): string {
  return DAY.format(new Date(iso));
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

// ─── How it connects ─────────────────────────────────────────────────────────

export function isConnector(i: ImIntegration): boolean {
  return i.how.connector !== null;
}

/** The plain kind line ("Built into the product", "Through Zapier"). */
export function howKind(i: ImIntegration): string {
  switch (i.how.kind) {
    case 'native':
      return 'Built into the product';
    case 'marketplace-app':
      return 'Marketplace app';
    case 'api':
      return 'Direct connection';
    case 'iPaaS':
      return `Through ${i.how.connector ?? 'a connector service'}`;
  }
}

/** One sentence under the kind, saying what it means for a customer. */
export function howExplain(i: ImIntegration): string {
  switch (i.how.kind) {
    case 'native':
      return `${i.other.name} can do this on its own. Customers do not install anything extra.`;
    case 'marketplace-app':
      return 'Customers install an add-on to use it.';
    case 'api':
      return 'The two products talk to each other directly once it is set up.';
    case 'iPaaS':
      return `Customers set it up in ${i.how.connector ?? 'a connector service'}, a separate service that moves information between apps.`;
  }
}

// ─── What's shared ───────────────────────────────────────────────────────────

export function directionShort(direction: FlowDirection, other: string): string {
  switch (direction) {
    case 'outbound':
      return `To ${other}`;
    case 'inbound':
      return `From ${other}`;
    case 'both':
      return 'Both ways';
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "Models are sent to Navisworks." */
export function flowSentence(flow: ImFlow, i: ImIntegration): string {
  const what = capitalize(flow.whatInSentence);
  switch (flow.direction) {
    case 'outbound':
      return `${what} are sent to ${i.other.name}`;
    case 'inbound':
      return `${what} come from ${i.other.name}`;
    case 'both':
      return `${what} are shared both ways`;
  }
}

/** The one-line summary a list row shows ("Models and drawings are sent to Navisworks"). */
export function sharedSummary(i: ImIntegration): string {
  if (i.flows.length === 0) return 'Nothing is listed as shared yet';
  const groups: FlowDirection[] = ['outbound', 'inbound', 'both'];
  const parts: string[] = [];
  for (const direction of groups) {
    const words = i.flows.filter((f) => f.direction === direction).map((f) => f.whatInSentence);
    if (words.length === 0) continue;
    const list = joinWords(words);
    if (direction === 'outbound') parts.push(`${list} are sent to ${i.other.name}`);
    if (direction === 'inbound') parts.push(`${list} come from ${i.other.name}`);
    if (direction === 'both') parts.push(`${list} are shared both ways`);
  }
  return parts.map(capitalize).join('. ');
}

export function answerLabel(flow: ImFlow, i: ImIntegration): string {
  if (isConnector(i)) return 'No answer needed';
  if (flow.mine === 'yes') return 'Yes, this is right';
  if (flow.mine === 'no') return 'No, this is wrong';
  return 'Not answered yet';
}

export function flowStatus(flow: ImFlow, i: ImIntegration): StatusCopy & { needsYou: boolean } {
  const co = i.other.vendor;
  if (isConnector(i)) {
    return {
      label: 'Checked by AEC Integrations',
      tone: 'neutral',
      explain: `This runs through ${i.how.connector}, so AEC Integrations checks it and neither company answers for it. Nothing to do.`,
      needsYou: false,
    };
  }
  if (i.ownsBoth) {
    if (flow.mine === 'yes') {
      return {
        label: 'Confirmed by you',
        tone: 'ok',
        explain:
          'Both products are yours, so nobody else needs to confirm it. The public page shows it as confirmed by Autodesk. Nothing to do.',
        needsYou: false,
      };
    }
    if (flow.mine === 'no') {
      return {
        label: 'You said this is wrong',
        tone: 'neutral',
        explain:
          'AEC Integrations reviews it and fixes the listing. Until then the public page shows it as not confirmed.',
        needsYou: false,
      };
    }
    return {
      label: 'Needs your answer',
      tone: 'attention',
      explain:
        'Tell us whether this is right. Until you do, the public page shows it as not confirmed.',
      needsYou: true,
    };
  }
  const { mine, theirs } = flow;
  if (mine === 'yes' && theirs === 'yes') {
    return {
      label: 'Confirmed by both companies',
      tone: 'ok',
      explain: `You and ${co} both say this is right. We ask you to check it again in ${STALE_VERSION_MONTHS} months.`,
      needsYou: false,
    };
  }
  if ((mine === 'yes' && theirs === 'no') || (mine === 'no' && theirs === 'yes')) {
    return {
      label: 'Disputed',
      tone: 'conflict',
      explain: flow.kept
        ? `You kept your answer. AEC Integrations reviews it after ${OPEN_CONFLICT_DAYS} days and emails you both.`
        : `You and ${co} disagree. It is open in Change requests.`,
      needsYou: !flow.kept,
    };
  }
  if (mine === 'yes' && theirs === null) {
    return {
      label: `Waiting for ${co}`,
      tone: 'neutral',
      explain: `You said this is right. If ${co} has not answered after ${SILENT_COUNTERPARTY_DAYS} days, we ask them. Nothing to do.`,
      needsYou: false,
    };
  }
  if (mine === null && theirs === 'yes') {
    return {
      label: 'Needs your answer',
      tone: 'attention',
      explain: `${co} says this is right. Tell us whether you agree. We send a reminder after ${SILENT_COUNTERPARTY_DAYS} days.`,
      needsYou: true,
    };
  }
  if (mine === null && theirs === 'no') {
    return {
      label: 'Needs your answer',
      tone: 'attention',
      explain: `${co} says this is wrong, and AEC Integrations will review it. Answer if you disagree.`,
      needsYou: true,
    };
  }
  if (mine === 'no' && theirs === null) {
    return {
      label: 'You said this is wrong',
      tone: 'neutral',
      explain: `AEC Integrations reviews it, fixes the listing and tells ${co}. Nothing to do.`,
      needsYou: false,
    };
  }
  if (mine === 'no' && theirs === 'no') {
    return {
      label: 'Both companies said this is wrong',
      tone: 'neutral',
      explain: 'AEC Integrations takes it off the listing. Nothing to do.',
      needsYou: false,
    };
  }
  return {
    label: 'Needs your answer',
    tone: 'attention',
    explain:
      'Nobody has confirmed this yet. Until someone does, the public page shows it as not confirmed.',
    needsYou: true,
  };
}

/** What "What's shared" means, said once at the top of every concept's section. */
export function sharedIntro(i: ImIntegration): string {
  if (isConnector(i)) {
    return `The types of information that move between ${VIEWER.product} and ${i.other.name} through ${i.how.connector}. AEC Integrations keeps this list up to date.`;
  }
  return `The types of information that move between ${VIEWER.product} and ${i.other.name}. Tell us whether each one is right. Your answers show on the public page.`;
}

// ─── Owner ───────────────────────────────────────────────────────────────────

export type OwnerAction = 'claim' | 'request-owner' | 'request-pending' | 'edit' | null;

export interface OwnerCopy {
  readonly value: string;
  /** Why the action is the one it is, in one sentence. */
  readonly reason: string;
  readonly action: OwnerAction;
  readonly actionLabel: string | null;
}

export const OWNER_DEFINITION =
  'The owner is the company that offers this integration and keeps its details up to date.';

export function openOwnerRequest(i: ImIntegration): VendorContest | null {
  return i.contests.find((c) => c.field === 'owner' && c.status === 'open') ?? null;
}

export function ownerCopy(i: ImIntegration): OwnerCopy {
  switch (i.owner.state) {
    case 'none': {
      const pending = openOwnerRequest(i);
      if (pending) {
        return {
          value: 'Not recorded yet',
          reason: `You asked to be recorded as the owner on ${formatDay(pending.created_at)}. AEC Integrations is reviewing it. Once it agrees, you can edit the details yourself.`,
          action: 'request-pending',
          actionLabel: 'See your request',
        };
      }
      return {
        value: 'Not recorded yet',
        reason:
          'You cannot claim it directly because no company is recorded as the owner yet. Ask to be recorded as the owner, and AEC Integrations checks it first.',
        action: 'request-owner',
        actionLabel: 'Ask to be recorded as the owner',
      };
    }
    case 'you-unclaimed':
      return {
        value: `${VIEWER.vendor} (you)`,
        reason: `You are recorded as the owner, so you can claim it. Claiming lets you edit the details yourself. AEC Integrations stops updating it, and ${i.other.vendor} is told.`,
        action: 'claim',
        actionLabel: 'Claim this integration',
      };
    case 'you-claimed':
      return {
        value: `${VIEWER.vendor} (you)`,
        reason:
          'You keep its details up to date. Edit a row with its pencil. Changes go live on the public page straight away.',
        action: null,
        actionLabel: null,
      };
    case 'other-claimed':
      return {
        value: i.owner.name ?? '',
        reason: `${i.owner.name} keeps its details up to date. If something is wrong, request a correction and ${i.owner.name} decides.`,
        action: null,
        actionLabel: null,
      };
    case 'other-unclaimed':
      return {
        value: i.owner.name ?? '',
        reason: `${i.owner.name} has not taken over this listing, so AEC Integrations reviews any correction you request.`,
        action: null,
        actionLabel: null,
      };
  }
}

export function isOwner(i: ImIntegration): boolean {
  return i.owner.state === 'you-claimed' || i.owner.state === 'you-unclaimed';
}

export function maintainedBy(i: ImIntegration): string {
  if (i.owner.state === 'you-claimed') return 'You';
  if (i.owner.state === 'other-claimed') return i.owner.name ?? 'The owner';
  return 'AEC Integrations';
}

// ─── Correction requests ─────────────────────────────────────────────────────

const FIELD_LABELS: Record<IntegrationContestField, string> = {
  name: 'Name',
  mechanism_kind: 'How you get it',
  mechanism_name: 'Connection name',
  direction: 'Direction',
  description: 'Description',
  listing_url: 'Listing page',
  docs_url: 'Documentation',
  website: 'Website',
  mechanism_url: 'Connection link',
  pricing_model: 'Pricing',
  maturity: 'Release stage',
  owner: 'Owner',
};

export const REQUEST_FIELDS: readonly IntegrationContestField[] = [
  'owner',
  'name',
  'description',
  'mechanism_name',
  'mechanism_kind',
  'direction',
  'maturity',
  'pricing_model',
  'listing_url',
  'docs_url',
  'website',
  'mechanism_url',
];

export function fieldLabel(field: IntegrationContestField): string {
  return FIELD_LABELS[field];
}

export function requestValue(c: VendorContest, which: 'current' | 'proposed'): string {
  const label = which === 'current' ? c.current_label : c.proposed_label;
  const value = which === 'current' ? c.current_value : c.proposed_value;
  if (c.field === 'owner') return label ?? (value === null ? 'No owner' : value);
  return value ?? 'Not set';
}

/** The value on record today, for the request form. */
export function currentValue(i: ImIntegration, field: IntegrationContestField): string {
  const d = i.details;
  switch (field) {
    case 'owner':
      return i.owner.name ?? 'No owner';
    case 'name':
      return d.name ?? `${VIEWER.product} and ${i.other.name}`;
    case 'mechanism_name':
      return i.how.name ?? 'Not set';
    case 'mechanism_kind':
      return howKind(i);
    case 'direction':
      return d.direction ? directionShort(d.direction, i.other.name) : 'Not set';
    case 'description':
      return d.description ?? 'Not set';
    case 'listing_url':
      return d.listingUrl ?? 'Not set';
    case 'docs_url':
      return d.docsUrl ?? 'Not set';
    case 'website':
      return d.website ?? 'Not set';
    case 'mechanism_url':
      return d.mechanismUrl ?? 'Not set';
    case 'pricing_model':
      return d.pricing ?? 'Not set';
    case 'maturity':
      return d.maturity ?? 'Not set';
  }
}

/** Who a new request goes to, and why, in one sentence. */
export function requestRouteLine(i: ImIntegration, field: IntegrationContestField | null): string {
  if (field === 'owner') return 'Requests about the owner always go to AEC Integrations.';
  if (i.owner.state === 'other-claimed') {
    return `This goes to ${i.owner.name}, the owner. If they say no, you can ask AEC Integrations to review it.`;
  }
  return 'This goes to AEC Integrations, because no company has taken over this listing.';
}

export interface RequestEvent {
  readonly at: string;
  readonly text: string;
  readonly note: string | null;
  readonly noteBy: string | null;
}

export function requestOutcome(c: VendorContest): StatusCopy {
  const owner = c.owner_vendor?.name ?? 'the owner';
  if (c.protest) {
    switch (c.protest.status) {
      case 'open':
        return {
          label: 'With AEC Integrations',
          tone: 'neutral',
          explain: `You asked AEC Integrations to review ${owner}'s answer. You will see its answer here.`,
        };
      case 'upheld':
        return {
          label: 'AEC Integrations agreed with you',
          tone: 'ok',
          explain: `This is advice to ${owner}. The listing changes only if ${owner} updates it.`,
        };
      case 'rejected':
        return {
          label: 'AEC Integrations kept the original',
          tone: 'neutral',
          explain: c.cooldown_until
            ? `The listing stays as it is. You can ask about this detail again after ${formatDay(c.cooldown_until)}.`
            : 'The listing stays as it is.',
        };
      case 'withdrawn':
        return {
          label: 'You cancelled the review',
          tone: 'neutral',
          explain: 'The listing stays as it is.',
        };
    }
  }
  switch (c.status) {
    case 'open':
      return c.routed_to === 'aeci'
        ? {
            label: 'With AEC Integrations',
            tone: 'neutral',
            explain:
              'AEC Integrations is reviewing it. You will see the answer here. Nothing to do.',
          }
        : {
            label: `With ${owner}`,
            tone: 'neutral',
            explain: `${owner} decides. If they do not answer within 30 days, you can ask AEC Integrations to review it.`,
          };
    case 'accepted':
      if (c.field === 'owner') {
        return {
          label: 'Accepted',
          tone: 'ok',
          explain: 'You are now recorded as the owner and can edit the details.',
        };
      }
      return c.routed_to === 'owner'
        ? { label: 'Accepted', tone: 'ok', explain: `${owner} made the change.` }
        : {
            label: 'Accepted',
            tone: 'ok',
            explain: 'AEC Integrations agreed. The listing updates with the next catalog refresh.',
          };
    case 'declined': {
      const closes = c.decided_at ? addDays(c.decided_at, 30) : null;
      return {
        label: `Declined by ${c.routed_to === 'owner' ? owner : 'AEC Integrations'}`,
        tone: 'neutral',
        explain:
          c.routed_to === 'owner' && closes
            ? `The listing stays as it is. You can ask AEC Integrations to review it until ${formatDay(closes)}.`
            : 'The listing stays as it is.',
      };
    }
    case 'withdrawn':
      return {
        label: 'Withdrawn by you',
        tone: 'neutral',
        explain: 'You cancelled this request. Nothing changed.',
      };
  }
}

export function requestEvents(c: VendorContest): readonly RequestEvent[] {
  const owner = c.owner_vendor?.name ?? 'the owner';
  const to = c.routed_to === 'aeci' ? 'AEC Integrations' : `${owner}, the owner at the time`;
  const events: RequestEvent[] = [
    { at: c.created_at, text: `You sent it to ${to}.`, note: c.reason, noteBy: 'Your reason' },
  ];
  if (c.status === 'withdrawn') {
    events.push({ at: c.updated_at, text: 'You withdrew it.', note: null, noteBy: null });
  }
  if ((c.status === 'accepted' || c.status === 'declined') && c.decided_at) {
    const who = c.routed_to === 'aeci' ? 'AEC Integrations' : owner;
    events.push({
      at: c.decided_at,
      text: `${who} ${c.status === 'accepted' ? 'accepted it' : 'said no'}.`,
      note: c.decision_note,
      noteBy: `${who}'s note`,
    });
  }
  const p = c.protest;
  if (p) {
    events.push({
      at: p.protested_at,
      text: 'You asked AEC Integrations to review the answer.',
      note: p.reason,
      noteBy: 'Your reason',
    });
    if (p.replied_at) {
      events.push({
        at: p.replied_at,
        text: `${owner} replied.`,
        note: p.reply,
        noteBy: `${owner}'s reply`,
      });
    }
    if (p.decided_at && (p.status === 'upheld' || p.status === 'rejected')) {
      events.push({
        at: p.decided_at,
        text:
          p.status === 'upheld'
            ? 'AEC Integrations agreed with you.'
            : 'AEC Integrations kept the original.',
        note: p.decision_note,
        noteBy: "AEC Integrations' note",
      });
    }
  }
  return events;
}

/** A request another company sent to the viewer, as the integration's owner. */
export function isReceived(c: VendorContest): boolean {
  return c.submitter_vendor.name !== VIEWER.vendor;
}

function isOpen(c: VendorContest): boolean {
  return c.status === 'open' || c.protest?.status === 'open';
}

/** Requests the viewer sent that are still open. */
export function openRequests(i: ImIntegration): readonly VendorContest[] {
  return i.contests.filter((c) => !isReceived(c) && isOpen(c));
}

export function pastRequests(i: ImIntegration): readonly VendorContest[] {
  return i.contests.filter((c) => !isReceived(c) && !isOpen(c));
}

/** Requests other companies sent to the viewer (owner-routed). */
export function receivedOpen(i: ImIntegration): readonly VendorContest[] {
  return i.contests.filter((c) => isReceived(c) && isOpen(c));
}

export function receivedPast(i: ImIntegration): readonly VendorContest[] {
  return i.contests.filter((c) => isReceived(c) && !isOpen(c));
}

/** A received request, from the owner's seat. */
export function receivedOutcome(c: VendorContest): StatusCopy {
  const who = c.submitter_vendor.name;
  switch (c.status) {
    case 'open':
      return {
        label: 'Waiting for your decision',
        tone: 'attention',
        explain: `Accept it to change the public page now, or decline it with a reason. If you do not answer within 30 days, ${who} can ask AEC Integrations to review it.`,
      };
    case 'accepted':
      return {
        label: 'You accepted it',
        tone: 'ok',
        explain: 'The public page shows the new value.',
      };
    case 'declined':
      return {
        label: 'You declined it',
        tone: 'neutral',
        explain: c.decided_at
          ? `The listing stays as it is. ${who} can ask AEC Integrations to review your decision until ${formatDay(addDays(c.decided_at, 30))}.`
          : 'The listing stays as it is.',
      };
    case 'withdrawn':
      return { label: `Withdrawn by ${who}`, tone: 'neutral', explain: 'Nothing changed.' };
  }
}

export function receivedEvents(c: VendorContest): readonly RequestEvent[] {
  const who = c.submitter_vendor.name;
  const events: RequestEvent[] = [
    {
      at: c.created_at,
      text: `${who} sent it to you.`,
      note: c.reason,
      noteBy: `${possessive(who)} reason`,
    },
  ];
  if ((c.status === 'accepted' || c.status === 'declined') && c.decided_at) {
    events.push({
      at: c.decided_at,
      text: c.status === 'accepted' ? 'You accepted it.' : 'You declined it.',
      note: c.decision_note,
      noteBy: 'Your note',
    });
  }
  if (c.status === 'withdrawn')
    events.push({ at: c.updated_at, text: `${who} withdrew it.`, note: null, noteBy: null });
  return events;
}

/** Rows another company added that the viewer has not answered yet. */
export function addedByThem(i: ImIntegration): readonly ImFlow[] {
  if (i.retired || isConnector(i)) return [];
  return i.flows.filter((f) => f.addedBy === 'them' && f.mine === null);
}

/** Rows the viewer added that the other company has not answered yet. */
export function addedByYou(i: ImIntegration): readonly ImFlow[] {
  if (i.retired || isConnector(i) || i.ownsBoth) return [];
  return i.flows.filter((f) => f.addedBy === 'you' && f.theirs === null);
}

export function addedItemId(flowId: string): string {
  return `im-req-added-${flowId}`;
}

// ─── The one status per integration, and what needs you ──────────────────────

export type SectionKey = 'overview' | 'shared' | 'links' | 'requests' | 'settings';

export interface NeedItem {
  readonly text: string;
  readonly section: SectionKey;
  /** The element id the item links to (a row, a data row, or a change request). */
  readonly target: string;
  /** true: the user has to act. false: waiting on someone else, shown for context. */
  readonly yours: boolean;
}

export function needs(i: ImIntegration): readonly NeedItem[] {
  const items: NeedItem[] = [];
  if (i.retired) return items;
  for (const f of disputes(i)) {
    if (f.kept) continue;
    items.push({
      text: `${i.other.vendor} disagrees about ${f.whatInSentence}`,
      section: 'requests',
      target: disputeItemId(f.id),
      yours: true,
    });
  }
  for (const f of addedByThem(i)) {
    items.push({
      text: `${i.other.vendor} added ${f.whatInSentence}. Is this right?`,
      section: 'requests',
      target: addedItemId(f.id),
      yours: true,
    });
  }
  for (const c of receivedOpen(i)) {
    items.push({
      text: `${c.submitter_vendor.name} asked to change ${fieldLabel(c.field).toLowerCase()}`,
      section: 'requests',
      target: requestItemId(c.id),
      yours: true,
    });
  }
  const toAnswer = i.flows.filter((f) => {
    const s = flowStatus(f, i);
    return s.needsYou && s.tone !== 'conflict' && !(f.addedBy === 'them' && f.mine === null);
  });
  if (toAnswer.length > 0) {
    items.push({
      text: `${toAnswer.length === 1 ? '1 row' : `${toAnswer.length} rows`} of data ${toAnswer.length === 1 ? 'needs' : 'need'} your answer`,
      section: 'shared',
      target: flowRowId(toAnswer[0].id),
      yours: true,
    });
  }
  if (i.owner.state === 'you-unclaimed') {
    items.push({
      text: 'You can claim this integration',
      section: 'overview',
      target: rowId('owner'),
      yours: true,
    });
  }
  if (i.owner.state === 'none' && !openOwnerRequest(i)) {
    items.push({
      text: 'No owner is recorded. Ask to be recorded as the owner',
      section: 'overview',
      target: rowId('owner'),
      yours: true,
    });
  }
  for (const c of openRequests(i)) {
    items.push({
      text: `Your request to change ${fieldLabel(c.field).toLowerCase()} is with ${c.routed_to === 'aeci' || c.protest ? 'AEC Integrations' : (c.owner_vendor?.name ?? 'the owner')}`,
      section: 'requests',
      target: requestItemId(c.id),
      yours: false,
    });
  }
  return items;
}

export function integrationStatus(i: ImIntegration): StatusCopy {
  if (i.retired) {
    return {
      label: 'Retired',
      tone: 'neutral',
      explain: 'It is hidden from the public page. Restore it from Settings to show it again.',
    };
  }
  const statuses = i.flows.map((f) => flowStatus(f, i));
  const conflicts = statuses.filter((s) => s.tone === 'conflict').length;
  if (conflicts > 0) {
    return {
      label: 'Disagreement open',
      tone: 'conflict',
      explain: `${i.other.vendor} disagrees with one of your answers. It is open in Change requests.`,
    };
  }
  const toAnswer = statuses.filter((s) => s.needsYou).length;
  if (toAnswer > 0) {
    return {
      label: 'Needs your answer',
      tone: 'attention',
      explain: `${toAnswer === 1 ? '1 thing' : `${toAnswer} things`} in What's shared ${toAnswer === 1 ? 'needs' : 'need'} a yes or a no from you.`,
    };
  }
  const received = receivedOpen(i).length;
  if (received > 0 || addedByThem(i).length > 0) {
    return {
      label: 'Needs your decision',
      tone: 'attention',
      explain:
        received > 0
          ? `${received === 1 ? 'A company has' : `${received} requests have`} asked you to change a detail. Accept or decline it in Change requests.`
          : `${i.other.vendor} added data. Tell them whether it is right in Change requests.`,
    };
  }
  if (i.owner.state === 'you-unclaimed') {
    return {
      label: 'Ready to claim',
      tone: 'attention',
      explain: 'You are recorded as the owner. Claim it to edit the details yourself.',
    };
  }
  if (i.owner.state === 'none' && !openOwnerRequest(i)) {
    return {
      label: 'No owner yet',
      tone: 'attention',
      explain:
        'No company is recorded as the owner. If you offer it, ask to be recorded as the owner.',
    };
  }
  const open = openRequests(i);
  if (open.length > 0) {
    const withOwner = open.some((c) => c.routed_to === 'owner' && !c.protest);
    return {
      label: withOwner
        ? `Waiting on ${open[0].owner_vendor?.name ?? 'the owner'}`
        : 'Waiting on AEC Integrations',
      tone: 'neutral',
      explain: 'You asked for a correction and it is being reviewed. Nothing else needs you.',
    };
  }
  if (isConnector(i)) {
    return {
      label: 'AEC Integrations maintained',
      tone: 'neutral',
      explain: `This runs through ${i.how.connector}, so AEC Integrations maintains it. Request a correction if something is wrong.`,
    };
  }
  return { label: 'All up to date', tone: 'ok', explain: 'Nothing needs you right now.' };
}

export function publicPageHref(i: ImIntegration): string {
  return `/products/${VIEWER.productSlug}/integrations/${i.other.slug}`;
}

// ─── Open-request markers and link targets ───────────────────────────────────

export function rowId(field: string): string {
  return `im-row-${field}`;
}
export function flowRowId(flowId: string): string {
  return `im-flow-${flowId}`;
}
export function requestItemId(contestId: string): string {
  return `im-req-${contestId}`;
}
export function disputeItemId(flowId: string): string {
  return `im-req-dispute-${flowId}`;
}

const SHORT_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
export function shortDay(iso: string): string {
  return SHORT_DAY.format(new Date(iso));
}

/** The open request on one field, if there is one. */
export function openContestFor(
  i: ImIntegration,
  field: IntegrationContestField,
): VendorContest | null {
  return openRequests(i).find((c) => c.field === field) ?? null;
}

/**
 * Rows the two companies disagree about. In the data model these are claims
 * whose agreement is conflict (attestations), not field contests. The Change
 * requests list shows them beside the contests; that merge is client-side.
 */
export function disputes(i: ImIntegration): readonly ImFlow[] {
  if (i.retired || isConnector(i)) return [];
  return i.flows.filter((f) => flowStatus(f, i).tone === 'conflict');
}

export function disputeRaised(f: ImFlow): string {
  return f.disputedAt ?? PREVIEW_NOW;
}

export function disputeReviewDay(f: ImFlow): string {
  return formatDay(addDays(disputeRaised(f), OPEN_CONFLICT_DAYS));
}

export function disputeTitle(f: ImFlow, i: ImIntegration): string {
  if (f.mine === 'no')
    return `${f.what}: you say ${reasonSummary(f, i)}, ${i.other.vendor} says it is right`;
  return `${f.what}: ${i.other.vendor} ${f.disputeSummary ?? 'says this is wrong'}`;
}

export function contestFlagText(c: VendorContest): string {
  return `Change requested ${shortDay(c.created_at)}: ${requestValue(c, 'current')} → ${requestValue(c, 'proposed')}. ${requestOutcome(c).label}. Select the flag to see the request.`;
}

export function disputeFlagText(f: ImFlow, i: ImIntegration): string {
  return `Disputed ${shortDay(disputeRaised(f))}: ${disputeTitle(f, i)}. AEC Integrations reviews it after ${disputeReviewDay(f)}. Select the flag to see it in Change requests.`;
}

/** Everything a search over one contest should match. */
export function contestSearchText(c: VendorContest): string {
  const p = c.protest;
  return [
    fieldLabel(c.field),
    requestValue(c, 'current'),
    requestValue(c, 'proposed'),
    c.reason,
    c.decision_note,
    requestOutcome(c).label,
    c.owner_vendor?.name,
    p?.reason,
    p?.reply,
    p?.decision_note,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
}

export function disputeSearchText(f: ImFlow, i: ImIntegration): string {
  return ['Disagreement', 'Disputed', disputeTitle(f, i), f.theirNote, f.myNote, i.other.vendor]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
}

/** What the viewer says is wrong, as it reads after "you say". */
export function reasonSummary(flow: ImFlow, i: ImIntegration): string {
  const r = flow.myReason;
  if (r?.kind === 'not-shared') return `${flow.whatInSentence} are not shared at all`;
  if (r?.kind === 'direction' && r.suggested) {
    const d = directionShort(r.suggested, i.other.name);
    return `the direction should be ${d.charAt(0).toLowerCase()}${d.slice(1)}`;
  }
  return 'this is wrong';
}

/** Tooltip lines for a row's status: both companies' reasons, then what it means. */
export function statusLines(flow: ImFlow, i: ImIntegration): readonly string[] {
  const s = flowStatus(flow, i);
  const lines: string[] = [];
  if (flow.mine === 'no') lines.push(`You say ${reasonSummary(flow, i)}.`);
  if (flow.myNote) lines.push(`Your reason: ${flow.myNote}`);
  if (flow.theirNote) lines.push(`${possessive(i.other.vendor)} reason: ${flow.theirNote}`);
  lines.push(s.explain);
  return lines;
}

/** "RFIs are shared both ways", mid-sentence (keeps acronyms intact). */
export function flowClause(flow: ImFlow, i: ImIntegration): string {
  switch (flow.direction) {
    case 'outbound':
      return `${flow.whatInSentence} are sent to ${i.other.name}`;
    case 'inbound':
      return `${flow.whatInSentence} come from ${i.other.name}`;
    case 'both':
      return `${flow.whatInSentence} are shared both ways`;
  }
}

/** "Procore Technologies' note", "Bluebeam's note". */
export function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}
