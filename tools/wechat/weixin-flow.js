/**
 * weixin-flow — 微信公众号后台自动化的共享流程（浏览器驱动）
 *
 * 被 create-article.js 与 publish-note.js 共用。所有 DOM 选择器与微信后台的
 * 怪癖都集中在这里，改版时只需改这一个文件。
 *
 * ── 实测依据（2026-09-17，CLI 1.8.7 + Browser Bridge v1.0.24 + Edge）──────
 *
 * 1. **必须带 `--trace retain-on-failure`**：无 trace 时对 mp.weixin.qq.com
 *    稳定报 "Navigation rejected"（trace 开 5/5 成功，关 8/8 失败）。这是
 *    opencli 1.8.7 的 bug，调用方命令行必须带上，本模块无法代为修复。
 *
 * 2. **正文写入用 `execCommand('insertHTML')`**，不能用 `insertText`。编辑器
 *    是 ProseMirror；insertHTML 保留内联样式，insertText 会把 HTML 当字面文本
 *    （内置 create-draft 的正文就是这样，Markdown 符号原样进库）。
 *
 * 3. **图片上传用 DataTransfer 注入，不能用 `page.setFileInput`**：后者依赖
 *    CDP `Page.fileChooserOpened`，本机稳定失败（`Page.fileChooserOpened not
 *    received within 5s`）。DataTransfer 在页面上下文直接塞 input.files 并派发
 *    change，实测图片真进 mmbiz CDN。代价：字节 base64 过 evaluate → 限 8MB。
 *
 * 4. **回读校验必须忽略所有空白**：编辑器 innerText 会在块级元素间插空白、
 *    把空格转 nbsp，直接比对原始字符串会假阴性（踩过）。
 *
 * 5. 草稿列表显示「图文内容不完整」只表示**缺封面**，不代表写入失败。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArgumentError, AuthRequiredError, CommandExecutionError, TimeoutError } from '@jackwener/opencli/errors';

export const WEIXIN_DOMAIN = 'mp.weixin.qq.com';
export const WEIXIN_HOME = 'https://mp.weixin.qq.com/';

// ── 选择器（按稳定性排序：id/class 优先，文案兜底）────────────────────────

// 正文编辑器。实测编辑器页有 3 个 contenteditable，正文是**最后一个**；
// #ueditor_0 是历史版本的容器，新版是 .ProseMirror，两者都匹配时取最后一个。
export const EDITOR_SELECTORS = [
    '#ueditor_0 div[contenteditable="true"]',
    '.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"]',
];

export const TITLE_SELECTORS = ['textarea#title', 'input#title', '#title'];
export const AUTHOR_SELECTORS = ['input#author', '#author'];
export const SUMMARY_SELECTORS = ['textarea#js_description', '#js_description'];

// 「图片」下拉的触发元素
export const IMAGE_MENU_TRIGGER = '#js_editor_insertimage';
// 下拉里的「本地上传」——**必须按文案点**：实测 items[0] 点完 file input 仍不可见
export const IMAGE_LOCAL_LABEL = '本地上传';
export const FILE_INPUT_SELECTOR = 'input[type="file"][name="file"]';

// 保存草稿（class 优先；文案兜底**特意不含「发表/发布」**，防误点发布）
export const SAVE_BUTTON_SELECTORS = [
    'span.btn.btn_input.btn_primary.r',
    'button.js_save_draft',
];
export const SAVE_LABELS = ['保存为草稿', '保存草稿', '保存'];

// 发表
export const PUBLISH_SELECTORS = [
    'span.btn.btn_input.btn_default.r',
    'button.mass_send',
];

// 封面
export const COVER_AREA = '#js_cover_description_area';
export const COVER_BUTTON_AREA = '.js_cover_btn_area';

/** 单图上限：DataTransfer 需把字节 base64 穿过 evaluate。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// ── 基础工具 ──────────────────────────────────────────────────────────────

export function requireFile(filePath, label) {
    const resolved = path.resolve(String(filePath));
    if (!fs.existsSync(resolved)) throw new ArgumentError(`${label}不存在: ${resolved}`);
    if (!fs.statSync(resolved).isFile()) throw new ArgumentError(`${label}不是文件: ${resolved}`);
    return resolved;
}

export function mimeOf(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.png') return 'image/png';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    return 'image/jpeg';
}

export async function getToken(page) {
    return page.evaluate('(window.location.href.match(/token=(\\d+)/)||[])[1]');
}

export async function requireLogin(page) {
    const token = await getToken(page);
    if (!token) {
        throw new AuthRequiredError(
            WEIXIN_DOMAIN,
            '微信公众号后台未登录。请在浏览器中打开并登录 https://mp.weixin.qq.com（'
            + '登录态会被复用，通常几周有效；过期后重新扫码即可）',
        );
    }
    return token;
}

/** 打开新建图文编辑器。 */
export async function navigateToEditor(page) {
    await page.goto(WEIXIN_HOME);
    await page.wait(3);
    const token = await requireLogin(page);
    await page.goto(
        `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=${token}&lang=zh_CN`,
    );
    await page.wait(5);
    const ready = await page.evaluate(`(() => {
        return document.querySelectorAll('div[contenteditable="true"]').length > 0;
    })()`);
    if (!ready) {
        throw new CommandExecutionError('编辑器未加载完成（登录态可能已过期，或后台改版）');
    }
}

