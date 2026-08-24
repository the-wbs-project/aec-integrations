import { formatDate } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type { VendorEntitlementBlock } from '@aeci/shared';
import { EXPIRY_WARNING_DAYS } from '@aeci/shared/entitlements';

import { VerifiedBadge } from '../../shared/verified-badge/verified-badge';

/**
 * The vendor-facing entitlement surface (AECI-614 /
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §8) — the Overview panel that replaces the
 * launch-minimum `vendor-verified-status.ts` chip.
 *
 * It reads the `entitlement` block on `GET /api/vendor/me` (§4): `tier`,
 * `status`, `period_end`, and the resolved `capabilities`. **No new endpoint and
 * no new query** — the block is built from the session the guard already loaded,
 * so this panel and the 403 a write would get cannot disagree.
 *
 * ── IT MOVES WITHOUT A RELOAD (AECI-631 / `STAGE_2_REALTIME_SPEC.md` §6.1) ──
 * The concierge flip is the one event on this surface with a real deadline: an
 * operator toggles verification while on the phone with the vendor, and until
 * AECI-516 the vendor had to hard-reload `/vendor` to see it. They no longer do.
 * `entitlement` is bound from `VendorPortalStore.me` through the dashboard shell,
 * so when the §4 poll sees the `entitlement` cursor move and refetches
 * `GET /api/vendor/me`, a new block arrives in this input and every `computed`
 * below re-derives: the chip becomes the badge, the term line changes, the CTA
 * disappears.
 *
 * That is only true because nothing here copies the input into local state. Every
 * value below is a `computed` over `entitlement()`; the single exception is
 * {@link now}, which is a CLOCK rather than entitlement data and is read at day
 * granularity. Do not "optimise" any of these into a constructor assignment or a
 * `signal` seeded from the input: the panel would then be a snapshot of the
 * entitlement as it stood when the tab first rendered, and the deadline this
 * whole epic exists for would be quietly missed.
 *
 * ── The states ──────────────────────────────────────────────────────────────
 * `status` is `null` when there is no `vendor_entitlements` row AT ALL, which
 * deliberately distinguishes *never arranged* from *lapsed* — two different
 * conversations, so they get two different panels:
 *
 *  - **`active`** (term far off, or no end date) — quiet. The badge the public
 *    sees, the term, and the framing sentence. Nothing shouty.
 *  - **`expiring`** (`active`, `period_end` within {@link EXPIRY_SOON_DAYS}) —
 *    warm Bone wash, "ends in N days", a renewal path. Still verified: nothing
 *    has been taken away yet, and the copy says so.
 *  - **`pending`** — arranged, not yet switched on.
 *  - **`lapsed`** (`expired` / `revoked`) — the state that had to be DESIGNED,
 *    not merely handled: it is shown to a customer AECi wants back. It is
 *    **not an error**, so it borrows nothing from the error vocabulary — no
 *    `--status-error`, no alert role, no warning glyph. It leads with what the
 *    vendor KEEPS (dashboard, listing, reviews, seats, everything readable),
 *    names the one thing that is paused, and offers a renewal path.
 *  - **`none`** (`status: null`) — never arranged. An invitation, not a loss.
 *
 * The `active` arm resolves fail-closed, the same way `tierFor` does: a row that
 * says `active` but carries a tier this build does not know grants nothing, so
 * it must not render as verified. Anything unrecognized falls to `lapsed`.
 *
 * ── Copy discipline (§8, and this is a trust surface) ───────────────────────
 * Verification is an **account status** — never an endorsement, never a ranking
 * or placement signal. The framing sentence is the `aec-verified-badge` tooltip
 * and the `claim-approved` email's wording, said once, in every state. There is
 * **no promise of instant search** (vendor edits reach Algolia on the nightly
 * watermark, ≤24h) and no search claim at all beyond the disclaimer. Arrangement
 * details — amount, terms, PO number, payer — are **admin-side only** (§5.1):
 * this panel shows status and term, never the money. Renewal is a conversation
 * (`/contact`), not a checkout.
 *
 * Anchor-Site Rule: the anchor is the existing `/vendor` dashboard. Bordered
 * surfaces over fills, the same `--surface-raised` card + `--radius-md` as the
 * Overview stat tiles, the same button classes as the profile form. Light theme
 * only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-plan-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, VerifiedBadge],
  template: `
    <div [class]="shellClass()">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        @if (state() === 'active' || state() === 'expiring') {
          <aec-verified-badge [verified]="true" />
        } @else {
          <span
            class="inline-flex w-fit items-center rounded-(--radius-sm) border border-(--border-strong) bg-(--surface-base) px-2.5 py-0.5 text-xs font-semibold tracking-[0.01em] text-(--text-secondary)"
            >{{ chipLabel() }}</span
          >
        }
        @if (termLine(); as line) {
          <span class="text-sm text-(--text-secondary)">{{ line }}</span>
        }
      </div>

      @switch (state()) {
        @case ('active') {
          <p class="mt-3 max-w-prose text-sm leading-relaxed text-(--text-secondary)">
            <span i18n="@@vendor.plan.active.body"
              >Your profile, products and integration attestations are yours to edit.</span
            >
          </p>
        }
        @case ('expiring') {
          @let days = daysRemaining() ?? 0;
          <p class="mt-3 max-w-prose text-sm font-semibold text-(--accent-secondary-deep)">
            @if (days === 0) {
              <span i18n="@@vendor.plan.expiring.lede.today">Your verification ends today.</span>
            } @else {
              <ng-container i18n="@@vendor.plan.expiring.lede"
                >Your verification ends in
                {days, plural, =1 {1 day} other {{{ days }} days}}.</ng-container
              >
            }
          </p>
          <p class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)">
            <span i18n="@@vendor.plan.expiring.body"
              >Nothing changes before then. Get in touch to renew and your badge, your editing
              access and your attestations carry on without a break.</span
            >
          </p>
          <a routerLink="/contact" [class]="secondaryCtaClass" i18n="@@vendor.plan.cta.renew"
            >Renew verification</a
          >
        }
        @case ('pending') {
          <p class="mt-3 max-w-prose text-sm leading-relaxed text-(--text-secondary)">
            <span i18n="@@vendor.plan.pending.body"
              >Your verification is arranged and switches on shortly. Until it does, everything on
              record is here to read, and editing stays closed.</span
            >
          </p>
        }
        @case ('lapsed') {
          <p class="mt-3 max-w-prose text-sm leading-relaxed text-(--text-primary)">
            <span i18n="@@vendor.plan.lapsed.body"
              >Your verification is no longer active. You are still signed in, and you and your
              colleagues keep the dashboard.</span
            >
          </p>
          <!--
            What you keep, then what is paused. Two blocks, not one list: the
            single negative must not sit in an undifferentiated stack with the
            reassurances, where it reads as an afterthought rather than the one
            thing the vendor actually needs to know.
          -->
          <ul
            class="mt-3 max-w-prose list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-(--text-secondary)"
          >
            <li i18n="@@vendor.plan.lapsed.keep.listing">
              Your listing, your reviews and your integrations stay published exactly as they are.
            </li>
            <li i18n="@@vendor.plan.lapsed.keep.readable">
              Everything on record is still here to read: profile, products and integrations.
            </li>
          </ul>
          <p
            class="mt-4 max-w-prose border-s-2 border-(--border-strong) ps-3 text-sm leading-relaxed text-(--text-primary)"
          >
            <span i18n="@@vendor.plan.lapsed.paused"
              >What is paused: the verified badge, and editing your profile and products.</span
            >
          </p>
          <p class="mt-4 max-w-prose text-sm leading-relaxed text-(--text-secondary)">
            <span i18n="@@vendor.plan.lapsed.renew"
              >Renewing turns editing and the badge back on, with nothing to re-enter. Get in touch
              and we will pick it up from there.</span
            >
          </p>
          <a routerLink="/contact" [class]="primaryCtaClass" i18n="@@vendor.plan.cta.renew"
            >Renew verification</a
          >
        }
        @case ('none') {
          <p class="mt-3 max-w-prose text-sm leading-relaxed text-(--text-secondary)">
            <span i18n="@@vendor.plan.none.body"
              >Your account is not verified yet. Everything on record is here to read; editing your
              profile and products, and confirming what your integrations move, opens up once
              verification is active.</span
            >
          </p>
          <a routerLink="/contact" [class]="primaryCtaClass" i18n="@@vendor.plan.cta.ask"
            >Ask about verification</a
          >
        }
      }

      <p class="mt-4 max-w-prose text-xs leading-relaxed text-(--text-secondary)">
        <span i18n="@@vendor.plan.framing"
          >Verification confirms your account represents this vendor. It is an account status, not
          an endorsement of your product, and it does not affect search ranking or placement.</span
        >
      </p>
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorPlanPanel {
  private readonly locale = inject(LOCALE_ID);

  /** The `entitlement` block from `GET /api/vendor/me`. */
  readonly entitlement = input.required<VendorEntitlementBlock>();

  /**
   * Clock injection point, so the expiring state is testable without freezing
   * global time. Defaults to construction time, and is read at DAY granularity —
   * which is also what keeps the SSR render and the hydration render agreeing on
   * `/vendor` (a non-cacheable, cookie-forwarded surface rendered twice, ~ms
   * apart; only a render that straddles a midnight-relative day boundary could
   * differ, and the value is presentational).
   */
  readonly now = input<number>(Date.now());

  /**
   * Fail-closed, exactly as `tierFor` does (§3.1): `active` alone is not enough,
   * because `vendor_entitlements.tier` is deliberately unconstrained at the DB
   * layer and an unknown tier resolves to `unclaimed` → zero capabilities. A
   * panel that said "verified" over read-only forms would be the wrong lie.
   */
  protected readonly isActive = computed(
    () => this.entitlement().status === 'active' && this.entitlement().tier !== 'unclaimed',
  );

  /** Whole days from `now` to `period_end`; `null` when there is no term. */
  protected readonly daysRemaining = computed<number | null>(() => {
    const end = this.periodEnd();
    if (end === null) return null;
    return Math.max(0, Math.ceil((end.getTime() - this.now()) / DAY_MS));
  });

  protected readonly state = computed<PlanState>(() => {
    const days = this.daysRemaining();
    if (this.isActive()) return days !== null && days <= EXPIRY_SOON_DAYS ? 'expiring' : 'active';
    const status = this.entitlement().status;
    if (status === null) return 'none';
    if (status === 'pending') return 'pending';
    // `expired`, `revoked`, and the active-status/unknown-tier drift above all
    // land here: a state we cannot name confidently is still a downgraded one.
    return 'lapsed';
  });

  private readonly periodEnd = computed<Date | null>(() => {
    const raw = this.entitlement().period_end;
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  });

  /**
   * Formatted in UTC, not the ambient zone — the SSR Worker runs in UTC and the
   * browser does not, so a zone-local format renders two different dates either
   * side of midnight and trips a hydration mismatch (the `maintenance-marker`
   * precedent).
   */
  private readonly termDate = computed<string | null>(() => {
    const end = this.periodEnd();
    return end === null ? null : formatDate(end, 'MMMM d, y', this.locale, 'UTC');
  });

  /** The term read-out beside the chip. Status and term only — never the money. */
  protected readonly termLine = computed<string | null>(() => {
    const date = this.termDate();
    switch (this.state()) {
      case 'active':
      case 'expiring':
        return date === null
          ? $localize`:@@vendor.plan.term.noEnd:No end date on record`
          : $localize`:@@vendor.plan.term.through:Verified through ${date}:DATE:`;
      case 'lapsed':
        return date === null ? null : $localize`:@@vendor.plan.term.ended:Ended ${date}:DATE:`;
      case 'pending':
        return date === null ? null : $localize`:@@vendor.plan.term.until:Term to ${date}:DATE:`;
      default:
        return null;
    }
  });

  protected readonly chipLabel = computed<string>(() => {
    switch (this.state()) {
      case 'pending':
        return $localize`:@@vendor.plan.chip.pending:Verification pending`;
      case 'lapsed':
        return $localize`:@@vendor.plan.chip.ended:Verification ended`;
      default:
        return $localize`:@@vendor.plan.chip.none:Not verified`;
    }
  });

  /**
   * Bordered surfaces, never fills (`DESIGN.md` "Borders-Not-Shadows"). The
   * expiring state is the only one that changes the wash — warm Bone, the
   * `/contact` hero's token, deliberately NOT `--status-error`: a term running
   * out is a calendar fact, not a failure. `lapsed` sits on `--surface-sunken`
   * so it reads as quiet and settled rather than alarmed.
   */
  protected readonly shellClass = computed<string>(() => {
    const base = 'rounded-(--radius-md) border p-5';
    switch (this.state()) {
      case 'expiring':
        return `${base} border-(--border-strong) bg-(--accent-warm)`;
      case 'lapsed':
      case 'none':
      case 'pending':
        return `${base} border-(--border-default) bg-(--surface-sunken)`;
      default:
        return `${base} border-(--border-default) bg-(--surface-raised)`;
    }
  });

  protected readonly primaryCtaClass =
    'mt-4 inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) no-underline transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  protected readonly secondaryCtaClass =
    'mt-4 inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-5 py-2.5 text-sm font-bold text-(--text-primary) no-underline transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}

/** The five rendered panels. `none` and `lapsed` are both downgraded — and are
 *  deliberately different conversations (never arranged vs. lost it). */
type PlanState = 'active' | 'expiring' | 'pending' | 'lapsed' | 'none';

const DAY_MS = 86_400_000;

/**
 * How close to `period_end` the panel starts leaning in.
 *
 * The SAME constant the §7 expiry cron warns on (`@aeci/shared/entitlements`),
 * not a presentational copy: a vendor must never receive the renewal email while
 * this panel still shows everything as fine.
 */
const EXPIRY_SOON_DAYS = EXPIRY_WARNING_DAYS;
