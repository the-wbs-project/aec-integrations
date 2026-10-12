import { z } from 'zod';

/**
 * Plan inquiry contract (AECI-1279): the "Talk to us about Managed" form on the
 * vendor guide's Plans page (`/docs/vendors/plans`) and on `/contact?topic=managed`.
 *
 * `POST /api/plan-inquiries` saves the inquiry to the D1 `plan_inquiries` table,
 * sends the visitor a receipt and sends the support inbox an alert whose reply-to is
 * the visitor. Lead capture, like `feedback`: no `audit_log` row (ADR 0022, the
 * 2026-10-12 amendment). See docs/API_CONTRACTS.md §6.13a.
 *
 * i18n note: this package is framework-agnostic, so the messages here are plain
 * English for API consumers and logs. The form renders its own copy.
 */

/** Which plan the visitor asked about. One value today; add more as plans arrive. */
export const PLAN_INQUIRY_TOPICS = ['managed'] as const;
export type PlanInquiryTopic = (typeof PLAN_INQUIRY_TOPICS)[number];

/** Field limits, shared by the schema, the D1 columns' callers and the form's `maxlength`. */
export const PLAN_INQUIRY_LIMITS = {
  email: 200,
  company: 200,
  details: 2000,
} as const;

/**
 * Wire body for `POST /api/plan-inquiries`.
 *
 *   - `email` is required: it is where we reply, and where the receipt goes.
 *   - `company` is required: it is what we quote against.
 *   - `details` is optional free text: which products, and anything else.
 *   - `website` is a honeypot. The form hides it from people and from assistive
 *     technology, so only a bot fills it. A filled honeypot gets the normal success
 *     response and nothing is saved or sent, so a bot learns nothing.
 *
 * The honeypot accepts any string here on purpose. Rejecting a filled one with a 400
 * would tell a bot which field gave it away.
 */
export const PlanInquirySubmitSchema = z.object({
  topic: z.enum(PLAN_INQUIRY_TOPICS),
  email: z.string().trim().email().max(PLAN_INQUIRY_LIMITS.email),
  company: z.string().trim().min(1).max(PLAN_INQUIRY_LIMITS.company),
  details: z.string().trim().max(PLAN_INQUIRY_LIMITS.details).nullish(),
  website: z.string().max(2000).nullish(),
  referrer: z.string().max(2000).nullish(),
});
export type PlanInquirySubmit = z.infer<typeof PlanInquirySubmitSchema>;

/**
 * Response for `POST /api/plan-inquiries`. Always `{ received: true }` with HTTP
 * 201, including for a filled honeypot, so the response never tells a bot it was
 * caught.
 */
export const PlanInquiryResultSchema = z.object({ received: z.literal(true) });
export type PlanInquiryResult = z.infer<typeof PlanInquiryResultSchema>;
