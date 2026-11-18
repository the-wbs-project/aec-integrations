/**
 * AECI-1758 - `aecButton`, the one shared button. These specs pin the recipe each
 * variant renders, the states, the link form and the iconOnly name check.
 *
 * jsdom does not run Tailwind, so computed sizes and colours are checked in the
 * browser by `e2e/button.spec.ts`. The unlayered edge rules and the danger hover
 * token are pinned by `button-styles.guard.spec.ts`.
 */
import { Component, PLATFORM_ID, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, RouterLink, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BUTTON_PRIMARY_CLASS, BUTTON_SECONDARY_CLASS } from '../form-field/form-field-classes';
import { ServerHostClasses, applyHostRecipe, dropStaleRecipe, hostRecipe } from '../host-recipe';
import { AecIcon } from '../icon/icon';
import { AecButton, type AecButtonVariant, buttonClass, hasAccessibleName } from './button';

@Component({
  selector: 'aec-button-host',
  imports: [AecButton, AecIcon],
  template: `
    <button
      aecButton
      type="button"
      class="w-full"
      [variant]="variant()"
      [compact]="compact()"
      [disabled]="disabled()"
      data-testid="btn"
    >
      Save
    </button>
    <a aecButton variant="secondary" href="/docs" data-testid="link">Read the docs</a>
    @if (showIconOnly()) {
      <button
        aecButton
        variant="ghost"
        iconOnly
        type="button"
        data-testid="icon"
        [attr.aria-label]="iconLabel()"
      >
        <aec-icon name="search" decorative />
      </button>
    }
  `,
})
class Host {
  readonly variant = signal<AecButtonVariant>('primary');
  readonly compact = signal(false);
  readonly disabled = signal(false);
  readonly showIconOnly = signal(false);
  readonly iconLabel = signal<string | null>('Search');
}

const VARIANT_FILL: Record<AecButtonVariant, string[]> = {
  primary: ['bg-(--accent-primary)', 'text-(--surface-base)', 'hover:bg-(--accent-primary-hover)'],
  'on-brand': [
    'bg-(--accent-warm)',
    'text-(--accent-primary)',
    'hover:bg-(--surface-on-brand-hover)',
    'focus-visible:outline-(--focus-ring-on-brand)',
  ],
  'on-brand-secondary': [
    'aec-btn-on-brand-secondary',
    'bg-(--surface-on-brand-wash)',
    'text-(--text-on-brand)',
    'hover:bg-(--surface-on-brand-wash-hover)',
    'focus-visible:outline-(--focus-ring-on-brand)',
  ],
  secondary: ['aec-btn-secondary', 'bg-(--surface-raised)', 'hover:bg-(--surface-sunken)'],
  ghost: ['bg-transparent', 'text-(--text-primary)', 'hover:text-(--accent-primary)'],
  danger: ['bg-(--status-error)', 'text-(--surface-base)', 'hover:bg-(--status-error-hover)'],
};

const VARIANTS = Object.keys(VARIANT_FILL) as AecButtonVariant[];

const SHARED = [
  'aec-btn',
  'min-h-11',
  'rounded-control',
  'border',
  'text-t-14',
  'font-semibold',
  'focus-visible:outline-3',
  'focus-visible:outline-offset-3',
  'motion-safe:active:translate-y-px',
  'motion-safe:active:scale-98',
  'disabled:opacity-60',
  'aria-disabled:opacity-60',
];

