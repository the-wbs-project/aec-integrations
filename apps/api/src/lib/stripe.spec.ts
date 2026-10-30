/**
 * AECI-1499: the Stripe fetch client. Every call goes through a fake `fetchImpl`, so no
 * request leaves the test.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createStripeClient,
  encodeStripeForm,
  invoiceSubscriptionId,
  STRIPE_API_VERSION,
  stripeCheckoutAvailable,
  stripeClientFromEnv,
  stripePortalConfigFor,
  subscriptionCurrentPeriodEnd,
  subscriptionInterval,
  subscriptionQuantity,
  type StripeInvoice,
  type StripeSubscription,
} from './stripe';

const KEY = 'sk_test_fake';

type Call = { url: string; init: RequestInit };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_123', ...headers },
  });
}

/** A fake fetch that answers each call with the next response and records the call. */
function fakeFetch(...responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return typeof next === 'function' ? next() : next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

/** A response whose body records whether anyone cancelled it. */
function trackedResponse(status: number, contentType: string, text = 'oops') {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      // Closed with the chunk still queued, so a reader finishes and a cancel still
      // reaches the source.
      controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: new Response(body, { status, headers: { 'content-type': contentType } }), state };
}

const headerOf = (call: Call, name: string): string | null =>
  new Headers(call.init.headers).get(name);

const SUB: StripeSubscription = {
  id: 'sub_1',
  status: 'active',
  customer: 'cus_1',
  cancel_at_period_end: false,
  metadata: { billing_account_id: 'ba_1' },
  items: {
    data: [
      {
        id: 'si_1',
        quantity: 3,
        current_period_end: 1_800_000_000,
        price: { id: 'price_1', recurring: { interval: 'year' } },
      },
    ],
  },
};

describe('encodeStripeForm', () => {
  it('nests objects as a[b], scalar arrays as a[], object arrays as a[0][b]', () => {
    const encoded = encodeStripeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 2 }],
      metadata: { billing_account_id: 'ba_1' },
      subscription_data: { metadata: { vendor_id: 'v_1' } },
      expand: ['subscription', 'customer'],
      automatic_tax: { enabled: true },
      allow_promotion_codes: false,
      skipped: undefined,
      dropped: null,
      cleared: '',
    });
    expect(decodeURIComponent(encoded).split('&')).toEqual([
      'mode=subscription',
      'line_items[0][price]=price_1',
      'line_items[0][quantity]=2',
      'metadata[billing_account_id]=ba_1',
      'subscription_data[metadata][vendor_id]=v_1',
      'expand[]=subscription',
      'expand[]=customer',
      'automatic_tax[enabled]=true',
      'allow_promotion_codes=false',
      'cleared=',
    ]);
  });

  it('URL-encodes values', () => {
    expect(encodeStripeForm({ success_url: 'https://x.test/a?b=c&d' })).toBe(
      'success_url=https%3A%2F%2Fx.test%2Fa%3Fb%3Dc%26d',
    );
  });
});

