import { z } from 'zod';

/**
 * Inbound webhook contracts. Linear (AECI-212 / Phase 6.5) and, since AECI-1222, the
 * Resend delivery webhook at the end of this file. Linear is the Linear → Site half of the bidirectional moderation sync (`STAGE_1_SPEC.md`
 * §26.4, `STAGE_1_PHASE_6_SPEC.md` §6.3). The companion outbound direction
 * (Site → Linear, 6.6) calls the Linear GraphQL API and needs no schema here.
 *
 * `LinearWebhookSchema` mirrors `docs/API_CONTRACTS.md` §6.11, which itself
 * reflects Linear's documented data-change webhook envelope. The handler
 * verifies the `Linear-Signature` HMAC over the raw body BEFORE parsing with
 * this schema (`apps/api/src/lib/linear-webhook-auth.ts`).
 *
 * **Tolerant by design:** a real Linear Issue payload carries far more fields
 * than the slice below (assignee, labels, priority, `updatedFrom`, `webhookId`,
 * …). A plain `z.object` strips unknown keys rather than rejecting them, so the
 * schema validates real payloads while only depending on the fields the sync
 * reads. Do NOT tighten this to `.strict()`. The §6.11 note to "validate against
 * a real captured payload (webhook.site)" is a webhook-setup checklist item —
 * confirm the field names below survive a live payload when the webhook is wired
 * in Linear.
 *
 * Framework-agnostic package (no `$localize`): any messages are plain English
 * for API consumers / logs.
 */

/**
 * Linear issue workflow-state category. This `type` is a fixed Linear enum,
 * independent of a workspace's custom state display names — the inbound sync
 * keys its status mapping on it, not on `state.name`. `triage` is included for
 * completeness (Linear adds it for triage-enabled teams).
 */
export const LINEAR_STATE_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;

/** Data-change webhook envelope from Linear. See file header + §6.11. */
export const LinearWebhookSchema = z.object({
  action: z.enum(['create', 'update', 'remove']),
  type: z.string(), // 'Issue', 'Comment', etc.
  data: z.object({
    id: z.string(),
    title: z.string().optional(),
    state: z
      .object({
        id: z.string(),
        name: z.string(),
        type: z.string(), // one of LINEAR_STATE_TYPES; kept loose per the contract
      })
      .optional(),
    assignee: z
      .object({
        id: z.string(),
        name: z.string(),
      })
      .nullable()
      .optional(),
    project: z
      .object({
        id: z.string(),
        name: z.string(),
      })
      .nullable()
      .optional(),
  }),
  url: z.string(), // permalink to the issue
  createdAt: z.string(),
  organizationId: z.string(),
  webhookTimestamp: z.number(),
});
export type LinearWebhook = z.infer<typeof LinearWebhookSchema>;

// ─── Resend delivery webhook (AECI-1222) ─────────────────────────────────────

/**
 * The Resend event types the delivery webhook records. Opens and clicks are deliberately
 * absent: Apple Mail and corporate link scanners fire them on their own, and they are
 * tracking data (ruling 2026-10-02). Any other type is acknowledged and ignored.
 */
export const RESEND_DELIVERY_EVENT_TYPES = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
] as const;
export type ResendDeliveryEventType = (typeof RESEND_DELIVERY_EVENT_TYPES)[number];

/**
 * Resend's webhook envelope, the slice the recorder reads. Field names from Resend's
 * per-event pages (`https://resend.com/docs/webhooks/emails/*`, read 2026-10-02):
 * `{ type, created_at, data: { email_id, from, to[], subject, tags, bounce? } }`.
 *
 * Tolerant like `LinearWebhookSchema`: unknown keys are stripped, not rejected. `tags` is an
 * object of `name → value` in the documented payload. An array of `{ name, value }` (the send
 * API's shape) is accepted too, so a format change cannot silently untag every event.
 * `data` is optional at the top level because a non-email event type may carry another shape.
 * The route checks the type before it reads `data`.
 */
export const ResendWebhookSchema = z.object({
  type: z.string(),
  created_at: z.string(),
  data: z
    .object({
      email_id: z.string().min(1),
      from: z.string().optional(),
      to: z.array(z.string()).optional(),
      subject: z.string().optional(),
      tags: z
        .union([
          z.record(z.string(), z.string()),
          z.array(z.object({ name: z.string(), value: z.string() })),
        ])
        .optional(),
      bounce: z
        .object({
          type: z.string().optional(),
          subType: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type ResendWebhook = z.infer<typeof ResendWebhookSchema>;
