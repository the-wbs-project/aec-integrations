/**
 * AgreementBadge render tests (AECI-300). Named `.component.spec.ts` so it runs
 * under `ng test` (TestBed).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AgreementState } from '@aeci/shared';

import { AgreementBadge } from './agreement-badge';

function render(agreement: AgreementState): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AgreementBadge);
  fixture.componentRef.setInput('agreement', agreement);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('AgreementBadge', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the neutral "Unverified · AECi" pill for the Stage 1.5 state', () => {
    const el = render('unverified');
    expect(el.textContent).toContain('Unverified · AECi');
    const aria = el.querySelector('span[aria-label]')?.getAttribute('aria-label');
    expect(aria).toContain('not yet vendor-confirmed');
  });

  it('exposes the Stage 2 labels for confirmed / conflict (seam, unreachable in 1.5)', () => {
    expect(render('confirmed').textContent).toContain('Vendor-confirmed');
    expect(render('conflict').textContent).toContain('Needs review');
  });
});
