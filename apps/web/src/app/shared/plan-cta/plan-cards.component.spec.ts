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
import { ClaimDialogService } from '../claim-dialog/claim-dialog.service';
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
  const claimDialog = TestBed.inject(ClaimDialogService);
  claimDialog.attachHost();
  const fixture = TestBed.createComponent(PlanCardsComponent);
  for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const cards = host.querySelectorAll('.aec-plan-card');
  return { host, cards, planCtaClicked, inquiry, claimDialog };
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

  const click = (link: HTMLElement): boolean => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    return event.defaultPrevented;
  };

  // AECI-1293 (spec §15.1): both cards open the claim dialog, each preselecting its
  // plan; the pricing question under Managed opens the inquiry dialog.
  it('opens the claim dialog from both cards with the plan preselected', () => {
    const { cards, planCtaClicked, claimDialog, inquiry } = render({ page: 'vendor_program' });
    const claim = cards[0].querySelector('a')!;
    expect(claim.textContent?.trim()).toBe('Claim your listing');
    expect(claim.getAttribute('href')).toBe('/search');
    expect(click(claim)).toBe(true);
    expect(claimDialog.opening()).toEqual({ page: 'vendor_program', entry: 'card', plan: 'free' });

    const [start, pricing] = [...cards[1].querySelectorAll('a')];
    expect(start.textContent?.trim()).toBe('Start with Managed');
    expect(click(start)).toBe(true);
    expect(claimDialog.opening()).toEqual({
      page: 'vendor_program',
      entry: 'card',
      plan: 'managed',
    });

    expect(pricing.textContent?.trim()).toBe('Talk to us');
    expect(cards[1].textContent).toContain('Questions about Managed or pricing?');
    expect(click(pricing)).toBe(true);
    expect(inquiry.placement()).toBe('card');
    expect(inquiry.page()).toBe('vendor_program');

    expect(planCtaClicked.mock.calls).toEqual([
      [{ plan: 'free', placement: 'card', page: 'vendor_program' }],
      [{ plan: 'managed', placement: 'card', page: 'vendor_program' }],
    ]);
  });

  // Spec §5 hook: a signed-in vendor gets the portal on both cards, untracked.
  it('swaps both dialog buttons for "Go to your portal" when portal is set', () => {
    const { cards, planCtaClicked, claimDialog } = render({
      page: 'vendor_program',
      portal: true,
    });
    for (const card of [cards[0], cards[1]]) {
      const link = card.querySelector('a')!;
      expect(link.textContent?.trim()).toBe('Go to your portal');
      expect(link.getAttribute('href')).toBe('/vendor');
      link.addEventListener('click', (e) => e.preventDefault());
      link.click();
    }
    expect(planCtaClicked).not.toHaveBeenCalled();
    expect(claimDialog.isOpen()).toBe(false);
  });
});
