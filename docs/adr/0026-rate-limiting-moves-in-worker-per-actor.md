# ADR 0026: Rate limiting gains an in-Worker per-actor layer; the two Pro WAF rules do not change

**Status:** Accepted
**Date:** 2026-09-09
**Context owner:** chrisw@thewbsproject.com
**Relates to:** AECI-773 (this record), inside the Stage 2.1 Vendor Activation window. Supersedes the "deliberately out of scope" clause in `docs/waf-rate-limits.md` §"Plan constraints" and the impossibility claims in `docs/STAGE_1_SPEC.md` §15.1's implementation blockquote. Build contract: `docs/waf-rate-limits.md` §6. Builds on ADR 0016 (D1/Drizzle — the hourly caps are D1 counts) and constrained by ADR 0023 (the 20-second vendor poll this must not break). Leaves AECI-242 / AECI-659's WAF rules untouched.

> **The zone did not change.** No rule was added, widened, retired or retuned; `scripts/ops/` was not run. If you are diffing the live Cloudflare zone against `docs/waf-rate-limits.md` and looking for an AECI-773 apply, there isn't one. The only pending zone action is still AECI-807's host narrowing, which predates this and is unrelated.

---

## Context

`STAGE_1_SPEC.md` §15.1 asked for four rate limits in 2026-06. Three of the four have never been implemented as written, and the spec's own implementation note records why: Cloudflare Pro **counts by client IP only** (per-user counting is an Enterprise "Advanced Rate Limiting" feature) and its **counting window maxes at one minute**. So "3 per authenticated user per hour" on `POST /api/reviews` shipped as "5 per IP per minute", and "5 per IP per hour" on `/api/requests/*` shipped as "5 per IP per minute".

Pro also caps the **zone** at two rate-limiting rules. Both slots are spent — Rule A on `POST /api/requests/*` plus the two lead-capture POSTs, Rule B on `POST /api/reviews` — and the prior broad `/api/*` rule was deleted to free the second slot, so there is no general write backstop either. AECI-659 had to *widen Rule A's predicate* rather than add a rule, because there was nowhere to put one.

AECI-773 was filed because Stage 2.1 seats real vendors, and the vendor-portal write surface is covered by nothing at the edge. It proposed four options: fold new paths into Rule A, retire Rule B, build a KV or Durable Object counter, or upgrade the plan.

Two things reframed the question.

**Cloudflare shipped a native Workers rate-limiting binding, GA 2025-09-19.** It is declared as `ratelimits` in `wrangler.jsonc` and called as `await env.LIMITER.limit({ key })`. The key is an arbitrary string, so it counts per authenticated user. There is no rule cap on it, no KV, no Durable Object, no migration, no storage, and — unlike every other binding in this repo — **no provisioning step at all**: `namespace_id` is an integer you choose and there is no `wrangler ratelimit create` subcommand. Pinned wrangler 4.123.0 supports it (it needs ≥ 4.36.0) and miniflare 4 implements it, so `pnpm dev:agent` exercises it locally.

**The gap is narrower and differently shaped than the issue assumed.** `POST /api/requests/claim` — the claim endpoint the issue names — already matches Rule A's `starts_with(http.request.uri.path, "/api/requests/")`, and `STAGE_2_1_SPEC.md` §2 already records that as green. The genuinely uncovered writes are the vendor-portal surface behind `requireVendor()`, the two token-presenting paths (`POST /api/seat-invites/:token/accept`, `POST /api/unsubscribe`), and the account/identity writes.

## Decision

Rate limiting becomes **two layers with different jobs**, and the line between them is where the request is when it gets stopped.

**Layer 1 — the Cloudflare WAF, unchanged.** Rules A and B stay byte-for-byte as they are. They mitigate at the edge *before a Worker runs*, which nothing in Layer 2 can do, and they are the only volumetric answer we have. Neither slot moved and no third slot was invented.

**Layer 2 — in-Worker, per actor.** Two `ratelimits` buckets on the API Worker, applied per route as Hono middleware registered *after* the route's authz guard:

| Bucket | Binding | Window | Keyed by | Guards |
|---|---|---|---|---|
| `token` | `TOKEN_RATE_LIMIT` | 10 / 10 s | client IP | paths where the caller presents a secret |
| `write` | `WRITE_RATE_LIMIT` | 30 / 60 s | authenticated user (vendor on the shared mailer) | authenticated writes |

