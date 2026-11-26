import type { ChipTone } from '../../shared/chip/chip';
import type { AecIconName } from '../../shared/icon/icon-registry';

import type { VendorBillingLicenseTone } from './vendor-billing-licenses';

/**
 * The class strings the Billing tab's files share (AECI-1812, the portal's design
 * language, mock-up 13). Buttons are `aecButton`, icons `aec-icon`, statuses
 * `aec-chip`, panels `aecCard`. What is left is the table recipe the subscriptions
 * and agreements tables both read, the in-text link and the status-chip tones.
 *
 * Whole class names, so Tailwind's scanner sees each one. Light only.
 */

/**
 * A table's scrolling region: `role="region"`, `tabindex="0"` and `aria-labelledby`
 * on the caption go beside it. A wide table scrolls inside it, never the page. It is
 * positioned, so the visually hidden text in a cell (an absolute box) stays inside the
 * scroller: unpositioned, it escaped and pushed the whole page sideways at 390px.
 */
export const BILLING_TABLE_REGION_CLASS =
  'relative min-w-0 overflow-x-auto rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** A column heading: the Label role on a strong rule, as the Seats roster has it. */
export const BILLING_TABLE_HEAD_CLASS =
  'border-t border-b border-t-(--border-default) border-b-(--border-strong) py-2 pe-4 text-start align-bottom text-t-13 font-semibold tracking-[0.01em] text-(--text-secondary) last:pe-0';

/** A body cell, on a hairline. */
export const BILLING_TABLE_CELL_CLASS =
  'border-b border-(--border-default) py-3 pe-4 align-top last:pe-0';

/** The in-text link role (DESIGN.md, "The Link Treatment Rule"). */
export const BILLING_LINK_CLASS =
  'rounded-mark text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/**
 * A subscription's status on `aec-chip` (AECI-1866 set the three tones, AECI-1812 moved
 * them onto the shared chip). `live` keeps its Forest wash. `warning` was Clay deep text
 * on a strong edge: a public chip never takes Clay, so it is the strong edge with a clock,
 * which keeps it apart from `ended` by more than colour. `ended` is the quiet step.
 */
export const LICENSE_CHIP_TONE: Readonly<Record<VendorBillingLicenseTone, ChipTone>> = {
  live: 'wash',
  warning: 'strong',
  ended: 'quiet',
};

export const LICENSE_CHIP_ICON: Readonly<Record<VendorBillingLicenseTone, AecIconName | null>> = {
  live: null,
  warning: 'clock',
  ended: null,
};
