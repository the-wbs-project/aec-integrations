/**
 * AECI-1753 - `AecIcon`. The accessibility contract fails silently: a wrongly
 * named or wrongly hidden icon still draws. These specs pin the three valid
 * forms (`decorative`, `label="x"`, `[label]="x"`), the stroke, and the registry
 * shape.
 *
 * Compile-level contract: the selector is `aec-icon[label], aec-icon[decorative]`,
 * so `<aec-icon name="x" />` with neither fails AOT with NG8001. The last
 * describe block pins the runtime half of that: such an element is unknown (NG0304). The compile error itself is checked by `pnpm build`, which
 * fails the moment a call site omits both.
 */
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AecIcon, type AecIconSize } from './icon';
import { AEC_ICONS, type AecIconName } from './icon-registry';

@Component({
  selector: 'aec-icon-host',
  imports: [AecIcon],
  template: `
    @switch (form) {
      @case ('decorative') {
        <aec-icon [name]="name" decorative [size]="size" [mirrorRtl]="mirror" />
      }
      @case ('static') {
        <aec-icon [name]="name" label="Needs review" [size]="size" [mirrorRtl]="mirror" />
      }
      @case ('bound') {
        <aec-icon [name]="name" [label]="label" [size]="size" [mirrorRtl]="mirror" />
      }
    }
  `,
})
class Host {
  form: 'decorative' | 'static' | 'bound' = 'decorative';
  name: AecIconName = 'search';
  size: AecIconSize = 5;
  label: string | null | undefined = undefined;
  mirror = false;
}

function create(setup: (h: Host) => void = () => undefined): ComponentFixture<Host> {
  const fixture = TestBed.createComponent(Host);
  setup(fixture.componentInstance);
  fixture.detectChanges();
  return fixture;
}

const svg = (f: ComponentFixture<Host>) =>
  (f.nativeElement as HTMLElement).querySelector('svg') as SVGElement;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('AecIcon', () => {
  it('renders the drawing for the name', () => {
    const el = svg(create((h) => (h.name = 'search')));

    expect(el.querySelector('circle')?.getAttribute('r')).toBe('7');
    expect(el.querySelector('path')?.getAttribute('d')).toBe('m20 20-4-4');
  });

  it('renders every shape kind', () => {
    const el = svg(create((h) => (h.name = 'chart')));

    expect(el.querySelectorAll('path')).toHaveLength(1);
    expect(el.querySelectorAll('rect')).toHaveLength(3);
    expect(el.querySelector('rect')?.getAttribute('rx')).toBe('1');
  });

  it('draws at 1.75 stroke in currentColor with no fill', () => {
    const el = svg(create());

    expect(el.getAttribute('stroke-width')).toBe('1.75');
    expect(el.getAttribute('stroke')).toBe('currentColor');
    expect(el.getAttribute('fill')).toBe('none');
    expect(el.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('is never keyboard focusable', () => {
    expect(svg(create()).getAttribute('focusable')).toBe('false');
  });

  it.each([
    [3.5, 'h-3.5 w-3.5'],
    [4, 'h-4 w-4'],
    [5, 'h-5 w-5'],
    [6, 'h-6 w-6'],
  ] as const)('maps size %s to Tailwind classes %s', (size, classes) => {
    const cls = svg(create((h) => (h.size = size))).getAttribute('class') ?? '';

    for (const c of classes.split(' ')) expect(cls).toContain(c);
  });

  it('mirrors in RTL only when asked', () => {
    expect(svg(create()).getAttribute('class')).not.toContain('rtl:-scale-x-100');
    expect(svg(create((h) => (h.mirror = true))).getAttribute('class')).toContain(
      'rtl:-scale-x-100',
    );
  });

  it('renders nothing inside the SVG for a name outside the registry', () => {
    const el = svg(create((h) => (h.name = 'nope' as AecIconName)));

    expect(el.children).toHaveLength(0);
  });
});

describe('AecIcon: the decorative form', () => {
  it('is aria-hidden with no role and no name', () => {
    const el = svg(create((h) => (h.form = 'decorative')));

    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hasAttribute('role')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
  });

  it('does not warn', () => {
    create((h) => (h.form = 'decorative'));

    expect(warn).not.toHaveBeenCalled();
  });

  it('decorative wins over a label: hidden, no role, no name, no warning', () => {
    TestBed.overrideComponent(Host, {
      set: { template: '<aec-icon name="search" decorative label="Ignored" />' },
    });
    const el = svg(create());

    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hasAttribute('role')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('AecIcon: the label forms', () => {
  it('a static label="x" makes an image with that name, not hidden', () => {
    const el = svg(create((h) => (h.form = 'static')));

    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Needs review');
    expect(el.hasAttribute('aria-hidden')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a bound [label]="x" makes an image with that name, not hidden', () => {
    const el = svg(
      create((h) => {
        h.form = 'bound';
        h.label = 'Verified by both';
      }),
    );

    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Verified by both');
    expect(el.hasAttribute('aria-hidden')).toBe(false);
  });

  it.each([['   '], [''], [null], [undefined]])(
    'a bound blank label (%j) falls back to decorative and warns in dev',
    (blank) => {
      const el = svg(
        create((h) => {
          h.form = 'bound';
          h.name = 'alert-circle';
          h.label = blank;
        }),
      );

      expect(el.getAttribute('aria-hidden')).toBe('true');
      expect(el.hasAttribute('role')).toBe(false);
      expect(el.hasAttribute('aria-label')).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toContain('alert-circle');
    },
  );
});

describe('AecIcon: neither form', () => {
  it('is not a known element at runtime, which is why the build fails it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    TestBed.overrideComponent(Host, {
      set: { template: '<aec-icon name="search" />' },
    });

    expect(() => TestBed.createComponent(Host).detectChanges()).toThrow(/NG0304/);
    error.mockRestore();
  });
});

describe('AEC_ICONS registry', () => {
  it('has only kebab-case keys', () => {
    for (const key of Object.keys(AEC_ICONS)) expect(key).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it('gives every icon at least one shape and no colour attribute', () => {
    for (const [key, shapes] of Object.entries(AEC_ICONS)) {
      expect(shapes.length, key).toBeGreaterThan(0);
      expect(JSON.stringify(shapes), key).not.toMatch(/#|fill|stroke/);
    }
  });

  it('draws no two icons identically', () => {
    const seen = new Map<string, string>();
    for (const [key, shapes] of Object.entries(AEC_ICONS)) {
      const drawing = JSON.stringify(shapes);
      expect(seen.get(drawing), `${key} duplicates ${seen.get(drawing)}`).toBeUndefined();
      seen.set(drawing, key);
    }
  });
});
