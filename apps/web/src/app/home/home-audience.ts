/**
 * `aec-home-audience` — the home audience "this is for you" recognition treatment
 * (§4.1 section 7, the AECI-269 build child 5). It REPLACES the generic
 * `<app-browse-grid kind="audience">` instance at the audience position so the
 * home has **one** coherent audience moment, not two (the AECI-274 non-negotiable):
 * the category + phase browse grids keep using `browse-grid.ts`; the audience
 * facet becomes recognition.
 *
 * The job (§4.1, AECI-269): the directory home's old audience moment was a
 * count-chip grid — navigation, not recognition. This band carries the legacy
 * landing's "Who this is for" section (ten role callouts + a light use-case line)
 * so a buyer **sees themselves on the page**. The copy is **translated**, not
 * pasted, from `apps/landing/public/index.html` into the editorial / anti-vendor
 * voice (`PRODUCT.md`): sentence case, no banned words, no em dashes.
 *
 * Roles map to the AECI-121 audience taxonomy where a term exists: each maps to a
 * `/audiences/:slug` browse page via the shipped `TaxonomyBadge` (Forest hover,
 * the count-chip vocabulary — live `product_count` when > 0, suppressed otherwise).
 * Roles with **no** good taxonomy term (Technology directors) render as plain,
 * non-interactive recognition text, never a dead link (the §4.1 / AC rule). The
 * audience vocabulary is fixed (AECI-121); this issue adds no new terms.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch and no per-visitor state: the
 * curated role list is static, and the only dynamic input is the already-resolved
 * live taxonomy (`GET /api/taxonomy`, the same payload the browse grids read),
 * used solely to look up counts. The band renders into the cacheable,
 * visitor-state-neutral home HTML (`Cache-Tag: route:index,taxonomy`,
 * `s-maxage=900`), identical for every visitor.
 *
 * Treatment per `DESIGN.md` (AECI-270 concept **b · warm commerce**): an eyebrow
 * with a small decorative **Clay** dot (`--accent-secondary`, fill only,
 * `aria-hidden`, well under the ≤5% cap, matching `home-why.ts`); the use-case lede
 * + role chips sit in a rounded **Bone** callout (`--accent-warm`, border not
 * shadow, never a page background); **Forest** (`--accent-primary`) is the only
 * link color (Forest-Anchor Rule). Borders not shadows. Light theme only (Stage 1).
 * The hero owns the page `<h1>`; this band's headline is the section `<h2>`, so the
 * heading order stays valid and axe-clean. Anchor site: Faire (AECI-270).
 */
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * One curated recognition role. `slug` is the AECI-121 audience term it maps to
 * (`/audiences/:slug`), or `null` when no good term exists — those render as plain
 * recognition text, not a link.
 */
interface AudienceRole {
  readonly id: string;
  readonly label: string;
  readonly slug: string | null;
}

/** A role joined with its live count (present only when > 0, so the chip never shows a bare "0"). */
interface AudienceRoleRow extends AudienceRole {
  readonly count: number | undefined;
}

