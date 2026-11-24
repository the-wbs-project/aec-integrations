import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { KeepClearOfSaveBar } from './keep-clear-of-save-bar';

@Component({
  selector: 'aec-test-keep-clear-host',
  imports: [KeepClearOfSaveBar],
  template: `
    <form aecKeepClearOfSaveBar>
      <input id="field" />
      <div class="aec-portal-save-bar"><button id="save" type="submit">Save</button></div>
    </form>
  `,
})
class TestKeepClearHost {}

/**
 * AECI-1811 built `aecKeepClearOfSaveBar`; AECI-1812 moved it to `vendor/shared/` so
 * every portal form with a sticky save bar can take it. A focused control outside the
 * bar asks for the nearest instant scroll. A control inside the bar is left alone.
 */
describe('KeepClearOfSaveBar (AECI-1811, AECI-1812)', () => {
  function render(): HTMLElement {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(TestKeepClearHost);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('scrolls a focused field to the nearest spot that clears the bar, instantly', () => {
    const host = render();
    const field = host.querySelector<HTMLInputElement>('#field')!;
    const scroll = vi.fn();
    field.scrollIntoView = scroll;
    field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(scroll).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
      behavior: 'instant',
    });
  });

  it('leaves a control inside the save bar alone', () => {
    const host = render();
    const save = host.querySelector<HTMLButtonElement>('#save')!;
    const scroll = vi.fn();
    save.scrollIntoView = scroll;
    save.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(scroll).not.toHaveBeenCalled();
  });
});
