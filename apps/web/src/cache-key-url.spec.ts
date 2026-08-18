import { describe, expect, it, vi } from 'vitest';

import { cacheGateway, cacheKeyFor, type Bindings } from './server-runtime';

// WC-4 (AECI-318) restored the cache-key normalization WC-3 removed with the
// hand-rolled `caches.default` pipeline. Native Cloudflare Workers Cache keys on
// the full, order-sensitive query string, so a gateway entrypoint normalizes the
// URL and forwards it as `cf.cacheKey` on a `ctx.exports` loopback to the cached
// `Renderer` entrypoint — a custom `cf.cacheKey` *replaces the path + query* in
// the native key. `cacheKeyFor()` IS that normalized key, so whether two URLs
// land in distinct edge entries — or collapse into one — is decided entirely
// here. Because a custom key replaces path+query only, the returned value is
// PATH-RELATIVE (origin dropped): each env / Worker version is already an
// isolated cache namespace, so origin need not (and cannot) be part of the key.
//
// This lives as a unit test, NOT an HTTP HIT/MISS e2e, on purpose: front-of-
// Worker HIT/MISS is unobservable on localhost Miniflare and is verified on a
// deployed preview via `Cf-Cache-Status` (WC-9). The facet e2e
// (`e2e/facets.spec.ts`) asserts the complementary half — distinct facet URLs
// carry the *same* Cache-Tag (facets live in the key, not the tag).

const ORIGIN = 'https://aeci.test';
const key = (pathWithQuery: string): string => cacheKeyFor(new URL(pathWithQuery, ORIGIN));

describe('cacheKeyFor — distinct facets → distinct cache entries (AECI-145)', () => {
  it('forks the key for distinct values of the same facet dimension', () => {
    expect(key('/products?category_id=cat-a')).not.toBe(key('/products?category_id=cat-b'));
  });

  it('forks the key across different facet dimensions with the same value', () => {
    expect(key('/products?category_id=x')).not.toBe(key('/products?audience_id=x'));
  });

  it('forks the key when a second facet dimension is added', () => {
    expect(key('/products?category_id=x&audience_id=y')).not.toBe(key('/products?category_id=x'));
  });

  it('keeps all three taxonomy dimensions in the key', () => {
    const k = key('/products?category_id=a&audience_id=b&phase_id=c');
    expect(k).toContain('category_id=a');
    expect(k).toContain('audience_id=b');
    expect(k).toContain('phase_id=c');
  });
});

describe('cacheKeyFor — ?view= forks the /products key (AECI-190)', () => {
  // `/products` SSR-renders a different layout for `?view=table` (dense table)
  // vs. the card-grid default. If `view` weren't in the allowlist the two
  // renders would collapse onto one entry and the edge would serve whichever
  // warmed the key first — so the table and cards URLs MUST get distinct keys.
  it('forks the key for the table view vs. the cards default', () => {
    expect(key('/products?view=table')).not.toBe(key('/products'));
  });

  it('forks the key for table vs. an explicit cards view', () => {
    expect(key('/products?view=table')).not.toBe(key('/products?view=cards'));
  });

  it('keeps view alongside the other listing params', () => {
    const k = key('/products?view=table&sort=name&page=2');
    expect(k).toContain('view=table');
    expect(k).toContain('sort=name');
    expect(k).toContain('page=2');
  });
});

describe('cacheKeyFor — ?view= forks the product-PAIR key (mirrors AECI-190)', () => {
  // The pair page /products/:context/integrations/:other SSR-renders a Basic
  // ("Overview": sync headline + descriptions, no claim lanes) for ?view=basic
  // vs. the `detailed` default. `view` is content-affecting, so it's in the pair
  // route's cacheKeyParams — otherwise the two renders collapse onto one entry
  // and the edge serves whichever warmed the key first.
  const pair = '/products/autodesk-revit/integrations/procore';

  it('forks the key for the basic view vs. the detailed default', () => {
    expect(key(`${pair}?view=basic`)).not.toBe(key(pair));
  });

  it('forks the key for basic vs. an explicit detailed view', () => {
    expect(key(`${pair}?view=basic`)).not.toBe(key(`${pair}?view=detailed`));
  });

  it('keeps view while still stripping tracking params on the pair route', () => {
    expect(key(`${pair}?view=basic&utm_source=g&fbclid=z`)).toBe(`${pair}?view=basic`);
  });

  it('strips other query params on the pair route (page/sort are not allowlisted)', () => {
    expect(key(`${pair}?page=2&sort=name`)).toBe(pair);
  });
});

