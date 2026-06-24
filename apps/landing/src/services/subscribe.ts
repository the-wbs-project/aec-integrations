import type { Context } from 'hono';
import type { Env } from '../types';
import { sendNotification } from './email';

interface SubscribeBody {
  email?: string;
}

export async function subscribe(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<SubscribeBody>();
  const email = body.email?.trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'A valid email address is required.' }, 400);
  }

  const cf = c.req.raw.cf as Record<string, unknown> | undefined;
  const url = new URL(c.req.url);

  // request.cf is read HERE (it does not survive the env.API service binding) and
  // sent in the body; the API Worker persists it to the D1 `mailing_list` table.
  const row = {
    email,
    country: cf?.country ?? null,
    city: cf?.city ?? null,
    region: cf?.region ?? null,
    timezone: cf?.timezone ?? null,
    as_organization: cf?.asOrganization ? String(cf.asOrganization) : null,
    asn: cf?.asn ? Number(cf.asn) : null,
    metro_code: cf?.metroCode ? Number(cf.metroCode) : null,
    utm_source: url.searchParams.get('utm_source') ?? null,
    utm_medium: url.searchParams.get('utm_medium') ?? null,
    utm_campaign: url.searchParams.get('utm_campaign') ?? null,
    referrer: c.req.header('referer') ?? null,
  };

  const res = await c.env.API.fetch('https://api/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Subscribe persist error:', res.status, text);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  }

  // The API returns `{ created }`: `false` means the email is already on the list
  // (idempotent ON CONFLICT DO NOTHING no-op) → the friendly "already on the list".
  const result = (await res.json().catch(() => ({ created: true }))) as { created?: boolean };
  if (result.created === false) {
    return c.json({ error: 'This email is already on the list.' }, 409);
  }

  c.executionCtx.waitUntil(
    sendNotification(c.env, {
      subject: '[AEC] New mailing list signup',
      bodyText: [
        `New subscriber: ${email}`,
        `Location: ${row.city ?? '—'}, ${row.region ?? '—'}, ${row.country ?? '—'}`,
        `Source: ${row.utm_source ?? 'direct'}`,
      ].join('\n'),
      bodyHtml: `
<p>Someone just signed up for the AEC Integrations mailing list.</p>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td><strong>Email</strong></td><td>${email}</td></tr>
  <tr><td><strong>Location</strong></td><td>${row.city ?? '—'}, ${row.region ?? '—'}, ${row.country ?? '—'}</td></tr>
  <tr><td><strong>Organization</strong></td><td>${row.as_organization ?? '—'}</td></tr>
  <tr><td><strong>Source</strong></td><td>${row.utm_source ?? 'direct'}</td></tr>
  <tr><td><strong>Campaign</strong></td><td>${row.utm_campaign ?? '—'}</td></tr>
  <tr><td><strong>Referrer</strong></td><td>${row.referrer ?? '—'}</td></tr>
</table>`,
    }).catch((err) => console.error('Notification error:', err)),
  );

  return c.json({ success: true }, 201);
}