describe('createStripeClient: request shape', () => {
  it('POSTs a form body with auth, the pinned version and the caller idempotency key', async () => {
    const { impl, calls } = fakeFetch(json({ id: 'cus_1', email: 'a@b.test' }));
    const client = createStripeClient({ secretKey: KEY, fetchImpl: impl });

    const res = await client.createCustomer(
      { email: 'a@b.test', metadata: { billing_account_id: 'ba_1' } },
      'customer:ba_1',
    );

    expect(res).toEqual({
      ok: true,
      data: { id: 'cus_1', email: 'a@b.test' },
      requestId: 'req_123',
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://api.stripe.com/v1/customers');
    expect(call.init.method).toBe('POST');
    expect(headerOf(call, 'authorization')).toBe(`Bearer ${KEY}`);
    expect(headerOf(call, 'stripe-version')).toBe(STRIPE_API_VERSION);
    expect(headerOf(call, 'idempotency-key')).toBe('customer:ba_1');
    expect(headerOf(call, 'content-type')).toBe('application/x-www-form-urlencoded');
    expect(decodeURIComponent(String(call.init.body))).toBe(
      'email=a@b.test&metadata[billing_account_id]=ba_1',
    );
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a POST without an idempotency key and sends nothing', async () => {
    const { impl, calls } = fakeFetch();
    const client = createStripeClient({ secretKey: KEY, fetchImpl: impl });

    const res = await client.createCustomer({ email: 'a@b.test' }, '  ');

    expect(res).toMatchObject({ ok: false, status: 0, reason: 'invalid_request' });
    expect(calls).toHaveLength(0);
  });

  it('sends GET params in the query string with no idempotency key or body', async () => {
    const { impl, calls } = fakeFetch(json({ data: [{ id: 'price_1' }], has_more: false }));
    const client = createStripeClient({ secretKey: KEY, fetchImpl: impl });

    await client.getPriceByLookupKey('managed_annual');

    const [call] = calls;
    expect(call.init.method).toBe('GET');
    expect(call.init.body).toBeUndefined();
    expect(headerOf(call, 'idempotency-key')).toBeNull();
    expect(decodeURIComponent(call.url)).toBe(
      'https://api.stripe.com/v1/prices?lookup_keys[]=managed_annual&active=true&limit=1',
    );
  });

  it('createCheckoutSession merges extra params after the typed ones', async () => {
    const { impl, calls } = fakeFetch(json({ id: 'cs_1', url: 'https://checkout.test' }));
    const client = createStripeClient({ secretKey: KEY, fetchImpl: impl });

    const res = await client.createCheckoutSession(
      {
        mode: 'subscription',
        customer: 'cus_1',
        line_items: [{ price: 'price_1', quantity: 2 }],
        success_url: 'https://x.test/ok',
        cancel_url: 'https://x.test/no',
        consent_collection: { terms_of_service: 'required' },
        extra: { locale: 'en' },
      },
      'checkout:ba_1:1',
    );

    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const body = decodeURIComponent(String(calls[0].init.body));
    expect(body).toContain('line_items[0][price]=price_1&line_items[0][quantity]=2');
    expect(body).toContain('consent_collection[terms_of_service]=required');
    expect(body).toMatch(/&locale=en$/);
    expect(body).not.toContain('extra');
  });

  it('createPortalSession posts customer, configuration and return_url', async () => {
    const { impl, calls } = fakeFetch(json({ id: 'bps_1', url: 'https://portal.test' }));
    const client = createStripeClient({ secretKey: KEY, fetchImpl: impl });

    const res = await client.createPortalSession(
      { customer: 'cus_1', configuration: 'bpc_1', return_url: 'https://x.test/back' },
      'portal:1',
    );

    expect(res).toMatchObject({ ok: true, data: { url: 'https://portal.test' } });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
    expect(decodeURIComponent(String(calls[0].init.body))).toBe(
      'customer=cus_1&configuration=bpc_1&return_url=https://x.test/back',
    );
  });

  it('updateSubscription sends the item quantity, proration, payment behavior and cancel flag', async () => {
    const { impl, calls } = fakeFetch(json(SUB));
    const client = createStripeClient({ secretKey: KEY, fetchImpl: impl });

    const res = await client.updateSubscription(
      'sub_1',
      {
        item: { id: 'si_1', quantity: 4 },
        proration_behavior: 'always_invoice',
        payment_behavior: 'pending_if_incomplete',
        cancel_at_period_end: false,
      },
      'add:sub_1:4',
    );

    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(headerOf(calls[0], 'idempotency-key')).toBe('add:sub_1:4');
    expect(decodeURIComponent(String(calls[0].init.body))).toBe(
      'proration_behavior=always_invoice&payment_behavior=pending_if_incomplete&cancel_at_period_end=false&items[0][id]=si_1&items[0][quantity]=4',
    );
  });

  it('updateSubscription without an item sends no items key', async () => {
    const { impl, calls } = fakeFetch(json(SUB));
    const client = createStripeClient({ secretKey: KEY, fetchImpl: impl });

    await client.updateSubscription('sub_1', { cancel_at_period_end: true }, 'ban:sub_1');

    expect(String(calls[0].init.body)).toBe('cancel_at_period_end=true');
  });

  it('retrieveSubscription GETs the id, path-encoded', async () => {
    const { impl, calls } = fakeFetch(json(SUB));
    const client = createStripeClient({ secretKey: KEY, fetchImpl: impl });

    const res = await client.retrieveSubscription('sub_1/../x');

    expect(res).toMatchObject({ ok: true, data: { id: 'sub_1' } });
    expect(calls[0].url).toBe('https://api.stripe.com/v1/subscriptions/sub_1%2F..%2Fx');
  });

  it('calls fetchImpl as a plain function, as the Workers global fetch requires', async () => {
    // The Workers `fetch` throws "Illegal invocation" when `this` is anything but the
    // global scope. Node's does not, so this fake stands in for the runtime's check.
    const seen: unknown[] = [];
    const strictFetch = function (this: unknown) {
      seen.push(this);
      if (this !== undefined && this !== globalThis) {
        return Promise.reject(new TypeError('Illegal invocation'));
      }
      return Promise.resolve(json({ data: [SUB], has_more: false }));
    } as unknown as typeof fetch;
    const client = createStripeClient({ secretKey: KEY, fetchImpl: strictFetch });

    const res = await client.listSubscriptions({});

    expect(res).toMatchObject({ ok: true });
    expect(seen).toEqual([undefined]);
  });
});

describe('createStripeClient: getPriceByLookupKey', () => {
  it('returns the first price', async () => {
    const price = { id: 'price_1', lookup_key: 'managed_annual', recurring: { interval: 'year' } };
    const { impl } = fakeFetch(json({ data: [price], has_more: false }));
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).getPriceByLookupKey(
      'managed_annual',
    );
    expect(res).toEqual({ ok: true, data: price, requestId: 'req_123' });
  });

  it('is not_found when no active price has the key', async () => {
    const { impl } = fakeFetch(json({ data: [], has_more: false }));
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).getPriceByLookupKey(
      'managed_annual',
    );
    expect(res).toMatchObject({ ok: false, status: 404, reason: 'not_found' });
  });
});

