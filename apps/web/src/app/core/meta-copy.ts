/**
 * `$localize` copy shared by more than one `MetaService` caller.
 *
 * Separate from `meta.helpers.ts`, which is deliberately Angular-free so its
 * Vitest spec can run under plain Node — `$localize` does not exist there.
 * Separate from `meta.service.ts` so a resolver can take the copy without
 * importing the injectable.
 *
 * Spec anchor: docs/STAGE_1_PHASE_2_SPEC.md §9.1.
 */

/**
 * The differentiator sentence appended to a composed entity description when it
 * fits the 155-char budget (AECI-802).
 *
 * **It does not say "vendor-verified", and must not.** `/methodology`
 * (`src/content/methodology.md`) states that AEC Integrations is currently the
 * source of every claim on the site and that readers will see "Unverified ·
 * AECi" throughout, because the vendor portal grants no seats yet
 * (`STAGE_2_5_SPEC.md` §7.1). A SERP snippet claiming verification would
 * contradict our own trust page on every indexed URL. "Compiled and curated" is
 * the phrasing `/methodology` itself uses and the phrasing the code supports.
 *
 * When the first vendor seat is granted this becomes revisable, alongside the
 * other edits §7.1 records as owed at that moment.
 */
export function metaTrustLine(): string {
  return $localize`:@@meta.trustLine:Independent data, compiled and curated by AEC Integrations.`;
}
