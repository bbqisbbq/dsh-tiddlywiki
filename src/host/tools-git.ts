/**
 * Git-facing `tiddlywiki_*` tools: git_sync / git_resolve, plus the shared
 * status + receipt renders they use.
 *
 * v0.30.5 (author's decision, 2026-09-29): `git_sync` syncs **every knowledge
 * base whose effective `git.remote` is set** — once per REPOSITORY (several
 * wikis may share one work tree, and git can only pull/commit/push once per
 * index), each independently (one repo's conflict no longer hides the others'
 * results). Before that it acted on the session's wiki only, so a multi-wiki
 * install could not sync the others from the agent at all — while the receipt
 * was labelled with the session's wiki.
 *
 * Split out of `tools.ts` in v0.28.8 — pure code move, bodies unchanged.
 *
 * @module dsh-tiddlywiki/host/tools-git
 */
import { join } from 'node:path'
import { defineTool } from '../sdk.ts'
import { GitConflictStateError } from './git.ts'
import type { GitStatusView, GitSyncTarget } from './git.ts'
import { flushPendingWrites } from './seeds.ts'
import { sessionIdOf } from './tools-support.ts'
import type { ResolveResult, SyncRepoResult, SyncResult, ToolEnv, ToolsDeps } from './tools-support.ts'

/** One-line 状态 summary: 分支 … 领先 … 落后 … 工作区未提交 … 最近提交. */
function gitStatusBits(s: GitStatusView): string {
  const bits = [`分支 ${s.branch}`]
  if (s.ahead !== undefined) bits.push(`领先 ${s.ahead}`)
  if (s.behind !== undefined) bits.push(`落后 ${s.behind}`)
  if (s.dirty) bits.push(`工作区有 ${s.dirtyFiles.length} 个未提交改动`)
  if (s.lastCommit !== undefined) bits.push(`最近提交 ${s.lastCommit}`)
  return bits.join(' · ')
}

/** How the receipt names one repository ("库 A、B" / "(未登记库)"). */
function repoLabel(repo: SyncRepoResult): string {
  return repo.wikis.length > 0 ? `库 ${repo.wikis.join('、')}` : '(未登记库)'
}

