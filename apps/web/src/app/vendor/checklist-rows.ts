import type {
  ProductChecklistStep,
  VendorChecklistResponse,
  VendorChecklistStep,
  VendorProductChecklistResponse,
} from '@aeci/shared';

import type { ChecklistRow } from './components/vendor-checklist';

/**
 * Checklist step keys → portal copy and actions (AECI-1218,
 * `STAGE_2_PAID_TIERS_SPEC.md` §13.10). The API sends stable keys, never copy, so
 * every label lives here as `$localize`.
 *
 * Paths are relative to the page that renders the card: Vendor Overview
 * (`…/overview`) for the vendor rows, a product's overview
 * (`…/products/:slug/overview`) for the product rows.
 */

/** The vendor checklist's rows, for Vendor Overview. */
export function vendorChecklistRows(checklist: VendorChecklistResponse): readonly ChecklistRow[] {
  const finished = checklist.products.filter((p) => p.complete).length;
  const total = checklist.products.length;
  return checklist.steps.map((step) => vendorRow(step, finished, total));
}

function vendorRow(step: VendorChecklistStep, finished: number, total: number): ChecklistRow {
  const base = { key: step.key, status: step.status, counts: step.counts, locked: false };
  switch (step.key) {
    case 'company_details':
      return {
        ...base,
        title: $localize`:@@vendor.checklist.company.title:Check your company details`,
        body: $localize`:@@vendor.checklist.company.body:Press Looks right on your profile, or edit anything that is out of date.`,
        action: {
          kind: 'link',
          label: $localize`:@@vendor.checklist.company.action:Review company`,
          commands: ['../profile'],
        },
      };
    case 'finish_products':
      return {
        ...base,
        title: $localize`:@@vendor.checklist.products.title:Finish each product checklist`,
        body:
          total === 0
            ? $localize`:@@vendor.checklist.products.body.none:No products are listed yet, so there is nothing to finish.`
            : $localize`:@@vendor.checklist.products.body:${finished}:DONE: of ${total}:TOTAL: product checklists done.`,
        action:
          total === 0
            ? null
            : {
                kind: 'link',
                label: $localize`:@@vendor.checklist.products.action:Go to products`,
                commands: ['../products'],
              },
      };
    case 'invite_colleague':
      return {
        ...base,
        title: $localize`:@@vendor.checklist.invite.title:Invite a colleague`,
        body: $localize`:@@vendor.checklist.invite.body:Someone else can keep the listing current when you are away.`,
        action:
          step.status === 'done'
            ? null
            : {
                kind: 'link',
                label: $localize`:@@vendor.checklist.invite.action:Invite`,
                commands: ['../seats'],
              },
      };
  }
}

/** One product's checklist rows, for the product overview. */
export function productChecklistRows(
  checklist: VendorProductChecklistResponse,
  product: { readonly id: string; readonly name: string },
): readonly ChecklistRow[] {
  return checklist.steps.map((step) => productRow(step, product));
}

function productRow(
  step: ProductChecklistStep,
  product: { readonly id: string; readonly name: string },
): ChecklistRow {
  const base = { key: step.key, status: step.status, counts: step.counts, locked: false };
  switch (step.key) {
    case 'product_details':
      return {
        ...base,
        title: $localize`:@@vendor.checklist.details.title:Check product details`,
        body: $localize`:@@vendor.checklist.details.body:Press Looks right if the details are current, or edit them on Profile.`,
        action: {
          kind: 'looksRight',
          target: 'product',
          productId: product.id,
          productName: product.name,
          link: {
            label: $localize`:@@vendor.checklist.details.link:Open Profile`,
            commands: ['../profile'],
          },
        },
      };
    case 'integration_list':
      return {
        ...base,
        title: $localize`:@@vendor.checklist.list.title:Check the integration list`,
        body: $localize`:@@vendor.checklist.list.body:Is every integration listed, and nothing extra? Add a missing one on Integrations.`,
        action: {
          kind: 'looksRight',
          target: 'integrations',
          productId: product.id,
          productName: product.name,
          link: {
            label: $localize`:@@vendor.checklist.list.link:Open Integrations`,
            commands: ['../integrations'],
          },
        },
      };
    case 'claim_integrations':
      return {
        ...base,
        title: $localize`:@@vendor.checklist.claim.title:Claim your integrations, or say which are not yours`,
        body:
          step.status === 'done'
            ? $localize`:@@vendor.checklist.claim.body.done:Every integration recorded as yours is claimed or questioned.`
            : $localize`:@@vendor.checklist.claim.body:Open each integration your company is recorded as building. Claim it, or tell us it is not yours.`,
        action:
          step.status === 'done'
            ? null
            : {
                kind: 'link',
                label: $localize`:@@vendor.checklist.claim.action:Go to integrations`,
                commands: ['../integrations'],
              },
      };
    case 'confirm_data_flows': {
      // Outside this product's plan and not done: a lock, and a note in place of
      // an action (decision 6: optional on Free, so a Free product reads 3 of 3).
      const locked = !step.counts && step.status !== 'done';
      return {
        ...base,
        locked,
        title: $localize`:@@vendor.checklist.flows.title:Confirm data flows`,
        body: locked
          ? $localize`:@@vendor.checklist.flows.body.free:Optional on Free. Confirming data flows is part of Managed.`
          : $localize`:@@vendor.checklist.flows.body:Answer yes or no for each data flow on this product's integrations.`,
        action: locked
          ? {
              kind: 'note',
              label: $localize`:@@vendor.checklist.flows.locked:Available on Managed`,
            }
          : step.status === 'done'
            ? null
            : {
                kind: 'link',
                label: $localize`:@@vendor.checklist.flows.action:Confirm data flows`,
                commands: ['../integrations'],
              },
      };
    }
  }
}
