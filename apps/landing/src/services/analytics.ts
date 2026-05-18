import type { Context } from 'hono';
import type { Env } from '../types';

export function logPageview(c: Context<{ Bindings: Env }>) {
  try {
    const url = new URL(c.req.url);
    const cf = c.req.raw.cf as Record<string, unknown> | undefined;

    c.env.ANALYTICS.writeDataPoint({
      indexes: [url.pathname],
      blobs: [
        c.req.header('referer') ?? '',
        c.req.header('user-agent') ?? '',
        cf?.country ?? '',
        cf?.city ?? '',
        cf?.region ?? '',
        String(cf?.asOrganization ?? ''),
        String(cf?.asn ?? ''),
        url.searchParams.get('utm_source') ?? '',
        url.searchParams.get('utm_medium') ?? '',
        url.searchParams.get('utm_campaign') ?? '',
      ],
      doubles: [cf?.metroCode ? Number(cf.metroCode) : 0],
    });
  } catch {
    // Analytics should never break the request
  }
}
