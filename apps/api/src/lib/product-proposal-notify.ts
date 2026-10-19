/**
 * The owner email for a new product proposal (AECI-1417, E6b.5; ADR 0042,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.22).
 *
 * Promote stores a new product for an owned vendor as a proposal (AECI-1416). Once that
 * batch commits, the Workflow's post-commit hooks (`dispatchPromoteHooks`) call
 * {@link emailOwnersOfProposal} once per proposal it stored. It sends
 * `product-proposal-owner-review` to every unbanned owner seat of the addressed vendor,
 * one send per owner per proposal (`product-proposal-owner-review:{proposalId}:{profileId}`),
 * so a replayed hook sends nothing twice. Modelled on `claim-owner-routing.ts`.
 *
 * No daily bound, unlike the claim email: the trigger is a curator's promote, not an
 * anonymous route, and Q5 stores one proposal per review-app ref, ever.
 *
 * **Never rejects.** It runs inside `waitUntil` after the proposal committed. A read
 * failure warns and sends nothing, and the email layer resolves every send failure to an
 * outcome.
 */

import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { productProposals, vendors } from '../db/schema';
import { logToPosthog } from '../posthog';
import { sendProductProposalOwnerReviewEmail, type EmailContext, type EmailOutcome } from './email';
import { loadVendorOwnerRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

/** The per-owner send-ledger key. */
export const proposalOwnerReviewKey = (proposalId: string, profileId: string) =>
  `product-proposal-owner-review:${proposalId}:${profileId}`;

export interface ProposalOwnerReviewResult {
  status: 'sent' | 'no_owners' | 'not_open' | 'error';
  emails: Partial<Record<EmailOutcome, number>>;
}

export interface ProposalOwnerReviewDeps {
  fetchSeatEmails?: FetchSeatEmails;
  sendEmail?: typeof sendProductProposalOwnerReviewEmail;
}

/** The proposed product's name, read off the stored payload without trusting its shape. */
function proposedName(payload: unknown): string {
  const product = (payload as { product?: { name?: unknown } } | null)?.product;
  return typeof product?.name === 'string' ? product.name : '';
}

/** Email every unbanned owner seat of the vendor a proposal is addressed to. Never rejects. */
export async function emailOwnersOfProposal(
  c: EmailContext,
  db: Db,
  proposalId: string,
  deps: ProposalOwnerReviewDeps = {},
): Promise<ProposalOwnerReviewResult> {
  const send = deps.sendEmail ?? sendProductProposalOwnerReviewEmail;
  const emails: Partial<Record<EmailOutcome, number>> = {};
  try {
    const proposal = await db.query.productProposals.findFirst({
      columns: { vendorId: true, payload: true, decision: true },
      where: eq(productProposals.id, proposalId),
    });
    // Decided (or discarded by a return) before the hook ran: nothing to ask.
    if (!proposal || proposal.decision !== null) return { status: 'not_open', emails };

    const owners = await loadVendorOwnerRecipients(
      db,
      c.env,
      proposal.vendorId,
      deps.fetchSeatEmails,
    );
    if (owners.length === 0) {
      log(c, 'info', 'aeci.proposal.owner_review.no_owner_address', proposalId, proposal.vendorId);
      return { status: 'no_owners', emails };
    }
    const vendor = await db.query.vendors.findFirst({
      columns: { companyName: true, slug: true },
      where: eq(vendors.id, proposal.vendorId),
    });

    // One connection at a time: sequential sends (a handful of owners).
    for (const owner of owners) {
      const outcome = await send(c, {
        to: owner.email,
        dedupeKey: proposalOwnerReviewKey(proposalId, owner.profileId),
        proposalId,
        vendorName: vendor?.companyName ?? '',
        vendorSlug: vendor?.slug ?? null,
        productName: proposedName(proposal.payload),
      });
      emails[outcome] = (emails[outcome] ?? 0) + 1;
    }
    return { status: 'sent', emails };
  } catch (error) {
    log(
      c,
      'warn',
      `aeci.proposal.owner_review.failed: ${error instanceof Error ? error.message : String(error)}`,
      proposalId,
      null,
    );
    return { status: 'error', emails };
  }
}

function log(
  c: EmailContext,
  level: 'info' | 'warn',
  message: string,
  proposalId: string,
  vendorId: string | null,
): void {
  try {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level,
      message,
      source: 'product-proposal-notify',
      proposal_id: proposalId,
      ...(vendorId ? { vendor_id: vendorId } : {}),
    });
  } catch {
    console.warn(`product-proposal-notify: ${message}`);
  }
}
