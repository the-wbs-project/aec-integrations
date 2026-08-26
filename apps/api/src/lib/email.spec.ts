/**
 * Unit coverage for the email transport (`lib/email.ts`).
 *
 * Two layers, two suites:
 *   - Transactional templates (AECI-240): every send NEVER throws and resolves to
 *     an `EmailOutcome`. Absent `RESEND_API_KEY`/`EMAIL_FROM` or empty recipient →
 *     silent `'skipped'` (no fetch); 2xx → `'sent'`; non-2xx/network/timeout →
 *     `'failed'` (logged, never thrown). Each template helper POSTs the right
 *     `to`/subject/body. Global `fetch` is stubbed; `DD_API_KEY` is unset so the
 *     `warn`/metric paths are no-ops. Mirrors `toxicity.spec.ts`.
 *   - Low-level transport (AECI-241): `sendEmail` + `parseRecipients` with a faked
 *     `fetch` — skip/sent/failed outcomes and the never-throw guarantee.
 */

import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { submitCount } from '../posthog';
import type { Env } from '../env';
import {
  parseRecipients,
  sendAccountDeletionEmail,
  sendAttestationOpenConflictEmail,
  sendAttestationOpsAlertEmail,
  sendAttestationSilentCounterpartyEmail,
  sendAttestationStaleVersionEmail,
  sendClaimApprovedEmail,
  sendClaimRejectedEmail,
  sendClaimSubmittedNotification,
  sendEmail,
  sendEntitlementExpiringAdminEmail,
  sendEntitlementExpiringEmail,
  sendMailingListWelcomeEmail,
  sendReviewApprovedEmail,
  sendReviewRejectedEmail,
  sendReviewSubmittedEmail,
  sendStuckRequestAdminAlert,
  sendTransactionalEmail,
  type EmailContext,
} from './email';

// The `aeci.email.send` count + the `warn` log ride the shared transport; mock it
// so we can assert per-branch outcome tags without a real Datadog intake.
vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const RESEND_URL = 'https://api.resend.com/emails';

/** The tag arrays recorded for `aeci.email.send` this test. */
function sendTags(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.email.send')
    .map((call) => call[5] as string[]);
}

/** Parse the JSON body of the last `fetch` call. */
function lastBody(fetchSpy: MockInstance): Record<string, unknown> {
  const call = fetchSpy.mock.calls.at(-1);
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<
    string,
    unknown
  >;
}

/** Minimal context the client reads: env (key/sender/site) + the telemetry triple.
 *  `RESEND_API_KEY` + `EMAIL_FROM` are set by default so sends go out. */
function fakeContext(env: Partial<Env> = {}): EmailContext {
  return {
    env: {
      DD_API_KEY: undefined,
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
      ...env,
    } as Env,
    executionCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
    req: { raw: new Request('https://api.test/x', { method: 'POST' }) },
  } as unknown as Context<{ Bindings: Env }>;
}

const ok = () => new Response('{"id":"re_1"}', { status: 200 });

beforeEach(() => vi.mocked(submitCount).mockClear());
afterEach(() => vi.restoreAllMocks());

