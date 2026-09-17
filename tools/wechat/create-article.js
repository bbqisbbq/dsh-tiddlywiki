/**
 * weixin create-article — 创建微信公众号图文草稿（富文本内联样式，可选发表）
 *
 * 流程与所有踩坑集中在 weixin-flow.js；排版规则在 wechat-html.js。
 *
 * 正文来自**文件**而非命令行参数：避免 Windows 转义与命令行长度上限。
 *
 * ⚠️ 必须带 `--trace retain-on-failure`（否则报 Navigation rejected，见 flow 头注释）。
 *
 * 用法：
 *   opencli weixin create-article --html ./article.html --title "标题" \
 *     --author "作者" --cover-image ./cover.png --summary "摘要" \
 *     --trace retain-on-failure -f json
 */
import * as fs from 'node:fs';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { ArgumentError, CommandExecutionError } from '@jackwener/opencli/errors';
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
import { extractBody, decorate } from './wechat-html.js';

cli({
    site: 'weixin',
    name: 'create-article',
    access: 'write',
    description: '创建微信公众号图文草稿（富文本内联样式，可选直接发表）',
    domain: WEIXIN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    navigateBefore: false,
    args: [
        { name: 'html', required: true, help: '正文 HTML 文件路径（可用 --raw 跳过装饰）' },
        { name: 'title', required: true, help: '文章标题（后台限制 64 字内）' },
        { name: 'author', help: '作者名（后台限制 8 字内）' },
        { name: 'summary', help: '摘要（后台限制 120 字内）' },
        { name: 'cover-image', help: '封面图片本地路径（先插入正文再设为封面）' },
        { name: 'publish', type: 'bool', default: false, help: '保存后直接点「发表」（需管理员扫码）' },
        { name: 'raw', type: 'bool', default: false, help: '跳过内联样式装饰，原样注入' },
        { name: 'timeout', type: 'int', default: 180, help: '发表等待扫码的秒数（默认 180）' },
    ],
    columns: ['status', 'title', 'detail'],

    func: async (page, kwargs) => {
        const htmlPath = requireFile(kwargs.html, 'HTML 文件');
        const rawHtml = fs.readFileSync(htmlPath, 'utf8');
        if (!rawHtml.trim()) throw new ArgumentError('HTML 文件是空的');

        // 装饰 = 给每个元素补内联样式（微信只认内联；会剥 <style>/class）
        const html = kwargs.raw === true ? extractBody(rawHtml) : decorate(extractBody(rawHtml));

        const title = String(kwargs.title || '').trim();
        if (!title) throw new ArgumentError('title 不能为空');
        if (title.length > 64) throw new ArgumentError(`标题超长（${title.length} > 64 字）`);
        const author = kwargs.author ? String(kwargs.author).trim() : '';
        if (author.length > 8) throw new ArgumentError(`作者名超长（${author.length} > 8 字）`);
        const summary = kwargs.summary ? String(kwargs.summary).trim() : '';
        if (summary.length > 120) throw new ArgumentError(`摘要超长（${summary.length} > 120 字）`);

        await navigateToEditor(page);
        await fillField(page, TITLE_SELECTORS, title, '标题');
        if (author) await fillField(page, AUTHOR_SELECTORS, author, '作者');
        if (summary) await fillField(page, SUMMARY_SELECTORS, summary, '摘要');

        await insertRichHtml(page, html);
        const probe = html.replace(/<[^>]*>/g, ' ').trim();
        const contentLength = await verifyContent(page, probe);

        let imageCount = 0;
        let coverSet = false;
        if (kwargs['cover-image']) {
            imageCount = await uploadContentImage(page, kwargs['cover-image']);
            coverSet = await selectCoverFromContent(page);
            if (!coverSet) {
                throw new CommandExecutionError(
                    '图片已上传正文，但「从正文选择」设为封面失败——微信要求封面必填，草稿会显示不完整。请手动设置封面。',
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
            kwargs['cover-image'] ? (coverSet ? '封面已设置' : '封面未设置') : '无封面（草稿会显示不完整）',
            published ? '已发表' : '已存草稿',
        ].filter(Boolean).join(' · ');

        return [{
            status: published ? '已发表' : '草稿已保存',
            title,
            detail,
        }];
    },
});
