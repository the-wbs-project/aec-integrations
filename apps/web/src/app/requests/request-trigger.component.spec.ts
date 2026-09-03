import { Component, PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { RequestDrawerService } from './request-drawer.service';
import { RequestTrigger } from './request-trigger';

@Component({
  selector: 'aec-trigger-host',
  imports: [RequestTrigger],
  template: `<a
    aecRequestTrigger
    [entity]="'product'"
    [kind]="'correction'"
    [slug]="'acme'"
    href="/products/acme/correction"
    >Suggest a correction</a
  >`,
})
class TriggerHost {}

/** The claimed-listing variant: a `claim` trigger on a vendor whose `verified`
 *  bit is set, i.e. the detail-page CTA that reads "Request access to this
 *  listing". Only the drawer copy differs — same kind, same endpoint. */
@Component({
  selector: 'aec-claimed-trigger-host',
  imports: [RequestTrigger],
  template: `<a
    aecRequestTrigger
    [entity]="'vendor'"
    [kind]="'claim'"
    [slug]="'acme'"
    [claimed]="true"
    href="/vendors/acme/claim"
    >Request access to this listing</a
  >`,
})
class ClaimedTriggerHost {}

function setup(platform: 'browser' | 'server' = 'browser') {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: PLATFORM_ID, useValue: platform }],
  });
  const fixture = TestBed.createComponent(TriggerHost);
  fixture.detectChanges();
  const anchor = (fixture.nativeElement as HTMLElement).querySelector('a') as HTMLAnchorElement;
  const drawer = TestBed.inject(RequestDrawerService);
  return { fixture, anchor, drawer };
}

/** Dispatch a cancelable click and report whether the default (navigation) was prevented. */
function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}): boolean {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  anchor.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe('RequestDrawerService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('starts closed and opens/closes with the active target', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const svc = TestBed.inject(RequestDrawerService);
    expect(svc.isOpen()).toBe(false);
    expect(svc.target()).toBeNull();

    svc.open({ entity: 'vendor', kind: 'claim', slug: 'acme' });
    expect(svc.isOpen()).toBe(true);
    expect(svc.target()).toEqual({ entity: 'vendor', kind: 'claim', slug: 'acme' });

    svc.close();
    expect(svc.isOpen()).toBe(false);
    expect(svc.target()).toBeNull();
  });
});

describe('RequestTrigger', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('intercepts a primary click in the browser: prevents navigation and opens the drawer', () => {
    const { anchor, drawer } = setup('browser');
    const prevented = click(anchor);
    expect(prevented).toBe(true);
    expect(drawer.isOpen()).toBe(true);
    expect(drawer.target()).toEqual({
      entity: 'product',
      kind: 'correction',
      slug: 'acme',
      claimed: false,
    });
  });

  it('forwards `claimed` so the drawer opens with the request-access copy', () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: PLATFORM_ID, useValue: 'browser' }],
    });
    const fixture = TestBed.createComponent(ClaimedTriggerHost);
    fixture.detectChanges();
    const anchor = (fixture.nativeElement as HTMLElement).querySelector('a') as HTMLAnchorElement;
    const drawer = TestBed.inject(RequestDrawerService);

    expect(click(anchor)).toBe(true);
    // Same `kind:'claim'` as an unclaimed listing — `claimed` is copy-only and
    // changes no field, no endpoint and no payload.
    expect(drawer.target()).toEqual({
      entity: 'vendor',
      kind: 'claim',
      slug: 'acme',
      claimed: true,
    });
  });

  it('leaves modified clicks (new-tab) to the browser — no preventDefault, no drawer', () => {
    const { anchor, drawer } = setup('browser');
    const prevented = click(anchor, { metaKey: true });
    expect(prevented).toBe(false);
    expect(drawer.isOpen()).toBe(false);
  });

  it('does nothing on the server (no JS): the anchor href navigates as the fallback', () => {
    const { anchor, drawer } = setup('server');
    const prevented = click(anchor);
    expect(prevented).toBe(false);
    expect(drawer.isOpen()).toBe(false);
  });
});
