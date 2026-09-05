/**
 * Generated from the wiki bundle (do not hand-edit the constant).
 * Source: render.bundle.json
 *
 * The "原生渲染路由" TW plugin, packaged as a TiddlyWiki plugin bundle
 * (`{"tiddlers": {...}}`), seeded into fresh wikis by seedRenderRoute. It
 * registers a server-side route module (`server-routes/render.js`,
 * module-type: route) that renders wiki text into a pure HTML fragment with
 * internal links rewritten to the same-origin DSH proxy hash.
 *
 * @module dsh-tiddlywiki/host/seed-render
 */
import type { TiddlyWebClient } from './tw-api.ts'

/** The packaged plugin tiddler title (a TW system tiddler, type application/json). */
export const RENDER_PLUGIN_TITLE = '$:/plugins/dsh/render'

/** One-time marker: presence means "the route was offered once — hands off". */
export const RENDER_MARKER_TITLE = '$:/plugins/dsh-tiddlywiki/seed-render'

/** The bundle's JSON text (`{"tiddlers": {...}}`), exactly as TW stores it. */
export const RENDER_BUNDLE_TEXT = "{\n  \"tiddlers\": {\n    \"$:/plugins/dsh/render/plugin.info\": {\n      \"title\": \"$:/plugins/dsh/render/plugin.info\",\n      \"type\": \"application/json\",\n      \"text\": \"{\\\"title\\\":\\\"$:/plugins/dsh/render\\\",\\\"name\\\":\\\"DSH Wiki Render\\\",\\\"description\\\":\\\"把 wiki 文本原生渲染成 HTML 片段（POST /render 服务端路由），供 DSH 回复流工具卡与 wiki 链接跳转使用\\\",\\\"author\\\":\\\"dsh-tiddlywiki\\\",\\\"version\\\":\\\"0.1.0\\\",\\\"plugin-type\\\":\\\"plugin\\\"}\"\n    },\n    \"$:/plugins/dsh/render/server-routes/render.js\": {\n      \"title\": \"$:/plugins/dsh/render/server-routes/render.js\",\n      \"type\": \"application/javascript\",\n      \"module-type\": \"route\",\n      \"text\": \"/*\\\\\\ntitle: $:/plugins/dsh/render/server-routes/render.js\\ntype: application/javascript\\nmodule-type: route\\n\\nPOST /render — native TiddlyWiki → HTML fragment for the DSH reply stream\\n\\nBody (JSON in state.data):\\n  { title }                       render an existing tiddler's wikified body\\n  { text, contextTitle?, parseAsInline? }\\n                                  render arbitrary wiki text as a fragment\\n\\\\*/\\n\\\"use strict\\\";\\n\\n/*\\nThe fragment's internal wiki links are rewritten to the SAME-ORIGIN DSH proxy\\nhash (`/dsh-tiddlywiki/tw/#<title>`) by overriding the `tv-wikilink-template`\\nvariable while rendering. Verified against tiddlywiki 5.4.1's link widget:\\n`link.js` expands `$uri_encoded$` (encodeURIComponentExtended) into the href,\\nso the default `#Title` becomes `/dsh-tiddlywiki/tw/#Title`. The DSH page's\\ndocument-level click interceptor + the embedded TW's hash navigation\\n(story.js reads the hash via decodeURIComponentSafe) both handle that href —\\nno post-hoc string rewriting needed.\\n*/\\nvar WIKILINK_TEMPLATE = \\\"/dsh-tiddlywiki/tw/#$uri_encoded$\\\";\\n\\nexports.methods = [\\\"POST\\\"];\\n\\nexports.path = /^\\\\/render$/;\\n\\nexports.info = {\\n\\tpriority: 100\\n};\\n\\nfunction sendJson(response,status,payload) {\\n\\tresponse.writeHead(status,{\\\"Content-Type\\\":\\\"application/json; charset=utf-8\\\",\\\"Cache-Control\\\":\\\"no-store\\\"});\\n\\tresponse.end(JSON.stringify(payload));\\n}\\n\\nexports.handler = function(request,response,state) {\\n\\tvar body;\\n\\ttry {\\n\\t\\tbody = JSON.parse(state.data || \\\"{}\\\");\\n\\t} catch(e) {\\n\\t\\tsendJson(response,400,{ok:false,error:\\\"invalid JSON body\\\"});\\n\\t\\treturn;\\n\\t}\\n\\ttry {\\n\\t\\tvar variables = {\\n\\t\\t\\t\\\"tv-wikilink-template\\\": WIKILINK_TEMPLATE\\n\\t\\t};\\n\\t\\tif(typeof body.title === \\\"string\\\" && body.title.length > 0) {\\n\\t\\t\\t// Render an existing tiddler's wikified body (block parse, so\\n\\t\\t\\t// headings / tables / lists render natively).\\n\\t\\t\\tvar tiddler = state.wiki.getTiddler(body.title);\\n\\t\\t\\tif(!tiddler) {\\n\\t\\t\\t\\tsendJson(response,404,{ok:false,notFound:true,title:body.title});\\n\\t\\t\\t\\treturn;\\n\\t\\t\\t}\\n\\t\\t\\tvariables.currentTiddler = body.title;\\n\\t\\t\\tvar html = state.wiki.renderText(\\\"text/html\\\",\\\"text/vnd.tiddlywiki\\\",tiddler.fields.text,{\\n\\t\\t\\t\\tparseAsInline: false,\\n\\t\\t\\t\\tvariables: variables\\n\\t\\t\\t});\\n\\t\\t\\tresponse.writeHead(200,{\\\"Content-Type\\\":\\\"text/html; charset=utf-8\\\",\\\"Cache-Control\\\":\\\"no-store\\\"});\\n\\t\\t\\tresponse.end(html);\\n\\t\\t\\treturn;\\n\\t\\t}\\n\\t\\tif(typeof body.text === \\\"string\\\") {\\n\\t\\t\\t// Render arbitrary wiki text (contextTitle gives currentTiddler so\\n\\t\\t\\t// links/transclusions resolve in that tiddler's context).\\n\\t\\t\\tif(typeof body.contextTitle === \\\"string\\\" && body.contextTitle.length > 0) {\\n\\t\\t\\t\\tvariables.currentTiddler = body.contextTitle;\\n\\t\\t\\t}\\n\\t\\t\\tvar inline = body.parseAsInline === true;\\n\\t\\t\\tvar textHtml = state.wiki.renderText(\\\"text/html\\\",\\\"text/vnd.tiddlywiki\\\",body.text,{\\n\\t\\t\\t\\tparseAsInline: inline,\\n\\t\\t\\t\\tvariables: variables\\n\\t\\t\\t});\\n\\t\\t\\tresponse.writeHead(200,{\\\"Content-Type\\\":\\\"text/html; charset=utf-8\\\",\\\"Cache-Control\\\":\\\"no-store\\\"});\\n\\t\\t\\tresponse.end(textHtml);\\n\\t\\t\\treturn;\\n\\t\\t}\\n\\t\\tsendJson(response,400,{ok:false,error:\\\"body must provide \\\\\\\"title\\\\\\\" or \\\\\\\"text\\\\\\\"\\\"});\\n\\t} catch(e) {\\n\\t\\tsendJson(response,500,{ok:false,error:String((e && e.message) || e)});\\n\\t}\\n};\\n\"\n    }\n  }\n}"

