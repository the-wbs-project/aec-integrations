import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Inline "Vendor not found" panel rendered when the resolver returns null.
 *
 * Temporary surface: AECI-62 introduces the global 404 shell, at which point
 * this component is replaced and the route hits the shell instead. Until
 * then, this is rendered inline at the vendor-detail route so we don't ship
 * a Phase 2 page that just shows blank when a slug typos.
 *
 * The page HTTP status is set to 404 by the resolver via Angular's
 * `RESPONSE_INIT.status = 404`, and `MetaService.setNotFoundMeta` writes the
 * noindex robots tag. This component itself has no SEO or status side
 * effects — it's purely visual.
 */
@Component({
  selector: 'aec-vendor-not-found',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="mx-auto w-full max-w-3xl px-6 py-16 text-(--text-primary) md:py-24"
      aria-labelledby="vendor-not-found-title"
    >
      <p
        class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
        i18n="@@vendors.notFound.eyebrow"
      >
        404 — Not found
      </p>
      <h1
        id="vendor-not-found-title"
        class="mt-3 font-serif text-3xl font-semibold tracking-tight md:text-4xl"
        i18n="@@vendors.notFound.title"
      >
        We couldn't find a vendor with that slug.
      </h1>
      <p
        class="mt-4 max-w-2xl text-base leading-relaxed text-(--text-secondary)"
        i18n="@@vendors.notFound.body"
      >
        The vendor <code class="font-mono text-(--text-primary)">{{ slug() }}</code> may have been
        renamed, removed, or never existed. Browse the directory or head back home.
      </p>

      <div class="mt-8 flex flex-wrap gap-3">
        <a
          routerLink="/vendors"
          class="inline-flex items-center rounded-(--radius-md) border border-(--border-strong)
            bg-(--accent-primary) px-5 py-3 text-sm font-bold text-(--surface-base)
            no-underline transition-colors hover:bg-(--accent-primary-hover)
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-primary)
            focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)"
          i18n="@@vendors.notFound.browseAll"
        >
          Browse all vendors
        </a>
        <a
          routerLink="/"
          class="inline-flex items-center rounded-(--radius-md) border border-(--border-default)
            bg-(--surface-raised) px-5 py-3 text-sm font-bold text-(--text-primary)
            no-underline transition-colors hover:border-(--border-strong)
            hover:text-(--accent-primary) focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
            focus-visible:ring-offset-(--surface-base)"
          i18n="@@vendors.notFound.home"
        >
          Go home
        </a>
      </div>
    </section>
  `,
})
export class VendorNotFound {
  readonly slug = input.required<string>();
}
