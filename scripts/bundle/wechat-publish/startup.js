/*\
title: $:/plugins/dsh/wechat-publish/startup.js
type: application/javascript
module-type: startup

\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

exports.name = "dsh-wechat-publish";
exports.after = ["story"];
exports.platforms = ["browser"];

// The one-shot confirm overlay. Kept as a DOM id (not a closure variable)
// because the poller and the overlay are wired together long after the
// overlay was built — see publishAndPoll().
var OVERLAY_ID = "dsh-wechat-publish-overlay";
// Stop polling after 10 minutes. The browser flow uploads every inlined image
// one by one, so a long article is slow, but a job that never settles must not
// keep a 2s timer alive for the rest of the page's life.
var POLL_INTERVAL_MS = 2000;
var POLL_TIMEOUT_MS = 10 * 60 * 1000;
// How much of job.log to show (a full adapter run can log megabytes).
var LOG_TAIL_CHARS = 2000;

// Mirrors the host's DEFAULT_ADAPTER. `wechat.enabled` is false by default:
// browser automation against the 公众号 backend is an OPT-IN feature that
// needs opencli + the Browser Bridge extension installed separately.
function readConfig() {
	var config = { enabled: false, endpoint: "", token: "", adapter: "publish-note" };
	try {
		var t = $tw.wiki.getTiddler("$:/plugins/dsh-tiddlywiki/config");
		if (t && t.fields && typeof t.fields.text === "string") {
			var parsed = JSON.parse(t.fields.text);
			var wechat = parsed && parsed.wechat;
			if (wechat) {
				if (typeof wechat.enabled === "boolean") { config.enabled = wechat.enabled; }
				if (typeof wechat.endpoint === "string" && wechat.endpoint.length > 0) { config.endpoint = wechat.endpoint; }
				if (typeof wechat.token === "string" && wechat.token.length > 0) { config.token = wechat.token; }
				if (wechat.adapter === "publish-note" || wechat.adapter === "publish-note-imgs") { config.adapter = wechat.adapter; }
			}
		}
	} catch (e) {}
	return config;
}

function baseEndpoint() {
	var config = readConfig();
	if (config.endpoint.length > 0) { return config.endpoint.replace(/\/+$/, ""); }
	if (typeof location !== "undefined" && location.origin) { return location.origin + "/dsh-tiddlywiki"; }
	return "/dsh-tiddlywiki";
}

function authHeaders() {
	var headers = { "Content-Type": "application/json" };
	var config = readConfig();
	// Must match the host's readToken(): the token only travels in this header,
	// never in the URL, so it cannot leak through history/referer/proxy logs.
	if (config.token.length > 0) { headers["x-wechat-publish-token"] = config.token; }
	return headers;
}

/*
Show a transient message.

TW's notifier renders a TIDDLER by title and does **nothing at all** when that
tiddler does not exist (core/modules/utils/dom/notifier.js: "Don't do anything
if the tiddler doesn't exist"). Passing free text as the title — the mistake
the 「发送给 Agent」 button shipped with — makes every notice a silent no-op.
Store the message in a $:/temp tiddler first (volatile: never synced, never
written to disk) and display THAT title.
*/
var NOTICE_TITLE = "$:/temp/dsh/wechat-publish/notice";
function notify(msg) {
	try {
		if ($tw.wiki && $tw.notifier && typeof $tw.notifier.display === "function" && typeof $tw.wiki.addTiddler === "function") {
			$tw.wiki.addTiddler({ title: NOTICE_TITLE, text: String(msg), type: "text/vnd.tiddlywiki" });
			$tw.notifier.display(NOTICE_TITLE);
			return;
		}
	} catch (e) {}
	if (typeof alert === "function") { alert(msg); }
}

/*
Parse a response body. The host answers every failure with a JSON body AND a
non-2xx status, and $tw.utils.httpRequest reports those as
`callback("Error/XMLHttpRequest: 403", body, xhr)` — i.e. err is a localized
string and the body is still handed over. So parse first, then decide: the
body's `error` is the readable truth, err is the fallback.
*/
function parseJob(data) {
	try { return JSON.parse(data || ""); } catch (e) { return null; }
}
function failText(err, parsed, data, fallback) {
	if (parsed && parsed.error) { return String(parsed.error); }
	if (err) { return String(err); }
	if (data) { return String(data); }
	return fallback || "未知错误";
}

