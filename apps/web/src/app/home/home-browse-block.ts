import { Component, computed, input } from '@angular/core';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { BrowseGrid, type BrowseChipTerm } from './browse-grid';

/**
 * `aec-home-browse-block`: the home page's one browse section. An `<h2>` "Browse
 * the directory" over four labelled chip rows, each a `BrowseGrid`:
 *
 *   1. Category: the top N by `product_count` (the caller slices).
 *   2. Trade: the top N published trades by `product_count` (the caller drops
 *      trades below the `TRADE_PUBLISH_MIN_PRODUCTS` floor, then slices).
 *   3. Project phase: every phase in `display_order`.
 *   4. Audience: a curated role list in editorial order, with a one-sentence
 *      lede. Each role maps to an AECI-121 audience term and links to
 *      `/audiences/:slug`. A role with no taxonomy term is not listed.
 *
 * Every row uses the same `TaxonomyBadge` count-chip. Counts come from the live
 * aggregate taxonomy (`GET /api/taxonomy`, resolved SSR-side by
 * `homeBrowseResolver`), so the block purges on the `taxonomy` Cache-Tag. It reads
 * no visitor state and renders identically for every visitor. The hero owns the
 * page `<h1>`, this block owns an `<h2>`, and each row label is an `<h3>`.
 */

/** One curated audience role: the label shown and the audience term it links to. */
interface AudienceRole {
  readonly label: string;
  readonly slug: string;
}

@Component({
  selector: 'aec-home-browse-block',
  imports: [BrowseGrid],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="home-browse-heading">
      <h2
        id="home-browse-heading"
        class="font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
        i18n="@@home.browse.heading"
      >
        Browse the directory
      </h2>

      <div class="mt-8">
        <app-browse-grid kind="category" [terms]="categories()" />
        <app-browse-grid kind="trade" [terms]="trades()" />
        <app-browse-grid kind="phase" [terms]="phases()" />
        <app-browse-grid kind="audience" [terms]="audienceChips()">
          <p
            class="mb-4 max-w-2xl text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@home.audience.lede"
          >
            Whether you're comparing three to five tools in a category or justifying a decision to a
            steering committee, start from your role.
          </p>
        </app-browse-grid>
      </div>
    </section>
  `,
})
export class HomeBrowseBlock {
  /** Category terms, already ranked and sliced to the top N by the caller. */
  readonly categories = input<readonly TaxonomyTermWithCount[]>([]);
  /** Published trade terms, already ranked and sliced to the top N by the caller. */
  readonly trades = input<readonly TaxonomyTermWithCount[]>([]);
  /** Phase terms, already in `display_order`. */
  readonly phases = input<readonly TaxonomyTermWithCount[]>([]);
  /**
   * The full live audience vocabulary. Used only to look up each curated role's
   * `product_count`. Defaults to `[]`, so a null resolver result still renders
   * every role: links resolve from the permanent slugs, just without counts.
   */
  readonly audiences = input<readonly TaxonomyTermWithCount[]>([]);

  /**
   * The curated roles, in editorial order. Each maps to an AECI-121 audience term.
   * Authored with `$localize` so the strings stay i18n-extractable in one place.
   */
  private readonly roles: readonly AudienceRole[] = [
    { label: $localize`:@@home.audience.role.architects:Architects`, slug: 'architecture' },
    {
      label: $localize`:@@home.audience.role.structuralEngineers:Structural engineers`,
      slug: 'structural-engineering',
    },
    {
      label: $localize`:@@home.audience.role.mepEngineers:MEP engineers`,
      slug: 'mep-engineering',
    },
    {
      label: $localize`:@@home.audience.role.generalContractors:General contractors`,
      slug: 'general-contracting',
    },
    { label: $localize`:@@home.audience.role.estimators:Estimators`, slug: 'estimator' },
    {
      label: $localize`:@@home.audience.role.projectManagers:Project managers`,
      slug: 'project-manager',
    },
    {
      label: $localize`:@@home.audience.role.ownersDevelopers:Owners & developers`,
      slug: 'owner-developer',
    },
    {
      label: $localize`:@@home.audience.role.subcontractors:Subcontractors`,
      slug: 'specialty-contracting',
    },
    {
      label: $localize`:@@home.audience.role.facilitiesManagers:Facilities managers`,
      slug: 'facilities-management',
    },
  ];

  /** The curated roles joined with their live count (`0` when the term is absent). */
  protected readonly audienceChips = computed<BrowseChipTerm[]>(() => {
    const counts = new Map<string, number>();
    for (const term of this.audiences()) counts.set(term.slug, term.product_count);
    return this.roles.map((role) => ({
      slug: role.slug,
      name: role.label,
      product_count: counts.get(role.slug) ?? 0,
    }));
  });
}
