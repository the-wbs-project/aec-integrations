/**
 * The Plans page's calls to action (`docs-plans-cta.ts`). Their placement on
 * the page is pinned in `docs-page.component.spec.ts`.
 */
import { ApplicationRef, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { Analytics } from '../analytics/analytics';
import {
  DocsPlansActionsComponent,
  DocsPlansCtaPanelComponent,
  DocsPlansMobileBarComponent,
  DocsPlansRailComponent,
} from './docs-plans-cta';

function render<T>(component: Type<T>) {
  const planCtaClicked = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      { provide: Analytics, useValue: { planCtaClicked } },
    ],
  });
  const fixture = TestBed.createComponent(component);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, planCtaClicked };
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
    links[0].click();
    links[1].click();
    expect(planCtaClicked.mock.calls).toEqual([
      [{ plan: 'managed', placement: 'top' }],
      [{ plan: 'free', placement: 'top' }],
    ]);
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
    link.click();
    expect(planCtaClicked).toHaveBeenCalledWith({ plan: 'managed', placement: 'bottom' });
  });

  it('rail card: plan, price and a short button', () => {
    const { host, planCtaClicked } = render(DocsPlansRailComponent);
    expect(host.textContent).toContain('Managed');
    expect(host.textContent).toContain('$25 a month per product');
    host.querySelector('a')!.click();
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
