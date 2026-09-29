/**
 * Note read/write `tiddlywiki_*` tools: get / put / batch_put / append / rename /
 * delete / trash.
 *
 * Split out of `tools.ts` in v0.28.8 — pure code move, bodies unchanged.
 *
 * v0.30.7: the seven factories moved into three responsibility-grouped modules
 * (`tools-notes-{write,structure,lifecycle}.ts`) purely so no single file has to
 * hold all of them. THIS file stays the barrel `tools.ts` imports from, so the
 * registration order (which `full`-mode prompt parameter index depends on) and
 * every external import path are unchanged.
 *
 * @module dsh-tiddlywiki/host/tools-notes
 */
export { getTool, putTool, batchPutTool } from './tools-notes-write.ts'
export { renameTool, appendTool } from './tools-notes-structure.ts'
export { deleteTool, trashTool } from './tools-notes-lifecycle.ts'