import { PLATFORM_ID } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ThemeService } from '../theme.service';
import { ThemeToggleGroup } from './theme-toggle-group';

const DARK_CLASS = 'theme-dark';

// The three segments render a real <button> each; the active mode is conveyed by
// `aria-pressed` (single active segment) and styling keys off it. Behaviour here
// depends only on `ThemeService.mode()`, so we run under the `server` PLATFORM_ID
// to avoid the service's browser-only `afterNextRender` → `window.matchMedia`,
// which jsdom does not implement. `setMode` still updates the `_mode` signal on
// the server; only its localStorage/cookie persistence is browser-gated.
describe('ThemeToggleGroup', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    // DOCUMENT is the shared jsdom document — drop any class a prior suite left
    // so the constructor effect starts from a clean slate.
    document.documentElement.classList.remove(DARK_CLASS);
    TestBed.configureTestingModule({
      providers: [{ provide: PLATFORM_ID, useValue: 'server' }],
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove(DARK_CLASS);
  });

  function render(): {
    fixture: ComponentFixture<ThemeToggleGroup>;
    group: HTMLElement;
    buttons: Record<string, HTMLButtonElement>;
  } {
    const fixture = TestBed.createComponent(ThemeToggleGroup);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    const group = host.querySelector<HTMLElement>('[role="group"]')!;
    const buttons: Record<string, HTMLButtonElement> = {};
    for (const btn of Array.from(group.querySelectorAll('button'))) {
      buttons[btn.textContent!.trim()] = btn;
    }
    return { fixture, group, buttons };
  }

  it('renders a labelled group of three button-type segments', () => {
    const { group, buttons } = render();
    expect(group.getAttribute('aria-label')).toBe('Theme');
    expect(Object.keys(buttons).sort()).toEqual(['Dark', 'Light', 'System']);
    for (const btn of Object.values(buttons)) {
      expect(btn.getAttribute('type')).toBe('button');
    }
  });

  it('marks the default System mode pressed and the others unpressed', () => {
    const { buttons } = render();
    expect(buttons['System'].getAttribute('aria-pressed')).toBe('true');
    expect(buttons['Light'].getAttribute('aria-pressed')).toBe('false');
    expect(buttons['Dark'].getAttribute('aria-pressed')).toBe('false');
  });

  it('moves the pressed state and the service mode when a segment is clicked', () => {
    const service = TestBed.inject(ThemeService);
    const { fixture, buttons } = render();

    buttons['Dark'].click();
    fixture.detectChanges();

    expect(service.mode()).toBe('dark');
    expect(buttons['Dark'].getAttribute('aria-pressed')).toBe('true');
    expect(buttons['System'].getAttribute('aria-pressed')).toBe('false');
    expect(buttons['Light'].getAttribute('aria-pressed')).toBe('false');
  });
});
