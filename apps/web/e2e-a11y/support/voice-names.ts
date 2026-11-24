/**
 * AECI-1883: the pure half of the voice-control and switch stand-ins. No browser.
 *
 * A voice-control user (Dragon, Voice Control, Voice Access) acts by saying what
 * they see: "click Save". The browser matches the words against each control's
 * accessible name. So the name must contain the visible label (WCAG 2.5.3), and
 * two controls that do different things must not share one. A switch user moves
 * through the page one stop at a time, so every stop before the task is effort.
 *
 * The browser half is `./voice-probe.ts`. These rules are pinned by
 * `voice-names.unit.spec.ts` in the plain Vitest runner.
 *
 * Text is compared the way speech is matched: case-folded, spacing collapsed,
 * and punctuation dropped. No `localeCompare` anywhere: the rules never order by
 * name, and problem lists are sorted by code unit, which is stable on every
 * machine.
 */
import { maskVolatile, normalizeTarget } from './aria-tree';

/** One control, as the probe reads it. */
export interface ControlFact {
  /** The probe's index for the element in this read. Distinct per element. */
  readonly key: number;
  /** The Chromium accessibility role, for example `button`, `link`, `textbox`. */
  readonly role: string;
  /** The Chromium accessible name. What a voice command is matched against. */
  readonly name: string;
  /**
   * The text a sighted user reads as the control's label: its rendered content,
   * the rendered text of its `<label>`, or a button input's value. Empty when it
   * shows no text (an icon button, a field with no `<label>`).
   */
  readonly visibleText: string;
  readonly labelSource: 'content' | 'label' | 'value' | 'none';
  /**
   * What activating it does, as a key two controls share only when they do the
   * same thing: `link <target>`, `controls <ids>`, `submit <form>`, `details <n>`,
   * or `element <n>` when nothing tells two controls apart.
   */
  readonly action: string;
  readonly disabled: boolean;
  /** The innermost landmark: `header`, `nav`, `main`, `aside`, `footer`, `dialog` or `page`. */
  readonly landmark: string;
  /** The nearest `data-testid`, for a stable problem string. */
  readonly testId: string | null;
  /** Set for a text-entry field: what 1.3.5 looks at. */
  readonly field: FieldFact | null;
}

export interface FieldFact {
  /** The input `type`, or `textarea`. */
  readonly type: string;
  /** The `autocomplete` attribute as written, or `null` when absent. */
  readonly autocomplete: string | null;
  /** The `name` and `id` attributes, which often say what a field is for. */
  readonly nameAttr: string;
  readonly id: string;
}

/** The words a speech engine would match: case-folded, punctuation and spacing dropped. */
export function speechWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '');
}

/**
 * Does the accessible name contain the visible label, word for word and in
 * order? WCAG 2.5.3. Case, spacing and punctuation do not count: "Save draft"
 * is in "save  draft (opens a dialog)". A label of only symbols ("→") asks
 * nothing. AECI-1469 is the failure: "Change billing email" shown, and the name
 * "Changebilling email".
 */
export function nameContainsLabel(name: string, label: string): boolean {
  const want = speechWords(label);
  if (want.length === 0) return true;
  const have = speechWords(name);
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, j) => have[i + j] === w)) return true;
  }
  return false;
}

