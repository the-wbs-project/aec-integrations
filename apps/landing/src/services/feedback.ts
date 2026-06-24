import type { Context } from 'hono';
import type { Env } from '../types';
import { sendNotification } from './email';

interface FeedbackBody {
  features?: string;
  tools?: string;
  email?: string;
  subscribe?: boolean;
}

export async function feedback(c: Context<{ Bindings: Env }>) {
  const body = await c.req.json<FeedbackBody>();
  const features = body.features?.trim() || null;
  const tools = body.tools?.trim() || null;

  if (!features && !tools) {
    return c.json({ error: 'Please share at least one suggestion.' }, 400);
  }

  const email = body.email?.trim().toLowerCase() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ error: 'Please enter a valid email address.' }, 400);
  }

  const cf = c.req.raw.cf as Record<string, unknown> | undefined;
  const subscribe = Boolean(body.subscribe);

  // request.cf is read HERE (it does not survive the env.API service binding) and
  // sent in the body; the API Worker persists it to the D1 `feedback` table.
  const row = {
    features,
    tools,
    email,
    subscribed: subscribe,
    country: cf?.country ?? null,
    city: cf?.city ?? null,
    region: cf?.region ?? null,
    timezone: cf?.timezone ?? null,
    referrer: c.req.header('referer') ?? null,
  };

  const res = await c.env.API.fetch('https://api/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('Feedback persist error:', res.status, text);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  }

  c.executionCtx.waitUntil(
    sendNotification(c.env, {
      subject: '[AEC] New feedback submitted',
      bodyText: [
        email ? `From: ${email}` : 'From: (anonymous)',
        '',
        'Features requested:',
        features ?? '(none)',
        '',
        'Tools/software used:',
        tools ?? '(none)',
        '',
        `Subscribed: ${subscribe ? 'yes' : 'no'}`,
        `Location: ${row.city ?? '—'}, ${row.region ?? '—'}, ${row.country ?? '—'}`,
      ].join('\n'),
      bodyHtml: `
<p>Someone just submitted feedback on AEC Integrations.</p>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td><strong>From</strong></td><td>${email ?? '(anonymous)'}</td></tr>
  <tr><td><strong>Features requested</strong></td><td>${features ?? '(none)'}</td></tr>
  <tr><td><strong>Tools/software</strong></td><td>${tools ?? '(none)'}</td></tr>
  <tr><td><strong>Subscribed</strong></td><td>${subscribe ? 'yes' : 'no'}</td></tr>
  <tr><td><strong>Location</strong></td><td>${row.city ?? '—'}, ${row.region ?? '—'}, ${row.country ?? '—'}</td></tr>
  <tr><td><strong>Referrer</strong></td><td>${row.referrer ?? '—'}</td></tr>
</table>`,
    }).catch((err) => console.error('Notification error:', err)),
  );

  // Also add to mailing list if they opted in and provided an email
  if (subscribe && email) {
    const url = new URL(c.req.url);
    const subRow = {
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

    // Best-effort — don't fail the feedback submission if this errors
    await c.env.API.fetch('https://api/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subRow),
    }).catch(() => {});
  }

  return c.json({ success: true }, 201);
}
