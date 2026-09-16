import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, products, productVendors, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createGetLogoHandler,
  createUploadLogoHandler,
  createUpdateAdminLogoHandler,
  readLogoBody,
  LOGO_REQUEST_MAX_BYTES,
} from './logos';
import { createUpdateVendorProductHandler, createUpdateVendorProfileHandler } from './vendor';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));
const image = new Uint8Array(readFileSync(join(__dirname, '../test/fixtures/logos/valid.png')));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUTH: AuthzVariables['auth'] = {
  userId: uuid(1),
  email: 'admin@example.com',
  role: 'admin',
  vendorId: uuid(2),
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
};
let t: TestDb;
let objects: Map<string, Uint8Array>;
let put: ReturnType<typeof vi.fn>;
let env: Env;
function app(auth = AUTH) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.post('/api/vendor/logo', createUploadLogoHandler('vendor'));
  app.post('/api/admin/logo', createUploadLogoHandler('admin'));
  app.get('/api/logos/:key', createGetLogoHandler());
  app.patch('/api/admin/vendors/:id/logo', createUpdateAdminLogoHandler('vendor', t.factory));
  app.patch('/api/admin/products/:id/logo', createUpdateAdminLogoHandler('product', t.factory));
  app.patch('/api/vendor/profile', createUpdateVendorProfileHandler(t.factory));
  app.patch('/api/vendor/products/:id', createUpdateVendorProductHandler(t.factory));
  return app;
}
const request = (path: string, init: RequestInit = {}, auth = AUTH) =>
  app(auth).request(`https://example.com${path}`, init, env, fakeExecutionContext());
const upload = (body: FormData, origin = 'https://example.com', auth = AUTH) =>
  request('/api/vendor/logo', { method: 'POST', body, headers: { origin } }, auth);
