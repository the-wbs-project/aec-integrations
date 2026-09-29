/**
 * AECI-1152 — "Integration links" (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.5).
 *
 * What these pin: three groups labelled by product (AECI-1141); the claimed owner
 * edits the record links, anyone else requests a change; the caller's own group is
 * editable with PUT and DELETE, the other company's is read-only; an owns-both row
 * shows two editable groups; a connector-powered row shows "View on {connector}"
 * and no per-side links; website and connection link are never shown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INTEGRATION_OWNED_CLAIMED,
  INTEGRATION_PROCORE_DETAIL,
  VENDOR_INTEGRATIONS_FIXTURE,
} from '../vendor-fixtures';

import {
  apiError,
  el,
  makeApi,
  mount,
  settle,
  setup,
  text,
} from './integration-detail-testing.harness';
import { IntegrationLinksSection } from './integration-links';

afterEach(() => vi.restoreAllMocks());

const testid = (id: string) => `[data-testid="${id}"]`;

describe('groups', () => {
  it('shows the record links, the caller’s product and the other product, by product name', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL]);
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationLinksSection, INTEGRATION_PROCORE_DETAIL);
    const headings = [...el(fixture).querySelectorAll('h4')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['On the integration', 'Summit Model Coordination', 'Procore']);
    expect(text(fixture)).toContain('Provided by Procore Technologies');
    expect(text(fixture)).not.toContain('Website');
    expect(text(fixture)).not.toContain('Connection link');
  });

  it('shows the other company’s links read-only', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL]);
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationLinksSection, INTEGRATION_PROCORE_DETAIL);
    const other = el(fixture).querySelector(testid('links-side-procore'))!;
    expect(other.textContent).toContain(
      'https://marketplace.procore.com/apps/summit-model-coordination',
    );
    expect(other.querySelector('button[aria-label^="Edit"]')).toBeNull();
  });

  it('shows both products as editable on an integration between two of the caller’s products', async () => {
    const both = VENDOR_INTEGRATIONS_FIXTURE.integrations[1]!;
    const api = makeApi([both]);
    await setup(api, both);
    const fixture = await mount(IntegrationLinksSection, both);
    expect(el(fixture).querySelectorAll('[data-testid^="edit-side-"]')).toHaveLength(4);
    expect(text(fixture)).not.toContain('Provided by');
  });
});

describe('the record links', () => {
  it('lets anyone else request a change', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL]);
    const { state } = await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationLinksSection, INTEGRATION_PROCORE_DETAIL);
    el(fixture).querySelector<HTMLButtonElement>(testid('request-docs_url'))!.click();
    expect(state.requestForm()?.field).toBe('docs_url');
    expect(el(fixture).querySelector(testid('edit-listing_url'))).toBeNull();
  });

  it('lets the claimed owner edit them with one PATCH', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    api.updateIntegration.mockResolvedValue({ integration: {} });
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationLinksSection, INTEGRATION_OWNED_CLAIMED);
    el(fixture).querySelector<HTMLButtonElement>(testid('edit-docs_url'))!.click();
    await settle(fixture);
    const input = el(fixture).querySelector<HTMLInputElement>(
      `${testid('links-row-docs_url')} input`,
    )!;
    input.value = 'https://summitbim.example.com/docs/trimble';
    input.dispatchEvent(new Event('input'));
    el(fixture)
      .querySelector<HTMLFormElement>(`${testid('links-row-docs_url')} form`)!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.updateIntegration).toHaveBeenCalledWith(INTEGRATION_OWNED_CLAIMED.id, {
      docs_url: 'https://summitbim.example.com/docs/trimble',
      context_product_id: INTEGRATION_OWNED_CLAIMED.context_product.id,
    });
  });
});

describe('the caller’s own links', () => {
  it('saves with PUT, and an empty value removes with DELETE', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    const productId = INTEGRATION_OWNED_CLAIMED.context_product.id;
    api.putIntegrationLink.mockResolvedValue({
      integration_id: INTEGRATION_OWNED_CLAIMED.id,
      product_id: productId,
      links: { listing_url: null, docs_url: 'https://summitbim.example.com/setup' },
    });
    api.deleteIntegrationLink.mockResolvedValue({
      integration_id: INTEGRATION_OWNED_CLAIMED.id,
      product_id: productId,
      links: { listing_url: null, docs_url: null },
    });
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationLinksSection, INTEGRATION_OWNED_CLAIMED);
    const slug = INTEGRATION_OWNED_CLAIMED.context_product.slug;

    el(fixture)
      .querySelector<HTMLButtonElement>(testid(`edit-side-${slug}-docs`))!
      .click();
    await settle(fixture);
    let input = el(fixture).querySelector<HTMLInputElement>(
      `${testid(`links-side-${slug}`)} input`,
    )!;
    input.value = 'https://summitbim.example.com/setup';
    input.dispatchEvent(new Event('input'));
    input.closest('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.putIntegrationLink).toHaveBeenCalledWith(
      INTEGRATION_OWNED_CLAIMED.id,
      productId,
      'docs',
      'https://summitbim.example.com/setup',
    );

    el(fixture)
      .querySelector<HTMLButtonElement>(testid(`edit-side-${slug}-listing`))!
      .click();
    await settle(fixture);
    input = el(fixture).querySelector<HTMLInputElement>(`${testid(`links-side-${slug}`)} input`)!;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.closest('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.deleteIntegrationLink).toHaveBeenCalledWith(
      INTEGRATION_OWNED_CLAIMED.id,
      productId,
      'listing',
    );
  });

  it('refuses a link that is not https before sending', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationLinksSection, INTEGRATION_OWNED_CLAIMED);
    const slug = INTEGRATION_OWNED_CLAIMED.context_product.slug;
    el(fixture)
      .querySelector<HTMLButtonElement>(testid(`edit-side-${slug}-docs`))!
      .click();
    await settle(fixture);
    const input = el(fixture).querySelector<HTMLInputElement>(
      `${testid(`links-side-${slug}`)} input`,
    )!;
    input.value = 'http://insecure.example.com';
    input.dispatchEvent(new Event('input'));
    input.closest('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.putIntegrationLink).not.toHaveBeenCalled();
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain('https://');
  });

  it('says why a save was refused', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    api.putIntegrationLink.mockRejectedValue(apiError(409, 'INTEGRATION_RETIRED'));
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationLinksSection, INTEGRATION_OWNED_CLAIMED);
    const slug = INTEGRATION_OWNED_CLAIMED.context_product.slug;
    el(fixture)
      .querySelector<HTMLButtonElement>(testid(`edit-side-${slug}-docs`))!
      .click();
    await settle(fixture);
    const input = el(fixture).querySelector<HTMLInputElement>(
      `${testid(`links-side-${slug}`)} input`,
    )!;
    input.value = 'https://summitbim.example.com/setup';
    input.dispatchEvent(new Event('input'));
    input.closest('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain('retired');
  });
});

describe('a connector-powered row', () => {
  it('shows View on the connector, no per-side groups, and no edit for a non-owner', async () => {
    const connector = {
      ...VENDOR_INTEGRATIONS_FIXTURE.integrations[4]!,
      contestable_fields: {
        ...VENDOR_INTEGRATIONS_FIXTURE.integrations[4]!.contestable_fields,
        listing_url: 'https://agave.example.com/acumatica',
      },
    };
    const api = makeApi([connector]);
    await setup(api, connector);
    const fixture = await mount(IntegrationLinksSection, connector);
    expect(el(fixture).querySelector(testid('link-value-listing_url'))?.textContent).toContain(
      'View on Agave ERP Sync',
    );
    expect(el(fixture).querySelector(testid('links-connector-note'))?.textContent).toContain(
      'Products cannot add their own links to an integration that runs through Agave ERP Sync.',
    );
    expect(el(fixture).querySelectorAll('[data-testid^="links-side-"]')).toHaveLength(0);
    expect(el(fixture).querySelectorAll('button[aria-label^="Edit"]')).toHaveLength(0);
  });

  it('keeps a stranded link’s Remove in the caller’s own group', async () => {
    const connector = {
      ...VENDOR_INTEGRATIONS_FIXTURE.integrations[4]!,
      own_links: { listing_url: 'https://summitbim.example.com/old', docs_url: null },
    };
    const api = makeApi([connector]);
    api.deleteIntegrationLink.mockResolvedValue({
      integration_id: connector.id,
      product_id: connector.context_product.id,
      links: { listing_url: null, docs_url: null },
    });
    await setup(api, connector);
    const fixture = await mount(IntegrationLinksSection, connector);
    const remove = el(fixture).querySelector<HTMLButtonElement>(
      `${testid('links-stranded')} button`,
    )!;
    remove.click();
    await settle(fixture);
    expect(api.deleteIntegrationLink).toHaveBeenCalledWith(
      connector.id,
      connector.context_product.id,
      'listing',
    );
  });
});
