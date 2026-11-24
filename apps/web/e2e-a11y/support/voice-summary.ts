/**
 * AECI-1883: the `voice` block of the nightly summary.
 *
 * Three of the voice-control checks report as well as pass or fail:
 *
 *   - Check 3, target size, is report only. Each surface's findings go here.
 *   - Check 4, input purpose, lists every text field it saw and the purpose it
 *     held each to, so a green run shows what it judged.
 *   - Check 5, effort, fails only above its margin, so the count, its change
 *     from the baseline, and the stop it matched go here on every run.
 *
 * `voice-control.spec.ts` writes one annotation per record, typed
 * `VOICE_EFFORT_ANNOTATION`, `VOICE_TARGET_SIZE_ANNOTATION` or
 * `VOICE_INPUT_PURPOSE_ANNOTATION`, with the record as JSON.
 * `summary-reporter.ts` folds them with `summarizeVoice`. Each shard writes its
 * own summary, and `scripts/a11y-nightly-merge-summary.mjs` merges the blocks
 * with `mergeVoice`. Keep the two in step.
 *
 * Pure. Pinned by `voice-summary.unit.spec.ts`. `docs/TESTING_STRATEGY.md` §8.4.8.
 */
import type { EffortVerdict, FieldJudged } from './voice-names';

export const VOICE_EFFORT_ANNOTATION = 'voice-effort';
export const VOICE_TARGET_SIZE_ANNOTATION = 'voice-target-size';
export const VOICE_INPUT_PURPOSE_ANNOTATION = 'voice-input-purpose';

export interface EffortRecord {
  readonly surfaceId: string;
  readonly route: string;
  /** The primary action, in words, as the spec's table names it. */
  readonly action: string;
  /** Tab presses from load to the action, or `null` when the walk never reached it. */
  readonly presses: number | null;
  readonly baseline: number;
  readonly margin: number;
  /** `presses - baseline`, or `null` when not reached. */
  readonly change: number | null;
  readonly verdict: EffortVerdict;
  /** The stop the walk matched: role, name and link target. `null` when not reached. */
  readonly matched: string | null;
}

export interface TargetSizeRecord {
  readonly surfaceId: string;
  readonly route: string;
  /** `fails` when axe measured a failure, `review` when it could not decide. Both are listed. */
  readonly targets: ReadonlyArray<{
    readonly target: string;
    readonly verdict: 'fails' | 'review';
    readonly why: string;
  }>;
}

export interface InputPurposeRecord {
  readonly surfaceId: string;
  readonly route: string;
  /** Every text field on the page at load. One with `purpose: null` was not judged. */
  readonly fields: readonly FieldJudged[];
}

export interface VoiceSummary {
  /** One row per surface whose effort test ran, by surface id. */
  readonly effort: readonly EffortRecord[];
  readonly targetSize: {
    /** Surfaces measured. */
    readonly surfaces: number;
    /** Findings across them. */
    readonly targets: number;
    /** One row per measured surface, by surface id. A surface with no finding has an empty list. */
    readonly bySurface: readonly TargetSizeRecord[];
  };
  readonly inputPurpose: {
    /** Surfaces read. */
    readonly surfaces: number;
    /** Text fields seen across them. */
    readonly fields: number;
    /** Of those, fields held to a purpose. */
    readonly judged: number;
    /** One row per surface read, by surface id. */
    readonly bySurface: readonly InputPurposeRecord[];
  };
}

const bySurfaceId = (a: { surfaceId: string }, b: { surfaceId: string }): number =>
  a.surfaceId < b.surfaceId ? -1 : a.surfaceId > b.surfaceId ? 1 : 0;

function parse<T>(description: string | undefined): T | null {
  if (!description) return null;
  try {
    return JSON.parse(description) as T;
  } catch {
    return null;
  }
}

/** Fold the annotations of every test into the block. Always an object. */
export function summarizeVoice(
  annotations: ReadonlyArray<{ readonly type: string; readonly description?: string }>,
): VoiceSummary {
  const effort: EffortRecord[] = [];
  const bySurface: TargetSizeRecord[] = [];
  const purposes: InputPurposeRecord[] = [];
  for (const a of annotations) {
    if (a.type === VOICE_EFFORT_ANNOTATION) {
      const r = parse<EffortRecord>(a.description);
      if (r) effort.push(r);
    } else if (a.type === VOICE_TARGET_SIZE_ANNOTATION) {
      const r = parse<TargetSizeRecord>(a.description);
      if (r) bySurface.push(r);
    } else if (a.type === VOICE_INPUT_PURPOSE_ANNOTATION) {
      const r = parse<InputPurposeRecord>(a.description);
      if (r) purposes.push(r);
    }
  }
  const fields = purposes.flatMap((p) => p.fields);
  return {
    effort: effort.sort(bySurfaceId),
    targetSize: {
      surfaces: bySurface.length,
      targets: bySurface.reduce((n, s) => n + s.targets.length, 0),
      bySurface: bySurface.sort(bySurfaceId),
    },
    inputPurpose: {
      surfaces: purposes.length,
      fields: fields.length,
      judged: fields.filter((f) => f.purpose !== null).length,
      bySurface: purposes.sort(bySurfaceId),
    },
  };
}
