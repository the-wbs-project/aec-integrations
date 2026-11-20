import {
  Directive,
  Injectable,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

/**
 * Whether the app is live in the browser: false on the server and through the first
 * (hydrating) render, true from then on. One answer for the whole page. `App` injects
 * it in its constructor, so it starts at bootstrap and a box drawn later, such as the
 * claim dialog's after a refused submit, is enabled from its first frame and can take
 * focus at once.
 */
@Injectable({ providedIn: 'root' })
export class AppLive {
  readonly live = signal(false);

  constructor() {
    afterNextRender(() => this.live.set(true));
  }
}

/**
 * `aecConsent` on a consent checkbox (AECI-1720): the box is disabled until the app is
 * live, and until the page says it is ready.
 *
 * The forms with a consent box are server-rendered, and a tick made before hydration
 * is never carried into the model (`early-input.ts`). If the box could be ticked
 * early, hydration would untick it in front of the visitor. So the server HTML
 * renders it `disabled`, as the claim submit waits for hydration
 * (`request-form-body.ts`), and the box becomes tickable once the app has rendered in
 * the browser. A disabled box looks inert (the browser's own disabled look), leaves
 * the tab order, and is announced as dimmed. Its label and the links in it stay
 * readable and clickable. The attribute is the same for every visitor, so the cached
 * HTML is too.
 *
 * A bare `aecConsent` is ready at once. `[aecConsent]="settled()"` also waits for the
 * page: `/auth/terms` keeps its box disabled until the summary of changes has loaded,
 * or the read has failed (the page works without it, so a failed read must not trap
 * the reader). A box drawn after the app is live is enabled from its first frame.
 *
 * Every consent box carries it: the Vendor Terms box, the `/auth/terms` box, the
 * portal and admin acceptance boxes and the launch-updates opt-in.
 * `early-input-coverage.spec.ts` fails any checkbox without it that is not on the
 * spec's short list of non-consent boxes.
 */
@Directive({
  selector: 'input[type=checkbox][aecConsent]',
  host: { '[attr.disabled]': 'enabled() ? null : ""' },
})
export class AecConsentBox {
  private readonly app = inject(AppLive);
  /** False while the page is not ready for a tick. A bare attribute is ready. */
  readonly aecConsent = input(true, { transform: (v: boolean | '') => v !== false });
  protected readonly enabled = computed(() => this.app.live() && this.aecConsent());
}
