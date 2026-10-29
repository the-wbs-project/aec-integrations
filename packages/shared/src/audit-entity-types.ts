/**
 * `audit_log.entity_type` values the API writes (AECI-653), as suggestions for
 * the `/admin/audit` entity-type filter.
 *
 * A suggestion list, never an enum. `audit_log.entity_type` has no CHECK, the
 * filter accepts any string, and `GET /api/admin/audit` never validates against
 * this list. A writer that adds a new value must add it here, and
 * `apps/api/src/lib/audit-entity-types.spec.ts` fails the build until it does:
 * it reads every `entityType: '…'` literal under `apps/api/src` and checks it
 * is listed.
 *
 * The list may hold values no current writer produces. `vendor_entitlement` is
 * no longer written, but historic rows carry it and the vendor tab still reads
 * them. Values written through a constant or an expression the spec cannot
 * resolve (`integration_field_challenge`, `review_response` and others) are
 * listed by hand.
 */
export const AUDIT_ENTITY_TYPES: readonly string[] = [
  'agreement_acceptance',
  'attestation',
  'billing_account',
  'claim',
  'claim_thread',
  'claim_thread_message',
  'connector_catalog',
  'connector_evidenced_pair',
  'gsc_recrawl_queue',
  'indexnow_queue',
  'integration',
  'integration_field_challenge',
  'listing_request',
  'notification_setting',
  'product',
  'product_proposal',
  'product_request',
  'product_version',
  'profile',
  'request_confirmation',
  'retention',
  'review',
  'review_response',
  'vendor',
  'vendor_entitlement',
  'vendor_request',
  'vendor_seat_invite',
];