describe('sendTransactionalEmail (low-level)', () => {
  it('POSTs to Resend with Bearer auth + from/to/subject/text on a 2xx → sent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const outcome = await sendTransactionalEmail(fakeContext(), {
      to: 'r@example.com',
      subject: 'Hi',
      text: 'Body',
      html: '<p>Body</p>',
      template: 'review-submitted',
    });

    expect(outcome).toBe('sent');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(RESEND_URL);
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer rk_test');
    expect(lastBody(fetchSpy)).toMatchObject({
      from: 'AEC Integrations <notifications@aecintegrations.com>',
      to: 'r@example.com',
      subject: 'Hi',
      text: 'Body',
      html: '<p>Body</p>',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(sendTags()).toEqual([['outcome:sent', 'template:review-submitted']]);
  });

  it('skips silently (no fetch) when RESEND_API_KEY is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const outcome = await sendTransactionalEmail(fakeContext({ RESEND_API_KEY: undefined }), {
      to: 'r@example.com',
      subject: 'Hi',
      text: 'Body',
      template: 'review-submitted',
    });

    expect(outcome).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendTags()).toEqual([['outcome:skipped', 'template:review-submitted']]);
  });

  it('skips when EMAIL_FROM is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const outcome = await sendTransactionalEmail(fakeContext({ EMAIL_FROM: undefined }), {
      to: 'r@example.com',
      subject: 'Hi',
      text: 'Body',
      template: 'review-approved',
    });
    expect(outcome).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips when the recipient is empty (an unresolved address)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const outcome = await sendTransactionalEmail(fakeContext(), {
      to: '',
      subject: 'Hi',
      text: 'Body',
      template: 'review-approved',
    });
    expect(outcome).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns failed (never throws) on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 422 }));
    const outcome = await sendTransactionalEmail(fakeContext(), {
      to: 'r@example.com',
      subject: 'Hi',
      text: 'Body',
      template: 'account-deleted',
    });
    expect(outcome).toBe('failed');
    expect(sendTags()).toEqual([['outcome:failed', 'template:account-deleted']]);
  });

  it('returns failed (never throws) on a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    await expect(
      sendTransactionalEmail(fakeContext(), {
        to: 'r@example.com',
        subject: 'Hi',
        text: 'Body',
        template: 'account-deleted',
      }),
    ).resolves.toBe('failed');
  });
});

describe('sendReviewSubmittedEmail', () => {
  it('sends the "in moderation" confirmation to the reviewer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const outcome = await sendReviewSubmittedEmail(fakeContext(), { to: 'rev@example.com' });

    expect(outcome).toBe('sent');
    const body = lastBody(fetchSpy);
    expect(body.to).toBe('rev@example.com');
    expect(body.subject).toBe('Thanks — your review is in moderation');
    expect(String(body.text)).toContain('in moderation');
  });

  it('skips when the reviewer email is undefined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await sendReviewSubmittedEmail(fakeContext(), { to: undefined })).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('sendReviewApprovedEmail', () => {
  it('subjects on the product name and links to the product when PUBLIC_SITE_URL is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendReviewApprovedEmail(fakeContext({ PUBLIC_SITE_URL: 'https://aecintegrations.com' }), {
      to: 'rev@example.com',
      productName: 'Procore',
      productSlug: 'procore',
    });

    const body = lastBody(fetchSpy);
    expect(body.subject).toBe('Your review of Procore is now live');
    expect(String(body.text)).toContain('https://aecintegrations.com/products/procore');
    expect(String(body.html)).toContain('https://aecintegrations.com/products/procore');
  });

  it('omits the link (no dead host) when PUBLIC_SITE_URL is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendReviewApprovedEmail(fakeContext(), {
      to: 'rev@example.com',
      productName: 'Procore',
      productSlug: 'procore',
    });
    expect(String(lastBody(fetchSpy).text)).not.toContain('/products/');
  });
});

describe('sendReviewRejectedEmail', () => {
  it('includes the moderator reason and a needs-revision subject', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendReviewRejectedEmail(fakeContext(), {
      to: 'rev@example.com',
      productName: 'Bluebeam',
      reason: 'Please remove the profanity.',
    });

    const body = lastBody(fetchSpy);
    expect(body.subject).toBe('Your review of Bluebeam needs revision');
    expect(String(body.text)).toContain('Please remove the profanity.');
  });
});

