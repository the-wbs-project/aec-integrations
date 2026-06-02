import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';

import type { ProductDetail, VendorDetail } from '@aeci/shared';

import {
  DEFAULT_OG_IMAGE,
  type EntityKind,
  buildEntityTitle,
  buildOgTags,
  buildProductJsonLd,
  buildVendorJsonLd,
  isBrowseKind,
  ogTypeForKind,
  stripQueryParams,
  truncateAtWordBoundary,
} from './meta.helpers';

/**
 * Entity kinds the service knows how to title. Defined once in `meta.helpers.ts`
 * and re-exported here so the service's public surface is unchanged.
 *
 * - Detail kinds (`product`, `vendor`, `integration`) get the bare
 *   `"{name} — AEC Integrations"` title and `og:type=article`.
 * - Browse kinds (`category`, `discipline`, `phase`) get the
 *   `"{name} tools — AEC Integrations"` variant and `og:type=website`
 *   (per Phase 2 Spec §9.1).
 * - `index` (used by `/products`, `/vendors`, `/integrations`) gets the bare
 *   `"{name} — AEC Integrations"` title (no "tools" infix) and
 *   `og:type=website` — an index is not an article.
 */
export type { EntityKind };

export interface SetEntityMetaInput {
  entity: EntityKind;
  name: string;
  description: string | null | undefined;
  canonical: string;
  ogImage?: string;
}

/**
 * Centralized SEO metadata composer for every Phase 2 page. Sets `<title>`,
 * description, canonical link, OG/Twitter tags, and (via `setProductJsonLd` /
 * `setVendorJsonLd`) JSON-LD script tags. Runs in the SSR Worker so all tags
 * ship in the initial HTML — `Title`, `Meta`, and `DOCUMENT` all work under
 * `@angular/ssr` without `isPlatformBrowser` guards.
 *
 * Spec anchor: docs/STAGE_1_PHASE_2_SPEC.md §9.
 */
@Injectable({ providedIn: 'root' })
export class MetaService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);

  setEntityMeta(input: SetEntityMetaInput): void {
    const suffix = isBrowseKind(input.entity)
      ? $localize`:@@meta.browseTitleSuffix: tools — AEC Integrations`
      : $localize`:@@meta.titleSuffix: — AEC Integrations`;

    const title = buildEntityTitle(input.name, suffix);
    this.title.setTitle(title);

    const fallback = $localize`:@@meta.defaultDescription:Software integration directory for the AEC industry.`;
    const description = truncateAtWordBoundary(input.description) || fallback;
    this.meta.updateTag({ name: 'description', content: description });

    const canonical = stripQueryParams(input.canonical);
    this.upsertCanonical(canonical);

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
    const title = $localize`:@@meta.notFoundTitle:Not found — AEC Integrations`;
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

  private upsertJsonLdScript(kind: 'product' | 'vendor', payload: object): void {
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
