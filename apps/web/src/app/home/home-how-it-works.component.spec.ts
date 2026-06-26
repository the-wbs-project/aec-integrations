import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { HomeHowItWorks } from './home-how-it-works';

function setup(): HTMLElement {
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(HomeHowItWorks);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('HomeHowItWorks', () => {
  it('states the operating-model headline as the section heading', () => {
    expect(setup().querySelector('h2')?.textContent?.trim()).toBe('How a listing earns its place');
  });

  it('renders the steps as an ordered list (a genuine sequence), not a bare ul', () => {
    const h = setup();
    expect(h.querySelector('ol')).not.toBeNull();
    // The steps live in the <ol>; there is no separate <ul> in this band.
    expect(h.querySelector('ul')).toBeNull();
  });

  it('renders the three operating-model steps, each with a heading', () => {
    const steps = Array.from(setup().querySelectorAll('li'));
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.querySelector('h3')?.textContent?.trim())).toEqual([
      'Integrations are documented',
      'Practitioners review them',
      'Nothing is for sale',
    ]);
  });

  it('numbers the steps 1, 2, 3 as visible ordinals', () => {
    const numerals = Array.from(setup().querySelectorAll('li > span')).map((n) =>
      n.textContent?.trim(),
    );
    expect(numerals).toEqual(['1', '2', '3']);
  });

  it('is a static band — no rotation, no controls', () => {
    const h = setup();
    expect(h.querySelectorAll('button')).toHaveLength(0);
    expect(h.querySelector('[aria-roledescription="carousel"]')).toBeNull();
  });
});
