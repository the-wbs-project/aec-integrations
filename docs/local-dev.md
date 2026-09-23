# Local development

How to build, run and debug AECi on a workstation, including inside parallel Conductor
workspaces. Moved out of `CLAUDE.md` on 2026-09-23. Local tracing has its own doc,
[`local-tracing.md`](./local-tracing.md). Deploy-side version gating is in
[`CICD_PLAN.md`](./CICD_PLAN.md) §9.2.

## 1. Commands

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm lint:fix
pnpm format
pnpm format:check
pnpm test
pnpm test:unit
pnpm test:e2e
pnpm build
```

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies. |
| `pnpm dev` | Boots the AECi app: SSR Worker on `:8788` and private API Worker on `:8787`, bound. Alias for `pnpm dev:bound`. Uses `.dev.vars` for secrets. |
| `pnpm typecheck` | Type check across the monorepo. |
| `pnpm lint` | ESLint across all packages plus Prettier `--check`. |
| `pnpm lint:fix` | ESLint `--fix` across all packages plus Prettier `--write`. |
| `pnpm format` | Prettier `--write .` |
| `pnpm format:check` | Prettier `--check .` |
| `pnpm test` | Unit plus integration tests. |
| `pnpm test:unit` | Vitest only. |
| `pnpm test:e2e` | Playwright against local `wrangler dev`. |
| `pnpm build` | Build for deployment. |

Local secrets live in `.dev.vars`, one per Worker package. They are not committed.
`.dev.vars.example` shows what is required.

## 2. SSR to API service binding in local dev

The SSR Worker calls the private API Worker over a service binding (`env.API`). In local dev,
wrangler's cross-Worker registry resolves the binding only when both Workers are running and
the API Worker's registered name matches the SSR Worker's `service` value. The bound name is
`aeci-api-preview`, which is the API Worker's `env.preview.name`. So the API Worker must be
started with `--env preview`.

```bash
pnpm dev:bound
```

`pnpm dev:bound` boots the API on `:8787` (as `aeci-api-preview`) and the SSR Worker on `:8788`
in parallel. It runs `pnpm -r --parallel --filter @aeci/api --filter @aeci/web run dev:preview`.

- Running only one of the two Workers leaves the binding unresolved, and the SSR `/api/health`
  proxy fails.
- The legacy single-Worker scripts `pnpm dev:web` and `pnpm dev:api` remain for solo-Worker
  iteration.

## 3. Parallel Conductor workspaces: `dev:conductor` vs `dev:agent`

Many Conductor workspaces run in parallel. Naively they collide two ways.

1. **Ports.** The symptom is `Address already in use` on `8788/8787`.
2. **Wrangler's local dev registry.** It is keyed by worker name (`aeci-web`,
   `aeci-api-preview`), not port. This clash is the nastier one. A second workspace registering
   the same names makes the first `wrangler dev` exit immediately, and pnpm `--parallel` then
   SIGTERMs its sibling. The symptom is `web: Done` plus `api: … signal "SIGTERM"`, with no
   "Address already in use".

Both clashes are fixed.

### 3.1 Ports

Two scripts split the lanes.

- **`pnpm dev:conductor`** pins SSR `8788` and API `8787`, always (`scripts/dev-conductor.sh`).
  It reclaims those ports if a stale or previous session is holding them. This pair is reserved
  for the human's primary workspace, whose preview button and URL point at `localhost:8788`.
  Exactly one workspace should use it.
- **`pnpm dev:agent`** is for every other (agent) workspace. It auto-scans for a free pair
  starting at `8790/8789` (`scripts/dev-launch.sh`), stepping up in twos, so it never touches
  the reserved conductor pair. It prints the URL it chose.

The port override is plumbed through `AECI_WEB_PORT` and `AECI_API_PORT`. Each app's
`dev:preview` and `playwright.config.ts` honor them. Both default to `8788/8787`, so direct
`pnpm dev:bound`, CI and e2e are unchanged, and each gets its own registry too.

**An agent that needs to boot the app in a workspace uses `pnpm dev:agent`.** It does not use
`pnpm dev:conductor`, `pnpm dev` or `pnpm dev:bound`. Leave the constant pair for the human.

### 3.2 Registry

`dev:bound` sets `WRANGLER_REGISTRY_PATH=$PWD/.wrangler/registry`. That gives each workspace
its own isolated dev registry, which is gitignored. Both Workers in a workspace share it, so the
`env.API` service binding still resolves. No two workspaces share names, so there is no
cross-workspace SIGTERM and no binding cross-talk.

### 3.3 Freshness (stale `dist`)

`dev:bound` runs each app's `dev:preview`, which serves a prebuilt `dist/` with no build step.
The legal and content `.md` files are inlined into that bundle at build time, so a stale `dist/`
silently serves old content on launch.

- Both `dev:conductor` and `dev:agent` rebuild the web bundle and clear the local SSR cache
  before booting. The cache is `apps/web/.wrangler/state/v3/cache`, which is Cache API only,
  with no D1 or KV.
- The rebuild makes every launch reflect current source.
- Set `DEV_SKIP_BUILD=1` for a fast restart when the bundle is already current.
- Bare `pnpm dev` and `pnpm dev:bound` skip the rebuild. They still serve whatever is in `dist/`.

### 3.4 Recovering from orphaned `workerd` processes

If launches start failing with the SIGTERM symptom, the cause is almost always orphaned
`workerd` processes from a prior run that Conductor did not clean up. Find them with the first
command below, then `kill` the PIDs. Re-running `dev:conductor` also works, because it reclaims
its own pair.

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep workerd
```

