/**
 * Shared, localized labels for integration `mechanism_kind` / `direction`
 * enums. Lifted out of the since-deleted `integrations/integration-card.ts`
 * (AECI-142) so every surface that names a mechanism renders from ONE
 * `$localize` id set — the labels (and their `@@integrations.mechanism.*` /
 * `@@integrations.direction.*` ids) can't drift apart. The `/integrations`
 * table that motivated the extraction is gone (AECI-165); the surviving
 * consumers are the `/search` integration hit card and the home
 * `IntegrationTile`.
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

/** Localized label for an integration `direction`, or `''` when absent/unknown. */
export function directionLabel(direction: string | null | undefined): string {
  switch (direction) {
    case 'one-way':
      return $localize`:@@integrations.direction.oneWay:One-way`;
    case 'bidirectional':
      return $localize`:@@integrations.direction.bidirectional:Bidirectional`;
    default:
      return '';
  }
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

/** Presentation for a precomputed context-relative direction. See `ContextDirectionLabel`. */
export function contextDirectionLabel(direction: ContextDirection | null): ContextDirectionLabel {
  switch (direction) {
    case 'outbound':
      return {
        label: $localize`:@@integrations.direction.outbound:Outbound`,
        glyph: '→',
        token: 'outbound',
      };
    case 'inbound':
      return {
        label: $localize`:@@integrations.direction.inbound:Inbound`,
        glyph: '←',
        token: 'inbound',
      };
    case 'both':
      return { label: $localize`:@@integrations.direction.both:Both`, glyph: '⇄', token: 'both' };
    default:
      return { label: '', glyph: '', token: null };
  }
}
