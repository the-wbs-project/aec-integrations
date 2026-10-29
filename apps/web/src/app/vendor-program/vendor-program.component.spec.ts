import {
  PLATFORM_ID,
  TransferState,
  makeStateKey,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MANAGED_ANNUAL_PRICE_CENTS, MANAGED_LIST_PRICE_CENTS } from '@aeci/shared/entitlements';

import { Analytics } from '../analytics/analytics';
import { SessionStatus } from '../auth/session-status';
import { VendorApi } from '../vendor/vendor-api';
import { VendorPlanStatus } from '../vendor/vendor-plan-status';
import { VendorStatus } from '../vendor/vendor-status';
import { ClaimDialogService } from '../shared/claim-dialog/claim-dialog.service';
import { VendorProgramPage } from './vendor-program';

/**
 * `/vendor-program` (`docs/VENDOR_PROGRAM_PAGE_SPEC.md`). AECI-1283 owns the meta
 * and the anchor. AECI-1284 owns the sections in the §3 order and the §8 copy
 * rules. AECI-1285's placements are wired here with this page's targets. AECI-1286
 * owns the signed-in variants, applied only after the first browser render.
 * Find your product was removed on 2026-10-12: the claim dialog's Find step
 * (`shared/claim-dialog/`) replaces it, and its specs pin that step.
 */

/** A `VendorPlanStatus` stand-in: `null` is the signed-out (and SSR) default. */
interface PlanStatusStub {
  vendorSlug: ReturnType<typeof signal<string | null>>;
  managed: ReturnType<typeof signal<boolean | null>>;
}

function stub(state: 'signed-out' | 'free' | 'managed' = 'signed-out'): PlanStatusStub {
  const vendor = state !== 'signed-out';
  return {
    vendorSlug: signal(vendor ? 'acme' : null),
    managed: signal(vendor ? state === 'managed' : null),
  };
}

async function setup(
  opts: { plan?: PlanStatusStub; platform?: 'browser' | 'server'; providers?: unknown[] } = {},
) {
  const planCtaClicked = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', children: [] }]),
      { provide: Analytics, useValue: { planCtaClicked } },
      ...(opts.plan ? [{ provide: VendorPlanStatus, useValue: opts.plan }] : []),
      ...(opts.platform === 'server' ? [{ provide: PLATFORM_ID, useValue: 'server' }] : []),
      ...((opts.providers ?? []) as never[]),
    ],
  });
  const fixture = TestBed.createComponent(VendorProgramPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    title: TestBed.inject(Title),
    planCtaClicked,
  };
}

const content = (selector: string): string | null | undefined =>
  document.head.querySelector(selector)?.getAttribute('content');

const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The page's links whose visible text is exactly `label`. */
const links = (host: HTMLElement, label: string): HTMLAnchorElement[] =>
  [...host.querySelectorAll('a')].filter((a) => text(a) === label);

