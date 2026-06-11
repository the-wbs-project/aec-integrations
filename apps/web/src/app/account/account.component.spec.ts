import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountProfileResponse } from '@aeci/shared';

import { AuthService } from '../auth/auth.service';
import { AccountApi } from './account-api';
import { AccountPage } from './account';

const PROFILE: AccountProfileResponse = {
  user_id: 'user-uuid-1',
  email: 'dana@example.com',
  display_name: 'Dana Reviewer',
};

/** Macrotask boundary — drains afterNextRender's async load + the async
 *  `validateStandardSchema` resource (mirrors the login/request-form harness). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

interface ApiMock {
  getProfile: ReturnType<typeof vi.fn>;
  updateProfile: ReturnType<typeof vi.fn>;
  deleteAccount: ReturnType<typeof vi.fn>;
}

interface AuthMock {
  signOut: ReturnType<typeof vi.fn>;
}

function makeApiMock(): ApiMock {
  return {
    getProfile: vi.fn(async () => ({ ...PROFILE })),
    updateProfile: vi.fn(async (input: { display_name: string | null }) => ({
      ...PROFILE,
      display_name: input.display_name,
    })),
    deleteAccount: vi.fn(async () => ({ message: 'gone' })),
  };
}

let assignSpy: ReturnType<typeof vi.fn>;

async function setup(
  api: ApiMock = makeApiMock(),
  auth: AuthMock = { signOut: vi.fn(async () => undefined) },
) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AccountApi, useValue: api },
      { provide: AuthService, useValue: auth },
    ],
  });
  const fixture = TestBed.createComponent(AccountPage);
  fixture.detectChanges();
  // Drain afterNextRender (the identity fetch) before asserting the loaded view.
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, auth, el: fixture.nativeElement as HTMLElement };
}

function typeName(fixture: ComponentFixture<unknown>, value: string) {
  const input = (fixture.nativeElement as HTMLElement).querySelector(
    '#account-display-name',
  ) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
}

async function submitNameForm(fixture: ComponentFixture<unknown>) {
  const formEl = (fixture.nativeElement as HTMLElement).querySelector('form') as HTMLFormElement;
  formEl.dispatchEvent(new Event('submit'));
  await settle();
  fixture.detectChanges();
}

describe('AccountPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    // The page runs in the BROWSER platform (it must — identity loads in
    // `afterNextRender`), so the embedded ThemeService reaches for
    // `window.matchMedia`, which this environment doesn't implement. Stub it.
    if (typeof window.matchMedia !== 'function') {
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    }
    assignSpy = vi.fn();
    try {
      vi.spyOn(globalThis.location, 'assign').mockImplementation(assignSpy as () => void);
    } catch {
      Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: { assign: assignSpy, href: 'http://localhost/' },
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('fetches and renders the read-only email and the editable display name', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('dana@example.com');
    const input = el.querySelector('#account-display-name') as HTMLInputElement;
    expect(input.value).toBe('Dana Reviewer');
    // A real <label for> names the input (never placeholder-as-label).
    expect(el.querySelector('label[for="account-display-name"]')).not.toBeNull();
  });

  it('shows the retryable "session expired" state when the fetch fails', async () => {
    const api = makeApiMock();
    api.getProfile.mockRejectedValueOnce(new Error('401'));
    const { el } = await setup(api);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('session may have expired');
    expect(el.querySelector('a[href="/auth/login"]')).not.toBeNull();
  });

  it('saves a new display name via PATCH and confirms success', async () => {
    const { fixture, el, api } = await setup();
    typeName(fixture, '  New Name  ');
    await settle();
    fixture.detectChanges();
    await submitNameForm(fixture);

    expect(api.updateProfile).toHaveBeenCalledTimes(1);
    // The value is trimmed before it reaches the API.
    expect(api.updateProfile).toHaveBeenCalledWith({ display_name: 'New Name' });
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Display name updated');
  });

  it('surfaces a retryable notice when the save fails and keeps the button enabled', async () => {
    const api = makeApiMock();
    api.updateProfile.mockRejectedValueOnce(new Error('boom'));
    const { fixture, el } = await setup(api);
    typeName(fixture, 'Another Name');
    await settle();
    fixture.detectChanges();
    await submitNameForm(fixture);

    expect(el.textContent).toContain('Something went wrong');
    const button = el.querySelector('form button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it('signs out and redirects home', async () => {
    const { el, auth } = await setup();
    const signOutBtn = [...el.querySelectorAll('button[type="button"]')].find((b) =>
      b.textContent?.trim().startsWith('Sign out'),
    ) as HTMLButtonElement;
    signOutBtn.click();
    await settle();

    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith('/');
  });

  it('deletes the account, then signs out and redirects home', async () => {
    const { fixture, api, auth } = await setup();
    await (
      fixture.componentInstance as unknown as { onConfirmDelete(): Promise<void> }
    ).onConfirmDelete();

    expect(api.deleteAccount).toHaveBeenCalledTimes(1);
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith('/');
  });

  it('surfaces a retryable error and does NOT redirect when the delete fails', async () => {
    const api = makeApiMock();
    api.deleteAccount.mockRejectedValueOnce(new Error('boom'));
    const { fixture } = await setup(api);
    const instance = fixture.componentInstance as unknown as {
      onConfirmDelete(): Promise<void>;
      deleteFailed(): boolean;
      deleting(): boolean;
    };
    await instance.onConfirmDelete();
    fixture.detectChanges();

    // The retryable notice renders inside the (now-closed) dialog overlay; assert
    // the state that drives it. No redirect — the account still exists.
    expect(assignSpy).not.toHaveBeenCalled();
    expect(instance.deleteFailed()).toBe(true);
    expect(instance.deleting()).toBe(false);
  });

  it('keeps the delete dialog wrapper free of a prohibited aria-labelledby and a sane heading order', async () => {
    const { el } = await setup();
    // The role-less <brn-dialog> wrapper must NOT carry aria-labelledby (axe
    // `aria-prohibited-attr`); the accessible name comes from `brnDialogTitle`
    // on the role="dialog" overlay, asserted by the e2e axe pass when open.
    const dialog = el.querySelector('brn-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute('aria-labelledby')).toBe(false);
    // h1 first, then section h2s (axe heading-order).
    const headings = Array.from(el.querySelectorAll('h1, h2')).map((h) => h.tagName);
    expect(headings[0]).toBe('H1');
    expect(headings.slice(1).every((t) => t === 'H2')).toBe(true);
  });
});
