import { readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Wraps the tsdown CJS bundle (lib/client.bundle.js) in the DSH web client
// module-loader shape: window.__ModuleLoader__.load({ id, factory }).
// `id` must equal the plugin row id in the profile roster (= package name), so
// it is read from package.json instead of being duplicated here — and
// cross-checked against the row id declared in cordis.patch.yml.
const root = dirname(dirname(fileURLToPath(import.meta.url)))

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const id = pkg.name
if (typeof id !== 'string' || id.length === 0) {
  throw new Error('[wrap-client] package.json has no "name" — cannot derive the module id')
}
const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
const rowId = patch.match(/^[ \t]*-[ \t]+id:[ \t]*(\S+)/m)?.[1]
if (rowId !== id) {
  throw new Error(`[wrap-client] profile row id (${rowId ?? 'not found in cordis.patch.yml'}) must equal package.json name (${id})`)
}

const bundlePath = join(root, 'lib', 'client.bundle.js')
const bundle = await readFile(bundlePath, 'utf8')

// Size gate (AGENTS.md §8): the client MUST stay minified — an unminified
// bundle is >1MB and plugin registries (dsh.pub) reject it. Fail the build
// loudly at 900KB, well before that cliff.
const MAX_BUNDLE_BYTES = 900 * 1024
const bundleBytes = (await stat(bundlePath)).size
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
console.log(`[wrap-client] id=${id} client.bundle.js=${bundleBytes} bytes (${kb(bundleBytes)})`)
if (bundleBytes > MAX_BUNDLE_BYTES) {
  throw new Error(`[wrap-client] client.bundle.js is ${kb(bundleBytes)}, over the ${kb(MAX_BUNDLE_BYTES)} limit — the client bundle must stay minified (check tsdown.client.config.ts)`)
}

const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(id)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${bundle}
		return module.exports;
	}
});
`

await writeFile(join(root, 'lib', 'client.js'), wrapped)
console.log('[wrap-client] wrote lib/client.js')