describe('cacheKeyFor — the version selectors fork the product-PAIR key (AECI-303 §9.2)', () => {
  // The two selectors are content-affecting URL params: they change which claims
  // render, what each added/removed/unchanged marker says, AND whether the
  // resolver marks the page `noindex` — which WC-8 bakes into the stored payload.
  // Under-including them would serve one visitor's version selection, and its
  // robots tag, to everyone.
  const pair = '/products/autodesk-revit/integrations/procore';

  it('forks the key for a context-product version vs. the latest default', () => {
    expect(key(`${pair}?context_version=2026.1`)).not.toBe(key(pair));
  });

  it('forks the key for an other-product version vs. the latest default', () => {
    expect(key(`${pair}?other_version=v5.2`)).not.toBe(key(pair));
  });

  it('forks on WHICH side the version is for, not just the value', () => {
    // The same label on opposite axes is a different selection: 2026.1 of the
    // context product against latest, vs. latest against 2026.1 of the other.
    expect(key(`${pair}?context_version=2026.1`)).not.toBe(key(`${pair}?other_version=2026.1`));
  });

  it('keeps the pair ORDERED — swapping the two values is a different selection', () => {
    // This is the test that catches a future "let's add these to
    // MULTI_VALUE_CACHE_KEY_PARAMS for consistency" change: any cross-name value
    // normalization would collapse these two distinct diffs onto one entry.
    expect(key(`${pair}?context_version=a&other_version=b`)).not.toBe(
      key(`${pair}?context_version=b&other_version=a`),
    );
  });

  it('forks the key for each distinct version pair', () => {
    expect(key(`${pair}?context_version=2026.1&other_version=v5`)).not.toBe(
      key(`${pair}?context_version=2026.9&other_version=v5`),
    );
  });

  it('canonicalizes param order across all three allowlisted params', () => {
    expect(key(`${pair}?view=basic&context_version=x&other_version=y`)).toBe(
      key(`${pair}?other_version=y&context_version=x&view=basic`),
    );
  });

  it('keeps the version params while still stripping tracking params', () => {
    expect(key(`${pair}?context_version=2026.1&utm_source=g&fbclid=z`)).toBe(
      `${pair}?context_version=2026.1`,
    );
  });

  it('preserves a comma inside a version label (NOT a multi-value CSV param)', () => {
    // Version labels are vendor-authored free text and may legally contain a
    // comma. `sortCsv` would rewrite `R2024,SP1` — pinning this stops the params
    // being added to MULTI_VALUE_CACHE_KEY_PARAMS, which would corrupt the
    // selection rather than merely fragment the cache.
    expect(key(`${pair}?context_version=R2024,SP1`)).toContain('R2024%2CSP1');
    expect(key(`${pair}?context_version=SP1,R2024`)).not.toBe(
      key(`${pair}?context_version=R2024,SP1`),
    );
  });
});

describe('cacheKeyFor — canonicalization (param order must not fork the key)', () => {
  it('is invariant to the order of page + sort', () => {
    expect(key('/products?page=2&sort=name')).toBe(key('/products?sort=name&page=2'));
  });

  it('is invariant to the order of facet params', () => {
    expect(key('/products?category_id=x&audience_id=y')).toBe(
      key('/products?audience_id=y&category_id=x'),
    );
  });
});

