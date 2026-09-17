/**
 * wechat-html — TiddlyWiki 渲染的语义 HTML → 微信公众号可用的内联样式 HTML
 *
 * 为什么需要这一步（实测依据，2026-09-17）：
 *   - TiddlyWiki 的 /render 输出是**纯语义 HTML**（<h1>/<p>/<ul>/<blockquote>/<pre>
 *     /<table>），**没有任何内联 style**，并带 class（如 class="markdown"、
 *     class="_codified_"、代码高亮的 class="hljs-keyword"）。
 *   - 微信公众号编辑器会**丢弃 <style> 标签**、**保留 class 但无样式可依附**、
 *     而**完整保留内联 style**。实测：注入 `<style>h1{color:red}</style>` 后
 *     `hasStyleTag:false`；注入 `style="font-size:20px"` 则原样保留。
 *   => 所以 TW 的 HTML 结构完全可用，只缺一件事：给每个元素补内联样式。
 *
 * 本模块就是这个「装饰器」。它不解析 Markdown——那是 TW 的活；这里只做
 * 「按标签名注入内联样式 + 清理无用属性 + 处理微信的规范化怪癖」。
 *
 * 微信实测行为（决定了下面这些处理为什么存在）：
 *   - `border:1px solid #ddd` 会被拆成 border-width / border-color（视觉不变）
 *   - 块级元素被包进 <section>（无害）
 *   - class 会保留但不产生任何视觉效果 → 我们主动清掉，避免噪音
 *   - <pre> 内的 <code> 若套用行内代码样式（背景/内边距）会很难看 → 必须区分
 */

/** 标签 → 内联样式。改这里就是改排版主题。 */
export const ELEMENT_STYLES = {
    // ── 容器 ──
    div: 'font-size:16px;color:#333333;',

    // ── 标题 ──
    h1: 'font-size:22px;font-weight:bold;color:#1a1a1a;line-height:1.4;margin:28px 0 14px;',
    h2: 'font-size:20px;font-weight:bold;color:#2563eb;line-height:1.4;margin:26px 0 12px;border-left:4px solid #2563eb;padding-left:10px;',
    h3: 'font-size:18px;font-weight:bold;color:#1a1a1a;line-height:1.5;margin:22px 0 10px;',
    h4: 'font-size:17px;font-weight:bold;color:#1a1a1a;line-height:1.5;margin:20px 0 10px;',
    h5: 'font-size:16px;font-weight:bold;color:#1a1a1a;line-height:1.5;margin:18px 0 8px;',
    h6: 'font-size:16px;font-weight:bold;color:#666666;line-height:1.5;margin:18px 0 8px;',

    // ── 正文 ──
    p: 'font-size:16px;color:#333333;line-height:1.75;letter-spacing:0.5px;margin:0 0 1em;',

    // ── 列表 ──
    ul: 'margin:0 0 1em;padding-left:22px;',
    ol: 'margin:0 0 1em;padding-left:22px;',
    li: 'font-size:16px;color:#333333;line-height:1.75;margin:0 0 6px;',

    // ── 引用 ──
    blockquote: 'border-left:3px solid #d0d0d0;padding:8px 0 8px 14px;margin:1em 0;color:#666666;background:#fafafa;',

    // ── 代码 ──
    // pre 是代码块外壳；行内 code 的样式在 applyInline 里特判（pre 内的 code 不套用）
    pre: 'background:#f6f8fa;border-radius:6px;padding:12px;margin:1em 0;overflow-x:auto;font-size:14px;line-height:1.6;',
    code: 'font-family:Consolas,Monaco,Menlo,monospace;font-size:14px;color:#c7254e;background:#f9f2f4;padding:1px 4px;border-radius:3px;',

    // ── 表格 ──
    table: 'border-collapse:collapse;width:100%;margin:1em 0;font-size:15px;',
    th: 'border:1px solid #e0e0e0;padding:8px 10px;background:#f5f5f5;font-weight:bold;color:#333333;font-size:15px;text-align:left;',
    td: 'border:1px solid #e0e0e0;padding:8px 10px;color:#333333;font-size:15px;',

    // ── 行内 ──
    a: 'color:#2563eb;text-decoration:none;border-bottom:1px solid #2563eb;',
    strong: 'font-weight:bold;color:#1a1a1a;',
    b: 'font-weight:bold;color:#1a1a1a;',
    em: 'font-style:italic;color:#555555;',
    i: 'font-style:italic;color:#555555;',
    hr: 'border:none;border-top:1px solid #e0e0e0;margin:1.5em 0;',
    img: 'max-width:100%;height:auto;display:block;margin:1em auto;border-radius:4px;',
};

/** 代码块内的 <code> 不该有行内代码的粉底/内边距。 */
const CODE_IN_PRE = 'font-family:Consolas,Monaco,Menlo,monospace;font-size:14px;color:#333333;background:transparent;padding:0;';

