/**
 * AECI-1499 (E9.1 of the AECI-1339 Stripe epic): a thin fetch client for the Stripe REST
 * API. No Stripe SDK, by the epic plan's P0.
 *
 * It follows the house transport pattern of `linearGraphql` (`lib/linear.ts`):
 *
 *   - **Never throws.** A timeout, a network failure, a non-2xx answer and an unreadable
 *     body all resolve to `{ ok: false, … }`. Callers branch on `ok`.
 *   - **`fetchImpl` is injected** (defaults to the global `fetch`), so specs need no global
 *     stub.
 *   - **`AbortSignal.timeout`** on every call.
 *   - **`discardResponseBody`** on every path that does not read the body. A Worker holds
 *     about six pending connections, and a cancelled `fetch` never settles (ADR 0021,
 *     2026-08-27 amendment).
 *   - **Form-encoded bodies** with nested `a[b]=` keys, which is what Stripe's v1 API takes.
 *   - **An `Idempotency-Key` on every POST**, supplied by the caller. The client refuses a
 *     POST without one rather than invent a key, because only the caller knows what makes
 *     two requests "the same" (a billing account id, a webhook event id).
 *
 * `Stripe-Version` is pinned to {@link STRIPE_API_VERSION}, so an account-level upgrade
 * in the Stripe dashboard cannot change the shapes this file reads. Webhook payloads are a
 * separate matter: each webhook endpoint carries its own version in the dashboard.
 *
 * The types below hold only the fields AECi reads. Stripe sends many more.
 */

import { discardResponseBody } from '@aeci/shared/response-drain';

import type { Env } from '../env';

/**
 * The pinned Stripe API version. `2026-09-30.endive` was the newest stable release when
 * this client was written (2026-10-28). None of Endive's breaking changes touch the
 * fields read here. Basil (2025-03-31) moved `current_period_end` from the subscription
 * onto each subscription item, and the invoice's subscription id under
 * `parent.subscription_details`. {@link subscriptionCurrentPeriodEnd} and
 * {@link invoiceSubscriptionId} read both places.
 */
export const STRIPE_API_VERSION = '2026-09-30.endive';

/** Stripe's API origin. Overridable for tests only. */
export const STRIPE_API_BASE = 'https://api.stripe.com';

/** Per-request timeout, covering the headers and the body read. */
export const STRIPE_TIMEOUT_MS = 10_000;

/** Stripe's maximum list page size. */
export const STRIPE_LIST_PAGE_LIMIT = 100;

/** Default page cap for {@link StripeClient.listSubscriptions}: 1,000 subscriptions. */
export const STRIPE_LIST_MAX_PAGES = 10;

// ─── Result union ────────────────────────────────────────────────────────────

/**
 * Why a call failed.
 *
 *   - `timeout` / `network`: the request never produced a response. `status` is 0.
 *   - `http_error`: Stripe answered non-2xx. `type`, `code`, `declineCode` and `param` come
 *     from the error body when it was JSON.
 *   - `invalid_response`: a 2xx whose body was not a JSON object.
 *   - `not_found`: a lookup that Stripe answered 200 with no match (a price lookup key with
 *     no active price, a subscription no Checkout Session created). `status` is 404 so a
 *     caller can treat it like one.
 *   - `invalid_request`: the client refused to send, for example a POST with no
 *     idempotency key. `status` is 0 and no request left the Worker.
 */
export type StripeFailureReason =
  | 'timeout'
  | 'network'
  | 'http_error'
  | 'invalid_response'
  | 'not_found'
  | 'invalid_request';

export type StripeFailure = {
  ok: false;
  status: number;
  reason: StripeFailureReason;
  message: string;
  /** Stripe's `error.type`, e.g. `invalid_request_error`, `card_error`. */
  type?: string;
  /** Stripe's `error.code`, e.g. `resource_missing`, `idempotency_key_in_use`. */
  code?: string;
  declineCode?: string;
  param?: string;
  /** Stripe's `Request-Id` response header, for the dashboard's request log. */
  requestId?: string;
};

export type StripeResult<T> = { ok: true; data: T; requestId?: string } | StripeFailure;

// ─── The fields we read ──────────────────────────────────────────────────────

/** Stripe metadata: string keys to string values. */
export type StripeMetadata = Record<string, string>;

