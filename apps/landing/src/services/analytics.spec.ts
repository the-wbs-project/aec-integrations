import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../types';
import { logPageview } from './analytics';

type CfProps = Record<string, unknown>;

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/*', (c) => {
    logPageview(c);
    return c.text('ok');
  });
  return app;
}

function makeEnv(writeDataPoint: ReturnType<typeof vi.fn>): Env {
  return {
    ASSETS: {} as Fetcher,
    ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    API: {} as Fetcher,
    RESEND_API_KEY: 'resend-key',
    NOTIFICATION_FROM: 'from@test',
    NOTIFICATION_TO: 'to@test',
  };
}

function request(
  app: Hono<{ Bindings: Env }>,
  env: Env,
  url: string,
  cf: CfProps,
  headers: Record<string, string> = {},
) {
  const req = new Request(url, { headers });
  // Cloudflare populates `request.cf` at the edge; jsdom/undici Requests don't,
  // so we attach it the way the runtime would.
  (req as unknown as { cf: CfProps }).cf = cf;
  return app.request(req, undefined, env);
}

describe('logPageview', () => {
  it('writes one data point indexed by pathname with mapped geo/UTM fields', async () => {
    // Guards: the Analytics Engine schema is positional — pathname index, then
    // the referer/UA/geo/UTM blobs and the metroCode double. A reordering here
    // silently corrupts every downstream query.
    const writeDataPoint = vi.fn();
    const app = buildApp();
    await request(
      app,
      makeEnv(writeDataPoint),
      'https://www.aecintegrations.com/pricing?utm_source=reddit&utm_medium=social&utm_campaign=launch',
      {
        country: 'US',
        city: 'Austin',
        region: 'Texas',
        asOrganization: 'Comcast',
        asn: 7922,
        metroCode: 635,
      },
      { referer: 'https://news.ycombinator.com/', 'user-agent': 'Mozilla/5.0' },
    );

    expect(writeDataPoint).toHaveBeenCalledOnce();
    const point = writeDataPoint.mock.calls[0][0];
    expect(point.indexes).toEqual(['/pricing']);
    expect(point.blobs).toEqual([
      'https://news.ycombinator.com/',
      'Mozilla/5.0',
      'US',
      'Austin',
      'Texas',
      'Comcast',
      '7922',
      'reddit',
      'social',
      'launch',
    ]);
    expect(point.doubles).toEqual([635]);
  });

  it('falls back to empty strings / zero when cf, headers and UTM are absent', async () => {
    // Guards: a direct hit with no edge geo, no referer and no UTMs must still
    // produce a well-formed, fixed-arity data point (no undefined slots).
    const writeDataPoint = vi.fn();
    const app = buildApp();
    await request(app, makeEnv(writeDataPoint), 'https://www.aecintegrations.com/', {});

    const point = writeDataPoint.mock.calls[0][0];
    expect(point.indexes).toEqual(['/']);
    expect(point.blobs).toEqual(['', '', '', '', '', '', '', '', '', '']);
    expect(point.doubles).toEqual([0]);
  });

  it('never throws when writeDataPoint fails — analytics must not break the request', async () => {
    // Guards: the try/catch swallow. Analytics is best-effort; a binding outage
    // should not surface as a 500 to the visitor.
    const writeDataPoint = vi.fn(() => {
      throw new Error('binding unavailable');
    });
    const app = buildApp();
    const res = await request(app, makeEnv(writeDataPoint), 'https://www.aecintegrations.com/', {});

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});
