import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { logPageview } from './services/analytics';
import { subscribe } from './services/subscribe';
import { feedback } from './services/feedback';

const app = new Hono<{ Bindings: Env }>();

// Redirect apex domain to www
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === 'aecintegrations.com') {
    url.hostname = 'www.aecintegrations.com';
    return c.redirect(url.toString(), 301);
  }
  await next();
});

function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function buildCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self'",
    "connect-src 'self' https://us.i.posthog.com",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function injectNonce(html: string, nonce: string): string {
  // Add nonce to all <script> tags except JSON-LD (which is non-executable)
  return html.replace(
    /<script(?!\s+type\s*=\s*"application\/ld\+json")/g,
    `<script nonce="${nonce}"`,
  );
}

// Security and cache headers
app.use('*', async (c, next) => {
  await next();
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()',
  );
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('X-Permitted-Cross-Domain-Policies', 'none');

  const path = new URL(c.req.url).pathname;
  const isStatic =
    path.startsWith('/assets/') ||
    path === '/robots.txt' ||
    path === '/sitemap.xml' ||
    path === '/manifest.json' ||
    path === '/favicon-i.svg' ||
    path === '/favicon-i.ico';

  if (isStatic) {
    c.header('Cache-Control', 'public, max-age=86400');
  } else {
    c.header('Cache-Control', 'no-cache');
  }
});

app.post('/api/subscribe', cors(), subscribe);
app.post('/api/feedback', cors(), feedback);

app.all('*', async (c) => {
  logPageview(c);
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const contentType = response.headers.get('Content-Type') || '';

  if (!contentType.includes('text/html')) {
    return response;
  }

  const nonce = generateNonce();
  const html = await response.text();
  const nonced = injectNonce(html, nonce);

  return new Response(nonced, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers),
      'Content-Security-Policy': buildCsp(nonce),
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
});

export default app;
