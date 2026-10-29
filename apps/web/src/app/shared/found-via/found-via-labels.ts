import { FOUND_VIA, type FoundVia } from '@aeci/shared';

/**
 * The visitor-facing label for each "How did you find AEC Integrations?" channel
 * (AECI-1063, `docs/ANALYTICS.md` §11b). One place, so the form and every admin
 * surface that shows an answer read the same words.
 */
export const FOUND_VIA_LABELS: Readonly<Record<FoundVia, string>> = {
  search: $localize`:@@foundVia.option.search:Google or another search engine`,
  ai_tool: $localize`:@@foundVia.option.aiTool:ChatGPT, Claude, Perplexity or another AI tool`,
  linkedin: $localize`:@@foundVia.option.linkedin:LinkedIn`,
  colleague: $localize`:@@foundVia.option.colleague:A colleague or word of mouth`,
  vendor: $localize`:@@foundVia.option.vendor:A vendor or software company`,
  event: $localize`:@@foundVia.option.event:An event or conference`,
  other: $localize`:@@foundVia.option.other:Something else`,
};

/** The label for a stored answer that was left blank. */
export const FOUND_VIA_NOT_ANSWERED = $localize`:@@foundVia.notAnswered:Not answered`;

/** The channels with their labels, in the order the form lists them. */
export const FOUND_VIA_OPTIONS: ReadonlyArray<{ value: FoundVia; label: string }> = FOUND_VIA.map(
  (value) => ({ value, label: FOUND_VIA_LABELS[value] }),
);

/** A stored answer as text: the channel label, or "Not answered" for `null`. */
export function foundViaLabel(value: FoundVia | null | undefined): string {
  return value ? FOUND_VIA_LABELS[value] : FOUND_VIA_NOT_ANSWERED;
}

/** The follow-up question for a channel that takes one. */
export const FOUND_VIA_FOLLOW_UP_LABELS: Readonly<Partial<Record<FoundVia, string>>> = {
  ai_tool: $localize`:@@foundVia.followUp.aiTool:What did you ask it?`,
  search: $localize`:@@foundVia.followUp.search:What did you search for?`,
  vendor: $localize`:@@foundVia.followUp.more:Tell us more (optional)`,
  event: $localize`:@@foundVia.followUp.more:Tell us more (optional)`,
  other: $localize`:@@foundVia.followUp.more:Tell us more (optional)`,
};
