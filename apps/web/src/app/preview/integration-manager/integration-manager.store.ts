import { Injectable, computed, signal } from '@angular/core';

import type { IntegrationContestField, VendorContest } from '@aeci/shared';

import {
  IM_INTEGRATIONS,
  NAVISWORKS_OWNER_REQUEST_ID,
  PREVIEW_NOW,
  flowSentence,
  type Answer,
  type FlowDirection,
  type ImFlow,
  type ImIntegration,
  type ImLinks,
  type WrongReason,
} from './integration-manager.fixtures';

/**
 * Local state for the integration-manager preview. Every write a real portal would
 * send to the API lands here instead, as a signal update, so each concept can be
 * clicked through without a session. Nothing here talks to the network.
 *
 * Form open state lives here too (which integration's request form or links
 * editor is open), so a concept can open a form from wherever its buttons sit: the
 * owner row, a "Things that need you" item, or D's single action bar.
 */
@Injectable({ providedIn: 'root' })
export class IntegrationManagerStore {
  private readonly base = signal<ImIntegration[]>(structuredClone([...IM_INTEGRATIONS]));

  /** Dev strip toggle: show Navisworks with or without its open owner request. */
  readonly ownerRequestSent = signal(true);

  readonly integrations = computed<readonly ImIntegration[]>(() => {
    const sent = this.ownerRequestSent();
    return this.base().map((i) =>
      i.id === 'navisworks' && !sent
        ? { ...i, contests: i.contests.filter((c) => c.id !== NAVISWORKS_OWNER_REQUEST_ID) }
        : i,
    );
  });

  /** Which integration's correction form is open, and on which field. */
  readonly requestFormFor = signal<{ id: string; field: IntegrationContestField | null } | null>(
    null,
  );
  /** Which integration's links editor is open. */
  readonly editingLinksFor = signal<string | null>(null);
  /** Which integration's add-data form is open (opened by the section's + button). */
  readonly addingFlowFor = signal<string | null>(null);
  /** Change requests search text and status filter. */
  readonly requestQuery = signal('');
  readonly requestFilter = signal<'all' | 'open' | 'closed'>('all');
  /** The one polite announcement, rendered by the preview root. */
  readonly announcement = signal('');

  private sequence = 0;

  byId(id: string | null): ImIntegration | null {
    if (!id) return null;
    return this.integrations().find((i) => i.id === id) ?? null;
  }

  /**
   * Record the viewer's answer. Like the real PUT, the whole position is replaced:
   * an answer saved without a note clears the old note.
   */
  setAnswer(
    integrationId: string,
    flowId: string,
    answer: Answer,
    extra: { note?: string | null; reason?: WrongReason | null } = {},
  ): void {
    this.update(integrationId, (i) => ({
      ...i,
      flows: i.flows.map((f) =>
        f.id === flowId
          ? {
              ...f,
              mine: answer,
              kept: false,
              myNote: extra.note ?? null,
              myReason: answer === 'no' ? (extra.reason ?? null) : null,
              disputedAt:
                f.disputedAt ??
                (answer !== null && f.theirs !== null && answer !== f.theirs
                  ? PREVIEW_NOW
                  : undefined),
            }
          : f,
      ),
    }));
    const i = this.byId(integrationId);
    const flow = i?.flows.find((f) => f.id === flowId);
    if (i && flow) {
      const subject = flowSentence(flow, i);
      this.announce(
        answer === null
          ? `Your answer was removed: ${subject}.`
          : `Saved. You said ${answer === 'yes' ? 'this is right' : 'this is wrong'}: ${subject}.`,
      );
    }
  }

  addFlow(
    integrationId: string,
    what: string,
    whatInSentence: string,
    direction: FlowDirection,
    note: string | null = null,
  ): void {
    const flow: ImFlow = {
      id: `${integrationId}-added-${++this.sequence}`,
      what,
      whatInSentence,
      direction,
      mine: 'yes',
      theirs: null,
      theirNote: null,
      addedBy: 'you',
      addedAt: PREVIEW_NOW,
      addedNote: note,
    };
    this.update(integrationId, (i) => ({ ...i, flows: [...i.flows, flow] }));
    const i = this.byId(integrationId);
    if (i) this.announce(`Added: ${flowSentence(flow, i)}.`);
  }

  /** The viewer keeps its answer on a disputed row; AEC Integrations reviews it. */
  keepAnswer(integrationId: string, flowId: string): void {
    this.update(integrationId, (i) => ({
      ...i,
      flows: i.flows.map((f) => (f.id === flowId ? { ...f, kept: true } : f)),
    }));
    this.announce('You kept your answer. AEC Integrations reviews the disagreement.');
  }

  claim(integrationId: string): void {
    this.update(integrationId, (i) => ({
      ...i,
      owner: { ...i.owner, state: 'you-claimed' },
    }));
    this.announce('You claimed this integration. You can now edit its details.');
  }

  setRetired(integrationId: string, retired: boolean): void {
    this.update(integrationId, (i) => ({ ...i, retired }));
    this.announce(
      retired
        ? 'Retired. It is hidden from the public page.'
        : 'Restored. It shows on the public page again.',
    );
  }

