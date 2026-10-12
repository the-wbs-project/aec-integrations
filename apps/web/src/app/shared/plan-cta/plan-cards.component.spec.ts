/**
 * The shared Free and Managed plan cards (`plan-cards.ts`, AECI-1285). Their place
 * in the docs Plans page is pinned in `docs/docs-plans-comparison.component.spec.ts`.
 *
 * `*.component.spec.ts` because the component reads `$localize`, which only the
 * Angular `ng test` tier sets up.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { Analytics } from '../../analytics/analytics';
import { PlanInquiryService } from '../plan-inquiry/plan-inquiry.service';
import { PlanCardsComponent } from './plan-cards';

function render(inputs: Record<string, unknown>) {
  const planCtaClicked = vi.fn();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      { provide: Analytics, useValue: { planCtaClicked } },
    ],
  });
  const inquiry = TestBed.inject(PlanInquiryService);
  inquiry.attachHost();
  const fixture = TestBed.createComponent(PlanCardsComponent);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const cards = host.querySelectorAll('.aec-plan-card');
  return { host, cards, planCtaClicked, inquiry };
}

describe('PlanCardsComponent', () => {
  it('renders Free and Managed, the Managed one featured, with both prices', () => {
    const { cards } = render({ page: 'docs_plans' });
    expect([...cards].map((card) => card.querySelector('h3')?.textContent?.trim())).toEqual([
      'Free',
      'Managed',
    ]);
    expect(cards[1].classList).toContain('aec-plan-card-featured');
    expect(cards[0].textContent).toContain('$0');
    expect(cards[1].textContent).toContain('$25');
    expect(cards[1].textContent).toContain(
      'We reply to most messages within a couple of business days.',
    );
  });

  // VENDOR_PROGRAM_PAGE_SPEC.md §4.1: "Claim your listing free" on Free, pointed at
  // the page's own Find your product section, tracked with the page.
  it('on the vendor program page: the free wording, the section target and the page', () => {
    const { cards, planCtaClicked, inquiry } = render({
      page: 'vendor_program',
      claimPath: '/vendor-program',
      claimFragment: 'find-your-product',
      claimLabel: 'free',
    });
    const claim = cards[0].querySelector('a')!;
    expect(claim.textContent?.trim()).toBe('Claim your listing free');
    expect(claim.getAttribute('href')).toBe('/vendor-program#find-your-product');
    claim.addEventListener('click', (e) => e.preventDefault());
    claim.click();

    const managed = cards[1].querySelector('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    managed.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(inquiry.placement()).toBe('card');
    expect(inquiry.page()).toBe('vendor_program');

    expect(planCtaClicked.mock.calls).toEqual([
      [{ plan: 'free', placement: 'card', page: 'vendor_program' }],
      [{ plan: 'managed', placement: 'card', page: 'vendor_program' }],
    ]);
  });

  // Spec §5 hook: a signed-in vendor gets the portal on the Free card, untracked.
  it('swaps the Free claim for "Go to your portal" when portal is set', () => {
    const { cards, planCtaClicked } = render({ page: 'vendor_program', portal: true });
    const link = cards[0].querySelector('a')!;
    expect(link.textContent?.trim()).toBe('Go to your portal');
    expect(link.getAttribute('href')).toBe('/vendor');
    link.addEventListener('click', (e) => e.preventDefault());
    link.click();
    expect(planCtaClicked).not.toHaveBeenCalled();
  });
});
