import { z } from 'zod';

/**
 * Self-reported attribution (AECI-1063, `docs/ANALYTICS.md` §11b): the optional
 * "How did you find AEC Integrations?" question and its free-text follow-up.
 *
 * It rides on the claim and listing request, the mailing-list signup and the
 * feedback form. Automatic attribution (UTM tags and the referrer) misses AI
 * answer engines, word of mouth, LinkedIn and events, so the visitor tells us.
 *
 * The D1 columns `found_via` and `found_via_detail` are the source of truth. They
 * have no CHECK: the enum is validated here, so a new channel needs no table
 * recreate (`docs/migrations.md` §0).
 *
 * The detail is free text. It never goes in a PostHog event, in audit metadata,
 * or in the PostHog Logs forward (`docs/ANALYTICS.md` §2). Only the enum does.
 */

/** The channel wire values, in the order the form lists them. */
export const FOUND_VIA = [
  'search',
  'ai_tool',
  'linkedin',
  'colleague',
  'vendor',
  'event',
  'other',
] as const;

export const FoundViaSchema = z.enum(FOUND_VIA);
export type FoundVia = z.infer<typeof FoundViaSchema>;

/**
 * The choices that show the follow-up text box. A detail sent with any other
 * choice, or with no choice, is dropped by `normalizeFoundVia`.
 */
export const FOUND_VIA_FOLLOW_UP: ReadonlySet<FoundVia> = new Set<FoundVia>([
  'ai_tool',
  'search',
  'vendor',
  'event',
  'other',
]);

/** Maximum length of the follow-up answer, after trimming. */
export const FOUND_VIA_DETAIL_MAX = 200;

/**
 * The two wire fields, spread into each form schema. Both carry `.default('')`:
 * they were added to endpoints already in production, so a body that predates
 * them must still validate (`docs/API_CONTRACTS.md` §6.7). `''` means "not
 * answered". Do not tidy the defaults away.
 */
export const foundViaFields = {
  found_via: z.union([z.literal(''), FoundViaSchema]).default(''),
  found_via_detail: z
    .string()
    .trim()
    .max(FOUND_VIA_DETAIL_MAX, `Keep this under ${FOUND_VIA_DETAIL_MAX} characters.`)
    .default(''),
};

/**
 * A stored `found_via` as an admin response carries it: the enum, or `null` when
 * the visitor did not answer. The column has no CHECK, so the reader maps an
 * off-vocabulary value to `null` with {@link storedFoundVia}.
 */
export const StoredFoundViaSchema = FoundViaSchema.nullable();

const FOUND_VIA_VALUES: ReadonlySet<string> = new Set(FOUND_VIA);

/** Read a stored `found_via` column back as the enum. Anything else is `null`. */
export function storedFoundVia(value: string | null | undefined): FoundVia | null {
  return value != null && FOUND_VIA_VALUES.has(value) ? (value as FoundVia) : null;
}

/** The parsed shape of `foundViaFields`, before normalisation. */
export interface FoundViaInput {
  found_via?: '' | FoundVia | null;
  found_via_detail?: string | null;
}

/** The stored shape: `null` means "not answered". */
export interface NormalizedFoundVia {
  foundVia: FoundVia | null;
  foundViaDetail: string | null;
}

/**
 * Map a parsed body onto the columns. `''` stores NULL. The detail is kept only
 * when the choice takes a follow-up, otherwise it is dropped, not rejected.
 */
export function normalizeFoundVia(body: FoundViaInput): NormalizedFoundVia {
  const choice = body.found_via ? body.found_via : null;
  if (choice === null) return { foundVia: null, foundViaDetail: null };
  const detail = (body.found_via_detail ?? '').trim();
  return {
    foundVia: choice,
    foundViaDetail: FOUND_VIA_FOLLOW_UP.has(choice) && detail !== '' ? detail : null,
  };
}