function closeOverlay() {
	var overlay = document.getElementById(OVERLAY_ID);
	if (overlay) {
		if (typeof overlay.__dshStopPolling === "function") { overlay.__dshStopPolling(); }
		if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
	}
}

function makeBox() {
	var box = document.createElement("div");
	box.setAttribute("style", "background:#fff;color:#333;border-radius:8px;padding:16px;max-width:520px;width:92vw;max-height:82vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.3);font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.6;");
	return box;
}

function makeRow(parent, weight, text, color) {
	var el = document.createElement(weight === "h" ? "h3" : "p");
	el.setAttribute("style", (weight === "h" ? "margin:0 0 8px;font-size:15px;" : "margin:0 0 8px;") + (color ? "color:" + color + ";" : "") + "word-break:break-all;");
	el.textContent = text;
	parent.appendChild(el);
	return el;
}

function makeButton(label, primary) {
	var b = document.createElement("button");
	b.type = "button";
	b.textContent = label;
	b.setAttribute("style", primary
		? "padding:7px 16px;border:1px solid #4a90d9;border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer;font-size:13px;"
		: "padding:7px 16px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;color:#444;");
	return b;
}

function setDisabled(btn, disabled) {
	btn.disabled = !!disabled;
	btn.style.opacity = disabled ? "0.5" : "1";
	btn.style.cursor = disabled ? "default" : "pointer";
}

/*
Build the confirm overlay. Returns the box plus the pieces the caller mutates:
  {overlay, box, status, actions, logs, logPre}
Only ever one overlay at a time (a second click replaces the first), and Esc /
backdrop click / ✕ all funnel through closeOverlay() so the poller is stopped.
*/
function createOverlay(title) {
	var previous = document.getElementById(OVERLAY_ID);
	if (previous) { closeOverlay(); }

	var overlay = document.createElement("div");
	overlay.id = OVERLAY_ID;
	overlay.setAttribute("style", "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);z-index:99999;display:flex;align-items:center;justify-content:center;");
	var box = makeBox();

	var header = document.createElement("div");
	header.setAttribute("style", "display:flex;align-items:center;justify-content:space-between;gap:8px;");
	var h = document.createElement("h3");
	h.setAttribute("style", "margin:0;font-size:15px;");
	h.textContent = "发布到公众号 · " + title;
	var closeX = document.createElement("button");
	closeX.type = "button";
	closeX.textContent = "✕";
	closeX.title = "关闭（停止轮询）";
	closeX.setAttribute("style", "border:none;background:transparent;font-size:15px;cursor:pointer;color:#888;padding:2px 8px;border-radius:4px;");
	closeX.addEventListener("click", function() { closeOverlay(); });
	header.appendChild(h);
	header.appendChild(closeX);
	box.appendChild(header);

	var status = document.createElement("div");
	status.setAttribute("style", "margin:6px 0 10px;white-space:pre-wrap;");
	box.appendChild(status);

	var logs = document.createElement("div");
	logs.setAttribute("style", "margin:8px 0 0;");
	var logCaption = document.createElement("p");
	logCaption.setAttribute("style", "margin:0 0 4px;font-size:12px;color:#888;");
	logCaption.textContent = "运行日志（最近 " + LOG_TAIL_CHARS + " 字符）：";
	var logPre = document.createElement("pre");
	logPre.setAttribute("style", "margin:0;max-height:32vh;overflow:auto;background:#1e1e1e;color:#ddd;border-radius:6px;padding:8px;font-size:11px;white-space:pre-wrap;word-break:break-all;");
	logs.appendChild(logCaption);
	logs.appendChild(logPre);
	logs.style.display = "none";
	box.appendChild(logs);

	var actions = document.createElement("div");
	actions.setAttribute("style", "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap;");
	box.appendChild(actions);

	overlay.appendChild(box);
	document.body.appendChild(overlay);

	overlay.addEventListener("click", function(e) { if (e.target === overlay) { closeOverlay(); } });
	var escHandler = function(e) { if (e.key === "Escape") { closeOverlay(); } };
	document.addEventListener("keydown", escHandler);
	// The Esc listener lived on `document`: it must die with the overlay,
	// otherwise every open/close cycle leaks one keydown handler.
	overlay.__dshCleanup = function() { document.removeEventListener("keydown", escHandler); };
	return { overlay: overlay, box: box, status: status, actions: actions, logs: logs, logPre: logPre };
}

