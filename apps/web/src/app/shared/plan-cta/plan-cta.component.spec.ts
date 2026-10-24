/**
 * The shared plan calls to action (`plan-cta.ts`, AECI-1285; the one claim workflow,
 * AECI-1293). Their placement on
 * the docs Plans page is pinned in `docs/docs-page.component.spec.ts`.
 */
import { ApplicationRef, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { Analytics } from '../../analytics/analytics';
import { ClaimDialogService } from '../claim-dialog/claim-dialog.service';
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
  // A mounted host, as on the Plans page, so a click opens the dialog in place rather
  // than following its link.
  const claim = TestBed.inject(ClaimDialogService);
  if (hosted) claim.attachHost();
  const fixture = TestBed.createComponent(component);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, planCtaClicked, claim, fixture };
}

/** Clicks like a mouse and reports whether the link's navigation was prevented. */
function click(link: HTMLElement, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  link.dispatchEvent(event);
  return event.defaultPrevented;
}

const CONTACT_HREF = '/contact';
const CLAIM_HREF = '/search';

const linkTexts = (host: HTMLElement) =>
  [...host.querySelectorAll('a')].map((a) => a.textContent?.replace(/\s+/g, ' ').trim());

describe('Plans calls to action', () => {
  // AECI-1293 (spec §15.1): one claim control. E8.1: no contact link on the hero.
  it('top row: "Claim your listing" opens the claim dialog, with no other link', () => {
    const { host, planCtaClicked, claim } = render(PlanCtaActionsComponent, true, {
      page: 'vendor_program',
    });
    expect(linkTexts(host)).toEqual(['Claim your listing']);
    expect(host.querySelector('aec-plan-contact-link')).toBeNull();
    const [claimLink] = [...host.querySelectorAll('a')];
    expect(claimLink.getAttribute('href')).toBe(CLAIM_HREF);
    expect(host.getAttribute('data-plans-cta')).toBe('top');

    expect(click(claimLink)).toBe(true);
    expect(claim.opening()).toEqual({ page: 'vendor_program', entry: 'top' });
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'free',
      placement: 'top',
      page: 'vendor_program',
    });
  });

  it('never says "Talk to us" or "Claim your listing free" any more', () => {
    for (const c of [PlanCtaActionsComponent, PlanCtaPanelComponent, PlanCtaRailComponent]) {
      const { host } = render(c);
      expect(host.textContent).not.toContain('Talk to us');
      expect(host.textContent).not.toContain('Claim your listing free');
    }
  });

  // Spec §5 hook: a signed-in vendor gets the portal instead of the dialog, untracked.
  it('swaps the claim for "Go to your portal" when portal is set', () => {
    const { host, planCtaClicked, claim } = render(PlanCtaActionsComponent, true, {
      page: 'vendor_program',
      portal: true,
    });
    const portal = host.querySelector('a')!;
    expect(portal.textContent?.trim()).toBe('Go to your portal');
    expect(portal.getAttribute('href')).toBe('/vendor');
    portal.addEventListener('click', (e) => e.preventDefault());
    portal.click();
    expect(planCtaClicked).not.toHaveBeenCalled();
    expect(claim.isOpen()).toBe(false);
  });

  // With no dialog on the page the link is left alone, so it reaches the search page.
  it('follows the link when no claim dialog host is mounted', () => {
    const { host, claim } = render(PlanCtaActionsComponent, false);
    const link = host.querySelector('a')!;
    let prevented: boolean | null = null;
    link.addEventListener('click', (e) => {
      prevented = e.defaultPrevented;
      e.preventDefault();
    });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    expect(prevented).toBe(false);
    expect(claim.isOpen()).toBe(false);
  });

  // A new-tab click keeps the link.
  it('a modified click follows the link instead', () => {
    const { host, claim, planCtaClicked } = render(PlanCtaActionsComponent);
    const link = host.querySelector('a')!;
    link.addEventListener('click', (e) => e.preventDefault());
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(claim.isOpen()).toBe(false);
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'free',
      placement: 'top',
      page: 'docs_plans',
    });
  });

  // Spec §4.1: the monthly and the annual price, both from the constants.
  it('formats the terms line from the monthly and annual price constants', () => {
    expect(managedTermsLine('en-US')).toBe('$25 USD a month or $250 USD a year per product.');
  });

  it('bottom panel: headline, both prices, safety line, the claim button and next steps', () => {
    const { host, planCtaClicked, claim } = render(PlanCtaPanelComponent);
    const text = host.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(host.querySelector('h3')?.textContent?.trim()).toBe(
      'Tell the full story of your product',
    );
    expect(text).toContain(
      '$25 USD a month or $250 USD a year per product. Monthly, cancel any time. Full refund within 14 days. If a plan ends, nothing you entered is removed.',
    );
    // Ruled 2026-10-12 (spec §4.1): the steps describe the claim dialog.
    expect(
      [...host.querySelectorAll('ol li span:last-child')].map((step) =>
        step.textContent?.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['Find your listing and send your claim.', 'We review it and email you the result.']);
    // E8.1: "Questions? Contact us" beside the claim button, a plain link to /contact.
    expect(linkTexts(host)).toEqual(['Claim your listing', 'Contact us']);
    expect(text).toContain('Questions? Contact us');
    const [link, contact] = [...host.querySelectorAll('a')];
    expect(contact.getAttribute('href')).toBe(CONTACT_HREF);
    expect(link.getAttribute('href')).toBe(CLAIM_HREF);
    expect(click(link)).toBe(true);
    expect(claim.opening()?.entry).toBe('bottom');
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'free',
      placement: 'bottom',
      page: 'docs_plans',
    });
  });

  it('bottom panel as a section: an h2', () => {
    const { host } = render(PlanCtaPanelComponent, true, {
      page: 'vendor_program',
      headingLevel: 2,
    });
    expect(host.querySelector('h2')?.textContent?.trim()).toBe(
      'Tell the full story of your product',
    );
    expect(host.querySelector('h3')).toBeNull();
  });

  // The steps describe the claim dialog, so a Free seat's "Go to your portal" drops them.
  it('bottom panel keeps the contact link but drops the steps for a Free vendor seat', () => {
    const { host } = render(PlanCtaPanelComponent, true, {
      page: 'vendor_program',
      portal: true,
    });
    expect(linkTexts(host)).toEqual(['Go to your portal', 'Contact us']);
    expect(host.querySelector('ol')).toBeNull();
  });

  // Spec §5 hook: a Managed company sees no contact link and no steps.
  it('bottom panel drops the contact link and the steps when hideManaged is set', () => {
    const { host } = render(PlanCtaPanelComponent, true, {
      page: 'vendor_program',
      portal: true,
      hideManaged: true,
    });
    expect(linkTexts(host)).toEqual(['Go to your portal']);
    expect(host.querySelector('ol')).toBeNull();
  });

  // E8.2: the rail reads "Claim your listing" like every other control.
  it('rail card: plan, price and "Claim your listing"', () => {
    const { host, planCtaClicked, claim } = render(PlanCtaRailComponent);
    expect(host.textContent).toContain('Managed');
    expect(host.textContent).toContain('$25 USD a month per product');
    const link = host.querySelector('a')!;
    expect(link.textContent?.trim()).toBe('Claim your listing');
    expect(link.getAttribute('href')).toBe(CLAIM_HREF);
    expect(click(link)).toBe(true);
    expect(claim.opening()).toEqual({ page: 'docs_plans', entry: 'rail' });
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
