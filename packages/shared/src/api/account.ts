import { z } from 'zod';

/**
 * Account contracts (AECI-202 / Phase 5.11): the signed-in user's own account
 * surface — read identity, edit the display name, and the GDPR right-to-erasure
 * delete. These back `apps/web/src/app/account/` and the `GET`/`PATCH`/`DELETE
 * /api/account` handlers (`apps/api/src/routes/account.ts`).
 *
 * `STAGE_1_PHASE_5_SPEC.md` §6 / `API_CONTRACTS.md` §6.8. `email` is read-only —
 * it comes from the verified session JWT, never a body field — so it is absent
 * from `UpdateAccountSchema`. The `GET`/`PATCH` shapes are a Phase-5.11 addition
 * beyond §6.8 (which documents only `DELETE`); flagged for doc reconciliation.
 *
 * i18n note: this package is framework-agnostic (no `$localize`), so the Zod
 * messages here are plain English for API consumers / logs. The Angular form
 * renders its own `$localize` copy keyed off field validity (ADR 0009).
 */

// ─── Profile read / update ──────────────────────────────────────────────────

/**
 * Mutable profile fields for `PATCH /api/account`. Only `display_name` is
 * editable today; it is nullable so the user can clear it back to the "Verified
 * reviewer" fallback. The server trims and stores `''`-after-trim as a rejected
 * value (min length 1) — pass an explicit `null` to clear.
 */
export const UpdateAccountSchema = z.object({
  display_name: z
    .string()
    .trim()
    .min(1, 'Display name must be at least 1 character.')
    .max(80, 'Keep your display name under 80 characters.')
    .nullable(),
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountSchema>;

/** Returned by `GET /api/account` and `PATCH /api/account`. `email` is read-only
 *  (from the session JWT); `display_name` is null when unset. */
export interface AccountProfileResponse {
  user_id: string;
  email: string | null;
  display_name: string | null;
}

// ─── Delete (GDPR erasure) ──────────────────────────────────────────────────

/** Returned by `DELETE /api/account` (API_CONTRACTS §6.8). */
export interface DeleteAccountResponse {
  message: string;
}
