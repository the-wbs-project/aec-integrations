/**
 * AECI-1884: the overlap matcher and the summary's `ibm` block. Plain Vitest
 * runner. `scripts/a11y-nightly-merge-summary.test.mjs` pins the merge of the
 * same block across shards.
 */
import { describe, expect, it } from 'vitest';
import {
  IBM_ANNOTATION,
  MAX_DEPTH_GAP,
  RULE_PAIRS,
  bucketOf,
  levelOf,
  matchAxe,
  sameElement,
  summarizeIbm,
  wcagFromAxeTags,
  type AxeNode,
  type IbmFinding,
  type IbmSurfaceRecord,
} from './ibm-overlap';

const BODY = '/html[1]/body[1]';
const MAIN = `${BODY}/main[1]`;
const FIELD = `${MAIN}/form[1]/input[1]`;

const finding = (over: Partial<IbmFinding> = {}): IbmFinding => ({
  ruleId: 'input_label_exists',
  reasonId: 'Fail_1',
  level: 'violation',
  message: 'Form control element <input> has no associated label',
  wcag: ['1.3.1', '4.1.2'],
  xpath: FIELD,
  ...over,
});

const axeNode = (over: Partial<AxeNode> = {}): AxeNode => ({
  ruleId: 'label',
  kind: 'violation',
  wcag: ['4.1.2'],
  xpath: FIELD,
  ...over,
});

describe('levelOf and bucketOf', () => {
  it('maps every IBM value pair the way the IBM wrapper does', () => {
    expect(levelOf(['VIOLATION', 'PASS'])).toBe('pass');
    expect(levelOf(['VIOLATION', 'FAIL'])).toBe('violation');
    expect(levelOf(['VIOLATION', 'POTENTIAL'])).toBe('potentialviolation');
    expect(levelOf(['VIOLATION', 'MANUAL'])).toBe('manual');
    expect(levelOf(['RECOMMENDATION', 'FAIL'])).toBe('recommendation');
    expect(levelOf(['RECOMMENDATION', 'POTENTIAL'])).toBe('potentialrecommendation');
    expect(levelOf(['RECOMMENDATION', 'MANUAL'])).toBe('manual');
    expect(levelOf(['INFORMATION', 'FAIL'])).toBeNull();
  });

  it('groups needs review and recommendations as IBM reports do', () => {
    expect(bucketOf('violation')).toBe('violation');
    expect(bucketOf('potentialviolation')).toBe('needsReview');
    expect(bucketOf('manual')).toBe('needsReview');
    expect(bucketOf('recommendation')).toBe('recommendation');
    expect(bucketOf('potentialrecommendation')).toBe('recommendation');
  });
});

describe('wcagFromAxeTags', () => {
  it('reads two- and three-part criteria and drops every other tag', () => {
    expect(
      wcagFromAxeTags(['wcag2aa', 'wcag143', 'wcag1410', 'best-practice', 'cat.color']),
    ).toEqual(['1.4.10', '1.4.3']);
  });
});

describe('sameElement', () => {
  it('is true for one element', () => {
    expect(sameElement(FIELD, FIELD)).toBe(true);
  });

  it(`is true for an ancestor at most ${MAX_DEPTH_GAP} levels up, either way round`, () => {
    expect(sameElement(`${MAIN}/form[1]`, FIELD)).toBe(true);
    expect(sameElement(FIELD, MAIN)).toBe(true);
  });

  it('is false further up, and for siblings that share a prefix', () => {
    expect(sameElement(BODY, FIELD)).toBe(false);
    expect(sameElement(`${MAIN}/form[1]/input[1]`, `${MAIN}/form[1]/input[10]`)).toBe(false);
    expect(sameElement(`${MAIN}/div[1]`, `${MAIN}/div[2]`)).toBe(false);
  });
});