describe('aecButton (AECI-1758)', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  const el = (id: string) =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    await fixture.whenStable();
  });

  afterEach(() => vi.restoreAllMocks());

  for (const variant of VARIANTS) {
    it(`renders the ${variant} variant with the shared frame and its own fill`, async () => {
      host.variant.set(variant);
      await fixture.whenStable();
      const btn = el('btn')!;
      for (const cls of [...SHARED, ...VARIANT_FILL[variant]]) {
        expect(btn.classList.contains(cls), `${variant} missing ${cls}`).toBe(true);
      }
      expect(btn.getAttribute('data-variant')).toBe(variant);
      // The fill of every other variant stays out.
      for (const other of VARIANTS) {
        const own = VARIANT_FILL[other][0];
        if (other === variant || VARIANT_FILL[variant].includes(own)) continue;
        expect(btn.classList.contains(own), `${variant} carries ${other}'s ${own}`).toBe(false);
      }
    });
  }

  it('never draws a pill, a shadow, a fixed height or a Clay fill on any variant', () => {
    for (const variant of VARIANTS) {
      for (const cls of [buttonClass(variant), buttonClass(variant, { iconOnly: true })]) {
        expect(cls).not.toMatch(/rounded-(full|pill)\b/);
        expect(cls).not.toMatch(/\bshadow-/);
        expect(cls).not.toMatch(/accent-secondary/);
        expect(cls).not.toMatch(/(^|\s)h-\d/);
      }
    }
  });

  it('keeps the caller’s layout classes beside the recipe', () => {
    const btn = el('btn')!;
    expect(btn.classList.contains('w-full')).toBe(true);
    expect(btn.classList.contains('min-h-11')).toBe(true);
  });

  it('gives ghost the compact padding without the flag', async () => {
    host.variant.set('ghost');
    await fixture.whenStable();
    expect(el('btn')!.classList.contains('px-4')).toBe(true);
    expect(el('btn')!.classList.contains('px-6')).toBe(false);
  });

  it('uses 24px side padding by default and 16px when compact, at the same height', async () => {
    expect(el('btn')!.classList.contains('px-6')).toBe(true);
    host.compact.set(true);
    await fixture.whenStable();
    const btn = el('btn')!;
    expect(btn.classList.contains('px-4')).toBe(true);
    expect(btn.classList.contains('px-6')).toBe(false);
    expect(btn.classList.contains('min-h-11')).toBe(true);
  });

  it('disables a native button: the attribute is set and a click does not fire', async () => {
    const onClick = vi.fn();
    el('btn')!.addEventListener('click', onClick);
    host.disabled.set(true);
    await fixture.whenStable();
    const btn = el('btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('styles a link as a button and keeps it a link', () => {
    const link = el('link') as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/docs');
    expect(link.getAttribute('role')).toBeNull();
    expect(link.classList.contains('aec-btn-secondary')).toBe(true);
    expect(link.classList.contains('no-underline')).toBe(true);
  });

  it('draws an iconOnly button as a 44px square', async () => {
    host.showIconOnly.set(true);
    await fixture.whenStable();
    const btn = el('icon')!;
    expect(btn.classList.contains('size-11')).toBe(true);
    expect(btn.classList.contains('px-6')).toBe(false);
  });

  it('logs an error in dev mode when an iconOnly button has no accessible name', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    host.iconLabel.set(null);
    host.showIconOnly.set(true);
    await fixture.whenStable();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('iconOnly button needs'),
      el('icon'),
    );
  });

  it('stays quiet when the iconOnly button has a name', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    host.showIconOnly.set(true);
    await fixture.whenStable();
    expect(error).not.toHaveBeenCalled();
  });

  it('counts a decorative icon as no name, and visible or hidden text as a name', () => {
    const b = document.createElement('button');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    b.appendChild(svg);
    expect(hasAccessibleName(b)).toBe(false);
    const hidden = document.createElement('span');
    hidden.className = 'sr-only';
    hidden.textContent = 'Close';
    b.appendChild(hidden);
    expect(hasAccessibleName(b)).toBe(true);
    const c = document.createElement('button');
    c.setAttribute('aria-labelledby', 'x');
    expect(hasAccessibleName(c)).toBe(true);
  });

  it('ignores text inside an aria-hidden subtree when it looks for a name', () => {
    const b = document.createElement('button');
    const hidden = document.createElement('span');
    hidden.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('span');
    inner.textContent = 'x';
    hidden.appendChild(inner);
    b.appendChild(hidden);
    expect(hasAccessibleName(b)).toBe(false);
    const img = document.createElement('span');
    img.setAttribute('role', 'img');
    img.setAttribute('aria-label', 'Search');
    hidden.appendChild(img);
    expect(hasAccessibleName(b)).toBe(false);
  });

  it('is what the two shared form-field constants render', () => {
    expect(BUTTON_PRIMARY_CLASS).toBe(buttonClass('primary'));
    expect(BUTTON_SECONDARY_CLASS).toBe(buttonClass('secondary'));
  });
});

