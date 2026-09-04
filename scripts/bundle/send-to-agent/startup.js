/*\
title: $:/plugins/dsh/send-to-agent/startup.js
type: application/javascript
module-type: startup

\*/
(function(){

/*jslint node: true, browser: true */
/*global $tw: false */
"use strict";

exports.name = "dsh-send-to-agent";
exports.after = ["story"];
exports.platforms = ["browser"];

function readConfig() {
	var config = { enabled: true, endpoint: "", token: "" };
	try {
		var t = $tw.wiki.getTiddler("$:/plugins/dsh-tiddlywiki/config");
		if (t && t.fields && typeof t.fields.text === "string") {
			var parsed = JSON.parse(t.fields.text);
			var s2a = parsed && parsed.ui && parsed.ui.sendToAgent;
			if (s2a) {
				if (typeof s2a.enabled === "boolean") { config.enabled = s2a.enabled; }
				if (typeof s2a.endpoint === "string" && s2a.endpoint.length > 0) { config.endpoint = s2a.endpoint; }
				if (typeof s2a.token === "string" && s2a.token.length > 0) { config.token = s2a.token; }
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

function notify(msg) {
	if ($tw.notifier && typeof $tw.notifier.display === "function") {
		$tw.notifier.display(msg);
	} else if (typeof alert === "function") {
		alert(msg);
	}
}

function doSend(payload, sessionId, note) {
	var config = readConfig();
	var lines = [];
	lines.push("《" + payload.title + "》");
	lines.push("标签: " + (payload.tags || []).join(", "));
	lines.push("类型: " + (payload.type || "无"));
	lines.push("");
	lines.push("【待办说明】以下内容是我（用户）提前编辑在 TiddlyWiki 知识库中的待办事项，通过「发送给 Agent」一键发送给你处理。请按内容执行；如有任何不清楚的地方，请主动向我提问，不要臆测或擅自发挥。");
	if (note && String(note).trim().length > 0) {
		lines.push("");
		lines.push("【附加说明】" + String(note).trim());
	}
	lines.push("");
	lines.push(payload.text || "");
	var text = lines.join("\n");
	var headers = { "Content-Type": "application/json" };
	if (config.token.length > 0) { headers["x-send-to-agent-token"] = config.token; }
	$tw.utils.httpRequest({
		url: baseEndpoint() + "/agent/send",
		type: "POST",
		headers: headers,
		data: JSON.stringify({ sessionId: sessionId, text: text }),
		callback: function(err, data) {
			var parsed = null;
			try { parsed = JSON.parse(data || ""); } catch (e) {}
			if (err) { notify("发送失败：" + err); return; }
			if (parsed && parsed.ok) {
				notify("已发送 ✓ 会话 " + sessionId.slice(0, 8));
			} else {
				notify("发送失败：" + ((parsed && parsed.error) || data || "未知错误"));
			}
		}
	});
}

function closeOverlay(overlay, escHandler) {
	if (escHandler) { document.removeEventListener("keydown", escHandler); }
	if (overlay && overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
}

function showPicker(payload, items, modes, defaultId, permissions) {
	if (typeof document === "undefined") { return; }
	// remove any previously-open picker
	var old = document.getElementById("dsh-send-picker");
	if (old && old.parentNode) { old.parentNode.removeChild(old); }

	var state = { workspace: null, mode: "", note: "", permission: "" };

	var overlay = document.createElement("div");
	overlay.id = "dsh-send-picker";
	overlay.setAttribute("style", "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);z-index:99999;display:flex;align-items:center;justify-content:center;");
	var box = document.createElement("div");
	box.setAttribute("style", "background:#fff;color:#333;border-radius:8px;padding:14px;min-width:340px;max-width:560px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.3);font-family:system-ui,-apple-system,sans-serif;");

	// header
	var header = document.createElement("div");
	header.setAttribute("style", "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;");
	var h = document.createElement("h3");
	h.setAttribute("style", "margin:0;font-size:15px;");
	h.textContent = "发送给 Agent · 选择目标";
	var closeX = document.createElement("button");
	closeX.type = "button";
	closeX.textContent = "✕";
	closeX.title = "关闭";
	closeX.setAttribute("style", "border:none;background:transparent;font-size:15px;cursor:pointer;color:#888;padding:2px 8px;border-radius:4px;");
	closeX.addEventListener("click", function() { closeOverlay(overlay, escHandler); });
	header.appendChild(h);
	header.appendChild(closeX);
	box.appendChild(header);

	// description
	var desc = document.createElement("p");
	desc.setAttribute("style", "margin:0 0 8px;font-size:12px;color:#888;word-break:break-all;");
	desc.textContent = "《" + payload.title + "》将作为消息注入所选会话";
	box.appendChild(desc);

	// 附加说明（可选）— any extra context the user wants to attach to the
	// message, e.g. what to focus on or how to handle it.
	var noteRow = document.createElement("div");
	noteRow.setAttribute("style", "margin:0 0 8px;");
	var noteLbl = document.createElement("label");
	noteLbl.setAttribute("style", "display:block;font-size:12px;color:#666;margin-bottom:4px;");
	noteLbl.textContent = "附加说明（可选，随笔记一起发给 Agent）";
	noteRow.appendChild(noteLbl);
	var noteTa = document.createElement("textarea");
	noteTa.placeholder = "例如：请重点看第 3 条；我希望你按 XX 方式处理…";
	noteTa.setAttribute("style", "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;min-height:44px;resize:vertical;font-family:inherit;");
	noteTa.addEventListener("input", function() { state.note = noteTa.value; });
	noteRow.appendChild(noteTa);
	box.appendChild(noteRow);

	// 工作模式（Agent 预设）selector — applies to newly created sessions; the
	// modes come from GET /agent/modes (id/name/description + deployment
	// default). When the modes endpoint is unreachable (e.g. an older host) the
	// row degrades to a hint and no mode is sent — DSH uses its default.
	var modeRow = document.createElement("div");
	modeRow.setAttribute("style", "margin:0 0 8px;");
	if (modes && modes.length > 0) {
		var modeLbl = document.createElement("label");
		modeLbl.setAttribute("style", "display:block;font-size:12px;color:#666;margin-bottom:4px;");
		modeLbl.textContent = "工作模式（Agent 预设）— 用于新建会话";
		modeRow.appendChild(modeLbl);
		var sel = document.createElement("select");
		sel.setAttribute("style", "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;");
		var optDefault = document.createElement("option");
		optDefault.value = "";
		optDefault.textContent = "（默认模式）";
		sel.appendChild(optDefault);
		modes.forEach(function(m) {
			var o = document.createElement("option");
			o.value = m.id || "";
			o.textContent = (m.name || m.id) + (m.isDefault ? "（默认）" : "");
			sel.appendChild(o);
		});
		// preselect the deployment default when listed
		if (defaultId) {
			for (var i = 0; i < sel.options.length; i++) {
				if (sel.options[i].value === defaultId) { sel.selectedIndex = i; break; }
			}
		}
		state.mode = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].value : "";
		sel.addEventListener("change", function() { state.mode = sel.value; });
		modeRow.appendChild(sel);
	} else {
		var modeHint = document.createElement("p");
		modeHint.setAttribute("style", "margin:0;font-size:12px;color:#999;");
		modeHint.textContent = "（未获取到可用工作模式，将使用 DSH 默认模式）";
		modeRow.appendChild(modeHint);
	}
	box.appendChild(modeRow);

	// 权限（权限预设）selector — applies to newly created sessions only; the
	// options come from GET /agent/modes' `permissions` roster (each bundles a
	// sandbox mode + approval policy). Existing sessions keep their own
	// permission, so this only affects "新建会话并发送".
	var permRow = document.createElement("div");
	permRow.setAttribute("style", "margin:0 0 8px;");
	if (permissions && Array.isArray(permissions.items) && permissions.items.length > 0) {
		var permLbl = document.createElement("label");
		permLbl.setAttribute("style", "display:block;font-size:12px;color:#666;margin-bottom:4px;");
		permLbl.textContent = "权限（权限预设）— 用于新建会话";
		permRow.appendChild(permLbl);
		var psel = document.createElement("select");
		psel.setAttribute("style", "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;");
		permissions.items.forEach(function(p) {
			var o = document.createElement("option");
			o.value = p.value || "";
			o.textContent = p.name || p.value;
			if (p.description) { o.title = p.description; }
			psel.appendChild(o);
		});
		// preselect the deployment default when listed
		if (permissions.defaultId) {
			for (var j = 0; j < psel.options.length; j++) {
				if (psel.options[j].value === permissions.defaultId) { psel.selectedIndex = j; break; }
			}
		}
		state.permission = psel.options[psel.selectedIndex] ? psel.options[psel.selectedIndex].value : "";
		psel.addEventListener("change", function() { state.permission = psel.value; });
		permRow.appendChild(psel);
	} else {
		var permHint = document.createElement("p");
		permHint.setAttribute("style", "margin:0;font-size:12px;color:#999;");
		permHint.textContent = "（未获取到权限预设，新建会话将使用 DSH 默认权限）";
		permRow.appendChild(permHint);
	}
	box.appendChild(permRow);

	// scrollable body
	var body = document.createElement("div");
	body.setAttribute("style", "overflow:auto;flex:1;min-height:0;");
	box.appendChild(body);

	// footer with cancel
	var footer = document.createElement("div");
	footer.setAttribute("style", "display:flex;justify-content:flex-end;gap:8px;margin-top:10px;");
	var cancel = document.createElement("button");
	cancel.type = "button";
	cancel.textContent = "取消";
	cancel.setAttribute("style", "padding:6px 14px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;");
	cancel.addEventListener("click", function() { closeOverlay(overlay, escHandler); });
	footer.appendChild(cancel);
	box.appendChild(footer);

	overlay.appendChild(box);
	document.body.appendChild(overlay);

	// backdrop click + Esc close
	overlay.addEventListener("click", function(e) {
		if (e.target === overlay) { closeOverlay(overlay, escHandler); }
	});
	var escHandler = function(e) { if (e.key === "Escape") { closeOverlay(overlay, escHandler); } };
	document.addEventListener("keydown", escHandler);

	// group sessions by workspace (cwd)
	var groups = {};
	var order = [];
	(items || []).forEach(function(s) {
		var key = (s.cwd && String(s.cwd).length > 0) ? s.cwd : "__default__";
		if (!groups[key]) { groups[key] = { cwd: s.cwd, sessions: [], max: 0 }; order.push(key); }
		groups[key].sessions.push(s);
		if ((s.updatedAt || 0) > groups[key].max) { groups[key].max = s.updatedAt || 0; }
	});
	order.sort(function(a, b) { return groups[b].max - groups[a].max; });

	function btnStyle() {
		return "display:block;width:100%;text-align:left;padding:8px 10px;margin:4px 0;border:1px solid #ddd;border-radius:6px;background:#f7f7f7;cursor:pointer;font-size:13px;";
	}
	function primaryBtnStyle() {
		return "display:block;width:100%;text-align:center;padding:7px 10px;margin:6px 0 0;border:1px solid #4a90d9;border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer;font-size:13px;";
	}
	function smallBtnStyle() {
		return "margin:0 0 6px;padding:4px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;color:#555;";
	}

	function shortSessionLabel(s) {
		var id = s.sessionId || "";
		var parts = id.split("-");
		var short = (parts.length > 1 ? parts[parts.length - 1] : id).slice(-10);
		var when = "";
		if (s.updatedAt) {
			var diff = Date.now() - s.updatedAt;
			if (diff < 60000) { when = "刚刚"; }
			else if (diff < 3600000) { when = Math.floor(diff / 60000) + " 分钟前"; }
			else if (diff < 86400000) { when = Math.floor(diff / 3600000) + " 小时前"; }
			else {
				var d = new Date(s.updatedAt);
				when = (d.getMonth() + 1) + "-" + d.getDate() + " " + ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
			}
		}
		return "#" + short + (when ? "  ·  " + when : "") + (s.running ? "  ·  ●运行中" : "") + (s.blank ? "  ·  (空)" : "");
	}

	function modeName(id) {
		if (!id) { return ""; }
		for (var i = 0; i < (modes || []).length; i++) {
			if (modes[i].id === id) { return modes[i].name || modes[i].id; }
		}
		return id;
	}

	function render() {
		body.innerHTML = "";
		if (state.workspace === null) { renderWorkspaces(); } else { renderSessions(state.workspace); }
	}

	function renderWorkspaces() {
		if (order.length === 0) {
			var none = document.createElement("p");
			none.textContent = "还没有任何会话——在下方新建一个吧";
			none.setAttribute("style", "color:#999;font-size:13px;margin:0 0 8px;");
			body.appendChild(none);
		} else {
			order.forEach(function(key) {
				var g = groups[key];
				var label = g.cwd || "(默认工作区)";
				var b = document.createElement("button");
				b.type = "button";
				b.setAttribute("style", btnStyle());
				b.textContent = "📁 " + label + "  ·  " + g.sessions.length + " 个会话";
				b.title = g.cwd || "默认工作区";
				b.addEventListener("click", function() { state.workspace = key; render(); });
				body.appendChild(b);
			});
		}
		// new workspace / session
		var newRow = document.createElement("div");
		newRow.setAttribute("style", "margin-top:10px;border-top:1px solid #eee;padding-top:8px;");
		var lbl = document.createElement("p");
		lbl.textContent = "新建工作区 / 会话";
		lbl.setAttribute("style", "margin:0 0 6px;font-size:12px;color:#666;");
		newRow.appendChild(lbl);
		var input = document.createElement("input");
		input.type = "text";
		input.placeholder = "输入工作区路径，留空为默认工作区";
		input.setAttribute("style", "width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;");
		newRow.appendChild(input);
		var go = document.createElement("button");
		go.type = "button";
		go.textContent = "创建并发送";
		go.setAttribute("style", primaryBtnStyle());
		go.addEventListener("click", function() { createAndSend(payload, input.value.trim()); });
		newRow.appendChild(go);
		input.addEventListener("keydown", function(e) { if (e.key === "Enter") { createAndSend(payload, input.value.trim()); } });
		body.appendChild(newRow);
	}

	function renderSessions(key) {
		var g = groups[key];
		var back = document.createElement("button");
		back.type = "button";
		back.textContent = "← 返回工作区列表";
		back.setAttribute("style", smallBtnStyle());
		back.addEventListener("click", function() { state.workspace = null; render(); });
		body.appendChild(back);

		var wsName = document.createElement("p");
		wsName.textContent = g.cwd ? "📁 " + g.cwd : "(默认工作区)";
		wsName.setAttribute("style", "margin:0 0 6px;font-size:13px;font-weight:600;word-break:break-all;");
		body.appendChild(wsName);

		(g.sessions || []).forEach(function(s) {
			var b = document.createElement("button");
			b.type = "button";
			b.setAttribute("style", btnStyle());
			var label = shortSessionLabel(s);
			if (s.agentPreset) { label += "  ·  🧭 " + modeName(s.agentPreset); }
			b.textContent = label;
			b.title = "会话 " + s.sessionId + (s.agentPreset ? " · 工作模式 " + modeName(s.agentPreset) : "");
			b.addEventListener("click", function() { closeOverlay(overlay, escHandler); doSend(payload, s.sessionId, state.note); });
			body.appendChild(b);
		});

		var newBtn = document.createElement("button");
		newBtn.type = "button";
		newBtn.textContent = "➕ 在此工作区新建会话并发送";
		newBtn.setAttribute("style", primaryBtnStyle());
		newBtn.addEventListener("click", function() { createAndSend(payload, g.cwd); });
		body.appendChild(newBtn);
	}

	function createAndSend(payload2, cwd) {
		var config = readConfig();
		var headers = { "Content-Type": "application/json" };
		if (config.token.length > 0) { headers["x-send-to-agent-token"] = config.token; }
		var body = { cwd: cwd || "" };
		if (state.mode && String(state.mode).length > 0) { body.mode = state.mode; }
		if (state.permission && String(state.permission).length > 0) { body.permission = state.permission; }
		$tw.utils.httpRequest({
			url: baseEndpoint() + "/agent/create",
			type: "POST",
			headers: headers,
			data: JSON.stringify(body),
			callback: function(err, data) {
				var parsed = null;
				try { parsed = JSON.parse(data || ""); } catch (e) {}
				if (err) { notify("新建会话失败：" + err); return; }
				if (parsed && parsed.ok && parsed.sessionId) {
					closeOverlay(overlay, escHandler);
					var modeNote = parsed.mode ? "（模式 " + modeName(parsed.mode) + "）" : "";
					var permNote = parsed.permissionApplied ? "（权限 " + (parsed.permission || "") + "）" : "";
					notify("已创建会话并发送 ✓ " + parsed.sessionId.slice(0, 8) + modeNote + permNote);
					doSend(payload2, parsed.sessionId, state.note);
				} else {
					notify("新建会话失败：" + ((parsed && parsed.error) || data || "未知错误"));
				}
			}
		});
	}

	render();
}

function handleSend(title) {
	if (!title) { notify("无法确定当前笔记标题"); return; }
	var tiddler = $tw.wiki.getTiddler(title);
	if (!tiddler) { notify("找不到笔记：" + title); return; }
	var config = readConfig();
	if (!config.enabled) { notify("「发送给 Agent」特性未启用（可在 TW 配置中打开）"); return; }
	var payload = {
		title: title,
		text: tiddler.fields.text || "",
		tags: tiddler.fields.tags || [],
		type: tiddler.fields.type || ""
	};
	var headers = {};
	if (config.token.length > 0) { headers["x-send-to-agent-token"] = config.token; }
	$tw.utils.httpRequest({
		url: baseEndpoint() + "/agent/sessions",
		type: "GET",
		headers: headers,
		callback: function(err, data) {
			var parsed = null;
			try { parsed = JSON.parse(data || ""); } catch (e) {}
			if (err) { notify("获取会话列表失败：" + err); return; }
			if (!parsed || !parsed.ok || !parsed.items) { notify("获取会话列表失败：" + ((parsed && parsed.error) || "未知错误")); return; }
			// fetch the available 工作模式 (Agent presets) alongside; degrade to
			// an empty roster (default mode) when the endpoint is missing.
			$tw.utils.httpRequest({
				url: baseEndpoint() + "/agent/modes",
				type: "GET",
				headers: headers,
				callback: function(err2, data2) {
					var modes = [];
					var defaultId = "";
					var permissions = null;
					var parsed2 = null;
					try { parsed2 = JSON.parse(data2 || ""); } catch (e) {}
					if (!err2 && parsed2 && parsed2.ok) {
						if (Array.isArray(parsed2.items)) {
							modes = parsed2.items;
							defaultId = parsed2.defaultId || "";
						}
						if (parsed2.permissions && Array.isArray(parsed2.permissions.items)) {
							permissions = parsed2.permissions;
						}
					}
					showPicker(payload, parsed.items, modes, defaultId, permissions);
				}
			});
		}
	});
}

exports.startup = function() {
	console.log("[dsh-send-to-agent] startup ran");
	if (!$tw.rootWidget || typeof $tw.rootWidget.addEventListener !== "function") { return; }
	$tw.rootWidget.addEventListener("dsh-send-to-agent", function(event) {
		handleSend(event.param);
	});
};

})();
