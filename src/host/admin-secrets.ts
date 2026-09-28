/**
 * Secret masking for the admin surface (design doc §13).
 *
 * Extracted verbatim from `admin.ts` (a pure code move, v0.28.8): `/admin/*` is
 * an unauthenticated surface, so stored tokens/passwords (and credentials
 * inside the git remote URL) are replaced by `MASKED_SECRET` on the way out and
 * dropped again on the way back in.
 *
 * @module dsh-tiddlywiki/host/admin-secrets
 */
import type { PluginConfigShape } from './config.ts'
import { redactRemoteUrl } from './routes.ts'

/**
 * Sentinel returned instead of a stored secret (`bridge.token` /
 * `ui.sendToAgent.token`) by `GET /admin/state` and by `POST /admin/config`'s
 * echo. `/admin/*` is an unauthenticated surface (only CSRF-hardened), and the
 * config tiddler legitimately carries shared tokens — handing them to any
 * caller of the loopback/LAN-reachable GUI is a real leak (v0.19.3). The
 * settings page renders the sentinel verbatim; posting it back is a no-op
 * (`stripMaskedSecrets` drops it), so the real value never leaves the host.
 */
export const MASKED_SECRET = '********'

/**
 * Mask secrets (and credentials inside the git remote URL) for an HTTP caller.
 *
 * v0.20.0: `auth.password` is masked too. The v0.19.3 implementation (and the
 * docs) claimed it was, but only `bridge.token` / `ui.sendToAgent.token` /
 * `git.remote` were handled — a config tiddler carrying `auth.password` (the
 * config tiddler is a wiki tiddler; a user can hand-edit it) was echoed in
 * clear text by the unauthenticated `GET /admin/state`. `passwordSet` mirrors
 * the `tokenSet` flag so the settings UI can show "a password is stored"
 * without ever receiving it.
 */
export function maskConfigSecrets(config: PluginConfigShape): PluginConfigShape {
  const bridge = (config.bridge ?? {}) as Record<string, unknown>
  const ui = (config.ui ?? {}) as Record<string, unknown>
  const sendToAgent = (ui.sendToAgent ?? {}) as Record<string, unknown>
  const git = (config.git ?? {}) as Record<string, unknown>
  const auth = (config.auth ?? {}) as Record<string, unknown>
  // v0.23.3: the WeChat publish routes accept a shared token too, and the
  // settings page round-trips the whole `wechat` block → mask it like the rest.
  const wechat = (config.wechat ?? {}) as Record<string, unknown>
  const maskToken = (value: unknown): string => (typeof value === 'string' && value.length > 0 ? MASKED_SECRET : '')
  return {
    ...config,
    wechat: {
      ...wechat,
      token: maskToken(wechat.token),
      tokenSet: typeof wechat.token === 'string' && wechat.token.length > 0,
    },
    auth: {
      ...auth,
      password: maskToken(auth.password),
      passwordSet: typeof auth.password === 'string' && auth.password.length > 0,
    },
    git: { ...git, remote: typeof git.remote === 'string' ? redactRemoteUrl(git.remote) : git.remote },
    bridge: {
      ...bridge,
      token: maskToken(bridge.token),
      tokenSet: typeof bridge.token === 'string' && bridge.token.length > 0,
    },
    ui: {
      ...ui,
      sendToAgent: {
        ...sendToAgent,
        token: maskToken(sendToAgent.token),
        tokenSet: typeof sendToAgent.token === 'string' && sendToAgent.token.length > 0,
      },
    },
  } as PluginConfigShape
}

/**
 * Drop the masked placeholders from an incoming config patch so saving the
 * settings page never overwrites a stored secret with `********` (or the
 * redacted git remote with `https://***@…`). `bridge.token`/`ui.sendToAgent.token`
 * are cleared only when the caller actually sends an empty string.
 */
export function stripMaskedSecrets<T extends Record<string, unknown>>(patch: T, current: PluginConfigShape): T {
  const copy = { ...patch } as Record<string, unknown>
  const cleanToken = (container: unknown): unknown => {
    if (typeof container !== 'object' || container === null) return container
    const obj = { ...(container as Record<string, unknown>) }
    if (obj.token === MASKED_SECRET) delete obj.token
    delete obj.tokenSet
    return obj
  }
  if (copy.bridge !== undefined) copy.bridge = cleanToken(copy.bridge)
  // v0.23.3: `wechat.token` follows the same round-trip rule.
  if (copy.wechat !== undefined) copy.wechat = cleanToken(copy.wechat)
  // v0.20.0: the same round-trip rule for auth.password (`passwordSet` is a
  // display-only flag and must never be persisted).
  if (copy.auth !== undefined && typeof copy.auth === 'object' && copy.auth !== null) {
    const auth = { ...(copy.auth as Record<string, unknown>) }
    if (auth.password === MASKED_SECRET) delete auth.password
    delete auth.passwordSet
    copy.auth = auth
  }
  if (copy.ui !== undefined) {
    const ui = typeof copy.ui === 'object' && copy.ui !== null
      ? { ...(copy.ui as Record<string, unknown>) }
      : copy.ui
    if (typeof ui === 'object' && ui !== null && (ui as Record<string, unknown>).sendToAgent !== undefined) {
      ;(ui as Record<string, unknown>).sendToAgent = cleanToken((ui as Record<string, unknown>).sendToAgent)
    }
    copy.ui = ui
  }
  if (copy.git !== undefined && typeof copy.git === 'object' && copy.git !== null) {
    const git = { ...(copy.git as Record<string, unknown>) }
    const storedRemote = typeof current.git?.remote === 'string' ? current.git.remote : ''
    if (typeof git.remote === 'string' && storedRemote.length > 0 && git.remote === redactRemoteUrl(storedRemote)) {
      delete git.remote
    }
    copy.git = git
  }
  return copy as T
}