@Component({
  selector: 'aec-button-link-host',
  imports: [AecButton, RouterLink],
  template: `
    <a aecButton variant="secondary" routerLink="/next" [disabled]="off()" data-testid="router-link"
      >Next</a
    >
    <a aecButton href="/plain" tabindex="2" [disabled]="off()" data-testid="href-link">Plain</a>
    <a aecButton href="/manual" aria-disabled="true" data-testid="manual-link">Manual</a>
    <form (submit)="onSubmit($event)">
      <button aecButton data-testid="bare">Bare</button>
      <button aecButton type="submit" data-testid="submit">Send</button>
    </form>
  `,
})
class LinkHost {
  readonly off = signal(true);
  submitted = 0;
  onSubmit(event: Event): void {
    event.preventDefault();
    this.submitted++;
  }
}

describe('aecButton disabled links and the default type (AECI-1758)', () => {
  let fixture: ComponentFixture<LinkHost>;
  let host: LinkHost;
  let navigate: { mock: { calls: unknown[] } };
  const el = (id: string) =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LinkHost],
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    }).compileComponents();
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture = TestBed.createComponent(LinkHost);
    host = fixture.componentInstance;
    await fixture.whenStable();
  });

  afterEach(() => vi.restoreAllMocks());

  const click = (node: HTMLElement) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    node.dispatchEvent(event);
    return event;
  };

  it('marks a disabled link aria-disabled and takes it out of the tab order', () => {
    for (const id of ['router-link', 'href-link']) {
      expect(el(id).getAttribute('aria-disabled'), id).toBe('true');
      expect(el(id).getAttribute('tabindex'), id).toBe('-1');
      expect(el(id).hasAttribute('disabled'), id).toBe(false);
    }
  });

  it('keeps the disabled look on the link, pointer events included', () => {
    expect(el('router-link').classList.contains('aria-disabled:pointer-events-none')).toBe(true);
    expect(el('router-link').classList.contains('aria-disabled:opacity-60')).toBe(true);
  });

  it('cancels a click on a disabled link, so neither the router nor the href navigates', () => {
    // Enter on a focused link fires this same click event in a browser.
    expect(click(el('router-link')).defaultPrevented).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(click(el('href-link')).defaultPrevented).toBe(true);
  });

  it('re-enabling restores navigation and the link’s own tabindex', async () => {
    host.off.set(false);
    await fixture.whenStable();
    expect(el('router-link').hasAttribute('aria-disabled')).toBe(false);
    expect(el('router-link').hasAttribute('tabindex')).toBe(false);
    expect(el('href-link').getAttribute('tabindex')).toBe('2');
    expect(click(el('href-link')).defaultPrevented).toBe(false);
    click(el('router-link'));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('gives a hand-set aria-disabled only the look: the link still navigates', () => {
    const manual = el('manual-link');
    expect(manual.getAttribute('aria-disabled')).toBe('true');
    expect(manual.hasAttribute('tabindex')).toBe(false);
    expect(click(manual).defaultPrevented).toBe(false);
  });

  it('gives a bare button type="button" so it never submits its form', () => {
    expect(el('bare').getAttribute('type')).toBe('button');
    el('bare').click();
    expect(host.submitted).toBe(0);
  });

  it('keeps an explicit type="submit"', () => {
    expect(el('submit').getAttribute('type')).toBe('submit');
    el('submit').click();
    expect(host.submitted).toBe(1);
  });
});

