import { EventPhase } from '@angular/core/primitives/event-dispatch';

/**
 * True when Angular is replaying an event that the inline event-replay contract
 * queued before hydration (AECI-1655).
 *
 * The SSR HTML carries a small inline script that records clicks, submits and
 * key presses made before the app is stable. It never calls `preventDefault`,
 * so the browser has ALREADY run the native default for those events: the link
 * was followed, the key did its normal thing. For a form the native default
 * depends on its method. A `method="get" action="/search"` form was submitted.
 * A `method="dialog"` form, which is every other form (AECI-1919), ran a native
 * submit that does nothing, so the page stayed and the replay reaches the
 * listener. Once the app is stable, Angular hands each queued event to the real listener. Before
 * it does, it sets `event.eventPhase` to `EventPhase.REPLAY` (101) and wraps
 * `preventDefault` so that calling it throws "`preventDefault` called during
 * event replay" (`prepareEventForReplay` in
 * `@angular/core/primitives/event-dispatch`).
 *
 * A handler that calls `preventDefault` must return early on a replay, BEFORE
 * that call, and the call would only throw into `PosthogErrorHandler`. Where the
 * native fallback ran, the in-app path must not run as well. Where it did
 * nothing (a `method="dialog"` form), the replayed press is dropped all the same,
 * as every form here does: the visitor presses again on the live page. A form
 * handler takes `(aecSubmit)` (`shared/form-field/form-submit.ts`), which does
 * this for it.
 * `ANGULAR_STYLE_GUIDE.md` states the rule.
 */
export function isReplayedEvent(event: Event | null | undefined): boolean {
  return event?.eventPhase === EventPhase.REPLAY;
}
