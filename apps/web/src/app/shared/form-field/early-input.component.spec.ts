/**
 * AECI-1720: `AecEarlyInput` puts back what a visitor typed before hydration, and no
 * checkbox, consent or otherwise, is ever carried.
 *
 * In the browser the inline recorder in `src/index.html` keeps each changed field's
 * last value and exposes `take` and `stop` (`e2e/forms-early-input.spec.ts` pins that
 * half). Here a stand-in recorder answers by element id, so the spec can name an entry
 * before the element exists. The first render writes the model's value over the
 * control, as hydration does, and the directive then restores the visitor's value.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, type Type, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormField, form } from '@angular/forms/signals';
import { afterEach, describe, expect, it } from 'vitest';

import { LegalInForceClient } from '../../legal/legal-in-force-client';
import { VendorTermsBox } from '../../requests/vendor-terms-box';
import { AecConsentBox } from './consent-box';
import {
  AecEarlyInput,
  EARLY_INPUT_KEY,
  type EarlyInputValue,
  restoreEarlyInput,
  stopEarlyInput,
  takeEarlyInput,
} from './early-input';

/** A stand-in for the recorder, answering by element id. */
function installRecorder(byId: Record<string, EarlyInputValue>) {
  const state = { taken: [] as string[], asked: [] as string[], stopped: false };
  const rec = {
    take(el: object) {
      const id = (el as Element).id;
      state.asked.push(id);
      if (state.stopped || !(id in byId)) return undefined;
      state.taken.push(id);
      const value = byId[id];
      delete byId[id];
      return value;
    },
    stop() {
      state.stopped = true;
    },
  };
  (window as unknown as Record<string, unknown>)[EARLY_INPUT_KEY] = rec;
  return state;
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[EARLY_INPUT_KEY];
});

@Component({
  imports: [FormField, AecEarlyInput, AecConsentBox],
  template: `
    <form method="dialog">
      <input id="name" [formField]="f.name" />
      <textarea id="body" [formField]="f.body"></textarea>
      <select id="role" [formField]="f.role">
        <option value="">Choose</option>
        <option value="pm">Product manager</option>
      </select>
      <input id="size-small" type="radio" value="small" [formField]="f.size" />
      <input id="size-large" type="radio" value="large" [formField]="f.size" />
      <input id="optin" type="checkbox" [formField]="f.optin" />
      <input id="accepted" type="checkbox" aecConsent [formField]="f.accepted" />
      <input id="plain" />
    </form>
  `,
})
class SignalFormHost {
  readonly model = signal({
    name: '',
    body: '',
    role: '',
    size: '',
    optin: false,
    accepted: false,
  });
  readonly f = form(this.model);
}

@Component({
  imports: [AecConsentBox],
  template: `<input
    id="box"
    type="checkbox"
    aecConsent
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
  fixture.detectChanges();
  return fixture;
}

const el = <T extends Element>(root: HTMLElement, id: string) => root.querySelector(`#${id}`) as T;

describe('AecEarlyInput (AECI-1720)', () => {
  it('carries early answers in text fields, a textarea, a select and a radio group', async () => {
    const rec = installRecorder({
      name: { value: 'Jane Example', checked: false },
      body: { value: 'Please list us.', checked: false },
      role: { value: 'pm', checked: false },
      'size-large': { value: 'large', checked: true },
    });
    const fixture = await render(SignalFormHost);
    const root = fixture.nativeElement as HTMLElement;

    expect(fixture.componentInstance.model()).toMatchObject({
      name: 'Jane Example',
      body: 'Please list us.',
      role: 'pm',
      size: 'large',
    });
    expect(el<HTMLInputElement>(root, 'name').value).toBe('Jane Example');
    expect(el<HTMLInputElement>(root, 'size-large').checked).toBe(true);
    expect(rec.taken.sort()).toEqual(['body', 'name', 'role', 'size-large']);
  });

  it('never carries a checkbox: neither an opt-in nor a consent box', async () => {
    const rec = installRecorder({
      optin: { value: 'on', checked: true },
      accepted: { value: 'on', checked: true },
    });
    const fixture = await render(SignalFormHost);
    const root = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.model()).toMatchObject({ optin: false, accepted: false });
    expect(el<HTMLInputElement>(root, 'optin').checked).toBe(false);
    expect(el<HTMLInputElement>(root, 'accepted').checked).toBe(false);
    // The directive does not even sit on a checkbox, so it never asks for one.
    expect(rec.asked).not.toContain('optin');
    expect(rec.asked).not.toContain('accepted');
  });

  it('never carries a tick on the Vendor Terms box into accepted_terms', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    installRecorder({ 'claim-terms': { value: 'on', checked: true } });
    const fixture = await render(TermsBoxHost);
    expect(fixture.componentInstance.model().accepted_terms).toBe(false);
    expect(el<HTMLInputElement>(fixture.nativeElement, 'claim-terms').checked).toBe(false);
  });

  it('never carries a tick on a consent box held in a template (change) listener', async () => {
    installRecorder({ box: { value: 'on', checked: true } });
    const fixture = await render(ChangeListenerHost);
    expect(fixture.componentInstance.ticked()).toBe(false);
    expect(el<HTMLInputElement>(fixture.nativeElement, 'box').checked).toBe(false);
  });

  it('leaves a field nobody changed to the model, and applies an entry once', async () => {
    installRecorder({ name: { value: 'Jane', checked: false } });
    const fixture = await render(SignalFormHost);
    expect(fixture.componentInstance.model()).toMatchObject({ name: 'Jane', body: '' });
    fixture.componentInstance.model.update((m) => ({ ...m, name: '' }));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(el<HTMLInputElement>(fixture.nativeElement, 'name').value).toBe('');
  });

  it('does nothing when the recorder is absent or has stopped', async () => {
    const rec = installRecorder({ name: { value: 'Jane', checked: false } });
    stopEarlyInput(window);
    expect(rec.stopped).toBe(true);
    const fixture = await render(SignalFormHost);
    expect(fixture.componentInstance.model().name).toBe('');
    delete (window as unknown as Record<string, unknown>)[EARLY_INPUT_KEY];
    expect(() => stopEarlyInput(window)).not.toThrow();
  });

  it('does not sit on a control without [formField]', async () => {
    const rec = installRecorder({ plain: { value: 'typed', checked: false } });
    const fixture = await render(SignalFormHost);
    expect(el<HTMLInputElement>(fixture.nativeElement, 'plain').value).toBe('');
    expect(rec.asked).not.toContain('plain');
  });
});

