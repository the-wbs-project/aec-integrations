/**
 * In-Worker rate limiting (AECI-773 / ADR 0026 / §15.1).
 *
 * An ADDITIONAL layer beneath the two Cloudflare Pro WAF rate-limit rules, which
 * this change leaves byte-for-byte untouched (`docs/waf-rate-limits.md` §1). The
 * two layers do different jobs and neither replaces the other: the WAF blocks at
 * the edge BEFORE a Worker runs, which nothing in here can do; this counts per
 * ACTOR, which Pro WAF cannot do at all (it counts by client IP only — per-user
 * / per-JWT counting is an Enterprise "Advanced Rate Limiting" feature).
 *
 * Why this exists at all: Pro caps the zone at TWO rate-limit rules and both
 * slots are spent — Rule A on `POST /api/requests/*` + the two lead-capture
 * POSTs, Rule B on `POST /api/reviews`. Every token-redemption and
 * vendor-portal path is therefore covered by nothing at the edge, and there is
 * no third slot to put them in. The native `ratelimits` binding has no such cap.
 *
 * **These are BURST caps.** `simple.period` is a strict enum of 10 or 60
 * seconds, so this mechanism cannot express §15.1's hourly/daily intent any
 * more than the WAF can. Genuinely-hourly caps stay D1-counted over a table we
 * already have — `INVITE_DAILY_LIMIT` (`routes/vendor-seat-invites.ts`) and the
 * AECI-773 per-user review cap (`routes/reviews.ts`). This composes BENEATH
 * those checks; it does not replace them.
 *
 * Registration is PER ROUTE and always AFTER the authz guard. A global
 * `app.use('*')` runs before every per-route guard and so can never see
 * `c.get('auth')` — which would silently collapse every key to IP and defeat
 * the whole `write` bucket.
 *
 * Reads are never limited. `GET /api/vendor/updates` is polled every 20 s per
 * focused vendor seat (AECI-629 / ADR 0023) and its failure mode is a silently
 * stale portal, so the invariant is kept exceptionless rather than carved.
 */

import { ApiErrorCode } from '@aeci/shared';
import type { Context, MiddlewareHandler } from 'hono';

import type { Env } from './env';
import { ApiError } from './errors';
import type { AuthzVariables } from './lib/authz';
import type { UserAuthVariables } from './lib/user-auth';
import { submitCount } from './posthog';

/** The count a limiter trip emits. */
export const RATE_LIMIT_METRIC = 'aeci.api.ratelimit';

export type RateLimitBucket = 'token' | 'write';

/**
 * The ONE table naming each bucket, its binding, and its window. Two guards
 * keep it honest:
 *
 *   1. compile time — `binding: keyof Env` makes a name `env.ts` does not
 *      declare a type error;
 *   2. CI — `rate-limit-middleware.spec.ts` asserts every entry here is
 *      declared in ALL FIVE `wrangler.jsonc` blocks with these exact numbers.
 *
 * Two guards because `ratelimits` is **not inherited** into a named environment
 * (wrangler's own config schema says so verbatim), so a bucket declared only at
 * the top level is bound on exactly ZERO deployed Workers. Nothing throws, no
 * test fails, and the only symptom is a limit that never limits — the AECI-659
 * shape ("the metric read ~0 and looked like 'no attacks' when it was really
 * 'no rules'") reproduced in a different file format.
 *
 * Thresholds. `token` is 10/10 s because what you want to kill on a
 * secret-presenting path is the BURST — a script's whole strategy — and a human
 * opening an invite link does one or two requests, three or four if it bounces
 * through a sign-in. `write` is 30/60 s because the loosest legitimate burst in
 * this codebase is a vendor authoring product versions through the portal, and
 * 30/min clears that comfortably while capping the D1 write and `audit_log`
 * amplification available to a stolen JWT.
 */
export const RATE_LIMIT_BUCKETS = {
  token: { binding: 'TOKEN_RATE_LIMIT', limit: 10, period: 10 },
  write: { binding: 'WRITE_RATE_LIMIT', limit: 30, period: 60 },
} as const satisfies Record<
  RateLimitBucket,
  { binding: keyof Env; limit: number; period: 10 | 60 }
