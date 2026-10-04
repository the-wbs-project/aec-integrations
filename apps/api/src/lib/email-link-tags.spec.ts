/**
 * Every link in every transactional email carries the AECI-1209 tag.
 *
 * Renders EVERY `EmailTemplate` id through its real helper, against the in-memory D1
 * harness so the send ledger hands out real `notification_sends.id` values. Resend is
 * a stubbed fetch, so no mail leaves. Then it reads every URL out of the request body:
 *
 *   - the HTML, unescaped first: `<a href>`, the Outlook VML `v:roundrect href`, the
 *     pasteable URL row, linked table values, image sources
 *   - the text part
 *   - the headers (`List-Unsubscribe`)
 *
 * Each site URL must carry `utm_source=email`, `utm_campaign=<template id>` and
 * `n=<the ledger row id of this send>`. An opt-out page, an `/api/*` link, an image,
 * a `mailto:` and any off-origin URL must carry none of the three.
 *
 * `FIXTURES` is typed `Record<EmailTemplate, …>`, and a runtime check compares it to
 * the registry, so a template added without a fixture fails here.
 */

import { asc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { Db } from '../db/client';
import { notificationSends } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { adminRequestUrl } from './request-links';
import {
  sendAccountDeletionEmail,
  sendAttestationDigestEmail,
  sendAttestationOpsDigestEmail,
  sendClaimApprovedEmail,
  sendClaimRejectedEmail,
  sendClaimSubmittedNotification,
  sendContestDeclinedProtestWindowEmail,
  sendContestProtestOpenedEmail,
  sendContestProtestReplyReminderEmail,
  sendContestSubmittedNotification,
  sendEntitlementExpiringAdminEmail,
  sendEntitlementExpiringEmail,
  sendLandingFeedbackNotification,
  sendLandingSignupNotification,
  sendMailingListWelcomeEmail,
  sendProtestSubmittedAlert,
  sendReviewApprovedEmail,
  sendReviewRejectedEmail,
  sendReviewSubmittedAlert,
  sendReviewSubmittedEmail,
  sendStaleClaimTicketAlert,
  sendStuckRequestAdminAlert,
  sendTransactionalEmail,
  sendVendorReviewPublishedEmail,
  sendVendorSeatInviteEmail,
  type EmailContext,
  type EmailOutcome,
  type EmailTemplate,
  type SubmittedReviewSummary,
} from './email';
import { EMAIL_LOGO_URL } from './email-layout';
import { EMAIL_LINK_PARAMS, isUntaggedPath } from './notifications/link-tag';
import { NOTIFICATIONS } from './notifications/registry';
import { ledgerDb } from './notifications/send-ledger';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

vi.mock('./notifications/send-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notifications/send-ledger')>();
  return { ...actual, ledgerDb: vi.fn(() => null) };
});

const SITE = 'https://www.aecintegrations.com';
const ORIGIN = new URL(SITE).origin;

let t: TestDb;
let fetchSpy: MockInstance;
let resendIds = 0;
beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ id: `re_${++resendIds}` })));
});
afterEach(() => {
  vi.restoreAllMocks();
  t.dispose();
});

