// Ambient declaration for `import body from './foo.md'` — resolved as raw
// string at build time by the Wrangler `Text` rule in wrangler.jsonc. Lets
// TypeScript accept the import without `any`.
declare module '*.md' {
  const text: string;
  export default text;
}
