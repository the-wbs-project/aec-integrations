/**
 * AECI-1777 - reads a rendered `aec-breadcrumb` back as data, so a page spec can
 * pin its trail: the items in order, each link target, and which one is current.
 * Test-only. Nothing in the app imports it.
 */
export interface TrailItem {
  readonly label: string;
  /** The link's `href`, or `null` for a text item. */
  readonly href: string | null;
  /** True for the item carrying `aria-current="page"`. */
  readonly current: boolean;
}

/** The trail inside the first `nav[aria-label="Breadcrumb"]` under `root`. */
export function trail(root: Element): TrailItem[] {
  const nav = root.querySelector('nav[aria-label="Breadcrumb"]');
  if (!nav) throw new Error('no breadcrumb nav rendered');
  return Array.from(nav.querySelectorAll('li')).map((li) => {
    const link = li.querySelector('a');
    const text = link ?? li.querySelector('span:not([aria-hidden="true"])');
    return {
      label: text?.textContent?.trim() ?? '',
      href: link ? link.getAttribute('href') : null,
      current: li.querySelector('[aria-current="page"]') !== null,
    };
  });
}