/**
 * AECI-1937: Angular writes an element's static classes when it creates the
 * element and applies the `[class]` host binding only in the first update pass.
 * `TestBed.createComponent` runs that creation pass, so the state before the
 * first update is the state a style read or a frame could land on in the gap.
 * These hosts are client-created: no server class list exists for them.
 */
@Component({
  imports: [AecButton],
  template: `
    <a aecButton variant="primary" class="mt-12" href="/" data-testid="static">Go home</a>
    <a aecButton class="mt-12" href="/" data-testid="default">Go home</a>
    <button aecButton variant="secondary" compact class="w-full" data-testid="attrs">Save</button>
    <button aecButton variant="ghost" iconOnly aria-label="Search" data-testid="icon"></button>
    <a aecButton class="grow" [variant]="bound()" href="/x" data-testid="bound">Review</a>
    @if (late()) {
      <a aecButton class="grow" [variant]="bound()" href="/y" data-testid="late">Review</a>
    }
  `,
})
class CreationHost {
  readonly bound = signal<AecButtonVariant>('secondary');
  readonly late = signal(false);
}

const ALL_FILLS = Object.values(VARIANT_FILL).flat();

describe('aecButton at the creation pass (AECI-1937)', () => {
  const tokens = (value: string) => value.split(' ');
  const create = (platform: 'browser' | 'server') => {
    TestBed.configureTestingModule({
      imports: [CreationHost],
      providers: [provideZonelessChangeDetection(), { provide: PLATFORM_ID, useValue: platform }],
    });
    const fixture = TestBed.createComponent(CreationHost);
    const el = (id: string) =>
      fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    return { fixture, el };
  };
  /** Every class list an element has had: each mutation's old value, then now. */
  const watch = () => {
    const seen = new Map<string, string[]>();
    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true,
    });
    const note = (el: Element, value: string | null) => {
      const id = el.getAttribute('data-testid');
      if (id) seen.set(id, [...(seen.get(id) ?? []), value ?? '']);
    };
    return (fixture: { nativeElement: HTMLElement }) => {
      for (const r of observer.takeRecords()) {
        if (r.type === 'attributes') note(r.target as Element, r.oldValue);
        for (const n of Array.from(r.addedNodes)) {
          if (n instanceof Element) note(n, n.getAttribute('class'));
        }
      }
      for (const el of Array.from(fixture.nativeElement.querySelectorAll('[data-testid]'))) {
        note(el, el.getAttribute('class'));
      }
      observer.disconnect();
      return seen;
    };
  };
  afterEach(() => TestBed.resetTestingModule());

  it('has the whole recipe beside the static class before the first update when the variant is static', () => {
    const { el } = create('browser');
    for (const cls of ['mt-12', ...tokens(buttonClass('primary'))]) {
      expect(el('static').classList.contains(cls), cls).toBe(true);
    }
  });

  it('adds the shape but no fill when no attribute fixes the variant', async () => {
    const { fixture, el } = create('browser');
    const btn = el('default').classList;
    for (const cls of ['mt-12', 'py-2', ...SHARED]) expect(btn.contains(cls), cls).toBe(true);
    for (const cls of ALL_FILLS) expect(btn.contains(cls), cls).toBe(false);
    await fixture.whenStable();
    for (const cls of tokens(buttonClass('primary'))) expect(btn.contains(cls), cls).toBe(true);
  });

  it('reads static variant and compact attributes before inputs are set', () => {
    const { el } = create('browser');
    const btn = el('attrs').classList;
    for (const cls of ['w-full', ...tokens(buttonClass('secondary', { compact: true }))]) {
      expect(btn.contains(cls), cls).toBe(true);
    }
    expect(btn.contains('bg-(--accent-primary)')).toBe(false);
  });

  it('draws a static iconOnly button as its 44px square before the first update', () => {
    const { el } = create('browser');
    for (const cls of tokens(buttonClass('ghost', { iconOnly: true }))) {
      expect(el('icon').classList.contains(cls), cls).toBe(true);
    }
  });

  it('never shows a primary fill on a bound secondary button, at creation or after', async () => {
    const collect = watch();
    const { fixture, el } = create('browser');
    await fixture.whenStable();
    fixture.componentInstance.late.set(true);
    await fixture.whenStable();
    const seen = collect(fixture);
    for (const id of ['bound', 'late']) {
      const states = seen.get(id) ?? [];
      expect(states.length, id).toBeGreaterThan(0);
      for (const state of states) {
        expect(tokens(state), `${id}: ${state}`).not.toContain('bg-(--accent-primary)');
      }
      for (const cls of ['grow', ...tokens(buttonClass('secondary'))]) {
        expect(el(id).classList.contains(cls), `${id} ${cls}`).toBe(true);
      }
    }
  });

  it('follows a bound variant changed after load, with nothing left from creation', async () => {
    const { fixture, el } = create('browser');
    await fixture.whenStable();
    fixture.componentInstance.bound.set('danger');
    await fixture.whenStable();
    const settled = el('bound').classList;
    for (const cls of tokens(buttonClass('danger'))) expect(settled.contains(cls), cls).toBe(true);
    for (const cls of VARIANT_FILL.secondary) expect(settled.contains(cls), cls).toBe(false);
  });

  it('adds nothing in the server render, so the server HTML is unchanged', async () => {
    const { fixture, el } = create('server');
    expect(el('static').getAttribute('class')).toBe('mt-12');
    await fixture.whenStable();
    expect(el('static').classList.contains('aec-btn')).toBe(true);
  });
});

