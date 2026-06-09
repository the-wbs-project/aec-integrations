import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { NavMenu } from './nav-menu';

// The dropdown panel renders into a CDK overlay that only mounts on click, so
// the "all four links + search + theme toggle + sign-in reachable when open"
// assertion lives in the Playwright e2e (e2e/nav-menu.spec.ts) where the overlay
// genuinely opens. Here we assert the always-rendered trigger has a correct
// accessible name and popup semantics.
describe('NavMenu', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  function toggle(): HTMLButtonElement {
    const fixture = TestBed.createComponent(NavMenu);
    fixture.detectChanges();
    return (fixture.nativeElement as HTMLElement).querySelector('button')!;
  }

  it('is hidden at md+ via its host class (hamburger is the small-screen affordance)', () => {
    const fixture = TestBed.createComponent(NavMenu);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).classList).toContain('md:hidden');
  });

  it('renders a labelled, button-type toggle', () => {
    const button = toggle();
    expect(button).toBeTruthy();
    expect(button.getAttribute('type')).toBe('button');
    // Accessible name comes from the i18n aria-label (icon is aria-hidden).
    expect(button.getAttribute('aria-label')).toBe('Open menu');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('exposes collapsed popup semantics before interaction', () => {
    const button = toggle();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});
