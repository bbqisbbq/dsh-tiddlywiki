// Single source of truth for the bundled TW plugin versions.
//
// The version lives in the bundle's INNER plugin.info tiddler (written by
// build-*-bundle.mjs) and is copied to the OUTER wiki tiddler by gen-seed-*.mjs
// — never hardcode it a third time. Bump the matching constant here, then
// rerun the bundle pipeline (build → gen → verify, see AGENTS.md §4).
// Bumped 0.3.4 → 0.3.5 (v0.20.0): notify() now stores the message in a
// $:/temp tiddler before calling $tw.notifier.display — passing free text as a
// title made EVERY notice of the button a silent no-op.
export const SEND_TO_AGENT_BUNDLE_VERSION = '0.3.5'

// Bumped 0.1.0 → 0.2.0: render.js behavior changed (see the route source).
export const RENDER_BUNDLE_VERSION = '0.2.0'

// The「发布到公众号」view-toolbar button (TW side of the opt-in 微信发布 feature).
// Same contract as SEND_TO_AGENT_BUNDLE_VERSION: this constant is the ONE
// source of truth — build-wechat-publish-bundle.mjs stamps it into the bundle's
// inner plugin.info and gen-seed-wechat-publish.mjs copies it to the outer wiki
// tiddler — so bumping behavior means bumping exactly this line.
// Bumped 0.1.0 → 0.2.0 (v0.23.4): the readiness precheck now understands
// `adapters.stale` (installed but outdated adapter files) and reports「版本过旧」
// instead of the misleading「缺少发布脚本」.
export const WECHAT_PUBLISH_BUNDLE_VERSION = '0.2.0'
