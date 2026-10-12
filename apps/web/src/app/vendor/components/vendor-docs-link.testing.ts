import { expect } from 'vitest';

import { VENDOR_GUIDE_PAGES, type VendorGuidePage } from './vendor-docs-link';

/**
 * Assert that `root` holds exactly one "Learn more" link to `page`, and that it
 * is the house new-tab link (AECI-1253): the guide URL, `target="_blank"`,
 * `rel="noopener"`, the drawn cue, and an accessible name of "Learn more", the
 * page title and the new-tab note. The surface specs call this so each one pins
 * its own link, not only the shared component.
 */
export function expectVendorDocsLink(root: HTMLElement, page: VendorGuidePage): HTMLAnchorElement {
  const links = root.querySelectorAll<HTMLAnchorElement>(`a[data-docs-link="${page}"]`);
  expect(links).toHaveLength(1);
  const link = links[0];

  expect(link.getAttribute('href')).toBe(`/docs/vendors/${page}`);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener');
  expect(link.hasAttribute('aria-label')).toBe(false);
  expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  // No aria-label, so the accessible name is the anchor's text content.
  expect(link.textContent?.replace(/\s+/g, ' ').trim()).toBe(
    `Learn more: ${VENDOR_GUIDE_PAGES[page]()} (opens in a new tab)`,
  );
  return link;
}