describe('VendorProgramPage', () => {
  // The vitest builder shares one jsdom document across component specs and never
  // resets <head>. Siblings leave a noindex robots tag behind, so strip it first
  // (the `about.component.spec.ts` hygiene).
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  describe('meta and hero (AECI-1283)', () => {
    it('renders one h1 saying the products may already be listed, with a free claim', async () => {
      const { host } = await setup({ plan: stub() });
      const h1s = host.querySelectorAll('h1');
      expect(h1s).toHaveLength(1);
      expect(text(h1s[0])).toBe(
        'Your products may already be listed here. Make sure buyers read your version.',
      );
      expect(text(host.querySelector('section'))).toContain(
        'Claim your listing, free, so what they read is current, complete and in your words.',
      );
    });

    it('states no statistics in the hero', async () => {
      const { host } = await setup({ plan: stub() });
      // The step discs of "How claiming works" are ordinals, hidden from assistive
      // tech (the list itself is numbered). Everything else carries no digit.
      const hero = host.querySelector('section')!.cloneNode(true) as HTMLElement;
      hero.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      expect(hero.textContent).not.toMatch(/\d/);
    });

    it('sets indexable meta with a canonical and the absolute share card', async () => {
      const { title } = await setup({ plan: stub() });
      expect(title.getTitle()).toBe('List your AEC software for free · AEC Integrations');
      expect(document.querySelector('meta[name="robots"]')).toBeNull();

      const canonical = document.head.querySelector('link[rel="canonical"]')?.getAttribute('href');
      expect(canonical).toMatch(/^https?:\/\/[^/]+\/vendor-program$/);

      const origin = new URL(canonical!).origin;
      expect(content('meta[property="og:image"]')).toBe(`${origin}/branding/vendor-program-og.png`);
      expect(content('meta[property="og:image:alt"]')).toBeTruthy();
      expect(content('meta[name="twitter:image:alt"]')).toBeTruthy();
    });

    it('publishes the list price as structured data, from the shared constants', async () => {
      await setup({ plan: stub() });
      const script = document.head.querySelector(
        'script[type="application/ld+json"][data-aeci-jsonld="plan"]',
      );
      const ld = JSON.parse(script!.textContent!);
      expect(ld['@type']).toBe('Service');
      expect(ld.url).toMatch(/^https?:\/\/[^/]+\/vendor-program$/);
      expect(
        ld.offers.map((o: { price: string; priceSpecification: { billingDuration: string } }) => [
          o.price,
          o.priceSpecification.billingDuration,
        ]),
      ).toEqual([
        [(MANAGED_LIST_PRICE_CENTS / 100).toFixed(2), 'P1M'],
        [(MANAGED_ANNUAL_PRICE_CENTS / 100).toFixed(2), 'P1Y'],
      ]);
      expect(JSON.stringify(ld)).not.toMatch(/founding|pilot|discount/i);
    });

    it('puts the target searches in the description, not a price', async () => {
      await setup({ plan: stub() });
      const description = content('meta[name="description"]') ?? '';
      expect(description).toContain('AEC software directory');
      expect(description).toContain('construction software integrations');
      expect(description).not.toContain('$');
    });
  });

  describe('sections and copy (AECI-1284)', () => {
    it('renders one h1, then one h2 per section, in the section 3 order', async () => {
      const { host } = await setup({ plan: stub() });
      const headings = [...host.querySelectorAll('h1, h2')].map((h) => `${h.tagName}:${text(h)}`);
      expect(headings).toEqual([
        'H1:Your products may already be listed here. Make sure buyers read your version.',
        'H2:What changes when you claim',
        'H2:What a free claim gets you',
        'H2:What Managed adds',
        'H2:Free and Managed',
        'H2:How listings are sorted',
        'H2:Questions vendors ask',
        'H2:Tell the full story of your product',
      ]);
      // Only the plan cards sit one level down. Free and Managed have no subgroup
      // headings (2026-10-12).
      expect([...host.querySelectorAll('h3')].map(text)).toEqual(['Free', 'Managed']);
    });

    it('drops Find your product: the claim dialog starts with Find it', async () => {
      const { host } = await setup({ plan: stub() });
      expect(host.querySelector('#find-your-product')).toBeNull();
      expect(host.querySelector('aec-search-autocomplete')).toBeNull();
      // Step 1 of "How claiming works" no longer says "on this page".
      expect(text(host.querySelector('[data-testid="vp-how"] li'))).toContain(
        'Find your product Start your claim here, or press Claim on any of your product pages, then search for your product or your company.',
      );
    });

    // Ruling 2026-10-12: Free and Managed are one pattern. The same split, and the
    // same item: a plain title, the body, then "Learn more" when there is a docs page.
    it('builds Free and Managed from the same section layout and item', async () => {
      const { host } = await setup({ plan: stub() });
      const free = host.querySelector('#vp-free')!;
      const managed = host.querySelector('#vp-managed')!;
      expect(free.className).toBe(managed.className);
      expect(free.querySelector(':scope > div')!.className).toBe(
        managed.querySelector(':scope > div')!.className,
      );
      expect(free.querySelector(':scope > ul')!.className).toBe(
        managed.querySelector(':scope > ul')!.className,
      );
      expect(free.querySelector(':scope > ul')!.classList).toContain('md:grid-cols-2');
      const titles = (section: Element) =>
        [...section.querySelectorAll('li > p:first-child')].map((p) => {
          // A plain title: no link, not a heading.
          expect(p.querySelector('a')).toBeNull();
          expect(p.classList).toContain('font-semibold');
          return text(p);
        });
      expect(titles(free)).toEqual([
        'Your listing, in your words',
        'Your integrations, owned by you',
        'A complete listing, at no cost',
      ]);
      expect(titles(managed)).toEqual([
        'How teams use it',
        'Trades, audiences and phases',
        'Integration detail buyers can check',
        'Review replies',
      ]);
      // Ruled 2026-10-12: the integration detail body, reworded for clarity.
      const detail = text(managed.querySelectorAll('li')[2]);
      expect(detail).toContain(
        "Link evaluators to your integrations page and API docs. Confirm which data each integration moves, and your answer counts the same as your partner's. Buyers can check what an integration syncs before they rely on it for a project.",
      );
      // Every line is the one shared item: the same host classes on both sections.
      const itemClasses = new Set(
        [...free.querySelectorAll('li'), ...managed.querySelectorAll('li')].map(
          (li) => li.className,
        ),
      );
      expect(itemClasses.size).toBe(1);
      for (const li of [...free.querySelectorAll('li'), ...managed.querySelectorAll('li')]) {
        expect(li.hasAttribute('aec-vendor-program-benefit')).toBe(true);
      }
    });

    it('ends each Managed line with "Learn more" to the page that explains it', async () => {
      const { host } = await setup({ plan: stub() });
      const items = [...host.querySelectorAll('#vp-managed li')];
      // Ruling 2026-10-12: connector integrations left the Managed pitch.
      expect(items).toHaveLength(4);
      const more = items.map((li) => li.querySelector('[data-testid="vp-learn-more"]')!);
      for (const [i, a] of more.entries()) {
        // The last thing in the line, named by the title for a links list.
        expect(items[i]!.lastElementChild?.contains(a)).toBe(true);
        expect(text(a)).toMatch(/^Learn more: /);
        expect(text(a)).toContain(text(items[i]!.querySelector('p')));
        expect(text(a)).toContain('(opens in a new tab)');
      }
      const hrefs = more.map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual([
        '/docs/vendors/plans#what-managed-adds',
        '/docs/getting-started/taxonomy',
        '/docs/vendors/plans#what-managed-adds',
        '/docs/vendors/replying-to-reviews',
      ]);
      // Ruling 2026-10-12: the links line and the data flows line are one entry.
      // Copy pass 2026-10-24: the in-text "Confirming integration data" link is gone,
      // and "Learn more" is the entry's one link.
      const detail = items[2]!;
      expect([...detail.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
        '/docs/vendors/plans#what-managed-adds',
      ]);
      // Copy pass 2026-10-12: the section's own lede, then the shared terms line.
      // E8.2 (2026-10-19): the monthly term and refund beside the price, then annual renewal.
      const intro = [...host.querySelectorAll('#vp-managed > div > p')];
      expect(text(intro[0])).toMatch(
        /^Managed is for products that need more than a corrected listing/,
      );
      expect(text(intro[1])).toBe(
        '$25 USD a month or $250 USD a year per product. Monthly has no commitment: cancel any time. We refund in full if you ask within 14 days of the first charge.',
      );
      expect(text(intro[2])).toBe(
        'An annual license renews each year unless you opt out before the renewal date. Thirty days before that date, we email every seat and your billing email the date, the price, the license count and any change to the terms. A new price never applies mid-term.',
      );
    });

    it('keeps the Free links to the seat and checklist pages', async () => {
      const { host } = await setup({ plan: stub() });
      const hrefs = [...host.querySelectorAll('#vp-free a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(['/docs/vendors/your-seat', '/docs/vendors/checklists']);
      expect(host.querySelectorAll('#vp-free li')).toHaveLength(3);
      // No Free line has a docs page of its own, so none ends in "Learn more".
      expect(host.querySelector('#vp-free [data-testid="vp-learn-more"]')).toBeNull();
    });

    // A cached copy carries the server's day. The browser must not redraw it.
    it('takes the example date from the server through TransferState', async () => {
      const key = makeStateKey<string>('aeci.vendor-program.example-updated-at');
      const server = await setup({ platform: 'server' });
      const serverValue = (
        server.fixture.componentInstance as unknown as { exampleUpdatedAt: string }
      ).exampleUpdatedAt;
      expect(TestBed.inject(TransferState).get(key, null)).toBe(serverValue);

      TestBed.resetTestingModule();
      const transferred = new TransferState();
      transferred.set(key, '2026-01-02T03:04:05.000Z');
      const browser = await setup({
        providers: [{ provide: TransferState, useValue: transferred }],
      });
      expect(
        (browser.fixture.componentInstance as unknown as { exampleUpdatedAt: string })
          .exampleUpdatedAt,
      ).toBe('2026-01-02T03:04:05.000Z');
    });

    it('shows the real maintenance labels before and after a claim', async () => {
      const { host } = await setup({ plan: stub() });
      const before = host.querySelector('[data-testid="vp-before"] aec-maintenance-marker');
      const after = host.querySelector('[data-testid="vp-after"] aec-maintenance-marker');
      expect(text(before)).toBe('AEC Integrations maintained');
      expect(text(after)).toMatch(/^Vendor maintained · Updated [A-Z][a-z]+ \d{1,2}, \d{4}$/);
    });

    // Ruling 2026-10-12: every docs link opens in a new tab
    // with the drawn cue and the sr-only note. Conversion links stay in the tab.
    it('opens every docs link in a new tab with the new-tab cue', async () => {
      const { host } = await setup({ plan: stub() });
      const docs = [...host.querySelectorAll<HTMLAnchorElement>('a[href^="/docs/"]')];
      expect(docs.length).toBe(11);
      for (const a of docs) {
        const href = a.getAttribute('href');
        expect(a.getAttribute('target'), href!).toBe('_blank');
        expect(a.getAttribute('rel'), href!).toBe('noopener');
        expect(a.querySelector('aec-new-tab-icon svg[aria-hidden="true"]'), href!).not.toBeNull();
        expect(text(a), href!).toContain('(opens in a new tab)');
      }
      // Every other link on the page stays in the tab.
      for (const a of host.querySelectorAll('a:not([href^="/docs/"])')) {
        expect(a.getAttribute('target'), a.getAttribute('href')!).toBeNull();
      }
    });

    it('states the sort rule as the reason to trust the order, linked to how ranking works', async () => {
      const { host } = await setup({ plan: stub() });
      const sorting = host.querySelector('#vp-sorting');
      expect(text(sorting)).toContain(
        'Every listing is sorted by the same published rules. Your plan is not part of that.',
      );
      expect(text(sorting)).toContain('That is why buyers trust what they find here');
      expect(sorting?.querySelector('a')?.getAttribute('href')).toBe(
        '/docs/trust/how-ranking-works',
      );
    });

    it('answers the FAQ in a native details list', async () => {
      const { host } = await setup({ plan: stub() });
      const faq = [...host.querySelectorAll('#vp-faq details')];
      expect(faq.map((d) => text(d.querySelector('summary')))).toEqual([
        'Who can claim a listing?',
        'What happens after I send a claim?',
        'We make several products. Do we claim each one?',
        'What does Managed cost?',
        'Can we cancel a Managed plan early?',
        'What happens when a Managed plan ends?',
        'Does paying affect our reviews or where we rank?',
      ]);
      // E8.2 (2026-10-19): no claim timing, a per-product license, both prices, the
      // monthly cancel answer, and the per-product end.
      // The visible answer, without the link's screen-reader-only new-tab note.
      const answer = (d: Element) => text(d.querySelector('p')).replace('(opens in a new tab)', '');
      expect(answer(faq[1])).toBe('A person reviews every claim and emails you the result.');
      expect(answer(faq[2])).toBe(
        "No. One claim gives you a seat on your company's account, and it covers every product your company makes. Managed is licensed per product. An owner buys licenses on the Billing tab and assigns one to each product you want on Managed.",
      );
      expect(answer(faq[3])).toBe(
        'Managed costs $25 USD a month or $250 USD a year per product. Monthly has no commitment: cancel any time. An annual license renews each year unless you opt out before the renewal date. We refund in full if you ask within 14 days of the first charge. You pay by card through Stripe, from the Billing tab.',
      );
      expect(answer(faq[4])).toBe(
        'Yes, on the monthly plan. Monthly has no commitment: cancel any time, and your licenses run to the end of the month you paid for. An annual license runs to its renewal date. If you opt out of renewal, it ends on that date.',
      );
      expect(answer(faq[5])).toBe(
        'Each product whose license ends moves to Free. Your seats, sign-in and portal stay. Nothing you entered is removed, and your listings stay published. The Managed fields stay just as you left them. See when a Managed plan ends.',
      );
    });

    // Section 8: the firewall and the copy rules, checked across the whole page.
    it('keeps to the copy rules: no em dashes, "may already be listed", no ranking promise', async () => {
      const { host } = await setup({ plan: stub() });
      const body = text(host);
      expect(body).not.toContain('—');
      expect(body).toContain('may already be listed');
      expect(body).not.toMatch(/are already listed/i);
      expect(body).not.toMatch(/vendor-verified/i);
      expect(body).not.toMatch(/rank (higher|better)|boost|top of|featured|priority placement/i);
      expect(body).not.toMatch(/AECi\b/);
      // E8.2 acceptance: no invoice or purchase order, claim timing, one-year term,
      // pilot, plan question or silence rule on the page. Card payment is named since
      // AECI-1396.
      expect(body).not.toMatch(
        /invoice or purchase order|48 hours|two days|one-year term|pilot|which plan you want|silence/i,
      );
    });
  });

  describe('calls to action (AECI-1285 placements)', () => {
    it('mounts the hero button, the cards, the phone bar, the panel and one claim dialog host', async () => {
      const { host } = await setup({ plan: stub() });
      const hero = host.querySelector('section')!;
      expect(hero.querySelector('aec-plan-cta-actions')).not.toBeNull();
      for (const tag of ['aec-plan-cards', 'aec-plan-cta-mobile-bar', 'aec-plan-cta-panel']) {
        expect(host.querySelectorAll(tag), tag).toHaveLength(1);
      }
      expect(host.querySelectorAll('aec-claim-dialog-host')).toHaveLength(1);
      // E8.1: the plan inquiry dialog is gone.
      expect(host.querySelector('aec-plan-inquiry-host')).toBeNull();
      // The cards count as a full call to action for the phone bar.
      expect(host.querySelector('aec-plan-cards')?.getAttribute('data-plans-cta')).toBe('card');
    });

    // AECI-1293 (spec §15.1): every main control reads "Claim your listing" and opens
    // the one claim dialog; without JS it lands on the search page (2026-10-12).
    it('labels every claim control "Claim your listing", with the search page as the no-JS target', async () => {
      const { host, planCtaClicked } = await setup({ plan: stub() });
      expect(links(host, 'Claim your listing free')).toHaveLength(0);
      expect(links(host, 'Talk to us about Managed')).toHaveLength(0);
      // E8.2: "Start with Managed" is retired, so the Managed card reads the same.
      expect(links(host, 'Start with Managed')).toHaveLength(0);
      const claims = links(host, 'Claim your listing');
      // Hero, Free card, Managed card, closing panel.
      expect(claims).toHaveLength(4);
      for (const a of claims) expect(a.getAttribute('href')).toBe('/search');

      for (const a of claims) {
        a.addEventListener('click', (e) => e.preventDefault());
        a.click();
      }
      expect(planCtaClicked.mock.calls.map(([c]) => c)).toEqual([
        { plan: 'free', placement: 'top', page: 'vendor_program' },
        { plan: 'free', placement: 'card', page: 'vendor_program' },
        { plan: 'managed', placement: 'card', page: 'vendor_program' },
        { plan: 'free', placement: 'bottom', page: 'vendor_program' },
      ]);
    });

    // E8.1 (ruled 2026-10-19): "Questions? Contact us" beside the closing panel's
    // claim button and under the FAQ. Not on the hero, and no topic on the link.
    it('shows "Questions? Contact us" twice, as a plain link to /contact', async () => {
      const { host } = await setup({ plan: stub() });
      expect(links(host, 'Talk to us')).toHaveLength(0);
      const contact = links(host, 'Contact us');
      expect(contact).toHaveLength(2);
      for (const a of contact) {
        expect(a.getAttribute('href')).toBe('/contact');
        expect(text(a.parentElement)).toContain('Questions?');
      }
      const hero = host.querySelector('section')!;
      expect(links(hero as HTMLElement, 'Contact us')).toHaveLength(0);
      expect(host.querySelector('aec-plan-cta-panel aec-plan-contact-link')).not.toBeNull();
      expect(host.querySelector('#vp-faq aec-plan-contact-link')).not.toBeNull();
    });

    // AECI-1474: under the FAQ, beside the contact link, the listing request page.
    it('links "Not listed yet?" under the FAQ to the listing request page', async () => {
      const { host } = await setup({ plan: stub() });
      const line = host.querySelector('#vp-faq [data-testid="vp-faq-list-your-product"]');
      expect(text(line)).toBe('Not listed yet? Ask us to list your product');
      const link = links(host, 'Ask us to list your product');
      expect(link).toHaveLength(1);
      expect(link[0]!.getAttribute('href')).toBe('/vendor-program/list-your-product');
      expect(link[0]!.hasAttribute('target')).toBe(false);
    });

    // Full width at desktop (spec section 11, 2026-10-12): no rail, so no column is
    // reserved beside the sections, and the closing panel splits across the width.
    it('mounts no rail and reserves no rail column', async () => {
      const { host } = await setup({ plan: stub() });
      expect(host.querySelector('aec-plan-cta-rail')).toBeNull();
      expect(host.querySelector('[data-testid="vp-rail"]')).toBeNull();
      expect(host.innerHTML).not.toContain('13rem');
      const panel = host.querySelector('aec-plan-cta-panel section')!;
      expect(panel.classList).toContain('lg:grid-cols-12');
    });

    it('shows how claiming works beside the hero copy from lg', async () => {
      const { host } = await setup({ plan: stub() });
      const how = host.querySelector('section [data-testid="vp-how"]')!;
      expect(text(how.querySelector('#vp-how-heading'))).toBe('How claiming works');
      expect(how.querySelectorAll('ol > li')).toHaveLength(3);
      // Copy ruling 2026-10-12: a claim is free, and approval sets up the account.
      const bodies = [...how.querySelectorAll('ol > li p:last-child')].map((p) => text(p));
      expect(bodies.slice(1)).toEqual([
        'Claiming is free. We set up your account when we approve your claim.',
        'A person reviews every claim and emails you the result.',
      ]);
      expect(text(how)).not.toContain('needs no account');
      // Not a section heading: the page keeps one h1, then one h2 per section.
      expect(how.querySelector('h1, h2, h3')).toBeNull();
    });
  });

  describe('signed-in variants (AECI-1286)', () => {
    it('signed out: claim controls stay, every contact link shows', async () => {
      const { host } = await setup({ plan: stub('signed-out') });
      expect(links(host, 'Go to your portal')).toHaveLength(0);
      expect(links(host, 'Claim your listing')).toHaveLength(4);
      expect(links(host, 'Start with Managed')).toHaveLength(0);
    });

    it('a Free vendor seat: every dialog control becomes "Go to your portal", contact links stay', async () => {
      const { host } = await setup({ plan: stub('free') });
      expect(links(host, 'Claim your listing')).toHaveLength(0);
      const portal = links(host, 'Go to your portal');
      // Hero, Free card, Managed card, closing panel.
      expect(portal).toHaveLength(4);
      for (const a of portal) expect(a.getAttribute('href')).toBe('/vendor');
      expect(links(host, 'Contact us')).toHaveLength(2);
    });

    it('a Managed vendor seat: also no contact link in the panel', async () => {
      const { host } = await setup({ plan: stub('managed') });
      expect(links(host, 'Go to your portal')).toHaveLength(4);
      const panel = host.querySelector('aec-plan-cta-panel')!;
      expect(links(panel as HTMLElement, 'Contact us')).toHaveLength(0);
      // The FAQ's link stays.
      expect(links(host, 'Contact us')).toHaveLength(1);
    });

    it('a failed vendor probe leaves the signed-out page, with no error', async () => {
      const getMe = vi.fn().mockRejectedValue(new Error('403'));
      const { host, fixture } = await setup({
        providers: [
          { provide: VendorStatus, useValue: { isVendor: signal(true) } },
          {
            provide: SessionStatus,
            useValue: { email: signal('dana@acme.example'), signedIn: signal(true) },
          },
          { provide: VendorApi, useValue: { getMe } },
        ],
      });
      await new Promise((r) => setTimeout(r));
      fixture.detectChanges();
      expect(getMe).toHaveBeenCalledTimes(1);
      expect(links(host, 'Go to your portal')).toHaveLength(0);
      expect(links(host, 'Claim your listing')).toHaveLength(4);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    // SSR neutrality: on the server the page renders the signed-out HTML, even when
    // the status already knows a Managed vendor.
    it('renders the signed-out page on the server for every visitor', async () => {
      const managed = await setup({ plan: stub('managed'), platform: 'server' });
      const managedHtml = managed.host.innerHTML;
      expect(links(managed.host, 'Go to your portal')).toHaveLength(0);
      expect(links(managed.host, 'Claim your listing')).toHaveLength(4);

      TestBed.resetTestingModule();
      const signedOut = await setup({ plan: stub('signed-out'), platform: 'server' });
      expect(signedOut.host.innerHTML).toBe(managedHtml);
    });
  });

  // §2.4: the product page's "Learn more about claiming" link carries `?vendor=`, so
  // the claim dialog opens on that company. Browser only, after hydration.
  describe('?vendor= seeds the claim dialog', () => {
    async function routed(url: string) {
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideRouter([{ path: 'vendor-program', component: VendorProgramPage }]),
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: Analytics, useValue: { planCtaClicked: vi.fn() } },
          { provide: VendorPlanStatus, useValue: stub() },
        ],
      });
      const harness = await RouterTestingHarness.create(url);
      harness.detectChanges();
      await harness.fixture.whenStable();
      return { harness, http: TestBed.inject(HttpTestingController) };
    }

    it('reads the vendor and seeds the dialog with its company', async () => {
      const { harness, http } = await routed('/vendor-program?vendor=acme');
      http.expectOne('/api/vendors/acme').flush({ slug: 'acme', company_name: 'Acme Software' });
      await new Promise((r) => setTimeout(r));
      await harness.fixture.whenStable();
      expect(TestBed.inject(ClaimDialogService).seed()).toEqual({
        targetType: 'vendor',
        slug: 'acme',
        name: 'Acme Software',
        company: 'Acme Software',
        product: null,
      });
      http.verify();
    });

    it('an unknown vendor seeds nothing', async () => {
      const { harness, http } = await routed('/vendor-program?vendor=nope');
      http
        .expectOne('/api/vendors/nope')
        .flush({ error: { code: 'NOT_FOUND' } }, { status: 404, statusText: 'Not Found' });
      await new Promise((r) => setTimeout(r));
      await harness.fixture.whenStable();
      expect(TestBed.inject(ClaimDialogService).seed()).toBeNull();
    });

    it('a reply after the page is gone seeds nothing', async () => {
      const { harness, http } = await routed('/vendor-program?vendor=acme');
      const req = http.expectOne('/api/vendors/acme');
      harness.fixture.destroy();
      req.flush({ slug: 'acme', company_name: 'Acme Software' });
      await new Promise((r) => setTimeout(r));
      expect(TestBed.inject(ClaimDialogService).seed()).toBeNull();
    });

    it('no param, no read', async () => {
      const { http } = await routed('/vendor-program');
      http.expectNone(() => true);
      expect(TestBed.inject(ClaimDialogService).seed()).toBeNull();
    });
  });
});
