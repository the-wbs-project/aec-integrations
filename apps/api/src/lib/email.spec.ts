/**
 * Unit tests for the fail-open Resend transport (`lib/email.ts`, AECI-241).
 * No network — `fetch` is faked. Covers the skip (no key / no recipients), the
 * sent/failed outcomes, the never-throw guarantee, and `parseRecipients`.
 */

import { describe, expect, it, vi } from 'vitest';

import { parseRecipients, sendEmail } from './email';

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
