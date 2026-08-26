import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SeatInvitePreview } from '@aeci/shared';

import { VendorInvitePage } from './vendor-invite-page';

/**
 * `/vendor/invite/:token` (AECI-664 / §11a).
 *
 * The behaviours worth pinning here are the ones a reviewer cannot see by
 * reading the template: that opening the page does NOT redeem the invite (a mail
 * scanner must not spend it), and that each refusal reason produces copy the
 * recipient can act on — especially `email_mismatch`, which is the likeliest
 * failure and the one where "invalid invite" would leave someone stuck.
 */
const TOKEN = 'tok-abc';

const preview = (over: Partial<SeatInvitePreview> = {}): SeatInvitePreview => ({
  vendor_name: 'Summit BIM',
  email: 'jordan@summitbim.example.com',
  expires_at: '2099-01-01T00:00:00.000Z',
  redeemable: true,
  reason: 'ok',
  ...over,
});

describe('VendorInvitePage', () => {
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navigate = vi.fn().mockResolvedValue(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Router, useValue: { navigateByUrl: navigate } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ token: TOKEN }) } },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => vi.restoreAllMocks());

  async function render(body: SeatInvitePreview): Promise<ComponentFixture<VendorInvitePage>> {
    const fixture = TestBed.createComponent(VendorInvitePage);
    fixture.detectChanges();
    const req = http.expectOne(`/api/seat-invites/${TOKEN}`);
    // The page opens with a READ. If this ever becomes a POST, a link-preview
    // bot or a corporate URL rewriter spends the invite before the human clicks.
    expect(req.request.method).toBe('GET');
    req.flush(body);
    await Promise.resolve();
    fixture.detectChanges();
    return fixture;
  }

  it('previews a live invite and offers a real button, redeeming nothing yet', async () => {
    const fixture = await render(preview());
    expect(fixture.nativeElement.textContent).toContain('Summit BIM');
    expect(fixture.nativeElement.querySelector('button')).not.toBeNull();
    http.verify(); // no accept POST was made just by opening the page
  });

  it('accepts on click and sends the redeemer to the vendor’s own URL', async () => {
    const fixture = await render(preview());
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

    const req = http.expectOne(`/api/seat-invites/${TOKEN}/accept`);
    expect(req.request.method).toBe('POST');
    req.flush({ vendor_slug: 'summit-bim', vendor_name: 'Summit BIM' });
    await Promise.resolve();

    expect(navigate).toHaveBeenCalledWith('/vendor/summit-bim/overview');
  });

  it('tells a mismatched signer WHICH address to use, and offers no button', async () => {
    const fixture = await render(preview({ redeemable: false, reason: 'email_mismatch' }));
    const text = fixture.nativeElement.textContent as string;
    // Naming the address is the difference between an actionable message and a
    // dead end: the recipient is probably signed in as a personal account.
    expect(text).toContain('jordan@summitbim.example.com');
    expect(text).toContain('Sign out');
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('distinguishes expired, revoked and already-used', async () => {
    for (const [reason, copy] of [
      ['expired', 'expired'],
      ['revoked', 'withdrawn'],
      ['accepted', 'already been used'],
    ] as const) {
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideHttpClient(),
          provideHttpClientTesting(),
          { provide: Router, useValue: { navigateByUrl: navigate } },
          {
            provide: ActivatedRoute,
            useValue: { snapshot: { paramMap: convertToParamMap({ token: TOKEN }) } },
          },
        ],
      });
      http = TestBed.inject(HttpTestingController);
      const fixture = await render(preview({ redeemable: false, reason }));
      expect(fixture.nativeElement.textContent).toContain(copy);
    }
  });

  it('shows a recoverable error state when the preview read fails', async () => {
    const fixture = TestBed.createComponent(VendorInvitePage);
    fixture.detectChanges();
    http.expectOne(`/api/seat-invites/${TOKEN}`).error(new ProgressEvent('boom'));
    await Promise.resolve();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain("couldn't load this invite");
  });
});
