/**
 * The shared plan calls to action (`plan-cta.ts`, AECI-1285). Their placement on
 * the docs Plans page is pinned in `docs/docs-page.component.spec.ts`.
 */
import { ApplicationRef, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { Analytics } from '../../analytics/analytics';
import { PlanInquiryService } from '../plan-inquiry/plan-inquiry.service';
import {
  PlanCtaActionsComponent,
  PlanCtaMobileBarComponent,
  PlanCtaPanelComponent,
  PlanCtaRailComponent,
  managedTermsLine,
} from './plan-cta';

function render<T>(
  component: Type<T>,
  hosted = true,
  inputs: Record<string, unknown> = { page: 'docs_plans' },
) {
  const planCtaClicked = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      { provide: Analytics, useValue: { planCtaClicked } },
    ],
  });
  // A mounted host, as on the Plans page, so a Managed click opens the dialog in
  // place rather than following its link.
  const inquiry = TestBed.inject(PlanInquiryService);
  if (hosted) inquiry.attachHost();
  const fixture = TestBed.createComponent(component);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, planCtaClicked, inquiry, fixture };
}

/** Clicks like a mouse and reports whether the link's navigation was prevented. */
function click(link: HTMLElement, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  link.dispatchEvent(event);
  return event.defaultPrevented;
}

const MANAGED_HREF = '/contact?topic=managed';