/**
 * 填 input/textarea：用原生 value setter + input/change 事件。
 * 受控组件直接赋 el.value 不触发框架更新；写完立刻回读，字段"看似填了但没
 * 持久化"是已知故障模式。
 */
export async function fillField(page, selectors, value, label) {
    const result = await page.evaluate(`(() => {
        var sels = ${JSON.stringify(selectors)};
        var el = null;
        for (var i = 0; i < sels.length; i++) { el = document.querySelector(sels[i]); if (el) break; }
        if (!el) return { ok: false, reason: 'not found' };
        el.focus();
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, ${JSON.stringify(value)});
        else el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)} }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        return { ok: true, actual: el.value };
    })()`);
    if (!result || !result.ok) {
        throw new CommandExecutionError(`填写${label}失败：${result ? result.reason : 'unknown'}`);
    }
    if (result.actual !== value) {
        throw new CommandExecutionError(
            `填写${label}后回读不一致：期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(result.actual)}`,
        );
    }
    return true;
}

/** 把 HTML 写进正文编辑器（insertHTML 保留内联样式）。 */
export async function insertRichHtml(page, html) {
    const result = await page.evaluate(`(() => {
        var sels = ${JSON.stringify(EDITOR_SELECTORS)};
        var editor = null;
        for (var i = 0; i < sels.length && !editor; i++) {
            var nodes = document.querySelectorAll(sels[i]);
            if (nodes.length > 0) editor = nodes[nodes.length - 1];
        }
        if (!editor) return { ok: false, reason: 'content editor not found' };
        editor.focus();
        if (editor.querySelector('[contenteditable="false"]')) editor.innerHTML = '';
        document.execCommand('selectAll', false, null);
        document.execCommand('insertHTML', false, ${JSON.stringify(html)});
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return { ok: true, length: editor.innerHTML.length };
    })()`);
    if (!result || !result.ok) {
        throw new CommandExecutionError(`写入正文失败：${result ? result.reason : 'unknown'}`);
    }
    return result;
}

/** 回读正文做 fail-closed 校验（忽略所有空白，见模块头注释第 4 条）。 */
export async function verifyContent(page, expectProbe) {
    const actual = await page.evaluate(`(() => {
        var sels = ${JSON.stringify(EDITOR_SELECTORS)};
        var editor = null;
        for (var i = 0; i < sels.length && !editor; i++) {
            var nodes = document.querySelectorAll(sels[i]);
            if (nodes.length > 0) editor = nodes[nodes.length - 1];
        }
        if (!editor) return null;
        return (editor.innerText || '').replace(/\\s+/g, ' ').trim();
    })()`);
    if (!actual || actual.length === 0) {
        throw new CommandExecutionError('正文写入后回读为空——内容没有真正落地');
    }
    const strip = (s) => String(s || '').replace(/[\s\u00a0\u200b]+/g, '');
    const probe = strip(expectProbe);
    if (probe && strip(actual).indexOf(probe.slice(0, 24)) < 0) {
        throw new CommandExecutionError(
            `正文回读校验失败：编辑器内容与预期不符。实际开头：${actual.slice(0, 120)}`,
        );
    }
    return actual.length;
}

