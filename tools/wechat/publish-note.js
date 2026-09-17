/**
 * weixin publish-note — **一条命令**：TiddlyWiki 笔记 → 微信公众号草稿（可选发表）
 *
 * 这是整套流程的主入口。设计目标：在**另一台机器**上只要 DSH + wiki 就位，
 * 一条命令即可把某篇笔记发到公众号草稿箱。
 *
 * 数据流：
 *   tiddler 标题
 *     → DSH 的 /render 取 TW 渲染好的**语义 HTML**（TW 已解析 Markdown + 代码高亮）
 *     → wechat-html.decorate 补内联样式（微信只认内联，会剥 <style>/class）
 *     → weixin-flow 驱动后台：填标题/作者/摘要 + 写入正文 + 传图 + 设封面 + 存草稿
 *     → （可选 --publish）点「发表」，等管理员扫码
 *
 * 前置（另一台机器要装的，见 docs/wechat-publish-setup.md）：
 *   1. opencli（npm i -g @jackwener/opencli）
 *   2. Browser Bridge 扩展（Chrome Web Store 或 GitHub Releases 的 zip）
 *   3. 浏览器登录 mp.weixin.qq.com
 *   4. 本目录的 adapter 复制到 ~/.opencli/clis/weixin/
 *
 * ⚠️ 必须带 `--trace retain-on-failure`（否则 Navigation rejected，见 flow 头注释）。
 *
 * 用法：
 *   opencli weixin publish-note "笔记标题" \
 *     --dsn http://127.0.0.1:3080/dsh-tiddlywiki \
 *     --trace retain-on-failure -f json
 *
 *   # 封面用本机图片
 *   opencli weixin publish-note "笔记标题" --cover ./cover.png -f json
 *
 *   # 直接发表（需管理员扫码）
 *   opencli weixin publish-note "笔记标题" --publish -f json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import {
    WEIXIN_DOMAIN,
    TITLE_SELECTORS,
    AUTHOR_SELECTORS,
    SUMMARY_SELECTORS,
    navigateToEditor,
    fillField,
    insertRichHtml,
    verifyContent,
    uploadContentImage,
    selectCoverFromContent,
    saveDraft,
    publishDraft,
    requireFile,
} from './weixin-flow.js';
import { extractBody, decorate, wrapForPreview } from './wechat-html.js';

const DEFAULT_DSN = 'http://127.0.0.1:3080/dsh-tiddlywiki';

/**
 * 从 DSH 的 /render 取 TW 渲染好的 HTML。
 * @param {string} dsn 形如 http://127.0.0.1:3080/dsh-tiddlywiki
 * @param {string} title tiddler 标题
 */
async function fetchRendered(dsn, title) {
    const url = `${String(dsn).replace(/\/+$/, '')}/render`;
    let resp;
    try {
        resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title }),
        });
    } catch (error) {
        throw new CommandExecutionError(`无法连接 DSH（${url}）：${error?.message || error}`);
    }
    if (resp.status === 404) {
        throw new EmptyResultError('weixin publish-note', `wiki 里找不到笔记「${title}」`);
    }
    if (!resp.ok) {
        throw new CommandExecutionError(`/render 返回 HTTP ${resp.status}（DSH 是否在运行？）`);
    }
    return resp.text();
}

/** 从 HTML 第一段文字里推摘要（后台限 120 字）。 */
function deriveSummary(html) {
    const text = String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
    return text.slice(0, 100);
}

cli({
    site: 'weixin',
    name: 'publish-note',
    access: 'write',
    description: '把 TiddlyWiki 笔记一键发布到微信公众号草稿箱（可选直接发表）',
    domain: WEIXIN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'title', required: true, positional: true, help: 'TiddlyWiki 笔记标题（tiddler 标题）' },
        { name: 'dsn', default: DEFAULT_DSN, help: `DSH 知识库地址（默认 ${DEFAULT_DSN}）` },
        { name: 'author', help: '公众号作者名（默认取笔记的 author 字段；限 8 字）' },
        { name: 'summary', help: '摘要（默认抓正文前 100 字；限 120 字）' },
        { name: 'cover', help: '封面图片本地路径（留空则无封面，草稿会显示不完整）' },
        { name: 'publish', type: 'bool', default: false, help: '保存后直接点「发表」（需管理员扫码）' },
        { name: 'preview', default: '', help: '把装饰后的 HTML 写到该路径（+ .html）以便本地预览' },
        { name: 'timeout', type: 'int', default: 180, help: '发表等待扫码的秒数（默认 180）' },
    ],
    columns: ['status', 'title', 'detail'],

    func: async (page, kwargs) => {
        const noteTitle = String(kwargs.title || '').trim();
        if (!noteTitle) throw new ArgumentError('笔记标题不能为空');

        // ── 1. 取 TW 渲染的语义 HTML ──
        const rendered = await fetchRendered(kwargs.dsn || DEFAULT_DSN, noteTitle);
        const body = extractBody(rendered);
        if (!body.trim()) throw new EmptyResultError('weixin publish-note', `笔记「${noteTitle}」正文为空`);

        // ── 2. 装饰：补内联样式（微信唯一认的形式）──
        const html = decorate(body);

        // 可选：导出预览，方便在浏览器里肉眼确认排版
        if (kwargs.preview) {
            const outPath = path.resolve(`${kwargs.preview}.html`);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, wrapForPreview(html, noteTitle), 'utf8');
            process.stderr.write(`预览已写出：${outPath}\n`);
        }

        // ── 3. 参数校验（后台限制）──
        const title = noteTitle.length > 64 ? noteTitle.slice(0, 64) : noteTitle;
        const author = kwargs.author ? String(kwargs.author).trim() : '';
        if (author.length > 8) throw new ArgumentError(`作者名超长（${author.length} > 8 字）`);
        let summary = kwargs.summary ? String(kwargs.summary).trim() : deriveSummary(html);
        if (summary.length > 120) summary = summary.slice(0, 120);

        // ── 4. 驱动微信后台 ──
        await navigateToEditor(page);
        await fillField(page, TITLE_SELECTORS, title, '标题');
        if (author) await fillField(page, AUTHOR_SELECTORS, author, '作者');
        if (summary) await fillField(page, SUMMARY_SELECTORS, summary, '摘要');

        await insertRichHtml(page, html);
        const contentLength = await verifyContent(page, body.replace(/<[^>]*>/g, ' ').trim());

        let imageCount = 0;
        let coverSet = false;
        if (kwargs.cover) {
            imageCount = await uploadContentImage(page, requireFile(kwargs.cover, '封面图片'));
            coverSet = await selectCoverFromContent(page);
            if (!coverSet) {
                throw new CommandExecutionError(
                    '封面图已上传正文，但「从正文选择」设封面失败。请手动到后台设置封面。',
                );
            }
        }

        await page.wait(1);
        await saveDraft(page);

        let published = false;
        if (kwargs.publish === true) {
            published = await publishDraft(page, Number(kwargs.timeout) || 180);
        }

        const detail = [
            `正文 ${contentLength} 字`,
            imageCount > 0 ? `图片 ${imageCount} 张` : null,
            kwargs.cover ? (coverSet ? '封面已设置' : '封面未设置') : '无封面（草稿会显示不完整）',
            published ? '已发表' : '已存草稿',
        ].filter(Boolean).join(' · ');

        return [{
            status: published ? '已发表' : '草稿已保存',
            title,
            detail,
        }];
    },
});
