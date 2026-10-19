/**
 * The term-end lapse (AECI-1404, E6.1). Asserted by observed effect on the real
 * migrations in the in-memory harness: run the pass, read the rows back. The
 * `managed-ended` sender and the seat-email seam are stubbed, so no spec here reaches
 * Resend or GoTrue.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  billingAccounts,
  licenses,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { stubPosthogIntake } from '../test/posthog-intake';
import type { EmailContext } from './email';
import {
  LAPSE_CAPPED_METRIC,
  managedEndedTermDedupeKey,
  runLicenseLapse,
  type LapseDeps,
  type SendManagedEnded,
} from './license-lapse';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const VENDOR_B_ID = '33333333-3333-4333-8333-333333333333';
const SEAT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = 'ba-1';
const ACCOUNT_B = 'ba-2';
const OLD_TS = '2020-01-01T00:00:00.000Z';

/** The 11:00 run on the end day. */
const NOW = new Date('2026-11-01T11:00:00.000Z');
/** A date-only end on that day, as every writer stores it. */
const TODAY = '2026-11-01T00:00:00.000Z';
const TOMORROW = '2026-11-02T00:00:00.000Z';
const NEXT_YEAR = '2027-11-01T00:00:00.000Z';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_ID, slug: 'acme', companyName: 'Acme', verified: true, updatedAt: OLD_TS },
    { id: VENDOR_B_ID, slug: 'bolt', companyName: 'Bolt', verified: true, updatedAt: OLD_TS },
  ]);
  await t.db.insert(billingAccounts).values([
    { id: ACCOUNT, vendorId: VENDOR_ID, name: 'Acme', billingEmail: 'billing@acme.example' },
    { id: ACCOUNT_B, vendorId: VENDOR_B_ID, name: 'Bolt' },
  ]);
  await t.db.insert(profiles).values({ id: SEAT_ID, role: 'vendor_admin', vendorId: VENDOR_ID });
  await t.db.insert(products).values([
    { id: 'p-1', slug: 'acme-one', name: 'Acme One', promotionStatus: 'promoted' },
    { id: 'p-2', slug: 'acme-two', name: 'Acme Two', promotionStatus: 'promoted' },
    { id: 'p-3', slug: 'acme-three', name: 'Acme Three', promotionStatus: 'promoted' },
    { id: 'p-b', slug: 'bolt-one', name: 'Bolt One', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: 'p-1', vendorId: VENDOR_ID },
    { productId: 'p-2', vendorId: VENDOR_ID },
    { productId: 'p-3', vendorId: VENDOR_ID },
    { productId: 'p-b', vendorId: VENDOR_B_ID },
  ]);
});
afterEach(() => {
  t.dispose();
  vi.unstubAllGlobals();
});

async function seedLicense(
  id: string,
  over: Partial<typeof licenses.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(licenses).values({
    id,
    billingAccountId: ACCOUNT,
    source: 'complimentary',
    startsAt: OLD_TS,
    endsAt: TODAY,
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
    ...over,
  });
}

const licenseOf = async (id: string) =>
  (await t.db.select().from(licenses).where(eq(licenses.id, id)))[0]!;
const vendorOf = async (id = VENDOR_ID) =>
  (await t.db.select().from(vendors).where(eq(vendors.id, id)))[0]!;
const audits = () => t.db.select().from(auditLog);

interface Sent {
  to: string;
  products: string[];
  cause: string;
  dedupeKey: string | undefined;
}

function sender() {
  const sent: Sent[] = [];
  const send = vi.fn(async (_c, o) => {
    sent.push({
      to: o.to,
      products: o.products.map((p: { slug: string }) => p.slug),
      cause: o.cause,
      dedupeKey: o.dedupeKey,
    });
    return 'sent' as const;
  }) as unknown as SendManagedEnded;
  return { sent, send };
}

function ctx(env: Partial<Env> = {}): EmailContext {
  return {
    env: { ...env } as Env,
    executionCtx: { waitUntil: () => {} },
    req: { raw: new Request('https://aeci-api/cron/entitlement-expiry') },
  };
}

