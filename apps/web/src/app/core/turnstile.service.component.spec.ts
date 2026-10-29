/**
 * Tests for `TurnstileService` (AECI-1457). Named `.component.spec.ts` so it
 * runs under `ng test`: it needs Angular DI (`PLATFORM_ID`, `DOCUMENT`).
 *
 * `window.turnstile` is stubbed. jsdom never fetches the external `api.js`, so
 * the script-load tests fire the element's `load` / `error` event by hand.
 */
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TURNSTILE_SCRIPT_SRC,
  TURNSTILE_TOKEN_TIMEOUT_MS,
  TurnstileService,
  type TurnstileApi,
  type TurnstileRenderOptions,
} from './turnstile.service';

const SITE_KEY = '1x00000000000000000000BB';

type Win = Window & { turnstile?: TurnstileApi; __AECI_TURNSTILE__?: unknown };
const win = window as Win;

function configure(platform: 'browser' | 'server' = 'browser'): TurnstileService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: platform }] });
  return TestBed.inject(TurnstileService);
}

/** A `window.turnstile` stub that records each render and lets the test drive
 *  the callbacks. */
function stubTurnstile() {
  const renders: { container: HTMLElement; options: TurnstileRenderOptions }[] = [];
  const api = {
    render: vi.fn((container: HTMLElement, options: TurnstileRenderOptions) => {
      renders.push({ container, options });
      return `w${renders.length}`;
    }),
    execute: vi.fn(),
    remove: vi.fn(),
  };
  return { api, renders };
}

function setNavigatorProp(name: 'doNotTrack' | 'globalPrivacyControl', value: unknown): void {
  Object.defineProperty(window.navigator, name, { value, configurable: true });
}

function turnstileScripts(): HTMLScriptElement[] {
  return Array.from(document.head.querySelectorAll<HTMLScriptElement>('script')).filter(
    (s) => s.src === TURNSTILE_SCRIPT_SRC,
  );
}

beforeEach(() => {
  win.__AECI_TURNSTILE__ = { siteKey: SITE_KEY };
});

afterEach(() => {
  delete win.__AECI_TURNSTILE__;
  delete win.turnstile;
  setNavigatorProp('doNotTrack', null);
  setNavigatorProp('globalPrivacyControl', undefined);
  turnstileScripts().forEach((s) => s.remove());
  vi.useRealTimers();
});

describe('TurnstileService — when it is active', () => {
  it('is active in the browser with a site key and no privacy signal', () => {
    expect(configure().active).toBe(true);
  });

  it('is inactive without a site key (the shipped, dark state), and loads nothing', async () => {
    delete win.__AECI_TURNSTILE__;
    const service = configure();

    expect(service.active).toBe(false);
    await expect(service.getToken()).resolves.toBeNull();
    expect(turnstileScripts()).toHaveLength(0);
  });

  it('is inactive on a malformed config', () => {
    win.__AECI_TURNSTILE__ = { siteKey: '' };
    expect(configure().active).toBe(false);
  });

  it('is inactive under Global Privacy Control', async () => {
    setNavigatorProp('globalPrivacyControl', true);
    const service = configure();

    expect(service.active).toBe(false);
    await expect(service.getToken()).resolves.toBeNull();
    expect(turnstileScripts()).toHaveLength(0);
  });

  it('is inactive under Do-Not-Track', async () => {
    setNavigatorProp('doNotTrack', '1');
    const service = configure();

    expect(service.active).toBe(false);
    await expect(service.getToken()).resolves.toBeNull();
    expect(turnstileScripts()).toHaveLength(0);
  });

  it('is inactive on the server', () => {
    expect(configure('server').active).toBe(false);
  });
});

