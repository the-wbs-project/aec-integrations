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

import { submitCount } from '../datadog';
import type { Env } from '../env';
import {
  parseRecipients,
  sendAccountDeletionEmail,
  sendEmail,
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
vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
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

/** Minimal context the client reads: env (key/sender/site) + the Datadog triple.
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
  it('welcomes the subscriber and links to the directory when PUBLIC_SITE_URL is set', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const outcome = await sendMailingListWelcomeEmail(
      fakeContext({ PUBLIC_SITE_URL: 'https://aecintegrations.com' }),
      { to: 'sub@example.com' },
    );

    expect(outcome).toBe('sent');
    const body = lastBody(fetchSpy);
    expect(body.to).toBe('sub@example.com');
    expect(body.subject).toBe('Welcome to AEC Integrations');
    expect(String(body.text)).toContain('directory and review platform');
    expect(String(body.text)).toContain('https://aecintegrations.com/products');
    expect(String(body.html)).toContain('https://aecintegrations.com/products');
    // List-Unsubscribe header (deliverability) derived from the EMAIL_FROM domain,
    // plus a matching in-body opt-out line.
    expect((body.headers as Record<string, string>)['List-Unsubscribe']).toBe(
      '<mailto:unsubscribe@aecintegrations.com?subject=unsubscribe>',
    );
    expect(String(body.text)).toContain('unsubscribe@aecintegrations.com');
    // Voice guard: the authored copy is em-dash-free (the only em dash in the body
    // is the shared house signature `— The AEC Integrations team`, appended by
    // `toText`/`toHtml` for every template).
    const authoredCopy = String(body.text).replace('— The AEC Integrations team', '');
    expect(authoredCopy).not.toContain('—');
  });

  it('omits the link (no dead host) when PUBLIC_SITE_URL is absent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    await sendMailingListWelcomeEmail(fakeContext(), { to: 'sub@example.com' });
    expect(String(lastBody(fetchSpy).text)).not.toContain('/products');
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
