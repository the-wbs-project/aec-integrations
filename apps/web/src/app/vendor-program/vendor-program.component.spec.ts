import { PLATFORM_ID, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Analytics } from '../analytics/analytics';
import { SessionStatus } from '../auth/session-status';
import { VendorApi } from '../vendor/vendor-api';
import { VendorPlanStatus } from '../vendor/vendor-plan-status';
import { VendorStatus } from '../vendor/vendor-status';
import { VendorProgramPage } from './vendor-program';

/**
 * `/vendor-program` (`docs/VENDOR_PROGRAM_PAGE_SPEC.md`). AECI-1283 owns the meta
 * and the anchor. AECI-1284 owns the sections in the §3 order and the §8 copy
 * rules. AECI-1285's placements are wired here with this page's targets. AECI-1286
 * owns the signed-in variants, applied only after the first browser render.
 * Find your product itself is pinned in `vendor-program-find.component.spec.ts`.
 */

/** A `VendorPlanStatus` stand-in: `null` is the signed-out (and SSR) default. */
interface PlanStatusStub {
  vendorSlug: ReturnType<typeof signal<string | null>>;
  vendorName: ReturnType<typeof signal<string | null>>;
  managed: ReturnType<typeof signal<boolean | null>>;
}

function stub(state: 'signed-out' | 'free' | 'managed' = 'signed-out'): PlanStatusStub {
  const vendor = state !== 'signed-out';
  return {
    vendorSlug: signal(vendor ? 'acme' : null),
    vendorName: signal(vendor ? 'Acme Software' : null),
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
      { provide: Analytics, useValue: { planCtaClicked, vendorProductSearch: vi.fn() } },
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
      expect(text(host.querySelector('section'))).toContain('Claiming your listing is free.');
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
        'H2:Find your product',
        'H2:What a free claim gets you',
        'H2:What Managed adds',
        'H2:Free and Managed',
        'H2:How listings are sorted',
        'H2:Coming soon',
        'H2:Questions vendors ask',
        'H2:Tell the full story of your product',
      ]);
      // The three Managed jobs, then the plan cards, sit one level down.
      expect([...host.querySelectorAll('h3')].map(text)).toEqual([
        'Explain what your product does on a project',
        'Back up your integrations',
        'Answer buyers in public',
        'Free',
        'Managed',
      ]);
    });

    it('anchors Find your product, which every claim link scrolls to', async () => {
      const { host } = await setup({ plan: stub() });
      const section = host.querySelector('section#find-your-product');
      expect(section?.querySelector('h2')?.textContent).toContain('Find your product');
    });

    it('links each Managed line to the page that explains it', async () => {
      const { host } = await setup({ plan: stub() });
      const items = [...host.querySelectorAll('#vp-managed li')];
      expect(items).toHaveLength(6);
      const hrefs = items.map((li) => li.querySelector('a')?.getAttribute('href'));
      expect(hrefs).toEqual([
        '/docs/vendors/plans#what-managed-adds',
        '/docs/getting-started/taxonomy',
        '/docs/vendors/attesting-an-integration',
        '/docs/vendors/plans#what-managed-adds',
        '/docs/vendors/owning-an-integration',
        '/docs/vendors/replying-to-reviews',
      ]);
      // The price leads the section, from the shared terms line.
      expect(text(host.querySelector('#vp-managed > div > p'))).toBe(
        '$25 a month per product, or $250 a year, billed by invoice or purchase order.',
      );
    });

    it('keeps the Free links to the seat and checklist pages', async () => {
      const { host } = await setup({ plan: stub() });
      const hrefs = [...host.querySelectorAll('#vp-free a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(['/docs/vendors/your-seat', '/docs/vendors/checklists']);
      expect(host.querySelectorAll('#vp-free li')).toHaveLength(3);
    });

    it('shows the real maintenance labels before and after a claim', async () => {
      const { host } = await setup({ plan: stub() });
      const before = host.querySelector('[data-testid="vp-before"] aec-maintenance-marker');
      const after = host.querySelector('[data-testid="vp-after"] aec-maintenance-marker');
      expect(text(before)).toBe('AEC Integrations maintained');
      expect(text(after)).toMatch(/^Vendor maintained · Updated [A-Z][a-z]+ \d{1,2}, \d{4}$/);
    });

    // Ruling 2026-10-12: every docs link, and View the listing, opens in a new tab
    // with the drawn cue and the sr-only note. Conversion links stay in the tab.
    it('opens every docs link in a new tab with the new-tab cue', async () => {
      const { host } = await setup({ plan: stub() });
      const docs = [...host.querySelectorAll<HTMLAnchorElement>('a[href^="/docs/"]')];
      expect(docs.length).toBe(13);
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
        'Every listing is sorted the same way: how well it matches the search, then how complete it is. Your plan is not part of that.',
      );
      expect(text(sorting)).toContain('That is why buyers trust the order they see.');
      expect(sorting?.querySelector('a')?.getAttribute('href')).toBe(
        '/docs/trust/how-ranking-works',
      );
    });

    it('labels Coming soon as not available yet', async () => {
      const { host } = await setup({ plan: stub() });
      const soon = text(host.querySelector('#vp-coming-soon'));
      expect(soon).toContain('Not available yet');
      expect(soon).toContain('never changes where you rank or appear');
    });

    it('answers the FAQ in a native details list, with no approval time', async () => {
      const { host } = await setup({ plan: stub() });
      const faq = [...host.querySelectorAll('#vp-faq details')];
      expect(faq.map((d) => text(d.querySelector('summary')))).toEqual([
        'Who can claim a listing?',
        'How long does approval take?',
        'We make several products. Do we claim each one?',
        'Can we pay by invoice or purchase order?',
        'What happens when a Managed plan ends?',
        'Does paying affect our reviews or where we rank?',
      ]);
      // Open decision 2: we review each claim and email the result, no time.
      const approval = text(faq[1]);
      expect(approval).toContain('We review each claim and email the result');
      expect(approval).not.toMatch(/\d|day|week|hour/i);
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
    });
  });

  describe('calls to action (AECI-1285 placements)', () => {
    it('mounts the hero pair, the cards, the phone bar, the panel and one inquiry host', async () => {
      const { host } = await setup({ plan: stub() });
      const hero = host.querySelector('section')!;
      expect(hero.querySelector('aec-plan-cta-actions')).not.toBeNull();
      for (const tag of ['aec-plan-cards', 'aec-plan-cta-mobile-bar', 'aec-plan-cta-panel']) {
        expect(host.querySelectorAll(tag), tag).toHaveLength(1);
      }
      expect(host.querySelectorAll('aec-plan-inquiry-host')).toHaveLength(1);
      // The cards count as a full call to action for the phone bar.
      expect(host.querySelector('aec-plan-cards')?.getAttribute('data-plans-cta')).toBe('card');
    });

    it('points every "Claim your listing free" at Find your product on this page', async () => {
      const { host, planCtaClicked } = await setup({ plan: stub() });
      const claims = links(host, 'Claim your listing free');
      // Hero, Free card, closing panel.
      expect(claims).toHaveLength(3);
      for (const a of claims)
        expect(a.getAttribute('href')).toBe('/vendor-program#find-your-product');

      for (const a of claims) {
        a.addEventListener('click', (e) => e.preventDefault());
        a.click();
      }
      expect(planCtaClicked.mock.calls.map(([c]) => c)).toEqual([
        { plan: 'free', placement: 'top', page: 'vendor_program' },
        { plan: 'free', placement: 'card', page: 'vendor_program' },
        { plan: 'free', placement: 'bottom', page: 'vendor_program' },
      ]);
    });

    it('opens every Managed ask as the vendor program page', async () => {
      const { host } = await setup({ plan: stub() });
      const managed = links(host, 'Talk to us about Managed');
      // Hero, Managed card, closing panel. The phone bar says "Talk to us".
      expect(managed).toHaveLength(3);
      for (const a of managed) expect(a.getAttribute('href')).toBe('/contact?topic=managed');
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
      // Not a section heading: the page keeps one h1, then one h2 per section.
      expect(how.querySelector('h1, h2, h3')).toBeNull();
    });
  });

  describe('signed-in variants (AECI-1286)', () => {
    it('signed out: claim links stay, every Managed ask shows', async () => {
      const { host } = await setup({ plan: stub('signed-out') });
      expect(links(host, 'Go to your portal')).toHaveLength(0);
      expect(links(host, 'Claim your listing free')).toHaveLength(3);
    });

    it('a Free vendor seat: claim links become "Go to your portal", Managed asks stay', async () => {
      const { host } = await setup({ plan: stub('free') });
      expect(links(host, 'Claim your listing free')).toHaveLength(0);
      const portal = links(host, 'Go to your portal');
      expect(portal).toHaveLength(3);
      for (const a of portal) expect(a.getAttribute('href')).toBe('/vendor');
      expect(links(host, 'Talk to us about Managed')).toHaveLength(3);
    });

    it('a Managed vendor seat: also no Managed button in the panel', async () => {
      const { host } = await setup({ plan: stub('managed') });
      expect(links(host, 'Go to your portal')).toHaveLength(3);
      const panel = host.querySelector('aec-plan-cta-panel')!;
      expect(links(panel as HTMLElement, 'Talk to us about Managed')).toHaveLength(0);
      // The hero and the Managed card keep theirs (spec section 5 lists only three).
      expect(links(host, 'Talk to us about Managed')).toHaveLength(2);
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
      expect(links(host, 'Claim your listing free')).toHaveLength(3);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    // SSR neutrality: on the server the page renders the signed-out HTML, even when
    // the status already knows a Managed vendor.
    it('renders the signed-out page on the server for every visitor', async () => {
      const managed = await setup({ plan: stub('managed'), platform: 'server' });
      const managedHtml = managed.host.innerHTML;
      expect(links(managed.host, 'Go to your portal')).toHaveLength(0);
      expect(links(managed.host, 'Claim your listing free')).toHaveLength(3);

      TestBed.resetTestingModule();
      const signedOut = await setup({ plan: stub('signed-out'), platform: 'server' });
      expect(signedOut.host.innerHTML).toBe(managedHtml);
    });
  });
});
