# `@aeci/shared`

Shared API contracts for the AEC Integrations Workers. Consumed by `@aeci/web`
(SSR Worker) and `@aeci/api` (private API Worker via service binding).

**Workspace-only. Not published.**

## Contract approach

Per `docs/API_CONTRACTS.md` §2:

- **Zod schemas + their inferred TypeScript types are the contract.** No
  OpenAPI spec, no codegen, no separate documents to drift apart from.
- The API Worker validates incoming requests against the relevant Zod schema
  at the handler boundary; responses are typed but not runtime-validated
  (we trust our own server).
- The SSR Worker imports the static TypeScript types (and, where useful, the
  Zod schemas for parsing error envelopes coming back from the API).

A single source of truth in this package means a schema change propagates
into both Workers via TypeScript at the next typecheck. No regeneration step.

## Layout

```
packages/shared/
├── src/
│   ├── api/
│   │   ├── common.ts         # ApiErrorSchema, PaginationQuerySchema, SortOrderSchema
│   │   ├── common.spec.ts
│   │   └── index.ts          # barrel for `@aeci/shared/api`
│   ├── errors/
│   │   ├── codes.ts          # ApiErrorCode constants (NOT_FOUND, FORBIDDEN, …)
│   │   └── index.ts
│   └── index.ts              # top-level barrel
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

Consumers can import either from the root or from a subpath that matches the
shape shown in the docs:

```ts
import { ApiErrorSchema, type ApiError } from "@aeci/shared";
import { ApiErrorCode } from "@aeci/shared/errors";
// And, once entity-specific schemas land in Phase 2:
import { SubmitReviewSchema } from "@aeci/shared/api/reviews";
```

## Adding new endpoint schemas

1. Create `src/api/<entity>.ts` (e.g., `src/api/products.ts`).
2. Define the Zod schemas; export the inferred TS type alongside each:

   ```ts
   import { z } from "zod";

   export const GetProductQuerySchema = z.object({
     slug: z.string().min(1).max(100),
   });

   export type GetProductQuery = z.infer<typeof GetProductQuerySchema>;
   ```

3. Co-locate a `.spec.ts` exercising at least one happy path and one rejection.
4. The new file is automatically reachable as `@aeci/shared/api/<entity>` via
   the `exports` map — no need to touch the root barrel unless you want the
   symbols available from `@aeci/shared` directly.

## Workers bundling rules

Both consumer Workers bundle TypeScript source from this package directly
(no build step here). To keep both bundles clean:

- **No Node-only imports.** Don't reach for `node:fs`, `node:path`,
  `node:crypto`, etc. `crypto.randomUUID()` from the Web Crypto global is
  fine; `import { randomUUID } from 'node:crypto'` is not.
- **No top-level side effects.** Schemas are values; module-level code that
  triggers I/O or registers globals will run at Worker cold-start and slow
  every request.
- **ESM only.** Stay aligned with the rest of the workspace (`"type": "module"`).

## Local development

```bash
pnpm --filter @aeci/shared typecheck
pnpm --filter @aeci/shared test:unit
```

Both run as part of the root `pnpm typecheck` / `pnpm test:unit` aggregates.
