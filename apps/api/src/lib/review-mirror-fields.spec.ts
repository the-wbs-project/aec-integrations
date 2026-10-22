/**
 * Parity for the review-app mirror's field map (AECI-1413, ADR 0044).
 *
 * The map in `review-mirror-fields.ts` is the only thing that decides which live
 * column reaches the review app. These tests make every schema it sits between fail
 * loudly when it moves: the vendor-input bodies on one side, the promote wire and the
 * shared v2 content schemas on the other, and the Drizzle tables underneath.
 */

import { getTableColumns, type Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  CreateVendorClaimSchema,
  CreateVendorIntegrationSchema,
  OwnershipClaimSchema,
  OwnershipIntegrationContentSchema,
  OwnershipProductContentSchema,
  OwnershipVendorContentSchema,
  PromoteAttestationSchema,
  PromoteClaimSchema,
  PromoteIntegrationSchema,
  PromoteProductSchema,
  PromoteVendorSchema,
  UpdateVendorIntegrationSchema,
  UpdateVendorProductSchema,
  UpdateVendorProfileSchema,
  UpsertVendorAttestationSchema,
} from '@aeci/shared';

import {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrations,
  products,
  vendors,
} from '../db/schema';
import {
  LIVE_ONLY_FIELDS,
  MIRROR_ENTITIES,
  REVIEW_MIRROR_FIELDS,
  VENDOR_INPUTS_NOT_MIRRORED,
  projectRow,
  type MirrorEntity,
} from './review-mirror-fields';

const keys = (schema: { shape: object }) => Object.keys(schema.shape);

/** The live tables each entity's direct columns come from. */
const TABLES: Record<MirrorEntity, readonly Table[]> = {
  vendor: [vendors],
  product: [products],
  integration: [integrations],
  connector_evidenced_pair: [connectorEvidencedPairs],
  claim: [claims, attestations],
};

/** The SQL name of a direct column, or `undefined` for a joined value. */
function sqlName(entity: MirrorEntity, column: string): string | undefined {
  for (const table of TABLES[entity]) {
    const col = (getTableColumns(table) as Record<string, { name: string }>)[column];
    if (col) return col.name;
  }
  return undefined;
}

/** Every vendor-input key an entity's map covers. */
function coveredInputs(entity: MirrorEntity): Set<string> {
  const out = new Set<string>();
  for (const field of REVIEW_MIRROR_FIELDS[entity]) {
    const name = sqlName(entity, field.column);
    if (name) out.add(name);
    for (const input of field.inputs ?? []) out.add(input);
  }
  return out;
}

const wires = (entity: MirrorEntity) => REVIEW_MIRROR_FIELDS[entity].map((f) => f.wire);
const liveOnly = (entity: MirrorEntity) =>
  LIVE_ONLY_FIELDS.filter((f) => f.entity === entity).map((f) => f.wire);

/** The promote wire fields each entity's map may name without a live-only entry. */
const PROMOTE_WIRE: Record<MirrorEntity, readonly string[]> = {
  vendor: keys(PromoteVendorSchema),
  product: keys(PromoteProductSchema),
  integration: keys(PromoteIntegrationSchema),
  connector_evidenced_pair: keys(PromoteIntegrationSchema),
  claim: [...keys(PromoteClaimSchema), ...keys(PromoteAttestationSchema)],
};

describe('review mirror field map: vendor inputs (AECI-1413)', () => {
  const cases: [string, { shape: object }, MirrorEntity][] = [
    ['UpdateVendorProfileSchema', UpdateVendorProfileSchema, 'vendor'],
    ['UpdateVendorProductSchema', UpdateVendorProductSchema, 'product'],
    ['UpdateVendorIntegrationSchema', UpdateVendorIntegrationSchema, 'integration'],
    ['CreateVendorIntegrationSchema', CreateVendorIntegrationSchema, 'integration'],
    ['CreateVendorClaimSchema', CreateVendorClaimSchema, 'claim'],
    ['UpsertVendorAttestationSchema', UpsertVendorAttestationSchema, 'claim'],
  ];

  it.each(cases)('maps every key of %s, or says why not', (_name, schema, entity) => {
    const covered = coveredInputs(entity);
    const unmapped = keys(schema).filter(
      (key) => !covered.has(key) && !(key in VENDOR_INPUTS_NOT_MIRRORED),
    );
    expect(unmapped).toEqual([]);
  });

  it('lists no not-mirrored input that a map entry covers or no schema sends', () => {
    const allInputs = new Set(cases.flatMap(([, schema]) => keys(schema)));
    for (const key of Object.keys(VENDOR_INPUTS_NOT_MIRRORED)) {
      expect(allInputs).toContain(key);
      for (const entity of MIRROR_ENTITIES) expect(coveredInputs(entity)).not.toContain(key);
    }
  });
});