export type StripeRecurringInterval = 'day' | 'week' | 'month' | 'year';

export type StripePrice = {
  id: string;
  object?: 'price';
  active?: boolean;
  lookup_key?: string | null;
  currency?: string;
  unit_amount?: number | null;
  recurring?: { interval: StripeRecurringInterval; interval_count?: number } | null;
};

export type StripeCustomer = {
  id: string;
  object?: 'customer';
  email?: string | null;
  name?: string | null;
  metadata?: StripeMetadata;
};

export type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

export type StripeSubscriptionItem = {
  id: string;
  quantity?: number;
  price: StripePrice;
  /** Unix seconds. Lives here since API version 2025-03-31.basil. */
  current_period_end?: number;
  current_period_start?: number;
};

export type StripeSubscription = {
  id: string;
  object?: 'subscription';
  status: StripeSubscriptionStatus;
  /** A customer id, or the expanded customer. */
  customer: string | StripeCustomer;
  cancel_at_period_end: boolean;
  /** Unix seconds; null unless a cancellation is scheduled. */
  cancel_at?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
  metadata: StripeMetadata;
  /** Unix seconds. For a Checkout subscription, the moment the session completed. */
  created?: number;
  items: { data: StripeSubscriptionItem[]; has_more?: boolean };
  /** Unix seconds. Only on API versions before 2025-03-31.basil. */
  current_period_end?: number;
  latest_invoice?: string | StripeInvoice | null;
  /**
   * Set when an update sent with `payment_behavior=pending_if_incomplete` is waiting on
   * an unpaid invoice. The subscription keeps its old values until the invoice is paid,
   * and the update lapses at `expires_at` (Unix seconds).
   */
  pending_update?: { expires_at: number } | null;
};

export type StripeCheckoutSession = {
  id: string;
  object?: 'checkout.session';
  /** The hosted page. Null once the session is complete or expired. */
  url: string | null;
  mode?: 'payment' | 'setup' | 'subscription';
  status?: 'open' | 'complete' | 'expired' | null;
  payment_status?: 'paid' | 'unpaid' | 'no_payment_required';
  customer: string | StripeCustomer | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  subscription?: string | StripeSubscription | null;
  metadata: StripeMetadata | null;
  consent?: { terms_of_service?: 'accepted' | null } | null;
  /** Unix seconds: when the session was opened, not when it completed. */
  created?: number;
  /** Not sent by default. {@link StripeClient.listOpenCheckoutSessions} expands it. */
  line_items?: StripeList<StripeCheckoutLineItem>;
};

/** One Checkout line item, as `expand[]=data.line_items` returns it. */
export type StripeCheckoutLineItem = {
  id: string;
  quantity?: number | null;
  price?: StripePrice | null;
};

export type StripeInvoiceBillingReason =
  | 'automatic_pending_invoice_item_invoice'
  | 'manual'
  | 'quote_accept'
  | 'subscription'
  | 'subscription_create'
  | 'subscription_cycle'
  | 'subscription_threshold'
  | 'subscription_update'
  | 'upcoming';

export type StripeInvoice = {
  id: string;
  object?: 'invoice';
  customer: string | StripeCustomer | null;
  status?: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | null;
  billing_reason: StripeInvoiceBillingReason | null;
  customer_email?: string | null;
  metadata?: StripeMetadata | null;
  /** Since 2025-03-31.basil the subscription id lives here. */
  parent?: {
    type?: string;
    subscription_details?: {
      subscription?: string | StripeSubscription | null;
      metadata?: StripeMetadata | null;
    } | null;
  } | null;
  /** Only on API versions before 2025-03-31.basil. */
  subscription?: string | StripeSubscription | null;
};

export type StripePortalSession = {
  id: string;
  object?: 'billing_portal.session';
  url: string;
};

type StripeList<T> = { object?: 'list'; data: T[]; has_more: boolean };

// ─── Readers that hide API-version drift ─────────────────────────────────────

