import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
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
  hasSessionCookie: ReturnType<typeof vi.fn>;
  sessionSnapshot: ReturnType<typeof vi.fn>;
  sendMagicLink: ReturnType<typeof vi.fn>;
  signInWithGoogle: ReturnType<typeof vi.fn>;
}

/**
 * `cookie` / `signedIn` drive the AECI-954 silent resume: the synchronous
 * presence check, then the async probe that reports whether a session survived
 * the refresh. Both default to "no session", which is the state every pre-954
 * test assumed, so the resume never fires unless a test asks for it.
 */
function makeAuthMock(
  configured = true,
  opts: { cookie?: boolean; signedIn?: boolean } = {},
): AuthMock {
  return {
    isConfigured: vi.fn(() => configured),
    hasSessionCookie: vi.fn(() => opts.cookie ?? false),
    sessionSnapshot: vi.fn(async () => ({
      signedIn: opts.signedIn ?? false,
      email: null,
      userId: null,
      avatarUrl: null,
      fullName: null,
    })),
    sendMagicLink: vi.fn(async () => undefined),
    signInWithGoogle: vi.fn(async () => undefined),
  };
}

async function setup(
  opts: {
    returnParam?: string | null;
    configured?: boolean;
    cookie?: boolean;
    signedIn?: boolean;
  } = {},
) {
  const auth = makeAuthMock(opts.configured ?? true, {
    cookie: opts.cookie,
    signedIn: opts.signedIn,
  });
  const navigateByUrl = vi.fn(async () => true);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: mockRoute(opts.returnParam ?? null) },
      { provide: AuthService, useValue: auth },
    ],
  });
  // Stubbed rather than routed: the resume's contract is "which URL did it ask
  // for", and a real navigation here would need every return target registered.
  const router = TestBed.inject(Router);
  vi.spyOn(router, 'navigateByUrl').mockImplementation(
    navigateByUrl as unknown as Router['navigateByUrl'],
  );
  const fixture = TestBed.createComponent(LoginPage);
  fixture.detectChanges();
  // Drain afterNextRender (the isConfigured probe) and then the resume, which
  // settles a few microtasks later than `whenStable()` resolves.
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, auth, navigateByUrl, el: fixture.nativeElement as HTMLElement };
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

  it('marks the Google logo decorative so the button keeps a single accessible name', async () => {
    const { el } = await setup();
    const google = [...el.querySelectorAll('button[type="button"]')].find((b) =>
      b.textContent?.includes('Continue with Google'),
    ) as HTMLButtonElement;
    const logo = google.querySelector('svg');
    expect(logo, 'the Google "G" mark must render inside the button').not.toBeNull();
    expect(logo?.getAttribute('aria-hidden')).toBe('true');
    // The four brand fills are fixed — recoloring the mark to `currentColor`
    // would violate the Sign in with Google branding guidelines.
    expect([...google.querySelectorAll('svg path')].map((p) => p.getAttribute('fill'))).toEqual([
      '#EA4335',
      '#4285F4',
      '#FBBC05',
      '#34A853',
    ]);
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

/**
 * AECI-954 — the silent resume. A vendor or operator whose access token aged out
 * is bounced here by the `/vendor` and `/admin` gates, but the refresh token in
 * the same cookie is usually still good, so the page trades it for a fresh
 * session and sends them back rather than asking for a magic link they do not
 * need.
 *
 * The four cases below are the whole contract: it fires only with a `?return=`
 * path AND a cookie, it shows the restoring panel instead of the form while it
 * probes, it navigates on a live session, and it falls back to the form on a
 * dead one.
 */
describe('LoginPage — silent resume', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('navigates to the return path when the session survives the refresh', async () => {
    const { el, navigateByUrl } = await setup({
      returnParam: '/vendor/summit-bim/overview',
      cookie: true,
      signedIn: true,
    });

    expect(navigateByUrl).toHaveBeenCalledWith('/vendor/summit-bim/overview');
    // The panel stays up through the navigation so the form never flashes behind
    // the outgoing view.
    expect(el.textContent).toContain('Restoring your session');
    expect(el.querySelector('#login-email')).toBeNull();
  });

  it('falls back to the sign-in form when the session is genuinely gone', async () => {
    const { el, auth, navigateByUrl } = await setup({
      returnParam: '/vendor/summit-bim/overview',
      cookie: true,
      signedIn: false,
    });

    expect(auth.sessionSnapshot).toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain('Restoring your session');
    expect(el.querySelector('#login-email')).not.toBeNull();
  });

  it('never probes without a session cookie', async () => {
    const { el, auth, navigateByUrl } = await setup({
      returnParam: '/vendor/summit-bim/overview',
      cookie: false,
    });

    expect(auth.sessionSnapshot).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
    expect(el.querySelector('#login-email')).not.toBeNull();
  });

  it('never probes on a deliberate visit to bare /auth/login', async () => {
    // A signed-in visitor who clicks "Sign in" gets the form, not a bounce: with
    // no `?return=` there is nowhere to send them.
    const { el, auth } = await setup({ returnParam: null, cookie: true, signedIn: true });

    expect(auth.sessionSnapshot).not.toHaveBeenCalled();
    expect(el.querySelector('#login-email')).not.toBeNull();
  });
});