describe('createStripeClient: findCheckoutSessionForSubscription (AECI-1503)', () => {
  it('GETs one session filtered by subscription and returns it', async () => {
    const session = {
      id: 'cs_1',
      url: null,
      customer: 'cus_1',
      metadata: { terms_version: '1.0' },
    };
    const { impl, calls } = fakeFetch(json({ data: [session], has_more: false }));
    const res = await createStripeClient({
      secretKey: KEY,
      fetchImpl: impl,
    }).findCheckoutSessionForSubscription('sub_1');
    expect(res).toEqual({ ok: true, data: session, requestId: 'req_123' });
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].url).toBe(
      'https://api.stripe.com/v1/checkout/sessions?subscription=sub_1&limit=1',
    );
  });

  it('is not_found when Stripe lists no session', async () => {
    const { impl } = fakeFetch(json({ data: [], has_more: false }));
    const res = await createStripeClient({
      secretKey: KEY,
      fetchImpl: impl,
    }).findCheckoutSessionForSubscription('sub_1');
    expect(res).toMatchObject({ ok: false, status: 404, reason: 'not_found' });
  });

  it('returns a failed request as a failure, never a throw', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const res = await createStripeClient({
      secretKey: KEY,
      fetchImpl: impl,
    }).findCheckoutSessionForSubscription('sub_1');
    expect(res).toMatchObject({ ok: false, status: 0, reason: 'network' });
  });
});

