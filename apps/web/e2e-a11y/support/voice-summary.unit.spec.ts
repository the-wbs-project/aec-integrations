/**
 * AECI-1883: folding the voice-control annotations into the summary's `voice`
 * block. Plain Vitest runner. `scripts/a11y-nightly-merge-summary.test.mjs`
 * pins the merge of the same block across shards.
 */
import { describe, expect, it } from 'vitest';
import {
  VOICE_EFFORT_ANNOTATION,
  VOICE_INPUT_PURPOSE_ANNOTATION,
  VOICE_TARGET_SIZE_ANNOTATION,
  summarizeVoice,
  type EffortRecord,
} from './voice-summary';

const effort = (surfaceId: string, presses: number | null): EffortRecord => ({
  surfaceId,
  route: `/${surfaceId}`,
  action: 'the first card',
  presses,
  baseline: 10,
  margin: 3,
  change: presses === null ? null : presses - 10,
  verdict: presses === null ? 'not-reached' : presses === 10 ? 'same' : 'more',
  matched: presses === null ? null : 'link "Fixture Procore" /products/fixture-procore',
});

describe('summarizeVoice', () => {
  it('is an empty block when no test wrote a record', () => {
    expect(summarizeVoice([{ type: 'surface', description: 'home' }])).toEqual({
      effort: [],
      targetSize: { surfaces: 0, targets: 0, bySurface: [] },
      inputPurpose: { surfaces: 0, fields: 0, judged: 0, bySurface: [] },
    });
  });

  it('counts the text fields seen and the ones held to a purpose', () => {
    const field = (name: string, purpose: string | null) => ({
      field: name,
      type: 'text',
      landmark: 'main',
      purpose,
      wants: purpose ? 'email' : null,
      has: null,
      ok: purpose === null,
    });
    const block = summarizeVoice([
      {
        type: VOICE_INPUT_PURPOSE_ANNOTATION,
        description: JSON.stringify({
          surfaceId: 'login',
          route: '/auth/login',
          fields: [field('Email', 'an email address')],
        }),
      },
      {
        type: VOICE_INPUT_PURPOSE_ANNOTATION,
        description: JSON.stringify({
          surfaceId: 'home',
          route: '/',
          fields: [field('Search', null), field('Email address', 'an email address')],
        }),
      },
      {
        type: VOICE_INPUT_PURPOSE_ANNOTATION,
        description: JSON.stringify({
          surfaceId: 'admin-requests',
          route: '/admin/requests',
          fields: [],
        }),
      },
    ]);
    expect(block.inputPurpose.surfaces).toBe(3);
    expect(block.inputPurpose.fields).toBe(3);
    expect(block.inputPurpose.judged).toBe(2);
    expect(block.inputPurpose.bySurface.map((s) => s.surfaceId)).toEqual([
      'admin-requests',
      'home',
      'login',
    ]);
  });

  it('collects effort rows and target size rows, sorted by surface id', () => {
    const block = summarizeVoice([
      { type: VOICE_EFFORT_ANNOTATION, description: JSON.stringify(effort('login', 9)) },
      { type: VOICE_EFFORT_ANNOTATION, description: JSON.stringify(effort('home', 10)) },
      {
        type: VOICE_TARGET_SIZE_ANNOTATION,
        description: JSON.stringify({
          surfaceId: 'login',
          route: '/login',
          targets: [{ target: 'button.x', verdict: 'fails', why: 'Target has insufficient size' }],
        }),
      },
      {
        type: VOICE_TARGET_SIZE_ANNOTATION,
        description: JSON.stringify({ surfaceId: 'home', route: '/', targets: [] }),
      },
    ]);
    expect(block.effort.map((e) => e.surfaceId)).toEqual(['home', 'login']);
    expect(block.targetSize.surfaces).toBe(2);
    expect(block.targetSize.targets).toBe(1);
    expect(block.targetSize.bySurface.map((s) => s.surfaceId)).toEqual(['home', 'login']);
  });

  it('skips a record that is not JSON', () => {
    expect(
      summarizeVoice([{ type: VOICE_EFFORT_ANNOTATION, description: 'not json' }]).effort,
    ).toEqual([]);
  });
});