describe('sendClaimApprovedEmail', () => {
  it('names the vendor, lists capabilities, and links to the dashboard when PUBLIC_SITE_URL is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const outcome = await sendClaimApprovedEmail(
      fakeContext({ PUBLIC_SITE_URL: 'https://aecintegrations.com' }),
      { to: 'owner@vendor.com', vendorName: 'Autodesk, Inc.', invited: false },
    );

    expect(outcome).toBe('sent');
    const body = lastBody(fetchSpy);
    expect(body.to).toBe('owner@vendor.com');
    expect(body.subject).toBe('Your claim for Autodesk, Inc. is approved');
    const text = String(body.text);
    expect(text).toContain('now verified');
    expect(text).toContain('data corrections');
    expect(text).toContain('https://aecintegrations.com/vendor');
    expect(String(body.html)).toContain('https://aecintegrations.com/vendor');
    // Account-state framing, not a product endorsement (no pay-for-placement).
    expect(text).toContain("doesn't affect search ranking or placement");
    expect(sendTags()).toEqual([['outcome:sent', 'template:claim-approved']]);
    // Voice guard: no em dash beyond the shared house signature.
    const authored = text.replace('— The AEC Integrations team', '');
    expect(authored).not.toContain('—');
  });

  it('tailors the sign-in copy for an invited (just-provisioned) claimant', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendClaimApprovedEmail(fakeContext({ PUBLIC_SITE_URL: 'https://aecintegrations.com' }), {
      to: 'owner@vendor.com',
      vendorName: 'Globex',
      invited: true,
    });
    expect(String(lastBody(fetchSpy).text)).toContain('We created an account');
  });

  it('reads as an existing-account sign-in for a linked claimant', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendClaimApprovedEmail(fakeContext(), {
      to: 'owner@vendor.com',
      vendorName: 'Globex',
      invited: false,
    });
    const text = String(lastBody(fetchSpy).text);
    expect(text).toContain('existing account');
    expect(text).not.toContain('We created an account');
  });

  it('omits the dashboard link (no dead host) when PUBLIC_SITE_URL is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendClaimApprovedEmail(fakeContext(), {
      to: 'owner@vendor.com',
      vendorName: 'Globex',
      invited: true,
    });
    expect(String(lastBody(fetchSpy).text)).not.toContain('/vendor');
  });

  it('skips when the recipient is undefined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(
      await sendClaimApprovedEmail(fakeContext(), {
        to: undefined,
        vendorName: 'Globex',
        invited: false,
      }),
    ).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('sendClaimRejectedEmail', () => {
  it('sends a neutral rejection that never echoes an internal reviewer note', async () => {
    // The email takes no `reason`: the reviewer's decision note is internal (audit
    // only), so nothing they type can reach the claimant (§9).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const outcome = await sendClaimRejectedEmail(fakeContext(), {
      to: 'owner@vendor.com',
      vendorName: 'Autodesk, Inc.',
    });

    expect(outcome).toBe('sent');
    const body = lastBody(fetchSpy);
    expect(body.subject).toBe('Your claim for Autodesk, Inc. was not approved');
    const text = String(body.text);
    expect(text).toContain("weren't able to approve it");
    expect(text).toContain('submit a new claim');
    expect(sendTags()).toEqual([['outcome:sent', 'template:claim-rejected']]);
    const authored = text.replace('— The AEC Integrations team', '');
    expect(authored).not.toContain('—');
  });

  it('skips when the recipient is undefined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(
      await sendClaimRejectedEmail(fakeContext(), {
        to: undefined,
        vendorName: 'Globex',
      }),
    ).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('sendAccountDeletionEmail', () => {
  it('confirms deletion to the captured recipient', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const outcome = await sendAccountDeletionEmail(fakeContext(), { to: 'gone@example.com' });

    expect(outcome).toBe('sent');
    const body = lastBody(fetchSpy);
    expect(body.to).toBe('gone@example.com');
    expect(body.subject).toBe('Your AEC Integrations account has been deleted');
    expect(String(body.text)).toContain('deleted');
  });
});

