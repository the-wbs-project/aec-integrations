/**
 * The claim dialog shell (`claim-dialog.ts`) and its trigger (AECI-1293,
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15). The steps are pinned in
 * `claim-dialog-flow.component.spec.ts`; which control opens it with which plan in
 * `shared/plan-cta/*.component.spec.ts`.
 */
import { ApplicationRef, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Analytics } from '../../analytics/analytics';
import { SessionStatus } from '../../auth/session-status';
import { RequestsApi } from '../../requests/requests-api';
import { ClaimDialog } from './claim-dialog';
import { ClaimDialogTrigger } from './claim-dialog-trigger';
import { CLAIM_DIALOG_FALLBACK_HREF, ClaimDialogService } from './claim-dialog.service';

function mount() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: SessionStatus, useValue: { email: signal(null) } },
      { provide: RequestsApi, useValue: { submitClaim: vi.fn(), submitListing: vi.fn() } },
      {
        provide: Analytics,
        useValue: { claimDialogStep: vi.fn(), claimRequested: vi.fn(), listingRequested: vi.fn() },
      },
    ],
  });
  return TestBed.inject(ClaimDialogService);
}

const panel = () => document.querySelector('[data-testid="claim-dialog"]');
const stable = () => TestBed.inject(ApplicationRef).whenStable();

describe('ClaimDialog', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  // The first click lands before the deferred dialog exists; it opens itself.
  it('opens on its first render, named by its title, at the step the opening asked for', async () => {
    const service = mount();
    service.open({
      page: 'vendor_program',
      entry: 'search_result',
      listing: { targetType: 'product', slug: 'x', name: 'X Pro' },
    });
    TestBed.createComponent(ClaimDialog).detectChanges();
    await stable();
    const dialog = document.querySelector('[role="dialog"]')!;
    const title = panel()!.querySelector('h2')!;
    expect(title.textContent?.trim()).toBe('Claim your listing');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(panel()!.querySelector('h3')?.textContent?.trim()).toBe('About you');
    expect(panel()!.textContent).toContain('X Pro');
  });

  it('is a full-screen sheet below sm and a centred panel from sm', async () => {
    const service = mount();
    service.open({ page: 'docs_plans', entry: 'top' });
    TestBed.createComponent(ClaimDialog).detectChanges();
    await stable();
    const classes = panel()!.classList;
    for (const c of [
      'h-dvh',
      'w-screen',
      'sm:h-auto',
      'sm:max-h-[85vh]',
      'sm:rounded-(--radius-lg)',
    ]) {
      expect(classes, c).toContain(c);
    }
  });

  it('closes from the close button and reports the close', async () => {
    const service = mount();
    const fixture = TestBed.createComponent(ClaimDialog);
    fixture.detectChanges();
    await stable();
    expect(panel()).toBeNull();
    service.open({ page: 'docs_plans', entry: 'top' });
    await stable();
    expect(panel()).not.toBeNull();
    (panel()!.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click();
    for (let i = 0; i < 40 && service.isOpen(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await stable();
    }
    expect(service.isOpen()).toBe(false);
  });

  it('closes on Escape', async () => {
    const service = mount();
    service.open({ page: 'docs_plans', entry: 'top' });
    TestBed.createComponent(ClaimDialog).detectChanges();
    await stable();
    panel()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (let i = 0; i < 40 && service.isOpen(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await stable();
    }
    expect(service.isOpen()).toBe(false);
  });
});

@Component({
  imports: [ClaimDialogTrigger],
  template: `<a
    [href]="href"
    aecClaimDialogTrigger="card"
    aecClaimDialogPage="vendor_program"
    aecClaimDialogPlan="managed"
    >Start with Managed</a
  >`,
})
class TriggerHost {
  protected readonly href = CLAIM_DIALOG_FALLBACK_HREF;
}

describe('ClaimDialogTrigger', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function render(hosted: boolean) {
    const service = mount();
    if (hosted) service.attachHost();
    const fixture = TestBed.createComponent(TriggerHost);
    fixture.detectChanges();
    return { service, link: (fixture.nativeElement as HTMLElement).querySelector('a')! };
  }

  it('keeps the absolute no-JS target, never a bare fragment', () => {
    const { link } = render(true);
    expect(link.getAttribute('href')).toBe('/vendor-program#find-your-product');
  });

  it('opens the dialog with its entry, page and plan on a plain click', () => {
    const { service, link } = render(true);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(service.opening()).toEqual({ page: 'vendor_program', entry: 'card', plan: 'managed' });
  });

  it('leaves the link alone with no host, or on a new-tab click', () => {
    for (const [hosted, init] of [
      [false, {}],
      [true, { ctrlKey: true }],
    ] as const) {
      TestBed.resetTestingModule();
      const { service, link } = render(hosted);
      let prevented: boolean | null = null;
      link.addEventListener('click', (e) => {
        prevented = e.defaultPrevented;
        e.preventDefault();
      });
      link.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }),
      );
      expect(prevented).toBe(false);
      expect(service.isOpen()).toBe(false);
    }
  });
});
