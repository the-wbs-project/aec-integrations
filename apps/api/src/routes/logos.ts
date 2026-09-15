import {
  LOGO_MAX_BYTES,
  LogoKeySchema,
  LogoPathSchema,
  UploadLogoResponseSchema,
  UpdateLogoSchema,
  type AuditLogEntry,
} from '@aeci/shared';
import { hasCapability } from '@aeci/shared/entitlements';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { products, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert } from '../lib/audit';
import { auditActorType, requireCapability, type AuthzVariables } from '../lib/authz';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { validateLogo } from '../lib/logo-validation';
import { logToPosthog } from '../posthog';
import { parseJsonBody } from './vendor-shared';

type LogoContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;
export const LOGO_REQUEST_MAX_BYTES = LOGO_MAX_BYTES + 16 * 1024;

function bucket(env: Env): R2Bucket {
  if (!env.UPLOADS) throw new ApiError(503, 'DEPENDENCY_FAILURE', 'Logo uploads are unavailable.');
  return env.UPLOADS;
}

/** Bound actual bytes before invoking the platform multipart parser. */
export async function readLogoBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () =>
    new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Logo upload is too large.', { field: 'file' });
  if (Number(request.headers.get('content-length')) > LOGO_REQUEST_MAX_BYTES) throw tooLarge();
  if (!request.body) throw new ApiError(400, 'MALFORMED_REQUEST', 'Missing upload body.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LOGO_REQUEST_MAX_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function requireLogoOrigin(c: LogoContext): void {
  const origin = c.req.header('origin');
  if (
    origin
      ? origin !== new URL(c.req.url).origin
      : !c.req.header('authorization')?.startsWith('Bearer ')
  ) {
    throw new ApiError(403, 'FORBIDDEN', 'A same-origin request is required.');
  }
}

export function createUploadLogoHandler(actor: 'vendor' | 'admin') {
  return async (c: LogoContext): Promise<Response> => {
    if (actor === 'vendor' && !hasCapability(c.get('auth').entitlementTier, 'product.edit'))
      requireCapability(c, 'profile.edit');
    requireLogoOrigin(c);
    const uploads = bucket(c.env);
    const contentType = c.req.header('content-type') ?? '';
    if (!/^multipart\/form-data\s*;/i.test(contentType))
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Expected a multipart file upload.');
    const body = await readLogoBody(c.req.raw);
    let form: FormData;
    try {
      form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Invalid multipart upload.');
    }
    const entries: string[] = [];
    form.forEach((_value, key) => entries.push(key));
    const file = form.get('file');
    if (entries.length !== 1 || entries[0] !== 'file' || !(file instanceof File))
      throw new ApiError(400, 'VALIDATION_FAILED', 'Choose exactly one image file.', {
        field: 'file',
      });
    if (file.size > LOGO_MAX_BYTES)
      throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Logo must be no larger than 2 MiB.', {
        field: 'file',
      });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const format = validateLogo(bytes);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const key = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    await uploads.put(key, bytes, { httpMetadata: { contentType: format.contentType } });
    return json(UploadLogoResponseSchema.parse({ logo_url: `/api/logos/${key}` }));
  };
}

export async function assertStoredLogo(
  env: Env,
  logoUrl: string | null | undefined,
): Promise<void> {
  if (!logoUrl || !LogoPathSchema.safeParse(logoUrl).success) return;
  const object = await bucket(env).get(logoUrl.slice('/api/logos/'.length));
  if (!object)
    throw new ApiError(400, 'VALIDATION_FAILED', 'Upload this logo before saving.', {
      field: 'logo_url',
    });
  if (object.size > LOGO_MAX_BYTES) {
    await object.body.cancel();
    throw new ApiError(400, 'VALIDATION_FAILED', 'Invalid stored logo.', { field: 'logo_url' });
  }
  validateLogo(new Uint8Array(await object.arrayBuffer()));
}

export function createGetLogoHandler() {
  return async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    const result = LogoKeySchema.safeParse(c.req.param('key'));
    if (!result.success) throw new ApiError(404, 'NOT_FOUND', 'Logo not found.');
    const object = await bucket(c.env).get(result.data);
    if (!object) throw new ApiError(404, 'NOT_FOUND', 'Logo not found.');
    if (object.size > LOGO_MAX_BYTES) {
      await object.body.cancel();
      throw new ApiError(404, 'NOT_FOUND', 'Logo not found.');
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    let contentType: string;
    try {
      contentType = validateLogo(bytes).contentType;
    } catch {
      throw new ApiError(404, 'NOT_FOUND', 'Logo not found.');
    }
    return new Response(bytes, {
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: `"${result.data}"`,
      },
    });
  };
}

export function createUpdateAdminLogoHandler(kind: 'vendor' | 'product', dbFor: DbFactory = getDb) {
  return async (c: LogoContext): Promise<Response> => {
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing record id.');
    requireLogoOrigin(c);
    const payload = await parseJsonBody(c, UpdateLogoSchema);
    const { db } = writeDb(c, dbFor);
    const table = kind === 'vendor' ? vendors : products;
    const [before] = await db
      .select({ slug: table.slug, logoUrl: table.logoUrl, logoSource: table.logoSource })
      .from(table)
      .where(eq(table.id, id));
    if (!before) throw notFoundError(kind, { id });
    await assertStoredLogo(c.env, payload.logo_url);
    const columns = {
      logoUrl: payload.logo_url,
      logoSource: 'admin' as const,
      updatedAt: new Date().toISOString(),
    };
    const session = c.get('auth');
    const auditEntry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: kind === 'vendor' ? 'vendor.updated' : 'product.updated',
      entityType: kind,
      entityId: id,
      beforeState: { logoUrl: before.logoUrl, logoSource: before.logoSource },
      afterState: { logoUrl: columns.logoUrl, logoSource: columns.logoSource },
      metadata: { source: 'admin-panel', fields: ['logo_url'] },
    };
    await db.batch([
      db.update(table).set(columns).where(eq(table.id, id)),
      auditInsert(db, auditEntry),
    ]);
    const tags =
      kind === 'vendor' ? [`vendor:${before.slug}`] : [`product:${before.slug}`, 'index:products'];
    c.executionCtx.waitUntil(
      (async () => {
        try {
          await c.env.CACHE_PURGE_QUEUE?.send({ tags, source: 'moderation' });
        } catch (error) {
          console.warn('Logo cache purge failed', error);
        }
      })(),
    );
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${auditEntry.action} ${id}`,
      action: auditEntry.action,
      entity_type: kind,
      entity_id: id,
      source: 'admin-panel',
    });
    return json({ logo_url: columns.logoUrl });
  };
}
