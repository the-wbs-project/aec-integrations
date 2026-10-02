import { z } from 'zod';

import { ARRIVAL_VALUE_MAX_LENGTH, NOTIFICATION_SEND_ID_PATTERN } from './user-activity';

/**
 * `POST /api/activity/arrival` body (AECI-1208, `docs/API_CONTRACTS.md`).
 *
 * At least one of the three params must be present. Unknown keys are refused, so
 * nothing but the allowlisted values can reach `user_activity_daily`. Each text
 * value is trimmed and at most 100 chars. `n` is a `notification_sends.id`.
 *
 * Kept apart from `./user-activity.ts` so the browser shell can import the params
 * without pulling Zod into the initial bundle.
 */
const arrivalText = z.string().trim().min(1).max(ARRIVAL_VALUE_MAX_LENGTH);

export const ActivityArrivalRequestSchema = z
  .object({
    utm_source: arrivalText.optional(),
    utm_campaign: arrivalText.optional(),
    n: z.string().regex(NOTIFICATION_SEND_ID_PATTERN).optional(),
  })
  .strict()
  .refine((b) => b.utm_source !== undefined || b.utm_campaign !== undefined || b.n !== undefined, {
    message: 'At least one of utm_source, utm_campaign or n is required',
  });
export type ActivityArrivalRequest = z.infer<typeof ActivityArrivalRequestSchema>;