/*
The plain-text confirm body. The「只存草稿」/「需要扫码」/「复用已登录浏览器」
sentences are the contract of the whole feature (v0.23.2 起策略就是「到草稿箱为止」):
users must not expect a one-click public post, and must know their session is
reused rather than a stored credential.
*/
function confirmationText(title) {
	return "笔记：《" + title + "》\n\n"
		+ "只存到草稿箱，不会自动发表；发表需你在浏览器里扫码。\n"
		+ "脚本会复用你已登录的浏览器（不保存任何凭据）。\n"
		+ "首次运行可能需要一两分钟（图片要逐张上传）。";
}

/*
A warning row for notes the 发布元数据规范 marks as off-limits. Read from the
tiddler's custom FIELDS (not tags alone): `pub-state: excluded` and the
`no-publish` tag are the two mirrors the spec keeps in sync. This only warns —
the host does not block (see docs: 只告警不阻断), so the user stays in control.
*/
function publishWarnings(title) {
	var tiddler = $tw.wiki.getTiddler(title);
	var fields = (tiddler && tiddler.fields) || {};
	var tags = fields.tags || [];
	var state = fields["pub-state"] ? String(fields["pub-state"]) : "";
	var warnings = [];
	if (state === "published") { warnings.push("这篇笔记的 pub-state 是 published —— 可能已经发表过，请确认不要重复发布。"); }
	if (state === "excluded") { warnings.push("这篇笔记的 pub-state 是 excluded —— 规范里标为「明确不发」。"); }
	if (tags.indexOf("no-publish") !== -1) { warnings.push("这篇笔记带着 no-publish 标签 —— 规范里标为「不可发布」。"); }
	return warnings;
}

function showError(title, msg, silent) {
	var ui = createOverlay(title);
	ui.overlay.__dshCleanup();
	makeRow(ui.status, "p", "⚠️ " + msg, "#c0392b");
	var cancel = makeButton("关闭", false);
	cancel.addEventListener("click", function() { closeOverlay(); });
	ui.actions.appendChild(cancel);
	// `silent` for the callers that already fire their own toast — one failure
	// must produce exactly one notification, not two.
	if (!silent) { notify("发布到公众号失败：" + msg); }
}

/*
GET /wechat/ready. The endpoint answers 200 with `ok:true` whenever the feature
is on — an INSTALLATION problem is deliberately not an HTTP error (see the host
route), it is reported inside the body as `opencli.ok=false` / `adapters.missing`.
So `parsed.ok` alone must never be read as "ready": gating on it would skip both
checks and let the user confirm a publish that is guaranteed to fail 503.
Returns an actionable message for a CONCRETE problem, or null otherwise.

This was measured, not guessed: with a body of
`{ok:true, adapters:{publishNote:false,…}}` an earlier draft still rendered the
confirm dialog, because the readiness check was keyed off `parsed.ok`.
*/
function readinessProblem(parsed, adapter) {
	if (!parsed) { return null; }
	if (parsed.enabled === false) {
		return "微信发布未启用：请在 DSH 设置 →「TiddlyWiki 知识库」→「可选功能：微信公众号发布」勾选并保存。";
	}
	var ready = parsed.ready || parsed;
	if (ready.opencli && ready.opencli.ok === false) {
		return "未检测到可用的 opencli —— 发布依赖它驱动浏览器。\n请先按 docs/wechat-publish-setup.md 安装 opencli，然后运行：\nnode <插件目录>/tools/wechat/install-wechat-adapters.mjs";
	}
	var adapters = ready.adapters;
	if (!adapters) { return null; }
	var missing = Array.isArray(adapters.missing) ? adapters.missing : [];
	// v0.23.4：`stale` = 文件都在但**版本过旧**（旧版 adapter 不认宿主的
	// `--title-file`，点了按钮才会在 opencli 里报「缺少必填参数」）。措辞必须
	// 与「缺失」分开，否则用户会去重装一遍同样的旧文件。
	var stale = Array.isArray(adapters.stale) ? adapters.stale : [];
	var installHint = "\n请运行（路径相对插件目录，npm 安装时是 node_modules/dsh-tiddlywiki）：\n"
		+ "node <插件目录>/tools/wechat/install-wechat-adapters.mjs";
	if (stale.length > 0) {
		return "发布脚本（adapter）版本过旧：" + stale.join("、") + "。\n"
			+ "旧版不认识宿主的 --title-file（标题走文件、不进命令行），直接发布会在 opencli 里报「缺少必填参数」。"
			+ installHint;
	}
	// Only the selected adapter matters: a wiki can publish plain notes long
	// before the multi-image adapter is installed.
	var needed = adapter === "publish-note-imgs" ? "publishNoteImgs" : "publishNote";
	if (adapters[needed] === false || missing.length > 0) {
		return "缺少发布脚本（adapter）：" + (missing.length > 0 ? missing.join("、") : needed) + "。"
			+ installHint;
	}
	return null;
}

