/**
 * AECI-2102: the console's segmented filter (`console-filter.ts`), rendered the way a
 * screen uses it: a labelled group of pressed toggles, a tick on the pressed one.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { AecIcon } from '../../shared/icon/icon';
import { CONSOLE_FILTER } from './console-filter';
import { CONSOLE_LABEL_CLASS } from './console-table';

@Component({
  imports: [AecIcon],
  template: `
    <div [class]="f.toolbar">
      <div [class]="f.group">
        <span id="t-status-label" [class]="f.label">Status</span>
        <div role="group" aria-labelledby="t-status-label" [class]="f.seg">
          @for (opt of options; track opt) {
            <button
              type="button"
              [class]="f.option"
              [attr.aria-pressed]="value() === opt"
              (click)="value.set(opt)"
            >
              @if (value() === opt) {
                <aec-icon name="check" decorative [size]="4" />
              }
              {{ opt }}
            </button>
          }
        </div>
      </div>
    </div>
  `,
})
class FilterHost {
  protected readonly f = CONSOLE_FILTER;
  protected readonly options = ['Pending', 'Approved'];
  readonly value = signal('Pending');
}

function render() {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(FilterHost);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('CONSOLE_FILTER (AECI-2102)', () => {
  it('names the group by its visible label', () => {
    const { el } = render();
    const group = el.querySelector('[role="group"]') as HTMLElement;
    expect(el.querySelector(`#${group.getAttribute('aria-labelledby')}`)?.textContent).toBe(
      'Status',
    );
  });

  it('marks the pressed option with aria-pressed AND a tick, never colour alone', async () => {
    const { el, fixture } = render();
    const [pending, approved] = [...el.querySelectorAll('button')];
    expect(pending!.getAttribute('aria-pressed')).toBe('true');
    expect(pending!.querySelector('svg')).not.toBeNull();
    expect(approved!.getAttribute('aria-pressed')).toBe('false');
    expect(approved!.querySelector('svg')).toBeNull();

    approved!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(approved!.getAttribute('aria-pressed')).toBe('true');
    expect(approved!.querySelector('svg')).not.toBeNull();
    expect(pending!.querySelector('svg')).toBeNull();
  });

  it('keeps the recipe: the Label role, role radius, the Forest pressed fill, forced colours', () => {
    expect(CONSOLE_FILTER.label).toBe(CONSOLE_LABEL_CLASS);
    expect(CONSOLE_FILTER.seg).toContain('rounded-control');
    expect(CONSOLE_FILTER.option).toContain('rounded-mark');
    expect(CONSOLE_FILTER.option).toContain('aria-pressed:bg-(--accent-primary)');
    expect(CONSOLE_FILTER.option).toContain('forced-colors:aria-pressed:bg-[Highlight]');
    // Two weights only, no half steps.
    expect(Object.values(CONSOLE_FILTER).join(' ')).not.toMatch(/font-(medium|bold)|\d\.5\b/);
  });
});
