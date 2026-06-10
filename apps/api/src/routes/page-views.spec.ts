import { ApiErrorSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Datadog transport so the AECI-180 write-health metric
// (`aeci.pageviews.write`) can be asserted without a live submission. The real
// transport no-ops without `DD_API_KEY`, so mocking only changes observability.
vi.mock('../datadog', () => ({ logToDatadog: vi.fn(), submitCount: vi.fn() }));

import { submitCount } from '../datadog';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { PrismaFactory } from '../lib/handler-utils';
import { createPageViewsHandler } from './page-views';

beforeEach(() => {
  vi.clearAllMocks();
});

const TRACE_ID_RE = /^[0-9a-f-]{36}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

const env: Env = { DATABASE_URL: 'prisma://test', ENV: 'preview' };

function jsonRequest(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

/** Validation / response-shape tests don't run the deferred insert. */
function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
}

/**
 * Execution context that retains the `waitUntil` promises so a test can await
 * the deferred capture task and assert on the resulting `pageView.create` call.
 * `settle` uses `allSettled` so a swallowed capture failure never rejects here.
 */
function capturingExecutionContext(): { ctx: ExecutionContext; settle: () => Promise<void> } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      tasks.push(p);
    },
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    settle: async () => {
      await Promise.allSettled(tasks);
    },
  };
}

type AnyFn = (...args: unknown[]) => Promise<unknown>;

type CaptureMock = {
  pageView: { create: ReturnType<typeof vi.fn> };
  product: { findUnique: ReturnType<typeof vi.fn> };
  vendor: { findUnique: ReturnType<typeof vi.fn> };
};

/** Structural Prisma fake covering only the methods `capturePageView` touches. */
function makeCaptureMock(
  overrides: { create?: AnyFn; productFindUnique?: AnyFn; vendorFindUnique?: AnyFn } = {},
): CaptureMock {
  return {
    pageView: { create: vi.fn(overrides.create ?? (async () => ({ id: 1n }))) },
    product: { findUnique: vi.fn(overrides.productFindUnique ?? (async () => null)) },
    vendor: { findUnique: vi.fn(overrides.vendorFindUnique ?? (async () => null)) },
  };
}

/** App wired to a handler whose Prisma client is the supplied capture mock.
 *  Always inject a mock — the real `getPrisma` would build an Accelerate client
 *  against the fake `prisma://test` URL and leak a background rejection. */
function buildCaptureApp(prisma: CaptureMock) {
  const factory: PrismaFactory = () => prisma as unknown as ReturnType<PrismaFactory>;
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  app.post('/api/page-views', createPageViewsHandler(factory));
  return app;
}

/** Bare app for validation/contract tests. Uses a throwaway mock client so a
 *  valid body's deferred capture never reaches the real Prisma engine. */
function buildApp() {
  return buildCaptureApp(makeCaptureMock());
}

