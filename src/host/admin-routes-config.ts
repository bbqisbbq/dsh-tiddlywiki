/**
 * 常规配置 / 提示词预览 两条 admin 路由（v0.30.25 从 admin-routes.ts 拆出，**纯搬迁** + 工厂化）。
 *
 * POST /admin/config — 保存配置补丁（先过 normalizeConfigPatch，回写后按需热应用 git 配置）
 * GET|POST /admin/prompt — 注入提示词的「现在会是什么样」（POST 带草稿，不落盘）
 *
 * 两者都**按库**取值（每库一份配置 tiddler / 每库一份 prompt.*），所以都先问
 * refuseStoppedTarget：目标库已登记但没在跑时必须 503 点名，而不是安静地改默认库 ——
 * 这正是 v0.29.0 那一类报障的成因（设置页写着「正在配置 X」，改的却是默认库）。
 *
 * 依赖面是**按代码生成**的（不是手抄）：Pick<AdminDeps, 'config' | 'getClient' | 'getPrompt' | 'onConfigChanged'>
 * 加上 base 的两个闭包 helper（refuseStoppedTarget / notRunning，与其它 admin 工厂同形状）。
 * AdminDeps 用 import type 从 base 拿（类型期闭环、运行期无环）。
 *
 * @module dsh-tiddlywiki/host/admin-routes-config
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ConfigPatchError, ConfigUnreadableError, normalizeConfigPatch, PluginConfigShape } from './config.ts'
import { normalizePromptPreview } from './prompt.ts'
import { maskConfigSecrets, stripMaskedSecrets } from './admin-secrets.ts'
import { errorStatus, json, readBody, rejectCrossSiteWrite, rejectNonRead } from './http.ts'
import type { AdminDeps } from './admin-routes.ts'

/** 这一组真正用到的 deps 成员（不是整个 AdminDeps）。 */
export type AdminConfigRouteDeps = Pick<AdminDeps, 'config' | 'getClient' | 'getPrompt' | 'onConfigChanged'>

export function createAdminConfigRoutes(
  deps: AdminConfigRouteDeps,
  /** base 的两个闭包 helper：目标库没在跑时拒掉 / 取它的 503 文案。 */
  helpers: {
    refuseStoppedTarget: (req: IncomingMessage, res: ServerResponse) => boolean
    notRunning: (req: IncomingMessage) => string
  },
) {
  const { refuseStoppedTarget, notRunning } = helpers
  const handleConfig = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (rejectCrossSiteWrite(req, res, ['POST'])) return
      const body = JSON.parse(await readBody(req)) as unknown
      const client = deps.getClient(req)
      if (client === undefined) {
        json(res, { ok: false, error: notRunning(req) }, 503)
        return
      }
      // Validate/normalise BEFORE merging (v0.25.0): the raw body used to be
      // merged verbatim, so any JSON at all (an array → `{"0":1}` keys) became
      // permanent config, and a wrong TYPE (git.debounceMs: "abc") reached the
      // consumer and changed behaviour silently. See normalizeConfigPatch.
      const patch = normalizeConfigPatch(body)
      // Never persist the masked placeholders the page read back from /state
      // (v0.19.3): saving an untouched form must not clobber a real token.
      await deps.config(req).set(client, stripMaskedSecrets(patch as Record<string, unknown>, deps.config(req).get()) as PluginConfigShape)
      // prompt.* may have changed: let the plugin re-register its prompt
      // section now (a no-op when the built text is unchanged).
      deps.onConfigChanged?.()
      json(res, { ok: true, config: maskConfigSecrets(deps.config(req).get()) })
    } catch (err) {
      // A malformed patch is the caller's problem (400): the page can then show
      // exactly which field was wrong instead of a generic 500.
      if (err instanceof ConfigPatchError) {
        json(res, { ok: false, error: err.message }, 400)
        return
      }
      // A config tiddler that EXISTS but cannot be parsed is a user-fixable data
      // problem, not a server fault (v0.23.4): 409 + the actionable text, so the
      // settings page can tell the user what to fix instead of showing「保存失败」.
      if (err instanceof ConfigUnreadableError) {
        json(res, { ok: false, error: err.message }, 409)
        return
      }
      // Not a blanket 400 (v0.19.5): a refused/dead wiki client surfaces as a
      // 500/413 like everywhere else — reporting「参数错误」for a service failure
      // sent the settings page down the wrong recovery path.
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }


  /**
   * GET /dsh-tiddlywiki/admin/prompt — the system-prompt text that would be
   * injected right now, with the effective mode/enabled flag (v0.21.0). The
   * settings page renders it verbatim so a prompt edit is never a black box.
   * Read-only + CSRF-hardened like every other admin read.
   *
   * POST /dsh-tiddlywiki/admin/prompt — same answer for a DRAFT config sent in
   * the body (v0.22.7). The settings page previews what its form currently
   * holds, before 保存配置: the dropdown's value lived only in the browser DOM,
   * so switching 形态 and previewing used to show the still-SAVED text
   * (byte-identical) and read as "the two modes are the same". Nothing is
   * persisted here — `enabled/mode/extra/override` go through the same builder
   * `applyPrompt()` uses, so the draft cannot disagree with a later save.
   */
  const handlePrompt = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      // 提示词是**按库**存的（每库一份 prompt.*）：目标库没在跑时给出基座默认，
      // 等于把「预览」变成另一个库的文本（v0.29.0）。
      if (refuseStoppedTarget(req, res)) return
      const draft = (req.method ?? 'GET').toUpperCase() === 'POST'
      if (draft) {
        if (rejectCrossSiteWrite(req, res, ['POST'])) return
        const raw = (await readBody(req)).trim()
        let body: unknown = {}
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw) as unknown
          } catch {
            json(res, { ok: false, error: 'invalid JSON body' }, 400)
            return
          }
        }
        const prompt = deps.getPrompt?.(normalizePromptPreview(body), req)
        if (prompt === undefined) {
          json(res, { ok: false, error: 'prompt preview is not available' }, 503)
          return
        }
        json(res, { ok: true, draft: true, enabled: prompt.enabled, mode: prompt.mode, length: prompt.text.length, text: prompt.text })
        return
      }
      if (rejectNonRead(req, res)) return
      const prompt = deps.getPrompt?.(undefined, req)
      if (prompt === undefined) {
        json(res, { ok: false, error: 'prompt preview is not available' }, 503)
        return
      }
      json(res, { ok: true, draft: false, enabled: prompt.enabled, mode: prompt.mode, length: prompt.text.length, text: prompt.text })
    } catch (err) {
      json(res, { ok: false, error: err instanceof Error ? err.message : String(err) }, errorStatus(err))
    }
  }
  return { handleConfig, handlePrompt }
}