const seatEmails = async (_env: Env, ids: readonly string[]) =>
  new Map(ids.map((id) => [id, `seat-${id.slice(0, 4)}@acme.example`]));

function lapse(extra: Partial<LapseDeps> & { env?: Partial<Env>; db?: Db } = {}, s = sender()) {
  const { env, db, ...deps } = extra;
  return runLicenseLapse(ctx(env), db ?? t.db, {
    now: NOW,
    fetchSeatEmails: seatEmails,
    sendEnded: s.send,
    ...deps,
  });
}

describe('the scan', () => {
  it('ends a term on its end day from 00:00Z, and leaves tomorrow and monthly alone', async () => {
    await seedLicense('l-today', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    // Assigned, so neither is a pool license the product could carry onto.
    await seedLicense('l-tomorrow', { endsAt: TOMORROW, assignedProductId: 'p-2' });
    await seedLicense('l-monthly', { endsAt: null, assignedProductId: 'p-3' });

    const result = await lapse();

    expect(result).toMatchObject({ lapsedTerms: 1, lapsedLicenses: 1, droppedProducts: 1 });
    expect(await licenseOf('l-today')).toMatchObject({
      endedAt: NOW.toISOString(),
      endReason: 'lapsed',
      // Decision 14: an ended license keeps its product as history.
      assignedProductId: 'p-1',
    });
    expect((await licenseOf('l-tomorrow')).endedAt).toBeNull();
    expect((await licenseOf('l-monthly')).endedAt).toBeNull();
  });

  it('ends an older passed term too: there is no lower bound', async () => {
    await seedLicense('l-old', { endsAt: '2026-09-01T00:00:00.000Z' });
    expect((await lapse()).lapsedTerms).toBe(1);
    expect((await licenseOf('l-old')).endReason).toBe('lapsed');
  });

  it('writes one audit row per license, as the system, and drops the mirror on the last one', async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    await lapse();
    const [row] = await audits();
    expect(row).toMatchObject({
      action: 'license.lapsed',
      actorType: 'system',
      actorId: null,
      entityType: 'billing_account',
      entityId: ACCOUNT,
      productId: 'p-1',
    });
    expect(row!.metadata).toMatchObject({
      source: 'license-lapse-cron',
      license_id: 'l-1',
      ends_at: TODAY,
    });
    expect((await vendorOf()).verified).toBe(false);
  });

  it('is idempotent: a re-run ends nothing and sends nothing', async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    await lapse();
    const s = sender();
    const again = await lapse({}, s);
    expect(again).toMatchObject({ lapsedTerms: 0, lapsedLicenses: 0 });
    expect(s.sent).toHaveLength(0);
    expect(await audits()).toHaveLength(1);
  });

  it('caps the run in terms, counts the metric, and leaves the rest for tomorrow', async () => {
    await seedLicense('l-a1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    await seedLicense('l-a2', { assignedProductId: 'p-2', assignedAt: OLD_TS });
    await seedLicense('l-b', { billingAccountId: ACCOUNT_B, assignedProductId: 'p-b' });
    const count = vi.fn();

    const result = await lapse({ termCap: 1, metrics: { count } });

    // The oldest term by (ends_at, account) goes first, whole: both of its licenses.
    expect(result).toMatchObject({ lapsedTerms: 1, lapsedLicenses: 2, capped: 1 });
    expect(count).toHaveBeenCalledWith(LAPSE_CAPPED_METRIC, 1, []);
    expect((await licenseOf('l-b')).endedAt).toBeNull();
    expect((await lapse()).lapsedTerms).toBe(1);
    expect((await licenseOf('l-b')).endedAt).not.toBeNull();
  });
});