function form(bytes: Uint8Array = image) {
  const form = new FormData();
  form.append(
    'file',
    new File([Uint8Array.from(bytes)], '../../evil.svg', { type: 'image/svg+xml' }),
  );
  return form;
}
const patch = (path: string, data: unknown) =>
  request(path, {
    method: 'PATCH',
    headers: { origin: 'https://example.com', 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
beforeEach(async () => {
  t = await makeTestDb();
  objects = new Map();
  put = vi.fn(async (key: string, value: Uint8Array) => {
    objects.set(key, value);
  });
  const get = vi.fn(async (key: string) => {
    const data = objects.get(key);
    return data
      ? {
          size: data.length,
          arrayBuffer: async () => Uint8Array.from(data).buffer,
          body: new Blob([Uint8Array.from(data)]).stream(),
          httpMetadata: { contentType: 'text/html' },
        }
      : null;
  });
  env = {
    ...TEST_ENV,
    UPLOADS: { get, put } as unknown as R2Bucket,
    CACHE_PURGE_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
    } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  await t.db.insert(vendors).values({ id: uuid(2), slug: 'vendor', companyName: 'Vendor' });
  await t.db.insert(products).values({ id: uuid(3), slug: 'product', name: 'Product' });
  await t.db
    .insert(productVendors)
    .values({ productId: uuid(3), vendorId: uuid(2), isPrimary: true });
  await t.db.insert(profiles).values({ id: uuid(1), role: 'admin' });
});
afterEach(() => t.dispose());

describe('logo routes', () => {
  it('ignores filename/MIME, deduplicates and does not write catalog or audit', async () => {
    const first = await upload(form());
    expect(first.status).toBe(200);
    const body = (await first.json()) as { logo_url: string };
    expect(body.logo_url).toMatch(/^\/api\/logos\/[a-f0-9]{64}$/);
    expect(await (await upload(form())).json()).toEqual(body);
    expect(objects.size).toBe(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect((await t.db.select().from(vendors))[0]?.logoUrl).toBeNull();
    const response = await request(body.logo_url);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(image);
  });
  it('rejects extra fields/files, wrong names, SVG and malformed multipart without storage', async () => {
    const extra = form();
    extra.append('file', new File([image], 'other.png'));
    const field = form();
    field.append('caption', 'not allowed');
    const wrong = new FormData();
    wrong.append('photo', new File([image], 'image.png'));
    for (const body of [extra, field, wrong, form(new TextEncoder().encode('<svg/>'))])
      expect((await upload(body)).status).toBe(400);
    expect(
      (
        await request('/api/admin/logo', {
          method: 'POST',
          headers: {
            origin: 'https://example.com',
            'content-type': 'multipart/form-data; boundary=nope',
          },
          body: 'invalid',
        })
      ).status,
    ).toBe(400);
    expect(put).not.toHaveBeenCalled();
  });
  it('denies cross-origin, missing origin with cookies, and unentitled uploads before storage', async () => {
    expect((await upload(form(), 'https://attacker.example')).status).toBe(403);
    expect((await request('/api/vendor/logo', { method: 'POST', body: form() })).status).toBe(403);
    expect(
      (await upload(form(), 'https://example.com', { ...AUTH, entitlementTier: 'unclaimed' }))
        .status,
    ).toBe(403);
    expect(put).not.toHaveBeenCalled();
  });
  it('bounds actual streamed bytes without relying on Content-Length', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(LOGO_REQUEST_MAX_BYTES + 1));
      },
      cancel,
    });
    await expect(
      readLogoBody(
        new Request('https://example.com', { method: 'POST', body, duplex: 'half' } as RequestInit),
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalled();
  });
  it('returns non-cacheable errors for missing, malformed and corrupt objects', async () => {
    objects.set('a'.repeat(64), new TextEncoder().encode('<script/>'));
    for (const key of ['bad', 'a'.repeat(64), 'b'.repeat(64)]) {
      const response = await request(`/api/logos/${key}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
  });
  it.each(['vendors', 'products'])(
    'admin saves and clears %s logos with provenance, audit and purge',
    async (kind) => {
      const id = kind === 'vendors' ? uuid(2) : uuid(3);
      const table = kind === 'vendors' ? vendors : products;
      for (const value of ['https://example.com/logo.png', null]) {
        expect((await patch(`/api/admin/${kind}/${id}/logo`, { logo_url: value })).status).toBe(
          200,
        );
        const [row] = await t.db.select().from(table).where(eq(table.id, id));
        expect(row).toMatchObject({ logoUrl: value, logoSource: 'admin' });
      }
      expect(await t.db.select().from(auditLog)).toHaveLength(2);
      expect(env.CACHE_PURGE_QUEUE?.send).toHaveBeenCalledWith({
        tags: kind === 'vendors' ? ['vendor:vendor'] : ['product:product', 'index:products'],
        source: 'moderation',
      });
    },
  );
  it('rolls the logo back when the audit insert fails', async () => {
    t.raw.exec(
      "CREATE TRIGGER fail_logo_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
    );
    expect(
      (
        await patch(`/api/admin/vendors/${uuid(2)}/logo`, {
          logo_url: 'https://example.com/new.png',
        })
      ).status,
    ).toBe(500);
    expect((await t.db.select().from(vendors))[0]).toMatchObject({
      logoUrl: null,
      logoSource: null,
    });
  });
  it('rejects extra admin fields and nonexistent local paths', async () => {
    for (const payload of [
      { logo_url: null, company_name: 'attack' },
      { logo_url: `/api/logos/${'c'.repeat(64)}` },
      { logo_url: 'javascript:alert(1)' },
      { logo_url: '//evil.example/logo' },
    ]) {
      expect((await patch(`/api/admin/vendors/${uuid(2)}/logo`, payload)).status).toBe(400);
    }
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
  it('rejects nonexistent local paths on vendor profile and product saves', async () => {
    const logo_url = `/api/logos/${'c'.repeat(64)}`;
    for (const path of ['/api/vendor/profile', `/api/vendor/products/${uuid(3)}`]) {
      const response = await patch(path, { logo_url });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
    expect((await t.db.select().from(vendors))[0]).toMatchObject({
      logoUrl: null,
      logoSource: null,
    });
    expect((await t.db.select().from(products))[0]).toMatchObject({
      logoUrl: null,
      logoSource: null,
    });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
  it('vendor saves local paths, preserves source on omission, and owns explicit clears', async () => {
    const { logo_url } = (await (await upload(form())).json()) as { logo_url: string };
    for (const path of ['/api/vendor/profile', `/api/vendor/products/${uuid(3)}`]) {
      expect((await patch(path, { logo_url })).status).toBe(200);
      expect((await patch(path, { description: 'Edited description' })).status).toBe(200);
    }
    expect((await t.db.select().from(vendors))[0]).toMatchObject({
      logoUrl: logo_url,
      logoSource: 'vendor',
    });
    expect((await t.db.select().from(products))[0]).toMatchObject({
      logoUrl: logo_url,
      logoSource: 'vendor',
    });
    expect((await patch('/api/vendor/profile', { logo_url: null })).status).toBe(200);
    expect((await t.db.select().from(vendors))[0]).toMatchObject({
      logoUrl: null,
      logoSource: 'vendor',
    });
    expect(
      (
        await request(
          `/api/vendor/products/${uuid(3)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ logo_url }),
          },
          { ...AUTH, vendorId: uuid(99) },
        )
      ).status,
    ).toBe(404);
  });
});
