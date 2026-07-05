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
