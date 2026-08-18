import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UnsubscribePage } from './unsubscribe';

/** Macrotask boundary — drains the awaited `unsubscribe` promise. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** The component reads `?token=` from the route snapshot at construction, so we
 *  stub `ActivatedRoute` rather than navigate. Pass `null` for the bare visit. */
function setup(token: string | null) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ActivatedRoute,
        useValue: {
          snapshot: { queryParamMap: convertToParamMap(token ? { token } : {}) },
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(UnsubscribePage);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return { fixture, httpMock, el: fixture.nativeElement as HTMLElement };
}

function clickConfirm(fixture: ComponentFixture<unknown>) {
  const button = (fixture.nativeElement as HTMLElement).querySelector(
    'button',
  ) as HTMLButtonElement;
  button.click();
}

describe('UnsubscribePage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    window.history.replaceState({}, '', '/unsubscribe');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders the confirm prompt (not a result) when a token is present, and does not auto-POST', () => {
    const { el, httpMock } = setup('tok-123');
    const h1 = el.querySelector('h1');
    expect(h1?.textContent).toContain('Unsubscribe from updates?');
    expect(el.querySelector('button')?.textContent).toContain('Unsubscribe');
    // A GET/load must never mutate — nothing is sent until the user confirms.
    httpMock.expectNone('/api/unsubscribe');
  });

  it('POSTs the token and shows the success state on { ok: true }', async () => {
    const { fixture, el, httpMock } = setup('tok-123');
    clickConfirm(fixture);
    await settle();

    const req = httpMock.expectOne('/api/unsubscribe');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ token: 'tok-123' });
    req.flush({ ok: true }, { status: 200, statusText: 'OK' });
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('h1')?.textContent).toContain("You've been unsubscribed");
    expect(el.querySelector('button')).toBeNull();
  });

  it('shows the invalid-link state on { ok: false }', async () => {
    const { fixture, el, httpMock } = setup('stale-token');
    clickConfirm(fixture);
    await settle();

    httpMock.expectOne('/api/unsubscribe').flush({ ok: false }, { status: 200, statusText: 'OK' });
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('h1')?.textContent).toContain('This link is no longer valid');
  });

  it('shows a retryable error and keeps the confirm button when the POST fails', async () => {
    const { fixture, el, httpMock } = setup('tok-123');
    clickConfirm(fixture);
    await settle();

    httpMock
      .expectOne('/api/unsubscribe')
      .flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Something went wrong');
    expect(el.querySelector('button')).not.toBeNull();
  });

  it('shows guidance and no confirm button (no POST) when the token is missing', () => {
    const { el, httpMock } = setup(null);
    expect(el.querySelector('h1')?.textContent).toContain('Unsubscribe from updates');
    expect(el.querySelector('button')).toBeNull();
    httpMock.expectNone('/api/unsubscribe');
  });
});
