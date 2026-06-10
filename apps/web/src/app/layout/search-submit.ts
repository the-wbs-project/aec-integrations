/**
 * Shared submit handler for the header + mobile-overlay search boxes (AECI-142).
 *
 * Both forms are progressive: `action="/search" method="get"` with an
 * `<input name="q">`, so a no-JS submit performs a native GET navigation to
 * `/search?q=…`. With JS, the `(submit)` binding calls this to do a smooth SPA
 * navigation instead (preventing the full reload). Search-as-you-type from the
 * header is out of scope here — that's Phase 3.11.
 *
 * Kept as a tiny pure helper so `SiteHeader` and `NavMenu` share one
 * implementation rather than duplicating the FormData read + navigate.
 */
import type { Router } from '@angular/router';

export function navigateToSearch(router: Router, event: SubmitEvent): void {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const raw = new FormData(form).get('q');
  const q = typeof raw === 'string' ? raw.trim() : '';
  void router.navigate(['/search'], { queryParams: q ? { q } : {} });
}