/** Shorten and mask a name for a problem string, so the string is the same on every run. */
export function quote(text: string, max = 80): string {
  const masked = maskVolatile(text.replace(/\s+/g, ' ').trim());
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

function near(c: ControlFact): string {
  return c.testId ? ` near [data-testid="${c.testId}"]` : '';
}

/** Check 1, WCAG 2.5.3: every control that shows text has a name that contains it. */
export function labelInNameProblems(controls: readonly ControlFact[]): string[] {
  const problems = new Set<string>();
  for (const c of controls) {
    if (c.labelSource === 'none' || c.visibleText.trim() === '') continue;
    if (nameContainsLabel(c.name, c.visibleText)) continue;
    problems.add(
      `label in name: ${c.role} in ${c.landmark} shows "${quote(c.visibleText)}" ` +
        `but is named "${quote(c.name)}"${near(c)}`,
    );
  }
  return [...problems].sort();
}

function describe(c: ControlFact): string {
  const target = c.action.startsWith('link ') ? ` to ${c.action.slice(5)}` : '';
  return `${c.role} in ${c.landmark}${target}`;
}

/**
 * Check 2: no two controls share an accessible name while doing different
 * things. A voice user saying the name cannot tell them apart.
 *
 * A group made only of links is left to the ARIA suite's `link names` rule
 * (`sharedNameProblems` in `./aria-tree.ts`), which owns "one link name, two
 * targets". This rule owns every group with at least one control that is not a
 * link: two buttons, a button and a link, two fields. A disabled control does
 * nothing, so it is not counted.
 */
export function sharedControlNameProblems(controls: readonly ControlFact[]): string[] {
  const groups = new Map<string, ControlFact[]>();
  for (const c of controls) {
    if (c.disabled) continue;
    const key = speechWords(c.name).join(' ');
    if (key === '') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const problems: string[] = [];
  for (const group of groups.values()) {
    if (group.every((c) => c.action.startsWith('link '))) continue;
    const actions = new Set(group.map((c) => c.action));
    if (actions.size < 2) continue;
    const what = [...new Set(group.map(describe))].sort();
    problems.push(
      `unique names: "${quote(group[0]!.name)}" names ${group.length} controls that do ` +
        `different things: ${what.join(', ')}`,
    );
  }
  return problems.sort();
}

/**
 * The input purposes of WCAG 1.3.5 the site's forms collect, each with the
 * `autocomplete` tokens that satisfy it. First match wins, so "Email address"
 * is an email and never a street address.
 */
interface Purpose {
  readonly purpose: string;
  readonly tokens: readonly string[];
  readonly matches: (words: string, type: string) => boolean;
}

const PURPOSES: readonly Purpose[] = [
  {
    purpose: 'an email address',
    tokens: ['email'],
    matches: (w, t) => t === 'email' || /\b(e mail|email)\b/.test(w),
  },
  {
    purpose: 'a phone number',
    tokens: ['tel', 'tel-national', 'tel-local'],
    matches: (w, t) => t === 'tel' || /\b(phone|telephone|mobile number)\b/.test(w),
  },
  {
    purpose: 'a first name',
    tokens: ['given-name'],
    matches: (w) => /\b(first name|given name|forename)\b/.test(w),
  },
  {
    purpose: 'a last name',
    tokens: ['family-name'],
    matches: (w) => /\b(last name|surname|family name)\b/.test(w),
  },
  {
    purpose: 'a display name',
    tokens: ['nickname', 'username', 'name'],
    matches: (w) => /\b(display name|username|user name|nickname)\b/.test(w),
  },
  {
    purpose: 'a name',
    tokens: ['name'],
    matches: (w) => /^(your |full )?name$/.test(w) || /\b(your name|full name)\b/.test(w),
  },
  {
    purpose: 'an organisation',
    tokens: ['organization'],
    matches: (w) =>
      /\b(company|organisation|organization|firm|employer)\b/.test(w) && !/\bsize\b/.test(w),
  },
  {
    purpose: 'a job title',
    tokens: ['organization-title'],
    matches: (w) => /\b(job title|your role|your title|position)\b/.test(w),
  },
  {
    purpose: 'a web address',
    tokens: ['url'],
    matches: (w, t) => t === 'url' || /\b(website|homepage|web site)\b/.test(w),
  },
  {
    purpose: 'a postal code',
    tokens: ['postal-code'],
    matches: (w) => /\b(postcode|post code|postal code|zip|zip code)\b/.test(w),
  },
  {
    purpose: 'a country',
    tokens: ['country', 'country-name'],
    matches: (w) => /\bcountry\b/.test(w),
  },
  {
    purpose: 'a street address',
    tokens: ['street-address', 'address-line1'],
    matches: (w) => /\b(street|address line|street address)\b/.test(w),
  },
];

/** Text-entry types 1.3.5 applies to. A checkbox or a list choice has no input purpose. */
const TEXT_TYPES = new Set(['text', 'email', 'tel', 'url', 'textarea', '']);

/** The tokens of an `autocomplete` value that name a section or an address kind, not a field. */
const MODIFIERS = /^(section-.*|shipping|billing|home|work|mobile|fax|pager|webauthn)$/;

/** The field-name token of an `autocomplete` value, or `null` when it names none. */
export function autocompleteField(value: string | null): string | null {
  if (value === null) return null;
  const tokens = value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const fields = tokens.filter((t) => !MODIFIERS.test(t));
  return fields.at(-1) ?? null;
}

/** `displayName`, `display_name` and `display-name` all read as "display name". */
function attributeWords(value: string): string {
  return speechWords(value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')).join(' ');
}

/**
 * What a field collects. The accessible name decides first, as a person reads
 * the label. The `name` and `id` attributes decide only when the name says
 * nothing. `null` when no purpose fits.
 */
export function purposeOf(c: Pick<ControlFact, 'name' | 'field'>): Purpose | null {
  if (!c.field || !TEXT_TYPES.has(c.field.type)) return null;
  const type = c.field.type;
  const byName = speechWords(c.name).join(' ');
  const found = PURPOSES.find((p) => p.matches(byName, type));
  if (found) return found;
  for (const attr of [c.field.nameAttr, c.field.id]) {
    const words = attributeWords(attr);
    const hit = words === '' ? undefined : PURPOSES.find((p) => p.matches(words, type));
    if (hit) return hit;
  }
  return null;
}

/**
 * Check 4, WCAG 1.3.5: a field that collects the user's name, email,
 * organisation or another listed purpose carries a matching `autocomplete`
 * token. `off`, a wrong token and no attribute all fail.
 */
export function inputPurposeProblems(controls: readonly ControlFact[]): string[] {
  const problems = new Set<string>();
  for (const c of controls) {
    const purpose = purposeOf(c);
    if (!purpose) continue;
    const has = autocompleteField(c.field!.autocomplete);
    if (has !== null && purpose.tokens.includes(has)) continue;
    problems.add(
      `input purpose: ${c.role} "${quote(c.name)}" in ${c.landmark} collects ${purpose.purpose}, ` +
        `wants autocomplete="${purpose.tokens[0]}", has ${
          c.field!.autocomplete === null ? 'none' : `"${c.field!.autocomplete}"`
        }${near(c)}`,
    );
  }
  return [...problems].sort();
}

/** One text field as check 4 saw it, so a green run shows what it judged. */
export interface FieldJudged {
  /** The accessible name, masked. */
  readonly field: string;
  readonly type: string;
  readonly landmark: string;
  /** The purpose it was held to, or `null` when no purpose fits (a search box, a headline). */
  readonly purpose: string | null;
  /** The token that satisfies it, or `null` with no purpose. */
  readonly wants: string | null;
  /** The `autocomplete` attribute as written, or `null` when absent. */
  readonly has: string | null;
  readonly ok: boolean;
}

/**
 * Every text-entry field on the page (search, number and password included),
 * with the purpose check 4 held it to. A field with no purpose is listed too,
 * so "nothing found" can be told apart from "nothing judged".
 */
export function judgedFields(controls: readonly ControlFact[]): FieldJudged[] {
  const out: FieldJudged[] = [];
  for (const c of controls) {
    if (!c.field) continue;
    const purpose = purposeOf(c);
    const has = c.field.autocomplete;
    out.push({
      field: quote(c.name),
      type: c.field.type,
      landmark: c.landmark,
      purpose: purpose?.purpose ?? null,
      wants: purpose?.tokens[0] ?? null,
      has,
      ok: !purpose || purpose.tokens.includes(autocompleteField(has) ?? ''),
    });
  }
  return out;
}

/** The action key of a link, so two links to one page are one action. */
export function linkAction(href: string, origin: string): string {
  let target = href;
  try {
    const url = new URL(href, origin);
    target = url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
  } catch {
    // A broken href is still a target, compared as written.
  }
  return `link ${normalizeTarget(target)}`;
}

/**
 * Check 5's margin: the walk to the primary action may grow by this many Tab
 * presses before the test fails. Three presses, or a fifth of the baseline when
 * that is more. One new link in the shared header adds one press to every
 * surface and passes. A new block of links or filters ahead of the task fails.
 */
export function effortMargin(baseline: number): number {
  return Math.max(3, Math.ceil(baseline * 0.2));
}

export type EffortVerdict = 'same' | 'fewer' | 'more' | 'over-margin' | 'not-reached';

/** Compare one walk with its committed baseline. Only `over-margin` and `not-reached` fail. */
export function effortVerdict(presses: number | null, baseline: number): EffortVerdict {
  if (presses === null) return 'not-reached';
  if (presses > baseline + effortMargin(baseline)) return 'over-margin';
  if (presses > baseline) return 'more';
  if (presses < baseline) return 'fewer';
  return 'same';
}