/** 统计编辑器里 mmbiz CDN 图片数量。 */
export async function countCdnImages(page) {
    return page.evaluate(`(() => {
        var editor = document.querySelector('#ueditor_0') || document.querySelector('.ProseMirror');
        if (!editor) return 0;
        var imgs = editor.querySelectorAll('img[src*="mmbiz"]');
        var n = 0;
        for (var i = 0; i < imgs.length; i++) { if (imgs[i].src && imgs[i].src.indexOf('mmbiz') >= 0) n++; }
        return n;
    })()`);
}

/**
 * 上传一张图片到正文（DataTransfer 注入，见模块头注释第 3 条）。
 * @returns CDN 上的图片总数
 */
export async function uploadContentImage(page, imagePath) {
    const absPath = requireFile(imagePath, '图片');
    const size = fs.statSync(absPath).size;
    if (size > MAX_IMAGE_BYTES) {
        throw new ArgumentError(
            `图片过大（${(size / 1048576).toFixed(1)}MB > 8MB）。DataTransfer 上传需把字节经 base64 送进页面，请先压缩。`,
        );
    }

    // 打开「图片」下拉 → 点「本地上传」
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
        return { ok: true, count: input.files.length };
    })()`);
    if (!injected || !injected.ok) {
        throw new CommandExecutionError(`注入图片失败：${injected ? injected.reason : 'unknown'}`);
    }

    // 轮询等 CDN 回填（最多 ~30s）
    for (let attempt = 0; attempt < 15; attempt++) {
        await page.wait(2);
        const n = await countCdnImages(page);
        if (n > 0) return n;
    }
    throw new CommandExecutionError('图片未能上传到微信 CDN（等待 30s 后仍没有 mmbiz 图片）');
}

/** 从正文里选第一张图作为封面（微信要求封面必填）。 */
export async function selectCoverFromContent(page) {
    await page.evaluate(`document.querySelector(${JSON.stringify(COVER_AREA)})?.scrollIntoView()`);
    await page.wait(1);
    await page.evaluate(`document.querySelector(${JSON.stringify(COVER_BUTTON_AREA)})?.click()`);
    await page.wait(1);

    const opened = await page.evaluate(`(() => {
        var links = document.querySelectorAll('a.pop-opr__button');
        for (var i = 0; i < links.length; i++) {
            if ((links[i].textContent || '').trim() === '从正文选择') { links[i].click(); return true; }
        }
        return false;
    })()`);
    if (!opened) return false;
    await page.wait(2);

    await page.evaluate(`(() => {
        var img = document.querySelector('.weui-desktop-dialog_img-picker .appmsg_content_img');
        if (img) img.click();
    })()`);
    await page.wait(1);

    await page.evaluate(`(() => {
        var btns = document.querySelectorAll('.weui-desktop-dialog_img-picker button');
        for (var i = 0; i < btns.length; i++) {
            if ((btns[i].textContent || '').trim() === '下一步' && !btns[i].disabled) { btns[i].click(); return; }
        }
    })()`);

    // 裁剪弹窗渲染慢，轮询「确认」
    for (let attempt = 0; attempt < 8; attempt++) {
        await page.wait(2);
        const ready = await page.evaluate(`(() => {
            var btns = document.querySelectorAll('button');
            for (var i = 0; i < btns.length; i++) {
                if ((btns[i].textContent || '').trim() === '确认' && btns[i].offsetHeight > 0 && !btns[i].disabled) return true;
            }
            return false;
        })()`);
        if (ready) break;
    }
    await page.evaluate(`(() => {
        var btns = document.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
            if ((btns[i].textContent || '').trim() === '确认' && btns[i].offsetHeight > 0 && !btns[i].disabled) { btns[i].click(); return; }
        }
    })()`);
    await page.wait(2);

    return page.evaluate(`(() => {
        var area = document.querySelector(${JSON.stringify('#js_cover_area')});
        if (!area) return false;
        var found = false;
        area.querySelectorAll('*').forEach(function(el) {
            var bg = window.getComputedStyle(el).backgroundImage;
            if (bg && bg.indexOf('mmbiz') >= 0) found = true;
        });
        return found;
    })()`);
}

/** 点「保存为草稿」并且必须看到保存成功信号才算成功。 */
export async function saveDraft(page) {
    const clicked = await page.evaluate(`(() => {
        var sels = ${JSON.stringify(SAVE_BUTTON_SELECTORS)};
        for (var i = 0; i < sels.length; i++) {
            var el = document.querySelector(sels[i]);
            if (el && el.offsetHeight > 0) { el.click(); return { ok: true, via: sels[i] }; }
        }
        var labels = ${JSON.stringify(SAVE_LABELS)};
        var els = document.querySelectorAll('span,button,a');
        for (var j = 0; j < els.length; j++) {
            var t = (els[j].textContent || '').trim();
            for (var k = 0; k < labels.length; k++) {
                if (t === labels[k] && els[j].offsetHeight > 0) { els[j].click(); return { ok: true, via: 'text:' + t }; }
            }
        }
        return { ok: false };
    })()`);
    if (!clicked || !clicked.ok) {
        throw new CommandExecutionError('找不到「保存为草稿」按钮（后台可能改版）');
    }
    // ⚠️ 轮询**绝不能**读 `document.body.innerText`：微信编辑器 DOM 极大，读它会
    // 强制整页 layout，实测每次 evaluate 约 17 秒——8 次轮询就把整个命令拖过 210s
    // 超时（踩过：命令超时但草稿其实已保存）。改成只查少量 toast 节点 + 直接看正文
    // 里是否已出现内容，都是 O(1) 级的操作。
    for (let attempt = 0; attempt < 10; attempt++) {
        await page.wait(1);
        const saved = await page.evaluate(`(() => {
            var el = document.querySelector('#js_save_success');
            if (el && window.getComputedStyle(el).display !== 'none') return true;
            // 后台保存成功会弹 .weui-desktop-toast（不必读全页文本）
            var toasts = document.querySelectorAll('.weui-desktop-toast, .weui-desktop-msg');
            for (var i = 0; i < toasts.length; i++) {
                var t = (toasts[i].textContent || '').trim();
                if (t.indexOf('已保存') >= 0 || t.indexOf('保存成功') >= 0) return true;
            }
            return false;
        })()`);
        if (saved) return true;
    }
    throw new CommandExecutionError('点击保存后未检测到保存成功信号（请到后台确认草稿是否已保存）');
}

/**
 * 点「发表」并等待管理员扫码。
 *
 * ⚠️ 微信要求**管理员扫码确认**，无法自动化。本函数会：
 *   1. 点「发表」；
 *   2. 提示用户去浏览器扫码；
 *   3. 轮询直到出现「已发表/审核中」等成功信号，或超时。
 */
export async function publishDraft(page, timeoutSec) {
    const clicked = await page.evaluate(`(() => {
        var sels = ${JSON.stringify(PUBLISH_SELECTORS)};
        for (var i = 0; i < sels.length; i++) {
            var el = document.querySelector(sels[i]);
            if (el && el.offsetHeight > 0) { el.click(); return { ok: true, via: sels[i] }; }
        }
        return { ok: false };
    })()`);
    if (!clicked || !clicked.ok) {
        throw new CommandExecutionError('找不到「发表」按钮（表单可能未填完或后台改版）');
    }

    process.stderr.write(
        '\n⚠️  已点击「发表」。微信要求管理员扫码确认，请在浏览器中扫码...\n'
        + '    （扫码页面会在浏览器中弹出；完成后本命令会自动继续）\n\n',
    );

    const deadline = Date.now() + Math.min(Number(timeoutSec) || 180, 300) * 1000;
    let lastUrl = '';
    while (Date.now() < deadline) {
        await page.wait(3);
        // ⚠️ 同样**不要**读 body.innerText（微信 DOM 极大，读一次 ~17s，会把轮询
        // 拖到超时）。只查 URL + 少量 toast 节点。
        const state = await page.evaluate(`(() => {
            var toasts = document.querySelectorAll('.weui-desktop-toast, .weui-desktop-msg, .weui-desktop-dialog__desc');
            var hit = '';
            for (var i = 0; i < toasts.length; i++) {
                var t = (toasts[i].textContent || '').trim();
                if (/已发表|发表成功|发布成功|审核中/.test(t)) { hit = t.slice(0, 80); break; }
            }
            return JSON.stringify({ url: location.href, hit: hit });
        })()`);
        try {
            const parsed = JSON.parse(state);
            lastUrl = parsed.url || lastUrl;
            if (parsed.hit) return true;
            if (parsed.url && parsed.url.indexOf('appmsgpublish') >= 0) return true;
        } catch { /* keep polling */ }
    }
    throw new TimeoutError(
        `等待发表结果超时（${Math.min(Number(timeoutSec) || 180, 300)}s）。可能是扫码未完成。`
        + `当前页面：${lastUrl}`,
    );
}