/** Mirror of the handler's hashing so a test can assert the stored digest. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function createdData(prisma: CaptureMock): Record<string, unknown> {
  expect(prisma.pageView.create).toHaveBeenCalledTimes(1);
  return (prisma.pageView.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
}

describe('createPageViewsHandler — contract (still 204, still validates)', () => {
  it('returns 204 with empty body for a minimal valid payload', async () => {
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('returns 204 for a fully populated payload (route, entity_type, entity_id)', async () => {
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({ route: '/vendors/acme', entity_type: 'vendor', entity_id: 'acme' }),
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('returns a canonical VALIDATION_FAILED envelope when route is missing', async () => {
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({}),
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const parsed = ApiErrorSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.error.code).toBe('VALIDATION_FAILED');
    expect(parsed.data.error.field).toBe('route');
    expect(parsed.data.trace_id).toMatch(TRACE_ID_RE);
  });

  it('returns a canonical VALIDATION_FAILED envelope when route is an empty string', async () => {
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({ route: '' }),
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const parsed = ApiErrorSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.error.code).toBe('VALIDATION_FAILED');
    expect(parsed.data.error.field).toBe('route');
  });

  it('returns a canonical MALFORMED_REQUEST envelope when the body is malformed JSON', async () => {
    const res = await buildApp().request(
      '/api/page-views',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      },
      env,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(400);
    const parsed = ApiErrorSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.error.code).toBe('MALFORMED_REQUEST');
    expect(parsed.data.trace_id).toMatch(TRACE_ID_RE);
  });

  it("sets Cache-Control: 'private, no-store' on the 204 success response (AECI-43)", async () => {
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it("sets Cache-Control: 'private, no-store' on the 400 error response (AECI-43)", async () => {
    const res = await buildApp().request(
      '/api/page-views',
      jsonRequest({}),
      env,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('does NOT touch Prisma when validation fails (no insert on a bad body)', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();
    const res = await buildCaptureApp(prisma).request('/api/page-views', jsonRequest({}), env, ctx);
    await settle();

    expect(res.status).toBe(400);
    expect(prisma.pageView.create).not.toHaveBeenCalled();
  });
});

describe('createPageViewsHandler — page_views insert + enrichment (AECI-177)', () => {
  it('inserts one row keyed on the route, returning 204 before the write resolves', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    const res = await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);

    await settle();
    const data = createdData(prisma);
    expect(data.path).toBe('/products/foo');
    expect(data.locale).toBe('en-US');
    // No entity → no product/vendor; no CF headers / UA on this request → nulls.
    expect(data.productId).toBeNull();
    expect(data.vendorId).toBeNull();
    expect(data.cfCountry).toBeNull();
    expect(data.cfColo).toBeNull();
    expect(data.cfAsn).toBeNull();
    expect(data.cfBotScore).toBeNull();
    expect(data.userAgentHash).toBeNull();
  });

  it('enriches from the forwarded Cloudflare context headers', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest(
        { route: '/' },
        {
          'x-aeci-cf-country': 'US',
          'x-aeci-cf-colo': 'SJC',
          'x-aeci-cf-asn': '13335',
          'x-aeci-cf-bot-score': '42',
        },
      ),
      env,
      ctx,
    );

    await settle();
    const data = createdData(prisma);
    expect(data.cfCountry).toBe('US');
    expect(data.cfColo).toBe('SJC');
    expect(data.cfAsn).toBe(13335); // coerced to a number
    expect(data.cfBotScore).toBe(42);
  });

  it('hashes the user agent (SHA-256) and never stores it raw', async () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/' }, { 'user-agent': ua }),
      env,
      ctx,
    );

    await settle();
    const data = createdData(prisma);
    expect(data.userAgentHash).toBe(await sha256Hex(ua));
    expect(data.userAgentHash).toMatch(SHA256_RE);
    expect(data.userAgentHash).not.toContain('Mozilla');
  });

  it('resolves product_id from a (product, uuid) entity reference', async () => {
    const PRODUCT_ID = '00000000-0000-4000-8000-000000020001';
    const prisma = makeCaptureMock({ productFindUnique: async () => ({ id: PRODUCT_ID }) });
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/products/:slug', entity_type: 'product', entity_id: PRODUCT_ID }),
      env,
      ctx,
    );

    await settle();
    expect(prisma.product.findUnique).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID },
      select: { id: true },
    });
    const data = createdData(prisma);
    expect(data.productId).toBe(PRODUCT_ID);
    expect(data.vendorId).toBeNull();
  });

  it('resolves vendor_id from a (vendor, uuid) entity reference', async () => {
    const VENDOR_ID = '00000000-0000-4000-8000-000000010001';
    const prisma = makeCaptureMock({ vendorFindUnique: async () => ({ id: VENDOR_ID }) });
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/vendors/:slug', entity_type: 'vendor', entity_id: VENDOR_ID }),
      env,
      ctx,
    );

    await settle();
    const data = createdData(prisma);
    expect(data.vendorId).toBe(VENDOR_ID);
    expect(data.productId).toBeNull();
  });

  it('stores null ids for a non-UUID entity_id without hitting the DB', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      // A slug (not a UUID) must never reach the uuid FK column.
      jsonRequest({ route: '/products/acme', entity_type: 'product', entity_id: 'acme' }),
      env,
      ctx,
    );

    await settle();
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(createdData(prisma).productId).toBeNull();
  });

  it('stores a null id when a well-formed entity UUID does not resolve (FK-safe)', async () => {
    const UNKNOWN = '00000000-0000-4000-8000-0000000000ff';
    const prisma = makeCaptureMock({ productFindUnique: async () => null });
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/products/:slug', entity_type: 'product', entity_id: UNKNOWN }),
      env,
      ctx,
    );

    await settle();
    expect(prisma.product.findUnique).toHaveBeenCalled();
    expect(createdData(prisma).productId).toBeNull();
  });

  it('still returns 204 and swallows the failure when the insert throws', async () => {
    const prisma = makeCaptureMock({
      create: async () => {
        throw new Error('db down');
      },
    });
    const { ctx, settle } = capturingExecutionContext();

    const res = await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      ctx,
    );

    expect(res.status).toBe(204);
    // The capture task catches its own error — settling must not reject.
    await expect(settle()).resolves.toBeUndefined();
    expect(prisma.pageView.create).toHaveBeenCalledTimes(1);
  });
});

describe('createPageViewsHandler — bot-score sampling knob (AECI-177 / §14.2)', () => {
  // The forwarded `x-aeci-cf-bot-score` header carries the captured score;
  // `PAGE_VIEWS_MIN_BOT_SCORE` is the drop floor. Cloudflare scores 1–99 (lower
  // = more bot-like), so a view is dropped only when the knob is SET and the
  // score is strictly below it. Unset (the default everywhere) or an unscored
  // request captures everything — nothing is hardcoded to drop.
  function botScoreRequest(score: string): RequestInit {
    return jsonRequest({ route: '/products/foo' }, { 'x-aeci-cf-bot-score': score });
  }

  it('drops the view (no insert) when the score is below PAGE_VIEWS_MIN_BOT_SCORE', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    const res = await buildCaptureApp(prisma).request(
      '/api/page-views',
      botScoreRequest('10'),
      { ...env, PAGE_VIEWS_MIN_BOT_SCORE: '30' },
      ctx,
    );

    expect(res.status).toBe(204); // sampling is invisible to the caller
    await settle();
    expect(prisma.pageView.create).not.toHaveBeenCalled();
  });

  it('captures the view when the score equals the floor (boundary — not "below")', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      botScoreRequest('30'),
      { ...env, PAGE_VIEWS_MIN_BOT_SCORE: '30' },
      ctx,
    );

    await settle();
    expect(createdData(prisma).cfBotScore).toBe(30);
  });

  it('captures every view when the knob is unset, even a maximally bot-like score', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    // No PAGE_VIEWS_MIN_BOT_SCORE on `env` → the floor is null → capture all.
    await buildCaptureApp(prisma).request('/api/page-views', botScoreRequest('1'), env, ctx);

    await settle();
    expect(createdData(prisma).cfBotScore).toBe(1);
  });

  it('captures an unscored request even when the knob is set (no score → not dropped)', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    // No x-aeci-cf-bot-score header → botScore null → sampling cannot apply.
    await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      { ...env, PAGE_VIEWS_MIN_BOT_SCORE: '30' },
      ctx,
    );

    await settle();
    expect(createdData(prisma).cfBotScore).toBeNull();
  });

  it('treats a non-numeric PAGE_VIEWS_MIN_BOT_SCORE as unset (captures all)', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      botScoreRequest('5'),
      { ...env, PAGE_VIEWS_MIN_BOT_SCORE: 'not-a-number' },
      ctx,
    );

    await settle();
    expect(createdData(prisma).cfBotScore).toBe(5);
  });
});

describe('createPageViewsHandler — write-health metric (AECI-180)', () => {
  /** Find every `aeci.pageviews.write` submitCount call's outcome tag. */
  function writeOutcomes(): string[] {
    return vi
      .mocked(submitCount)
      .mock.calls.filter((c) => c[3] === 'aeci.pageviews.write')
      .map((c) => (c[5] as string[])[0]!);
  }

  it('emits aeci.pageviews.write{outcome:ok} after a successful insert', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      ctx,
    );
    await settle();

    expect(prisma.pageView.create).toHaveBeenCalledTimes(1);
    expect(writeOutcomes()).toEqual(['outcome:ok']);
  });

  it('emits aeci.pageviews.write{outcome:failed} when the insert throws (still 204)', async () => {
    const prisma = makeCaptureMock({
      create: async () => {
        throw new Error('db down');
      },
    });
    const { ctx, settle } = capturingExecutionContext();

    const res = await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    await settle();

    expect(writeOutcomes()).toEqual(['outcome:failed']);
  });

  it('emits NO write metric when the view is sampled out (not a write)', async () => {
    const prisma = makeCaptureMock();
    const { ctx, settle } = capturingExecutionContext();

    await buildCaptureApp(prisma).request(
      '/api/page-views',
      jsonRequest({ route: '/products/foo' }, { 'x-aeci-cf-bot-score': '10' }),
      { ...env, PAGE_VIEWS_MIN_BOT_SCORE: '30' },
      ctx,
    );
    await settle();

    expect(prisma.pageView.create).not.toHaveBeenCalled();
    expect(writeOutcomes()).toEqual([]);
  });
});