describe('TurnstileService — getToken', () => {
  it('renders an invisible execute-mode widget, resolves the token and removes the widget', async () => {
    vi.useFakeTimers();
    const { api, renders } = stubTurnstile();
    win.turnstile = api;
    const service = configure();

    const pending = service.getToken('8f2a1b3c4d5e6f70-SIN');
    await vi.advanceTimersByTimeAsync(0);

    expect(api.render).toHaveBeenCalledTimes(1);
    const { container, options } = renders[0];
    expect(options).toMatchObject({
      sitekey: SITE_KEY,
      cData: '8f2a1b3c4d5e6f70-SIN',
      execution: 'execute',
      retry: 'never',
      'refresh-expired': 'never',
      'response-field': false,
      tabindex: -1,
    });
    expect(api.execute).toHaveBeenCalledWith('w1');
    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(container.hasAttribute('inert')).toBe(true);
    expect(container.isConnected).toBe(true);

    options.callback('tok-123');
    await expect(pending).resolves.toBe('tok-123');

    await vi.advanceTimersByTimeAsync(0);
    expect(api.remove).toHaveBeenCalledWith('w1');
    expect(container.isConnected).toBe(false);
  });

  it('sends no cData when none is given', async () => {
    const { api, renders } = stubTurnstile();
    win.turnstile = api;
    const service = configure();

    const pending = service.getToken();
    await vi.waitFor(() => expect(api.render).toHaveBeenCalled());
    expect(renders[0].options).not.toHaveProperty('cData');
    renders[0].options.callback('t');
    await pending;
  });

  it.each([
    ['error-callback', (o: TurnstileRenderOptions) => o['error-callback']('300030')],
    ['expired-callback', (o: TurnstileRenderOptions) => o['expired-callback']()],
    ['timeout-callback', (o: TurnstileRenderOptions) => o['timeout-callback']()],
    ['unsupported-callback', (o: TurnstileRenderOptions) => o['unsupported-callback']()],
  ])('resolves null on the %s', async (_name, fire) => {
    const { api, renders } = stubTurnstile();
    win.turnstile = api;
    const service = configure();

    const pending = service.getToken();
    await vi.waitFor(() => expect(api.render).toHaveBeenCalled());
    fire(renders[0].options);

    await expect(pending).resolves.toBeNull();
  });

  it('marks an error handled so Turnstile does not rethrow it', async () => {
    const { api, renders } = stubTurnstile();
    win.turnstile = api;
    const service = configure();

    const pending = service.getToken();
    await vi.waitFor(() => expect(api.render).toHaveBeenCalled());
    expect(renders[0].options['error-callback']('110100')).toBe(true);
    await pending;
  });

  it('resolves null when render throws (never rejects)', async () => {
    const { api } = stubTurnstile();
    api.render.mockImplementation(() => {
      throw new Error('invalid sitekey');
    });
    win.turnstile = api;

    await expect(configure().getToken()).resolves.toBeNull();
  });

  it('resolves null after the timeout when no callback ever fires', async () => {
    vi.useFakeTimers();
    const { api } = stubTurnstile();
    win.turnstile = api;
    const service = configure();

    let result: string | null | undefined;
    void service.getToken().then((t) => (result = t));
    await vi.advanceTimersByTimeAsync(TURNSTILE_TOKEN_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();
    await vi.runOnlyPendingTimersAsync();
    expect(api.remove).toHaveBeenCalledWith('w1');
  });

  it('ignores a token that arrives after the timeout', async () => {
    vi.useFakeTimers();
    const { api, renders } = stubTurnstile();
    win.turnstile = api;
    const service = configure();

    const pending = service.getToken();
    await vi.advanceTimersByTimeAsync(TURNSTILE_TOKEN_TIMEOUT_MS);
    renders[0].options.callback('late');

    await expect(pending).resolves.toBeNull();
  });
});

describe('TurnstileService — script loading', () => {
  it('adds api.js once across concurrent calls and renders after it loads', async () => {
    const { api, renders } = stubTurnstile();
    const service = configure();

    const first = service.getToken();
    const second = service.getToken();
    expect(turnstileScripts()).toHaveLength(1);
    expect(api.render).not.toHaveBeenCalled();

    win.turnstile = api;
    turnstileScripts()[0].dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(api.render).toHaveBeenCalledTimes(2));

    // Each concurrent call gets its own widget (tokens are single-use).
    renders[0].options.callback('a');
    renders[1].options.callback('b');
    await expect(first).resolves.toBe('a');
    await expect(second).resolves.toBe('b');

    // A later call reuses the loaded API: still one script element.
    const third = service.getToken();
    await vi.waitFor(() => expect(api.render).toHaveBeenCalledTimes(3));
    renders[2].options.callback('c');
    await expect(third).resolves.toBe('c');
    expect(turnstileScripts()).toHaveLength(1);
  });

  it('resolves null when the script fails to load, and does not retry it', async () => {
    const service = configure();

    const pending = service.getToken();
    turnstileScripts()[0].dispatchEvent(new Event('error'));
    await expect(pending).resolves.toBeNull();

    await expect(service.getToken()).resolves.toBeNull();
    expect(turnstileScripts()).toHaveLength(1);
  });

  it('resolves null when the script loads but exposes no API', async () => {
    const service = configure();

    const pending = service.getToken();
    turnstileScripts()[0].dispatchEvent(new Event('load'));

    await expect(pending).resolves.toBeNull();
  });
});