describe('the race guard', () => {
  it('an admin extend that commits between the read and the batch wins', async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    await seedLicense('l-2', { assignedProductId: 'p-2', assignedAt: OLD_TS });
    // Only l-2 is extended, so l-1's guarded UPDATE would still match on its own.
    // The sentinel after l-2 rolls the whole term back: never half-ended.
    const racing = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'batch') {
          return async (stmts: Parameters<Db['batch']>[0]) => {
            await target.update(licenses).set({ endsAt: NEXT_YEAR }).where(eq(licenses.id, 'l-2'));
            return target.batch(stmts);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Db;
    const s = sender();

    const result = await lapse({ db: racing }, s);

    expect(result).toMatchObject({ lapsedTerms: 0, batchFailures: 1 });
    expect((await licenseOf('l-1')).endedAt).toBeNull();
    expect((await licenseOf('l-2')).endedAt).toBeNull();
    expect(await audits()).toHaveLength(0);
    expect(s.sent).toHaveLength(0);
    expect((await vendorOf()).verified).toBe(true);
  });
});

describe('released versus lapsed, and the emails', () => {
  it('ends a release-at-renewal license as released, in its own email', async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    await seedLicense('l-2', {
      assignedProductId: 'p-2',
      assignedAt: OLD_TS,
      releaseAtRenewal: true,
    });
    await seedLicense('l-pool');
    const s = sender();

    const result = await lapse({}, s);

    expect(result).toMatchObject({ lapsedTerms: 1, lapsedLicenses: 3, droppedProducts: 2 });
    expect((await licenseOf('l-1')).endReason).toBe('lapsed');
    expect((await licenseOf('l-2')).endReason).toBe('released');
    expect((await licenseOf('l-pool')).endReason).toBe('lapsed');

    // One email per cause, each to the seat and the billing email. The pool license
    // changed no product, so it is in neither.
    const lapsed = s.sent.filter((m) => m.cause === 'lapsed');
    const released = s.sent.filter((m) => m.cause === 'released');
    expect(lapsed.map((m) => m.to).sort()).toEqual([
      'billing@acme.example',
      'seat-2222@acme.example',
    ]);
    expect(lapsed.every((m) => m.products.join() === 'acme-one')).toBe(true);
    expect(released.every((m) => m.products.join() === 'acme-two')).toBe(true);
    expect(released).toHaveLength(2);
    expect(lapsed[0]!.dedupeKey).toBe(
      await managedEndedTermDedupeKey(ACCOUNT, TODAY, 'lapsed', lapsed[0]!.to),
    );
    expect(result.emails.sent).toBe(4);
  });

  it('sends each address once when the billing email is also a seat', async () => {
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: ' SEAT-2222@acme.example ' })
      .where(eq(billingAccounts.id, ACCOUNT));
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    const s = sender();
    await lapse({}, s);
    expect(s.sent.map((m) => m.to)).toEqual(['seat-2222@acme.example']);
  });

  it('sends nothing when only pool licenses lapse', async () => {
    await seedLicense('l-pool');
    const s = sender();
    const result = await lapse({}, s);
    expect(result.lapsedLicenses).toBe(1);
    expect(s.sent).toHaveLength(0);
  });
});

