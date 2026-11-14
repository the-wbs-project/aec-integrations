/**
 * AECI-1753 - `AecIcon`. The accessibility contract fails silently: a wrongly
 * named or wrongly hidden icon still draws. These specs pin the two states
 * (decorative and meaningful), the stroke, and the registry shape.
 */
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AecIcon, type AecIconSize } from './icon';
import { AEC_ICONS, type AecIconName } from './icon-registry';

@Component({
  selector: 'aec-icon-host',
  imports: [AecIcon],
  template: `<aec-icon [name]="name" [size]="size" [label]="label" [mirrorRtl]="mirror" />`,
})
class Host {
  name: AecIconName = 'search';
  size: AecIconSize = 5;
  label: string | undefined = undefined;
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

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
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

  it('is decorative without a label: aria-hidden, no role, no name', () => {
    const el = svg(create());

    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hasAttribute('role')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
  });

  it('is an image with a name when given a label, and not hidden', () => {
    const el = svg(
      create((h) => {
        h.name = 'alert-circle';
        h.label = 'Needs review';
      }),
    );

    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe('Needs review');
    expect(el.hasAttribute('aria-hidden')).toBe(false);
  });

  it('treats a blank label as decorative, never an image with an empty name', () => {
    const el = svg(create((h) => (h.label = '   ')));

    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hasAttribute('role')).toBe(false);
    expect(el.hasAttribute('aria-label')).toBe(false);
  });

  it('is never keyboard focusable', () => {
    expect(svg(create()).getAttribute('focusable')).toBe('false');
  });

  it.each([
    [4, 'h-4 w-4'],
    [5, 'h-5 w-5'],
    [6, 'h-6 w-6'],
  ] as const)('maps size %i to Tailwind classes %s', (size, classes) => {
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
});
