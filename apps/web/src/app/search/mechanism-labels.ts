/**
 * Shared, localized labels for integration `mechanism_kind` and context-relative
 * direction. Lifted out of the since-deleted `integrations/integration-card.ts`
 * (AECI-142) so every surface that names a mechanism renders from ONE
 * `$localize` id set — the labels (and their `@@integrations.mechanism.*` ids)
 * can't drift apart. The `/integrations` table that motivated the extraction is
 * gone (AECI-165). The `/search` integration hit card and the product and pair
 * page surfaces consume it now.
 *
 * AECI-1939 removed the context-free `directionLabel()` ("One-way" /
 * "Bidirectional"). Its last caller, the `/search` integration card, now names
 * both products with `pairFlowSentence()` (`products/pair-direction-labels.ts`).
 *
 * Pure functions, not a component or service: `$localize` is a global tagged
 * template available at runtime (SSR + browser + the Angular unit-test
 * pipeline), so these need no Angular DI. Inputs are typed loosely
 * (`string | null | undefined`) because the two callers carry the enum under
 * different shapes — `IntegrationListItem.mechanism_kind` (the API list type)
 * and `AlgoliaIntegrationRecord.mechanism_kind` (the denormalized search
 * record) — both ultimately the §7.1 enum strings. An unknown / null value maps
 * to `''`, which both call sites render as their em-dash empty state.
 *
 * Spec: `STAGE_1_SPEC.md` §7.1 (integration record enums).
 */
import { type ContextDirection } from '@aeci/shared';

import { directionGlyph, directionHeading } from '../products/pair-direction-labels';

/** Localized label for an integration `mechanism_kind`, or `''` when absent/unknown. */
export function mechanismKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'native':
      return $localize`:@@integrations.mechanism.native:Native`;
    case 'iPaaS':
      return $localize`:@@integrations.mechanism.ipaas:iPaaS`;
    case 'marketplace-app':
      return $localize`:@@integrations.mechanism.marketplaceApp:Marketplace app`;
    case 'api':
      return $localize`:@@integrations.mechanism.api:API`;
    case 'webhook':
      return $localize`:@@integrations.mechanism.webhook:Webhook`;
    case 'partner':
      return $localize`:@@integrations.mechanism.partner:Partner`;
    // AECI-698 / AECI-721 added `integrator` to the enum and the DB CHECK, but
    // not here, so a row carrying it rendered the em-dash "Mechanism not listed"
    // — indistinguishable from a null kind. Both `partner` and `integrator` are
    // listed while the review app re-keys; neither is dropped in the meantime.
    case 'integrator':
      return $localize`:@@integrations.mechanism.integrator:Integrator`;
    default:
      return '';
  }
}

/**
 * Heading for one connector group in the endpoint product page's split
 * Integrations section (`STAGE_1_5_SPEC.md` §13.3). Lives beside the other
 * single-sourced mechanism labels rather than inline in the template, so the
 * `$localize` id set for "how is this integration delivered" stays in one file.
 *
 * `null` is §13.2(c)'s unnamed bucket — a connector-delivered edge whose
 * connector has no `products` row to name. It gets a heading that asserts only
 * what the data says; **never** an invented connector name.
 */
export function viaConnectorLabel(connectorName: string | null): string {
  return connectorName === null
    ? $localize`:@@products.detail.integrations.via.unnamed:Via a connector`
    : $localize`:@@products.detail.integrations.via:Via ${connectorName}:CONNECTOR:`;
}

/**
 * Presentation (localized `label` + decorative arrow `glyph`) for a
 * *context-relative* integration direction on the product-detail integrations
 * table (`STAGE_1_5_SPEC.md` §3.2) — **outbound** (data leaves this page's
 * product), **inbound** (data arrives), **both** (bidirectional).
 *
 * The frame translation is done on the SERVER now — `ProductIntegrationItem`
 * carries the already-resolved `context_direction`, made claims-aware via the
 * canonical `effectiveContextDirection()` in `@aeci/shared`
 * (`integration-context.ts`). This helper only turns that token into a
 * `$localize`d label + glyph (the shared module is `$localize`-free). A
 * `null` token (unknown — no claims and no stored direction) yields an empty
 * `token`, which the caller renders as its em-dash empty state.
 */
