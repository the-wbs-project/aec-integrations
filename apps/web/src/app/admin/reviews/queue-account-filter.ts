/**
 * The per-person filter of the three review queues (AECI-1949, `ADMIN_PANEL_SPEC.md`
 * §5.13, §5.20, §5.21). `/admin/reviews`, `/admin/review-updates` and
 * `/admin/review-responses` read `?account=<profile id>`, as `/admin/dmca` does
 * (`DESIGN.md` "The Same-Behavior Rule"), and send it as `account_id`. The links on
 * `/admin/users/:id` open them filtered.
 *
 * {@link injectQueueAccount} reads the param reactively, so Back and a changed link
 * re-filter without a reload. {@link QueueAccountFilter} is the bar that says the
 * list is narrowed and clears it.
 */
import { Component, computed, inject, input, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AecButton } from '../../shared/button/button';
import { CONSOLE_TEXT_LINK_CLASS } from '../console/console-detail';

/** `?account=` from the URL, or `null`. Call in an injection context. */
export function injectQueueAccount(): Signal<string | null> {
  const route = inject(ActivatedRoute);
  const params = toSignal(route.queryParamMap, { initialValue: route.snapshot.queryParamMap });
  return computed(() => params().get('account') || null);
}

@Component({
  selector: 'aec-queue-account-filter',
  imports: [AecButton, RouterLink],
  template: `
    <p
      class="flex flex-wrap items-center gap-x-3 gap-y-1 text-t-14 text-(--text-secondary)"
      data-testid="queue-account-filter"
    >
      @if (email(); as address) {
        <span i18n="@@admin.queue.accountFilter.email">Showing items by {{ address }}.</span>
      } @else {
        <span i18n="@@admin.queue.accountFilter.one">Showing one account's items.</span>
      }
      <a
        [routerLink]="['/admin/users', accountId()]"
        [class]="linkClass"
        i18n="@@admin.queue.accountFilter.open"
        >Open the account</a
      >
      <button
        aecButton
        variant="ghost"
        compact
        type="button"
        data-testid="queue-account-clear"
        (click)="clear()"
        i18n="@@admin.queue.accountFilter.clear"
      >
        Clear filter
      </button>
    </p>
  `,
})
export class QueueAccountFilter {
  readonly accountId = input.required<string>();
  /** The person's address, from a loaded row. `null` when none loaded or unknown. */
  readonly email = input<string | null>(null);

  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly linkClass = CONSOLE_TEXT_LINK_CLASS;

  protected clear(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { account: null },
      queryParamsHandling: 'merge',
    });
  }
}