## 4. Local tracing

Wrangler (pinned `^4.123.0`) captures OpenTelemetry traces for every local Worker invocation.
They cover the handler lifecycle, outbound `fetch()`, and binding calls (D1, KV, R2, DO,
Queues). There is no SDK, no config and no code change. The traces are exposed over a read-only
SQL endpoint, so the debug loop for a local failure is to query the runtime rather than add a
log, rebuild and re-curl (AECI-548).

[`local-tracing.md`](./local-tracing.md) is the source of truth for the endpoint, schema,
guardrails and recipes. The short version:

- Derive the URL from the port your session actually bound. Never hardcode `8787`, which
  belongs to the human's `dev:conductor`.
- Two Workers means two trace stores, one per port. All D1 spans live on the API store.
- Failures are not in `spans.outcome` or `spans.error`. Filter on the `error.type` and
  `http.response.status_code` attributes instead.
- Opt out with `X_LOCAL_OBSERVABILITY=false`.

## 5. Version reporting (AECI-74)

`GET /api/version` reports the API Worker's `{ sha, deployedAt, environment }`, proxied through
the SSR Worker. `GET /_version` is served by the SSR Worker itself
(`apps/web/src/server/routes/version.ts`, AECI-92) and reports the SSR Worker's own
`COMMIT_SHA`. The two exist because `/api/version` alone cannot catch a stale SSR deploy.

`COMMIT_SHA` and `DEPLOYED_AT` are injected with `wrangler --var`. They override the
`"unknown"` and epoch placeholders declared in each Worker's `wrangler.jsonc`. Both Workers'
`dev` and `dev:preview` scripts derive them from `git rev-parse HEAD` and
`date -u +%Y-%m-%dT%H:%M:%S.000Z`.

**Any new `wrangler dev` or `wrangler deploy` invocation that targets either Worker must pass
both flags.** Otherwise that Worker's version endpoint reports `sha: "unknown"`.

```bash
wrangler deploy --env staging \
  --var COMMIT_SHA:"$GITHUB_SHA" \
  --var DEPLOYED_AT:"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
```

The deploy gates that check both endpoints (`deploy.yml`, `promote-to-prod.yml`,
`pr-preview.yml`, `refresh-staging.yml`, via `scripts/verify-version.sh`) are described in
[`CICD_PLAN.md`](./CICD_PLAN.md) §9.2. CI wiring landed in AECI-71 and the dual SSR plus API
gate in AECI-92.