**Layer 2b — D1 counts for hourly intent.** `simple.period` is a strict enum of 10 or 60 seconds, so the binding cannot express an hourly cap any more than the WAF can. `POST /api/reviews` therefore gains **3 per authenticated user per rolling hour** as one indexed `count()` over `reviews`, on the model already shipped for `INVITE_DAILY_LIMIT`. This is the first time §15.1's second bullet is honoured literally.

Full endpoint map, including every deliberate exclusion and its reason: `docs/waf-rate-limits.md` §6.

## Why not a KV or Durable Object counter

This is what AECI-773's option 3 proposed, and what `docs/waf-rate-limits.md` recorded as the price of an hourly cap. Both are now the expensive way to get less.

**KV** is the wrong storage primitive for a counter. It is eventually consistent with a write-visibility lag measured in seconds, and a read-modify-write per request has no atomicity — two concurrent requests read the same value and both write `n+1`. It also costs a KV write on every guarded request, on the hot path.

**A Durable Object** is correct but heavy: a new class, a `migrations` block, a binding in four environments, a round trip per guarded request, and a new failure surface. ADR 0023 already declined Durable Objects for the vendor portal on a cost-versus-need argument, and that argument is stronger here — the native binding delivers the same per-key semantics with no object to place, no migration, and no round trip we own.

The binding is not free of cost, only of *infrastructure* cost. Its counters are **per Cloudflare colo** and eventually consistent, and the docs describe the API as "permissive… intentionally designed to not be used as an accurate accounting system". A distributed attacker gets `limit × colos`. That is acceptable precisely because Layer 1 exists: the WAF is the volumetric answer, and Layer 2 is a per-actor brake.

## Why the hourly caps stay D1 counts

Because the binding cannot do it, not because we prefer SQL. `period` accepts 10 or 60 and nothing else. Any true hourly or daily cap is a count over a table, and both of ours are counts over a table we already have — `vendor_seat_invites` for the 10-per-vendor-per-24 h invite cap, `reviews` for the new 3-per-user-per-hour review cap. No new table, no new index, no migration.

The review cap costs one indexed seek: `reviews_reviewer_idx` covers `reviewer_id`, and `reviews_unique_per_user_product` already caps a user at one review per product, so the rows the predicate scans are the number of products that user has ever reviewed. Single digits. A composite `(reviewer_id, created_at)` index would be asymptotically better and practically pointless, and drizzle-kit generation over this table family has already produced one destructive recreate (migration `0027`, guarded by its own spec file). Not a trade worth making for a sub-twenty-row filter.