describe('sendMailingListWelcomeEmail', () => {
  it('welcomes the subscriber, links the directory, and carries the tokenized one-click unsubscribe (AECI-537)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const outcome = await sendMailingListWelcomeEmail(
      fakeContext({ PUBLIC_SITE_URL: 'https://aecintegrations.com' }),
      { to: 'sub@example.com', token: 'tok-123' },
    );

    expect(outcome).toBe('sent');
    const body = lastBody(fetchSpy);
    expect(body.to).toBe('sub@example.com');
    expect(body.subject).toBe('Welcome to AEC Integrations');
    expect(String(body.text)).toContain('directory and review platform');
    expect(String(body.text)).toContain('https://aecintegrations.com/products');
    expect(String(body.html)).toContain('https://aecintegrations.com/products');
    // In-body opt-out now links the /unsubscribe page (token in the query).
    expect(String(body.text)).toContain('https://aecintegrations.com/unsubscribe?token=tok-123');
    expect(String(body.html)).toContain('https://aecintegrations.com/unsubscribe?token=tok-123');
    // RFC 8058 one-click: https target (through the SSR passthrough) + the mailto
    // as a secondary value, plus the List-Unsubscribe-Post header.
    const headers = body.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toBe(
      '<https://aecintegrations.com/api/unsubscribe?token=tok-123>, <mailto:unsubscribe@aecintegrations.com?subject=unsubscribe>',
    );
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // Voice guard: the authored copy is em-dash-free (the only em dash in the body
    // is the shared house signature `— The AEC Integrations team`, appended by
    // `toText`/`toHtml` for every template).
    const authoredCopy = String(body.text).replace('— The AEC Integrations team', '');
    expect(authoredCopy).not.toContain('—');
  });

  it('falls back to the mailto opt-out when there is no token (mailto-only List-Unsubscribe, no one-click)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendMailingListWelcomeEmail(
      fakeContext({ PUBLIC_SITE_URL: 'https://aecintegrations.com' }),
      {
        to: 'sub@example.com',
      },
    );

    const body = lastBody(fetchSpy);
    const headers = body.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toBe(
      '<mailto:unsubscribe@aecintegrations.com?subject=unsubscribe>',
    );
    expect(headers['List-Unsubscribe-Post']).toBeUndefined();
    expect(String(body.text)).toContain('unsubscribe@aecintegrations.com');
    expect(String(body.text)).not.toContain('/unsubscribe?token=');
  });

  it('omits the directory + page links (no dead host) when PUBLIC_SITE_URL is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendMailingListWelcomeEmail(fakeContext(), { to: 'sub@example.com', token: 'tok-123' });
    const body = lastBody(fetchSpy);
    expect(String(body.text)).not.toContain('/products');
    // Without a host there is no page/one-click link; it degrades to the mailto.
    expect(String(body.text)).not.toContain('/unsubscribe');
    expect((body.headers as Record<string, string>)['List-Unsubscribe-Post']).toBeUndefined();
  });

  it('skips when the subscriber email is undefined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await sendMailingListWelcomeEmail(fakeContext(), { to: undefined })).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('sendStuckRequestAdminAlert', () => {
  it('digests the stuck rows and pluralizes the subject', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendStuckRequestAdminAlert(fakeContext(), {
      to: 'ops@aecintegrations.com',
      rows: [
        {
          requestId: 'req-1',
          kind: 'claim',
          targetType: 'vendor',
          targetName: 'Globex Inc',
          ageMinutes: 95,
        },
        {
          requestId: 'req-2',
          kind: 'correction',
          targetType: 'product',
          targetName: null,
          ageMinutes: 40,
        },
      ],
    });

    const body = lastBody(fetchSpy);
    expect(body.subject).toBe('[AECi] 2 requests stuck in the Linear pipeline');
    const text = String(body.text);
    expect(text).toContain('req-1');
    expect(text).toContain('Globex Inc');
    expect(text).toContain('(target removed)'); // null targetName
  });

  it('uses the singular subject for one row', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendStuckRequestAdminAlert(fakeContext(), {
      to: 'ops@aecintegrations.com',
      rows: [
        {
          requestId: 'req-1',
          kind: 'claim',
          targetType: 'vendor',
          targetName: 'X',
          ageMinutes: 90,
        },
      ],
    });
    expect(lastBody(fetchSpy).subject).toBe('[AECi] 1 request stuck in the Linear pipeline');
  });
});

