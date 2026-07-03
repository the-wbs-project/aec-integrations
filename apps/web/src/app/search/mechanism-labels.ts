/**
 * Shared, localized labels for integration `mechanism_kind` / `direction`
 * enums. Lifted out of `integrations/integration-card.ts` (AECI-142) so the
 * `/search` integration hit card and the `/integrations` table row render from
 * ONE `$localize` id set — the labels (and their `@@integrations.mechanism.*` /
 * `@@integrations.direction.*` ids) can't drift between the two surfaces.
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
import {
  integrationDirectionForContext,
  type ContextDirection,
  type IntegrationDirection,
} from '@aeci/shared';

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
    default:
      return '';
  }
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
 * A `direction` label rendered *relative to the page's context product*, for the
 * product-detail integrations table. The stored `source → target` flow is
 * re-framed to whichever endpoint is the page we're on (`STAGE_1_5_SPEC.md`
 * §3.2) — **outbound** when the context product is the row's `source` (data
 * leaves it), **inbound** when it's the `target`, **both** for bidirectional.
 *
 * The frame translation itself is NOT re-derived here: it delegates to the
 * canonical, spec-mandated `integrationDirectionForContext()` in
 * `@aeci/shared` (`integration-context.ts`), which the spec requires be the
 * single home for both the mechanism- and claim-level translations. This helper
 * only adds the presentation layer the shared module can't (it is `$localize`-
 * free): the localized `label` and a decorative arrow `glyph`, keyed off the
 * shared `outbound`/`inbound`/`both` token. A null/unknown direction yields an
 * empty `token`, which the caller renders as its em-dash empty state.
 */
export type ContextDirectionLabel = {
  /** Visible label, or `''` when the direction is absent/unknown. */
  label: string;
  /** Decorative arrow glyph (`aria-hidden`), or `''` when absent. */
  glyph: string;
  /** Shared context-relative token, or `null` when absent/unknown. */
  token: ContextDirection | null;
};

/** Context-relative direction for the product-detail table. See `ContextDirectionLabel`. */
export function contextDirectionLabel(
  direction: IntegrationDirection | null | undefined,
  isSource: boolean,
): ContextDirectionLabel {
  switch (integrationDirectionForContext(direction ?? null, isSource)) {
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
