import { defineConfig } from 'tsdown'

/**
 * Client half build: a single CJS bundle for the browser, emitting
 * lib/client.bundle.js (then scripts/wrap-client.mjs wraps it in
 * window.__ModuleLoader__.load({ id, factory }) → lib/client.js).
 *
 * The client is pure DOM and uses React ONLY as a thin wrapper for the
 * settings.section slot (the shell renders React components there), so react
 * is never bundled — the web app's module loader resolves `require("react")`
 * at runtime. clean:false — the host build already cleaned lib/ and wrote
 * lib/index.js; this step must not wipe it.
 */
export default defineConfig({
  entry: { 'client.bundle': 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  clean: false,
  sourcemap: false,
  outExtensions: () => ({ js: '.js' }),
  deps: { neverBundle: ['react'] },
})
