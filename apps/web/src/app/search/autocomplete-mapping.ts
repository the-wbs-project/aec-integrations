/**
 * Pure view-model mappers for the header autocomplete (AECI-144 / Phase 3.11).
 *
 * The autocomplete dropdown suggests **products + vendors** (not integrations —
 * §4.1 hero / §7.5). These functions turn the denormalized Algolia records
 * (`@aeci/shared/algolia-records`) into a flat, render-ready `AutocompleteSuggestion`
 * so the row template stays trivial and the mapping is unit-testable WITHOUT
 * Angular or the Algolia SDK (plain-Vitest `.spec.ts`). The factory
 * (`autocomplete-search.factory.ts`) calls these at the impure boundary; the
 * component never touches a raw record.
 */
import type { AlgoliaProductRecord, AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

/** A single render-ready autocomplete row (product or vendor). */
export interface AutocompleteSuggestion {
  readonly kind: 'product' | 'vendor';
  /** Stable Algolia `objectID` — `@for` track key + DOM option id seed. */
  readonly objectID: string;
  /** Primary line: product name / vendor company name. */
  readonly title: string;
  /** Secondary line: a product's vendor name; vendors have none (`null`). */
  readonly subtitle: string | null;
  /** Router target for the detail page the parent navigates to on select. */
  readonly routerLink: readonly string[];
}

/** The two suggestion lists from one batched products+vendors query. */
export interface AutocompleteResult {
  readonly products: readonly AutocompleteSuggestion[];
  readonly vendors: readonly AutocompleteSuggestion[];
  /**
   * Total matches across both indices (`results[0].nbHits + results[1].nbHits`),
   * NOT the capped suggestion count — drives the AECI-174 `results_bucket`.
   * Optional so the structural seam/tests can omit it.
   */
  readonly nbHits?: number;
}

/** The structural search seam the controller is given — see the factory. */
export type AutocompleteSearchFn = (query: string) => Promise<AutocompleteResult>;

/** Map a `products`-index hit to a suggestion → `/products/:slug`. */
export function productToSuggestion(record: AlgoliaProductRecord): AutocompleteSuggestion {
  return {
    kind: 'product',
    objectID: record.objectID,
    title: record.name,
    subtitle: record.vendor_name,
    routerLink: ['/products', record.slug],
  };
}

/** Map a `vendors`-index hit to a suggestion → `/vendors/:slug`. */
export function vendorToSuggestion(record: AlgoliaVendorRecord): AutocompleteSuggestion {
  return {
    kind: 'vendor',
    objectID: record.objectID,
    title: record.company_name,
    subtitle: null,
    routerLink: ['/vendors', record.slug],
  };
}

/**
 * Combine the two positional hit slices of a batched `searchForHits` call
 * (`results[0]` = products, `results[1]` = vendors) into the suggestion lists.
 * Takes plain record arrays (not the Algolia response wrapper) so it stays free
 * of SDK types and trivially unit-testable.
 */
export function mapAutocompleteResults(
  productHits: readonly AlgoliaProductRecord[],
  vendorHits: readonly AlgoliaVendorRecord[],
  /** Total matches across both indices (AECI-174 `results_bucket`); see type. */
  nbHits?: number,
): AutocompleteResult {
  return {
    products: productHits.map(productToSuggestion),
    vendors: vendorHits.map(vendorToSuggestion),
    nbHits,
  };
}
