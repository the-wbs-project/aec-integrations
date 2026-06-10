import { vi, type Mock } from 'vitest';

type QueryRawFn = (
  template: TemplateStringsArray | string,
  ...values: unknown[]
) => Promise<unknown>;

export type MockPrisma = {
  $queryRaw: Mock<QueryRawFn>;
};

export function makeMockPrisma(overrides: Partial<{ queryRaw: QueryRawFn }> = {}): MockPrisma {
  const queryRaw = overrides.queryRaw ?? (async () => [{ '?column?': 1 }]);
  return {
    $queryRaw: vi.fn(queryRaw),
  };
}

// ---------------------------------------------------------------------------
// Phase 2.8 (AECI-54) — model-method mock.
// ---------------------------------------------------------------------------
//
// The Phase 2.8 read endpoints call `prisma.<model>.findMany` / `findUnique`
// / `count`. We don't simulate Prisma — each test stubs the specific methods
// it cares about via `vi.fn().mockResolvedValue(...)` and asserts the handler
// shape on the way out.
//
// `makeMockAcceleratedPrisma(overrides)` returns a structurally compatible
// stand-in for `AcceleratedPrisma` (`prisma.ts`). Models default to vi-mocks
// that resolve to empty arrays / null / 0, so unspecified models behave like
// "table is empty" without the test having to declare them. Pass `overrides`
// to inject canned responses for the model methods the test exercises.

type AnyFn = (...args: unknown[]) => Promise<unknown>;

type ModelMock = {
  findMany: Mock<AnyFn>;
  findUnique: Mock<AnyFn>;
  count: Mock<AnyFn>;
};

type ModelOverrides = Partial<{
  findMany: AnyFn | unknown;
  findUnique: AnyFn | unknown;
  count: AnyFn | unknown;
}>;

function asFn(value: AnyFn | unknown): AnyFn {
  return typeof value === 'function' ? (value as AnyFn) : async () => value;
}

function buildModelMock(
  overrides: ModelOverrides | undefined,
  defaults: { findMany: unknown; findUnique: unknown; count: unknown },
): ModelMock {
  return {
    findMany: vi.fn(asFn(overrides?.findMany ?? defaults.findMany)),
    findUnique: vi.fn(asFn(overrides?.findUnique ?? defaults.findUnique)),
    count: vi.fn(asFn(overrides?.count ?? defaults.count)),
  };
}

export type MockAcceleratedPrisma = {
  product: ModelMock;
  vendor: ModelMock;
  integration: ModelMock;
  taxonomyCategory: ModelMock;
  taxonomyAudience: ModelMock;
  taxonomyPhase: ModelMock;
  statsCache: ModelMock;
  $queryRaw: Mock<QueryRawFn>;
};

export type MockAcceleratedPrismaOverrides = Partial<{
  product: ModelOverrides;
  vendor: ModelOverrides;
  integration: ModelOverrides;
  taxonomyCategory: ModelOverrides;
  taxonomyAudience: ModelOverrides;
  taxonomyPhase: ModelOverrides;
  statsCache: ModelOverrides;
  queryRaw: QueryRawFn;
}>;

const listDefaults = { findMany: [], findUnique: null, count: 0 };

export function makeMockAcceleratedPrisma(
  overrides: MockAcceleratedPrismaOverrides = {},
): MockAcceleratedPrisma {
  return {
    product: buildModelMock(overrides.product, listDefaults),
    vendor: buildModelMock(overrides.vendor, listDefaults),
    integration: buildModelMock(overrides.integration, listDefaults),
    taxonomyCategory: buildModelMock(overrides.taxonomyCategory, listDefaults),
    taxonomyAudience: buildModelMock(overrides.taxonomyAudience, listDefaults),
    taxonomyPhase: buildModelMock(overrides.taxonomyPhase, listDefaults),
    // Phase 4.4 (AECI-179) — `prisma.statsCache.findMany` backs GET /api/stats/home.
    // Default empty array models a cold/sparse cache (pre-compute-job).
    statsCache: buildModelMock(overrides.statsCache, listDefaults),
    $queryRaw: vi.fn(overrides.queryRaw ?? (async () => [{ '?column?': 1 }])),
  };
}
