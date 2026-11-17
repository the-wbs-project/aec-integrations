import { Directive, output } from '@angular/core';

import { isReplayedEvent } from '../../core/event-replay';

/**
 * `(aecSubmit)` on a `<form>`: the submit handler for a form that may be in the
 * server-rendered HTML (AECI-1919).
 *
 * Every form declares `method="dialog"`, so a press before hydration runs a
 * native submit that does nothing. Angular then replays that press into the
 * real listener once the app is stable, and on a replay `preventDefault` throws
 * "`preventDefault` called during event replay" (`core/event-replay.ts`). An
 * inline `(submit)` handler that called `$event.preventDefault()` therefore
 * threw into the error handler. This directive drops the replayed press, as
 * the other forms do, and otherwise cancels the event and emits.
 *
 * Use it in place of that inline pattern: `<form method="dialog" (aecSubmit)="save()">`.
 */
@Directive({
  selector: 'form[aecSubmit]',
  host: { '(submit)': 'onSubmit($event)' },
})
export class AecFormSubmit {
  /** The visitor's own submit, never a replayed one. */
  readonly aecSubmit = output<void>();

  protected onSubmit(event: Event): void {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    this.aecSubmit.emit();
  }
}
