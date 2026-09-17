/**
 * Optional seed: 「发布元数据规范」doc tiddler (hand-maintained constant, like
 * seed-clip-bridge / seed-starter-docs — no generator script).
 *
 * WHAT & WHY (v0.23.0): the wiki holds both articles already published elsewhere
 * and articles that must never be published. Without per-note metadata an agent
 * cannot tell them apart — it would either re-publish something already live or
 * push something the user deliberately excluded. This doc is the single source
 * of truth for those fields; the injected system prompt only carries a one-line
 * POINTER to it (the slim prompt had just 66 characters of headroom left, so the
 * full spec cannot live there).
 *
 * ⚠️ NAMING COLLISIONS AVOIDED (verified against the live wiki, 2026-09-17):
 *   - `publish` / `publishyear` are ALREADY TAKEN by Obsidian-imported book
 *     notes, where they mean 出版社 / 出版年 ("新世界出版社", "2011-09-01").
 *   - the tag `发布记录` is ALREADY TAKEN by this plugin's own release notes.
 *   Both are therefore off-limits; this spec uses the `pub-*` namespace, which
 *   matches the plugin's existing kebab-case custom fields (clip-url / attach-at).
 *
 * @module dsh-tiddlywiki/host/seed-publish-spec
 */
import type { TiddlyWebClient } from './tw-api.ts'
import { readSeedTiddler, writeSeedMarker, hashText } from './seed-util.ts'

/** The spec tiddler's title (a normal, searchable note; also the pointer target). */
export const PUBLISH_SPEC_TITLE = '发布元数据规范'

/** One-time marker: presence = "the doc was offered once — hands off". */
export const PUBLISH_SPEC_MARKER_TITLE = '$:/dsh-tiddlywiki/publish-spec-seeded'

/**
 * The doc body. Markdown (the plugin's default note type). Kept deliberately
 * concrete: an agent must be able to pick the right field without guessing.
 */
export const PUBLISH_SPEC_TEXT = `# 发布元数据规范

> 用途：记录每篇笔记**对外发布的状态**，让 agent 在发布前能判断「这篇发过没有 / 能不能发」。
> 由 \`tools/wechat/\` 的发布流程使用；插件与 agent 都以此文件为唯一事实来源。

## 为什么需要它

wiki 里既有**早已发到公众号**的文章，也有**明确不能发**的内容（草稿、私事、未定稿）。
没有这层元数据，agent 只能靠猜——要么重复发布已上线的文章，要么把不该发的推出去。

## 字段（自定义字段，不是标签）

按**平台分字段**，便于将来加平台（\`pub-zhihu-*\`、\`pub-juejin-*\` 直接平铺）：

| 字段 | 含义 | 取值示例 |
|---|---|---|
| \`pub-state\` | 能不能发 | \`draft\`（未发，可发）/ \`published\`（已发）/ \`excluded\`（明确不发） |
| \`pub-platform\` | 最近发布的平台（多平台用逗号） | \`wechat\` 或 \`wechat,zhihu\` |
| \`pub-wechat-at\` | 公众号发表时间 | \`2026-09-17 15:30\` |
| \`pub-wechat-title\` | **发表时用的标题**（仅在和 TW 标题不同才写） | \`中年失业自救指南\` |
| \`pub-wechat-url\` | 发表后的链接 | \`https://mp.weixin.qq.com/s/xxx\` |
| \`pub-note\` | 备注（人看的补充说明） | \`删改后重发过一版\` |

**没有 \`pub-state\` 的条目 = 未知状态**。agent 应当把它当作「需要人确认」，而不是「可以随便发」。

## 标签（给人看的镜像）

\`\`\`
no-publish   ← 明确不可发布（与 pub-state: excluded 保持一致）
\`\`\`

标签的好处是 TW 界面里一眼可见、可点进去列出全部不可发条目；
\`pub-state\` 则是给 agent 程序化判断用的。**两者应保持一致**——如果只改一个，以字段为准。

## agent 的发布前检查（约定）

发布前**按顺序**做三件事：

1. 读 \`pub-state\`：是 \`published\` → **默认不重发**，除非用户明确要求或带 \`--force\`。
2. 看 \`no-publish\` 标签 / \`pub-state: excluded\` → **提醒用户这篇被标为不可发**。
3. 都通过 → 发布。

⚠️ **当前策略是「只告警，不阻断」**：adapter 发现上述情况会打印醒目警告并继续执行，
由用户/agent 决定是否中止。**不要**把警告当失败。

## 发布后回写（agent 负责）

发布成功后，agent 用 \`tiddlywiki_put\` 把这几个字段写回该笔记：

\`\`\`
pub-state: published
pub-platform: wechat
pub-wechat-at: <发表时间，从 adapter 输出或当前时间取>
pub-wechat-title: <仅当与 TW 标题不同时>
pub-wechat-url: <若能拿到>
\`\`\`

⚠️ \`tiddlywiki_put\` 覆盖时**不传 \`tags\` 就保留原标签**、只补 \`fields\` 里的自定义字段，
所以回写不会动到既有标签与正文。

## 存量回填

早于本规范、来源可辨的公众号文章，用 \`source-path\` 判定：路径含 \`公众号\` 的
（如 \`Articles\\公众号\\杂七杂八\\打工记.md\`）即视为已发布，回填：

\`\`\`
pub-state: published
pub-platform: wechat
\`\`\`

发表时间若无法考证就**留空**——不要编造时间。

## 相关

- 发布工具与安装说明见仓库 \`tools/wechat/\` 与 \`docs/wechat-publish-setup.md\`
- 设计依据见 \`docs/plans/2026-09-17-wechat-publish-design.md\`

> 本文档属于**可选功能**：只有设置页开启「微信公众号发布」（\`wechat.enabled\`）时，
> 插件才会在启动时写入它；关闭时不写、也不注入任何发布相关提示词。
> 因此「打开设置开关」与「本文档存在」应当是同进同退的。
`

/** Write the doc + marker (ONE-SHOT when \`force\` is false). */
export async function seedPublishSpec(client: TiddlyWebClient, opts?: { force?: boolean }): Promise<boolean> {
  const force = opts?.force === true
  if (!force) {
    const existing = await readSeedTiddler(client, PUBLISH_SPEC_MARKER_TITLE)
    if (existing !== undefined) return false
  }
  await client.put({
    title: PUBLISH_SPEC_TITLE,
    text: PUBLISH_SPEC_TEXT,
    tags: ['dsh-docs', 'dsh-tiddlywiki'],
    type: 'text/markdown',
  })
  await writeSeedMarker(client, PUBLISH_SPEC_MARKER_TITLE, { [PUBLISH_SPEC_TITLE]: hashText(PUBLISH_SPEC_TEXT) })
  return true
}

/** Remove the doc + marker (反初始化). */
export async function unseedPublishSpec(client: TiddlyWebClient): Promise<{ removed: string[] }> {
  const removed: string[] = []
  for (const title of [PUBLISH_SPEC_TITLE, PUBLISH_SPEC_MARKER_TITLE]) {
    try {
      await client.delete(title)
      removed.push(title)
    } catch {
      // 删除不存在的条目按幂等处理（与 seed-clip-bridge 一致）
    }
  }
  return { removed }
}
