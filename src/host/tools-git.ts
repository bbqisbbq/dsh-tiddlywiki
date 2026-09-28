/**
 * Git-facing `tiddlywiki_*` tools: git_sync / git_resolve, plus the shared
 * status + receipt renders they use.
 *
 * Split out of `tools.ts` in v0.28.8 — pure code move, bodies unchanged.
 *
 * @module dsh-tiddlywiki/host/tools-git
 */
import { join } from 'node:path'
import { defineTool } from '../sdk.ts'
import { GitConflictStateError } from './git.ts'
import type { GitStatusView } from './git.ts'
import { flushPendingWrites } from './seeds.ts'
import { sessionIdOf } from './tools-support.ts'
import type { ResolveResult, SyncResult, ToolEnv } from './tools-support.ts'

/** One-line 状态 summary: 分支 … 领先 … 落后 … 工作区未提交 … 最近提交. */
function gitStatusBits(s: GitStatusView): string {
  const bits = [`分支 ${s.branch}`]
  if (s.ahead !== undefined) bits.push(`领先 ${s.ahead}`)
  if (s.behind !== undefined) bits.push(`落后 ${s.behind}`)
  if (s.dirty) bits.push(`工作区有 ${s.dirtyFiles.length} 个未提交改动`)
  if (s.lastCommit !== undefined) bits.push(`最近提交 ${s.lastCommit}`)
  return bits.join(' · ')
}

