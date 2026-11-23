import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { EventPhase } from '@angular/core/primitives/event-dispatch';
import { describe, expect, it } from 'vitest';

import { AecFormSubmit } from './form-submit';

@Component({
  imports: [AecFormSubmit],
  template: `<form method="dialog" (aecSubmit)="count = count + 1"><input /></form>`,
})
class Host {
  count = 0;
}

function setup() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
  return { host: fixture.componentInstance, form };
}

describe('AecFormSubmit (AECI-1919)', () => {
  it('cancels a live submit and emits once', () => {
    const { host, form } = setup();
    const event = new Event('submit', { cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(host.count).toBe(1);
  });

  it('drops a replayed submit without calling preventDefault, which throws on a replay', () => {
    const { host, form } = setup();
    const event = new Event('submit', { cancelable: true });
    Object.defineProperty(event, 'eventPhase', { value: EventPhase.REPLAY });
    event.preventDefault = () => {
      throw new Error('preventDefault called during event replay');
    };
    expect(() => form.dispatchEvent(event)).not.toThrow();
    expect(host.count).toBe(0);
  });
});
