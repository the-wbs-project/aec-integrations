/**
 * Ambient type for raw-text Markdown imports (AECI-237).
 *
 * The Angular application builder is configured with `"loader": { ".md": "text" }`
 * (`angular.json`), so `import body from './x.md'` resolves to the file contents
 * as a string. Consumed by the legal-page content registry
 * (`app/legal/legal-content.ts`) to bundle the `src/content/legal/*.md` documents
 * into both the browser and SSR builds.
 *
 * This MUST stay a script (no top-level `import`/`export`) so the wildcard
 * `declare module '*.md'` is a true ambient module declaration that participates
 * in module resolution — inside a module file it would be treated as augmentation
 * and would not resolve the imports. Covered by `tsconfig.app.json`'s `src` glob.
 */
declare module '*.md' {
  const content: string;
  export default content;
}
