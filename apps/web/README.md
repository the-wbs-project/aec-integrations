# `@aec/web`

The customer-facing Angular 21 SSR app for AEC Integrations. Renders on Cloudflare Workers, hydrates zoneless on the client, and talks to the private API Worker via a service binding.

For the full picture (data model, routes, caching, auth) read **`docs/STAGE_1_SPEC.md`** in the repo root. The repo-level `CLAUDE.md` covers cross-cutting constraints (Prisma Accelerate, cache safety, i18n, zoneless, theme tokens).

## Run it

```bash
pnpm install                       # from the repo root
pnpm --filter @aec/web build       # SSR + browser bundles
pnpm --filter @aec/web dev         # wrangler dev with SSR
```

The Spartan brain probe page lives at `/_demo/spartan` — use it to confirm primitives render, both themes apply, and keyboard focus traps inside the dialog.

## UI primitives policy: brain only, no helm

We use [`@spartan-ng/brain`](https://www.spartan.ng/) headless primitives + [`@angular/cdk`](https://material.angular.dev/cdk/categories) directly. We do **not** use `@spartan-ng/helm` and we do **not** run Spartan's `helm` code generation.

**Rule (from `docs/STAGE_1_SPEC.md` §2):**

> Spartan UI **brain primitives only** (signal-based) + Angular CDK. `helm` codegen is avoided (alpha-CLI instability; decision validated in stack-test).

In practice:

- Import the brain directives you need from the per-primitive subpath, e.g. `import { BrnButton } from '@spartan-ng/brain/button'` and `import { BrnDialog, BrnDialogTrigger, ... } from '@spartan-ng/brain/dialog'`.
- Style them with Tailwind utilities and the theme-token CSS vars defined in `src/styles.css` (e.g. `bg-(--surface-base)`, `text-(--text-primary)`, `border-(--border-default)`, `bg-(--accent-primary)`). The tokens are bound to both light and dark themes — every component must render correctly in both.
- The Tailwind preset import in `src/styles.css` is `@spartan-ng/brain/hlm-tailwind-preset.css`. That gives us the brain-side preset; **it does not** opt us into helm.
- **Do not** install `@spartan-ng/helm` or `@spartan-ng/cli`.
- **Do not** run `ng generate @spartan-ng/cli:ui …`.
- **Do not** copy helm-generated component files (`hlm-*`) into this app.

If a brain primitive is missing something we need, build the wrapper component in this repo using brain + CDK + Tailwind. Don't pull in helm to "fill the gap".

## Stack quick reference

- Angular 21 standalone components, zoneless (`provideZonelessChangeDetection`)
- Tailwind CSS v4 via `@tailwindcss/postcss` + the brain preset
- SSR via `@angular/ssr` running on Cloudflare Workers (`compatibility_flags: ["nodejs_compat"]` for the SSR Worker runtime only)
- `@angular/localize` with `en-US` as the default locale — every visible string must be wrapped with an `i18n` attribute or `$localize` tag
- Theme tokens in `src/styles.css` follow `docs/STAGE_1_SPEC.md` §2a.2 byte-for-byte

When in doubt, the spec is the contract.
