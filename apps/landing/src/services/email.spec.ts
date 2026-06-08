import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../types';
import { sendNotification } from './email';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: {} as Fetcher,
    ANALYTICS: {} as AnalyticsEngineDataset,
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_PUBLISHABLE_KEY: 'anon-key',
    RESEND_API_KEY: 'resend-key',
    NOTIFICATION_FROM: 'noreply@aecintegrations.com',
    NOTIFICATION_TO: 'team@aecintegrations.com',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendNotification', () => {
  it('skips (no fetch) and warns when RESEND_API_KEY is missing', async () => {
    // Guards: the Worker boots in local/preview before secrets are provisioned;
    // a missing Resend key must no-op, never throw or attempt a network call.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendNotification(makeEnv({ RESEND_API_KEY: '' }), {
      subject: 's',
      bodyText: 't',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('skips when NOTIFICATION_FROM is missing', async () => {
    // Guards: both endpoints are required — a half-configured sender is treated
    // the same as no sender (no half-formed email goes out).
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendNotification(makeEnv({ NOTIFICATION_FROM: '' }), {
      subject: 's',
      bodyText: 't',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips when NOTIFICATION_TO is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendNotification(makeEnv({ NOTIFICATION_TO: '' }), {
      subject: 's',
      bodyText: 't',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to the Resend API with auth, addresses, and List-Unsubscribe header', async () => {
    // Guards: the exact Resend request contract — bearer auth, from/to/reply_to,
    // and the List-Unsubscribe header that keeps us out of spam folders.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    await sendNotification(makeEnv(), {
      subject: 'Hello',
      bodyText: 'plain',
      bodyHtml: '<p>rich</p>',
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer resend-key');

    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload.from).toBe('noreply@aecintegrations.com');
    expect(payload.to).toBe('team@aecintegrations.com');
    expect(payload.reply_to).toBe('team@aecintegrations.com');
    expect(payload.subject).toBe('Hello');
    expect(payload.text).toBe('plain');
    expect(payload.html).toBe('<p>rich</p>');
    expect((payload.headers as Record<string, string>)['List-Unsubscribe']).toBe(
      '<mailto:team@aecintegrations.com>',
    );
  });

  it('throws with status and body when Resend returns a non-2xx response', async () => {
    // Guards: callers wrap this in .catch() to log — but the error message must
    // carry the status + Resend body so failures are debuggable from logs.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('rate limited', { status: 429 }));

    await expect(sendNotification(makeEnv(), { subject: 's', bodyText: 't' })).rejects.toThrow(
      'Resend error 429: rate limited',
    );
  });
});
