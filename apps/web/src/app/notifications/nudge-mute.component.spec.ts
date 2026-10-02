/**
 * `/notifications/mute` (AECI-1204) — the confirm page behind the digest footer's
 * mute link. The rule that matters most: rendering never mutes. Only the click
 * POSTs, so a mail scanner that prefetches the link changes nothing.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NudgeMutePage } from './nudge-mute';

const URL = '/api/notifications/nudges/mute';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

function setup(token: string | null) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(token ? { token } : {}) } },
      },
    ],
  });
  const fixture = TestBed.createComponent(NudgeMutePage);
  fixture.detectChanges();
  return { fixture, httpMock: TestBed.inject(HttpTestingController) };
}

/** The real route, so the Router's own URL is what the test reads. */
async function routed(url: string) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: 'notifications/mute', component: NudgeMutePage }]),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url, NudgeMutePage);
  await harness.fixture.whenStable();
  return {
    harness,
    router: TestBed.inject(Router),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
const confirm = (f: ComponentFixture<unknown>) => el(f).querySelector('button')!.click();

describe('NudgeMutePage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    window.history.replaceState({}, '', '/notifications/mute');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders the confirm prompt and does NOT POST on load', () => {
    const { fixture, httpMock } = setup('tok-1');
    expect(el(fixture).querySelector('h1')?.textContent).toContain(
      'Mute the daily reminder email?',
    );
    expect(el(fixture).querySelector('button')?.textContent).toContain('Mute daily reminder email');
    httpMock.expectNone(URL);
  });

  it('POSTs the token on the click and shows the muted state, focused', async () => {
    const { fixture, httpMock } = setup('tok-1');
    confirm(fixture);
    fixture.detectChanges();

    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ token: 'tok-1' });
    req.flush({ ok: true });
    await settle();
    fixture.detectChanges();

    const h1 = el(fixture).querySelector('h1')!;
    expect(h1.textContent).toContain('Daily reminder email muted');
    expect(document.activeElement).toBe(h1);
    expect(el(fixture).textContent).toContain('Seat invites, claim decisions');
  });

  it('shows the invalid-link state for an unknown token', async () => {
    const { fixture, httpMock } = setup('nope');
    confirm(fixture);
    httpMock.expectOne(URL).flush({ ok: false });
    await settle();
    fixture.detectChanges();
    expect(el(fixture).querySelector('h1')?.textContent).toContain('This link is no longer valid');
    expect(el(fixture).querySelector('a[href="/vendor"]')).not.toBeNull();
  });

  it('keeps the confirm available with an alert when the request fails', async () => {
    const { fixture, httpMock } = setup('tok-1');
    confirm(fixture);
    httpMock.expectOne(URL).flush('boom', { status: 500, statusText: 'Server Error' });
    await settle();
    fixture.detectChanges();
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'Something went wrong',
    );
    expect(el(fixture).querySelector('button')).not.toBeNull();
  });

  it('drops the token from the Router URL but still POSTs it', async () => {
    // Through the Router, so a cancelled navigation cannot write the token back.
    const { harness, router, httpMock } = await routed(
      '/notifications/mute?utm_source=email&token=tok-1#x',
    );

    expect(router.url).toBe('/notifications/mute?utm_source=email#x');

    harness.routeNativeElement!.querySelector('button')!.click();
    const req = httpMock.expectOne(URL);
    expect(req.request.body).toEqual({ token: 'tok-1' });
    req.flush({ ok: true });
    await settle();
  });

  it('leaves the URL alone when there is no token', async () => {
    const { router } = await routed('/notifications/mute?utm_source=email');
    expect(router.url).toBe('/notifications/mute?utm_source=email');
  });

  it('explains where the link lives when there is no token, with no button', () => {
    const { fixture } = setup(null);
    expect(el(fixture).querySelector('h1')?.textContent).toContain('Mute the daily reminder email');
    expect(el(fixture).querySelector('button')).toBeNull();
  });
});