/**
 * Seed the "原生渲染路由" TW plugin exactly once per wiki (mirrors the
 * send-to-agent one-shot policy). The marker records the offer; afterwards the
 * bundle is user-owned — deleting it and restarting dsh web does NOT recreate
 * it, and edits are never overwritten. With `opts.force` the bundle is
 * (re)written even when it already exists and the marker is (re)written — the
 * settings page uses this for "重新初始化". Returns whether a bundle was
 * written this call. Never throws.
 */
export async function seedRenderRoute(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const marker = await client.get(RENDER_MARKER_TITLE).catch(() => undefined)
    if (marker !== undefined) return false
  }
  const existing = await client.get(RENDER_PLUGIN_TITLE).catch(() => undefined)
  let wrote = false
  if (force || existing === undefined) {
    await client.put({
      title: RENDER_PLUGIN_TITLE,
      text: RENDER_BUNDLE_TEXT,
      type: 'application/json',
      tags: [],
      // TW only REGISTERS a wiki tiddler as a plugin (boot.js
      // registerPluginTiddlers) when the OUTER tiddler carries a
      // `plugin-type` field — without it the bundle is never unpacked and its
      // server-routes module is never defined, so /render 404s. The metadata
      // mirrors what the live send-to-agent bundle's tiddler carries.
      'plugin-type': 'plugin',
      name: 'DSH Wiki Render',
      author: 'dsh-tiddlywiki',
      version: '0.1.0',
      description: '把 wiki 文本原生渲染成 HTML 片段（POST /render 服务端路由），供 DSH 回复流工具卡与 wiki 链接跳转使用',
    })
    wrote = true
  }
  // Record the offer regardless, so an existing bundle (upgrade from a
  // pre-seed wiki) also becomes user-owned from here on.
  await client
    .put({ title: RENDER_MARKER_TITLE, text: 'seeded-once', type: 'text/plain', tags: [] })
    .catch(() => undefined)
  return wrote
}