describe('createStripeClient: open Checkout Sessions (AECI-1501)', () => {
  it('lists the customer’s open sessions with their line items expanded', async () => {
    const session = {
      id: 'cs_1',
      url: 'https://checkout.test/cs_1',
      status: 'open',
      customer: 'cus_1',
      metadata: {},
      line_items: { data: [{ id: 'li_1', quantity: 2, price: { id: 'price_1' } }] },
    };
    const { impl, calls } = fakeFetch(json({ data: [session], has_more: false }));
    const res = await createStripeClient({
      secretKey: KEY,
      fetchImpl: impl,
    }).listOpenCheckoutSessions('cus_1');
    expect(res).toEqual({ ok: true, data: [session], requestId: 'req_123' });
    expect(calls[0].init.method).toBe('GET');
    expect(headerOf(calls[0], 'idempotency-key')).toBeNull();
    expect(decodeURIComponent(calls[0].url)).toBe(
      'https://api.stripe.com/v1/checkout/sessions?customer=cus_1&status=open&limit=100&expand[]=data.line_items',
    );
  });

  it('returns an empty list, and a failure as a failure', async () => {
    const empty = fakeFetch(json({ data: [], has_more: false }));
    expect(
      await createStripeClient({ secretKey: KEY, fetchImpl: empty.impl }).listOpenCheckoutSessions(
        'cus_1',
      ),
    ).toMatchObject({ ok: true, data: [] });

    const failed = fakeFetch(json({ error: { type: 'api_error' } }, 500));
    expect(
      await createStripeClient({ secretKey: KEY, fetchImpl: failed.impl }).listOpenCheckoutSessions(
        'cus_1',
      ),
    ).toMatchObject({ ok: false, status: 500, reason: 'http_error' });
  });

  it('expires a session by POST with the caller’s idempotency key, path-encoded', async () => {
    const { impl, calls } = fakeFetch(
      json({ id: 'cs_1', url: null, status: 'expired', customer: 'cus_1', metadata: {} }),
    );
    const res = await createStripeClient({
      secretKey: KEY,
      fetchImpl: impl,
    }).expireCheckoutSession('cs_1/x', 'aeci-expire-cs_1');
    expect(res).toMatchObject({ ok: true, data: { status: 'expired' } });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_1%2Fx/expire');
    expect(headerOf(calls[0], 'idempotency-key')).toBe('aeci-expire-cs_1');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('releases the body of a non-JSON refusal to expire', async () => {
    const { res, state } = trackedResponse(400, 'text/plain');
    const { impl } = fakeFetch(res);
    const out = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).expireCheckoutSession(
      'cs_1',
      'aeci-expire-cs_1',
    );
    expect(out).toMatchObject({ ok: false, status: 400, reason: 'http_error' });
    await Promise.resolve();
    expect(state.cancelled).toBe(true);
  });
});

describe('createStripeClient: listSubscriptions', () => {
  const sub = (id: string): StripeSubscription => ({ ...SUB, id });

  it('walks pages with starting_after until has_more is false', async () => {
    const { impl, calls } = fakeFetch(
      json({ data: [sub('sub_a'), sub('sub_b')], has_more: true }),
      json({ data: [sub('sub_c')], has_more: false }),
    );
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).listSubscriptions({
      status: 'all',
      limit: 2,
    });

    expect(res.ok && res.data.subscriptions.map((s) => s.id)).toEqual(['sub_a', 'sub_b', 'sub_c']);
    expect(res.ok && res.data.truncated).toBe(false);
    expect(decodeURIComponent(calls[0].url)).toBe(
      'https://api.stripe.com/v1/subscriptions?status=all&limit=2',
    );
    expect(decodeURIComponent(calls[1].url)).toBe(
      'https://api.stripe.com/v1/subscriptions?status=all&limit=2&starting_after=sub_b',
    );
  });

  it('stops at maxPages and reports truncated', async () => {
    const { impl, calls } = fakeFetch(
      json({ data: [sub('sub_a')], has_more: true }),
      json({ data: [sub('sub_b')], has_more: true }),
    );
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).listSubscriptions({
      maxPages: 2,
    });

    expect(calls).toHaveLength(2);
    expect(res).toMatchObject({ ok: true, data: { truncated: true } });
    expect(res.ok && res.data.subscriptions).toHaveLength(2);
  });

  it('passes nested filters and returns the failure of a failed page', async () => {
    const { impl, calls } = fakeFetch(
      json({ data: [sub('sub_a')], has_more: true }),
      json({ error: { type: 'api_error', message: 'boom' } }, 500),
    );
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).listSubscriptions({
      created: { gte: 1_700_000_000 },
    });

    expect(decodeURIComponent(calls[0].url)).toContain('created[gte]=1700000000');
    expect(res).toMatchObject({ ok: false, status: 500, reason: 'http_error', message: 'boom' });
  });
});

