/**
 * Client for the one-click nudge mute (AECI-1204), `POST /api/notifications/nudges/mute`,
 * over the SSR Worker's `/api/*` passthrough. Called only from the confirm click on
 * the `/notifications/mute` page, never during render.
 */
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type { NudgeMuteResult } from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class NudgeMuteApi {
  private readonly http = inject(HttpClient);

  /** Mute the daily reminder email for the seat that owns `token`. `ok: false` means
   *  the token matched no seat. */
  mute(token: string): Promise<NudgeMuteResult> {
    return firstValueFrom(
      this.http.post<NudgeMuteResult>('/api/notifications/nudges/mute', { token }),
    );
  }
}
