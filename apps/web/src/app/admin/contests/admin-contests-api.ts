/**
 * Client for the admin integration-field-contest endpoints (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b; `API_CONTRACTS.md` §6.10), consumed by the
 * `/admin/contests` queue.
 *
 * Mirrors `AdminClaimsApi`: browser-side calls over the SSR Worker's `/api/*`
 * passthrough. The same-origin request carries the HttpOnly Supabase session
 * cookie, so the API Worker's `requireAdmin()` authenticates and authorizes it.
 * Only ever called from user actions or `afterNextRender`, never during SSR render.
 *
 * There is no `getContest(id)`: the API has no single-contest read, and the list
 * row already carries every field the decision needs.
 */
import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import type {
  AdminContest,
  AdminDecideContestInput,
  DecideContestProtestInput,
  ListAdminContestsQuery,
  ListAdminContestsResponse,
  AdminPairContestsResponse,
  AdminDecidePairContestInput,
  AdminDecidePairProtestInput,
  AdminVetoesResponse,
  PairContestResponse,
  VetoWriteResponse,
} from '@aeci/shared';

@Injectable({ providedIn: 'root' })
export class AdminContestsApi {
  private readonly http = inject(HttpClient);

  /** `GET /api/admin/contests`. The server defaults `status` to `open` and
   *  `routed_to` to `aeci`; an omitted key is left to that default. */
  listContests(query: Partial<ListAdminContestsQuery> = {}): Promise<ListAdminContestsResponse> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params = params.set(key, String(value));
    }
    return firstValueFrom(
      this.http.get<ListAdminContestsResponse>('/api/admin/contests', { params }),
    );
  }

  /** `PATCH /api/admin/contests/:id`. Accept records the decision and files a
   *  `REVIEW - ` Linear issue after commit; it writes no catalog data. Returns the
   *  row's post-decision state. */
  decide(id: string, input: AdminDecideContestInput): Promise<AdminContest> {
    return firstValueFrom(
      this.http.patch<AdminContest>(`/api/admin/contests/${encodeURIComponent(id)}`, input),
    );
  }

  /** `PATCH /api/admin/contests/:id/protest` (AECI-1009). AECi says which side it
   *  agrees with. Advice only: it writes no catalog data and files no issue. The
   *  note is required. Returns the row's post-decision state. */
  decideProtest(id: string, input: DecideContestProtestInput): Promise<AdminContest> {
    return firstValueFrom(
      this.http.patch<AdminContest>(`/api/admin/contests/${encodeURIComponent(id)}/protest`, input),
    );
  }

  // ── AECI-2042: Sync Service pair reports and endpoint vetoes ──────────────

  /** `GET /api/admin/pair-contests` — open reports, or open protests. */
  listPairContests(query: { protests?: boolean } = {}): Promise<AdminPairContestsResponse> {
    const params = query.protests ? new HttpParams().set('protests', 'true') : new HttpParams();
    return firstValueFrom(
      this.http.get<AdminPairContestsResponse>('/api/admin/pair-contests', { params }),
    );
  }

  /** `PATCH /api/admin/pair-contests/:id`. An existence accept on a vendor-held pair
   *  retires it; it needs a note and a proof link. */
  decidePairContest(id: string, input: AdminDecidePairContestInput): Promise<PairContestResponse> {
    return firstValueFrom(
      this.http.patch<PairContestResponse>(
        `/api/admin/pair-contests/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }

  /** `PATCH /api/admin/pair-contests/:id/protest`. Advice only. */
  decidePairProtest(id: string, input: AdminDecidePairProtestInput): Promise<PairContestResponse> {
    return firstValueFrom(
      this.http.patch<PairContestResponse>(
        `/api/admin/pair-contests/${encodeURIComponent(id)}/protest`,
        input,
      ),
    );
  }

  /** `GET /api/admin/vetoes` — the vetoes in force. */
  listVetoes(): Promise<AdminVetoesResponse> {
    return firstValueFrom(this.http.get<AdminVetoesResponse>('/api/admin/vetoes'));
  }

  /** `POST /api/admin/vetoes/:id/lift` — end a veto, with a required note. */
  liftVeto(id: string, note: string): Promise<VetoWriteResponse> {
    return firstValueFrom(
      this.http.post<VetoWriteResponse>(`/api/admin/vetoes/${encodeURIComponent(id)}/lift`, {
        note,
      }),
    );
  }
}
