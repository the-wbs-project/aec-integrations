import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

/**
 * Flue owns the Worker entry; the Cloudflare plugin owns workerd dev, the build
 * output, and the deploy config.
 *
 * `flue()` MUST come before `cloudflare()`. The Cloudflare plugin invokes the
 * `flueWorkerConfig()` customizer while Vite resolves the config, and `flue()`
 * must have scanned the `'use agent'` modules by then. The wrong order is a
 * build-time error, not a silent misconfiguration.
 *
 * `flueWorkerConfig()` contributes `main` (a virtual entry) and one Durable
 * Object binding per scanned agent into the resolved wrangler config. It never
 * writes `wrangler.jsonc` — migrations and every application-owned binding stay
 * hand-authored there.
 */
export default defineConfig({
  /**
   * `public/` is NOT Vite's public directory here.
   *
   * It holds exactly one file, the internal test chat page, and `src/app.ts`
   * imports it with `?raw` so the Worker serves it from inside the access gate.
   * Left as the default publicDir, Vite would also copy it into the build
   * output as a static asset AND warn about importing from it. Disabling it
   * keeps one file with one delivery path.
   */
  publicDir: false,
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
