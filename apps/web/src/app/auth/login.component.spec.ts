import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service';
import { LoginPage } from './login';

function mockRoute(returnParam: string | null): ActivatedRoute {
  return {
    snapshot: {
      queryParamMap: convertToParamMap(returnParam === null ? {} : { return: returnParam }),
    },
  } as unknown as ActivatedRoute;
}

/** Macrotask boundary — drains the async `validateStandardSchema` validation
 *  resource (mirrors the request-form harness `settle()`). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

interface AuthMock {
  isConfigured: ReturnType<typeof vi.fn>;
  sendMagicLink: ReturnType<typeof vi.fn>;
  signInWithGoogle: ReturnType<typeof vi.fn>;
}

function makeAuthMock(configured = true): AuthMock {
  return {
    isConfigured: vi.fn(() => configured),
    sendMagicLink: vi.fn(async () => undefined),
    signInWithGoogle: vi.fn(async () => undefined),
  };
}

async function setup(opts: { returnParam?: string | null; configured?: boolean } = {}) {
  const auth = makeAuthMock(opts.configured ?? true);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: mockRoute(opts.returnParam ?? null) },
      { provide: AuthService, useValue: auth },
    ],
  });
  const fixture = TestBed.createComponent(LoginPage);
  fixture.detectChanges();
  // Drain afterNextRender (the isConfigured probe) before asserting.
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, auth, el: fixture.nativeElement as HTMLElement };
}

function typeEmail(fixture: ComponentFixture<unknown>, value: string) {
  const input = (fixture.nativeElement as HTMLElement).querySelector(
    '#login-email',
  ) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
}

async function submitForm(fixture: ComponentFixture<unknown>) {
  const form = (fixture.nativeElement as HTMLElement).querySelector('form') as HTMLFormElement;
  form.dispatchEvent(new Event('submit'));
  await settle();
  fixture.detectChanges();
}

describe('LoginPage', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders a labeled email input and the Google button', async () => {
    const { el } = await setup();
    const label = el.querySelector('label[for="login-email"]');
    expect(label, 'a real <label for="login-email"> must exist').not.toBeNull();
    expect(el.querySelector('#login-email')).not.toBeNull();
    expect(el.textContent).toContain('Continue with Google');
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain(
      'Email me a sign-in link',
    );
  });

  it('disables submit while the email is invalid and never calls the service', async () => {
    const { fixture, el, auth } = await setup();
    typeEmail(fixture, 'not-an-email');
    await settle();
    fixture.detectChanges();

    const button = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await submitForm(fixture);
    expect(auth.sendMagicLink).not.toHaveBeenCalled();
  });

  it('surfaces the email error once the field is touched', async () => {
    const { fixture, el } = await setup();
    typeEmail(fixture, 'nope');
    await settle();
    fixture.detectChanges();

    const error = el.querySelector('#login-email-error');
    expect(error).not.toBeNull();
    expect(error?.getAttribute('role')).toBe('alert');
  });

  it('sends the magic link with the validated return path and shows the confirmation', async () => {
    const { fixture, el, auth } = await setup({ returnParam: '/products/procore' });
    typeEmail(fixture, 'pm@example.com');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    expect(auth.sendMagicLink).toHaveBeenCalledTimes(1);
    expect(auth.sendMagicLink).toHaveBeenCalledWith('pm@example.com', '/products/procore');
    expect(el.textContent).toContain('Check your email');
    expect(el.textContent).toContain('pm@example.com');
  });

  it('collapses a hostile return param to / before it reaches the service', async () => {
    const { fixture, auth } = await setup({ returnParam: '//evil.example' });
    typeEmail(fixture, 'pm@example.com');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    expect(auth.sendMagicLink).toHaveBeenCalledWith('pm@example.com', '/');
  });

  it('threads the validated return path into the Google flow', async () => {
    const { el, auth } = await setup({ returnParam: '/vendors/acme' });
    const google = [...el.querySelectorAll('button[type="button"]')].find((b) =>
      b.textContent?.includes('Continue with Google'),
    ) as HTMLButtonElement;
    google.click();
    await settle();

    expect(auth.signInWithGoogle).toHaveBeenCalledTimes(1);
    expect(auth.signInWithGoogle).toHaveBeenCalledWith('/vendors/acme');
  });

  it('shows the retryable error notice when the magic link fails', async () => {
    const { fixture, el, auth } = await setup();
    auth.sendMagicLink.mockRejectedValueOnce(new Error('boom'));
    typeEmail(fixture, 'pm@example.com');
    await settle();
    fixture.detectChanges();
    await submitForm(fixture);

    const notice = el.querySelector('[role="alert"]');
    expect(notice?.textContent).toContain('Something went wrong');
    // The submit button must stay enabled so the user can retry.
    const button = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('renders the unavailable notice with disabled actions when unconfigured', async () => {
    const { el } = await setup({ configured: false });
    expect(el.textContent).toContain('Sign-in is temporarily unavailable');
    const submitBtn = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
    const google = [...el.querySelectorAll('button[type="button"]')].find((b) =>
      b.textContent?.includes('Continue with Google'),
    ) as HTMLButtonElement;
    expect(google.disabled).toBe(true);
  });
});