describe('createStripeClient: failures never throw', () => {
  it('maps a Stripe error body onto the failure', async () => {
    const { impl } = fakeFetch(
      json(
        {
          error: {
            type: 'invalid_request_error',
            code: 'resource_missing',
            param: 'id',
            message: 'No such subscription',
          },
        },
        404,
      ),
    );
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).retrieveSubscription(
      'sub_x',
    );
    expect(res).toEqual({
      ok: false,
      status: 404,
      reason: 'http_error',
      message: 'No such subscription',
      type: 'invalid_request_error',
      code: 'resource_missing',
      declineCode: undefined,
      param: 'id',
      requestId: 'req_123',
    });
  });

  it('drains a non-JSON error body it does not read', async () => {
    const { res: response, state } = trackedResponse(502, 'text/html');
    const { impl } = fakeFetch(response);
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).retrieveSubscription(
      'sub_1',
    );
    expect(res).toMatchObject({ ok: false, status: 502, reason: 'http_error' });
    expect(state.cancelled).toBe(true);
  });

  it('drains a non-JSON 2xx body and reports invalid_response', async () => {
    const { res: response, state } = trackedResponse(200, 'text/plain');
    const { impl } = fakeFetch(response);
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).retrieveSubscription(
      'sub_1',
    );
    expect(res).toMatchObject({ ok: false, status: 200, reason: 'invalid_response' });
    expect(state.cancelled).toBe(true);
  });

  it('reports unparseable JSON as invalid_response', async () => {
    const { res: response } = trackedResponse(200, 'application/json', '{not json');
    const { impl } = fakeFetch(response);
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).retrieveSubscription(
      'sub_1',
    );
    expect(res).toMatchObject({ ok: false, reason: 'invalid_response' });
  });

  it("clamps the page size to Stripe's 1..100 and the page cap to at least 1", async () => {
    const { impl, calls } = fakeFetch(json({ data: [{ ...SUB, id: 'sub_a' }], has_more: true }));
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).listSubscriptions({
      limit: 500,
      maxPages: 0,
    });
    expect(calls).toHaveLength(1);
    expect(decodeURIComponent(calls[0].url)).toContain('limit=100');
    expect(res).toMatchObject({ ok: true, data: { truncated: true } });
  });

  it('maps a timeout during the body read to timeout', async () => {
    const res = new Response('{}', { headers: { 'content-type': 'application/json' } });
    vi.spyOn(res, 'json').mockRejectedValue(
      Object.assign(new Error('t'), { name: 'TimeoutError' }),
    );
    const { impl } = fakeFetch(res);
    const out = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).retrieveSubscription(
      'sub_1',
    );
    expect(out).toMatchObject({ ok: false, status: 200, reason: 'timeout' });
  });

  it('reports a JSON array as invalid_response', async () => {
    const { impl } = fakeFetch(json([1, 2]));
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).retrieveSubscription(
      'sub_1',
    );
    expect(res).toMatchObject({ ok: false, reason: 'invalid_response' });
  });

  it('maps a timeout abort to timeout', async () => {
    const { impl } = fakeFetch(() => {
      const e = new Error('The operation timed out');
      e.name = 'TimeoutError';
      throw e;
    });
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).retrieveSubscription(
      'sub_1',
    );
    expect(res).toEqual({
      ok: false,
      status: 0,
      reason: 'timeout',
      message: 'The operation timed out',
    });
  });

  it('times out for real when the fetch outlives timeoutMs', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const res = await createStripeClient({
      secretKey: KEY,
      fetchImpl: hang,
      timeoutMs: 5,
    }).retrieveSubscription('sub_1');
    expect(res).toMatchObject({ ok: false, status: 0, reason: 'timeout' });
  });

  it('maps a network failure to network', async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const res = await createStripeClient({ secretKey: KEY, fetchImpl: impl }).createCustomer(
      {},
      'k',
    );
    expect(res).toEqual({ ok: false, status: 0, reason: 'network', message: 'fetch failed' });
  });
});

