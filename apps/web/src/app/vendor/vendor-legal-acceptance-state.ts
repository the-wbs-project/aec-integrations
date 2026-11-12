import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import type {
  AcceptLegalVersionResponse,
  VendorLegalAcceptanceResponse,
  VendorLegalPending,
} from '@aeci/shared';

import { VendorApi } from './vendor-api';
import { VendorLegalRequiredEvents } from './vendor-legal-required';

/** The `sessionStorage` key holding the optional prompts dismissed in this session. */
export const LEGAL_DISMISSED_KEY = 'aeci.vendor.legal-accept.dismissed';

/** One dismissal: `<document>@<version>`. */
export function legalPromptKey(item: Pick<VendorLegalPending, 'document' | 'version'>): string {
  return `${item.document}@${item.version}`;
}

/** What the confirmation after an accept names. */
export interface LegalAcceptConfirmation {
  readonly document: VendorLegalPending['document'];
  readonly version: string;
  readonly acceptedAt: string;
  /** The accept lifted a block, so the portal just opened. */
  readonly unblocked: boolean;
}

/**
 * The portal's acceptance screen state (AECI-1677, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.24):
 * what `GET /api/vendor/legal-acceptance` said, which optional prompts this session
 * dismissed, and the confirmation after an accept.
 *
 * Provided by the surface owner beside `VendorPortalStore` (`VendorPage`, the preview),
 * never at root: `/vendor` is never edge-cached, and none of this may reach a cached page.
 * The shell injects it optionally, so a spec that mounts the shell alone sees no gate.
 *
 * ── FAIL OPEN IN THE SHELL, CLOSED ON THE SERVER ─────────────────────────────────
 * A `null` state (the read failed, or was never seeded) shows no screen and blocks nothing
 * in the shell. The API still refuses a blocked company's writes (`lib/authz.ts`), so a
 * failed read never lets a write through, and never locks a vendor out of reading.
 *
 * ── DISMISSAL: ONCE PER BROWSER SESSION ──────────────────────────────────────────
 * "Not now" on an optional prompt hides that version until the browser session ends
 * (`sessionStorage`). The prompt comes back on the next visit in a new session, and on a
 * different browser. A required item cannot be dismissed. The stored set is read after
 * the first render (`loadDismissed`), so SSR and hydration render the same thing.
 *
 * ── OPTIONAL PROMPTS WAIT FOR THE CLIENT ─────────────────────────────────────────
 * An optional prompt renders only once `loadDismissed` has run in the browser. SSR never
 * renders one, so a prompt dismissed earlier in the session never flashes on a reload. The
 * required screen does not wait: SSR renders it, so a blocked company never sees the tabs.
 *
 * ── A BLOCK THAT STARTS MID-SESSION ──────────────────────────────────────────────
 * A write refused with `403 LEGAL_ACCEPTANCE_REQUIRED` (`vendor-legal-required.ts`)
 * re-reads the state, so the required screen appears in place of the tabs.
 */
// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- surface-scoped, alongside VendorPortalStore
@Injectable()
export class VendorLegalAcceptanceState {
  private readonly api = inject(VendorApi);

  readonly state = signal<VendorLegalAcceptanceResponse | null>(null);
  readonly confirmation = signal<LegalAcceptConfirmation | null>(null);
  private readonly dismissed = signal<ReadonlySet<string>>(new Set());
  /** `loadDismissed` has run in the browser: optional prompts may render. */
  private readonly dismissedLoaded = signal(false);
  private readonly events = inject(VendorLegalRequiredEvents);

  constructor() {
    // A vendor write was refused because the company must accept first: re-read.
    effect(() => {
      if (this.events.count() === 0) return;
      untracked(() => void this.refresh());
    });
  }

  /** The portal opens only the acceptance screen. */
  readonly blocked = computed(() => this.state()?.blocked === true);

  /** The item on screen: the required one, else the first optional one not dismissed. */
  readonly current = computed<VendorLegalPending | null>(() => {
    const state = this.state();
    if (!state) return null;
    const required = state.pending.find((p) => p.mode === 'required');
    if (required) return required;
    if (!state.can_accept || !this.dismissedLoaded()) return null;
    const dismissed = this.dismissed();
    return state.pending.find((p) => !dismissed.has(legalPromptKey(p))) ?? null;
  });

  seed(state: VendorLegalAcceptanceResponse | null): void {
    this.state.set(state);
  }

  /** Re-read the state. False when the read failed; the state is then left as it was. */
  async refresh(): Promise<boolean> {
    try {
      this.state.set(await this.api.getLegalAcceptance());
      return true;
    } catch {
      return false;
    }
  }

  /** An accept committed: take the state it returned and show the confirmation. */
  accepted(res: AcceptLegalVersionResponse): void {
    const unblocked = this.blocked() && !res.state.blocked;
    this.state.set(res.state);
    this.confirmation.set({
      document: res.document,
      version: res.version,
      acceptedAt: res.accepted_at,
      unblocked,
    });
  }

  clearConfirmation(): void {
    this.confirmation.set(null);
  }

  /** "Not now" on an optional prompt, for the rest of this browser session. */
  dismiss(item: VendorLegalPending): void {
    if (item.mode === 'required') return;
    const next = new Set(this.dismissed());
    next.add(legalPromptKey(item));
    this.dismissed.set(next);
    try {
      globalThis.sessionStorage?.setItem(LEGAL_DISMISSED_KEY, JSON.stringify([...next]));
    } catch {
      // Storage off (private mode, a full quota): the dismissal lasts for this page only.
    }
  }

  /** Read this session's dismissals. Browser only, after the first render. Until it runs,
   *  no optional prompt renders. */
  loadDismissed(): void {
    this.dismissedLoaded.set(true);
    try {
      const raw = globalThis.sessionStorage?.getItem(LEGAL_DISMISSED_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        this.dismissed.set(new Set(parsed.filter((k): k is string => typeof k === 'string')));
      }
    } catch {
      // A corrupt or unreadable entry reads as nothing dismissed.
    }
  }
}
