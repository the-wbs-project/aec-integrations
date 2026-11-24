import { describe, expect, it } from 'vitest';
import {
  collectPageFacts,
  inconsistentNameProblems,
  maskAriaSnapshot,
  namesConsistent,
  sharedNameProblems,
  structureProblems,
  titleProblems,
  type AriaNode,
} from './aria-tree';

// AECI-1879: the rules the ARIA nightly judges a page by. The browser half only
// reads the tree, so a wrong rule here is a false result in the nightly.

const heading = (level: number, name: string): AriaNode => ({ role: 'heading', level, name });
const link = (name: string, url: string): AriaNode => ({ role: 'link', name, url });

function page(
  main: AriaNode[],
  extra: { banner?: AriaNode[]; footer?: AriaNode[] } = {},
): AriaNode[] {
  return [
    {
      role: 'banner',
      children: [
        { role: 'search', name: 'Site search', children: [{ role: 'combobox', name: 'Search' }] },
        { role: 'navigation', name: 'Primary', children: [link('Browse', '/products')] },
        ...(extra.banner ?? []),
      ],
    },
    { role: 'main', children: main },
    { role: 'contentinfo', children: [link('Home', '/'), ...(extra.footer ?? [])] },
  ];
}

describe('collectPageFacts', () => {
  it('records each link with the landmark it sits in', () => {
    const facts = collectPageFacts(page([link('Fixture Procore', '/products/fixture-procore')]));
    expect(facts.links).toEqual([
      { name: 'Browse', url: '/products', region: 'banner' },
      { name: 'Fixture Procore', url: '/products/fixture-procore', region: 'main' },
      { name: 'Home', url: '/', region: 'contentinfo' },
    ]);
  });

  it('counts the links inside each landmark, nested ones included', () => {
    const facts = collectPageFacts(page([]));
    expect(facts.landmarks.map((l) => [l.role, l.name, l.links])).toEqual([
      ['banner', '', 1],
      ['search', 'Site search', 0],
      ['navigation', 'Primary', 1],
      ['main', '', 0],
      ['contentinfo', '', 1],
    ]);
  });
});

describe('structureProblems', () => {
  it('passes one h1 followed by deeper levels one step at a time', () => {
    const tree = page([heading(1, 'Title'), heading(2, 'A'), heading(3, 'A.1'), heading(2, 'B')]);
    expect(structureProblems(collectPageFacts(tree))).toEqual([]);
  });

  it('reports no h1, two h1s, and a skipped level', () => {
    expect(structureProblems(collectPageFacts(page([heading(2, 'A')])))).toEqual([
      'the page has 0 h1 headings, not one',
      'h2 "A" follows h(none), skipping a level',
    ]);
    expect(structureProblems(collectPageFacts(page([heading(1, 'A'), heading(1, 'B')])))).toEqual([
      'the page has 2 h1 headings, not one: "A", "B"',
    ]);
    expect(structureProblems(collectPageFacts(page([heading(1, 'A'), heading(3, 'C')])))).toEqual([
      'h3 "C" follows h1, skipping a level',
    ]);
  });

  it('reports a missing landmark and a navigation or search landmark without a unique name', () => {
    const tree: AriaNode[] = [
      { role: 'main', children: [heading(1, 'Title')] },
      { role: 'navigation', name: 'Primary' },
      { role: 'navigation', name: 'primary' },
      { role: 'search' },
    ];
    expect(structureProblems(collectPageFacts(tree))).toEqual([
      'no banner landmark',
      'no contentinfo landmark',
      'two navigation landmarks are both named "primary"',
      'a search landmark has no name',
    ]);
  });
});

describe('sharedNameProblems', () => {
  it('reports one name that points to two targets, the AECI-830 shape', () => {
    const facts = collectPageFacts(
      page([link('Source', 'https://a.example/'), link('Source', 'https://b.example/')]),
    );
    expect(sharedNameProblems(facts.links)).toEqual([
      '"Source" links to https://a.example and https://b.example',
    ]);
  });

  it('treats case, spacing, and a trailing slash as the same', () => {
    const facts = collectPageFacts(
      page([link('Suggest a correction', '/c'), link('suggest  a correction', '/c/')]),
    );
    expect(sharedNameProblems(facts.links)).toEqual([]);
  });
});

