/**
 * Proxy-header strip for the SSR render (AECI-1477) — Angular-free so it runs
 * under plain-Node Vitest.
 *
 * The Cloudflare edge adds `x-forwarded-proto` and `x-forwarded-for` to every
 * inbound request, and the gateway carries them through the `ctx.exports`
 * loopback to `Renderer`. `AngularAppEngine.handle()` deletes every
 * `forwarded` / `x-forwarded-*` header that `trustProxyHeaders` does not allow
 * (`@angular/ssr` `sanitizeRequestHeaders`), and `console.warn`s once per
 * deleted header. That was two Workers Logs rows on every production render.
 *
 * We strip rather than trust: nothing in SSR reads these headers.
 * `servingOrigin()` takes the origin from `request.url`, the Fetch path of
 * `AngularAppEngine` never builds a URL from proxy headers, and the client IP
 * comes from `cf-connecting-ip`. Trusting them would put a client-spoofable
 * `x-forwarded-for` into `REQUEST` for no reader. Stripping keeps Angular's
 * default-deny result and drops only the warning. Only the Request handed to
 * Angular is stripped; the `/api/*` passthrough and the page-view arrival
 * write run upstream and are unaffected.
 */

/** The predicate `@angular/ssr` uses to decide what counts as a proxy header. */
export function isProxyHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'forwarded' || lower.startsWith('x-forwarded-');
}

/**
 * Returns `request` with every proxy header removed. Returns the same instance
 * when there is nothing to remove, so the common case allocates nothing.
 */
export function stripProxyHeaders(request: Request): Request {
  const proxyHeaders = [...request.headers.keys()].filter(isProxyHeader);
  if (proxyHeaders.length === 0) return request;
  const headers = new Headers(request.headers);
  for (const name of proxyHeaders) headers.delete(name);
  return new Request(request, { headers });
}
