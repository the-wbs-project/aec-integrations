/**
 * `VendorPortalAnnouncer` (AECI-631 / `docs/STAGE_2_REALTIME_SPEC.md` §6.3) — the
 * vendor portal's ONE polite announcement channel.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * Before this, the live region lived inside `vendor-integrations-section.ts` and
 * the integration card carried a second `role="status"` of its own. Two live
 * regions on one page make announcements RACE: the screen reader gets two
 * competing queued utterances for one event and the vendor hears the wrong one,
 * or both. §6.3 resolves that by hoisting the region to the dashboard shell —
 * which immediately raises the question this service answers: how does a control
 * five levels down say something into a region it does not render?
 *
 * A prop chain would have to thread an output through every component between
 * the control and the shell, including several this issue does not own, and
 * every new announcing surface would have to re-thread it. So the CHANNEL is a
 * service and the REGION is one `<p class="sr-only" role="status">` in
 * `vendor-dashboard-tabbed.ts` bound to {@link message}. Announcing is
 * `announce(...)`; there is nowhere else to put an announcement, which is what
 * keeps "exactly one region" true as the portal grows.
 *
 * ── WHY `providedIn: 'root'` WHEN THE STORE DELIBERATELY IS NOT ─────────────
 * `VendorPortalStore` is surface-scoped because it injects `VendorApi`, and the
 * dev-only preview shadows `VendorApi` in a component `providers` array — a
 * root-provided store would walk past that shadow and fire real network calls.
 * This service injects NOTHING and fetches NOTHING; it holds one transient
 * string. There is no binding for it to resolve wrongly, so the ordinary
 * root-singleton rule applies, and root is what lets both dashboard concepts and
 * any future section reach it without a provider each.
 *
 * It is deliberately NOT part of the store: the store owns portal *data*, and
 * announcement copy is presentation — keeping the `$localize` strings in the
 * components that already own the wording is what stops the store from becoming
 * a second place to look for UI text.
 *
 * ── THE CONSTRAINTS, WHICH ARE NOT NEGOTIABLE (§6.3) ────────────────────────
 *  - **Polite only.** The region is `role="status"`. A background revalidation
 *    is not an interruption, so there is no `assertive` path here and no API to
 *    ask for one. Failures stay lane-local and `role="alert"`, beside the
 *    control that failed.
 *  - **Never focus-stealing.** This service touches no DOM and moves no focus;
 *    a poll landing mid-keystroke cannot pull the caret anywhere.
 *  - **Never a layout shift.** The region is `sr-only`, so an announcement
 *    occupies no space and can never move a button out from under a pointer
 *    that is already travelling toward it.
 *
 * ── THE REPEAT-MESSAGE PROBLEM ──────────────────────────────────────────────
 * A live region announces when its TEXT CHANGES. Retracting two positions in a
 * row produces the identical sentence twice, the text node does not change, and
 * the second retract is silent — which reads as "the click did nothing". So the
 * value is carried with a sequence number and {@link message} alternates a
 * trailing no-break space, an established live-region technique: the DOM text
 * differs every time, and a trailing space is not spoken.
 */
import { Service, computed, signal } from '@angular/core';

/** The alternating suffix: U+00A0, a no-break space. A plain space would be
 *  normalised away before the region's text is compared and would re-announce
 *  nothing; a no-break space survives and is not spoken. Built from its code
 *  point rather than pasted, so it cannot be silently "fixed" into an ordinary
 *  space by an editor or a reformat. */
const REANNOUNCE_SUFFIX = String.fromCharCode(0xa0);

@Service()
export class VendorPortalAnnouncer {
  private readonly state = signal<{ text: string; seq: number }>({ text: '', seq: 0 });

  /** What the shell's single live region renders. Empty until something is
   *  announced, so the region is present from first paint but says nothing. */
  readonly message = computed(() => {
    const { text, seq } = this.state();
    if (text === '') return '';
    return seq % 2 === 0 ? text : `${text}${REANNOUNCE_SUFFIX}`;
  });

  /**
   * Say something, politely, once. The caller owns the wording (and its
   * `$localize` id); this only guarantees it reaches the one region.
   */
  announce(text: string): void {
    this.state.update((current) => ({ text, seq: current.seq + 1 }));
  }
}
