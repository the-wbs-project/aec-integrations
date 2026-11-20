/**
 * AECI-1720: `AecEarlyInput` puts back what a visitor typed or ticked before hydration.
 *
 * In the browser the inline recorder in `src/index.html` keeps a `WeakMap` from each
 * changed field to its last value, written only by trusted events
 * (`e2e/forms-early-input.spec.ts` pins that half). Here a stand-in map answers by
 * element id, so the spec can name an entry before the element exists. The first
 * render writes the model's value over the control, as hydration does, and the
 * directive then restores the visitor's value into the control and the model.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, type Type, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormField, form } from '@angular/forms/signals';
import { afterEach, describe, expect, it } from 'vitest';

import { VendorTermsBox } from '../../requests/vendor-terms-box';
import {
  AecEarlyInput,
  EARLY_INPUT_KEY,
  type EarlyInputValue,
  restoreEarlyInput,
  takeEarlyInput,
} from './early-input';

/** The recorder's map, answering by element id. `taken` lists the ids applied. */
class KeptById extends WeakMap<object, EarlyInputValue> {
  readonly taken: string[] = [];
  constructor(private readonly byId: Record<string, EarlyInputValue>) {
    super();
  }
  override get(el: object): EarlyInputValue | undefined {
    return this.byId[(el as Element).id];
  }
  override delete(el: object): boolean {
    const id = (el as Element).id;
    if (!(id in this.byId)) return false;
    this.taken.push(id);
    delete this.byId[id];
    return true;
  }
}

function installRecorder(byId: Record<string, EarlyInputValue>): KeptById {
  const kept = new KeptById(byId);
  (window as unknown as Record<string, unknown>)[EARLY_INPUT_KEY] = kept;
  return kept;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[EARLY_INPUT_KEY];
});

@Component({
  imports: [FormField, AecEarlyInput],
  template: `
    <form method="dialog">
      <input id="name" [formField]="f.name" />
      <textarea id="body" [formField]="f.body"></textarea>
      <input id="terms" type="checkbox" [formField]="f.terms" />
      <input id="plain" />
    </form>
  `,
})
class SignalFormHost {
  readonly model = signal({ name: '', body: '', terms: false });
  readonly f = form(this.model);
}

@Component({
  imports: [AecEarlyInput],
  template: `<input
    id="box"
    type="checkbox"
    aecEarlyInput
    [checked]="ticked()"
    (change)="onTick($event)"
  />`,
})
class ChangeListenerHost {
  readonly ticked = signal(false);
  onTick(event: Event): void {
    this.ticked.set((event.target as HTMLInputElement).checked);
  }
}

@Component({
  imports: [VendorTermsBox],
  template: `<aec-vendor-terms-box [field]="f.accepted_terms" />`,
})
class TermsBoxHost {
  readonly model = signal({ accepted_terms: false });
  readonly f = form(this.model);
}