## 6. Checked-in agent skills

Shared Claude Code skills live in `.agents/skills/`, checked into the repo so every contributor,
and CI agents, get them automatically. Commit any changes under `.agents/skills/`.

- **`spec-anchor`** is a local skill with two jobs.
  - Anchor: it fetches the Linear issue, resolves its `**Spec section:**` line with a two-pass
    scan, and loads that section and its companion docs. The grammar authors write is in
    [`linear-issue-conventions.md`](./linear-issue-conventions.md).
  - Check (step 4.5, AECI-550): once a plan exists, it reviews the plan against that contract
    before any code is written. Findings are rated CRITICAL, MAJOR or MINOR. It is advisory,
    not blocking.
  - Two rules keep it usable rather than noisy. The precedence chain is `CLAUDE.md`
    constraints, then ADRs, then the superseding spec, then the companion doc, then
    `STAGE_1_SPEC.md` last. Verify-before-flag means every finding must cite a doc and a code
    artifact, so a stale doc yields an advisory MINOR instead of a false blocker.
  - Issues with no `§X.Y` anchor use the n/a ladder.
  - It is the pre-implementation half of [`CODE_REVIEW_CHECKLIST.md`](./CODE_REVIEW_CHECKLIST.md).
- **`pbakaus/impeccable`** is the design skill. It is one skill with 23 sub-commands: `craft`,
  `shape`, `teach`, `document`, `critique`, `audit`, `polish`, `bolder`, `quieter`, `distill`,
  `harden`, `onboard`, `animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive`,
  `clarify`, `adapt`, `optimize`, `extract` and `live`. It lives at `.agents/skills/impeccable/`
  and reads `PRODUCT.md` and `DESIGN.md` at the repo root. Refresh it with
  `npx impeccable skills update`, or reinstall with `npx -y impeccable skills install --force`.
- **`angular-developer`** is the official Angular skill from `angular/skills`. It loads
  version-specific Angular best practices on demand from a bundled `references/` library:
  signals and reactivity, forms, DI, routing, SSR, ARIA, animations, styling, testing and CLI.
  It auto-triggers when you create or modify Angular code in `apps/web/`, and pairs with the
  `angular-cli` MCP server. Added in AECI-131.
- **`angular-new-app`** is the official Angular skill for scaffolding a new Angular app with the
  CLI. It is rarely needed in this established monorepo but is kept for parity with the
  upstream set.

The two Angular skills are installed with the command below. It is the same openskills CLI as
`pnpm skills:update`. It writes the skill dirs under `.agents/skills/`, the `.claude/skills/`
symlinks, and `skills-lock.json` entries. It must not re-hydrate the removed marketing bundle.

```bash
npx skills add https://github.com/angular/skills
```

The `coreyhaines31/marketingskills` bundle (about 39 marketing, SEO and CRO skills) is removed
from the tree. Restore it for marketing work with `pnpm skills:update`. It must never clobber
`impeccable/`. A same-named skill in the bundle is a bug.

## 7. MCP servers

All four servers below are wired in the repo-root `.mcp.json`.

### 7.1 Angular CLI (`angular-cli`)

- Pre-approved through `enabledMcpjsonServers` in `.claude/settings.json` (AECI-131), so it
  connects automatically.
- It runs the workspace's Angular v22 CLI from `apps/web`:
  `sh -c 'cd "$CLAUDE_PROJECT_DIR/apps/web" && exec npx -y @angular/cli mcp -E all'`. This is
  because `@angular/cli` is a dependency of `apps/web`, not the repo root, so `ng` only
  resolves there.
- It registers the stable read tools `get_best_practices`, `search_documentation`,
  `list_projects`, `onpush_zoneless_migration` and `ai_tutor`. It also registers the
  experimental `run_target` (build, test, lint, e2e) and the `devserver.start`,
  `devserver.stop` and `devserver.wait_for_build` tools. The experimental tools can build and
  serve `apps/web`, so invoke them deliberately.
