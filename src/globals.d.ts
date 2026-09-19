/**
 * Wrangler "Text" rule bundles matched files as a default-exported string
 * (see the sql rule in wrangler.toml). Type declaration for TypeScript.
 *
 * NOTE: do not write the glob pattern literally in this comment -- it
 * contains a "star slash" sequence that terminates the block comment.
 */
declare module '*.sql' {
  const content: string;
  export default content;
}
