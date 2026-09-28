/**
 * Admin surface for the plugin settings page (design doc §13, config panel).
 *
 * - dynamic plugin/theme management: enumerate the bundled catalog from the
 *   installed tiddlywiki package, read/write the wiki's `tiddlywiki.info`
 *   plugins/themes arrays, then restart the TW child so the change applies;
 * - extensible config: the settings page reads/writes a config tiddler
 *   ($:/plugins/dsh-tiddlywiki/config, a JSON string) that overlays the
 *   cordis `config:` block — future config fields just extend the shape.
 *
 * Routes (all under ROUTE_PREFIX/admin, JSON):
 *   GET  /admin/state    current info + catalog + effective config + status
 *   POST /admin/info     { plugins?, themes? } → write info → restart TW
 *   POST /admin/config   { ...patch }          → write config tiddler
 *   GET  /admin/prompt   the prompt text injected right now (SAVED config)
 *   POST /admin/prompt   { enabled?, mode?, extra?, override? } → the text for
 *                        a DRAFT config (v0.22.7); writes nothing
 *   POST /admin/restart  restart the TW child
 *
 * @module dsh-tiddlywiki/host/admin
 */
export * from './admin-catalog.ts'
export * from './admin-routes.ts'
export * from './admin-secrets.ts'
