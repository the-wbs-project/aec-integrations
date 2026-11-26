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
  AdminPairContestResponse,
  AdminPairContestsResponse,
  AdminDecidePairContestInput,
  AdminDecidePairProtestInput,
  AdminVetoesResponse,
  VetoWriteResponse,
  AdminDecideVetoObjectionInput,
  RemovalEndReason,
  VetoObjectionResponse,
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

  /** `GET /api/admin/pair-contests` — open reports, open protests, or (AECI-2170) the
   *  accepted existence reports with a listing AECi holds still to retract. */
  listPairContests(
    query: { protests?: boolean; retractions?: boolean } = {},
  ): Promise<AdminPairContestsResponse> {
    let params = new HttpParams();
    if (query.protests) params = params.set('protests', 'true');
    if (query.retractions) params = params.set('retractions', 'true');
    return firstValueFrom(
      this.http.get<AdminPairContestsResponse>('/api/admin/pair-contests', { params }),
    );
  }

  /** `PATCH /api/admin/pair-contests/:id`. An existence accept retires every listing of
   *  the pair a vendor holds (AECI-2170); it needs a note and a proof link. Answers the
   *  admin shape, with the pair's listings and the retract-by date. */
  decidePairContest(
    id: string,
    input: AdminDecidePairContestInput,
  ): Promise<AdminPairContestResponse> {
    return firstValueFrom(
      this.http.patch<AdminPairContestResponse>(
        `/api/admin/pair-contests/${encodeURIComponent(id)}`,
        input,
      ),
    );
  }

  /** `PATCH /api/admin/pair-contests/:id/protest`. Advice only. */
  decidePairProtest(
    id: string,
    input: AdminDecidePairProtestInput,
  ): Promise<AdminPairContestResponse> {
    return firstValueFrom(
      this.http.patch<AdminPairContestResponse>(
        `/api/admin/pair-contests/${encodeURIComponent(id)}/protest`,
        input,
      ),
    );
  }

  /** `GET /api/admin/vetoes` — the vetoes in force. */
  listVetoes(): Promise<AdminVetoesResponse> {
    return firstValueFrom(this.http.get<AdminVetoesResponse>('/api/admin/vetoes'));
  }

  /** `POST /api/admin/vetoes/:id/lift` — end a veto, with a required end reason and
   *  note (AECI-2192, ruling 66). */
  liftVeto(id: string, endReason: RemovalEndReason, note: string): Promise<VetoWriteResponse> {
    return firstValueFrom(
      this.http.post<VetoWriteResponse>(`/api/admin/vetoes/${encodeURIComponent(id)}/lift`, {
        end_reason: endReason,
        note,
      }),
    );
  }

  /** `PATCH /api/admin/veto-objections/:id` — accept or decline an objection (AECI-2192). */
  decideVetoObjection(
    id: string,
    body: AdminDecideVetoObjectionInput,
  ): Promise<VetoObjectionResponse> {
    return firstValueFrom(
      this.http.patch<VetoObjectionResponse>(
        `/api/admin/veto-objections/${encodeURIComponent(id)}`,
        body,
      ),
    );
  }
}
