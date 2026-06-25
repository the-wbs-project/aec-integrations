/**
 * Shared structural cases for the product / vendor / integration Zod-schema
 * specs (AECI-113). The three specs' field-level validations genuinely differ
 * (each entity has its own columns), but a handful of cases are structurally
 * identical because every list schema composes the same `PageQuerySchema`
 * (`common.ts`) and the same `*ListResponseSchema` wrapper:
 *
 *   - SortSchema: defaults to `<sortDefault>`, rejects unknown keys
 *   - ListQuerySchema: applies page=1 / perPage=24 / sort defaults, rejects perPage > 100
 *   - ListResponseSchema: wraps a page of list items
 *
 * Those live here once; every entity-specific field validation stays explicit
 * in its own spec. Test helper, not a spec — `*.harness.ts` so no runner
 * collects it and coverage excludes it (`vitest.config.ts`).
 */
import { describe, expect, it } from 'vitest';

interface ParseableSchema {
  parse(input: unknown): unknown;
  safeParse(input: unknown): { success: boolean };
}

export interface SchemaSuiteScenario {
  /** Entity label for the describe block, e.g. `products`. */
  entity: string;
  sortSchema: ParseableSchema;
  /** Default sort value, e.g. `created` | `name`. */
  sortDefault: string;
  listQuerySchema: ParseableSchema;
  listResponseSchema: ParseableSchema;
  /** A valid list item to wrap in the response-schema case. */
  validListItem: unknown;
}

/** Registers the structural schema cases shared across all three entities. */
export function registerSchemaStructuralCases(s: SchemaSuiteScenario): void {
  describe(`${s.entity} — shared schema contract`, () => {
    describe('SortSchema', () => {
      it(`defaults to ${s.sortDefault}`, () => {
        expect(s.sortSchema.parse(undefined)).toBe(s.sortDefault);
      });

      it('rejects unknown keys', () => {
        // A value that is not a valid sort for ANY entity (products added
        // `rating`/`reviews`, so the prior `'rating'` sample is now valid there).
        expect(s.sortSchema.safeParse('not-a-real-sort').success).toBe(false);
      });
    });

    describe('ListQuerySchema', () => {
      it('applies pagination + sort defaults when called with empty params', () => {
        const parsed = s.listQuerySchema.parse({}) as {
          page: number;
          perPage: number;
          sort: string;
        };
        expect(parsed.page).toBe(1);
        expect(parsed.perPage).toBe(24);
        expect(parsed.sort).toBe(s.sortDefault);
      });

      it('rejects perPage > 100', () => {
        expect(s.listQuerySchema.safeParse({ perPage: 200 }).success).toBe(false);
      });
    });

    describe('ListResponseSchema', () => {
      it('wraps a page of list items', () => {
        const parsed = s.listResponseSchema.parse({
          data: [s.validListItem],
          page: 1,
          perPage: 24,
          total: 1,
        }) as { data: unknown[] };
        expect(parsed.data).toHaveLength(1);
      });
    });
  });
}
