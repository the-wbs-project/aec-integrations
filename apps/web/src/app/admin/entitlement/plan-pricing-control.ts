import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { formatDate } from '@angular/common';

import type { VendorPlanPricingResponse } from '@aeci/shared';
import {
  MANAGED_LIST_PRICE_CENTS,
  MANAGED_PRICE_CENTS_MAX,
  PLAN_PRICE_MESSAGE_MAX,
} from '@aeci/shared/entitlements';

import { formatPlanPrice, planPriceSentence } from '../../vendor/vendor-plan';
import { AdminPlanPricingApi } from './admin-plan-pricing-api';

/** A dollar amount with at most two decimals: `25`, `12.5`, `12.50`. */
const DOLLARS = /^\d+(\.\d{1,2})?$/;

/** The price field's text, parsed. `null` = blank (the default). */
type ParsedPrice = { ok: true; cents: number | null } | { ok: false };

/**
 * The admin "Plan price" control on `/admin/vendors/:id` (ruling 2026-10-08,
 * `STAGE_2_PAID_TIERS_SPEC.md` §13.13, `ADMIN_PANEL_SPEC.md` §5.7).
 *
 * Two optional overrides for what the vendor portal's plan panel says Managed
 * costs: a price in dollars, and a free-text message that replaces the whole
 * sentence. The preview line runs the same `planPriceSentence` the vendor panel
 * runs, so what the admin reads is exactly what the vendor will see.
 *
 * ── DISPLAY ONLY ────────────────────────────────────────────────────────────
 * Nothing bills from this. It does not change the plan, a capability, ranking or
 * placement, and the copy says so. It is not part of the entitlement: a Free
 * vendor can carry one, and clearing the entitlement leaves it alone.
 *
 * Same shape as `EntitlementControl`: no heading (the host owns the outline and
 * passes `labelledBy`) and no live region (announcements go to the host's one
 * region through {@link announce}).
 */
@Component({
  selector: 'aec-plan-pricing-control',
  templateUrl: './plan-pricing-control.html',
})
export class PlanPricingControl {
  private readonly api = inject(AdminPlanPricingApi);
  private readonly locale = inject(LOCALE_ID);

  readonly vendorId = input.required<string>();
  readonly vendorName = input.required<string>();
  /** The stored overrides. All-null fields = the default. */
  readonly pricing = input.required<VendorPlanPricingResponse>();
  /** Prefix for the `id`/`for` pairs, so two controls on a page never collide. */
  readonly idPrefix = input.required<string>();
  /** Id of the host's heading, wired through `aria-labelledby`. */
  readonly labelledBy = input<string | null>(null);

  /** The committed overrides, for the host to drop in with no refetch. */
  readonly changed = output<VendorPlanPricingResponse>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  /** The price field, in dollars. Resets whenever the stored value changes. */
  protected readonly priceText = linkedSignal(() =>
    centsToField(this.pricing().managed_price_cents),
  );
  /** The message field. Resets whenever the stored value changes. */
  protected readonly messageText = linkedSignal(() => this.pricing().message ?? '');
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');

  protected readonly messageMax = PLAN_PRICE_MESSAGE_MAX;
  protected readonly defaultHint = $localize`:@@admin.vendors.planPrice.defaultHint:Default: ${formatPlanPrice(MANAGED_LIST_PRICE_CENTS, this.locale)}:AMOUNT: a month per product. Leave blank to use it.`;

  private readonly parsedPrice = computed<ParsedPrice>(() => parsePrice(this.priceText()));

  /** The message as the server will store it: whitespace folded, ends trimmed. */
  private readonly normalizedMessage = computed(() =>
    this.messageText().replace(/\s+/g, ' ').trim(),
  );

  protected readonly messageLength = computed(() => this.normalizedMessage().length);

  protected readonly priceError = computed(() =>
    this.parsedPrice().ok
      ? ''
      : $localize`:@@admin.vendors.planPrice.priceError:Enter a price in dollars, like 12.50, up to ${formatPlanPrice(MANAGED_PRICE_CENTS_MAX, this.locale)}:MAX:.`,
  );

