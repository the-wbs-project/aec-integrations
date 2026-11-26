// AECI-1874: the summary reporter keeps every known-failure ID a test carries.
// Vitest, not Playwright (`*.unit.spec.ts`). The TestCase objects are minimal fakes.
import type { TestCase } from '@playwright/test/reporter';
import { describe, expect, it } from 'vitest';

import { buildSummary, sortIssueIds } from './summary-reporter';

type Annotation = { type: string; description?: string };

function fakeTest(title: string, result: Annotation[], declared: Annotation[] = []): TestCase {
  return {
    titlePath: () => ['', 'chromium', 'magnification.spec.ts', title],
    results: [{ annotations: result, duration: 1, status: 'failed' }],
    annotations: declared,
    location: { file: '/repo/apps/web/e2e-a11y/magnification.spec.ts', line: 1, column: 1 },
    outcome: () => 'expected',
    expectedStatus: 'failed',
  } as unknown as TestCase;
}

const kf = (id: string): Annotation => ({ type: 'known-failure', description: id });

describe('known-failure IDs in the summary', () => {
  it('lists every ID a test carries, once each, by issue number', () => {
    const summary = buildSummary(
      [
        // Playwright may list a runtime annotation on the result and the test.
        fakeTest(
          'Product index wide',
          [kf('AECI-2106'), kf('AECI-1889'), kf('AECI-2105')],
          [kf('AECI-2106')],
        ),
        fakeTest('one mark', [kf('AECI-2105')]),
        fakeTest('no mark', []),
      ],
      'passed',
      {} as NodeJS.ProcessEnv,
      new Date('2026-11-25T05:40:00.000Z'),
      '/repo/apps/web',
    );
    const [wide, one, none] = summary.tests;
    expect(wide.knownFailures).toEqual(['AECI-1889', 'AECI-2105', 'AECI-2106']);
    // The old field keeps its meaning: the first mark the reporter finds.
    expect(wide.knownFailure).toBe('AECI-2106');
    expect(one.knownFailures).toEqual(['AECI-2105']);
    expect(one.knownFailure).toBe('AECI-2105');
    expect(none.knownFailures).toEqual([]);
    expect(none.knownFailure).toBeNull();
    expect(summary.schemaVersion).toBe(1);
  });

  it('names the browser project that ran each test (AECI-1885)', () => {
    const inWebkit = {
      ...fakeTest('webkit walk', []),
      titlePath: () => ['', 'webkit', 'keyboard-public.spec.ts', 'webkit walk'],
    } as unknown as TestCase;
    const summary = buildSummary(
      [fakeTest('chromium walk', []), inWebkit],
      'passed',
      {} as NodeJS.ProcessEnv,
      new Date('2026-11-26T05:40:00.000Z'),
      '/repo/apps/web',
    );
    expect(summary.tests.map((t) => [t.title, t.browser])).toEqual([
      ['chromium walk', 'chromium'],
      ['webkit walk', 'webkit'],
    ]);
    // The title still drops the root, the project and the file.
    expect(summary.schemaVersion).toBe(1);
  });

  it('sorts by issue number, not as text', () => {
    expect(sortIssueIds(['AECI-2106', 'AECI-999', 'AECI-1889'])).toEqual([
      'AECI-999',
      'AECI-1889',
      'AECI-2106',
    ]);
  });
});