describe('maskAriaSnapshot', () => {
  it('masks counts, dates, and relative times in names and text', () => {
    const yaml = [
      '- link "Zz Fixture Category Alpha 8 products":',
      '- text: Updated 3 days ago on Nov 24, 2026',
      '- paragraph: 2026-11-24',
      '- definition: Nov 24, 2026, 4:24:46 PM',
    ].join('\n');
    expect(maskAriaSnapshot(yaml)).toBe(
      [
        '- link "Zz Fixture Category Alpha <n> products":',
        '- text: Updated <ago> on <date>',
        '- paragraph: <date>',
        '- definition: <date>, <time>',
        '',
      ].join('\n'),
    );
  });

  it('keeps heading levels and link targets, apart from a UUID and the return page', () => {
    const yaml = [
      '- heading "Step 2" [level=2]',
      '- /url: /products/fixture-procore',
      '- /url: /integrations/00000000-0000-4000-8000-000000000065',
      '- /url: /auth/login?return=%2Fproducts',
      '- /url: /auth/login?a=1&return=%2Fproducts&b=2',
    ].join('\n');
    expect(maskAriaSnapshot(yaml)).toBe(
      [
        '- heading "Step <n>" [level=2]',
        '- /url: /products/fixture-procore',
        '- /url: /integrations/<uuid>',
        '- /url: /auth/login',
        '- /url: /auth/login?a=1&b=2',
        '',
      ].join('\n'),
    );
  });
});

describe('the cross-page rules', () => {
  it('names agree when one holds every word of the other', () => {
    // Equal once masked and case-folded.
    expect(namesConsistent('Suggest a correction', 'suggest a correction')).toBe(true);
    // A name followed by a count.
    expect(namesConsistent('Project Management 2 products', 'Project Management')).toBe(true);
    // A name followed by a description.
    expect(namesConsistent('Trades Tools built for the work you sell.', 'Trades')).toBe(true);
    // The accepted leads: "View all", "View" and "Back to".
    expect(namesConsistent('View all categories', 'Categories')).toBe(true);
    expect(namesConsistent('View all trades', 'Trades Tools built for the work you sell.')).toBe(
      true,
    );
    expect(namesConsistent('View Fixture Procore', 'Fixture Procore')).toBe(true);
    expect(
      namesConsistent('← Back to Fixture Procore Technologies', 'Fixture Procore Technologies'),
    ).toBe(true);
  });

  it('names disagree when either has a word the other lacks', () => {
    // AECI-2087: one shared word is not enough.
    expect(namesConsistent('Vendor portal', 'Vendor Overview')).toBe(false);
    expect(namesConsistent('Vendor portal', 'Fixture Procore Technologies')).toBe(false);
    // AECI-2078: a different word ending is a different word.
    expect(namesConsistent('General contractors 4 products', 'General Contracting')).toBe(false);
    expect(namesConsistent('Estimators 4 products', 'Estimator')).toBe(false);
    expect(namesConsistent('Subcontractors 3 products', 'Specialty Contracting')).toBe(false);
    // A lead is accepted only in front of a name, never as the whole name.
    expect(namesConsistent('View all', 'See more')).toBe(false);
    expect(namesConsistent('View', 'Fixture Procore')).toBe(false);
  });

  it('compares a target within one landmark only', () => {
    const problems = inconsistentNameProblems([
      { page: '/', url: '/audiences/architecture', name: 'Architects 1 products', region: 'main' },
      { page: '/audiences', url: '/audiences/architecture', name: 'Architecture', region: 'main' },
      { page: '/', url: '/products', name: 'Browse', region: 'banner' },
      { page: '/', url: '/products', name: 'Products', region: 'contentinfo' },
    ]);
    expect(problems).toEqual([
      '/audiences/architecture (in main) is named "Architects 1 products" on /, "Architecture" on /audiences',
    ]);
  });

  it('reports an empty title and a title two pages share', () => {
    expect(
      titleProblems([
        { page: '/a', title: 'A' },
        { page: '/b', title: ' ' },
        { page: '/c', title: 'A' },
      ]),
    ).toEqual(['/b has no title', '"A" is the title of /a, /c']);
  });
});