  protected readonly messageError = computed(() =>
    this.messageLength() > PLAN_PRICE_MESSAGE_MAX
      ? $localize`:@@admin.vendors.planPrice.messageTooLong:The message is too long. Keep it to ${PLAN_PRICE_MESSAGE_MAX}:MAX: characters.`
      : '',
  );

  protected readonly invalid = computed(() => !!this.priceError() || !!this.messageError());

  /** Whether the stored state is already the default, so Reset has nothing to do. */
  protected readonly isDefault = computed(() => {
    const p = this.pricing();
    return p.managed_price_cents === null && p.message === null;
  });

  /** Exactly what the vendor will see once saved, by the §13.13 precedence. */
  protected readonly preview = computed(() => {
    const parsed = this.parsedPrice();
    return planPriceSentence(
      {
        managed_price_cents: parsed.ok ? parsed.cents : null,
        message: this.normalizedMessage() || null,
      },
      this.locale,
    );
  });

  /** The stored state, as one line. */
  protected readonly statusLabel = computed(() => {
    const p = this.pricing();
    if (p.message !== null) {
      return $localize`:@@admin.vendors.planPrice.status.message:Custom message set`;
    }
    if (p.managed_price_cents !== null) {
      const amount = formatPlanPrice(p.managed_price_cents, this.locale);
      return $localize`:@@admin.vendors.planPrice.status.price:Custom price set: ${amount}:AMOUNT: a month per product`;
    }
    return $localize`:@@admin.vendors.planPrice.status.default:Default price`;
  });

  protected readonly updatedLabel = computed(() => {
    const at = this.pricing().updated_at;
    if (!at) return null;
    const date = formatDate(at, 'MMMM d, y', this.locale, 'UTC');
    return $localize`:@@admin.vendors.planPrice.updated:Last changed ${date}:DATE:`;
  });

  protected onPriceInput(event: Event): void {
    this.priceText.set((event.target as HTMLInputElement).value);
  }

  protected onMessageInput(event: Event): void {
    this.messageText.set((event.target as HTMLTextAreaElement).value);
  }

  protected async save(): Promise<void> {
    const parsed = this.parsedPrice();
    if (this.pending() || !parsed.ok || this.invalid()) return;
    await this.send(parsed.cents, this.normalizedMessage() || null);
  }

  protected async reset(): Promise<void> {
    if (this.pending()) return;
    await this.send(null, null);
  }

  private async send(cents: number | null, message: string | null): Promise<void> {
    this.failedMessage.set('');
    this.pending.set(true);
    try {
      const saved = await this.api.setPlanPricing(this.vendorId(), {
        managed_price_cents: cents,
        message,
      });
      this.changed.emit(saved);
      const name = this.vendorName();
      this.announce.emit(
        saved.managed_price_cents === null && saved.message === null
          ? $localize`:@@admin.vendors.planPrice.announce.reset:Plan price reset to the default for ${name}:NAME:.`
          : $localize`:@@admin.vendors.planPrice.announce.saved:Plan price saved for ${name}:NAME:.`,
      );
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }
}

function centsToField(cents: number | null): string {
  if (cents === null) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** Blank is the default. Otherwise whole dollars with up to two decimals, in range.
 *  Parsed by string, not `parseFloat * 100`, so `0.29` is 29 cents, not 28.999. */
function parsePrice(raw: string): ParsedPrice {
  const text = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (text === '') return { ok: true, cents: null };
  if (!DOLLARS.test(text)) return { ok: false };
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > MANAGED_PRICE_CENTS_MAX) return { ok: false };
  return { ok: true, cents };
}

function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse && err.status === 400) {
    return $localize`:@@admin.vendors.planPrice.error.invalid:Check the price and the message. The message must be plain text.`;
  }
  return $localize`:@@admin.vendors.planPrice.error.failed:Something went wrong. Please try again.`;
}