function ctx(env: Partial<Env> = {}): EmailContext {
  return {
    env: {
      ENV: 'production',
      POSTHOG_PROJECT_KEY: undefined,
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
      PUBLIC_SITE_URL: SITE,
      SUPPORT_EMAIL: 'support@aecintegrations.com',
      EMAIL_BCC: 'ops@aecintegrations.com',
      ...env,
    } as Env,
    executionCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
    req: { raw: new Request('https://api.test/x', { method: 'POST' }) },
  } as unknown as Context<{ Bindings: Env }>;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REVIEW: SubmittedReviewSummary = {
  reviewId: 'rev-1',
  productName: 'Revit',
  productSlug: 'revit',
  ratingOverall: 4,
  ratingOnboarding: 3,
  title: 'Solid',
  body: 'Works well with our stack.',
  roleAtCompany: 'practitioner',
  reviewerFirm: 'Acme',
  yearsUsing: 2,
  wouldRecommend: 'yes',
};

const CONTEST = {
  contestId: 'ct-1',
  integrationName: 'Revit to MicroStation',
  field: 'direction',
  currentValue: 'a_to_b',
  proposedValue: 'bidirectional',
  pairSlugs: ['revit', 'microstation'] as const,
};

const SEAT = {
  to: 'seat@vendor.example',
  vendorId: 'v-1',
  vendorSlug: 'bentley',
  vendorName: 'Bentley',
};

/** An on-site referrer: a recorded fact, shown as it came, never tagged. */
const REFERRER = `${SITE}/products/revit?utm_source=linkedin`;

interface Fixture {
  send: (c: EmailContext) => Promise<EmailOutcome>;
  /** Whether the email has at least one taggable site link. */
  links: boolean;
  /** Site URLs that are recorded facts, not links we built, and stay as they came. */
  verbatim?: readonly string[];
}

const FIXTURES: Record<EmailTemplate, Fixture> = {
  'review-submitted': {
    links: true,
    send: (c) => sendReviewSubmittedEmail(c, { to: 'r@example.com', review: REVIEW }),
  },
  'review-submitted-alert': {
    links: true,
    send: (c) =>
      sendReviewSubmittedAlert(c, {
        review: REVIEW,
        reviewerEmail: 'r@example.com',
        toxicityScore: 0.1,
      }),
  },
  'review-approved': {
    links: true,
    send: (c) =>
      sendReviewApprovedEmail(c, {
        to: 'r@example.com',
        productName: 'Revit',
        productSlug: 'revit',
      }),
  },
  'review-rejected': {
    links: true,
    send: (c) =>
      sendReviewRejectedEmail(c, {
        to: 'r@example.com',
        productName: 'Revit',
        reason: 'Too short',
      }),
  },
  'vendor-review-published': {
    links: true,
    send: (c) =>
      sendVendorReviewPublishedEmail(c, {
        to: 'seat@vendor.example',
        vendorSlug: 'autodesk',
        reviewId: 'rev-1',
        productName: 'Revit',
        productSlug: 'revit',
        title: 'Solid',
        ratingOverall: 4,
        ratingOnboarding: 3,
        dedupeKey: 'vendor-review-published:rev-1:p-1',
      }),
  },
  'account-deleted': {
    links: false,
    send: (c) => sendAccountDeletionEmail(c, { to: 'r@example.com' }),
  },
  'mailing-list-welcome': {
    links: true,
    send: (c) => sendMailingListWelcomeEmail(c, { to: 'sub@example.com', token: 'tok-123' }),
  },
  'mailing-list-welcome-operator-copy': {
    links: true,
    send: (c) => sendMailingListWelcomeEmail(c, { to: 'sub@example.com', token: 'tok-123' }),
  },
  'landing-signup': {
    links: true,
    verbatim: [REFERRER],
    send: (c) =>
      sendLandingSignupNotification(c, {
        email: 'sub@example.com',
        city: 'Austin',
        region: 'TX',
        country: 'US',
        asOrganization: 'Acme',
        utmSource: 'linkedin',
        utmCampaign: null,
        referrer: REFERRER,
      }),
  },
  'landing-feedback': {
    links: true,
    verbatim: [REFERRER],
    send: (c) =>
      sendLandingFeedbackNotification(c, {
        email: 'f@example.com',
        features: 'More filters',
        tools: 'Revit',
        subscribed: true,
        city: null,
        region: null,
        country: null,
        referrer: REFERRER,
      }),
  },
  'claim-submitted-alert': {
    links: true,
    send: (c) =>
      sendClaimSubmittedNotification(c, {
        requestId: 'req-1',
        targetName: 'Bentley',
        targetType: 'vendor',
        slug: 'bentley',
        submitterEmail: 'claimant@bentley.example',
        submitterName: 'Pat',
        submitterRole: 'Product manager',
        submitterLinkedinUrl: 'https://www.linkedin.com/in/pat',
        domainMatch: 'match',
        duplicateOfRequestId: null,
        linearIssueUrl: 'https://linear.app/aeci/issue/AECI-1',
      }),
  },
  'contest-submitted-alert': {
    links: true,
    send: (c) =>
      sendContestSubmittedNotification(c, {
        ...CONTEST,
        reason: 'It is two-way',
        submitterVendorName: 'Autodesk',
        routeReason: 'unclaimed',
      }),
  },
  'protest-submitted-alert': {
    links: true,
    send: (c) =>
      sendProtestSubmittedAlert(c, {
        ...CONTEST,
        submitterVendorName: 'Autodesk',
        ownerVendorName: 'Bentley',
        basis: 'declined',
        protestReason: 'They are wrong',
        evidenceCount: 2,
        replyDueAt: '2026-10-16T14:30:00.000Z',
        dedupeKey: 'protest-submitted-alert:ct-1:t',
      }),
  },
  'contest-protest-opened': {
    links: true,
    send: (c) =>
      sendContestProtestOpenedEmail(c, {
        ...CONTEST,
        ...SEAT,
        submitterVendorName: 'Autodesk',
        basis: 'silence',
        protestReason: 'No answer',
        replyDueAt: '2026-10-16T14:30:00.000Z',
        dedupeKey: 'contest-protest-opened:ct-1:t:p',
      }),
  },
  'contest-protest-reply-reminder': {
    links: true,
    send: (c) =>
      sendContestProtestReplyReminderEmail(c, {
        ...CONTEST,
        ...SEAT,
        submitterVendorName: 'Autodesk',
        replyDueAt: '2026-10-16T14:30:00.000Z',
        dedupeKey: 'contest-protest-reply-reminder:ct-1:t:p',
      }),
  },
  'contest-declined-protest-window': {
    links: true,
    send: (c) =>
      sendContestDeclinedProtestWindowEmail(c, {
        ...CONTEST,
        ...SEAT,
        ownerVendorName: 'Autodesk',
        decisionNote: 'It is one-way',
        protestClosesAt: '2026-11-01T14:30:00.000Z',
        dedupeKey: 'contest-declined-protest-window:ct-1:p',
      }),
  },
  'claim-approved': {
    links: true,
    send: (c) =>
      sendClaimApprovedEmail(c, {
        to: 'claimant@bentley.example',
        vendorName: 'Bentley',
        invited: true,
        plan: 'free',
      }),
  },
  'claim-rejected': {
    links: false,
    send: (c) =>
      sendClaimRejectedEmail(c, { to: 'claimant@bentley.example', vendorName: 'Bentley' }),
  },
  'vendor-seat-invite': {
    links: true,
    send: (c) =>
      sendVendorSeatInviteEmail(c, {
        to: 'new@bentley.example',
        vendorName: 'Bentley',
        invitedByName: 'Pat',
        token: 'inv-tok',
        expiresAt: '2026-10-16T00:00:00.000Z',
        notification: 'vendor-seat-invite',
      }),
  },
  'vendor-seat-invite-resend': {
    links: true,
    send: (c) =>
      sendVendorSeatInviteEmail(c, {
        to: 'new@bentley.example',
        vendorName: 'Bentley',
        invitedByName: null,
        token: 'inv-tok',
        expiresAt: '2026-10-16T00:00:00.000Z',
        notification: 'vendor-seat-invite-resend',
      }),
  },
  'stuck-request-alert': {
    links: true,
    send: (c) =>
      sendStuckRequestAdminAlert(c, {
        to: 'support@aecintegrations.com',
        rows: [
          {
            requestId: 'req-1',
            kind: 'claim',
            targetType: 'product',
            targetName: 'Revit',
            targetSlug: 'revit',
            ageMinutes: 90,
            retried: true,
            reason: 'timeout',
          },
        ],
      }),
  },
  'stale-claim-ticket-alert': {
    links: true,
    send: (c) =>
      sendStaleClaimTicketAlert(c, {
        to: 'founder@aecintegrations.com',
        rows: [
          {
            requestId: 'req-1',
            kind: 'claim',
            identifier: 'AECI-1',
            title: 'Claim Bentley',
            issueUrl: 'https://linear.app/aeci/issue/AECI-1',
            adminUrl: adminRequestUrl(c.env, 'claim', 'req-1'),
            stateName: 'Backlog',
            submitterEmail: 'claimant@bentley.example',
            targetName: 'Bentley',
            ageMinutes: 1500,
          },
        ],
      }),
  },
  'attestation-digest': {
    links: true,
    send: (c) =>
      sendAttestationDigestEmail(c, {
        to: 'seat@vendor.example',
        vendorId: 'v-1',
        vendorName: 'Bentley',
        findings: [
          {
            detector: 'silent-counterparty',
            dataObject: 'RFIs',
            product: 'MicroStation',
            counterpart: 'Revit',
            mechanismName: 'Connector',
            pairSlugs: ['microstation', 'revit'],
          },
        ],
        muteToken: 'mute-tok',
        dedupeKey: 'attestation-digest:v-1:p:2026-10-02',
      }),
  },
  'attestation-ops-digest': {
    links: true,
    send: (c) =>
      sendAttestationOpsDigestEmail(c, {
        to: 'support@aecintegrations.com',
        findings: [
          {
            detector: 'claim-denied',
            dataObject: 'RFIs',
            productA: 'Revit',
            productB: 'MicroStation',
            mechanismName: null,
            claimId: 'cl-1',
            integrationId: 'int-1',
            pairSlugs: ['revit', 'microstation'],
          },
        ],
        dedupeKey: 'attestation-ops-digest:2026-10-02:h',
      }),
  },
  'entitlement-expiring': {
    links: true,
    send: (c) =>
      sendEntitlementExpiringEmail(c, {
        to: 'seat@vendor.example',
        vendorName: 'Bentley',
        periodEndDay: '2026-11-01',
        daysRemaining: 30,
      }),
  },
  'entitlement-expiring-admin': {
    links: false,
    send: (c) =>
      sendEntitlementExpiringAdminEmail(c, {
        to: 'support@aecintegrations.com',
        vendorName: 'Bentley',
        vendorSlug: 'bentley',
        tier: 'managed',
        periodEndDay: '2026-11-01',
        daysRemaining: 30,
        payer: null,
        invoiceRef: null,
        vendorNotice: 'sent',
      }),
  },
};

// ─── URL extraction ─────────────────────────────────────────────────────────────

function unescapeHtml(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Every `attr="…"` value, unescaped. */
function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`\\b${attr}="([^"]*)"`, 'g'))].map((m) =>
    unescapeHtml(m[1]!),
  );
}