describe('review mirror field map: wire names', () => {
  it.each(MIRROR_ENTITIES)('%s names only promote wire fields or live-only ones', (entity) => {
    const allowed = new Set([...PROMOTE_WIRE[entity], ...liveOnly(entity)]);
    expect(wires(entity).filter((w) => !allowed.has(w))).toEqual([]);
  });

  it.each(MIRROR_ENTITIES)('%s lists a live-only field only when promote lacks it', (entity) => {
    for (const wire of liveOnly(entity)) {
      expect(wires(entity)).toContain(wire);
      expect(PROMOTE_WIRE[entity]).not.toContain(wire);
    }
  });

  it('gives every live-only field a one-line reason', () => {
    for (const field of LIVE_ONLY_FIELDS) {
      expect(field.reason.length).toBeGreaterThan(0);
      expect(field.reason).not.toContain('\n');
    }
  });

  it.each(MIRROR_ENTITIES)('%s names each wire field and each column once', (entity) => {
    const fields = REVIEW_MIRROR_FIELDS[entity];
    expect(new Set(fields.map((f) => f.wire)).size).toBe(fields.length);
    expect(new Set(fields.map((f) => f.column)).size).toBe(fields.length);
  });

  it('agrees with the shared v2 content schemas, key for key', () => {
    const sorted = (list: readonly string[]) => [...list].sort();
    expect(sorted(wires('vendor'))).toEqual(sorted(keys(OwnershipVendorContentSchema)));
    expect(sorted(wires('product'))).toEqual(sorted(keys(OwnershipProductContentSchema)));
    expect(sorted(wires('integration'))).toEqual(sorted(keys(OwnershipIntegrationContentSchema)));
    expect(sorted(wires('connector_evidenced_pair'))).toEqual(
      sorted(keys(OwnershipIntegrationContentSchema).filter((k) => k !== 'mechanismKind')),
    );
    expect(sorted(wires('claim'))).toEqual(sorted(keys(OwnershipClaimSchema)));
  });
});

describe('review mirror field map: live columns', () => {
  it.each(MIRROR_ENTITIES)(
    '%s: a field is a real column exactly when it is not joined',
    (entity) => {
      for (const field of REVIEW_MIRROR_FIELDS[entity]) {
        const isColumn = sqlName(entity, field.column) !== undefined;
        expect({ column: field.column, isColumn }).toEqual({
          column: field.column,
          isColumn: field.joined === undefined,
        });
      }
    },
  );

  it('never mirrors a derived, aggregate or timestamp column', () => {
    const banned = [
      'verified',
      'reviewCount',
      'ratingOverallAvg',
      'ratingOnboardingAvg',
      'integrationCount',
      'createdAt',
      'updatedAt',
    ];
    for (const entity of MIRROR_ENTITIES) {
      const columns = REVIEW_MIRROR_FIELDS[entity].map((f) => f.column);
      expect(columns.filter((c) => banned.includes(c))).toEqual([]);
    }
  });
});

describe('projectRow', () => {
  const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const rowFor = (entity: MirrorEntity, values: Record<string, unknown> = {}) =>
    Object.fromEntries(
      REVIEW_MIRROR_FIELDS[entity].map((f) => [f.column, values[f.column] ?? null]),
    );

  it('renames columns to wire fields and sends empty values as null', () => {
    const out = projectRow('vendor', { ...rowFor('vendor'), companyName: 'Acme', xUrl: undefined });
    expect(out.companyName).toBe('Acme');
    expect(out.xUrl).toBeNull();
    expect(Object.keys(out).sort()).toEqual([...wires('vendor')].sort());
  });

  it('wraps a ref field as { supabaseId } and leaves a null ref null', () => {
    const out = projectRow(
      'integration',
      rowFor('integration', { sourceProductId: u(1), targetProductId: u(2) }),
    );
    expect(out.sourceProduct).toEqual({ supabaseId: u(1) });
    expect(out.targetProduct).toEqual({ supabaseId: u(2) });
    expect(out.builtByVendor).toBeNull();
  });

  it('sends a pair A/B as source/target, its connector as poweredBy, and no mechanismKind', () => {
    const out = projectRow(
      'connector_evidenced_pair',
      rowFor('connector_evidenced_pair', {
        productAId: u(1),
        productBId: u(2),
        connectorProductId: u(3),
      }),
    );
    expect(out.sourceProduct).toEqual({ supabaseId: u(1) });
    expect(out.targetProduct).toEqual({ supabaseId: u(2) });
    expect(out.poweredByProduct).toEqual({ supabaseId: u(3) });
    expect('mechanismKind' in out).toBe(false);
  });

  it('projects a product that parses as v2 content once the builder fills the joins', () => {
    const out = projectRow(
      'product',
      rowFor('product', {
        name: 'Acme Plan',
        slug: 'acme-plan',
        productRole: 'application',
        maintainedBy: 'vendor',
        categories: ['scheduling'],
        audiences: [],
        phases: [],
        trades: [],
        versions: [],
      }),
    );
    expect(OwnershipProductContentSchema.safeParse(out).success).toBe(true);
  });

  it('throws when the row lacks a mapped column', () => {
    const { website: _dropped, ...row } = rowFor('vendor');
    expect(() => projectRow('vendor', row)).toThrow(/"website"/);
  });
});