describe('fewer licenses than products: the carry-over (AECI-1405)', () => {
  it('carries the 2 products assigned longest, and emails only the one left over', async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: '2026-06-01T00:00:00.000Z' });
    await seedLicense('l-2', { assignedProductId: 'p-2', assignedAt: OLD_TS });
    await seedLicense('l-3', { assignedProductId: 'p-3', assignedAt: '2025-01-01T00:00:00.000Z' });
    await seedLicense('pool-1', { endsAt: NEXT_YEAR, createdAt: '2026-01-01T00:00:00.000Z' });
    await seedLicense('pool-2', { endsAt: null, createdAt: '2026-02-01T00:00:00.000Z' });
    const s = sender();
    const sent: Array<{ fewerLicenses?: boolean }> = [];
    const send = vi.fn(async (c, o) => {
      sent.push({ fewerLicenses: o.fewerLicenses });
      return s.send(c, o);
    }) as unknown as SendManagedEnded;
    const sendBatch = vi.fn().mockResolvedValue(undefined);

    const result = await lapse({
      sendEnded: send,
      env: { CACHE_PURGE_QUEUE: { sendBatch } as never },
    });

    expect(result).toMatchObject({ lapsedLicenses: 3, carried: 2, droppedProducts: 1 });
    expect((await licenseOf('pool-1')).assignedProductId).toBe('p-2');
    expect((await licenseOf('pool-2')).assignedProductId).toBe('p-3');
    expect(s.sent.every((m) => m.products.join() === 'acme-one')).toBe(true);
    expect(sent.every((m) => m.fewerLicenses === true)).toBe(true);
    // The dropped product is purged. (The vendor set carries every owned product's tag.)
    const tags = sendBatch.mock.calls[0]![0][0].body.tags as string[];
    expect(tags).toContain('product:acme-one');
    expect((await vendorOf()).verified).toBe(true);
  });

  it('does not carry a product the vendor no longer owns', async () => {
    await t.db.delete(productVendors).where(eq(productVendors.productId, 'p-1'));
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    await seedLicense('pool-1', { endsAt: null });
    const result = await lapse();
    expect(result).toMatchObject({ carried: 0, droppedProducts: 1 });
    expect((await licenseOf('pool-1')).assignedProductId).toBeNull();
  });

  it('a product released at renewal does not carry, and its email has no carry-over line', async () => {
    await seedLicense('l-1', {
      assignedProductId: 'p-1',
      assignedAt: OLD_TS,
      releaseAtRenewal: true,
    });
    await seedLicense('pool-1', { endsAt: null });
    const sent: Array<{ cause: string; fewerLicenses?: boolean }> = [];
    const send = vi.fn(async (_c, o) => {
      sent.push({ cause: o.cause, fewerLicenses: o.fewerLicenses });
      return 'sent' as const;
    }) as unknown as SendManagedEnded;
    const result = await lapse({ sendEnded: send });
    expect(result.carried).toBe(0);
    expect(sent.every((m) => m.cause === 'released' && m.fewerLicenses === false)).toBe(true);
  });
});

describe('after commit', () => {
  it('queues ONE purge message, source moderation, with the dropped products and the vendor set', async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    await seedLicense('l-b', { billingAccountId: ACCOUNT_B, assignedProductId: 'p-b' });
    const sendBatch = vi.fn().mockResolvedValue(undefined);

    await lapse({ env: { CACHE_PURGE_QUEUE: { sendBatch } as never } });

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const [messages] = sendBatch.mock.calls[0]!;
    expect(messages).toHaveLength(1);
    expect(messages[0].body.source).toBe('moderation');
    expect(messages[0].body.tags).toEqual(
      expect.arrayContaining([
        'product:acme-one',
        'product:bolt-one',
        'index:products',
        'vendor:acme',
        'vendor:bolt',
      ]),
    );
  });

  it('purges the vendor set alone when an unassigned last license flips the mirror', async () => {
    await seedLicense('l-pool');
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    await lapse({ env: { CACHE_PURGE_QUEUE: { sendBatch } as never } });
    const tags = sendBatch.mock.calls[0]![0][0].body.tags as string[];
    expect(tags).toContain('vendor:acme');
  });

  it('forwards every committed audit row in ONE logs request', async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    await seedLicense('l-b', { billingAccountId: ACCOUNT_B, assignedProductId: 'p-b' });
    const intake = stubPosthogIntake();
    await lapse({ env: { POSTHOG_PROJECT_KEY: 'phc_test' } });
    const forwards = intake.auditRequests();
    expect(forwards).toHaveLength(1);
    expect(forwards[0]!.messages).toHaveLength(2);
  });

  it('a failed purge or send never undoes the lapse', async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    const sendBatch = vi.fn().mockRejectedValue(new Error('queue down'));
    const send = vi.fn().mockRejectedValue(new Error('resend down')) as unknown as SendManagedEnded;
    const result = await lapse({
      env: { CACHE_PURGE_QUEUE: { sendBatch } as never },
      sendEnded: send,
    });
    expect(result.lapsedTerms).toBe(1);
    expect((await licenseOf('l-1')).endedAt).not.toBeNull();
  });
});