>;

/** Which principal a counter ended up keyed by. `absent` is the degraded mode. */
export type RateLimitKeySource = 'user' | 'vendor' | 'ip' | 'absent';

export type RateLimitOptions = {
  /**
   * Which principal the counter is keyed by. Defaults to `'user'`.
   *
   * `'vendor'` ONLY where the protected resource is vendor-SHARED — the seat
   * invite mailer is the example, and `INVITE_DAILY_LIMIT` is already
   * per-vendor for exactly that reason, because otherwise five seats buy five
   * times the outbound Resend mail. Everywhere else per-vendor would punish a
   * customer for having colleagues: a five-seat vendor legitimately generates
   * five times the writes of a solo one.
   */
  by?: 'user' | 'vendor' | 'ip';
  /**
   * Optional isolated sub-budget. OMIT it unless you have a specific reason —
   * splitting the budget per route multiplies an attacker's total by the number
   * of routes.
   */
  tag?: string;
};

/**
 * Build the counter key. Pure and exported so the precedence rules are
 * unit-tested without standing up Hono.
 *
 * The environment label is in the key even though each (bucket, environment)
 * pair already has its own `namespace_id`. It is redundant by design: it costs
 * one string concat and converts a copy-paste that duplicates a `namespace_id`
 * from "two tiers silently share a counter" into "still isolated". The lockstep
 * test still asserts distinctness, so the copy-paste is caught in CI rather
 * than merely survived.
 *
 * The bucket is NOT in the key — buckets are already separate namespaces.
 */
export function rateLimitKey(input: {
  envLabel: string;
  by: 'user' | 'vendor' | 'ip';
  userId?: string | null;
  vendorId?: string | null;
  clientIp?: string | null;
  tag?: string;
}): { key: string; source: RateLimitKeySource } {
  const { envLabel, by, userId, vendorId, clientIp, tag } = input;

  let scoped: string;
  let source: RateLimitKeySource;
  if (by === 'user' && userId) {
    scoped = `user:${userId}`;
    source = 'user';
  } else if (by === 'vendor' && vendorId) {
    scoped = `vendor:${vendorId}`;
    source = 'vendor';
  } else if (clientIp) {
    scoped = `ip:${clientIp}`;
    source = 'ip';
  } else {
    // One shared counter for the whole keyless population — still a limit, and
    // `key_source:absent` puts the condition on a dashboard from the first
    // request rather than being discovered during an incident.
    scoped = 'ip:unknown';
    source = 'absent';
  }

  return { key: [envLabel, scoped, tag].filter(Boolean).join(':'), source };
}

/**
 * Bindings already announced as missing, so the warn + `unconfigured` count fire
 * at most once per isolate per binding. A per-request emit here would be an
 * unbatched per-request `fetch` in precisely the environment where the binding
 * is expected to be absent (the AECI-666 connection budget). The consequence for
 * readers of the metric: this series is isolate-sampled, so read it as
 * presence/absence and never as a rate.
 */
const announced = new Set<string>();

/** Test-only. The `announced` set is module state and must not leak between specs. */
export function resetRateLimitAnnouncements(): void {
  announced.clear();
}

/**
 * Takes the three primitives `submitCount` needs rather than a `Context`, so it
 * is callable from the generic middleware without a second variance cast — Hono
 * `Context<E>` is invariant in `E` through its `set`, so `Context<E>` does not
 * assign to `Context<{ Bindings: Env }>`.
 */
function emit(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  env: Env,
  request: Request,
  bucket: RateLimitBucket,
  outcome: 'limited' | 'unconfigured',
  source: RateLimitKeySource,
): void {
  try {
    submitCount(ctx, env, request, RATE_LIMIT_METRIC, 1, [
      `bucket:${bucket}`,
      `outcome:${outcome}`,
      `key_source:${source}`,
    ]);
  } catch (error) {
    // Observability MUST NOT break the request path — including a missing
    // ExecutionContext in non-Worker test harnesses (metrics-middleware.ts).
    console.warn('rateLimit: emit failed', error);
  }
}

