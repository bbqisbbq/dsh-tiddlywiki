/**
 * seed-publish-spec-now.mts — 把「发布元数据规范」立即写进当前 wiki
 *
 * 为什么需要它：seed 是**插件启动时**注册的，而注入提示词里的
 * `[[发布元数据规范]]` 指针在 lib/ 重建后就已生效。若不先把文档写进 wiki，
 * 那条链接就是死链（`tiddlywiki_lint` 会报，用户点进去是空白）。
 *
 * 本脚本 import 的常量与 seed 实现**同源**（src/host/seed-publish-spec.ts），
 * 因此写出的内容与将来 seed 启动时写的逐字节一致；同时**连标记一起写**，
 * 后续启动的 ONE-SHOT 检查会认为「已初始化」而跳过，不会覆盖用户改动。
 *
 * 用法（在仓库根目录）：
 *   npx tsx tools/wechat/seed-publish-spec-now.mts
 */
import { PUBLISH_SPEC_TITLE, PUBLISH_SPEC_MARKER_TITLE, PUBLISH_SPEC_TEXT } from '../../src/host/seed-publish-spec.ts'
import { hashText, SEED_MARKER_VERSION } from '../../src/host/seed-util.ts'

const DSN = (process.env.DSH_TW_DSN ?? 'http://127.0.0.1:3080/dsh-tiddlywiki').replace(/\/+$/, '')

/** 经 DSH 的 /api 代理写入（等价于插件内部走 TiddlyWebClient）。 */
async function put(tiddler: Record<string, unknown>): Promise<void> {
  const url = `${DSN}/api/recipes/default/tiddlers/${encodeURIComponent(String(tiddler.title))}`
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tiddler),
  })
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`写入「${tiddler.title}」失败：HTTP ${resp.status}`)
  }
}

async function exists(title: string): Promise<boolean> {
  const resp = await fetch(`${DSN}/api/recipes/default/tiddlers/${encodeURIComponent(title)}`, {
    headers: { Accept: 'application/json' },
  })
  return resp.ok
}

async function main() {
  console.log(`DSN: ${DSN}`)

  if (await exists(PUBLISH_SPEC_MARKER_TITLE)) {
    console.log(`已有标记 ${PUBLISH_SPEC_MARKER_TITLE}——说明 seed 已跑过，跳过（不覆盖用户改动）。`)
    return
  }

  const docExists = await exists(PUBLISH_SPEC_TITLE)
  console.log(`文档是否已存在: ${docExists ? '是（将覆盖为规范原文）' : '否（新建）'}`)

  await put({
    title: PUBLISH_SPEC_TITLE,
    text: PUBLISH_SPEC_TEXT,
    tags: ['dsh-docs', 'dsh-tiddlywiki'],
    type: 'text/markdown',
  })
  console.log(`✔ 已写 ${PUBLISH_SPEC_TITLE}（${PUBLISH_SPEC_TEXT.length} 字符）`)

  // 标记格式与 writeSeedMarker 一致：{version, hashes, at}
  await put({
    title: PUBLISH_SPEC_MARKER_TITLE,
    text: JSON.stringify({
      version: SEED_MARKER_VERSION,
      hashes: { [PUBLISH_SPEC_TITLE]: hashText(PUBLISH_SPEC_TEXT) },
      at: new Date().toISOString(),
    }),
    type: 'application/json',
    tags: [],
  })
  console.log(`✔ 已写标记 ${PUBLISH_SPEC_MARKER_TITLE}`)
  console.log('\n完成。提示词里的 [[发布元数据规范]] 现在可点。')
}

main().catch((err) => {
  console.error(`出错：${err?.message || err}`)
  process.exit(1)
})
