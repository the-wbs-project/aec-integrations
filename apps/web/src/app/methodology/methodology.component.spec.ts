/**
 * AECI-804 — `/methodology`, the editorial methodology page.
 *
 * Lives in the `*.component.spec.ts` tier (the Angular `ng test` builder) rather
 * than plain Vitest deliberately: the component pulls in `methodology-content.ts`,
 * which `import`s a `.md`, and only the Angular build carries the esbuild `text`
 * loader. A plain `*.spec.ts` here would fail to resolve the import.
 *
 * The interesting assertions are the honesty ones. AC2 on the issue is "every
 * assertion traceable to a shipped behaviour", and the two ways this page can
 * silently rot are (a) losing the "not yet reachable" qualifier on the agreement
 * ladder, which would leave the four states reading as an observed state, and
 * (b) acquiring ranking-signal copy, which `STAGE_2_5_SPEC.md` §2 step 3 parks on
 * the AECI-636 ranking-method page. Both are pinned below.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';

import { MethodologyPage } from './methodology';

function setup(): { host: HTMLElement; title: Title } {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(MethodologyPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

describe('MethodologyPage', () => {
  // The Angular vitest builder shares one jsdom document across every
  // *.component.spec.ts and never resets <head>. Sibling specs write
  // `<meta name="robots" content="noindex">` and don't clean up, so strip any
  // lingering tag first — same hygiene as about.component.spec.ts. Without this
  // the indexable-page assertion below fails purely on run order.
  beforeEach(() => {
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('renders the frontmatter title as the only h1', () => {
    const { host } = setup();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent?.trim()).toBe(
      'How we research and verify listings',
    );
  });

  it('renders the Markdown body into .aec-prose in a valid heading order', () => {
    const { host } = setup();
    const article = host.querySelector('article.aec-prose');
    expect(article).not.toBeNull();
    // The six questions the issue says a reader actually asks, in order.
    const h2s = Array.from(article!.querySelectorAll('h2')).map((h) => h.textContent?.trim());
    expect(h2s).toEqual([
      'What we list, and why',
      'Where the data comes from',
      'What verification means',
      'Who owns an integration',
      'No pay-for-placement',
      'Reviews',
      'Corrections and disputes',
      'Who is responsible',
    ]);
  });

  it('describes all four agreement states using the labels the badge actually renders', () => {
    const { host } = setup();
    const text = host.textContent ?? '';
    // These four strings are the visible labels in products/agreement-badge.ts.
    // If that component's copy changes, this page has to change with it, which
    // is the drift this assertion exists to catch.
    expect(text).toContain('Unverified · AECi');
    expect(text).toContain('Confirmed by');
    expect(text).toContain('Both vendors confirmed');
    expect(text).toContain('Vendors disagree');
  });

  it('qualifies the agreement ladder as not yet reachable (AC2: no aspirational claims)', () => {
    const { host } = setup();
    const text = host.textContent ?? '';
    expect(text).toContain('Those accounts are only now being opened to vendors');
    expect(text).toContain('almost every claim and integration on the site is still recorded by');
  });

  // AECI-1023. The ownership model of ADR 0035 / AECI-1003, in the reader's words.
  // Each sentence pinned here maps to one shipped rule, so a change to the rule
  // has to come back and change the page on purpose.
  describe('who owns an integration (AECI-1023)', () => {
    it('names the owner as the "Offered by" vendor and says AECi seeds', () => {
      const text = setup().host.textContent ?? '';
      expect(text).toContain('An integration belongs to the vendor that offers it');
      expect(text).toContain('"Offered by" line');
      expect(text).toContain('We seeded the catalogue.');
    });

    it('says a claim needs no approval and fences our updates off the row (decisions 1 and 5)', () => {
      const text = setup().host.textContent ?? '';
      expect(text).toContain('There is no approval step');
      expect(text).toContain(
        'Once an integration is claimed, the updates we publish from our research stop reaching it',
      );
      expect(text).toContain('each edit goes live without review by us');
    });

    it('routes contests the way the code does, owner field always to AECi (§11b.4)', () => {
      const text = setup().host.textContent ?? '';
      expect(text).toContain('If the owner has claimed it, the owner decides.');
      expect(text).toContain('If it has not been claimed, we decide.');
      expect(text).toContain(
        'A contest about who owns the integration always comes to us, even after a claim',
      );
      expect(text).toContain('A contest stays with whoever was deciding when it was sent.');
    });

    it('says an open contest is invisible to readers (§11b.1: nothing public reads it)', () => {
      const text = setup().host.textContent ?? '';
      expect(text).toContain(
        'the page keeps showing the value on record and does not say a contest exists',
      );
    });

    it('separates retire from delete and says restore does not reopen contests (§4.6)', () => {
      const text = setup().host.textContent ?? '';
      expect(text).toContain('Retiring is not deleting.');
      expect(text).toContain('Nothing is deleted.');
      expect(text).toContain('restoring it does not reopen them');
      expect(text).toContain('our catalogue tools refuse to delete an integration a vendor holds');
      // Scoped to today on purpose: an admin retire path is filed as its own
      // issue, so the page must not promise AECi never retires one.
      expect(text).toContain('Today, only the owner retires or restores an integration.');
      expect(text).not.toContain('We never retire');
    });

    it('says vendor-created integrations exist and are not researched by us', () => {
      const text = setup().host.textContent ?? '';
      expect(text).toContain('An owner can also add an integration we have not recorded.');
      expect(text).toContain('We did not research it');
    });

    it('keeps connector-delivered integrations out of every vendor write (decision 9)', () => {
      const text = setup().host.textContent ?? '';
      expect(text).toContain(
        'no vendor can yet claim, edit, retire, add, or put its own links on the integration',
      );
    });

    it('no longer says AECi is the source of every claim', () => {
      const text = setup().host.textContent ?? '';
      expect(text).not.toContain('currently the source of every claim');
      expect(text).not.toContain('Nothing reaches the public catalogue on its own');
    });

    it('does not add ownership to the paid-plan list (decision 15: a seat is the gate)', () => {
      const { host } = setup();
      const text = host.textContent ?? '';
      // The plan list is exactly four items, and claiming, editing and
      // contesting are seat-gated, so none of them may appear in it.
      const planList = Array.from(host.querySelectorAll('li'))
        .map((li) => li.textContent?.trim() ?? '')
        .filter((line) =>
          /^(what a vendor may edit|whether (a vendor|the)|how far back)/.test(line),
        );
      expect(planList).toHaveLength(4);
      expect(planList.join(' ')).not.toMatch(/claim an integration|contest/i);
      expect(text).toContain('this is the complete list');
    });
  });

  it('states the no-pay-for-placement rule without naming a ranking signal', () => {
    const { host } = setup();
    const text = host.textContent ?? '';
    expect(text).toContain('Position is never for sale');
    // STAGE_2_5_SPEC.md §2 step 3 parks the plain-language ranking-signal copy on
    // the AECI-636 ranking-method page, because naming signals now would publish
    // `integration_count` — the signal that overhaul retires. Keep this page on
    // the RULE only.
    for (const signal of ['integration_count', 'review_count', 'listing_tier', 'evidence_tier']) {
      expect(text, `must not name the ranking signal ${signal}`).not.toContain(signal);
    }
  });

  it('discloses that a vendor plan reaches one reader-visible surface', () => {
    const { host } = setup();
    const text = host.textContent ?? '';
    // `integration.version_diff` gates historical diff depth on the PUBLIC pair
    // page, keyed on the pair's vendors (`packages/shared/src/version-diff.ts`).
    // It is the only capability an anonymous reader can feel, so a paid-plan
    // section that lists only vendor-facing effects would understate. Both halves
    // are pinned: that it happens, and that the current state stays free.
    expect(text).toContain('how far back the version history on an integration page goes');
    expect(text).toContain('The current state of an integration is always shown in full');
  });

  it('renders the maintainer and both contact routes', () => {
    const { host } = setup();
    expect(host.textContent).toContain('The WBS Project');
    const hrefs = Array.from(host.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('mailto:founders@thewbsproject.com');
    expect(hrefs).toContain('mailto:reviews@thewbsproject.com');
    expect(hrefs).toContain('/contact');
  });

  it('links out to the two legal policies it defers to', () => {
    const { host } = setup();
    const hrefs = Array.from(host.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/legal/listing-accuracy');
    expect(hrefs).toContain('/legal/review-guidelines');
  });

  it('sets an indexable static-page title (no noindex robots tag)', () => {
    const { title } = setup();
    expect(title.getTitle()).toBe('How we research and verify listings · AEC Integrations');
    // This page is the citable trust surface — a noindex here would defeat it.
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
  });
});
