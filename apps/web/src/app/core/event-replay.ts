import { EventPhase } from '@angular/core/primitives/event-dispatch';

/**
 * True when Angular is replaying an event that the inline event-replay contract
 * queued before hydration (AECI-1655).
 *
 * The SSR HTML carries a small inline script that records clicks, submits and
 * key presses made before the app is stable. It never calls `preventDefault`,
 * so the browser has ALREADY run the native default for those events: the link
 * was followed, the form was submitted, the key did its normal thing. Once the
 * app is stable, Angular hands each queued event to the real listener. Before
 * it does, it sets `event.eventPhase` to `EventPhase.REPLAY` (101) and wraps
 * `preventDefault` so that calling it throws "`preventDefault` called during
 * event replay" (`prepareEventForReplay` in
 * `@angular/core/primitives/event-dispatch`).
 *
 * A handler that calls `preventDefault` must return early on a replay, BEFORE
 * that call. The native fallback already ran, so the in-app path must not run
 * as well, and the call would only throw into `PosthogErrorHandler`.
 * `ANGULAR_STYLE_GUIDE.md` states the rule.
 */
export function isReplayedEvent(event: Event | null | undefined): boolean {
  return event?.eventPhase === EventPhase.REPLAY;
}