describe('sendClaimSubmittedNotification', () => {
  const CLAIM = {
    requestId: 'req-9',
    targetName: 'Globex Inc',
    targetType: 'vendor' as const,
    slug: 'globex',
    submitterEmail: 'ops@globex.com',
    submitterName: 'Dana Ops',
    submitterRole: 'VP Product',
    domainMatch: 'match',
    duplicateOfRequestId: null,
  };

  it('sends to CLAIM_ALERT_EMAIL with the target in the subject and both signals in the body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const outcome = await sendClaimSubmittedNotification(
      fakeContext({
        CLAIM_ALERT_EMAIL: 'support@aecintegrations.com',
        PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
      }),
      CLAIM,
    );

    expect(outcome).toBe('sent');
    const body = lastBody(fetchSpy);
    expect(body.to).toBe('support@aecintegrations.com');
    expect(body.subject).toBe('[AECi] New vendor claim: Globex Inc');
    const text = String(body.text);
    expect(text).toContain('ops@globex.com');
    expect(text).toContain('Domain match: match');
    expect(text).toContain('Possible duplicate: no');
    expect(text).toContain('req-9');
    expect(sendTags()).toContainEqual(['outcome:sent', 'template:claim-submitted-alert']);
  });

  it('links a vendor target at /vendors and a product target at /products', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const ctx = fakeContext({
      CLAIM_ALERT_EMAIL: 'support@aecintegrations.com',
      PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
    });

    await sendClaimSubmittedNotification(ctx, CLAIM);
    expect(String(lastBody(fetchSpy).text)).toContain(
      'https://www.aecintegrations.com/vendors/globex',
    );

    await sendClaimSubmittedNotification(ctx, {
      ...CLAIM,
      targetType: 'product',
      slug: 'acme-cad',
    });
    expect(String(lastBody(fetchSpy).text)).toContain(
      'https://www.aecintegrations.com/products/acme-cad',
    );
  });

  it('surfaces the duplicate id when the probe matched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendClaimSubmittedNotification(
      fakeContext({ CLAIM_ALERT_EMAIL: 'support@aecintegrations.com' }),
      { ...CLAIM, duplicateOfRequestId: 'req-1' },
    );
    expect(String(lastBody(fetchSpy).text)).toContain('Possible duplicate: req-1');
  });

  it('omits the links when PUBLIC_SITE_URL is unset rather than emitting a dead host', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendClaimSubmittedNotification(
      fakeContext({ CLAIM_ALERT_EMAIL: 'support@aecintegrations.com' }),
      CLAIM,
    );
    const text = String(lastBody(fetchSpy).text);
    expect(text).not.toContain('Review queue');
    expect(text).not.toContain('Listing');
  });

  it('skips (no fetch) when CLAIM_ALERT_EMAIL is unset — fail-open, never throws', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const outcome = await sendClaimSubmittedNotification(fakeContext(), CLAIM);

    expect(outcome).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendTags()).toContainEqual(['outcome:skipped', 'template:claim-submitted-alert']);
  });

  it('escapes HTML in the submitter-supplied fields', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendClaimSubmittedNotification(
      fakeContext({ CLAIM_ALERT_EMAIL: 'support@aecintegrations.com' }),
      { ...CLAIM, submitterName: '<script>alert(1)</script>' },
    );
    const html = String(lastBody(fetchSpy).html);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
});

// ─── Low-level transport (AECI-241) ─────────────────────────────────────────────

const MSG = {
  from: 'AECi <dq@aecintegrations.com>',
  to: ['a@x.com', 'b@x.com'],
  subject: 'subj',
  text: 'body',
};

const silent = { warn: () => {}, error: () => {} };

