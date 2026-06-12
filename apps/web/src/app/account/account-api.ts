/**
 * Client for the account endpoints (AECI-202 / Phase 5.11). The signed-in
 * user's own account surface: read identity, update the display name, and the
 * GDPR delete.
 *
 * Like `RequestsApi`, these are browser-side mutations/reads over the SSR
 * Worker's `/api/*` proxy (service binding). The same-origin requests carry the
 * HttpOnly Supabase session cookie automatically, so the API Worker's
 * `requireAuth()` authenticates them — no token is threaded by hand. Only ever
 * called from user actions / `afterNextRender`, never during SSR render.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AccountProfileResponse,
  DeleteAccountResponse,
  UpdateAccountInput,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AccountApi {
  private readonly http = inject(HttpClient);

  /** Read the caller's identity (`email` read-only from the session, display name). */
  getProfile(): Promise<AccountProfileResponse> {
    return firstValueFrom(this.http.get<AccountProfileResponse>('/api/account'));
  }

  /** Update the editable display name. */
  updateProfile(input: UpdateAccountInput): Promise<AccountProfileResponse> {
    return firstValueFrom(this.http.patch<AccountProfileResponse>('/api/account', input));
  }

  /** Right-to-erasure: anonymizes the caller's reviews, deletes their profile +
   *  auth user. The caller signs out + redirects on success. */
  deleteAccount(): Promise<DeleteAccountResponse> {
    return firstValueFrom(this.http.delete<DeleteAccountResponse>('/api/account'));
  }
}
