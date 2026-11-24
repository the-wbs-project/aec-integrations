import type { SeoEngine } from '@aeci/shared';

/** The two engines' display names, one definition for both panels (AECI-822).
 *  They are never summed anywhere on the screen. */
export const SEO_ENGINE_LABELS: Readonly<Record<SeoEngine, string>> = {
  google: $localize`:@@admin.seo.engine.google:Google`,
  bing: $localize`:@@admin.seo.engine.bing:Bing`,
};