/** The concrete problem, or the transport error / host message when there is none. */
function describeNotReady(parsed, err, data, adapter) {
	var problem = readinessProblem(parsed, adapter);
	if (problem !== null) { return problem; }
	return "无法检查发布环境：" + failText(err, parsed, data, "未知错误");
}

/*
POST /wechat/publish, then poll GET /wechat/publish/status?id=… every 2s until
the job settles. A 409 (another job running) is surfaced verbatim — the host
already names the running jobId, which is what the user needs to go look at it.
*/
function publishAndPoll(title, adapter) {
	var ui = createOverlay(title);
	setDisabled(ui.actions, true);
	ui.actions.innerHTML = "";
	makeRow(ui.status, "p", "正在提交发布任务…", "#555");

	var stopped = false;
	var timer = null;
	function stopPolling() {
		stopped = true;
		if (timer !== null) { clearInterval(timer); timer = null; }
	}
	// closeOverlay() calls this through the overlay node, so EVERY close path
	// (✕ / Esc / backdrop / programmatic) stops the 2s polling loop.
	ui.overlay.__dshStopPolling = function() {
		stopPolling();
		ui.overlay.__dshCleanup();
	};

	function addCloseButton(onClose) {
		var close = makeButton("关闭", false);
		close.addEventListener("click", function() { closeOverlay(); if (onClose) { onClose(); } });
		ui.actions.appendChild(close);
	}

	function renderJob(job) {
		var lines = [];
		if (job.state === "running") { lines.push("⏳ 正在发布…"); }
		else if (job.state === "ok") { lines.push("✅ " + (job.message || "已存到公众号草稿箱")); }
		else if (job.state === "error") { lines.push("❌ 发布失败" + (job.exitCode !== undefined ? "（exit " + job.exitCode + "）" : "")); }
		else { lines.push("状态：" + String(job.state || "未知")); }
		if (job.message && job.state !== "ok") { lines.push(String(job.message)); }
		if (job.state === "ok") {
			lines.push("");
			lines.push("建议回写发布元数据（用 tiddlywiki_put 补 fields，别动 tags）：");
			lines.push("pub-state: published · pub-platform: wechat · pub-wechat-at: <发表时间>");
			lines.push("若实际发表时间/标题与本文不同，再补 pub-wechat-title / pub-wechat-url。");
		}
		ui.status.textContent = lines.join("\n");
		if (job.log) {
			ui.logs.style.display = "";
			ui.logPre.textContent = String(job.log).slice(-LOG_TAIL_CHARS);
			ui.logPre.scrollTop = ui.logPre.scrollHeight;
		}
	}

	function poll(jobId) {
		$tw.utils.httpRequest({
			url: baseEndpoint() + "/wechat/publish/status?id=" + encodeURIComponent(jobId),
			type: "GET",
			headers: authHeaders(),
			callback: function(err, data) {
				if (stopped) { return; }
				var parsed = parseJob(data);
				if (err || !parsed || !parsed.ok || !parsed.job) {
					// A transient poll failure must not end the job: show it and
					// keep polling — the job is still running on the host.
					makeRow(ui.status, "p", "⚠️ 查询状态失败：" + failText(err, parsed, data, "未知错误") + "（继续重试…）", "#c0392b");
					return;
				}
				var job = parsed.job;
				renderJob(job);
				if (job.state === "ok" || job.state === "error") {
					stopPolling();
					ui.overlay.__dshCleanup();
					ui.actions.innerHTML = "";
					addCloseButton();
					// Sync a one-shot toast: the overlay may be closed (or the
					// TW panel hidden) before the user reads it.
					notify(job.state === "ok"
						? "已存到公众号草稿箱 ✓《" + title + "》"
						: "发布到公众号失败：《" + title + "》" + (job.message ? "（" + job.message + "）" : ""));
				}
			}
		});
	}

	$tw.utils.httpRequest({
		url: baseEndpoint() + "/wechat/publish",
		type: "POST",
		headers: authHeaders(),
		data: JSON.stringify({ title: title, adapter: adapter }),
		callback: function(err, data) {
			if (stopped) { return; }
			var parsed = parseJob(data);
			if (err || !parsed || !parsed.ok) {
				// The 503 body carries a `ready` snapshot (opencli + adapters)
				// whose install advice is more useful than the raw error; for
				// every other failure (400/401/403/409) the host's own `error`
				// is already the actionable text, so it is kept as-is.
				var advice = readinessProblem(parsed, adapter);
				var detail = advice !== null
					? advice + "\n" + failText(err, parsed, data, "未知错误")
					: failText(err, parsed, data, "未知错误");
				stopPolling();
				ui.overlay.__dshCleanup();
				ui.actions.innerHTML = "";
				if (parsed && parsed.jobId) { detail += "\n（正在运行的任务：" + parsed.jobId + "）"; }
				makeRow(ui.status, "p", "⚠️ " + detail, "#c0392b");
				addCloseButton();
				notify("发布到公众号失败：" + failText(err, parsed, data, "未知错误"));
				return;
			}
			var jobId = parsed.jobId;
			makeRow(ui.status, "p", "任务已提交（" + jobId + "），每 2 秒查询进度…", "#555");
			addCloseButton();
			poll(jobId);
			timer = setInterval(function() { poll(jobId); }, POLL_INTERVAL_MS);
			// Hard stop: the host has its own timeouts, but the page must not
			// poll forever if a job somehow never settles.
			setTimeout(function() {
				if (!stopped && timer !== null) {
					stopPolling();
					makeRow(ui.status, "p", "⚠️ 超过 10 分钟仍未结束，已停止查询。请到公众号后台确认草稿是否已保存。", "#c0392b");
				}
			}, POLL_TIMEOUT_MS);
		}
	});
}