  /** One of an endpoint product's own links (PUT/DELETE …/links/:productId/:kind). */
  saveSideLink(
    integrationId: string,
    product: string,
    kind: keyof ImLinks,
    value: string | null,
  ): void {
    this.update(integrationId, (i) => ({
      ...i,
      sides: i.sides.map((side) =>
        side.product === product ? { ...side, links: { ...side.links, [kind]: value } } : side,
      ),
    }));
    this.announce('Link saved.');
  }

  /** A detail the claimed owner edits directly (PATCH /api/vendor/integrations/:id). */
  saveDetail(
    integrationId: string,
    key: 'name' | 'description' | 'maturity' | 'pricing' | 'pricingUrl' | 'mechanismName',
    value: string | null,
  ): void {
    this.update(integrationId, (i) =>
      key === 'mechanismName'
        ? { ...i, how: { ...i.how, name: value } }
        : { ...i, details: { ...i.details, [key]: value } },
    );
    this.announce('Saved. It is live on the public page.');
  }

  /** The owner's decision on a request another company sent (POST …/contests/:id/decision). */
  decideReceived(
    integrationId: string,
    contestId: string,
    decision: 'accept' | 'decline',
    note: string | null,
  ): void {
    this.update(integrationId, (i) => {
      const c = i.contests.find((x) => x.id === contestId);
      if (!c) return i;
      const contests = i.contests.map((x) =>
        x.id === contestId
          ? {
              ...x,
              status: decision === 'accept' ? ('accepted' as const) : ('declined' as const),
              decision_note: note,
              decided_at: PREVIEW_NOW,
              updated_at: PREVIEW_NOW,
            }
          : x,
      );
      if (decision !== 'accept') return { ...i, contests };
      const v = c.proposed_value;
      const details = { ...i.details };
      if (c.field === 'maturity') details.maturity = v;
      if (c.field === 'description') details.description = v;
      if (c.field === 'pricing_model') details.pricing = v;
      if (c.field === 'listing_url') details.listingUrl = v;
      if (c.field === 'docs_url') details.docsUrl = v;
      return { ...i, contests, details };
    });
    this.announce(
      decision === 'accept'
        ? 'Accepted. The public integration page now shows the new value.'
        : 'Declined. The company that sent it will see your decision.',
    );
  }

  /** One of the integration record's own links, edited by its claimed owner (PATCH). */
  saveRecordLink(
    integrationId: string,
    key: 'listingUrl' | 'docsUrl' | 'website' | 'mechanismUrl',
    value: string | null,
  ): void {
    this.update(integrationId, (i) => ({ ...i, details: { ...i.details, [key]: value } }));
    this.announce('Link saved. It is live on the public page.');
  }

  sendRequest(
    integrationId: string,
    field: IntegrationContestField,
    current: string,
    proposed: string,
    reason: string,
  ): void {
    const i = this.byId(integrationId);
    if (!i) return;
    const routedToOwner = field !== 'owner' && i.owner.state === 'other-claimed';
    const created: VendorContest = {
      id: `00000000-0000-4000-8000-${String(++this.sequence).padStart(12, '0')}`,
      integration_id: i.uuid,
      anchor: 'integration',
      integration_name: null,
      context_product: {
        id: 'aca',
        name: 'AutoCAD Architecture',
        slug: 'autocad-architecture',
        logo_url: null,
      },
      other_product: { id: i.id, name: i.other.name, slug: i.other.slug, logo_url: null },
      field,
      current_value: current,
      proposed_value: proposed,
      current_label: field === 'owner' ? current : null,
      proposed_label: field === 'owner' ? proposed : null,
      reason,
      routed_to: routedToOwner ? 'owner' : 'aeci',
      status: 'open',
      submitter_vendor: { id: 'autodesk', name: 'Autodesk' },
      owner_vendor: routedToOwner ? { id: 'owner', name: i.owner.name ?? '' } : null,
      decision_note: null,
      decided_at: null,
      created_at: PREVIEW_NOW,
      updated_at: PREVIEW_NOW,
      protest: null,
      protest_opens_at: null,
      protest_closes_at: null,
      protest_basis: null,
      cooldown_until: null,
    };
    this.update(integrationId, (row) => ({ ...row, contests: [created, ...row.contests] }));
    this.requestFormFor.set(null);
    this.announce(
      routedToOwner ? `Request sent to ${i.owner.name}.` : 'Request sent to AEC Integrations.',
    );
  }

  withdraw(integrationId: string, contestId: string): void {
    this.update(integrationId, (i) => ({
      ...i,
      contests: i.contests.map((c) =>
        c.id === contestId ? { ...c, status: 'withdrawn', updated_at: PREVIEW_NOW } : c,
      ),
    }));
    this.announce('Request withdrawn. Nothing changed on the listing.');
  }

  announce(message: string): void {
    // Clear first so the same sentence twice is still announced.
    this.announcement.set('');
    queueMicrotask(() => this.announcement.set(message));
  }

  private update(id: string, fn: (i: ImIntegration) => ImIntegration): void {
    this.base.update((rows) => rows.map((i) => (i.id === id ? fn(i) : i)));
  }
}
