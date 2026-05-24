import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';

import type { ProductDetail, VendorDetail } from '@aeci/shared';

import {
  DEFAULT_OG_IMAGE,
  buildEntityTitle,
  buildOgTags,
  buildProductJsonLd,
  buildVendorJsonLd,
  stripQueryParams,
  truncateAtWordBoundary,
} from './meta.helpers';

/**
 * Entity kinds the service knows how to title. Detail kinds get the bare
 * `"{name} — AEC Integrations"` title; browse kinds get the `"… tools — …"`
 * variant per Phase 2 Spec §9.1.
 */
export type EntityKind = 'product' | 'vendor' | 'integration' | 'category' | 'discipline' | 'phase';

export interface SetEntityMetaInput {
  entity: EntityKind;
  name: string;
  description: string | null | undefined;
  canonical: string;
  ogImage?: string;
}

const BROWSE_KINDS: ReadonlySet<EntityKind> = new Set(['category', 'discipline', 'phase']);

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
    const suffix = BROWSE_KINDS.has(input.entity)
      ? $localize`:@@meta.browseTitleSuffix: tools — AEC Integrations`
      : $localize`:@@meta.titleSuffix: — AEC Integrations`;

    const title = buildEntityTitle(input.name, suffix);
    this.title.setTitle(title);

    const fallback = $localize`:@@meta.defaultDescription:Software integration directory for the AEC industry.`;
    const description = truncateAtWordBoundary(input.description) || fallback;
    this.meta.updateTag({ name: 'description', content: description });

    const canonical = stripQueryParams(input.canonical);
    this.upsertCanonical(canonical);

    const ogType = BROWSE_KINDS.has(input.entity) ? 'website' : 'article';
    const tags = buildOgTags({
      title,
      description,
      url: canonical,
      type: ogType,
      image: input.ogImage ?? DEFAULT_OG_IMAGE,
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
