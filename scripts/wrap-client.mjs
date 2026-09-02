import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Wraps the tsdown CJS bundle (lib/client.bundle.js) in the DSH web client
// module-loader shape: window.__ModuleLoader__.load({ id, factory }).
// `id` must equal the plugin row id in the profile roster (= package name).
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const id = 'dsh-tiddlywiki'
const bundle = await readFile(join(root, 'lib', 'client.bundle.js'), 'utf8')

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
