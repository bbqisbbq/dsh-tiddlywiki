// Single source of truth for the bundled TW plugin versions.
//
// The version lives in the bundle's INNER plugin.info tiddler (written by
// build-*-bundle.mjs) and is copied to the OUTER wiki tiddler by gen-seed-*.mjs
// — never hardcode it a third time. Bump the matching constant here, then
// rerun the bundle pipeline (build → gen → verify, see AGENTS.md §4).
export const SEND_TO_AGENT_BUNDLE_VERSION = '0.3.4'

// Bumped 0.1.0 → 0.2.0: render.js behavior changed (see the route source).
export const RENDER_BUNDLE_VERSION = '0.2.0'
