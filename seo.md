# SEO Improvement Plan — aecintegrations.com

## Technical SEO (code changes)

1. **Add `robots.txt`** — No robots.txt exists. Search engines need explicit crawling directives.

2. **Add `sitemap.xml`** — Missing entirely. Even for a single-page site, a sitemap helps search engines discover and index your content.

3. **Add a canonical URL tag** — `<link rel="canonical" href="https://www.aecintegrations.com/">` is missing. Prevents duplicate content issues between `www` and non-`www`.

4. **Add structured data (JSON-LD)** — No Schema.org markup exists. Add `Organization`, `WebSite`, and potentially `SoftwareApplication` or `Product` schemas relevant to AEC software evaluation.

5. **Add Twitter Card meta tags** — Open Graph tags exist but no `twitter:card`, `twitter:title`, `twitter:description`, or `twitter:image` tags.

6. **Set up www vs non-www redirect** — Both `www.aecintegrations.com` and `aecintegrations.com` are configured as custom domains with no redirect. Pick one canonical domain and 301-redirect the other.

7. **Add a `manifest.json`** — Missing. Helps with PWA signals and can marginally improve search presence.

8. **Configure Cloudflare Web Analytics** — The script is included but the token is a placeholder (`CLOUDFLARE_WEB_ANALYTICS_TOKEN`). Either configure it or remove the dead script.

## Off-Page / Infrastructure

9. **Submit sitemap to Google Search Console** — Register the site, verify ownership, and submit sitemap.

10. **Submit to Bing Webmaster Tools** — Same process for Bing.

11. **Set up Google Business Profile** — If AEC Integrations has a business presence, this boosts local/brand search visibility.

12. **Register with AEC/construction industry directories** — Backlinks from industry-specific directories (e.g., AEC resource lists, BuildingSMART, construction tech directories) carry strong topical authority.

13. **Verify HTTP-to-HTTPS redirect** — Cloudflare likely handles this, but verify it's enforced.

14. **Implement security headers** — Add a `_headers` file for CSP, HSTS, X-Frame-Options, etc. Security headers are an indirect ranking signal and improve trust.

## Performance & Crawlability

15. **Audit Core Web Vitals** — Run Lighthouse / PageSpeed Insights. The 44KB single HTML file with Google Fonts loaded via `<link>` could be optimized (self-host Inter font, inline critical CSS).

16. **Preload key assets** — Add `<link rel="preload">` for the hero image and critical fonts to improve LCP.

17. **Set proper cache headers** — No `_headers` file exists. Static assets should have long cache TTLs; HTML should have short ones.

## Content Strategy (off-page)

18. **Start a blog or resource section** — A single-page site has very limited keyword surface area. Adding pages targeting specific AEC software evaluation queries will dramatically expand organic reach.

19. **Build backlinks through content** — Guest posts, industry reports, or comparison guides that other AEC sites would link to.

20. **Social profiles** — Ensure consistent NAP (Name, Address, Phone) and links across LinkedIn, Twitter/X, and any industry platforms.