/**
 * Rate-limit a route against one of the {@link RATE_LIMIT_BUCKETS}.
 *
 * Generic over the router's env, exactly like `errorHandler`, so the several
 * differently-`Variables`-typed sub-routers in `index.ts` can all register it
 * with no per-site annotation.
 *
 * MUST be registered after the route's authz guard. That ordering is
 * load-bearing and the type system cannot enforce it, so the `write` bucket
 * throws a 500 rather than guessing when no principal is present (see below),
 * and each guarded route's spec asserts the guard rejects before `limit()` runs.
 */
export function rateLimit<E extends { Bindings: Env }>(
  bucket: RateLimitBucket,
  options: RateLimitOptions = {},
): MiddlewareHandler<E> {
  const spec = RATE_LIMIT_BUCKETS[bucket];
  const by = options.by ?? 'user';

  return async (c, next) => {
    // The implementation touches `Bindings` plus two optional `Variables` slots
    // the generic `E` cannot promise. One documented cast, the same posture as
    // `errorHandler`'s "the implementation only touches `Bindings`".
    const vars = c as unknown as Context<{
      Bindings: Env;
      Variables: Partial<AuthzVariables & UserAuthVariables>;
    }>;
    // Both must be read: two router families exist with different `Variables`
    // shapes — `requireAuth`/`requireAdmin`/`requireVendor` set `auth`, while
    // `requireUserAuth` sets `user` — and `index.ts` registers both.
    const session = vars.get('auth');
    const userId = session?.userId ?? vars.get('user')?.userId ?? null;

    const { key, source } = rateLimitKey({
      envLabel: c.env.ENV ?? 'development',
      by,
      userId,
      vendorId: session?.vendorId ?? null,
      clientIp: c.req.header('cf-connecting-ip'),
      tag: options.tag,
    });

    // Refuse to guess. The `write` bucket composes AFTER an authz guard that has
    // already thrown 401/403 without a verified `sub`, so no principal here means
    // the registration order is wrong. Falling back to IP would quietly turn a
    // per-user cap into a per-NAT cap; failing open would be a protection that
    // covers nothing (AECI-659); failing closed would 429 every authenticated
    // write on a wiring bug, which is the worse outage. A 500 is the honest
    // answer: a server fault, loud, and impossible under correct wiring.
    if (bucket === 'write' && source !== 'user' && source !== 'vendor') {
      throw new ApiError(500, ApiErrorCode.INTERNAL_ERROR, 'Internal server error');
    }

    const limiter = c.env[spec.binding];
    if (!limiter) {
      if (!announced.has(spec.binding)) {
        announced.add(spec.binding);
        console.warn(
          `rateLimit: ${spec.binding} is not bound — ${bucket} limiting is INACTIVE on this deployment`,
        );
        emit(c.executionCtx, c.env, c.req.raw, bucket, 'unconfigured', source);
      }
      return next();
    }

    const { success } = await limiter.limit({ key });
    if (success) {
      // Nothing is emitted on the allow path. Not one metric, not one log. This
      // is the invariant a future refactor is most likely to break, and the
      // spec asserts it.
      return next();
    }

    // Workers Observability logs are enabled on this Worker, so a `console.warn`
    // costs no outbound connection where `logToPosthog` would cost one on the
    // trip path. Deliberately NOT the key: it holds a user id or a client IP.
    console.warn('rateLimit: limit tripped', {
      bucket,
      path: c.req.path,
      method: c.req.method,
      key_source: source,
    });
    emit(c.executionCtx, c.env, c.req.raw, bucket, 'limited', source);

    throw new ApiError(429, ApiErrorCode.RATE_LIMITED, 'Too many requests. Try again shortly.', {
      // The window is fixed rather than sliding, and a DENIED request does not
      // increment the counter, so the full period is a correct upper bound: the
      // true wait may be shorter, never longer.
      retryAfterSeconds: spec.period,
    });
  };
}
