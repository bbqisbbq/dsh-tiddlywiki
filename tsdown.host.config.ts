import { defineConfig } from 'tsdown'

/**
 * Host half build: a single ESM entry bundled for Node, emitting lib/index.js.
 *
 * - `tiddlywiki` stays UNBUNDLED (deps.neverBundle): at runtime the host
 *   resolves its absolute entry via
 *   `createRequire(import.meta.url).resolve('tiddlywiki/tiddlywiki.js')` from
 *   the installed package.
 * - node: builtins are external by platform; the resulting lib/index.js
 *   carries ZERO @deepseek-ai runtime imports (sdk.ts reimplements
 *   defineTool/dshHomePath).
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: false,
  sourcemap: true,
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: ['tiddlywiki'] },
})