/** The id of an expandable field, whether Stripe sent the id or the object. */
export function stripeId(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

/** The first item. AECi subscriptions carry exactly one price (one plan, one interval). */
function firstItem(sub: StripeSubscription): StripeSubscriptionItem | undefined {
  return sub.items?.data?.[0];
}

/** `items.data[0].quantity`, or 0 when the subscription has no item. */
export function subscriptionQuantity(sub: StripeSubscription): number {
  return firstItem(sub)?.quantity ?? 0;
}

/** `items.data[0].price.recurring.interval`, or null when absent. */
export function subscriptionInterval(sub: StripeSubscription): StripeRecurringInterval | null {
  return firstItem(sub)?.price?.recurring?.interval ?? null;
}

/**
 * `current_period_end` in Unix seconds. Reads the subscription item first (API
 * 2025-03-31.basil and later) and the subscription itself second (older versions, and
 * webhook endpoints pinned to one). Null when neither carries it.
 */
export function subscriptionCurrentPeriodEnd(sub: StripeSubscription): number | null {
  return firstItem(sub)?.current_period_end ?? sub.current_period_end ?? null;
}

/** The subscription id an invoice belongs to, from either API-version location. */
export function invoiceSubscriptionId(invoice: StripeInvoice): string | null {
  return (
    stripeId(invoice.parent?.subscription_details?.subscription) ?? stripeId(invoice.subscription)
  );
}

// ─── Form encoding ───────────────────────────────────────────────────────────

/** A value Stripe's form encoding can carry. `undefined` and `null` keys are omitted. */
export type StripeFormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly StripeFormValue[]
  | { readonly [key: string]: StripeFormValue };

export type StripeFormParams = { readonly [key: string]: StripeFormValue };

/**
 * Flatten params into Stripe's form encoding: `a[b][c]=v` for nested objects, `a[]=v` for
 * an array of scalars, and `a[0][b]=v` for an array of objects (Stripe needs the index to
 * group an object's keys, as in `line_items[0][price]`). Booleans become `true`/`false`.
 * `undefined` and `null` are dropped. An empty string is kept, because Stripe reads it as
 * "unset this field" (e.g. a metadata key).
 */
export function encodeStripeForm(params: StripeFormParams): string {
  const out = new URLSearchParams();
  const walk = (key: string, value: StripeFormValue): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry: StripeFormValue, i) => {
        const nested = entry !== null && typeof entry === 'object';
        walk(nested ? `${key}[${i}]` : `${key}[]`, entry);
      });
      return;
    }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as StripeFormParams)) walk(`${key}[${k}]`, v);
      return;
    }
    out.append(key, String(value));
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return out.toString();
}

// ─── Request params ──────────────────────────────────────────────────────────

export type StripeCreateCustomerParams = {
  email?: string;
  name?: string;
  metadata?: StripeMetadata;
};

/**
 * Checkout Session params. The fields E9.3 sets are typed. Anything else Stripe accepts
 * can ride in `extra`, which is merged last.
 */
export type StripeCreateCheckoutSessionParams = {
  mode: 'subscription' | 'payment' | 'setup';
  customer?: string;
  line_items: { price: string; quantity: number }[];
  success_url: string;
  cancel_url: string;
  metadata?: StripeMetadata;
  subscription_data?: { metadata?: StripeMetadata; description?: string };
  consent_collection?: { terms_of_service?: 'required' | 'none' };
  custom_text?: { terms_of_service_acceptance?: { message: string } };
  automatic_tax?: { enabled: boolean };
  tax_id_collection?: { enabled: boolean };
  billing_address_collection?: 'auto' | 'required';
  customer_update?: { address?: 'auto' | 'never'; name?: 'auto' | 'never' };
  allow_promotion_codes?: boolean;
  client_reference_id?: string;
  extra?: StripeFormParams;
};

export type StripeCreatePortalSessionParams = {
  customer: string;
  configuration: string;
  return_url: string;
};

export type StripeProrationBehavior = 'create_prorations' | 'none' | 'always_invoice';

export type StripePaymentBehavior =
  | 'allow_incomplete'
  | 'default_incomplete'
  | 'error_if_incomplete'
  | 'pending_if_incomplete';

/**
 * Subscription update params. A quantity change names the subscription item to change,
 * because Stripe updates items by id (`items[0][id]` + `items[0][quantity]`).
 */
export type StripeUpdateSubscriptionParams = {
  item?: { id: string; quantity: number };
  proration_behavior?: StripeProrationBehavior;
  /**
   * `pending_if_incomplete`: the change applies only when the invoice it creates is paid.
   * Until then the subscription carries a `pending_update` and keeps its old values.
   * Stripe supports it with `items[].quantity` and `proration_behavior=always_invoice`.
   */
  payment_behavior?: StripePaymentBehavior;
  cancel_at_period_end?: boolean;
  metadata?: StripeMetadata;
};