- Before writing, modifying or analyzing any Angular code, call `get_best_practices` once per
  session.
- For any Angular API question (signals, control flow, forms, router, SSR, zoneless), call
  `search_documentation` before answering from training data.
- Use `list_projects` to orient before generating files. It discovers `apps/web/angular.json`.
  Pass that workspace `path` to `run_target` and the devserver tools.
- Prefer the `angular-developer` skill over training-data recall for Angular patterns.

### 7.2 Linear (`linear`)

- Remote HTTP at `https://mcp.linear.app/mcp`, pre-approved in `enabledMcpjsonServers`.
- Auth is `Authorization: Bearer ${LINEAR_API_KEY}`. The token is injected from the Conductor
  keychain (`.conductor/settings.local.toml`, `[environment_variables]`) and never committed.
- Tools cover issues (`list_issues`, `get_issue`, `save_issue`, `list_issue_statuses`,
  `list_issue_labels`), comments (`list_comments`, `save_comment`), projects, cycles, documents
  and releases.
- The team prefix is `AECI`. The `spec-anchor` skill uses this server to fetch an issue and read
  its `**Spec section:**` line, and assumes it is connected.
- Keep the tracker current without asking. The default is to write: file issues for work you
  discover, assign to `chrisw@thewbsproject.com`, move status to match reality (In Progress at
  workspace start, In Review and Done as the PR moves), and comment findings on the issue you are
  working (verification results, blockers, deferred scope). A stale tracker costs more than an
  unnecessary comment.
- Confirm first only when the write lands on someone else's work or destroys context: editing or
  reassigning an issue another person owns, closing an issue you did not do the work for,
  deleting comments, or restructuring projects or cycles.

### 7.3 AECi review app (`aeci-review`)

- Remote HTTP at `https://review.aecintegrations.com/mcp`, pre-approved in
  `enabledMcpjsonServers`. Auth is `Authorization: Bearer ${AECI_MCP_TOKEN}`, also injected from
  the Conductor keychain.
- It is the curation and review application upstream of this repo, the system described in
  [`REVIEW_APP_PROMOTE_API.md`](./REVIEW_APP_PROMOTE_API.md) that pushes promoted products into
  the AECi API via `POST /api/promote`. It exposes vendors, products, integrations, claims and
  attestations, and taxonomy.
- Use it to inspect real production catalog shape when building or debugging a surface that
  renders it: `list_products`, `get_product`, `find_product`, `list_vendors`, `get_vendor`,
  `list_integrations`, `get_integration`, `list_claims`, `get_claim`, `list_taxonomy`, and the
  scoring and demand tools (`compute_product_score`, `compute_vendor_score`,
  `compute_product_search_demand`, `compute_product_reddit_mentions`). Prefer it over inventing
  fixture data.
- Treat the write tools as production actions. `create_*`, `update_*`, `add_attestation` and
  especially `promote_product` mutate the live curation database. `promote_product` also pushes
  rows into the live AECi database and purges edge cache. Never call them to try something out.
  Confirm with the user first, and default to the read tools.

### 7.4 Mobbin (`mobbin`)

- A visual reference library of real shipping apps: flows, screens and component patterns from
  production iOS, Android and web products.
- Use it on any UI-touching issue. During `/impeccable shape` or equivalent, pick the named
  anchor references for a surface. During `/impeccable craft` or component-level work, look up
  patterns from the same anchor site already chosen for that surface.
- Auth: the surfaced tools are `mcp__mobbin__authenticate` and
  `mcp__mobbin__complete_authentication`. Call `authenticate` first, then
  `complete_authentication`. Additional Mobbin tools become callable in the same session after
  auth completes.
- The anchor-site rule binds here. Its source of truth is `DESIGN.md`, "Named Rules", "The
  Anchor-Site Rule".
