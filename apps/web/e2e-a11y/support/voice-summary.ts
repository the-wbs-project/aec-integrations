/**
 * AECI-1883: the `voice` block of the nightly summary.
 *
 * Two of the voice-control checks report rather than only pass or fail:
 *
 *   - Check 3, target size, is report only. Each surface's findings go here.
 *   - Check 5, effort, fails only above its margin, so the count and its change
 *     from the baseline go here on every run.
 *
 * `voice-control.spec.ts` writes one annotation per test, typed
 * `VOICE_EFFORT_ANNOTATION` or `VOICE_TARGET_SIZE_ANNOTATION`, with the record
 * as JSON. `summary-reporter.ts` folds them with `summarizeVoice`. Each shard
 * writes its own summary, and `scripts/a11y-nightly-merge-summary.mjs` merges
 * the blocks with `mergeVoice`. Keep the two in step.
 *
 * Pure. Pinned by `voice-summary.unit.spec.ts`. `docs/TESTING_STRATEGY.md` §8.4.8.
 */
import type { EffortVerdict } from './voice-names';

export const VOICE_EFFORT_ANNOTATION = 'voice-effort';
export const VOICE_TARGET_SIZE_ANNOTATION = 'voice-target-size';

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
  for (const a of annotations) {
    if (a.type === VOICE_EFFORT_ANNOTATION) {
      const r = parse<EffortRecord>(a.description);
      if (r) effort.push(r);
    } else if (a.type === VOICE_TARGET_SIZE_ANNOTATION) {
      const r = parse<TargetSizeRecord>(a.description);
      if (r) bySurface.push(r);
    }
  }
  return {
    effort: effort.sort(bySurfaceId),
    targetSize: {
      surfaces: bySurface.length,
      targets: bySurface.reduce((n, s) => n + s.targets.length, 0),
      bySurface: bySurface.sort(bySurfaceId),
    },
  };
}