export type ContextDirectionLabel = {
  /** Visible label, or `''` when the direction is absent/unknown. */
  label: string;
  /** Decorative arrow glyph (`aria-hidden`), or `''` when absent. */
  glyph: string;
  /** Shared context-relative token, or `null` when absent/unknown. */
  token: ContextDirection | null;
};

/**
 * Presentation for a precomputed context-relative direction. See `ContextDirectionLabel`.
 *
 * AECI-1720 restore C: the words are mock-up 6's and the pair page's, through
 * `directionHeading()`, so the card, the table row and the pair page print one
 * wording: `outbound` is "Sends to {partner}", `inbound` is "Receives from {partner}"
 * and `both` is "Syncs both ways". `otherName` is the counterpart product, never this
 * page's. The token is passed through unchanged and never inferred: a `null` direction
 * stays empty, and the caller keeps its own empty state.
 */
export function contextDirectionLabel(
  direction: ContextDirection | null,
  otherName: string,
): ContextDirectionLabel {
  switch (direction) {
    case 'outbound':
    case 'inbound':
    case 'both':
      return {
        label: directionHeading(direction, otherName),
        glyph: directionGlyph(direction),
        token: direction,
      };
    default:
      return { label: '', glyph: '', token: null };
  }
}

/**
 * What "How it connects" prints for one row (AECI-1720 restore C): the kind chips and
 * the mechanism's name, each fact once. A name that only repeats a kind ("Native" under
 * a "Native" chip) is dropped. A name that contains its row's one kind as a whole word
 * ("REST API" for "API", "Native integration" for "Native") is the more specific of
 * the two, so it takes the kind's chip and the kind is not printed. A name that says
 * something the kind does not ("Revu Studio" for "Native") keeps both. A row with
 * several kinds (a collapsed Via row) keeps every chip.
 */
export function mechanismDisplay(
  kindLabels: readonly string[],
  mechanismName: string | null | undefined,
): { readonly labels: readonly string[]; readonly name: string | null } {
  const name = mechanismName?.trim() || null;
  if (!name) return { labels: kindLabels, name: null };
  const lower = name.toLocaleLowerCase();
  if (kindLabels.some((label) => label.toLocaleLowerCase() === lower)) {
    return { labels: kindLabels, name: null };
  }
  if (kindLabels.length === 1 && containsWord(lower, kindLabels[0]!.toLocaleLowerCase())) {
    return { labels: [name], name: null };
  }
  return { labels: kindLabels, name };
}

function containsWord(text: string, word: string): boolean {
  if (!word) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
}

/**
 * The direction filter's chip words (mock-up 6, `#dirSeg`): "{product} sends",
 * "{product} receives" and "Both ways", where `{product}` is this page's product. A
 * chip covers every partner at once, so it names the page's product, not a partner.
 * The filter's "Any direction" chip is the section's own message.
 */
export function directionFilterLabel(direction: ContextDirection, productName: string): string {
  switch (direction) {
    case 'outbound':
      return $localize`:@@products.detail.integrations.filter.direction.outbound:${productName}:PRODUCT: sends`;
    case 'inbound':
      return $localize`:@@products.detail.integrations.filter.direction.inbound:${productName}:PRODUCT: receives`;
    case 'both':
      return $localize`:@@products.detail.integrations.filter.direction.both:Both ways`;
  }
}

/**
 * The depth axis's object-coverage label (AECI-711): "1 type of data" /
 * "N types of data" (reader wording since AECI-1142; the model still calls them
 * data objects), for an integration row and a pair-page mechanism card alike,
 * so the two surfaces cannot word the same count two ways. `''` for `0`, which
 * the caller renders as nothing at all — the 2026-09-22 ruling forbids a
 * "not specified" marker. Singular and plural are separate ids rather than an ICU
 * plural, the pattern the rest of the integrations section uses.
 */
export function dataObjectCountLabel(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? $localize`:@@integrations.dataObjects.one:1 type of data`
    : $localize`:@@integrations.dataObjects.other:${count}:count: types of data`;
}