/** Every http(s) URL in a run of text, without trailing sentence punctuation. */
function textUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"]+/g)].map((m) => m[0].replace(/[.,;:)]+$/, ''));
}

interface Captured {
  html: string;
  text: string;
  headers: Record<string, string>;
}

/** The Resend request a fixture made for `id`: the operator copy is the `COPY:` one. */
function captured(id: EmailTemplate): Captured {
  const bodies = fetchSpy.mock.calls.map(
    (call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
  );
  const isCopy = (b: Record<string, unknown>) => String(b.subject).startsWith('COPY: ');
  const body = bodies.find((b) => (id.endsWith('-operator-copy') ? isCopy(b) : !isCopy(b)));
  expect(body, `no Resend request for ${id}`).toBeDefined();
  return {
    html: String(body!.html ?? ''),
    text: String(body!.text ?? ''),
    headers: (body!.headers ?? {}) as Record<string, string>,
  };
}

const hasNoTag = (url: URL) => EMAIL_LINK_PARAMS.every((p) => !url.searchParams.has(p));

/** Running totals across the fixtures, so the exclusion checks cannot pass vacuously. */
const seen = { untaggedSitePaths: 0, offOrigin: 0, mailto: 0, images: 0, headers: 0 };

// ─── The tests ────────────────────────────────────────────────────────────────

describe('every transactional email template tags its site links (AECI-1209)', () => {
  it('has a fixture for every registry template, and nothing else', () => {
    const registry = Object.entries(NOTIFICATIONS)
      .filter(
        ([id, e]) =>
          (e.channel === 'email' || e.channel === 'email+portal') && !id.startsWith('digest-'),
      )
      .map(([id]) => id)
      .sort();
    expect(Object.keys(FIXTURES).sort()).toEqual(registry);
  });

  it.each(Object.keys(FIXTURES) as EmailTemplate[])('%s', async (id) => {
    const fixture = FIXTURES[id];
    expect(await fixture.send(ctx())).toBe('sent');
    const { html, text, headers } = captured(id);

    // The send's own ledger row. The operator copy has no row before its send, one
    // Resend call to the whole operator list, so its links carry no `n`.
    const operatorCopy = id.endsWith('-operator-copy');
    const ledger = await t.db
      .select()
      .from(notificationSends)
      .where(eq(notificationSends.notificationId, id))
      .orderBy(asc(notificationSends.id));
    expect(ledger.length).toBeGreaterThan(0);
    const expectedN = operatorCopy ? null : String(ledger[0]!.id);

    // Images: never tagged. The house layout carries the logo, which is on our own
    // origin, so it is the case that matters. The legacy layout has no image.
    const images = attrValues(html, 'src');
    if (html.includes('<img')) expect(images).toContain(EMAIL_LOGO_URL);
    for (const src of images) expect(hasNoTag(new URL(src))).toBe(true);
    seen.images += images.length;

    // mailto: never tagged.
    for (const href of attrValues(html, 'href').filter((h) => h.startsWith('mailto:'))) {
      expect(href).not.toMatch(/utm_|[?&]n=/);
      seen.mailto++;
    }

    // Headers (List-Unsubscribe): never tagged.
    for (const value of Object.values(headers)) {
      expect(value).not.toMatch(/utm_|[?&]n=/);
      seen.headers++;
      if (value.includes('mailto:')) seen.mailto++;
    }

    // Every http(s) URL anywhere in the HTML (hrefs, VML, the pasteable row, linked
    // table values) and in the text part, minus image sources.
    const urls = [...textUrls(unescapeHtml(html)), ...textUrls(text)].filter(
      (u) => !images.includes(u),
    );
    let tagged = 0;
    for (const raw of urls) {
      const url = new URL(raw);
      if (url.origin !== ORIGIN) {
        expect(hasNoTag(url), `${id}: off-origin ${raw} was tagged`).toBe(true);
        seen.offOrigin++;
        continue;
      }
      if (fixture.verbatim?.includes(raw)) continue;
      if (isUntaggedPath(url.pathname)) {
        expect(hasNoTag(url), `${id}: opt-out ${raw} was tagged`).toBe(true);
        seen.untaggedSitePaths++;
        continue;
      }
      expect(url.searchParams.getAll('utm_source'), `${id}: ${raw}`).toEqual(['email']);
      expect(url.searchParams.getAll('utm_campaign'), `${id}: ${raw}`).toEqual([id]);
      expect(url.searchParams.getAll('n'), `${id}: ${raw}`).toEqual(
        expectedN === null ? [] : [expectedN],
      );
      tagged++;
    }
    if (fixture.links) expect(tagged, `${id}: no tagged link found`).toBeGreaterThan(0);
    else expect(tagged).toBe(0);

    // A recorded fact stays exactly as it came.
    for (const fact of fixture.verbatim ?? []) expect(text).toContain(fact);
  });

  it('the exclusion checks above saw real cases', () => {
    // Opt-out pages (`/unsubscribe`, `/notifications/mute`), an off-origin link
    // (Linear, LinkedIn), the logo and List-Unsubscribe. No template carries a mailto
    // since AECI-1220 dropped the welcome's `unsubscribe@`, so `seen.mailto` is not
    // asserted. `link-tag.spec.ts` covers the mailto rule directly.
    expect(seen.untaggedSitePaths).toBeGreaterThan(0);
    expect(seen.offOrigin).toBeGreaterThan(0);
    expect(seen.images).toBeGreaterThan(0);
    expect(seen.headers).toBeGreaterThan(0);
  });
});

describe('the CTA shows one tagged URL everywhere (AECI-1209)', () => {
  it('the button, its VML twin, the pasteable row and the text part all match', async () => {
    await FIXTURES['claim-approved'].send(ctx());
    const { html, text } = captured('claim-approved');
    const [row] = await t.db.select().from(notificationSends);
    const expected = `${SITE}/vendor?utm_source=email&utm_campaign=claim-approved&n=${row!.id}`;

    // `<a href>` and `v:roundrect href`, escaped once.
    const escaped = expected.replace(/&/g, '&amp;');
    expect(html.split(`href="${escaped}"`)).toHaveLength(3);
    // The pasteable row.
    expect(html).toContain(`word-break:break-all">${escaped}</div>`);
    // The text part.
    expect(text).toContain(`Go to your vendor portal: ${expected}`);
    // Never double-escaped.
    expect(html).not.toContain('&amp;amp;');
  });
});

describe('the ledger row id is the n in the links (AECI-1209 + AECI-1202)', () => {
  it('two sends of one template get two rows, and each email names its own', async () => {
    await FIXTURES['review-approved'].send(ctx());
    await FIXTURES['review-approved'].send(ctx());
    const rows = await t.db.select().from(notificationSends).orderBy(asc(notificationSends.id));
    expect(rows.map((r) => r.outcome)).toEqual(['sent', 'sent']);
    const ns = fetchSpy.mock.calls.map((call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as { text: string };
      return new URL(textUrls(body.text)[0]!).searchParams.get('n');
    });
    expect(ns).toEqual(rows.map((r) => String(r.id)));
  });

  it('a ledger that fails open still sends, tagged with both utm params and no n', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(ledgerDb).mockReturnValue({
      insert: () => {
        throw new Error('D1_ERROR');
      },
      update: () => {
        throw new Error('D1_ERROR');
      },
    } as unknown as Db);

    expect(await FIXTURES['claim-approved'].send(ctx())).toBe('sent');
    const { text } = captured('claim-approved');
    expect(text).toContain(`${SITE}/vendor?utm_source=email&utm_campaign=claim-approved\n`);
  });

  it('a duplicate makes no fetch, so nothing is rendered for it', async () => {
    const render = vi.fn(() => ({ text: 'x' }));
    const input = {
      to: 'r@example.com',
      subject: 'Hi',
      template: 'claim-approved' as const,
      render,
      dedupeKey: 'k',
    };
    await sendTransactionalEmail(ctx(), input);
    fetchSpy.mockClear();
    render.mockClear();

    expect(await sendTransactionalEmail(ctx(), input)).toBe('duplicate');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('a render that throws fails the send, releases the key and never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = await sendTransactionalEmail(ctx(), {
      to: 'r@example.com',
      subject: 'Hi',
      template: 'claim-approved',
      dedupeKey: 'k',
      render: () => {
        throw new Error('boom');
      },
    });
    expect(outcome).toBe('failed');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await t.db.select().from(notificationSends)).toEqual([
      expect.objectContaining({ outcome: 'failed', dedupeKey: null }),
    ]);
  });

  it('the Idempotency-Key ignores n, so Resend still dedupes across a ledger outage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const keyed = (c: EmailContext) =>
      sendReviewApprovedEmail(c, {
        to: 'r@example.com',
        productName: 'Revit',
        productSlug: 'revit',
        dedupeKey: 'review-approved:rev-1',
      });

    // Attempt 1: the ledger is down, so the links carry no n.
    vi.mocked(ledgerDb).mockReturnValueOnce({
      insert: () => {
        throw new Error('D1_ERROR');
      },
      update: () => {
        throw new Error('D1_ERROR');
      },
    } as unknown as Db);
    await keyed(ctx());
    // Attempt 2: the ledger is back, so the links carry this attempt's row id.
    await keyed(ctx());

    const calls = fetchSpy.mock.calls.map((call) => call[1] as RequestInit);
    const keys = calls.map((init) => (init.headers as Record<string, string>)['Idempotency-Key']);
    const texts = calls.map((init) => (JSON.parse(String(init.body)) as { text: string }).text);
    expect(texts[0]).not.toBe(texts[1]);
    expect(texts[1]).toMatch(/[?&]n=\d+/);
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
  });
});