function renderSync(value: SyncResult): Array<{ type: 'text'; text: string }> {
  const lines = [`git ${value.action}: ${value.ok ? '成功' : '失败'}`]
  lines.push(`  ${value.message}`)
  if (value.conflictFiles !== undefined && value.conflictFiles.length > 0) {
    lines.push(`冲突文件（rebase 已 abort，勿自动覆盖）:`)
    for (const f of value.conflictFiles) lines.push(`  - ${f}`)
    lines.push('处理方式：用 tiddlywiki_git_resolve files=[以上文件] strategy=keep-local|keep-remote 按 tiddler 二选一解决，再重新 sync；也可以直接让用户处理。')
  }
  if (value.commit !== undefined) lines.push(`本地 commit: ${value.commit}`)
  if (value.push !== undefined) lines.push(`远端 push: ${value.push}`)
  if (value.changed === true) {
    lines.push(value.restarted !== undefined && value.restarted.length > 0
      ? `本次 pull 拉取了新内容，已重启：${value.restarted.join('、')}（同端口），其读取/搜索均为最新快照。`
      : '本次 pull 拉取了新内容，但没有正在运行的知识库受影响（无需重启，或改动落在未运行的库里）。')
  }
  if (value.restartFailed !== undefined) {
    for (const item of value.restartFailed) lines.push(`TW 重启失败：${item.id} —— ${item.message}`)
  }
  if (value.status !== undefined) {
    lines.push(`状态: ${gitStatusBits(value.status)}`)
    const s = value.status
    if (s.dirty && s.dirtyFiles.length > 0) lines.push(`  未提交: ${s.dirtyFiles.join(', ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export function gitSyncTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_git_sync ──────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_git_sync',
    description: '对 TiddlyWiki 知识库的 git 仓库做同步：pull（拉取远端并 rebase 本地，冲突则 abort 并报文件）、push（推送本地提交到远端）、sync（pull → commit 本地改动 → push）。未配置 git.remote 时 push 会失败并提示。',
    parameters: {
      action: { type: 'string', enum: ['pull', 'push', 'sync'], description: '要执行的 git 操作', required: true },
      message: { type: 'string', description: 'commit 信息（可选，仅 sync 的本地 commit 使用）' },
    },
    output: {
      render: (_args, value: SyncResult) => renderSync(value),
    },
    execute: async (args: { action: 'pull' | 'push' | 'sync'; message?: string }, exec: unknown): Promise<SyncResult> => {
      const dir = deps.wikiPath()
      /**
       * Restart the RUNNING wikis whose content this pull changed.
       *
       * `changedFiles` is what makes this correct with several knowledge bases in
       * one repository: restarting "the wiki I happened to pull from" would miss
       * the one that actually changed, and would interrupt a wiki nothing
       * happened to (v0.28.0).
       */
      const restartIfChanged = async (pulled: { changed?: boolean; changedFiles?: string[] }): Promise<{ restarted?: string[]; restartFailed?: Array<{ id: string; message: string }> }> => {
        if (pulled.changed !== true) return {}
        if (deps.restartAffected === undefined) return {}
        try {
          // DRAIN THE SYNCER FIRST (v0.19.1, data safety): a PUT answers 204 as
          // soon as the tiddler is in TW's in-memory store; the filesystem
          // syncer writes it ~250ms later. Restarting TW before that flush KILLS
          // the write (the restarted server boots from the old snapshot and the
          // note is gone — not even the git commit that follows can recover it).
          // The agent path is the risky one: `tiddlywiki_put` → `git_sync`
          // back-to-back. Same sentinel trick as seeds.ts / index.ts.
          await flushPendingWrites(requireWiki(sessionIdOf(exec)), join(dir, 'tiddlers')).catch(() => undefined)
          const outcome = await deps.restartAffected(dir, pulled.changedFiles ?? [])
          return {
            ...(outcome.restarted.length > 0 ? { restarted: outcome.restarted } : {}),
            ...(outcome.failed.length > 0 ? { restartFailed: outcome.failed } : {}),
          }
        } catch (err) {
          return { restartFailed: [{ id: '(全部)', message: err instanceof Error ? err.message : String(err) }] }
        }
      }
      switch (args.action) {
        case 'pull': {
          const r = await deps.git.pull(dir)
          const restart = await restartIfChanged(r)
          return { action: args.action, ok: r.ok, message: r.message, ...(r.conflictFiles !== undefined ? { conflictFiles: r.conflictFiles } : {}), ...(r.changed === true ? { changed: true } : {}), ...restart }
        }
        case 'push': {
          const r = await deps.git.push(dir)
          return { action: args.action, ok: r.ok, message: r.message }
        }
        case 'sync': {
          const pulled = await deps.git.pull(dir)
          if (!pulled.ok) return { action: args.action, ok: false, message: pulled.message, ...(pulled.conflictFiles !== undefined ? { conflictFiles: pulled.conflictFiles } : {}) }
          const restart = await restartIfChanged(pulled)
          // The commit guard (v0.23.4) turns a conflicted tree into a structured
          // failure instead of a thrown error: the model must SEE why nothing was
          // committed, otherwise it would report「同步完成」over broken content.
          let committed: { committed: boolean; message: string }
          try {
            committed = await deps.git.commit(dir, args.message ?? `sync ${new Date().toISOString()}`)
          } catch (err) {
            if (err instanceof GitConflictStateError) {
              return { action: args.action, ok: false, message: err.message, conflictFiles: err.files, ...restart }
            }
            throw err
          }
          const pushed = await deps.git.push(dir)
          const status = await deps.git.status(dir)
          return {
            action: args.action,
            ok: pushed.ok,
            message: pushed.ok ? '同步完成' : pushed.message,
            pull: 'ok',
            ...(pulled.changed === true ? { changed: true } : {}),
            ...restart,
            commit: committed.message,
            push: pushed.message,
            status,
          }
        }
      }
    },
  })
}

export function gitResolveTool(env: ToolEnv) {
  const { deps } = env
  // ── tiddlywiki_git_resolve ───────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_git_resolve',
    description: '在 tiddlywiki_git_sync action=pull 冲突（已 abort）后，按 tiddler 二选一解决：keep-local 保留本地版本；keep-remote 用 git fetch 拉取远端并检出远端版本（需已配置 git.remote）；list 仅报告当前状态。解决后建议重新 pull/sync 整合其余改动。',
    parameters: {
      strategy: { type: 'string', enum: ['keep-local', 'keep-remote', 'list'], description: 'keep-local=保留本地；keep-remote=改用远端版本；list=仅报告当前 git 状态', required: true },
      files: { type: 'array', items: { type: 'string' }, description: '冲突文件名数组（来自 pull 返回的 conflictFiles；list 时忽略）' },
    },
    output: {
      render: (_args, value: ResolveResult) => {
        const lines = [`git resolve ${value.action}: ${value.ok ? '成功' : '失败'}`]
        lines.push(`  ${value.message}`)
        if (value.files !== undefined && value.files.length > 0) lines.push(`涉及文件: ${value.files.join(', ')}`)
        if (value.commit !== undefined) lines.push(`本地 commit: ${value.commit}`)
        if (value.status !== undefined) lines.push(`状态: ${gitStatusBits(value.status)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { strategy: 'keep-local' | 'keep-remote' | 'list'; files?: string[] }, exec: unknown): Promise<ResolveResult> => {
      const dir = deps.wikiPath()
      if (args.strategy === 'list') {
        const status = await deps.git.status(dir)
        return { ok: true, action: 'list', message: '当前仓库状态（pull 冲突已 abort，工作区即本地版本，不会残留未合并状态）', status }
      }
      const files = (args.files ?? []).filter((f) => typeof f === 'string' && f.length > 0)
      if (files.length === 0) {
        return { ok: false, action: args.strategy, message: '请提供 conflictFiles（来自 pull 返回）', hint: '可先执行 tiddlywiki_git_sync action=pull 查看冲突文件' }
      }
      if (args.strategy === 'keep-local') {
        const status = await deps.git.status(dir)
        return {
          ok: true,
          action: 'keep-local',
          message: `已保留本地版本（${files.length} 个文件；abort 后本地即为工作区内容）。建议重新 tiddlywiki_git_sync action=sync 整合远端其余改动。`,
          files,
          status,
        }
      }
      const fetched = await deps.git.fetch(dir)
      if (!fetched.ok) {
        return { ok: false, action: 'keep-remote', message: `fetch 失败（可能未配置 git.remote）：${fetched.message}` }
      }
      const checked = await deps.git.checkoutFetchHead(dir, files)
      if (!checked.ok) {
        return { ok: false, action: 'keep-remote', message: `从远端检出失败：${checked.message}` }
      }
      // Same guard as git_sync: resolving one file may still leave other
      // conflicted files behind — report that instead of throwing (v0.23.4).
      let committed: { committed: boolean; message: string }
      try {
        committed = await deps.git.commit(dir, `resolve conflict (keep remote) ${new Date().toISOString()}`)
      } catch (err) {
        if (err instanceof GitConflictStateError) {
          return { ok: false, action: 'keep-remote', message: err.message, files: err.files }
        }
        throw err
      }
      deps.autoCommit()
      const status = await deps.git.status(dir)
      return {
        ok: true,
        action: 'keep-remote',
        message: `已把 ${files.length} 个冲突文件改为远端版本并提交。建议继续 tiddlywiki_git_sync action=sync 完成整合与推送。`,
        files,
        commit: committed.message,
        status,
      }
    },
  })
}
