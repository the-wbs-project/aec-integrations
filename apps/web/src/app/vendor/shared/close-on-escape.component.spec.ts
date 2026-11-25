import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { CloseOnEscape } from './close-on-escape';

@Component({
  selector: 'aec-test-close-on-escape-host',
  imports: [CloseOnEscape],
  template: `
    <div id="parent">
      <form aecCloseOnEscape [escapeBusy]="busy()" (escapeCancel)="cancels = cancels + 1">
        <input id="field" />
        <input
          id="combo"
          role="combobox"
          aria-controls="combo-list"
          [attr.aria-expanded]="comboOpen() ? 'true' : 'false'"
        />
        <button id="cancel" type="button" [disabled]="busy()">Cancel</button>
      </form>
    </div>
  `,
})
class TestHost {
  readonly busy = signal(false);
  readonly comboOpen = signal(false);
  cancels = 0;
  readonly parentKeys: string[] = [];
}

/**
 * AECI-2133: in a portal nested form, Escape does what Cancel does. It is ignored while
 * the form sends, during an input-method composition, when a control already spent it,
 * and from a combobox whose popup is open. Whenever the form owns the Escape, a parent
 * never sees it.
 */
describe('CloseOnEscape (AECI-2133)', () => {
  function render() {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(TestHost);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector('#parent')!.addEventListener('keydown', (e) =>
      fixture.componentInstance.parentKeys.push((e as KeyboardEvent).key),
    );
    return { fixture, host: fixture.componentInstance, el };
  }

  function press(target: Element, init: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  }

  it('calls the cancel handler on Escape and stops it reaching a parent', () => {
    const { host, el } = render();
    const event = press(el.querySelector('#field')!);
    expect(host.cancels).toBe(1);
    expect(host.parentKeys).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  it('accepts the legacy "Esc" key name', () => {
    const { host, el } = render();
    press(el.querySelector('#field')!, { key: 'Esc' });
    expect(host.cancels).toBe(1);
  });

  it('ignores every other key', () => {
    const { host, el } = render();
    press(el.querySelector('#field')!, { key: 'Enter' });
    expect(host.cancels).toBe(0);
    expect(host.parentKeys).toEqual(['Enter']);
  });

  it('does nothing while the form is busy, and still keeps the Escape from a parent', () => {
    const { fixture, host, el } = render();
    host.busy.set(true);
    fixture.detectChanges();
    press(el.querySelector('#field')!);
    expect(host.cancels).toBe(0);
    expect(host.parentKeys).toEqual([]);
  });

  it('ignores Escape during an input-method composition', () => {
    const { host, el } = render();
    press(el.querySelector('#field')!, { isComposing: true });
    expect(host.cancels).toBe(0);
  });

  it('ignores the keyCode 229 some browsers send while composing', () => {
    const { host, el } = render();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    Object.defineProperty(event, 'keyCode', { value: 229 });
    el.querySelector('#field')!.dispatchEvent(event);
    expect(host.cancels).toBe(0);
  });

  it('ignores an Escape a control inside the form already handled', () => {
    const { host, el } = render();
    const field = el.querySelector<HTMLInputElement>('#field')!;
    field.addEventListener('keydown', (e) => e.preventDefault());
    press(field);
    expect(host.cancels).toBe(0);
    // Not the form's Escape, so it is not the form's to stop either.
    expect(host.parentKeys).toEqual(['Escape']);
  });

  it('ignores an Escape from a combobox whose popup is open, and acts once it is closed', () => {
    const { fixture, host, el } = render();
    host.comboOpen.set(true);
    fixture.detectChanges();
    const combo = el.querySelector('#combo')!;
    press(combo);
    expect(host.cancels).toBe(0);
    host.comboOpen.set(false);
    fixture.detectChanges();
    press(combo);
    expect(host.cancels).toBe(1);
  });
});
