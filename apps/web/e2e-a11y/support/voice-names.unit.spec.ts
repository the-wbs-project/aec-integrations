/**
 * AECI-1883: the pure rules of the voice-control stand-ins. Plain Vitest runner
 * (`pnpm --filter @aeci/web test:unit`). Playwright ignores `*.unit.spec.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  autocompleteField,
  effortMargin,
  effortVerdict,
  inputPurposeProblems,
  judgedFields,
  labelInNameProblems,
  linkAction,
  nameContainsLabel,
  purposeOf,
  sharedControlNameProblems,
  speechWords,
  type ControlFact,
} from './voice-names';

const control = (over: Partial<ControlFact> = {}): ControlFact => ({
  key: 0,
  role: 'button',
  name: 'Save',
  visibleText: 'Save',
  labelSource: 'content',
  action: 'element 0',
  disabled: false,
  landmark: 'main',
  testId: null,
  field: null,
  ...over,
});

const field = (
  name: string,
  over: Partial<NonNullable<ControlFact['field']>> = {},
  key = 0,
): ControlFact =>
  control({
    key,
    role: 'textbox',
    name,
    visibleText: name,
    labelSource: 'label',
    action: `element ${key}`,
    field: { type: 'text', autocomplete: null, nameAttr: '', id: '', ...over },
  });

describe('speechWords', () => {
  it('folds case, drops punctuation and collapses spacing', () => {
    expect(speechWords('  Save\n\tDRAFT — now! ')).toEqual(['save', 'draft', 'now']);
  });

  it('keeps letters and digits from any script', () => {
    expect(speechWords('Café 3 stars')).toEqual(['café', '3', 'stars']);
  });
});

describe('nameContainsLabel', () => {
  it('passes when the name is the label', () => {
    expect(nameContainsLabel('Save', 'Save')).toBe(true);
  });

  it('ignores case and extra whitespace on both sides', () => {
    expect(nameContainsLabel('save   DRAFT', 'Save\n draft')).toBe(true);
    expect(nameContainsLabel('  SAVE DRAFT  ', 'save draft')).toBe(true);
  });

  it('passes when the label sits inside a longer name', () => {
    expect(nameContainsLabel('Visit website (opens in a new tab)', 'Visit website')).toBe(true);
    expect(
      nameContainsLabel('Zz Fixture Category Alpha 8 products', 'Zz Fixture Category Alpha 8'),
    ).toBe(true);
  });

  it('ignores punctuation, so "(optional)" glued to a word still matches', () => {
    expect(nameContainsLabel('Your role(optional)', 'Your role (optional)')).toBe(true);
  });

  it('fails the AECI-1469 case: a lost space joins two words', () => {
    expect(nameContainsLabel('Changebilling email', 'Change billing email')).toBe(false);
  });

  it('fails when the name says something else', () => {
    expect(nameContainsLabel('Account menu', 'Profile')).toBe(false);
  });

  it('needs whole words in order, not a substring or a shuffle', () => {
    expect(nameContainsLabel('Saved items', 'Save')).toBe(false);
    expect(nameContainsLabel('draft save', 'save draft')).toBe(false);
  });

  it('asks nothing of a label made only of symbols', () => {
    expect(nameContainsLabel('Next page', '→')).toBe(true);
  });
});

describe('labelInNameProblems', () => {
  it('reports a control whose name drops its visible label', () => {
    const problems = labelInNameProblems([
      control({
        name: 'Changebilling email',
        visibleText: 'Change billing email',
        testId: 'billing',
      }),
    ]);
    expect(problems).toEqual([
      'label in name: button in main shows "Change billing email" but is named "Changebilling email" near [data-testid="billing"]',
    ]);
  });

  it('skips a control that shows no text', () => {
    expect(
      labelInNameProblems([control({ name: 'Close', visibleText: '', labelSource: 'none' })]),
    ).toEqual([]);
  });

  it('masks counts so the string is the same on every run', () => {
    const [p] = labelInNameProblems([control({ name: 'Inbox', visibleText: 'Messages 12' })]);
    expect(p).toContain('"Messages <n>"');
  });
});

describe('sharedControlNameProblems', () => {
  it('reports two buttons with one name that do different things', () => {
    expect(
      sharedControlNameProblems([
        control({ key: 1, name: '3 stars', role: 'option', action: 'element 1' }),
        control({ key: 2, name: '3 stars', role: 'option', action: 'element 2' }),
      ]),
    ).toEqual([
      'unique names: "<n> stars" names 2 controls that do different things: option in main',
    ]);
  });

  it('compares names without case or spacing', () => {
    expect(
      sharedControlNameProblems([
        control({ key: 1, name: 'Open', action: 'element 1' }),
        control({ key: 2, name: ' open ', action: 'element 2' }),
      ]),
    ).toHaveLength(1);
  });

  it('reports a button and a link that share a name', () => {
    const [p] = sharedControlNameProblems([
      control({ key: 1, name: 'Delete account', action: 'element 1' }),
      control({
        key: 2,
        name: 'Delete account',
        role: 'link',
        landmark: 'nav',
        action: 'link /account#delete-account',
      }),
    ]);
    expect(p).toBe(
      'unique names: "Delete account" names 2 controls that do different things: button in main, link in nav to /account#delete-account',
    );
  });

  it('leaves a group of only links to the ARIA suite', () => {
    expect(
      sharedControlNameProblems([
        control({ key: 1, role: 'link', name: 'About', action: 'link /about' }),
        control({ key: 2, role: 'link', name: 'About', action: 'link /products/x#about' }),
      ]),
    ).toEqual([]);
  });

  it('passes controls that do the same thing', () => {
    expect(
      sharedControlNameProblems([
        control({ key: 1, name: 'Menu', action: 'controls panel' }),
        control({ key: 2, name: 'Menu', action: 'controls panel' }),
      ]),
    ).toEqual([]);
  });

  it('does not count a disabled control or an unnamed one', () => {
    expect(
      sharedControlNameProblems([
        control({ key: 1, name: 'Save', action: 'element 1' }),
        control({ key: 2, name: 'Save', action: 'element 2', disabled: true }),
        control({ key: 3, name: '', action: 'element 3' }),
        control({ key: 4, name: '', action: 'element 4' }),
      ]),
    ).toEqual([]);
  });
});

describe('linkAction', () => {
  const origin = 'http://localhost:8790';

  it('drops the origin and a trailing slash, and keeps the hash', () => {
    expect(linkAction('http://localhost:8790/products/', origin)).toBe('link /products');
    expect(linkAction('http://localhost:8790/account#delete', origin)).toBe('link /account#delete');
  });

  it('keeps another origin whole', () => {
    expect(linkAction('https://example.com/a', origin)).toBe('link https://example.com/a');
  });
});

describe('input purpose', () => {
  it('reads the field-name token of an autocomplete value', () => {
    expect(autocompleteField('section-a shipping email')).toBe('email');
    expect(autocompleteField(' WORK  Tel ')).toBe('tel');
    expect(autocompleteField('off')).toBe('off');
    expect(autocompleteField(null)).toBeNull();
  });

  it('finds the purpose from the name first, then the attributes', () => {
    expect(purposeOf(field('Email address'))?.tokens).toEqual(['email']);
    expect(purposeOf(field('Your firm (optional)'))?.tokens).toEqual(['organization']);
    expect(purposeOf(field('Display name'))?.tokens).toContain('nickname');
    expect(purposeOf(field('Contact', { nameAttr: 'workEmail' }))?.tokens).toEqual(['email']);
    expect(purposeOf(field('Contact', { type: 'email' }))?.tokens).toEqual(['email']);
  });

  it('gives no purpose to a search box, a headline, a size or a non-text field', () => {
    expect(purposeOf(field('Search'))).toBeNull();
    expect(purposeOf(field('Headline'))).toBeNull();
    expect(purposeOf(field('Company size'))).toBeNull();
    expect(purposeOf(field('Email me', { type: 'checkbox' }))).toBeNull();
    expect(purposeOf(control({ name: 'Email' }))).toBeNull();
  });

  it('passes a field with the right token, and fails none, off and a wrong one', () => {
    expect(inputPurposeProblems([field('Email', { autocomplete: 'email' })])).toEqual([]);
    expect(inputPurposeProblems([field('Email', { autocomplete: 'work email' })])).toEqual([]);
    expect(inputPurposeProblems([field('Email', {}, 1)])).toEqual([
      'input purpose: textbox "Email" in main collects an email address, wants autocomplete="email", has none',
    ]);
    expect(inputPurposeProblems([field('Email', { autocomplete: 'off' })])[0]).toMatch(
      /has "off"$/,
    );
    expect(inputPurposeProblems([field('Email', { autocomplete: 'name' })])[0]).toMatch(
      /has "name"$/,
    );
  });
});

describe('judgedFields', () => {
  it('lists every text field with the purpose it was held to, and the ones with none', () => {
    const judged = judgedFields([
      field('Email address', { type: 'email', autocomplete: 'email' }, 1),
      field('Your firm (optional)', {}, 2),
      field('Search', {}, 3),
      field('Find', { type: 'search' }, 4),
      control({ key: 5 }),
    ]);
    expect(judged).toEqual([
      {
        field: 'Email address',
        type: 'email',
        landmark: 'main',
        purpose: 'an email address',
        wants: 'email',
        has: 'email',
        ok: true,
      },
      {
        field: 'Your firm (optional)',
        type: 'text',
        landmark: 'main',
        purpose: 'an organisation',
        wants: 'organization',
        has: null,
        ok: false,
      },
      {
        field: 'Search',
        type: 'text',
        landmark: 'main',
        purpose: null,
        wants: null,
        has: null,
        ok: true,
      },
      {
        field: 'Find',
        type: 'search',
        landmark: 'main',
        purpose: null,
        wants: null,
        has: null,
        ok: true,
      },
    ]);
  });

  it('agrees with inputPurposeProblems on which fields fail', () => {
    const controls = [field('Email', {}, 1), field('Email', { autocomplete: 'email' }, 2)];
    expect(judgedFields(controls).filter((f) => !f.ok)).toHaveLength(
      inputPurposeProblems(controls).length,
    );
  });
});

describe('effort', () => {
  it('allows three presses, or a fifth of the baseline when that is more', () => {
    expect(effortMargin(8)).toBe(3);
    expect(effortMargin(15)).toBe(3);
    expect(effortMargin(16)).toBe(4);
    expect(effortMargin(38)).toBe(8);
  });

  it('fails only above the margin or when the action is not reached', () => {
    expect(effortVerdict(10, 10)).toBe('same');
    expect(effortVerdict(8, 10)).toBe('fewer');
    expect(effortVerdict(13, 10)).toBe('more');
    expect(effortVerdict(14, 10)).toBe('over-margin');
    expect(effortVerdict(null, 10)).toBe('not-reached');
  });
});
