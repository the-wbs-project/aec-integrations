/**
 * Site footer.
 *
 * Anchor: Stripe (stripe.com) — three-column structured footer with a
 * brand-area column, legal nav, and company nav. Copyright lives on a
 * bottom strip separated by a thin border.
 *
 * Year is frozen at class init so SSR and client render the same value (no
 * `new Date()` in the template — see ANGULAR_STYLE_GUIDE.md §8, §16).
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Monogram } from './monogram';

@Component({
  selector: 'aec-site-footer',
  imports: [RouterLink, Monogram],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <footer class="border-t border-(--border-default) bg-(--surface-raised)">
      <div class="mx-auto grid max-w-7xl gap-10 px-8 py-12 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <aec-monogram [size]="28" />
          <p
            class="mt-3 max-w-xs text-sm text-(--text-secondary)"
            i18n="@@app.footer.tagline"
          >
            Vendor-verified reviews for AEC software integrations.
          </p>
        </div>
        <nav
          class="text-sm"
          i18n-aria-label="@@app.footer.legal.aria"
          aria-label="Legal"
        >
          <p
            class="mb-3 text-xs uppercase tracking-wide text-(--text-tertiary)"
            i18n="@@app.footer.legal.eyebrow"
          >
            Legal
          </p>
          <ul class="space-y-2">
            <li>
              <a
                routerLink="/legal/terms"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.legal.terms"
              >
                Terms
              </a>
            </li>
            <li>
              <a
                routerLink="/legal/privacy"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.legal.privacy"
              >
                Privacy
              </a>
            </li>
            <li>
              <a
                routerLink="/legal/review-guidelines"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.legal.reviewGuidelines"
              >
                Review guidelines
              </a>
            </li>
            <li>
              <a
                routerLink="/legal/listing-accuracy"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.legal.listingAccuracy"
              >
                Listing accuracy
              </a>
            </li>
          </ul>
        </nav>
        <nav
          class="text-sm"
          i18n-aria-label="@@app.footer.company.aria"
          aria-label="Company"
        >
          <p
            class="mb-3 text-xs uppercase tracking-wide text-(--text-tertiary)"
            i18n="@@app.footer.company.eyebrow"
          >
            Company
          </p>
          <ul class="space-y-2">
            <li>
              <a
                routerLink="/contact"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.contact"
              >
                Contact
              </a>
            </li>
          </ul>
        </nav>
      </div>
      <div class="border-t border-(--border-default) px-8 py-4 text-xs text-(--text-tertiary)">
        <p class="mx-auto max-w-7xl" i18n="@@app.footer.copyright">© {{ year }} AEC Integrations.</p>
      </div>
    </footer>
  `,
})
export class SiteFooter {
  protected readonly year = new Date().getFullYear();
}
