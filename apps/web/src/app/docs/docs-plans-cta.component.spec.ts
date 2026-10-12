/**
 * The Plans page's calls to action (`docs-plans-cta.ts`). Their placement on
 * the page is pinned in `docs-page.component.spec.ts`.
 */
import { ApplicationRef, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { Analytics } from '../analytics/analytics';
import { PlanInquiryService } from '../shared/plan-inquiry/plan-inquiry.service';
import {
  DocsPlansActionsComponent,
  DocsPlansCtaPanelComponent,
  DocsPlansMobileBarComponent,
  DocsPlansRailComponent,
} from './docs-plans-cta';

function render<T>(component: Type<T>, hosted = true) {
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
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, planCtaClicked, inquiry };
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
    const { host, planCtaClicked } = render(DocsPlansActionsComponent);
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
      [{ plan: 'managed', placement: 'top' }],
      [{ plan: 'free', placement: 'top' }],
    ]);
  });

  // AECI-1279: a plain click opens the one inquiry dialog, carrying its placement.
  it('a Managed click opens the inquiry dialog with its placement', () => {
    const { host, inquiry } = render(DocsPlansActionsComponent);
    expect(click(host.querySelector('a')!)).toBe(true);
    expect(inquiry.placement()).toBe('top');
  });

  // With no dialog on the page the link is left alone, so it reaches the contact form.
  it('follows the link when no inquiry host is mounted', () => {
    const { host, inquiry } = render(DocsPlansActionsComponent, false);
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
    const { host, inquiry, planCtaClicked } = render(DocsPlansActionsComponent);
    const link = host.querySelector('a')!;
    link.addEventListener('click', (e) => e.preventDefault());
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    // The listener above stops jsdom navigating. Read the trigger's verdict from the
    // service instead: it must not have opened.
    link.dispatchEvent(event);
    expect(inquiry.isOpen()).toBe(false);
    expect(planCtaClicked).toHaveBeenCalledWith({ plan: 'managed', placement: 'top' });
  });

  it('bottom panel: headline, price, safety line, button and next steps', () => {
    const { host, planCtaClicked } = render(DocsPlansCtaPanelComponent);
    const text = host.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(host.querySelector('h3')?.textContent?.trim()).toBe(
      'Tell the full story of your product',
    );
    expect(text).toContain('$25 a month per product, billed by invoice or purchase order.');
    expect(text).toContain('If a plan ends, nothing you entered is removed.');
    expect(host.querySelectorAll('ol li')).toHaveLength(2);
    const link = host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(MANAGED_HREF);
    expect(click(link)).toBe(true);
    expect(planCtaClicked).toHaveBeenCalledWith({ plan: 'managed', placement: 'bottom' });
  });

  it('rail card: plan, price and a short button', () => {
    const { host, planCtaClicked } = render(DocsPlansRailComponent);
    expect(host.textContent).toContain('Managed');
    expect(host.textContent).toContain('$25 a month per product');
    const link = host.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(MANAGED_HREF);
    expect(click(link)).toBe(true);
    expect(planCtaClicked).toHaveBeenCalledWith({ plan: 'managed', placement: 'rail' });
  });

  // Hidden in the SSR HTML, so the cached page is the same for every visitor.
  it('phone bar renders nothing until the browser decides to show it', () => {
    const { host } = render(DocsPlansMobileBarComponent);
    expect(host.querySelector('a')).toBeNull();
  });

  // The host is `lg:hidden`. From `lg` the bar must not reserve its height
  // either, or desktop gets blank space at the page foot.
  it.each([
    [true, '5rem'],
    [false, ''],
  ])('phone bar on a phone-width screen %s reserves "%s"', async (phone, reserve) => {
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
      render(DocsPlansMobileBarComponent);
      await TestBed.inject(ApplicationRef).whenStable();
      fire([
        { target: top, isIntersecting: false, boundingClientRect: { bottom: -10 } as DOMRect },
      ]);
      expect(document.body.style.paddingBottom).toBe(reserve);
      TestBed.resetTestingModule();
      expect(document.body.style.paddingBottom).toBe('');
    } finally {
      top.remove();
      vi.unstubAllGlobals();
      delete (view as { matchMedia?: unknown }).matchMedia;
    }
  });
});