function checkReadyThenConfirm(title, adapter) {
	var ui = createOverlay(title);
	setDisabled(ui.actions, true);
	ui.actions.innerHTML = "";
	makeRow(ui.status, "p", "正在检查发布环境…", "#555");

	$tw.utils.httpRequest({
		url: baseEndpoint() + "/wechat/ready",
		type: "GET",
		headers: authHeaders(),
		callback: function(err, data) {
			var parsed = parseJob(data);
			// `parsed.ok` is NOT the readiness signal (see readinessProblem):
			// the endpoint returns ok:true even when opencli/adapters are
			// missing, and reports those inside the body.
			var problem = readinessProblem(parsed, adapter);
			if (problem !== null) {
				closeOverlay();
				// The overlay shows the fix; the toast mirrors it once.
				showError(title, problem);
				return;
			}
			// Ready → rebuild the overlay as the confirm dialog.
			closeOverlay();
			var ui2 = createOverlay(title);
			makeRow(ui2.status, "p", confirmationText(title), "#444");
			publishWarnings(title).forEach(function(w) {
				makeRow(ui2.status, "p", "⚠️ " + w, "#c0392b");
			});
			var cancel = makeButton("取消", false);
			cancel.addEventListener("click", function() { closeOverlay(); });
			var go = makeButton("开始存草稿", true);
			go.addEventListener("click", function() { closeOverlay(); publishAndPoll(title, adapter); });
			ui2.actions.appendChild(cancel);
			ui2.actions.appendChild(go);
		}
	});
}

function handlePublish(title) {
	// Whole handler is wrapped by the caller: a throw inside a startup module
	// aborts the rest of TW's startup (other plugins' modules never run).
	if (!title) { notify("无法确定当前笔记标题"); return; }
	var tiddler = $tw.wiki.getTiddler(title);
	if (!tiddler) { notify("找不到笔记：" + title); return; }
	var config = readConfig();
	if (!config.enabled) {
		notify("「发布到公众号」未启用：请在 DSH 设置 →「TiddlyWiki 知识库」→「微信公众号发布」勾选并保存后重试。");
		return;
	}
	checkReadyThenConfirm(title, config.adapter);
}

exports.startup = function() {
	console.log("[dsh-wechat-publish] startup ran");
	if (!$tw.rootWidget || typeof $tw.rootWidget.addEventListener !== "function") { return; }
	$tw.rootWidget.addEventListener("dsh-wechat-publish", function(event) {
		try {
			handlePublish(event.param);
		} catch (e) {
			// Never let a startup-module exception escape: TW runs every startup
			// module in one loop, so a throw here breaks unrelated plugins.
			try { notify("发布到公众号失败：" + (e && e.message ? e.message : e)); } catch (e2) {}
			try { console.log("[dsh-wechat-publish] handler error", e); } catch (e3) {}
		}
	});
};

})();