async function render<T>(type: Type<T>) {
  const fixture = TestBed.createComponent(type);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

const el = <T extends Element>(root: HTMLElement, id: string) => root.querySelector(`#${id}`) as T;

describe('AecEarlyInput (AECI-1720)', () => {
  it('carries an early tick and early answers into the Signal Forms model', async () => {
    const kept = installRecorder({
      name: { value: 'Jane Example', checked: false },
      body: { value: 'Please list us.', checked: false },
      terms: { value: 'on', checked: true },
    });
    const fixture = await render(SignalFormHost);
    const root = fixture.nativeElement as HTMLElement;

    expect(fixture.componentInstance.model()).toEqual({
      name: 'Jane Example',
      body: 'Please list us.',
      terms: true,
    });
    expect(el<HTMLInputElement>(root, 'terms').checked).toBe(true);
    expect(el<HTMLInputElement>(root, 'name').value).toBe('Jane Example');
    expect(el<HTMLTextAreaElement>(root, 'body').value).toBe('Please list us.');
    expect(kept.taken.sort()).toEqual(['body', 'name', 'terms']);
  });

  it('leaves a field the visitor never changed to the model', async () => {
    installRecorder({ name: { value: 'Jane', checked: false } });
    const fixture = await render(SignalFormHost);
    expect(fixture.componentInstance.model()).toEqual({ name: 'Jane', body: '', terms: false });
    expect(el<HTMLInputElement>(fixture.nativeElement, 'terms').checked).toBe(false);
  });

  it('carries false for a box ticked and unticked again', async () => {
    installRecorder({ terms: { value: 'on', checked: false } });
    const fixture = await render(SignalFormHost);
    expect(fixture.componentInstance.model().terms).toBe(false);
    expect(el<HTMLInputElement>(fixture.nativeElement, 'terms').checked).toBe(false);
  });

  it('applies an entry once: a later render does not write it again', async () => {
    installRecorder({ terms: { value: 'on', checked: true } });
    const fixture = await render(SignalFormHost);
    fixture.componentInstance.model.update((m) => ({ ...m, terms: false }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el<HTMLInputElement>(fixture.nativeElement, 'terms').checked).toBe(false);
  });

  it('does nothing when the recorder is absent', async () => {
    const fixture = await render(SignalFormHost);
    expect(fixture.componentInstance.model()).toEqual({ name: '', body: '', terms: false });
  });

  it('does not sit on a control without [formField] or the opt-in attribute', async () => {
    const kept = installRecorder({ plain: { value: 'typed', checked: false } });
    const fixture = await render(SignalFormHost);
    expect(el<HTMLInputElement>(fixture.nativeElement, 'plain').value).toBe('');
    expect(kept.taken).toEqual([]);
  });

  it('opts in a plain box whose template (change) listener holds the state', async () => {
    installRecorder({ box: { value: 'on', checked: true } });
    const fixture = await render(ChangeListenerHost);
    expect(fixture.componentInstance.ticked()).toBe(true);
    expect(el<HTMLInputElement>(fixture.nativeElement, 'box').checked).toBe(true);
  });

  it('carries an early tick on the Vendor Terms box into accepted_terms', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    installRecorder({ 'claim-terms': { value: 'on', checked: true } });
    const fixture = await render(TermsBoxHost);
    expect(fixture.componentInstance.model().accepted_terms).toBe(true);
    expect(el<HTMLInputElement>(fixture.nativeElement, 'claim-terms').checked).toBe(true);
  });
});

describe('restoreEarlyInput / takeEarlyInput (AECI-1720)', () => {
  it('announces the value with untrusted input then change, which the recorder ignores', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    const seen: string[] = [];
    for (const type of ['input', 'change']) {
      box.addEventListener(type, (e) => seen.push(`${e.type}:${e.isTrusted}`));
    }
    expect(restoreEarlyInput(box, { value: 'on', checked: true })).toBe(true);
    expect(box.checked).toBe(true);
    expect(seen).toEqual(['input:false', 'change:false']);
  });

  it('fires nothing when the control already shows the value', () => {
    const field = document.createElement('input');
    field.value = 'same';
    let fired = 0;
    field.addEventListener('input', () => fired++);
    expect(restoreEarlyInput(field, { value: 'same', checked: false })).toBe(false);
    expect(fired).toBe(0);
  });

  it('reads and removes an entry, and ignores anything that is not a WeakMap', () => {
    const field = document.createElement('input');
    const kept = new WeakMap<object, EarlyInputValue>([[field, { value: 'a', checked: false }]]);
    const win = { [EARLY_INPUT_KEY]: kept } as unknown as Window;
    expect(takeEarlyInput(win, field)).toEqual({ value: 'a', checked: false });
    expect(takeEarlyInput(win, field)).toBeUndefined();
    const forged = { [EARLY_INPUT_KEY]: { get: () => ({ value: 'x', checked: true }) } };
    expect(takeEarlyInput(forged as unknown as Window, field)).toBeUndefined();
    expect(takeEarlyInput(null, field)).toBeUndefined();
  });
});