function renderSync(value: SyncResult): Array<{ type: 'text'; text: string }> {
  const lines = [`git ${value.action}: ${value.ok ? '成功' : '失败'}`]
  lines.push(`  ${value.message}`)
  if (value.skipped !== undefined && value.skipped.length > 0) {
    lines.push(`未同步：${value.skipped.join('；')}`)
  }
  for (const repo of value.repos ?? []) {
    lines.push(`- ${repoLabel(repo)} @ ${repo.root}`)
    lines.push(`  ${repo.ok ? '成功' : '失败'}: ${repo.message}`)
    if (repo.conflictFiles !== undefined && repo.conflictFiles.length > 0) {
      lines.push('  冲突文件（rebase 已 abort，勿自动覆盖）:')
      for (const f of repo.conflictFiles) lines.push(`    - ${f}`)
      lines.push('  处理方式：用 tiddlywiki_git_resolve strategy=keep-local|keep-remote files=[以上文件] wiki=<该库的 id> 按 tiddler 二选一解决，再重新 sync；也可以直接让用户处理。')
    }
    if (repo.commit !== undefined) lines.push(`  本地 commit: ${repo.commit}`)
    if (repo.push !== undefined) lines.push(`  远端 push: ${repo.push}`)
    if (repo.changed === true) {
      lines.push(repo.restarted !== undefined && repo.restarted.length > 0
        ? `  本次 pull 拉取了新内容，已重启：${repo.restarted.join('、')}（同端口），其读取/搜索均为最新快照。`
        : '  本次 pull 拉取了新内容，但没有正在运行的知识库受影响（无需重启，或改动落在未运行的库里）。')
    }
    if (repo.restartFailed !== undefined) {
      for (const item of repo.restartFailed) lines.push(`  TW 重启失败：${item.id} —— ${item.message}`)
    }
    if (repo.drainFailed === true) {
      lines.push('  ⚠️ 重启前未能确认 syncer 队列已排干（等待超时）——若刚写过笔记，请先用 tiddlywiki_get 确认它已落盘；必要时再执行一次 tiddlywiki_git_sync。')
    }
    if (repo.status !== undefined) {
      lines.push(`  状态: ${gitStatusBits(repo.status)}`)
      if (repo.status.dirty && repo.status.dirtyFiles.length > 0) lines.push(`    未提交: ${repo.status.dirtyFiles.join(', ')}`)
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Sync ONE repository (pull → maybe restart → commit → push), never throwing:
 * a failure is data for the receipt, because the caller has more repositories
 * to visit and one broken remote must not hide the others.
 */
async function syncOneRepo(
  deps: ToolsDeps,
  group: { root: string; dir: string; targets: GitSyncTarget[] },
  action: 'pull' | 'push' | 'sync',
  message: string | undefined,
  drainFailed: boolean,
): Promise<SyncRepoResult> {
  const base = {
    root: group.root,
    wikis: group.targets.map((t) => t.label),
    wikiIds: group.targets.map((t) => t.id),
    ...(drainFailed ? { drainFailed: true } : {}),
  }
  /**
   * Restart the RUNNING wikis in THIS repository whose content the pull changed.
   *
   * `changedFiles` is what makes this correct with several knowledge bases in one
   * repository: restarting "the wiki I happened to pull from" would miss the one
   * that actually changed, and interrupt a wiki nothing happened to (v0.28.0).
   * The drain itself lives inside each instance's `restart()` (`drainThenStop`),
   * so this path cannot skip it.
   */
  const restartIfChanged = async (pulled: { changed?: boolean; changedFiles?: string[]; changedFilesUnknown?: boolean }): Promise<Partial<SyncRepoResult>> => {
    if (pulled.changed !== true) return {}
    if (deps.restartAffected === undefined) return {}
    try {
      const outcome = await deps.restartAffected(group.dir, pulled.changedFilesUnknown === true ? undefined : pulled.changedFiles ?? [])
      return {
        ...(outcome.restarted.length > 0 ? { restarted: outcome.restarted } : {}),
        ...(outcome.failed.length > 0 ? { restartFailed: outcome.failed } : {}),
      }
    } catch (err) {
      return { restartFailed: [{ id: '(全部)', message: err instanceof Error ? err.message : String(err) }] }
    }
  }
  try {
    if (action === 'push') {
      const pushed = await deps.git.push(group.dir)
      return { ...base, ok: pushed.ok, message: pushed.message, push: pushed.message }
    }
    const pulled = await deps.git.pull(group.dir)
    if (!pulled.ok) {
      return { ...base, ok: false, message: pulled.message, ...(pulled.conflictFiles !== undefined ? { conflictFiles: pulled.conflictFiles } : {}) }
    }
    const restart = await restartIfChanged(pulled)
    if (action === 'pull') {
      return {
        ...base,
        ok: true,
        message: pulled.changed === true ? '已拉取远端改动' : '已是最新（无改动）',
        ...(pulled.changed === true ? { changed: true } : {}),
        ...restart,
      }
    }
    // sync: commit the (possibly just-pulled) tree, then push.
    // The commit guard (v0.23.4) turns a conflicted tree into a structured
    // failure instead of a thrown error: the model must SEE why nothing was
    // committed, otherwise it would report「同步完成」over broken content.
    let committed: { committed: boolean; message: string }
    try {
      committed = await deps.git.commit(group.dir, message ?? `sync ${new Date().toISOString()}`)
    } catch (err) {
      if (err instanceof GitConflictStateError) {
        return { ...base, ok: false, message: err.message, conflictFiles: err.files, ...restart }
      }
      throw err
    }
    const pushed = await deps.git.push(group.dir)
    const status = await deps.git.status(group.dir)
    return {
      ...base,
      ok: pushed.ok,
      message: pushed.ok ? '同步完成' : pushed.message,
      ...(pulled.changed === true ? { changed: true } : {}),
      ...restart,
      commit: committed.message,
      push: pushed.message,
      status,
    }
  } catch (err) {
    return { ...base, ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export function gitSyncTool(env: ToolEnv) {
  const { deps, requireWiki } = env
  // ── tiddlywiki_git_sync ──────────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_git_sync',
    description: '对**所有开启了 git 同步**（配了 `git.remote`）的知识库仓库做同步：pull（拉取远端并 rebase 本地，冲突则 abort 并报文件）、push（推送本地提交到远端）、sync（pull → commit 本地改动 → push）。多个库共用一个仓库时**只同步一次**；每个仓库独立成败（一个仓库冲突不影响其余），回执逐仓库标明「哪个库 @ 哪个仓库」。未配 `git.remote` 或不在 git 仓库里的库会被跳过并在回执里列出。',
    parameters: {
      action: { type: 'string', enum: ['pull', 'push', 'sync'], description: '要执行的 git 操作（作用于每一个可同步的仓库）', required: true },
      message: { type: 'string', description: 'commit 信息（可选，仅 sync 的本地 commit 使用）' },
    },
    output: {
      render: (_args, value: SyncResult) => renderSync(value),
    },
    execute: async (args: { action: 'pull' | 'push' | 'sync'; message?: string }, exec: unknown): Promise<SyncResult> => {
      const action = args.action
      /**
       * "开启了 git 同步" = the wiki's EFFECTIVE `git.remote` is non-empty
       * (v0.30.5). `autoCommit` is deliberately NOT part of the test: turning
       * automatic commits off is not a reason to refuse a manual sync.
       */
      const allTargets = (await deps.gitTargets?.()) ?? []
      const targets = allTargets.filter((t) => t.remote.trim().length > 0)
      const skipped = allTargets
        .filter((t) => t.remote.trim().length === 0)
        .map((t) => `${t.label}（未配 git.remote）`)
      if (targets.length === 0) {
        // ok:false on purpose: `verify-tools.mjs` (and the README) promise that
        // "push with no remote" is a FAILURE, not a silent success.
        return {
          action,
          ok: false,
          message: allTargets.length === 0
            ? '没有已登记的知识库，未执行任何 git 操作。'
            : '没有任何知识库配置了 git.remote（同步远端），未执行任何 git 操作；请在设置页给要同步的库填上远端地址。',
          ...(skipped.length > 0 ? { skipped } : {}),
          repos: [],
        }
      }
      // ONE sync per REPOSITORY: several wikis may live in one work tree, and
      // running pull/commit/push N times over the same index would be wrong
      // (and would fight itself).
      const groups = new Map<string, { root: string; dir: string; targets: GitSyncTarget[] }>()
      for (const t of targets) {
        const root = t.repoRoot ?? t.dir
        const group = groups.get(root)
        if (group === undefined) groups.set(root, { root, dir: t.dir, targets: [t] })
        else group.targets.push(t)
      }
      /**
       * Drain ONCE, for the wiki the caller just wrote to: it is the only queue
       * this tool can reach, and the one at risk from the restarts below (every
       * other running wiki drains inside its own `restart()`).
       */
      let drainFailed = false
      try {
        const sessionDir = deps.wikiPath()
        const drained = await flushPendingWrites(requireWiki(sessionIdOf(exec)), join(sessionDir, 'tiddlers')).catch(() => false)
        if (!drained) drainFailed = true
      } catch {
        drainFailed = true
      }
      const repos: SyncRepoResult[] = []
      for (const group of groups.values()) repos.push(await syncOneRepo(deps, group, action, args.message, drainFailed))

      const failed = repos.filter((r) => !r.ok)
      const ok = failed.length === 0
      const names = repos.map((r) => repoLabel(r)).join('、')
      // Single repository (the overwhelmingly common case): keep the flat
      // aliases populated so one-wiki installs see the pre-v0.30.5 shape.
      const only = repos.length === 1 ? repos[0] : undefined
      return {
        action,
        ok,
        message: ok
          ? `同步完成（${repos.length} 个仓库：${names}）`
          : `${failed.length}/${repos.length} 个仓库失败：${failed.map((r) => `${repoLabel(r)} —— ${r.message}`).join('；')}`,
        ...(skipped.length > 0 ? { skipped } : {}),
        repos,
        ...(only === undefined
          ? {}
          : {
              ...(only.conflictFiles !== undefined ? { conflictFiles: only.conflictFiles } : {}),
              ...(only.commit !== undefined ? { commit: only.commit } : {}),
              ...(only.push !== undefined ? { push: only.push } : {}),
              ...(only.changed === true ? { changed: true } : {}),
              ...(only.restarted !== undefined ? { restarted: only.restarted } : {}),
              ...(only.restartFailed !== undefined ? { restartFailed: only.restartFailed } : {}),
              ...(only.drainFailed === true ? { drainFailed: true } : {}),
              ...(only.status !== undefined ? { status: only.status } : {}),
            }),
      }
    },
  })
}

/**
 * Which folder a `git_resolve` call acts on (v0.30.5).
 *
 * `wiki` picks a registered knowledge base by id (what the `git_sync` receipt
 * prints); omitted → the session's wiki, exactly as before. Without this,
 * resolving a conflict in a repository that is NOT the session's would silently
 * operate on the wrong tree.
 */
async function resolveResolveTarget(
  deps: ToolsDeps,
  wiki: string | undefined,
): Promise<{ dir: string; repo?: string; wikis?: string[] }> {
  const wanted = (wiki ?? '').trim()
  if (wanted.length === 0) return { dir: deps.wikiPath() }
  const targets = (await deps.gitTargets?.()) ?? []
  const key = wanted.toLowerCase()
  const hit = targets.find((t) => t.id.toLowerCase() === key || t.label === wanted)
  if (hit === undefined) {
    throw new Error(`未知的知识库「${wanted}」——先执行 tiddlywiki_git_sync 看可同步的库（回执里「库 … @ <仓库>」那一行给出库 id）`)
  }
  const siblings = targets.filter((t) => (t.repoRoot ?? t.dir) === (hit.repoRoot ?? hit.dir)).map((t) => t.label)
  return { dir: hit.dir, ...(hit.repoRoot !== undefined ? { repo: hit.repoRoot } : {}), wikis: siblings }
}

export function gitResolveTool(env: ToolEnv) {
  const { deps } = env
  // ── tiddlywiki_git_resolve ───────────────────────────────────────────────
  return defineTool({
    name: 'tiddlywiki_git_resolve',
    description: '在 tiddlywiki_git_sync action=pull 冲突（已 abort）后，按 tiddler 二选一解决：keep-local 保留本地版本；keep-remote 用 git fetch 拉取远端并检出远端版本（需已配置 git.remote）；list 仅报告当前状态。多库各有独立仓库时用 `wiki` 指明是哪一个（取 sync 回执里的库 id）。解决后建议重新 pull/sync 整合其余改动。',
    parameters: {
      strategy: { type: 'string', enum: ['keep-local', 'keep-remote', 'list'], description: 'keep-local=保留本地；keep-remote=改用远端版本；list=仅报告当前 git 状态', required: true },
      files: { type: 'array', items: { type: 'string' }, description: '冲突文件名数组（来自 pull 返回的 conflictFiles；list 时忽略）' },
      wiki: { type: 'string', description: '可选：要解决哪一个知识库所在的仓库（传 tiddlywiki_git_sync 回执里的库 id）。不传 = 当前会话作用域的那个库；多库各有独立仓库时**必须传**，否则可能改错仓库。' },
    },
    output: {
      render: (_args, value: ResolveResult) => {
        const lines = [`git resolve ${value.action}: ${value.ok ? '成功' : '失败'}`]
        lines.push(`  ${value.message}`)
        if (value.repo !== undefined) lines.push(`仓库: ${value.repo}${value.wikis !== undefined && value.wikis.length > 0 ? `（库 ${value.wikis.join('、')}）` : ''}`)
        if (value.files !== undefined && value.files.length > 0) lines.push(`涉及文件: ${value.files.join(', ')}`)
        if (value.commit !== undefined) lines.push(`本地 commit: ${value.commit}`)
        if (value.status !== undefined) lines.push(`状态: ${gitStatusBits(value.status)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args: { strategy: 'keep-local' | 'keep-remote' | 'list'; files?: string[]; wiki?: string }, exec: unknown): Promise<ResolveResult> => {
      const target = await resolveResolveTarget(deps, args.wiki)
      const dir = target.dir
      const where = { ...(target.repo !== undefined ? { repo: target.repo } : {}), ...(target.wikis !== undefined ? { wikis: target.wikis } : {}) }
      if (args.strategy === 'list') {
        const status = await deps.git.status(dir)
        return { ok: true, action: 'list', message: '当前仓库状态（pull 冲突已 abort，工作区即本地版本，不会残留未合并状态）', ...where, status }
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
          ...where,
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
        ...where,
        commit: committed.message,
        status,
      }
    },
  })
}