describe('sendEmail', () => {
  it('skips (no fetch) when RESEND_API_KEY is unset', async () => {
    const fetchImpl = vi.fn();
    const out = await sendEmail({}, MSG, fetchImpl as unknown as typeof fetch, silent);
    expect(out).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips when there are no recipients or no sender', async () => {
    const fetchImpl = vi.fn();
    expect(
      await sendEmail(
        { RESEND_API_KEY: 'k' },
        { ...MSG, to: [] },
        fetchImpl as unknown as typeof fetch,
        silent,
      ),
    ).toBe('skipped');
    expect(
      await sendEmail(
        { RESEND_API_KEY: 'k' },
        { ...MSG, from: '' },
        fetchImpl as unknown as typeof fetch,
        silent,
      ),
    ).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts to Resend and returns sent on 2xx', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    const out = await sendEmail(
      { RESEND_API_KEY: 'secret' },
      MSG,
      fetchImpl as unknown as typeof fetch,
      silent,
    );
    expect(out).toBe('sent');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0]!;
    const init = call[1]!;
    expect(call[0]).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body as string) as { to: string[]; subject: string };
    expect(body.to).toEqual(['a@x.com', 'b@x.com']);
    expect(body.subject).toBe('subj');
  });

  it('returns failed on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 422 }));
    expect(
      await sendEmail({ RESEND_API_KEY: 'k' }, MSG, fetchImpl as unknown as typeof fetch, silent),
    ).toBe('failed');
  });

  it('returns failed (never throws) when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network');
    });
    expect(
      await sendEmail({ RESEND_API_KEY: 'k' }, MSG, fetchImpl as unknown as typeof fetch, silent),
    ).toBe('failed');
  });
});

describe('parseRecipients', () => {
  it('splits on commas/semicolons/whitespace and trims', () => {
    expect(parseRecipients('a@x.com, b@x.com;c@x.com\n d@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
  });

  it('returns [] for undefined/empty', () => {
    expect(parseRecipients(undefined)).toEqual([]);
    expect(parseRecipients('   ')).toEqual([]);
  });
});

// ─── Attestation detector nudges (§7.2 — AECI-302) ────────────────────────────

describe('attestation nudge templates', () => {
  const SUBJECT = {
    to: 'ops@vendor.test',
    dataObject: 'RFIs',
    product: 'Revit',
    counterpart: 'Procore',
    mechanismName: 'Procore Connector',
    pairSlugs: ['revit', 'procore'] as const,
  };

  it('sends the silent-counterparty nudge under its own template id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const c = fakeContext({ PUBLIC_SITE_URL: 'https://www.aecintegrations.com' });

    expect(await sendAttestationSilentCounterpartyEmail(c, SUBJECT)).toBe('sent');
    expect(sendTags()).toEqual([['outcome:sent', 'template:attestation-silent-counterparty']]);

    const body = lastBody(fetchSpy);
    expect(body.to).toBe('ops@vendor.test');
    expect(body.subject).toContain('RFIs');
    // The canonical pair URL: alphabetically-first slug is the context.
    expect(String(body.text)).toContain(
      'https://www.aecintegrations.com/products/procore/integrations/revit',
    );
    // The §8.1(4) promise, stated in the copy rather than merely implied.
    expect(String(body.text)).toContain('reported by one vendor only');
  });

  it('omits the links entirely when PUBLIC_SITE_URL is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendAttestationSilentCounterpartyEmail(fakeContext(), SUBJECT);

    const text = String(lastBody(fetchSpy).text);
    expect(text).not.toContain('http');
    expect(text).not.toContain('undefined');
  });

  it('drops the mechanism clause when the row has no mechanism name', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendAttestationOpenConflictEmail(fakeContext(), { ...SUBJECT, mechanismName: null });

    expect(String(lastBody(fetchSpy).text)).not.toContain('through');
  });

  it('sends the open-conflict nudge without blaming either side', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    expect(await sendAttestationOpenConflictEmail(fakeContext(), SUBJECT)).toBe('sent');
    expect(sendTags()).toEqual([['outcome:sent', 'template:attestation-open-conflict']]);
    expect(String(lastBody(fetchSpy).text)).toContain('rather than picking a side');
  });

  it('offers withdraw as an equal option on the stale-version nudge', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    expect(await sendAttestationStaleVersionEmail(fakeContext(), SUBJECT)).toBe('sent');
    expect(sendTags()).toEqual([['outcome:sent', 'template:attestation-stale-version']]);
    expect(String(lastBody(fetchSpy).text)).toContain('withdraw it');
  });

  it('never implies attesting affects ranking or placement', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    for (const send of [
      sendAttestationSilentCounterpartyEmail,
      sendAttestationOpenConflictEmail,
      sendAttestationStaleVersionEmail,
    ]) {
      await send(fakeContext({ PUBLIC_SITE_URL: 'https://www.aecintegrations.com' }), SUBJECT);
      const text = String(lastBody(fetchSpy).text).toLowerCase();
      expect(text).not.toContain('ranking');
      expect(text).not.toContain('placement');
      expect(text).not.toContain('search results');
    }
  });

  it('renders the ops alert in the operator format, naming the detector', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const c = fakeContext({ PUBLIC_SITE_URL: 'https://www.aecintegrations.com' });

    expect(
      await sendAttestationOpsAlertEmail(c, {
        to: 'ops@aecintegrations.com',
        detector: 'aeci-denied',
        dataObject: 'RFIs',
        productA: 'Revit',
        productB: 'Procore',
        mechanismName: null,
        claimId: 'claim-1',
        integrationId: 'intg-1',
        pairSlugs: ['revit', 'procore'],
      }),
    ).toBe('sent');
    expect(sendTags()).toEqual([['outcome:sent', 'template:attestation-ops-alert']]);

    const body = lastBody(fetchSpy);
    expect(body.subject).toContain('[AECi]');
    expect(String(body.text)).toContain('Detector: aeci-denied');
    expect(String(body.text)).toContain('Claim: claim-1');
    expect(String(body.text)).toContain('Mechanism: (unnamed)');
  });

  it('skips every nudge when the transport is unconfigured', async () => {
    const c = fakeContext({ RESEND_API_KEY: undefined });
    expect(await sendAttestationSilentCounterpartyEmail(c, SUBJECT)).toBe('skipped');
  });
});

