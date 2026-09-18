/**
 * weixin publish-note-imgs — 多图版发布：笔记正文内嵌的所有图片全部上传微信 CDN
 *
 * 与 publish-note 的差异（为什么需要这个 adapter）：
 *   publish-note 只支持 --cover 单图（先传正文再从正文选封面）。而 TW 笔记正文里
 *   的 [img[...]] 经 /render 会变成 data URI 内嵌在 HTML 里——微信编辑器**不会**
 *   自动把 data URI 图上传 CDN，存草稿时非 mmbiz 图会被过滤，配图全丢。
 *
 * 本命令的流程：
 *   1. /render 取语义 HTML → 数出 data URI 图数量
 *   2. 逐张走「图片→本地上传」DataTransfer 注入（复用 weixin-flow 已验证机制），
 *      编辑器里先落下 N 张 mmbiz 占位图
 *   3. 按 DOM 顺序收集 N 个 CDN src，把装饰后 HTML 里的 data URI src 依序替换
 *   4. insertHTML 写入正文 → 回读校验 → 从正文选封面（第一张即封面）→ 存草稿
 *      → （可选 --publish）点发表等扫码
 *
 * 与 publish-note 一致：发布前读 pub-state / no-publish 元数据，**只告警不阻断**。
 * ⚠️ 已知误报：封面设置成功时流程仍可能打「封面自动设置失败」警告（校验时机太早，
 * 见 weixin-flow.selectCoverFromContent 的轮询修复与 docs §8 排错表）——以草稿箱
 * 实际显示为准。
 *
 * ⚠️ 必须带 --trace retain-on-failure（同 weixin-flow 头注释第 1 条）。
 *
 * 用法：
 *   opencli weixin publish-note-imgs "笔记标题" --images <目录|a.png|b.png|...> \
 *     --trace retain-on-failure -f json [--publish] [--summary "..."] [--author "..."]
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
    IMAGE_MENU_TRIGGER,
    IMAGE_LOCAL_LABEL,
    FILE_INPUT_SELECTOR,
    navigateToEditor,
    fillField,
    insertRichHtml,
    verifyContent,
    countCdnImages,
    selectCoverFromContent,
    saveDraft,
    publishDraft,
    requireFile,
    mimeOf,
    MAX_IMAGE_BYTES,
    resolveNoteTitle,
} from './weixin-flow.js';
import { extractBody, decorate, wrapForPreview } from './wechat-html.js';

const DEFAULT_DSN = 'http://127.0.0.1:3080/dsh-tiddlywiki';

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
        throw new EmptyResultError('weixin publish-note-imgs', `wiki 里找不到笔记「${title}」`);
    }
    if (!resp.ok) {
        throw new CommandExecutionError(`/render 返回 HTTP ${resp.status}（DSH 是否在运行？）`);
    }
    return resp.text();
}

/** 从 DSH 的 /get 读 tiddler 元数据（含自定义字段 → 发布状态）。读不到不抛错——元数据是辅助信息，不阻断发布。 */
async function fetchNoteMeta(dsn, title) {
    const url = `${String(dsn).replace(/\/+$/, '')}/get?title=${encodeURIComponent(title)}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!data || data.ok !== true) return null;
        return data;
    } catch {
        return null;
    }
}

/**
 * 发布前检查既有发布状态——与 publish-note 同策略：**只告警、不阻断**。
 * 字段规范见 wiki「发布元数据规范」。
 */
function checkPublishState(meta, noteTitle, force) {
    if (!meta) return { warnings: [], state: '' };
    const fields = meta.fields || {};
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    const state = String(fields['pub-state'] || '').trim().toLowerCase();
    const warnings = [];

    if (state === 'published') {
        const platform = String(fields['pub-platform'] || '').trim();
        const at = String(fields['pub-wechat-at'] || '').trim();
        const url = String(fields['pub-wechat-url'] || '').trim();
        const via = [platform && `平台 ${platform}`, at && `时间 ${at}`, url && `链接 ${url}`]
            .filter(Boolean).join(' · ');
        if (force) {
            warnings.push(`「${noteTitle}」已发布过（${via || '无细节'}），本次带 --force 强制重发。`);
        } else {
            warnings.push(
                `⚠️ 「${noteTitle}」**已发布过**（${via || '无细节'}）。`
                + '这可能是重复发布——确认无误再继续；确实要重发请加 --force（仅作标记）。',
            );
        }
    }

    if (state === 'excluded' || tags.includes('no-publish')) {
        const why = String(fields['pub-note'] || '').trim();
        warnings.push(
            `⚠️ 「${noteTitle}」被标记为**不可发布**（${state === 'excluded' ? 'pub-state: excluded' : ''}`
            + `${state === 'excluded' && tags.includes('no-publish') ? ' + ' : ''}`
            + `${tags.includes('no-publish') ? 'no-publish 标签' : ''}）${why ? `。备注：${why}` : ''}。`,
        );
    }

    return { warnings, state };
}

/** 把警示打到 stderr（不阻断）。 */
function emitWarnings(warnings) {
    if (warnings.length === 0) return;
    process.stderr.write('\n' + warnings.join('\n') + '\n\n');
}

/** --images 参数：目录 → 取其中图片按文件名排序；否则按 | 分隔的路径列表。 */
function resolveImagePaths(spec) {
    const raw = String(spec || '').trim();
    if (!raw) throw new ArgumentError('--images 不能为空（传图片目录，或用 | 分隔的路径列表）');
    let paths;
    if (fs.existsSync(raw) && fs.statSync(raw).isDirectory()) {
        paths = fs.readdirSync(raw)
            .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
            .sort()
            .map((f) => path.join(raw, f));
    } else {
        paths = raw.split('|').map((s) => s.trim()).filter(Boolean);
    }
    if (paths.length === 0) throw new ArgumentError(`--images 没有解析出任何图片：${raw}`);
    if (paths.length > 20) throw new ArgumentError(`图片数量过多（${paths.length} > 20），请分批发布`);
    return paths.map((p) => requireFile(p, '正文图片'));
}

/** 数出 HTML 正文里的 data URI 图数量。 */
function countDataUriImages(html) {
    const re = /<img\b[^>]*?\bsrc=["']data:image\//gi;
    let n = 0;
    while (re.exec(String(html || '')) !== null) n += 1;
    return n;
}

/** 把装饰后 HTML 里的 data URI src 依序替换为 CDN 地址。 */
function rewriteDataUriSrcs(html, cdnSrcs) {
    let i = 0;
    const out = String(html).replace(
        /(<img\b[^>]*?\bsrc=)(["'])data:image\/[a-z+]+;base64,[^"']*\2/gi,
        (whole, head, quote) => {
            const src = cdnSrcs[i];
            i += 1;
            if (!src) return whole; // 不够就用原样（外层已校验数量一致）
            return `${head}${quote}${src}${quote}`;
        },
    );
    return { html: out, replaced: i };
}

/** 单张图上传（DataTransfer 注入），并轮询等待 CDN 图片数达到 expectCount。 */
async function uploadOne(page, imagePath, expectCount) {
    const absPath = requireFile(imagePath, '图片');
    const size = fs.statSync(absPath).size;
    if (size > MAX_IMAGE_BYTES) {
        throw new ArgumentError(
            `图片过大（${(size / 1048576).toFixed(1)}MB > 8MB）：${absPath}`,
        );
    }

    await page.evaluate(`(() => {
        var li = document.querySelector(${JSON.stringify(IMAGE_MENU_TRIGGER)});
        if (li) li.click();
    })()`);
    await page.wait(1);
    const opened = await page.evaluate(`(() => {
        var items = document.querySelectorAll('.tpl_dropdown_menu_item');
        for (var i = 0; i < items.length; i++) {
            if ((items[i].innerText || '').trim() === ${JSON.stringify(IMAGE_LOCAL_LABEL)}) { items[i].click(); return true; }
        }
        return false;
    })()`);
    if (!opened) throw new CommandExecutionError('找不到「本地上传」菜单项（后台可能改版）');
    await page.wait(2);

    const b64 = fs.readFileSync(absPath).toString('base64');
    const injected = await page.evaluate(`(() => {
        var input = document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)})
                 || document.querySelector('input[type="file"]');
        if (!input) return { ok: false, reason: 'file input not found' };
        var bin = atob(${JSON.stringify(b64)});
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var file = new File([arr], ${JSON.stringify(path.basename(absPath))}, { type: ${JSON.stringify(mimeOf(absPath))} });
        var dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
    })()`);
    if (!injected || !injected.ok) {
        throw new CommandExecutionError(`注入图片失败：${injected ? injected.reason : 'unknown'}`);
    }

    // 轮询等 CDN 计数达到期望值（多图场景必须比期望数比较，不能用 >0）
    for (let attempt = 0; attempt < 20; attempt++) {
        await page.wait(2);
        const n = await countCdnImages(page);
        if (n >= expectCount) return n;
    }
    throw new CommandExecutionError(
        `图片未上传成功（等待后 CDN 图片数未达到 ${expectCount}）：${path.basename(absPath)}`,
    );
}

/** 按 DOM 顺序收集编辑器里的 mmbiz 图 src。 */
async function collectCdnSrcs(page) {
    const raw = await page.evaluate(`(() => {
        var editor = document.querySelector('#ueditor_0') || document.querySelector('.ProseMirror');
        if (!editor) return '[]';
        var imgs = editor.querySelectorAll('img');
        var out = [];
        for (var i = 0; i < imgs.length; i++) {
            var s = imgs[i].getAttribute('src') || '';
            if (s.indexOf('mmbiz') >= 0) out.push(s);
        }
        return JSON.stringify(out);
    })()`);
    try { return JSON.parse(raw) || []; } catch { return []; }
}

cli({
    site: 'weixin',
    name: 'publish-note-imgs',
    access: 'write',
    description: '多图版：TW 笔记正文内嵌图片全部上传 CDN 后发布到公众号草稿箱（可选发表）',
    domain: WEIXIN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        // 位置参数与 --title-file 二选一（都传则位置参数优先）。宿主按钮走
        // --title-file：标题不进 argv，见 weixin-flow.resolveNoteTitle 的注释。
        { name: 'title', required: false, positional: true, help: 'TiddlyWiki 笔记标题（tiddler 标题；与 --title-file 二选一）' },
        { name: 'titleFile', help: '从 UTF-8 文本文件读取标题（供宿主进程调用，避免标题进 argv）' },
        { name: 'dsn', default: DEFAULT_DSN, help: `DSH 知识库地址（默认 ${DEFAULT_DSN}）` },
        { name: 'images', required: true, help: '图片目录（按文件名排序），或用 | 分隔的图片路径列表，顺序=正文出现顺序' },
        { name: 'author', help: '公众号作者名（限 8 字）' },
        { name: 'summary', help: '摘要（默认抓正文前 100 字；限 120 字）' },
        { name: 'no-cover', type: 'bool', default: false, help: '不设封面（默认从正文第一张图设封面）' },
        { name: 'publish', type: 'bool', default: false, help: '保存后直接点「发表」（需管理员扫码）' },
        { name: 'preview', default: '', help: '把装饰后的 HTML 写到该路径（+ .html）以便本地预览' },
        { name: 'force', type: 'bool', default: false, help: '已知这篇发过时仍继续（仅影响告警措辞）' },
        { name: 'timeout', type: 'int', default: 180, help: '发表等待扫码的秒数（默认 180）' },
    ],
    columns: ['status', 'title', 'detail'],

    func: async (page, kwargs) => {
        const noteTitle = resolveNoteTitle(kwargs.title, kwargs.titleFile);

        // ── 1. 取渲染 HTML 与图片清单 ──
        const rendered = await fetchRendered(kwargs.dsn || DEFAULT_DSN, noteTitle);
        const body = extractBody(rendered);
        if (!body.trim()) throw new EmptyResultError('weixin publish-note-imgs', `笔记「${noteTitle}」正文为空`);

        // 发布前检查（只告警、不阻断；与 publish-note 同策略）
        const meta = await fetchNoteMeta(kwargs.dsn || DEFAULT_DSN, noteTitle);
        const { warnings } = checkPublishState(meta, noteTitle, kwargs.force === true);
        emitWarnings(warnings);

        const imagePaths = resolveImagePaths(kwargs.images);
        const dataUriCount = countDataUriImages(body);
        if (dataUriCount === 0) {
            throw new EmptyResultError('weixin publish-note-imgs', '正文里没有 data URI 内嵌图——普通笔记请用 publish-note');
        }
        if (dataUriCount !== imagePaths.length) {
            throw new ArgumentError(
                `图片数量不一致：正文内嵌 ${dataUriCount} 张，--images 提供 ${imagePaths.length} 张。`
                + '顺序必须与正文出现顺序一致（封面在前）。',
            );
        }

        const html = decorate(body);
        if (kwargs.preview) {
            const outPath = path.resolve(`${kwargs.preview}.html`);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, wrapForPreview(html, noteTitle), 'utf8');
            process.stderr.write(`预览已写出：${outPath}\n`);
        }

        const title = noteTitle.length > 64 ? noteTitle.slice(0, 64) : noteTitle;
        const author = kwargs.author ? String(kwargs.author).trim() : '';
        if (author.length > 8) throw new ArgumentError(`作者名超长（${author.length} > 8 字）`);
        const textOf = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        let summary = kwargs.summary ? String(kwargs.summary).trim() : textOf(html).slice(0, 100);
        if (summary.length > 120) summary = summary.slice(0, 120);

        // ── 2. 进编辑器，填标题/摘要 ──
        await navigateToEditor(page);
        await fillField(page, TITLE_SELECTORS, title, '标题');
        if (author) await fillField(page, AUTHOR_SELECTORS, author, '作者');
        if (summary) await fillField(page, SUMMARY_SELECTORS, summary, '摘要');

        // ── 3. 先把 N 张图全部传 CDN（编辑器里落成 mmbiz 占位）──
        for (let i = 0; i < imagePaths.length; i++) {
            process.stderr.write(`上传图片 ${i + 1}/${imagePaths.length}：${path.basename(imagePaths[i])}\n`);
            await uploadOne(page, imagePaths[i], i + 1);
        }

        // ── 4. 收集 CDN src，重写正文 HTML，写入 ──
        const cdnSrcs = await collectCdnSrcs(page);
        if (cdnSrcs.length !== imagePaths.length) {
            throw new CommandExecutionError(
                `CDN 图数量不符：编辑器里 ${cdnSrcs.length} 张，期望 ${imagePaths.length} 张——中止写入，避免配图错乱`,
            );
        }
        const { html: finalHtml, replaced } = rewriteDataUriSrcs(html, cdnSrcs);
        if (replaced !== imagePaths.length) {
            throw new CommandExecutionError(`data URI 替换数量不符（${replaced} != ${imagePaths.length}）`);
        }

        await insertRichHtml(page, finalHtml);
        const contentLength = await verifyContent(page, textOf(body));

        // ── 5. 封面（正文第一张 = 封面图）→ 存草稿 → 可选发表 ──
        let coverSet = false;
        if (!kwargs['no-cover']) {
            coverSet = await selectCoverFromContent(page);
            if (!coverSet) {
                process.stderr.write('⚠️ 封面自动设置失败——草稿会显示「不完整」，可到后台手动设置封面\n');
            }
        }

        await page.wait(1);
        await saveDraft(page);

        let published = false;
        if (kwargs.publish === true) {
            published = await publishDraft(page, Number(kwargs.timeout) || 180);
        }

        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
            + `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const writebackHint = '建议回写：'
            + `pub-state=published, pub-platform=wechat, pub-wechat-at="${stamp}"`
            + (title !== noteTitle ? `, pub-wechat-title="${title}"` : '');

        return [{
            status: published ? '已发表' : '草稿已保存',
            title,
            detail: [
                warnings.length > 0 ? `⚠️ ${warnings.length} 条发布前警告` : null,
                `正文 ${contentLength} 字 · 图片 ${imagePaths.length} 张已上传 CDN`,
                kwargs['no-cover'] ? '未设封面' : (coverSet ? '封面已设置（正文第一张）' : '封面未设置'),
                published ? '已发表' : '已存草稿',
                writebackHint,
            ].filter(Boolean).join(' · '),
        }];
    },
});
