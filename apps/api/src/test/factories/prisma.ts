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