describe('matchAxe', () => {
  it('matches the same element under a shared criterion', () => {
    expect(matchAxe(finding(), [axeNode()])).toEqual(['label']);
  });

  it('matches a wrapper or a child within the depth gap', () => {
    expect(matchAxe(finding({ xpath: `${MAIN}/form[1]` }), [axeNode()])).toEqual(['label']);
  });

  it('does not match another element, or the same element under another criterion', () => {
    expect(matchAxe(finding(), [axeNode({ xpath: `${MAIN}/form[1]/input[2]` })])).toEqual([]);
    expect(matchAxe(finding(), [axeNode({ ruleId: 'color-contrast', wcag: ['1.4.3'] })])).toEqual(
      [],
    );
  });

  it('matches a best-practice axe rule only through RULE_PAIRS', () => {
    const pair = RULE_PAIRS.find((p) => p.axe === 'region')!;
    const bp = axeNode({ ruleId: 'region', wcag: [], xpath: `${BODY}/div[1]` });
    expect(matchAxe(finding({ ruleId: pair.ibm, xpath: `${BODY}/div[1]` }), [bp])).toEqual([
      'region',
    ]);
    expect(matchAxe(finding({ ruleId: 'something_else', xpath: `${BODY}/div[1]` }), [bp])).toEqual(
      [],
    );
  });

  it('marks an axe incomplete as review, and lists each axe rule once, sorted', () => {
    expect(
      matchAxe(finding(), [
        axeNode({ ruleId: 'label', kind: 'violation' }),
        axeNode({ ruleId: 'label', kind: 'violation' }),
        axeNode({ ruleId: 'aria-input-field-name', kind: 'review' }),
      ]),
    ).toEqual(['aria-input-field-name (review)', 'label']);
  });

  it('every RULE_PAIRS entry says why', () => {
    for (const p of RULE_PAIRS) expect(p.why.trim()).not.toBe('');
  });
});

const record = (
  surfaceId: string,
  findings: IbmSurfaceRecord['findings'],
): { type: string; description: string } => ({
  type: IBM_ANNOTATION,
  description: JSON.stringify({
    surfaceId,
    route: `/${surfaceId}`,
    engine: { version: '4.0.35', ruleset: 'IBM_Accessibility' },
    rulesRun: 160,
    scanMs: 250,
    axeMs: 400,
    axeNodes: 3,
    findings,
  } satisfies IbmSurfaceRecord),
});

describe('summarizeIbm', () => {
  it('is an empty block when no test wrote a record', () => {
    expect(summarizeIbm([{ type: 'surface', description: 'home' }])).toEqual({
      engine: null,
      surfaces: 0,
      counts: { violation: 0, needsReview: 0, recommendation: 0 },
      alsoAxe: { violation: 0, needsReview: 0, recommendation: 0 },
      violations: [],
      needsReview: [],
      recommendations: [],
      bySurface: [],
    });
  });

  it('skips a record it cannot read', () => {
    expect(summarizeIbm([{ type: IBM_ANNOTATION, description: '{not json' }]).surfaces).toBe(0);
  });

  it('separates the three lists, counts the overlap, and groups by rule across surfaces', () => {
    const s = summarizeIbm([
      record('login', [
        { ...finding(), axe: ['label'] },
        { ...finding({ xpath: `${MAIN}/form[1]/input[2]` }), axe: [] },
        {
          ...finding({ ruleId: 'text_contrast_sufficient', level: 'potentialviolation' }),
          axe: [],
        },
        { ...finding({ ruleId: 'aria_landmark_name_unique', level: 'recommendation' }), axe: [] },
      ]),
      record('account', [{ ...finding({ message: 'second message' }), axe: [] }]),
    ]);
    expect(s.engine).toEqual({ version: '4.0.35', ruleset: 'IBM_Accessibility' });
    expect(s.surfaces).toBe(2);
    expect(s.counts).toEqual({ violation: 3, needsReview: 1, recommendation: 1 });
    expect(s.alsoAxe).toEqual({ violation: 1, needsReview: 0, recommendation: 0 });
    expect(s.violations).toEqual([
      {
        ruleId: 'input_label_exists',
        // Records fold in surface id order, so `account` comes first.
        message: 'second message',
        wcag: ['1.3.1', '4.1.2'],
        nodes: 3,
        alsoAxe: 1,
        axeRules: ['label'],
        surfaces: ['account', 'login'],
        examples: [
          { surfaceId: 'account', xpath: FIELD },
          { surfaceId: 'login', xpath: FIELD },
          { surfaceId: 'login', xpath: `${MAIN}/form[1]/input[2]` },
        ],
      },
    ]);
    expect(s.needsReview.map((r) => r.ruleId)).toEqual(['text_contrast_sufficient']);
    expect(s.recommendations.map((r) => r.ruleId)).toEqual(['aria_landmark_name_unique']);
    expect(s.bySurface).toEqual([
      {
        surfaceId: 'account',
        route: '/account',
        violation: 1,
        needsReview: 0,
        recommendation: 0,
        uniqueViolations: 1,
        scanMs: 250,
        axeMs: 400,
      },
      {
        surfaceId: 'login',
        route: '/login',
        violation: 2,
        needsReview: 1,
        recommendation: 1,
        uniqueViolations: 1,
        scanMs: 250,
        axeMs: 400,
      },
    ]);
  });
});
