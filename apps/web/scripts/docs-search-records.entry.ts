/**
 * Bundle entry for `scripts/algolia/push-docs.mjs` (AECI-1270). The push
 * script bundles this file with esbuild in memory (`.md` as text, like
 * `angular.json`), imports the bundle, and calls `buildRecords()`.
 *
 * `@angular/localize/init` comes first: the section labels are `$localize`
 * getters (`docs-content.ts`), and Node has no `$localize` until it runs. The
 * records therefore carry the source-locale (en-US) labels.
 */
import '@angular/localize/init';

import { DOCS_SECTIONS } from '../src/app/docs/docs-content';
import { type DocsSearchRecord, buildDocsSearchRecords } from '../src/app/docs/docs-search-records';

/** Every docs search record from the real manifest. */
export function buildRecords(): readonly DocsSearchRecord[] {
  return buildDocsSearchRecords(DOCS_SECTIONS);
}
