/**
 * Vendor-portal post-commit tail — connection hygiene (AECI-666).
 *
 * `afterVendorWrite` runs after EVERY vendor write. It used to be
 * `Promise.all([purgeTags(…), ...entries.map(forwardAuditLog)])`, and because
 * the §3.1 dual-run fans `logToPosthog` out to PostHog AND Datadog, a write that
 * emits N audit rows — AECI-301's `POST /api/vendor/claims` writes a
 * `claim.created` plus one `attestation.created` per owned slot — opened 2N
 * simultaneous connections from one invocation, alongside the queue send sitting
 * in the same array. A Worker invocation may hold only a bounded number; past
 * the limit the runtime cancels the stalled responses into `fetch` promises that
 * never settle, so the forwards are lost with no error at all.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import type { Env } from '../env';
import type { AuthzVariables } from '../lib/authz';
import { enqueueGscRecrawl } from '../lib/gsc-recrawl-queue';
import { enqueueIndexNowUrls } from '../lib/indexnow-queue';
import { logBatchToPosthog, submitCount } from '../posthog';
import { fakeExecutionContext } from '../test/helpers';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  vendorRecrawlEnabled,
  type VendorContext,
  type VendorRecrawl,
} from './vendor-shared';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

vi.mock('../lib/indexnow-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/indexnow-queue')>()),
  enqueueIndexNowUrls: vi.fn().mockResolvedValue(1),
}));
vi.mock('../lib/gsc-recrawl-queue', () => ({
  enqueueGscRecrawl: vi.fn().mockResolvedValue(1),
}));

function entry(n: number): AuditLogEntry {
  return {
    actorId: null,
    actorType: 'user',
    action: n === 0 ? 'claim.created' : 'attestation.created',
    entityType: n === 0 ? 'claim' : 'attestation',
    entityId: `entity-${n}`,
  };
}

function makeCtx(env: Partial<Env> = {}, auth?: Partial<AuthzVariables['auth']>) {
  const execCtx = fakeExecutionContext();
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  const c = {
    env: { ENV: 'preview', ...env } as Env,
    executionCtx: execCtx,
    req: { raw: new Request('http://localhost:8787/api/vendor/claims') },
    get: (key: string) => (key === 'auth' ? auth : undefined),
  } as unknown as VendorContext;
  return { c, execCtx, send, sendBatch };
}

beforeEach(() => vi.mocked(logBatchToPosthog).mockClear());

describe('afterVendorWrite', () => {
  it('forwards N audit entries in ONE batched call, not N', () => {
    const { c } = makeCtx();

    afterVendorWrite(c, [], [entry(0), entry(1), entry(2), entry(3)]);

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logBatchToPosthog).mock.calls[0][3]).toHaveLength(4);
  });

  it('accepts a bare entry as well as an array', () => {
    const { c } = makeCtx();

    afterVendorWrite(c, [], entry(0));

    expect(vi.mocked(logBatchToPosthog).mock.calls[0][3]).toEqual([
      {
        level: 'info',
        message: 'audit claim.created entity-0',
        action: 'claim.created',
        entity_type: 'claim',
        entity_id: 'entity-0',
        source: AUDIT_SOURCE,
      },
    ]);
  });

  it('dispatches with no vendor key configured — each leg self-gates', () => {
    // The old forwarder returned `undefined` (dropping every forward) unless
    // `POSTHOG_PROJECT_KEY` was set. The transport gates itself
    // now, so the call site must not re-add that.
    const { c } = makeCtx();

    afterVendorWrite(c, [], entry(0));

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });

  it('still enqueues the cache purge, on its own waitUntil task', async () => {
    const { c, execCtx, sendBatch, send } = makeCtx();
    (c.env as Env).CACHE_PURGE_QUEUE = { send, sendBatch } as unknown as Env['CACHE_PURGE_QUEUE'];

    afterVendorWrite(c, ['product:revit'], entry(0));
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    expect(send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'vendor' });
  });

  it('no-ops the purge without a queue binding, and still forwards', async () => {
    const { c, execCtx } = makeCtx();

    afterVendorWrite(c, ['product:revit'], entry(0));
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });
});

// ─── AECI-1186: search-engine submission is Managed-only ────────────────────

describe('afterVendorWrite — the re-crawl plan gate (AECI-1186)', () => {
  const PUBLIC: Partial<Env> = {
    INDEXNOW_KEY: 'test-key',
    PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
  };
  const FREE = { entitlementTier: 'unclaimed', entitlement: null } as const;
  const MANAGED = {
    entitlementTier: 'verified',
    entitlement: { status: 'active', periodEnd: null },
  } as const;
  const RECRAWL: VendorRecrawl = {
    indexNow: ['https://www.aecintegrations.com/products/revit'],
    gsc: [{ url: 'https://www.aecintegrations.com/products/revit', reason: 'product.updated' }],
  };
  const db = {} as Db;

  beforeEach(() => {
    vi.mocked(enqueueIndexNowUrls).mockClear();
    vi.mocked(enqueueGscRecrawl).mockClear();
    vi.mocked(submitCount).mockClear();
  });

  async function run(
    auth: Partial<AuthzVariables['auth']>,
    origin?: Parameters<typeof afterVendorWrite>[5],
    recrawl: VendorRecrawl | Promise<VendorRecrawl> = RECRAWL,
  ) {
    const { c, execCtx } = makeCtx(PUBLIC, auth);
    afterVendorWrite(c, [], entry(0), recrawl, db, origin);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
  }

  it('buffers nothing into either queue for a vendor write with no active entitlement', async () => {
    await run(FREE);
    expect(enqueueIndexNowUrls).not.toHaveBeenCalled();
    // Decision 4 of AECI-1182 (2026-10-02): the Google worklist is Managed-only too.
    expect(enqueueGscRecrawl).not.toHaveBeenCalled();
    expect(submitCount).not.toHaveBeenCalled();
  });

  it('buffers both legs as before for a vendor write with an active entitlement', async () => {
    await run(MANAGED);
    expect(enqueueIndexNowUrls).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueIndexNowUrls).mock.calls[0][2]).toBe('vendor');
    expect(enqueueGscRecrawl).toHaveBeenCalledWith(db, RECRAWL.gsc, 'vendor');
  });

  it('keeps an AECi admin write ungated, though its session carries no entitlement', async () => {
    // The admin retire shares this tail with a `NO_ENTITLEMENT` session. Gating
    // on the session alone would silently drop AECi's own re-crawls.
    await run(FREE, { auditSource: 'admin-moderation', purgeSource: 'moderation' });
    expect(enqueueIndexNowUrls).toHaveBeenCalledTimes(1);
    expect(enqueueGscRecrawl).toHaveBeenCalledTimes(1);
  });

  it('settles a rejected derivation handed over by a Free write', async () => {
    const rejected = Promise.reject(new Error('trade floor read failed'));
    await expect(run(FREE, undefined, rejected)).resolves.toBeUndefined();
    expect(enqueueIndexNowUrls).not.toHaveBeenCalled();
  });
});

describe('vendorRecrawlEnabled', () => {
  const PUBLIC: Partial<Env> = {
    INDEXNOW_KEY: 'test-key',
    PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
  };

  it.each([
    ['public env, active entitlement', PUBLIC, 'verified', true],
    ['public env, no entitlement', PUBLIC, 'unclaimed', false],
    ['gated env, active entitlement', {}, 'verified', false],
    ['gated env, no entitlement', {}, 'unclaimed', false],
  ] as const)('%s → %s', (_label, env, entitlementTier, expected) => {
    const { c } = makeCtx(env, { entitlementTier, entitlement: null });
    expect(vendorRecrawlEnabled(c)).toBe(expected);
  });
});
