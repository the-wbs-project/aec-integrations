/**
 * Renders the Plans page (`/docs/vendors/plans`) to one Markdown file: the
 * **Plans snapshot** (AECI-1619, counsel ruling 16). A checkout or grant
 * acceptance records the Plans version and the SHA-256 of this file, so the
 * record points at the page as the vendor saw it.
 *
 * The live page is Markdown plus three code widgets (`DOCS_WIDGETS`). Hashing
 * `plans.md` alone would miss the cards, the comparison table and the prices,
 * which come from code (`TIER_CAPABILITIES`, the list prices). So the snapshot
 * prints them:
 *
 *   - frontmatter `title`, `version` and `recorded_on`;
 *   - the `plans.md` body, frontmatter stripped;
 *   - the `plans-comparison` marker replaced by both cards (`planCardsCopy`), the
 *     sort-rule note and a Markdown table of `planComparisonGroups`;
 *   - the `plans-actions` marker replaced by its pointer sentence to the vendor
 *     program (`plans-actions-copy.ts`), and the `plans-cta` marker by the closing
 *     panel's heading, terms and next steps (`planCtaPanelCopy`). Every statement a
 *     vendor sees goes in (ruled 2026-11-11). Buttons, the contact link and the rail
 *     and phone-bar cards stay out: they are navigation, and the rail and bar repeat
 *     the Managed card's name and price word for word;
 *   - the `## Versions` section left out, so adding a history line to the live
 *     page does not change any version's hash.
 *
 * en-US only: the record is of the source-locale page. Pure and deterministic:
 * `\r\n` becomes `\n`, runs of blank lines collapse to one, trailing spaces go,
 * and the file ends in exactly one newline. No `.md` import and no Angular
 * component import, so plain Vitest runs it (`plans-snapshot.spec.ts`, which is
 * also the generator behind `pnpm docs:plans-snapshot`).
 */
import { parseFrontmatter } from '../legal/legal-frontmatter';
import { type PlanCardCopy, planCardsCopy } from '../shared/plan-cta/plan-card-copy';
import { planCtaPanelCopy } from '../shared/plan-cta/plan-cta-copy';
import { VENDOR_PROGRAM_PATH, plansVendorProgramPointer } from './plans-actions-copy';
import { type PlanCell, planComparisonGroups, planSortRuleNote } from './plans-comparison-groups';

/** The locale every snapshot is recorded in. */
export const PLANS_SNAPSHOT_LOCALE = 'en-US';

/** The live page's version-history heading. Its section is never part of a snapshot. */
export const PLANS_VERSIONS_HEADING = '## Versions';

const WIDGET_LINE = /^<!--\s*docs:([a-z-]+)\s*-->$/;

/** A table cell: `|` escaped, and booleans spelled out. */
function cell(value: PlanCell): string {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return value.replace(/\|/g, '\\|');
}

function cardMarkdown(card: PlanCardCopy): string[] {
  const priceLine = card.price === undefined ? card.unit : `${card.price} ${card.unit}`;
  return [
    `### ${card.name}`,
    '',
    card.summary,
    '',
    `${priceLine}.`,
    '',
    `${card.includes}:`,
    '',
    ...card.highlights.map((item) => `- ${item}`),
    '',
  ];
}

/** The `plans-comparison` widget as Markdown: both cards, the note, the table. */
export function plansComparisonMarkdown(locale: string = PLANS_SNAPSHOT_LOCALE): string {
  const cards = planCardsCopy(locale);
  const lines: string[] = [
    ...cardMarkdown(cards.free),
    ...cardMarkdown(cards.managed),
    planSortRuleNote(),
    '',
    `| Feature | ${cards.free.name} | ${cards.managed.name} |`,
    '| --- | --- | --- |',
  ];
  for (const group of planComparisonGroups(locale)) {
    lines.push(`| **${cell(group.label)}** | | |`);
    for (const row of group.rows) {
      lines.push(`| ${cell(row.label)} | ${cell(row.free)} | ${cell(row.managed)} |`);
    }
  }
  return lines.join('\n');
}

/** The `plans-actions` widget as Markdown: its one statement, the vendor program pointer. */
export function plansActionsMarkdown(): string {
  const { before, link, after } = plansVendorProgramPointer();
  return `${before}[${link}](${VENDOR_PROGRAM_PATH})${after}`;
}

/** The `plans-cta` widget as Markdown: the panel's heading, terms and next steps. */
export function plansCtaMarkdown(locale: string = PLANS_SNAPSHOT_LOCALE): string {
  const panel = planCtaPanelCopy(locale);
  return [
    `### ${panel.heading}`,
    '',
    `${panel.terms} ${panel.term} ${panel.safety}`,
    '',
    ...panel.steps.map((step, i) => `${i + 1}. ${step}`),
  ].join('\n');
}

/** The body lines with the `## Versions` section cut out: its heading up to the next `h1`/`h2`. */
export function withoutVersionsSection(lines: readonly string[]): string[] {
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === PLANS_VERSIONS_HEADING) {
      skipping = true;
      continue;
    }
    if (skipping && /^#{1,2}\s/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out;
}

/**
 * The snapshot file for `version`, recorded on `recordedOn` (a "Month D, YYYY"
 * display string), from the `plans.md` source.
 */
export function plansSnapshotMarkdown(source: string, version: string, recordedOn: string): string {
  const { data, body } = parseFrontmatter(source.replace(/\r\n?/g, '\n'));
  const lines: string[] = [];
  for (const line of withoutVersionsSection(body.split('\n'))) {
    const widget = line.trim().match(WIDGET_LINE)?.[1];
    if (widget === undefined) {
      lines.push(line.replace(/\s+$/, ''));
    } else if (widget === 'plans-comparison') {
      lines.push(plansComparisonMarkdown());
    } else if (widget === 'plans-actions') {
      lines.push('', plansActionsMarkdown(), '');
    } else if (widget === 'plans-cta') {
      lines.push('', plansCtaMarkdown(), '');
    } else {
      throw new Error(`Plans snapshot: no Markdown rendering for widget "${widget}"`);
    }
  }
  const front = [
    '---',
    `title: ${data['title'] ?? ''}`,
    `version: ${version}`,
    `recorded_on: ${recordedOn}`,
    '---',
  ].join('\n');
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${front}\n\n${text}\n`;
}