Two semantics in that count are silent if they are wrong, so they are asserted by tests rather than left to a comment: **every status counts** (reusing the dedup index's `status <> 'archived'` predicate would turn a moderation loop into a slot-refund machine), and `reviews.reviewer_id` is `ON DELETE SET NULL`, so a GDPR erasure naturally resets the counter.

## Why not the other options

**Fold the new paths into Rule A** — rejected. Rule A already spans three endpoint families on one 5-per-minute counter, and the home feedback form with the opt-in ticked fires two requests, so the real budget is about two and a half user actions. Adding vendor writes would let an unrelated vendor action hard-block a visitor out of the signup form for an hour, and Pro's action is a 1 h Block with no self-service recovery. It is also unnecessary: the binding removes the scarcity that made folding attractive.

**Retire Rule B** — rejected. Edge blocking runs before the Worker and costs nothing to keep. Reviews' app-layer dedup caps one review per product per user, which does not stop a flood across *distinct* products.

**Upgrade the Cloudflare plan** — declined, and it is worth being precise about why, because "pay for the better tier" reads like the obvious answer. Business at $200/month per zone buys 5 rate-limit rules and a 10-minute window, but it is **still IP-only**. Per-header, per-JWT and per-cookie characteristics are Enterprise Advanced Rate Limiting. So the paid tier immediately above us buys strictly less than the free binding on the one axis §15.1 actually asked about. See the re-open trigger.

## Consequences

**Gained**

- §15.1's "3 per authenticated user per hour" is honoured literally for the first time, and the per-user half of it is now expressible everywhere.
- The vendor-portal write surface, the two token-presenting paths, and the account/identity writes have a limit where they previously had none.
- `Retry-After` is emitted. `docs/API_CONTRACTS.md` §4.1 has promised it on 429 since Phase 2.8, and until now `ApiError` had no header channel, so **no 429 this Worker ever returned carried one** — including the shipped invite-limit rejection, which is fixed in the same change.
- No zone change, no dashboard action, no new secret, no migration, no provisioning.

**Accepted costs**

- Per-colo, eventually consistent counters. A brake, not an accounting system.
- Layer 2 runs after the Worker invocation is already paid for. It bounds D1 and downstream cost, not Worker cost.
- The binding is **not inherited across wrangler environments**, so each bucket is declared five times. A missing block silently protects nothing — AECI-659's shape in a config file — and the PR suite runs no `wrangler deploy --dry-run`, so nothing else would catch it. `apps/api/src/wrangler-ratelimits.spec.ts` is the gate, and it fails with the environment named.
- Counters are shared **account-wide** by `namespace_id`, across Workers. The sibling `aec-integrations-review` app already ships this binding on the same account, so every (bucket, environment) pair gets its own id and the ids are AECI-773-derived rather than the `1001`/`1002` the Cloudflare docs example uses.

**Invariants that must not be broken**

- **Reads are never rate-limited, on any surface, with no exceptions.** `GET /api/vendor/updates` is polled every 20 seconds per focused vendor seat and one poll can fan out to six scope refetches, so a limiter on it trips inside a minute — and the failure is silent in both directions: a permanently stale portal, or a self-inflicted poll amplifier, with nothing logged. The rule is kept exceptionless deliberately. `GET /api/seat-invites/:token` is the one place that costs something (it is the cheaper enumeration oracle of that pair), and it is still not limited: the token is a 122-bit `crypto.randomUUID()` that no achievable request rate meaningfully erodes, and a grinder is visible by its 404 rate.
- **`rateLimit()` is registered after the route's authz guard, never before, and never globally.** A global middleware runs before every per-route guard and can never see `c.get('auth')`, which would silently collapse every key to IP. The `write` bucket throws a 500 rather than guessing when no principal is present, so a mis-ordered registration is loud instead of quietly becoming a per-NAT cap.

## What this does NOT fix

- **`POST /api/feedback` mails the operator on every submit, with no dedup.** WAF Rule A caps it at 5 per IP per minute; an attacker rotating IPs mails the operator without an effective bound. An email-keyed in-Worker cap does not help, because the adversary chooses the email. Closing it needs either a WAF custom rule (a separate, larger quota that consumes neither rate-limit slot) or per-recipient throttling at the Resend layer. Neither is in this change.
- **The subscribe/unsubscribe mail loop.** `created = inserted.length > 0 || reactivated`, and two Resend sends fire on `created`, so `subscribe → unsubscribe → subscribe` on one address re-fires both every cycle. It is *not* adversary-drivable without the victim's unsubscribe token — a repeat subscribe on an already-active address is a no-op that sends nothing — so the residual is a slow-drip loop by someone who already holds the token. The `token` bucket bounds the unsubscribe half per IP; nothing here bounds it per address.
- **`/api/requests/*` "5 per IP per hour"** stays a per-minute per-IP approximation, permanently. `vendor_requests` stores no client IP, and adding one to run a rate-limit counter would put a new personal identifier inside the `docs/AUTH_AND_RLS.md` §8 erasure boundary. The only key we hold is a caller-supplied email, which an adversary rotates for free. Rule A's 5-per-minute with a 1 h block is stronger in practice than 5 per hour would be, so this is recorded as closed by the table shape rather than punted.
- **`POST /admin/purge` on the SSR Worker** is not limited. It would be the SSR Worker's first non-transport binding across four environment blocks, and it buys little: an unauthenticated flood costs one constant-time string compare and a 401, and an attacker who *has* the token can purge everything in a single request, which no rate limit prevents. If a control is wanted later, the cheap one is a WAF **custom** rule — a separate, larger quota that consumes neither rate-limit slot.

## Re-open trigger

Revisit the plan upgrade — and only then — when **either** holds:

1. **A per-actor characteristic is needed at the edge**, i.e. an attack that must be stopped before the Worker runs *and* cannot be expressed per-IP. That is Enterprise Advanced Rate Limiting, not Business, and it should be priced as such.
2. **More than two path families need volumetric edge blocking at once.** That is the Business rule-count limit doing real work, and $200/month per zone becomes a fair price for it.

Neither is true today, and `aeci.api.ratelimit{outcome:limited}` plus `aeci.waf.ratelimit.blocked` are the two series that would show it becoming true.