export type StripeListSubscriptionsParams = {
  customer?: string;
  /** One status, or `all` (which includes canceled). Stripe's default omits canceled. */
  status?: StripeSubscriptionStatus | 'all' | 'ended';
  /** Unix seconds. */
  created?: { gte?: number; lte?: number };
  /** Page size, 1 to 100. Defaults to 100. */
  limit?: number;
  /** Page cap. Defaults to {@link STRIPE_LIST_MAX_PAGES}. */
  maxPages?: number;
};

/** A capped list. `truncated` is true when the cap stopped the walk with pages left. */
export type StripeSubscriptionPage = { subscriptions: StripeSubscription[]; truncated: boolean };

// ─── Client ──────────────────────────────────────────────────────────────────

export interface StripeClient {
  /** `GET /v1/prices?lookup_keys[]=…&active=true`. `not_found` when no active price has it. */
  getPriceByLookupKey(lookupKey: string): Promise<StripeResult<StripePrice>>;
  /** `POST /v1/customers`. */
  createCustomer(
    params: StripeCreateCustomerParams,
    idempotencyKey: string,
  ): Promise<StripeResult<StripeCustomer>>;
  /** `POST /v1/checkout/sessions`. */
  createCheckoutSession(
    params: StripeCreateCheckoutSessionParams,
    idempotencyKey: string,
  ): Promise<StripeResult<StripeCheckoutSession>>;
  /** `POST /v1/billing_portal/sessions`. */
  createPortalSession(
    params: StripeCreatePortalSessionParams,
    idempotencyKey: string,
  ): Promise<StripeResult<StripePortalSession>>;
  /** `GET /v1/subscriptions/:id`. */
  retrieveSubscription(subscriptionId: string): Promise<StripeResult<StripeSubscription>>;
  /** `POST /v1/subscriptions/:id`. */
  updateSubscription(
    subscriptionId: string,
    params: StripeUpdateSubscriptionParams,
    idempotencyKey: string,
  ): Promise<StripeResult<StripeSubscription>>;
  /** `GET /v1/subscriptions`, walked with `starting_after` up to `maxPages`. */
  listSubscriptions(
    params?: StripeListSubscriptionsParams,
  ): Promise<StripeResult<StripeSubscriptionPage>>;
  /**
   * `GET /v1/checkout/sessions?subscription=…&limit=1`: the Checkout Session that
   * created a subscription. `not_found` when Stripe lists none.
   */
  findCheckoutSessionForSubscription(
    subscriptionId: string,
  ): Promise<StripeResult<StripeCheckoutSession>>;
  /**
   * `GET /v1/checkout/sessions?customer=…&status=open&expand[]=data.line_items`: the
   * customer's sessions that can still be paid. One page of {@link STRIPE_LIST_PAGE_LIMIT},
   * which is far more than one account ever holds open.
   */
  listOpenCheckoutSessions(customerId: string): Promise<StripeResult<StripeCheckoutSession[]>>;
  /** `POST /v1/checkout/sessions/:id/expire`. Stripe refuses a session that is not open. */
  expireCheckoutSession(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<StripeResult<StripeCheckoutSession>>;
}

export type StripeClientOptions = {
  secretKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  apiBase?: string;
};

/** Build a client over a secret key. Pure: no request leaves until a method is called. */
export function createStripeClient(options: StripeClientOptions): StripeClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? STRIPE_TIMEOUT_MS;
  const base = options.apiBase ?? STRIPE_API_BASE;

  const request = <T>(
    method: 'GET' | 'POST',
    path: string,
    params: StripeFormParams,
    idempotencyKey?: string,
  ): Promise<StripeResult<T>> =>
    stripeRequest<T>({
      fetchImpl,
      timeoutMs,
      base,
      secretKey: options.secretKey,
      method,
      path,
      params,
      idempotencyKey,
    });