/** 从整篇 HTML 文档里抽出可发布内容：丢 <style>/<script>/<head>，body 优先。 */
export function extractBody(html) {
    let out = String(html || '');
    out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
    out = out.replace(/<style[\s\S]*?<\/style>/gi, '');
    out = out.replace(/<!--[\s\S]*?-->/g, '');
    const bodyMatch = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) out = bodyMatch[1];
    return out.trim();
}

/** 内部 wiki 链接（指向 DSH 代理 hash）在公众号里毫无意义 → 只留文字。 */
function isInternalWikiLink(attrs) {
    return /href\s*=\s*["'][^"']*(?:\/dsh-tiddlywiki\/tw\/#|^#)/i.test(attrs)
        || /class\s*=\s*["'][^"']*tc-tiddlylink(?!-external)/i.test(attrs);
}

/** 去掉 class/style 等我们接管或微信无用的属性，保留 href/src 等语义属性。 */
function cleanAttrs(attrs) {
    return String(attrs || '')
        .replace(/\s+class\s*=\s*"[^"]*"/gi, '')
        .replace(/\s+class\s*=\s*'[^']*'/gi, '')
        .replace(/\s+style\s*=\s*"[^"]*"/gi, '')
        .replace(/\s+style\s*=\s*'[^']*'/gi, '')
        .replace(/\s+data-[a-z0-9-]+\s*=\s*"[^"]*"/gi, '')
        .replace(/\s+leaf\s*=\s*"[^"]*"/gi, '')
        .trim();
}

/**
 * 装饰：给白名单标签注入内联样式，清掉 class，修正微信怪癖。
 *
 * 幂等：每次都先剥掉已有 style 再套我们的 → 重复调用结果一致。
 */
export function decorate(html) {
    const src = String(html || '');
    const out = [];
    // 用栈跟踪是否身处 <pre> 内（决定 <code> 用哪套样式）
    let preDepth = 0;
    let linkTextSuppressed = 0;

    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let last = 0;
    let m;

    while ((m = tagRe.exec(src)) !== null) {
        out.push(src.slice(last, m.index));
        last = tagRe.lastIndex;

        const closing = m[1] === '/';
        const tag = m[2].toLowerCase();
        const attrs = m[3] || '';

        // ── 内部链接降级为纯文字 ──
        if (tag === 'a' && !closing && isInternalWikiLink(attrs)) {
            linkTextSuppressed += 1;
            continue; // 丢弃 <a ...>，后续遇到 </a> 也丢弃
        }
        if (tag === 'a' && closing && linkTextSuppressed > 0) {
            linkTextSuppressed -= 1;
            continue;
        }

        if (tag === 'pre') {
            if (!closing) preDepth += 1; else preDepth = Math.max(0, preDepth - 1);
        }

        if (closing) {
            out.push(`</${tag}>`);
            continue;
        }

        const isSelfClosing = /\/$/.test(attrs.trim());
        const cleaned = cleanAttrs(attrs);

        let style = ELEMENT_STYLES[tag];
        if (tag === 'code' && preDepth > 0) style = CODE_IN_PRE;

        // 不管理的标签原样保留（去掉我们清掉的属性）
        const rendered = style
            ? `<${tag} style="${style}"${cleaned ? ' ' + cleaned : ''}${isSelfClosing ? ' /' : ''}>`
            : `<${tag}${cleaned ? ' ' + cleaned : ''}${isSelfClosing ? ' /' : ''}>`;
        out.push(rendered);
    }
    out.push(src.slice(last));
    return out.join('');
}

/** 找出 HTML 里指向**本地文件**的图片，返回 [{ src, path }]。 */
export function findLocalImages(html, existsSync) {
    const found = [];
    const imgRe = /<img\b([^>]*)>/gi;
    let m;
    while ((m = imgRe.exec(String(html || ''))) !== null) {
        const attrs = m[1] || '';
        const srcMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
        if (!srcMatch) continue;
        const raw = srcMatch[1];
        let p = raw;
        if (/^file:\/\//i.test(p)) {
            try { p = decodeURIComponent(new URL(p).pathname); } catch { /* keep */ }
            if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // /C:/x → C:/x
        }
        if (/^https?:/i.test(p)) continue; // 网络图需先落地（微信会过滤外链）
        if (existsSync && !existsSync(p)) continue;
        found.push({ src: raw, path: p });
    }
    return found;
}

/** 预览包装：生成一个能直接在浏览器里看效果的 HTML 文档。 */
export function wrapForPreview(bodyHtml, title) {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${String(title || '预览').replace(/[<>&]/g, '')}</title>
<style>body{max-width:677px;margin:0 auto;padding:20px 16px;background:#fff;font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;}</style>
</head><body>
${bodyHtml}
</body></html>`;
}