describe('readers', () => {
  it('read quantity, interval and the item-level period end', () => {
    expect(subscriptionQuantity(SUB)).toBe(3);
    expect(subscriptionInterval(SUB)).toBe('year');
    expect(subscriptionCurrentPeriodEnd(SUB)).toBe(1_800_000_000);
  });

  it('fall back to the subscription-level period end of older API versions', () => {
    const legacy: StripeSubscription = {
      ...SUB,
      current_period_end: 1_700_000_000,
      items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_1' } }] },
    };
    expect(subscriptionCurrentPeriodEnd(legacy)).toBe(1_700_000_000);
    expect(subscriptionInterval(legacy)).toBeNull();
  });

  it('answer 0 and null for a subscription with no item', () => {
    const empty: StripeSubscription = { ...SUB, items: { data: [] } };
    expect(subscriptionQuantity(empty)).toBe(0);
    expect(subscriptionCurrentPeriodEnd(empty)).toBeNull();
  });

  it('find the invoice subscription id in either API-version location', () => {
    const base: StripeInvoice = {
      id: 'in_1',
      customer: 'cus_1',
      billing_reason: 'subscription_cycle',
    };
    expect(
      invoiceSubscriptionId({
        ...base,
        parent: { subscription_details: { subscription: 'sub_1' } },
      }),
    ).toBe('sub_1');
    expect(invoiceSubscriptionId({ ...base, subscription: { ...SUB, id: 'sub_2' } })).toBe('sub_2');
    expect(invoiceSubscriptionId(base)).toBeNull();
  });
});

describe('env helpers', () => {
  it('stripeCheckoutAvailable needs the flag exactly "true" AND a key', () => {
    expect(
      stripeCheckoutAvailable({ STRIPE_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: KEY }),
    ).toBe(true);
    expect(
      stripeCheckoutAvailable({ STRIPE_CHECKOUT_ENABLED: 'false', STRIPE_SECRET_KEY: KEY }),
    ).toBe(false);
    expect(
      stripeCheckoutAvailable({ STRIPE_CHECKOUT_ENABLED: 'TRUE', STRIPE_SECRET_KEY: KEY }),
    ).toBe(false);
    expect(
      stripeCheckoutAvailable({ STRIPE_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: ' ' }),
    ).toBe(false);
    expect(stripeCheckoutAvailable({ STRIPE_CHECKOUT_ENABLED: 'true' })).toBe(false);
    expect(stripeCheckoutAvailable({ STRIPE_SECRET_KEY: KEY })).toBe(false);
  });

  it('stripeClientFromEnv is null without a key', () => {
    expect(stripeClientFromEnv({})).toBeNull();
    expect(stripeClientFromEnv({ STRIPE_SECRET_KEY: '' })).toBeNull();
    expect(stripeClientFromEnv({ STRIPE_SECRET_KEY: KEY })).not.toBeNull();
  });

  it('stripePortalConfigFor picks the config by interval', () => {
    const env = { STRIPE_PORTAL_CONFIG_ANNUAL: 'bpc_a', STRIPE_PORTAL_CONFIG_MONTHLY: 'bpc_m' };
    expect(stripePortalConfigFor(env, 'year')).toBe('bpc_a');
    expect(stripePortalConfigFor(env, 'month')).toBe('bpc_m');
    expect(stripePortalConfigFor({}, 'year')).toBeNull();
  });
});