describe('host recipe on a server node (AECI-1937)', () => {
  const recipe = hostRecipe(
    'aec-btn',
    VARIANTS.map((v) => buttonClass(v)),
    VARIANTS.map((v) => buttonClass(v)),
  );
  const serverNode = (cls: string) => {
    const a = document.createElement('a');
    a.setAttribute('aecbutton', '');
    a.setAttribute('class', cls);
    document.body.appendChild(a);
    return a;
  };
  afterEach(() => document.body.replaceChildren());

  it('puts back the recipe classes the server wrote, and only those', () => {
    const server = new ServerHostClasses();
    const a = serverNode(`mt-12 foreign ${buttonClass('secondary')}`);
    server.record(document, '[aecbutton][class]');
    a.setAttribute('class', 'mt-12'); // the creation pass's static write
    const added = applyHostRecipe(a, recipe, server, true);
    for (const cls of ['mt-12', ...buttonClass('secondary').split(' ')]) {
      expect(a.classList.contains(cls), cls).toBe(true);
    }
    expect(a.classList.contains('foreign')).toBe(false);
    expect(added).not.toContain('mt-12');
    // Each list is taken once.
    expect(server.take(a)).toBeNull();
  });

  it('drops a server class the client settles without, keeping the static class', () => {
    const server = new ServerHostClasses();
    const a = serverNode(`mt-12 ${buttonClass('primary')}`);
    server.record(document, '[aecbutton][class]');
    a.setAttribute('class', 'mt-12');
    const added = applyHostRecipe(a, recipe, server, true);
    dropStaleRecipe(a, added, buttonClass('secondary'));
    for (const cls of VARIANT_FILL.primary) expect(a.classList.contains(cls), cls).toBe(false);
    expect(a.classList.contains('mt-12')).toBe(true);
  });

  it('leaves a server node alone when the static write did not touch it', () => {
    const server = new ServerHostClasses();
    const list = buttonClass('ghost');
    const a = serverNode(list);
    server.record(document, '[aecbutton][class]');
    expect(applyHostRecipe(a, recipe, server, true)).toEqual([]);
    expect(a.getAttribute('class')).toBe(list);
  });
});