@Component({
  selector: 'aec-home-audience',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, TaxonomyBadge],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="home-audience-heading">
      <p class="aec-overline inline-flex items-center gap-2 text-(--text-secondary)">
        <span
          class="inline-block h-2 w-2 rounded-full bg-(--accent-secondary)"
          aria-hidden="true"
        ></span>
        <span i18n="@@home.audience.eyebrow">Who it's for</span>
      </p>

      <div class="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id="home-audience-heading"
          class="font-display text-xl font-semibold tracking-tight text-(--text-primary)"
          i18n="@@home.audience.heading"
        >
          Built for the people who choose and use AEC software
        </h2>
        <a
          [routerLink]="['/audiences']"
          class="rounded-sm text-sm text-(--text-secondary) underline decoration-(--border-strong)
            underline-offset-4 transition-colors hover:text-(--text-primary)
            focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          i18n="@@home.audience.viewAll"
        >
          View all audiences
        </a>
      </div>

      <div
        class="mt-4 rounded-(--radius-lg) border border-(--border-default) bg-(--accent-warm) p-6 md:p-8"
      >
        <p
          class="max-w-2xl text-base leading-relaxed text-(--text-secondary)"
          i18n="@@home.audience.lede"
        >
          Whether you're comparing three to five tools in a category or justifying a decision to a
          steering committee, start from your role.
        </p>

        <ul class="mt-5 flex flex-wrap gap-2">
          @for (row of rows(); track row.id) {
            <li>
              @if (row.slug) {
                <aec-taxonomy-badge
                  kind="audience"
                  [slug]="row.slug"
                  [name]="row.label"
                  [count]="row.count"
                />
              } @else {
                <span
                  class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
                    bg-(--surface-base) px-3 py-1 text-[0.8125rem] font-medium tracking-[0.01em]
                    text-(--text-secondary)"
                  >{{ row.label }}</span
                >
              }
            </li>
          }
        </ul>
      </div>
    </section>
  `,
})
export class HomeAudience {
  /**
   * The live aggregate audience taxonomy (`TaxonomyResponse.audiences`), passed
   * from the home page's already-resolved `browse` data. Used only to look up a
   * mapped role's `product_count`; defaults to `[]` so a null resolver result (a
   * render mode without `REQUEST_CONTEXT`, or a failed client fetch) still renders
   * every role — links resolve from the permanent slugs, just without counts.
   */
  readonly audiences = input<readonly TaxonomyTermWithCount[]>([]);

  /**
   * The curated recognition roles, in the landing's editorial order. `slug` maps
   * to an AECI-121 audience term where one fits; `null` is a deliberate
   * non-mapping role rendered as plain recognition text (no good term exists).
   * Authored with `$localize` so the strings stay i18n-extractable in one place.
   */
  private readonly roles: readonly AudienceRole[] = [
    {
      id: 'architects',
      label: $localize`:@@home.audience.role.architects:Architects`,
      slug: 'architecture',
    },
    {
      id: 'structural-engineers',
      label: $localize`:@@home.audience.role.structuralEngineers:Structural engineers`,
      slug: 'structural-engineering',
    },
    {
      id: 'mep-engineers',
      label: $localize`:@@home.audience.role.mepEngineers:MEP engineers`,
      slug: 'mep-engineering',
    },
    {
      id: 'general-contractors',
      label: $localize`:@@home.audience.role.generalContractors:General contractors`,
      slug: 'general-contracting',
    },
    {
      id: 'estimators',
      label: $localize`:@@home.audience.role.estimators:Estimators`,
      slug: 'estimator',
    },
    {
      id: 'project-managers',
      label: $localize`:@@home.audience.role.projectManagers:Project managers`,
      slug: 'project-manager',
    },
    {
      id: 'owners-developers',
      label: $localize`:@@home.audience.role.ownersDevelopers:Owners & developers`,
      slug: 'owner-developer',
    },
    {
      id: 'subcontractors',
      label: $localize`:@@home.audience.role.subcontractors:Subcontractors`,
      slug: 'specialty-contracting',
    },
    {
      id: 'facilities-managers',
      label: $localize`:@@home.audience.role.facilitiesManagers:Facilities managers`,
      slug: 'facilities-management',
    },
    {
      // No good audience term: "Technology directors" is a buyer persona, not the
      // IT/systems-administration domain — render as plain recognition text.
      id: 'technology-directors',
      label: $localize`:@@home.audience.role.technologyDirectors:Technology directors`,
      slug: null,
    },
  ];

  /**
   * The roles joined with their live `product_count`. Only counts > 0 are carried
   * through, so a 0-count or not-yet-indexed term renders a clean name-only chip
   * (the §4.1 thin-corpus rule — never a bare "0").
   */
  protected readonly rows = computed<AudienceRoleRow[]>(() => {
    const counts = new Map<string, number>();
    for (const term of this.audiences()) {
      if (term.product_count > 0) counts.set(term.slug, term.product_count);
    }
    return this.roles.map((role) => ({
      ...role,
      count: role.slug ? counts.get(role.slug) : undefined,
    }));
  });
}
