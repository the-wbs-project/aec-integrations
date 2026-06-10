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