// ─── Entitlement term-expiry warnings (§7.2 — AECI-613) ───────────────────────

describe('entitlement expiry templates', () => {
  const SUBJECT = {
    to: 'ops@vendor.test',
    vendorName: 'Autodesk',
    periodEndDay: '2026-09-18',
    daysRemaining: 30,
  };

  it('sends the vendor renewal prompt under its own template id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const c = fakeContext({ PUBLIC_SITE_URL: 'https://www.aecintegrations.com' });

    expect(await sendEntitlementExpiringEmail(c, SUBJECT)).toBe('sent');
    expect(sendTags()).toEqual([['outcome:sent', 'template:entitlement-expiring']]);

    const body = lastBody(fetchSpy);
    expect(body.to).toBe('ops@vendor.test');
    expect(String(body.subject)).toContain('in 30 days');
    expect(String(body.text)).toContain('2026-09-18');
    expect(String(body.text)).toContain('https://www.aecintegrations.com/vendor');
  });

  it('promises no automatic lapse — the §7.3 decision, stated in the copy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendEntitlementExpiringEmail(fakeContext(), SUBJECT);

    const text = String(lastBody(fetchSpy).text);
    expect(text).toContain('Nothing changes automatically');
    expect(text).toContain("don't switch verification off");
    // Nothing that reads as a threat or a countdown to removal.
    expect(text.toLowerCase()).not.toContain('will be removed');
    expect(text.toLowerCase()).not.toContain('will expire');
  });

  it('reads as past tense once the term is behind us', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendEntitlementExpiringEmail(fakeContext(), { ...SUBJECT, daysRemaining: -5 });

    const body = lastBody(fetchSpy);
    expect(String(body.subject)).toContain('has reached its end date');
    expect(String(body.text)).toContain('5 days ago');
  });

  it.each([
    [1, 'tomorrow'],
    [0, 'today'],
    [-1, 'yesterday'],
  ])('renders %s days remaining as "%s"', async (days, phrase) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendEntitlementExpiringEmail(fakeContext(), { ...SUBJECT, daysRemaining: days });

    expect(String(lastBody(fetchSpy).text)).toContain(phrase);
  });

  it('never implies verification affects ranking or placement', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendEntitlementExpiringEmail(
      fakeContext({ PUBLIC_SITE_URL: 'https://www.aecintegrations.com' }),
      SUBJECT,
    );

    const text = String(lastBody(fetchSpy).text);
    // It says the opposite, explicitly — the same framing the badge tooltip and
    // the `claim-approved` email use.
    expect(text).toContain("doesn't affect search ranking or placement");
    expect(text).toContain('not an endorsement');
  });

  it('omits the dashboard link entirely when PUBLIC_SITE_URL is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendEntitlementExpiringEmail(fakeContext(), SUBJECT);

    const text = String(lastBody(fetchSpy).text);
    expect(text).not.toContain('http');
    expect(text).not.toContain('undefined');
  });

  it('keeps the money out of the vendor copy — arrangement details are admin-side', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendEntitlementExpiringEmail(fakeContext(), SUBJECT);

    const text = String(lastBody(fetchSpy).text).toLowerCase();
    for (const word of ['invoice', 'payer', 'amount', 'purchase order', 'po-']) {
      expect(text).not.toContain(word);
    }
  });

  const ADMIN_SUBJECT = {
    to: 'ops@aecintegrations.com',
    vendorName: 'Autodesk',
    vendorSlug: 'autodesk',
    tier: 'verified',
    periodEndDay: '2026-09-18',
    daysRemaining: 30,
    payer: 'Autodesk Inc.',
    invoiceRef: 'PO-4471',
    vendorNotice: 'sent' as const,
  };

  it('renders the admin copy in the operator format, carrying the arrangement', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    expect(await sendEntitlementExpiringAdminEmail(fakeContext(), ADMIN_SUBJECT)).toBe('sent');
    expect(sendTags()).toEqual([['outcome:sent', 'template:entitlement-expiring-admin']]);

    const body = lastBody(fetchSpy);
    expect(String(body.subject)).toContain('[AECi]');
    expect(String(body.text)).toContain('Vendor: Autodesk (autodesk)');
    expect(String(body.text)).toContain('Term ends: 2026-09-18 (in 30 days)');
    expect(String(body.text)).toContain('Invoice ref: PO-4471');
    // Says outright that nothing was changed — the operator must not read this as
    // a notification of an automatic action.
    expect(String(body.text)).toContain('warns and never lapses');
  });

  it('names the vendor half\u2019s outcome so delivery is never assumed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendEntitlementExpiringAdminEmail(fakeContext(), {
      ...ADMIN_SUBJECT,
      vendorNotice: 'skipped',
    });

    expect(String(lastBody(fetchSpy).text)).toContain('Vendor notice: skipped');
  });

  it('labels an unrecorded arrangement rather than rendering undefined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());

    await sendEntitlementExpiringAdminEmail(fakeContext(), {
      ...ADMIN_SUBJECT,
      payer: null,
      invoiceRef: null,
    });

    const text = String(lastBody(fetchSpy).text);
    expect(text).toContain('Payer: (none recorded)');
    expect(text).toContain('Invoice ref: (none recorded)');
    expect(text).not.toContain('undefined');
  });

  it('skips both halves when the transport is unconfigured', async () => {
    const c = fakeContext({ RESEND_API_KEY: undefined });
    expect(await sendEntitlementExpiringEmail(c, SUBJECT)).toBe('skipped');
    expect(await sendEntitlementExpiringAdminEmail(c, ADMIN_SUBJECT)).toBe('skipped');
  });
});
