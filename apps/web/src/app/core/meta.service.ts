import { DOCUMENT } from '@angular/common';
import { Service, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';

import type { ProductDetail, VendorDetail } from '@aeci/shared';

import {
  DEFAULT_OG_IMAGE,
  type EntityKind,
  HOME_OG_IMAGE,
  SITE_NAME,
  buildEntityTitle,
  buildOgTags,
  buildProductJsonLd,
  buildSiteOrganizationLd,
  buildVendorJsonLd,
  buildWebSiteJsonLd,
  isBrowseKind,
  ogTypeForKind,
  originOf,
  stripQueryParams,
  truncateAtWordBoundary,
} from './meta.helpers';

/**
 * Entity kinds the service knows how to title. Defined once in `meta.helpers.ts`
 * and re-exported here so the service's public surface is unchanged.
 *
 * - Detail kinds (`product`, `vendor`, `integration`) get the bare
 *   `"{name} · AEC Integrations"` title and `og:type=article`.
 * - Browse kinds (`category`, `audience`, `phase`) get the
 *   `"{name} tools · AEC Integrations"` variant and `og:type=website`
 *   (per Phase 2 Spec §9.1).
 * - `index` (used by `/products`, `/vendors`, `/integrations`) gets the bare
 *   `"{name} · AEC Integrations"` title (no "tools" infix) and
 *   `og:type=website` — an index is not an article.
 */
export type { EntityKind };

export interface SetEntityMetaInput {
  entity: EntityKind;
  name: string;
  description: string | null | undefined;
  canonical: string;
  ogImage?: string;
  /**
   * Emit `robots: noindex` for an otherwise-canonical entity page whose current
   * state isn't worth indexing — e.g. a product-PAIR page with no integrations
   * between the two products (thin content; AECI-294). Defaults to indexable.
   * The tag is actively removed when `false` so an in-app navigation OFF a
   * noindexed page back onto an indexable one doesn't leave a stale robots tag.
   */
  noindex?: boolean;
}

/**
 * Centralized SEO metadata composer for every Phase 2 page. Sets `<title>`,
 * description, canonical link, OG/Twitter tags, and (via `setProductJsonLd` /
 * `setVendorJsonLd`) JSON-LD script tags. Platform-agnostic — `Title`, `Meta`,
 * and `DOCUMENT` all work under `@angular/ssr` AND in the browser, so no
 * `isPlatformBrowser` guards. During SSR these ship in the initial HTML; on an
 * in-app client navigation the resolvers re-invoke them so the head stays
 * correct in the SPA (idempotent upserts; AECI-151). The methods are pure DOM
 * upserts — the platform decision lives in the callers, not here.
 *
 * Spec anchor: docs/STAGE_1_PHASE_2_SPEC.md §9.
 */
@Service()
export class MetaService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);

  setEntityMeta(input: SetEntityMetaInput): void {
    const suffix = isBrowseKind(input.entity)
      ? $localize`:@@meta.browseTitleSuffix: tools · AEC Integrations`
      : $localize`:@@meta.titleSuffix: · AEC Integrations`;

    const title = buildEntityTitle(input.name, suffix);
    this.title.setTitle(title);

    const fallback = $localize`:@@meta.defaultDescription:Software integration directory for the AEC industry.`;
    const description = truncateAtWordBoundary(input.description) || fallback;
    this.meta.updateTag({ name: 'description', content: description });

    const canonical = stripQueryParams(input.canonical);
    this.upsertCanonical(canonical);

    // Indexable by default; noindex only when the caller opts in (e.g. an empty
    // pair page). Clear the tag otherwise so a client nav off a noindexed page
    // doesn't carry the tag onto an indexable one.
    if (input.noindex) this.meta.updateTag({ name: 'robots', content: 'noindex' });
    else this.meta.removeTag('name="robots"');

    const ogType = ogTypeForKind(input.entity);
    const tags = buildOgTags({
      title,
      description,
      url: canonical,
      type: ogType,
      image: input.ogImage ?? DEFAULT_OG_IMAGE,
    });
    for (const tag of tags) this.meta.updateTag(tag);
  }

  /**
   * Meta for a "not found" response on a detail route. Sets a noindex robots
   * meta so the panel-bodied 404 never gets indexed (the inline panel is a
   * stopgap until AECI-62 lands the global 404 shell — even then, the panel's
   * URL is the entity URL the visitor typed, so we want crawlers to skip).
   * Title and description are deliberately generic — we know the slug missed
   * but not what the visitor meant.
   *
   * Spec anchors: Stage 1 Spec §9.1b ("Pinned 404 trap" — never index a 404)
   * and §20.7 (404 page noindex). Pairs with `RESPONSE_INIT.status = 404`
   * set by the resolver so the runtime emits a real HTTP 404 with
   * `NOT_FOUND_TTL`.
   */
  setNotFoundMeta(input: { kind: EntityKind; slug: string; canonical: string }): void {
    const title = $localize`:@@meta.notFoundTitle:Not found · AEC Integrations`;
    const description = $localize`:@@meta.notFoundDescription:The page you were looking for could not be found.`;

    this.title.setTitle(title);
    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({ name: 'robots', content: 'noindex' });
    this.upsertCanonical(stripQueryParams(input.canonical));

    // Belt-and-braces: if a prior render path on the same Worker instance set
    // a product/vendor JSON-LD, remove it so the 404 doesn't ship stale
    // structured data. JSON-LD script elements use the `data-aeci-jsonld`
    // attribute set by `upsertJsonLdScript` (line 100).
    const head = this.document.head;
    for (const script of head.querySelectorAll(
      'script[type="application/ld+json"][data-aeci-jsonld]',
    )) {
      script.remove();
    }
  }

  /**
   * Meta for the `/search` results page (AECI-142 / §4.6). Search-results pages
   * aren't canonical content, so they carry `robots: noindex` — same noindex
   * treatment as a 404, but with a real (200) page. Title/description are
   * generic (the page has no entity); canonical self-references `/search`
   * (query-stripped, so `?q=…` variants don't fork the canonical). Set from the
   * component constructor so the noindex ships in the SSR HTML head AND is
   * refreshed on an in-app client navigation onto `/search`.
   *
   * Mirrors `setNotFoundMeta`'s stale-JSON-LD cleanup so navigating from a
   * product/vendor detail page into search doesn't leave structured data behind.
   */
  setSearchMeta(input: { canonical: string }): void {
    const title = $localize`:@@meta.searchTitle:Search · AEC Integrations`;
    const description = $localize`:@@meta.searchDescription:Search the AEC software integration directory by product, vendor, or integration.`;

    this.title.setTitle(title);
    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({ name: 'robots', content: 'noindex' });
    this.upsertCanonical(stripQueryParams(input.canonical));

    const head = this.document.head;
    for (const script of head.querySelectorAll(
      'script[type="application/ld+json"][data-aeci-jsonld]',
    )) {
      script.remove();
    }
  }

  /**
   * Meta + structured data for the home page (`/`, AECI-186 / §20.3–§20.6).
   * Unlike the entity pages, the home `<title>` and description are STATIC (they
   * don't depend on fetched data), so this is set from the `Home` component
   * constructor — like `setSearchMeta` — and the stats resolver stays narrow.
   * Home is indexable, so no `robots` tag is set (cf. `setNotFoundMeta` /
   * `setSearchMeta`, which both noindex).
   *
   * OG/Twitter point at the dedicated 1200×630 home share card (`HOME_OG_IMAGE`,
   * AECI-276) — an absolute URL, with an `og:image:alt` / `twitter:image:alt`
   * pair — not the fallback monogram.
   *
   * Emits, beyond `<title>` + description + canonical + OG/Twitter
   * (`og:type=website`), the two home-specific JSON-LD items not covered by
   * AECI-51's product/vendor structured data: the §20.3 `WebSite` (with a
   * `SearchAction` for Google's sitelinks search box) and a publisher
   * `Organization` (whose `logo` stays the square monogram, not the share card).
   * Both are derived from the serving origin so they follow the self-referential
   * canonical (ADR 0011). No `aggregateRating`/`Review` LD: nothing is verified
   * and the launch corpus is not an honest basis for star ratings (§20.3). Stale
   * detail JSON-LD from a prior in-app navigation is left untouched — like
   * `setProductJsonLd` / `setVendorJsonLd`, which only upsert their own kind;
   * each SSR render (the SEO-relevant path) is a fresh per-URL app, so it never
   * ships cross-page LD.
   */
  setHomeMeta(input: { canonical: string }): void {
    const title = $localize`:@@meta.homeTitle:AEC Integrations: the independent directory of AEC software integrations`;
    const description = $localize`:@@meta.homeDescription:The independent directory of AEC software integrations. No vendor marketing, no pay-for-placement.`;

    this.title.setTitle(title);
    this.meta.updateTag({ name: 'description', content: description });

    const canonical = stripQueryParams(input.canonical);
    this.upsertCanonical(canonical);

    const origin = originOf(canonical);
    // The home is the highest-value share surface (the Stage 1 success metric is
    // "buyers send the link to colleagues"), so its og:image is the dedicated
    // 1200×630 card emitted as an ABSOLUTE URL — older LinkedIn/Slack scrapers are
    // the ones the DEFAULT_OG_IMAGE comment flags as flaky with relative paths.
    // Entity pages deliberately stay relative (they have no `origin` in hand).
    const ogImage = `${origin}${HOME_OG_IMAGE}`;
    const ogImageAlt = $localize`:@@meta.homeOgImageAlt:AEC Integrations: the independent directory of AEC software integrations.`;
    const tags = buildOgTags({
      title,
      description,
      url: canonical,
      type: 'website',
      image: ogImage,
    });
    for (const tag of tags) this.meta.updateTag(tag);
    // `buildOgTags` covers the 9 shared tags; the image-alt pair is home-only, so
    // set it here rather than widening the helper (and perturbing entity callers).
    this.meta.updateTag({ property: 'og:image:alt', content: ogImageAlt });
    this.meta.updateTag({ name: 'twitter:image:alt', content: ogImageAlt });

    this.upsertJsonLdScript('website', buildWebSiteJsonLd({ origin, name: SITE_NAME }));
    this.upsertJsonLdScript(
      'organization',
      buildSiteOrganizationLd({ origin, name: SITE_NAME, logo: `${origin}${DEFAULT_OG_IMAGE}` }),
    );
  }

  /**
   * Meta for a static content page with hand-authored copy — `/about`
   * (AECI-238) and the `/legal/*` pages (Phase 7.2). Like `setHomeMeta`
   * but WITHOUT the WebSite/Organization JSON-LD: sets `<title>`, description, a
   * self-referential canonical, and OG/Twitter tags (`og:type=website`). The caller
   * passes the full title (e.g. `"About · AEC Integrations"`), mirroring
   * `setSearchMeta` / `setHomeMeta`. Set from the component constructor so it ships
   * in the SSR HTML head AND refreshes on an in-app navigation onto the route.
   *
   * `noindex: true` adds a `robots: noindex` tag for transactional pages that must
   * not be indexed — e.g. the tokenized `/unsubscribe` page (AECI-537), whose URL
   * carries a per-subscriber token (contrast `/about` / `/legal`, which stay
   * indexable). Default is indexable (no `robots` tag), matching `setHomeMeta`.
   */
  setStaticPageMeta(input: {
    title: string;
    description: string;
    canonical: string;
    noindex?: boolean;
  }): void {
    this.title.setTitle(input.title);
    this.meta.updateTag({ name: 'description', content: input.description });

    // Indexable by default; noindex only when the caller opts in (e.g. the
    // tokenized `/unsubscribe` page). Clear the tag otherwise so a client nav off
    // a noindexed page onto an indexable one (`/about`, `/legal/*`) doesn't carry
    // the stale tag — same guard as `setEntityMeta`.
    if (input.noindex) this.meta.updateTag({ name: 'robots', content: 'noindex' });
    else this.meta.removeTag('name="robots"');

    const canonical = stripQueryParams(input.canonical);
    this.upsertCanonical(canonical);

    const tags = buildOgTags({
      title: input.title,
      description: input.description,
      url: canonical,
      type: 'website',
      image: DEFAULT_OG_IMAGE,
    });
    for (const tag of tags) this.meta.updateTag(tag);
  }

  setProductJsonLd(product: ProductDetail): void {
    this.upsertJsonLdScript('product', buildProductJsonLd(product));
  }

  setVendorJsonLd(vendor: VendorDetail): void {
    this.upsertJsonLdScript('vendor', buildVendorJsonLd(vendor));
  }

  private upsertCanonical(href: string): void {
    const head = this.document.head;
    let link = head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      head.appendChild(link);
    }
    link.setAttribute('href', href);
  }

  private upsertJsonLdScript(
    kind: 'product' | 'vendor' | 'website' | 'organization',
    payload: object,
  ): void {
    const head = this.document.head;
    const selector = `script[type="application/ld+json"][data-aeci-jsonld="${kind}"]`;
    let script = head.querySelector(selector) as HTMLScriptElement | null;
    if (!script) {
      script = this.document.createElement('script');
      script.setAttribute('type', 'application/ld+json');
      script.setAttribute('data-aeci-jsonld', kind);
      head.appendChild(script);
    }
    // Escape `</script>` sequences so SSR HTML serialization can't break out of
    // this script element. `<\/` is valid JSON and schema.org parsers accept it.
    script.textContent = JSON.stringify(payload).replace(/<\/script>/gi, '<\\/script>');
  }
}