describe('Plans calls to action', () => {
  // Wording is the ask, not a checkout: there is no checkout to start.
  it('top row: Managed first, then claiming free, each tracked by placement', () => {
    const { host, planCtaClicked } = render(PlanCtaActionsComponent);
    const links = [...host.querySelectorAll('a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      'Talk to us about Managed',
      'Claim your listing free',
    ]);
    expect(links[0].getAttribute('href')).toBe(MANAGED_HREF);
    expect(links[1].getAttribute('href')).toBe('/docs/vendors/claiming-your-listing');
    expect(host.getAttribute('data-plans-cta')).toBe('top');
    links[1].addEventListener('click', (e) => e.preventDefault());
    expect(click(links[0])).toBe(true);
    links[1].click();
    expect(planCtaClicked.mock.calls).toEqual([
      [{ plan: 'managed', placement: 'top', page: 'docs_plans' }],
      [{ plan: 'free', placement: 'top', page: 'docs_plans' }],
    ]);
  });

  // AECI-1279: a plain click opens the one inquiry dialog, carrying its placement
  // and, since AECI-1288, its page.
  it('a Managed click opens the inquiry dialog with its placement and page', () => {
    const { host, inquiry } = render(PlanCtaActionsComponent, true, { page: 'vendor_program' });
    expect(click(host.querySelector('a')!)).toBe(true);
    expect(inquiry.placement()).toBe('top');
    expect(inquiry.page()).toBe('vendor_program');
  });

  // VENDOR_PROGRAM_PAGE_SPEC.md §4: the vendor program page points the claim at its
  // own Find your product section, as a path plus fragment.
  it('points the claim at a page section when given a path and fragment', () => {
    const { host, planCtaClicked } = render(PlanCtaActionsComponent, true, {
      page: 'vendor_program',
      claimPath: '/vendor-program',
      claimFragment: 'find-your-product',
    });
    const claim = host.querySelectorAll('a')[1];
    expect(claim.getAttribute('href')).toBe('/vendor-program#find-your-product');
    claim.addEventListener('click', (e) => e.preventDefault());
    claim.click();
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'free',
      placement: 'top',
      page: 'vendor_program',
    });
  });

  // Spec §5 hook: a signed-in vendor gets the portal instead of the claim, untracked.
  it('swaps the claim for "Go to your portal" when portal is set', () => {
    const { host, planCtaClicked } = render(PlanCtaActionsComponent, true, {
      page: 'vendor_program',
      portal: true,
    });
    const portal = host.querySelectorAll('a')[1];
    expect(portal.textContent?.trim()).toBe('Go to your portal');
    expect(portal.getAttribute('href')).toBe('/vendor');
    portal.addEventListener('click', (e) => e.preventDefault());
    portal.click();
    expect(planCtaClicked).not.toHaveBeenCalled();
  });

  // With no dialog on the page the link is left alone, so it reaches the contact form.
  it('follows the link when no inquiry host is mounted', () => {
    const { host, inquiry } = render(PlanCtaActionsComponent, false);
    const link = host.querySelector('a')!;
    let prevented: boolean | null = null;
    // Read the verdict after the trigger ran, then stop jsdom navigating.
    link.addEventListener('click', (e) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(prevented).toBe(false);
    expect(inquiry.isOpen()).toBe(false);
  });

  // A new-tab click keeps the link, so the visitor gets the contact page form.
  it('a modified click follows the link instead', () => {
    const { host, inquiry, planCtaClicked } = render(PlanCtaActionsComponent);
    const link = host.querySelector('a')!;
    link.addEventListener('click', (e) => e.preventDefault());
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    // The listener above stops jsdom navigating. Read the trigger's verdict from the
    // service instead: it must not have opened.
    link.dispatchEvent(event);
    expect(inquiry.isOpen()).toBe(false);
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'managed',
      placement: 'top',
      page: 'docs_plans',
    });
  });

  // Spec §4.1: the monthly and the annual price, both from the constants.
  it('formats the terms line from the monthly and annual price constants', () => {
    expect(managedTermsLine('en-US')).toBe(
      '$25 a month per product, or $250 a year, billed by invoice or purchase order.',
    );
  });

  it('bottom panel: headline, both prices, safety line, button and next steps', () => {
    const { host, planCtaClicked } = render(PlanCtaPanelComponent);
    const text = host.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(host.querySelector('h3')?.textContent?.trim()).toBe(
      'Tell the full story of your product',
    );
    expect(text).toContain(
      '$25 a month per product, or $250 a year, billed by invoice or purchase order. If a plan ends, nothing you entered is removed.',
    );
    expect(host.querySelectorAll('ol li')).toHaveLength(2);
    // The docs panel carries the Managed ask alone.
    expect(host.querySelectorAll('a')).toHaveLength(1);
    const link = host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(MANAGED_HREF);
    expect(click(link)).toBe(true);
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'managed',
      placement: 'bottom',
      page: 'docs_plans',
    });
  });

  // Spec §4.1: its own section on the vendor program page, with the claim beside it.
  it('bottom panel as a section: an h2 and the claim as a text link', () => {
    const { host, planCtaClicked } = render(PlanCtaPanelComponent, true, {
      page: 'vendor_program',
      headingLevel: 2,
      showClaim: true,
      claimPath: '/vendor-program',
      claimFragment: 'find-your-product',
    });
    expect(host.querySelector('h2')?.textContent?.trim()).toBe(
      'Tell the full story of your product',
    );
    expect(host.querySelector('h3')).toBeNull();
    const links = [...host.querySelectorAll('a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual([
      'Talk to us about Managed',
      'Claim your listing free',
    ]);
    expect(links[1].getAttribute('href')).toBe('/vendor-program#find-your-product');
    links[1].addEventListener('click', (e) => e.preventDefault());
    links[1].click();
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'free',
      placement: 'bottom',
      page: 'vendor_program',
    });
  });

  // Spec §5 hook: a Managed company sees no Managed ask in the panel.
  it('bottom panel drops the Managed button and its steps when hideManaged is set', () => {
    const { host } = render(PlanCtaPanelComponent, true, {
      page: 'vendor_program',
      showClaim: true,
      portal: true,
      hideManaged: true,
    });
    const links = [...host.querySelectorAll('a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Go to your portal']);
    expect(host.querySelector('ol')).toBeNull();
  });

  it('rail card: plan, price and a short button', () => {
    const { host, planCtaClicked } = render(PlanCtaRailComponent);
    expect(host.textContent).toContain('Managed');
    expect(host.textContent).toContain('$25 a month per product');
    const link = host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(MANAGED_HREF);
    expect(click(link)).toBe(true);
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'managed',
      placement: 'rail',
      page: 'docs_plans',
    });
  });

  it('rail card renders nothing when hideManaged is set', () => {
    const { host } = render(PlanCtaRailComponent, true, { page: 'docs_plans', hideManaged: true });
    expect(host.querySelector('aside')).toBeNull();
  });

  // Hidden in the SSR HTML, so the cached page is the same for every visitor.
  it('phone bar renders nothing until the browser decides to show it', () => {
    const { host } = render(PlanCtaMobileBarComponent);
    expect(host.querySelector('a')).toBeNull();
  });

  // The host is `lg:hidden`. From `lg` the bar must not reserve its height
  // either, or desktop gets blank space at the page foot.
  // Spec §5 hook: a Managed company never sees the bar, so nothing is reserved,
  // and a flip after hydration takes effect without a scroll.
  it.each([
    [true, false, '5rem'],
    [false, false, ''],
    [true, true, ''],
  ])(
    'phone bar on a phone-width screen %s, hideManaged %s, reserves "%s"',
    async (phone, hideManaged, reserve) => {
      let fire: (entries: Partial<IntersectionObserverEntry>[]) => void = () => undefined;
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: (entries: Partial<IntersectionObserverEntry>[]) => void) {
            fire = cb;
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
      // jsdom has no matchMedia, so define one on the window the component reads.
      const view = document.defaultView!;
      Object.defineProperty(view, 'matchMedia', {
        configurable: true,
        value: () => ({
          matches: phone,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }),
      });
      const top = document.createElement('div');
      top.setAttribute('data-plans-cta', 'top');
      document.body.appendChild(top);
      try {
        const { fixture } = render(PlanCtaMobileBarComponent, true, {
          page: 'docs_plans',
          hideManaged,
        });
        await TestBed.inject(ApplicationRef).whenStable();
        fire([
          { target: top, isIntersecting: false, boundingClientRect: { bottom: -10 } as DOMRect },
        ]);
        expect(document.body.style.paddingBottom).toBe(reserve);
        if (phone && !hideManaged) {
          fixture.componentRef.setInput('hideManaged', true);
          await TestBed.inject(ApplicationRef).whenStable();
          expect(document.body.style.paddingBottom).toBe('');
        }
        TestBed.resetTestingModule();
        expect(document.body.style.paddingBottom).toBe('');
      } finally {
        top.remove();
        vi.unstubAllGlobals();
        delete (view as { matchMedia?: unknown }).matchMedia;
      }
    },
  );
});