describe('cacheKeyFor — multi-select facet CSV order-independence (AECI-223 / WC-4)', () => {
  // The taxonomy facets are multi-select: a dimension's set is a comma-separated
  // list in one `{kind}_id` param. `a,b` and `b,a` are the same filter, so they
  // MUST resolve to one key. The producer (`aec-facet-sidebar`) emits the CSV
  // sorted, but WC-4 also sorts it in the key so a raw/hand-typed/bot `b,a`
  // collapses too. (Comma serializes to `%2C` in the key string, so these assert
  // key equality rather than a literal comma substring.)
  it('collapses `a,b` and `b,a` of one dimension onto a single key', () => {
    expect(key('/products?category_id=a,b')).toBe(key('/products?category_id=b,a'));
  });

  it('sorts an unsorted CSV into the same key as its sorted form', () => {
    expect(key('/products?category_id=c,a,b')).toBe(key('/products?category_id=a,b,c'));
  });

  it('holds order-independence for one dimension while another is present', () => {
    expect(key('/products?category_id=b,a&audience_id=x')).toBe(
      key('/products?category_id=a,b&audience_id=x'),
    );
  });

  it('still forks distinct sets (a,b is not the same filter as just a)', () => {
    expect(key('/products?category_id=a,b')).not.toBe(key('/products?category_id=a'));
  });
});

describe('cacheKeyFor — tracking/marketing params are stripped', () => {
  it('drops utm_* and fbclid while keeping content-affecting params', () => {
    expect(key('/products?category_id=x&utm_source=g&utm_medium=cpc&fbclid=z')).toBe(
      key('/products?category_id=x'),
    );
  });

  it('collapses a tracking-only query down to the bare index key', () => {
    expect(key('/products?utm_source=g&gclid=abc')).toBe(key('/products'));
  });

  it('collapses utm_*/fbclid/gclid variants of a detail route to one key', () => {
    // AC #1 — these all resolve to the same cache entry.
    expect(key('/products/foo?utm_source=x')).toBe(key('/products/foo'));
    expect(key('/products/foo?fbclid=y')).toBe(key('/products/foo'));
    expect(key('/products/foo?utm_source=x&utm_medium=email&fbclid=y&gclid=z')).toBe(
      key('/products/foo'),
    );
  });

  it('strips the query on home, browse, and static routes (no content params)', () => {
    expect(key('/?utm_campaign=launch')).toBe('/');
    expect(key('/about?utm_source=x')).toBe('/about');
    expect(key('/categories?ref=newsletter')).toBe('/categories');
  });
});

describe('cacheKeyFor — index/browse routes keep only content-affecting params', () => {
  it('keeps page/perPage and drops tracking on /products', () => {
    // AC #2 — distinct content keyed; tracking noise dropped.
    expect(key('/products?page=2&utm_source=x&fbclid=y')).toBe('/products?page=2');
    expect(key('/products?perPage=50')).toBe('/products?perPage=50');
  });

  it('keys distinct pages of an index as distinct entries', () => {
    expect(key('/products?page=1')).not.toBe(key('/products?page=2'));
  });

  it('treats stray filter params on /products as noise (not content params)', () => {
    // `sourceProductId` is not in the products index cacheKeyParams, so it drops.
    expect(key('/products?sourceProductId=abc')).toBe('/products');
  });

  it('keeps the AECI-143 taxonomy filter ids and drops tracking noise', () => {
    expect(key('/products?category_id=abc&utm_source=x')).toBe('/products?category_id=abc');
    expect(key('/products?audience_id=a&phase_id=p')).toBe('/products?audience_id=a&phase_id=p');
  });

  it('keeps the cross-filter ids on a taxonomy browse page (AECI-143)', () => {
    // A browse page's own dimension rides the path; the other three ride the query.
    expect(key('/categories/structural?audience_id=a&fbclid=y')).toBe(
      '/categories/structural?audience_id=a',
    );
    expect(key('/phases/preconstruction?category_id=c')).toBe(
      '/phases/preconstruction?category_id=c',
    );
    // AECI-544 — `trade_id` is content-affecting on every listing route. These
    // cases came over from `server.spec.ts` at the AECI-619 reconciliation, when
    // the pre-WC-3 `cacheKeyUrl` suite they lived in was retired.
    expect(key('/trades/electrical?category_id=c&fbclid=y')).toBe(
      '/trades/electrical?category_id=c',
    );
    expect(key('/categories/structural?trade_id=t')).toBe('/categories/structural?trade_id=t');
  });

  it('keys distinct trade filters as distinct entries (AECI-544)', () => {
    // Under-including `trade_id` would collapse these onto one entry and serve
    // the wrong HTML (CACHE_STRATEGY.md §4a).
    expect(key('/products?trade_id=a')).not.toBe(key('/products?trade_id=b'));
    expect(key('/products')).not.toBe(key('/products?trade_id=a'));
  });
});

