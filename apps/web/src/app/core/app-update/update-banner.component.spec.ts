/**
 * Tests for `UpdateBanner` (AECI-1493). Runs under `ng test` for DI and change
 * detection. `AppUpdateService` is stubbed with a writable signal.
 */
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppUpdateService } from './app-update.service';
import { UpdateBanner } from './update-banner';

describe('UpdateBanner', () => {
  const updateAvailable = signal(false);
  const reload = vi.fn();

  beforeEach(() => {
    updateAvailable.set(false);
    reload.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [UpdateBanner],
      providers: [{ provide: AppUpdateService, useValue: { updateAvailable, reload } }],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(UpdateBanner);
    await fixture.whenStable();
    return fixture;
  }

  it('renders only the empty live region until an update is found', async () => {
    const fixture = await render();
    const el = fixture.nativeElement as HTMLElement;
    const region = el.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent?.trim()).toBe('');
  });

  it('shows the notice and reloads on Refresh', async () => {
    const fixture = await render();
    updateAvailable.set(true);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('A new version of AEC Integrations is available');
    (el.querySelector('#app-update-refresh') as HTMLButtonElement).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('hides for good when dismissed', async () => {
    const fixture = await render();
    updateAvailable.set(true);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const dismiss = el.querySelector('#app-update-dismiss') as HTMLButtonElement;
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss');
    dismiss.click();
    await fixture.whenStable();
    expect(el.querySelector('#app-update-refresh')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});