  return {
    async getPriceByLookupKey(lookupKey) {
      const res = await request<StripeList<StripePrice>>('GET', '/v1/prices', {
        lookup_keys: [lookupKey],
        active: true,
        limit: 1,
      });
      if (!res.ok) return res;
      const price = res.data.data?.[0];
      if (!price) {
        return {
          ok: false,
          status: 404,
          reason: 'not_found',
          message: `no active price has lookup key ${lookupKey}`,
          requestId: res.requestId,
        };
      }
      return { ok: true, data: price, requestId: res.requestId };
    },

    createCustomer(params, idempotencyKey) {
      return request<StripeCustomer>('POST', '/v1/customers', params, idempotencyKey);
    },

    createCheckoutSession(params, idempotencyKey) {
      const { extra, ...typed } = params;
      return request<StripeCheckoutSession>(
        'POST',
        '/v1/checkout/sessions',
        { ...typed, ...extra },
        idempotencyKey,
      );
    },

    createPortalSession(params, idempotencyKey) {
      return request<StripePortalSession>(
        'POST',
        '/v1/billing_portal/sessions',
        params,
        idempotencyKey,
      );
    },

    retrieveSubscription(subscriptionId) {
      return request<StripeSubscription>(
        'GET',
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {},
      );
    },

    updateSubscription(subscriptionId, params, idempotencyKey) {
      const { item, ...rest } = params;
      return request<StripeSubscription>(
        'POST',
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { ...rest, items: item ? [{ id: item.id, quantity: item.quantity }] : undefined },
        idempotencyKey,
      );
    },

    async listSubscriptions(params = {}) {
      const {
        maxPages = STRIPE_LIST_MAX_PAGES,
        limit = STRIPE_LIST_PAGE_LIMIT,
        ...filters
      } = params;
      // Stripe rejects a page size outside 1..100; a cap below 1 would fetch nothing.
      const pageSize = Math.min(Math.max(Math.trunc(limit), 1), STRIPE_LIST_PAGE_LIMIT);
      const pageCap = Math.max(Math.trunc(maxPages), 1);
      const subscriptions: StripeSubscription[] = [];
      let startingAfter: string | undefined;
      let requestId: string | undefined;
      for (let page = 0; page < pageCap; page++) {
        const res = await request<StripeList<StripeSubscription>>('GET', '/v1/subscriptions', {
          ...filters,
          limit: pageSize,
          starting_after: startingAfter,
        });
        if (!res.ok) return res;
        requestId = res.requestId;
        const rows = res.data.data ?? [];
        subscriptions.push(...rows);
        const last = rows.at(-1);
        if (!res.data.has_more || !last) {
          return { ok: true, data: { subscriptions, truncated: false }, requestId };
        }
        startingAfter = last.id;
      }
      return { ok: true, data: { subscriptions, truncated: true }, requestId };
    },

    async findCheckoutSessionForSubscription(subscriptionId) {
      const res = await request<StripeList<StripeCheckoutSession>>('GET', '/v1/checkout/sessions', {
        subscription: subscriptionId,
        limit: 1,
      });
      if (!res.ok) return res;
      const session = res.data.data?.[0];
      if (!session) {
        return {
          ok: false,
          status: 404,
          reason: 'not_found',
          message: `no checkout session created subscription ${subscriptionId}`,
          requestId: res.requestId,
        };
      }
      return { ok: true, data: session, requestId: res.requestId };
    },

    async listOpenCheckoutSessions(customerId) {
      const res = await request<StripeList<StripeCheckoutSession>>('GET', '/v1/checkout/sessions', {
        customer: customerId,
        status: 'open',
        limit: STRIPE_LIST_PAGE_LIMIT,
        expand: ['data.line_items'],
      });
      if (!res.ok) return res;
      return { ok: true, data: res.data.data ?? [], requestId: res.requestId };
    },

    expireCheckoutSession(sessionId, idempotencyKey) {
      return request<StripeCheckoutSession>(
        'POST',
        `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
        {},
        idempotencyKey,
      );
    },
  };
}

/** A client over `env.STRIPE_SECRET_KEY`, or null when the key is unset. */
export function stripeClientFromEnv(
  env: Pick<Env, 'STRIPE_SECRET_KEY'>,
  fetchImpl?: typeof fetch,
): StripeClient | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return createStripeClient({ secretKey, fetchImpl });
}

/**
 * Whether this tier may start a Stripe purchase (AECI-1339 ruling, 2026-10-28). True only
 * when the `STRIPE_CHECKOUT_ENABLED` var is exactly `"true"` AND `STRIPE_SECRET_KEY` is
 * set. Production ships `"false"` until the epic's production switch-on. The webhook
 * route does not consult this: it depends only on `STRIPE_WEBHOOK_SECRET`.
 */
export function stripeCheckoutAvailable(
  env: Pick<Env, 'STRIPE_CHECKOUT_ENABLED' | 'STRIPE_SECRET_KEY'>,
): boolean {
  return env.STRIPE_CHECKOUT_ENABLED === 'true' && Boolean(env.STRIPE_SECRET_KEY?.trim());
}

/**
 * The Customer Portal configuration for a subscription interval. The configs live in
 * Stripe, one pair per account, with the ids in `wrangler.jsonc`. Annual has cancel off.
 * Monthly cancels at period end. Both have quantity update and plan switching off. Null
 * when the var is unset.
 */
export function stripePortalConfigFor(
  env: Pick<Env, 'STRIPE_PORTAL_CONFIG_ANNUAL' | 'STRIPE_PORTAL_CONFIG_MONTHLY'>,
  interval: StripeRecurringInterval,
): string | null {
  const id =
    interval === 'year' ? env.STRIPE_PORTAL_CONFIG_ANNUAL : env.STRIPE_PORTAL_CONFIG_MONTHLY;
  return id?.trim() || null;
}

// ─── Transport ───────────────────────────────────────────────────────────────

type StripeRequestArgs = {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  base: string;
  secretKey: string;
  method: 'GET' | 'POST';
  path: string;
  params: StripeFormParams;
  idempotencyKey?: string;
};

type StripeErrorBody = {
  error?: { type?: string; code?: string; decline_code?: string; param?: string; message?: string };
};

async function stripeRequest<T>(args: StripeRequestArgs): Promise<StripeResult<T>> {
  const { method, params } = args;
  const idempotencyKey = args.idempotencyKey?.trim();
  if (method === 'POST' && !idempotencyKey) {
    return {
      ok: false,
      status: 0,
      reason: 'invalid_request',
      message: `POST ${args.path} needs an idempotency key`,
    };
  }

  const encoded = encodeStripeForm(params);
  const url =
    method === 'GET' && encoded
      ? `${args.base}${args.path}?${encoded}`
      : `${args.base}${args.path}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${args.secretKey}`,
    'stripe-version': STRIPE_API_VERSION,
  };
  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['idempotency-key'] = idempotencyKey as string;
  }

  let res: Response;
  try {
    res = await args.fetchImpl(url, {
      method,
      headers,
      body: method === 'POST' ? encoded : undefined,
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: isTimeoutError(error) ? 'timeout' : 'network',
      message: error instanceof Error ? error.message : 'network_error',
    };
  }

  const requestId = res.headers.get('request-id') ?? undefined;
  const isJson = (res.headers.get('content-type') ?? '').includes('json');

  if (!res.ok) {
    let body: StripeErrorBody | null = null;
    if (isJson) {
      try {
        body = (await res.json()) as StripeErrorBody;
      } catch {
        discardResponseBody(res);
      }
    } else {
      discardResponseBody(res);
    }
    const err = body?.error;
    return {
      ok: false,
      status: res.status,
      reason: 'http_error',
      message: err?.message || res.statusText || `http_${res.status}`,
      type: err?.type,
      code: err?.code,
      declineCode: err?.decline_code,
      param: err?.param,
      requestId,
    };
  }

  if (!isJson) {
    discardResponseBody(res);
    return {
      ok: false,
      status: res.status,
      reason: 'invalid_response',
      message: 'non-JSON response',
      requestId,
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (error) {
    // The timeout signal also covers the body read, so a stalled body is a timeout.
    discardResponseBody(res);
    const timedOut = isTimeoutError(error);
    return {
      ok: false,
      status: res.status,
      reason: timedOut ? 'timeout' : 'invalid_response',
      message: timedOut ? 'body read timed out' : 'unparseable JSON',
      requestId,
    };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      status: res.status,
      reason: 'invalid_response',
      message: 'response is not an object',
      requestId,
    };
  }
  return { ok: true, data: data as T, requestId };
}

/** True for an `AbortSignal.timeout` abort. Duck-typed on `.name`, as in `lib/linear.ts`. */
function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}