describe('cacheKeyFor — path-relative key (origin dropped, pathname preserved)', () => {
  it('keeps the pathname and appends only the allowlisted params', () => {
    expect(key('/products?category_id=x')).toBe('/products?category_id=x');
  });

  it('returns the bare pathname for a no-query listing URL', () => {
    expect(key('/products')).toBe('/products');
  });

  it('drops the origin (host + port) — a custom cf.cacheKey replaces path+query only', () => {
    // The removed pre-WC-3 `cacheKeyUrl` returned a full-origin URL for the
    // `caches.default` match/put; the gateway's `cf.cacheKey` is path-relative.
    expect(cacheKeyFor(new URL('http://localhost:8788/products/foo?utm_source=x'))).toBe(
      '/products/foo',
    );
  });

  // LOCALES is en-US-only today (the default entry has an empty prefix), so
  // there is no non-trivial locale prefix to exercise. When a prefixed locale
  // lands, add a case asserting the prefix survives in the key (locale variance
  // is segmented by URL prefix, so the key MUST keep it).
});

describe('cacheKeyFor — browse routes share the listing allowlist', () => {
  it('forks the key for distinct facets on a /categories/:slug browse page', () => {
    expect(key('/categories/structural?audience_id=a')).not.toBe(
      key('/categories/structural?audience_id=b'),
    );
  });

  it('preserves the browse pathname and keeps the facet param', () => {
    expect(key('/categories/structural?audience_id=a')).toBe(
      '/categories/structural?audience_id=a',
    );
  });
});

describe('cacheKeyFor — non-listing routes strip every param', () => {
  it('strips even page/sort on a detail route (no cacheKeyParams)', () => {
    expect(key('/products/procore?page=2&sort=name')).toBe('/products/procore');
  });

  it('strips the query on an uncacheable/unmatched route (e.g. /search)', () => {
    expect(key('/search?q=revit')).toBe('/search');
  });
});

describe('cacheGateway — forwards to the Renderer entrypoint with the normalized key', () => {
  // The gateway's own cache is disabled (wrangler `exports.default`), so it runs
  // on every request. It computes `cacheKeyFor(url)` and forwards the ORIGINAL
  // request to `ctx.exports.Renderer.fetch(request, { cf: { cacheKey } })`. Here
  // we stub the loopback and assert the key + that the request is untouched.
  const stubCtx = (rendererFetch: ReturnType<typeof vi.fn>) =>
    ({ exports: { Renderer: { fetch: rendererFetch } } }) as unknown as ExecutionContext;
  const env = {} as unknown as Bindings;

  it('forwards a GET with the normalized cf.cacheKey (utm stripped)', async () => {
    const rendererFetch = vi.fn().mockResolvedValue(new Response('rendered'));
    const request = new Request('https://aeci.test/products?category_id=x&utm_source=g');

    await cacheGateway.fetch(request, env, stubCtx(rendererFetch));

    expect(rendererFetch).toHaveBeenCalledTimes(1);
    const [forwarded, init] = rendererFetch.mock.calls[0];
    // The cache LOOKUP key is normalized...
    expect(init).toEqual({ cf: { cacheKey: '/products?category_id=x' } });
    // ...but the request the Renderer sees is the original (utm_* intact for the
    // render + client analytics — only the key is de-fragmented).
    expect(forwarded).toBe(request);
    expect(new URL((forwarded as Request).url).search).toContain('utm_source=g');
  });

  it('returns the Renderer response unchanged', async () => {
    const response = new Response('rendered', { status: 200 });
    const rendererFetch = vi.fn().mockResolvedValue(response);

    const result = await cacheGateway.fetch(
      new Request('https://aeci.test/'),
      env,
      stubCtx(rendererFetch),
    );

    expect(result).toBe(response);
  });

  it('forwards a non-GET request with no custom cache key (not cacheable)', async () => {
    const rendererFetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const request = new Request('https://aeci.test/api/subscribe', { method: 'POST' });

    await cacheGateway.fetch(request, env, stubCtx(rendererFetch));

    expect(rendererFetch).toHaveBeenCalledTimes(1);
    expect(rendererFetch.mock.calls[0]).toEqual([request]);
  });
});
