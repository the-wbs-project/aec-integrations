/**
 * The tested core of `scripts/backfill-ownership-sync.ts` (AECI-1418, ruling Q7 on
 * AECI-1341): one ownership message per already-owned vendor, so the review app learns
 * every record the live app owned before the producers shipped.
 *
 * The script reads D1 through `wrangler d1 execute` and PUBLISHES onto the tier's
 * `aeci-ownership-sync-{env}` queue through the Cloudflare Queues HTTP publish endpoint.
 * It never calls the review app itself: the Worker's consumer does, exactly as for a
 * live claim approval, so the backfill exercises the real delivery path, its ledger
 * and its retries. The message carries no ownership data (§4d), so a re-run is
 * harmless: each delivery sends the vendor's current state.
 *
 * No `audit_log` row: enqueuing changes no domain state (ADR 0022). The delivery
 * ledger (`ownership_sync_deliveries`) records each send.
 */

import { OwnershipSyncMessageSchema, type OwnershipSyncMessage } from '@aeci/shared';

/** A vendor row the script reads. */
export interface BackfillOwnedVendorRow {
  id: string;
  slug: string;
  company_name: string;
  owned_at: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every owned vendor, or the one named by `vendorId` whether owned or not (a re-send
 * after a return to AECi). The id is validated before it is interpolated.
 */
export function buildOwnedVendorsSql(vendorId?: string): string {
  if (vendorId !== undefined) {
    if (!UUID.test(vendorId)) throw new Error(`--vendor must be a vendor UUID. Got: ${vendorId}`);
    return `SELECT id, slug, company_name, owned_at FROM vendors WHERE id = '${vendorId}';`;
  }
  return 'SELECT id, slug, company_name, owned_at FROM vendors WHERE owned_at IS NOT NULL ORDER BY id;';
}

/** One message per vendor, `reason: 'backfill'`, validated against the wire schema. */
export function planOwnershipBackfill(
  rows: readonly BackfillOwnedVendorRow[],
  now: Date,
): OwnershipSyncMessage[] {
  const enqueuedAt = now.toISOString();
  return [...new Map(rows.map((r) => [r.id, r])).values()].map((r) =>
    OwnershipSyncMessageSchema.parse({ vendorId: r.id, reason: 'backfill', enqueuedAt }),
  );
}

export function formatBackfillReport(rows: readonly BackfillOwnedVendorRow[]): string {
  if (rows.length === 0) return 'No vendors to send.';
  const lines = rows.map(
    (r) =>
      `  ${r.id}  ${r.company_name} (${r.slug})  owner=${r.owned_at ? `vendor since ${r.owned_at}` : 'aeci'}`,
  );
  return [`${rows.length} vendor(s):`, ...lines].join('\n');
}

/** The Cloudflare Queues HTTP publish endpoint for one message. */
export function queuePublishUrl(accountId: string, queueId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queueId)}/messages`;
}

export interface PublishOutcome {
  vendorId: string;
  ok: boolean;
  status: number | null;
  error?: string;
}

/**
 * Publish each message, one request at a time (a handful of vendors; no fan-out).
 * Every response body is read, so none is left open. Never throws: each failure is
 * returned, and the caller exits non-zero.
 */
export async function publishOwnershipMessages(args: {
  fetch: typeof fetch;
  accountId: string;
  queueId: string;
  apiToken: string;
  messages: readonly OwnershipSyncMessage[];
}): Promise<PublishOutcome[]> {
  const out: PublishOutcome[] = [];
  const url = queuePublishUrl(args.accountId, args.queueId);
  for (const message of args.messages) {
    try {
      const res = await args.fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${args.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body: message, content_type: 'json' }),
      });
      const text = await res.text();
      let success = res.ok;
      try {
        success = success && (JSON.parse(text) as { success?: boolean }).success !== false;
      } catch {
        // A non-JSON 2xx is treated by status alone.
      }
      out.push({
        vendorId: message.vendorId,
        ok: success,
        status: res.status,
        ...(success ? {} : { error: text.slice(0, 300) }),
      });
    } catch (error) {
      out.push({
        vendorId: message.vendorId,
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return out;
}

// ─── Argv (pure, so the gates are unit-tested) ───────────────────────────────

export const BACKFILL_D1_ENVS = ['staging', 'demo', 'production'] as const;
export type BackfillEnv = (typeof BACKFILL_D1_ENVS)[number];

export interface BackfillTarget {
  label: 'local' | BackfillEnv;
  db: string;
  flags: string[];
  remote: boolean;
  queue: string;
}

export type BackfillArgs =
  | {
      ok: true;
      target: BackfillTarget;
      apply: boolean;
      vendorId?: string;
      queueId?: string;
    }
  | { ok: false; error: string };

function readValueFlag(argv: readonly string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

/**
 * Parse and gate the CLI. Refusals, in order:
 *  - no target (`--local` or `--env staging|demo|production`);
 *  - `--apply` on `--local`: the local queue lives inside `wrangler dev` (Miniflare)
 *    and has no publish endpoint outside it. A local claim approval exercises the
 *    same path;
 *  - `--apply` on production without `--allow-production`;
 *  - `--apply` on a remote tier without `--queue-id` (from `wrangler queues info`).
 */
export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  const apply = argv.includes('--apply');
  const vendorId = readValueFlag(argv, '--vendor');
  const queueId = readValueFlag(argv, '--queue-id');
  let target: BackfillTarget;
  if (argv.includes('--local')) {
    target = {
      label: 'local',
      db: 'aeci-app-preview',
      flags: ['--local'],
      remote: false,
      queue: 'aeci-ownership-sync-local',
    };
  } else {
    const env = readValueFlag(argv, '--env');
    if (!env || !(BACKFILL_D1_ENVS as readonly string[]).includes(env)) {
      return {
        ok: false,
        error: `Set --env ${BACKFILL_D1_ENVS.join('|')} (or --local). Got: ${env ?? '(unset)'}.`,
      };
    }
    const e = env as BackfillEnv;
    target = {
      label: e,
      db: `aeci-app-${e}`,
      flags: ['--env', e, '--remote'],
      remote: true,
      queue: `aeci-ownership-sync-${e}`,
    };
  }
  if (apply && !target.remote) {
    return {
      ok: false,
      error:
        'Refusing --apply with --local: the local queue exists only inside `wrangler dev` and cannot be published to from here. Approve a claim locally instead.',
    };
  }
  if (apply && target.label === 'production' && !argv.includes('--allow-production')) {
    return {
      ok: false,
      error:
        'Refusing to --apply against PRODUCTION without --allow-production. Re-run with both if intended.',
    };
  }
  if (apply && !queueId) {
    return {
      ok: false,
      error: `--apply needs --queue-id. Read it with: pnpm exec wrangler queues info ${target.queue}`,
    };
  }
  return {
    ok: true,
    target,
    apply,
    ...(vendorId ? { vendorId } : {}),
    ...(queueId ? { queueId } : {}),
  };
}