describe('AecConsentBox (AECI-1720)', () => {
  it('is enabled once the app has rendered in the browser', async () => {
    const fixture = await render(ChangeListenerHost);
    expect(el<HTMLInputElement>(fixture.nativeElement, 'box').disabled).toBe(false);
  });
});

describe('VendorTermsBox: the version line changes under a ticked box (AECI-1720)', () => {
  function setupBox() {
    const versions = signal({
      agreements: {},
      policies: { listing_accuracy: '1.0', review_guidelines: '1.0' },
    });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LegalInForceClient, useValue: { versions, refresh: () => Promise.resolve() } },
      ],
    });
    return versions;
  }

  it('unticks the box and marks it touched, so the error asks for a fresh tick', async () => {
    const versions = setupBox();
    const fixture = await render(TermsBoxHost);
    const host = fixture.componentInstance;
    host.model.set({ accepted_terms: true });
    fixture.detectChanges();
    await fixture.whenStable();

    versions.set({
      agreements: {},
      policies: { listing_accuracy: '1.1', review_guidelines: '1.0' },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(host.model().accepted_terms).toBe(false);
    expect(host.f.accepted_terms().touched()).toBe(true);
    const root = fixture.nativeElement as HTMLElement;
    expect(el<HTMLInputElement>(root, 'claim-terms').checked).toBe(false);
    expect(el<HTMLInputElement>(root, 'claim-terms').getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('#claim-terms-error')).not.toBeNull();
  });

  it('keeps the tick while the line stays the same, and never ticks an unticked box', async () => {
    const versions = setupBox();
    const fixture = await render(TermsBoxHost);
    const host = fixture.componentInstance;
    versions.set({
      agreements: {},
      policies: { listing_accuracy: '1.1', review_guidelines: '1.0' },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.model().accepted_terms).toBe(false);
    expect(host.f.accepted_terms().touched()).toBe(false);

    host.model.set({ accepted_terms: true });
    versions.set({
      agreements: {},
      policies: { listing_accuracy: '1.1', review_guidelines: '1.0' },
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.model().accepted_terms).toBe(true);
  });
});

describe('restoreEarlyInput / takeEarlyInput (AECI-1720)', () => {
  it('announces a value with input then change', () => {
    const field = document.createElement('input');
    const seen: string[] = [];
    for (const type of ['input', 'change']) field.addEventListener(type, (e) => seen.push(e.type));
    expect(restoreEarlyInput(field, { value: 'Jane', checked: false })).toBe(true);
    expect(field.value).toBe('Jane');
    expect(seen).toEqual(['input', 'change']);
  });

  it('refuses any checkbox and any consent-marked control', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    expect(restoreEarlyInput(box, { value: 'on', checked: true })).toBe(false);
    expect(box.checked).toBe(false);
    const marked = document.createElement('input');
    marked.setAttribute('aecConsent', '');
    expect(restoreEarlyInput(marked, { value: 'x', checked: false })).toBe(false);
    const win = { [EARLY_INPUT_KEY]: { take: () => ({ value: 'on', checked: true }), stop() {} } };
    expect(takeEarlyInput(win as unknown as Window, box)).toBeUndefined();
  });

  it('fires nothing when the control already shows the value', () => {
    const field = document.createElement('input');
    field.value = 'same';
    let fired = 0;
    field.addEventListener('input', () => fired++);
    expect(restoreEarlyInput(field, { value: 'same', checked: false })).toBe(false);
    expect(fired).toBe(0);
  });

  it('ignores a global that is not the recorder', () => {
    const field = document.createElement('input');
    const forged = { [EARLY_INPUT_KEY]: new WeakMap([[field, { value: 'x', checked: false }]]) };
    expect(takeEarlyInput(forged as unknown as Window, field)).toBeUndefined();
    expect(takeEarlyInput(null, field)).toBeUndefined();
  });
});
