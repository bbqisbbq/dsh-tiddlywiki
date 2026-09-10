import { createRequire } from "node:module";
import { existsSync, watch } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createServer as createServer$1 } from "node:http";
import { homedir } from "node:os";
//#region src/host/git.ts
/**
* Git face (design doc §7, D11) — the ONLY place dsh-tiddlywiki shells out to
* git. The wiki folder itself is the repository; the folder is pure text
* (FileSystemAdaptor writes one file per tiddler), so git is a natural sync /
* backup channel.
*
* Sync model is the single-thread alternating one:
*   1. start of work:  `git pull --rebase --autostash`
*   2. end of work:    `git add -A && git commit && git push`
*   3. auto-commit:    debounced 60s commit after wiki writes (AutoCommitter)
*
* Conflict policy (user-confirmed, no complex handling): a rebase conflict
* (only reachable by "forgot to pull before writing") → `git rebase --abort`
* + report the unmerged files. Never auto-merge data.
*
* @module dsh-tiddlywiki/host/git
*/
const execFileP = promisify(execFile);
/** Timeout for quick read-only queries. */
const QUICK_TIMEOUT_MS = 5e3;
/** Timeout for structural/network operations. */
const HEAVY_TIMEOUT_MS = 6e4;
/** Default exec layer: run `git <args>` under a cwd with a timeout. */
const defaultExec = async (args, options) => {
	try {
		const { stdout, stderr } = await execFileP("git", args, {
			cwd: options.cwd,
			timeout: options.timeout ?? QUICK_TIMEOUT_MS,
			windowsHide: true,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024
		});
		return {
			ok: true,
			stdout,
			stderr
		};
	} catch (err) {
		const e = err;
		return {
			ok: false,
			stdout: e.stdout ?? "",
			stderr: e.stderr ?? String(e.message ?? err)
		};
	}
};
function parseCount(line, re) {
	const m = line.match(re);
	return m === null ? void 0 : Number(m[1]);
}
var GitFace = class {
	exec;
	constructor(exec = defaultExec) {
		this.exec = exec;
	}
	async isRepo(dir) {
		const r = await this.exec(["rev-parse", "--is-inside-work-tree"], {
			cwd: dir,
			timeout: 2e3
		});
		return r.ok && r.stdout.trim() === "true";
	}
	async init(dir, branch = "main") {
		return (await this.exec([
			"init",
			"-b",
			branch
		], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		})).ok;
	}
	/** Initial commit for a fresh repo (tolerates an empty index). */
	async initialCommit(dir) {
		await this.exec(["add", "-A"], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		const r = await this.exec([
			...identity(),
			"commit",
			"-m",
			"chore(dsh-tiddlywiki): initial commit"
		], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		return r.ok || /nothing to commit/.test(r.stderr + r.stdout);
	}
	/**
	* Stage everything and commit; a local identity is always provided so the
	* plugin never depends on the machine's global git config. Returns whether
	* a commit actually happened.
	*/
	async commit(dir, message) {
		await this.exec(["add", "-A"], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		if ((await this.exec([
			"diff",
			"--cached",
			"--quiet"
		], {
			cwd: dir,
			timeout: QUICK_TIMEOUT_MS
		})).ok) return {
			committed: false,
			message: "nothing to commit"
		};
		const r = await this.exec([
			...identity(),
			"commit",
			"-m",
			message
		], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		return r.ok ? {
			committed: true,
			message
		} : {
			committed: false,
			message: `commit failed: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 500)}`
		};
	}
	async status(dir) {
		const empty = {
			exists: false,
			branch: "",
			dirty: false,
			dirtyFiles: [],
			remote: ""
		};
		const r = await this.exec([
			"status",
			"--porcelain",
			"-b"
		], {
			cwd: dir,
			timeout: QUICK_TIMEOUT_MS
		});
		if (!r.ok) return empty;
		const lines = r.stdout.split("\n").filter((l) => l.length > 0);
		const branchLine = lines.find((l) => l.startsWith("## "));
		const branch = branchLine === void 0 ? "" : branchLine.slice(3).split("...")[0] ?? "";
		const ahead = branchLine === void 0 ? void 0 : parseCount(branchLine, /ahead (\d+)/);
		const behind = branchLine === void 0 ? void 0 : parseCount(branchLine, /behind (\d+)/);
		const dirty = lines.some((l) => !l.startsWith("## "));
		const dirtyFiles = lines.filter((l) => !l.startsWith("## ")).map((l) => l.slice(3).trim()).filter(Boolean);
		const remoteR = await this.exec(["remote", "-v"], {
			cwd: dir,
			timeout: QUICK_TIMEOUT_MS
		});
		const remote = remoteR.ok ? remoteR.stdout.split("\n").map((l) => l.trim()).find(Boolean) ?? "" : "";
		const lastR = await this.exec([
			"log",
			"-1",
			"--format=%h %s"
		], {
			cwd: dir,
			timeout: QUICK_TIMEOUT_MS
		});
		const lastCommit = lastR.ok && lastR.stdout.trim().length > 0 ? lastR.stdout.trim() : void 0;
		return {
			exists: true,
			branch,
			dirty,
			dirtyFiles,
			remote,
			...lastCommit !== void 0 ? { lastCommit } : {},
			...ahead !== void 0 ? { ahead } : {},
			...behind !== void 0 ? { behind } : {}
		};
	}
	/** `git pull --rebase --autostash`; on conflict: abort + report files.
	*  On success, `changed: true` means HEAD actually moved (files came in /
	*  commits were replayed) — callers use it to decide whether a running TW
	*  child needs a restart to drop its stale in-memory snapshot. */
	async pull(dir) {
		const before = await this.exec(["rev-parse", "HEAD"], {
			cwd: dir,
			timeout: QUICK_TIMEOUT_MS
		});
		const beforeHead = before.ok ? before.stdout.trim() : "";
		const r = await this.exec([
			"pull",
			"--rebase",
			"--autostash"
		], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		if (r.ok) {
			const after = await this.exec(["rev-parse", "HEAD"], {
				cwd: dir,
				timeout: QUICK_TIMEOUT_MS
			});
			const afterHead = after.ok ? after.stdout.trim() : "";
			const changed = beforeHead.length > 0 && beforeHead !== afterHead;
			return {
				ok: true,
				message: r.stdout.trim() || "pull ok",
				...changed ? { changed: true } : {}
			};
		}
		const conflictFiles = await this.unmergedFiles(dir);
		await this.exec(["rebase", "--abort"], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		const reason = (r.stderr.trim() || r.stdout.trim()).slice(0, 500);
		return {
			ok: false,
			message: conflictFiles.length > 0 ? `conflict in ${conflictFiles.join(", ")} (rebase aborted): ${reason}` : `pull failed: ${reason}`,
			...conflictFiles.length > 0 ? { conflictFiles } : {}
		};
	}
	async push(dir) {
		const r = await this.exec(["push"], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		return r.ok ? {
			ok: true,
			message: r.stdout.trim() || "push ok"
		} : {
			ok: false,
			message: (r.stderr.trim() || r.stdout.trim()).slice(0, 500)
		};
	}
	/** First push with upstream tracking (called once after a remote is set). */
	async firstPush(dir) {
		const branch = (await this.status(dir)).branch || "main";
		const r = await this.exec([
			"push",
			"-u",
			"origin",
			branch
		], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		return r.ok ? {
			ok: true,
			message: `pushed ${branch} to origin`
		} : {
			ok: false,
			message: (r.stderr.trim() || r.stdout.trim()).slice(0, 500)
		};
	}
	/** `git fetch` (no remote configured → failure reported by the caller). */
	async fetch(dir) {
		const r = await this.exec(["fetch"], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		return r.ok ? {
			ok: true,
			message: r.stdout.trim() || "fetch ok"
		} : {
			ok: false,
			message: (r.stderr.trim() || r.stdout.trim()).slice(0, 500)
		};
	}
	/**
	* Restore the given files from the freshly fetched remote HEAD (FETCH_HEAD)
	* into the working tree + index — the "keep remote version" half of
	* tiddler-granular conflict resolution. Callers must `git fetch` first.
	*/
	async checkoutFetchHead(dir, files) {
		if (files.length === 0) return {
			ok: true,
			message: "no files given"
		};
		const r = await this.exec([
			"checkout",
			"FETCH_HEAD",
			"--",
			...files
		], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		return r.ok ? {
			ok: true,
			message: `已从远端检出 ${files.length} 个文件`
		} : {
			ok: false,
			message: (r.stderr.trim() || r.stdout.trim()).slice(0, 500)
		};
	}
	/** Ensure `origin` points at `url` (add or set-url). */
	async ensureRemote(dir, url) {
		const cur = await this.exec([
			"remote",
			"get-url",
			"origin"
		], {
			cwd: dir,
			timeout: QUICK_TIMEOUT_MS
		});
		if (cur.ok) {
			if (cur.stdout.trim() === url) return {
				ok: true,
				message: "remote origin already set"
			};
			const set = await this.exec([
				"remote",
				"set-url",
				"origin",
				url
			], {
				cwd: dir,
				timeout: HEAVY_TIMEOUT_MS
			});
			return set.ok ? {
				ok: true,
				message: `remote origin → ${url}`
			} : {
				ok: false,
				message: set.stderr.trim() || "remote set-url failed"
			};
		}
		const add = await this.exec([
			"remote",
			"add",
			"origin",
			url
		], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		return add.ok ? {
			ok: true,
			message: `remote origin → ${url}`
		} : {
			ok: false,
			message: add.stderr.trim() || "remote add failed"
		};
	}
	async unmergedFiles(dir) {
		const r = await this.exec([
			"diff",
			"--name-only",
			"--diff-filter=U"
		], {
			cwd: dir,
			timeout: QUICK_TIMEOUT_MS
		});
		return r.ok ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
	}
};
/** Always-on local identity so commits never depend on global git config. */
function identity() {
	return [
		"-c",
		"user.name=dsh-tiddlywiki",
		"-c",
		"user.email=dsh-tiddlywiki@local"
	];
}
/**
* Debounced auto-committer: every wiki write calls `touch()`; the commit
* fires once writes settle for `debounceMs`. Disable with git.autoCommit.
*/
var AutoCommitter = class {
	options;
	timer;
	disposed = false;
	constructor(options) {
		this.options = options;
	}
	touch() {
		if (!this.options.enabled || this.disposed) return;
		if (this.timer !== void 0) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.flush();
		}, this.options.debounceMs);
	}
	/** Run a commit now (also cancels the pending debounce). */
	async flush() {
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
		if (!this.options.enabled || this.disposed) return;
		try {
			const result = await this.options.git.commit(this.options.dir, this.options.message());
			this.options.onCommit?.(result);
		} catch (err) {
			this.options.onError?.(err);
		}
	}
	dispose() {
		this.disposed = true;
		if (this.timer !== void 0) {
			clearTimeout(this.timer);
			this.timer = void 0;
		}
	}
};
//#endregion
//#region src/host/wiki.ts
/**
* WikiServer — the TiddlyWiki 5 child-process lifecycle (design doc §9, D3).
*
* Zero-friction rules:
* - ensure the wiki folder exists (scaffold with `--init server` once)
* - git bootstrap is NOT this class's job (index.ts owns the GitFace)
* - auto-detect a free loopback port unless one is pinned in config
* - spawn `node <tw>/tiddlywiki.js <wiki> --listen host=127.0.0.1 ...`
*   and poll /status until it answers 200
* - the TW child serves at the ROOT of its own dedicated loopback port (no
*   `path-prefix`): TW's browser frontend builds its API URLs from
*   `$protocol$//$host$/` only, so any path-prefix makes every frontend call
*   ../../status → 404 (verified against tiddlywiki 5.4.1). Namespacing lives
*   on the DSH webserver side (/dsh-tiddlywiki/* routes), never in TW itself.
* - crash → restart with exponential backoff (1s,2s,4s… cap 30s), reset on
*   a successful readiness
* - stop() is deterministic: SIGTERM, escalate to SIGKILL after a grace
*   period, and never leave a timer that would respawn during teardown
*
* @module dsh-tiddlywiki/host/wiki
*/
/** The DSH webserver route prefix (NOT a TW path-prefix; see module header). */
const PATH_PREFIX = "/dsh-tiddlywiki";
/**
* Same-origin TW proxy route on the DSH webserver (remote-access mode, R1).
* The browser only ever talks to the DSH origin — which it already reaches
* over loopback, LAN, Tailscale, a domain or HTTPS — and DSH proxies to the
* loopback TW child. TW's frontend is pointed at this prefix via the
* `$:/config/tiddlyweb/host` tiddler so every API call stays same-origin.
*/
const TW_PROXY_PREFIX = `${PATH_PREFIX}/tw`;
/** The proxy base path (trailing slash) handed to browsers / TW's frontend. */
const TW_PROXY_PATH = `${TW_PROXY_PREFIX}/`;
/** How long to wait for the wiki to answer /status. */
const READY_TIMEOUT_MS = 2e4;
/** Poll cadence while waiting for readiness. */
const READY_POLL_MS = 500;
/** Backoff ceiling for crash restarts. */
const MAX_RESTART_BACKOFF_MS = 3e4;
/** SIGTERM → SIGKILL escalation grace. */
const KILL_GRACE_MS = 3e3;
/** Ring-buffer cap for the stdout/stderr log. */
const LOG_BUFFER_LIMIT = 200;
/** One-shot scaffold timeout for `--init server`. */
const INIT_TIMEOUT_MS = 3e4;
/** Resolve the absolute entry of the installed `tiddlywiki` package. */
function resolveTwEntry() {
	return createRequire(import.meta.url).resolve("tiddlywiki/tiddlywiki.js");
}
var WikiServer = class {
	options;
	child;
	wikiPath;
	logs = [];
	logLimit;
	health = "stopped";
	port;
	stopping = false;
	restartTimer;
	restartDelay = 1e3;
	lastStartedAt;
	error;
	constructor(options) {
		this.options = options;
		this.wikiPath = resolve(options.wikiRoot, options.wiki);
		this.logLimit = options.logBufferLimit ?? LOG_BUFFER_LIMIT;
	}
	/** Base URL of the TW service, once a port is bound (root, no path prefix). */
	get url() {
		return this.port === void 0 ? void 0 : `http://127.0.0.1:${this.port}`;
	}
	/** The currently bound port (undefined until first spawn). */
	get currentPort() {
		return this.port;
	}
	log(line) {
		const ts = (/* @__PURE__ */ new Date()).toISOString();
		this.logs.push(`[${ts}] ${line}`);
		if (this.logs.length > this.logLimit) this.logs.splice(0, this.logs.length - this.logLimit);
	}
	/** Scaffold the wiki folder with `--init server` when it is absent. */
	async ensureWiki() {
		await mkdir(this.wikiPath, { recursive: true });
		if (existsSync(join(this.wikiPath, "tiddlywiki.info"))) return;
		const tw = resolveTwEntry();
		this.log(`init: ${process.execPath} ${tw} ${this.wikiPath} --init server`);
		await new Promise((resolveP, rejectP) => {
			execFile(process.execPath, [
				tw,
				this.wikiPath,
				"--init",
				"server"
			], {
				timeout: INIT_TIMEOUT_MS,
				windowsHide: true
			}, (err) => {
				if (err) rejectP(err);
				else resolveP();
			});
		});
	}
	/** Probe a free loopback port. */
	async findFreePort() {
		return new Promise((resolveP, rejectP) => {
			const server = createServer();
			server.unref();
			server.once("error", rejectP);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (address === null || typeof address === "string") {
					server.close();
					rejectP(/* @__PURE__ */ new Error("cannot resolve a free port"));
					return;
				}
				const port = address.port;
				server.close(() => resolveP(port));
			});
		});
	}
	/**
	* Start (or restart) the TW child. Resolves once `/status` answers 200 or
	* the readiness deadline passes. Never throws on a crash — the exit handler
	* schedules a self-healing restart unless we are stopping.
	*/
	async start() {
		this.stopping = false;
		this.restartDelay = 1e3;
		await this.ensureWiki();
		if (this.child !== void 0) return this.status();
		this.health = "starting";
		const port = this.options.port > 0 ? this.options.port : (this.port ?? 0) > 0 ? this.port : await this.findFreePort();
		this.port = port;
		const args = [
			resolveTwEntry(),
			this.wikiPath,
			"--listen",
			"host=127.0.0.1",
			`port=${port}`
		];
		if (this.options.username) {
			args.push(`username=${this.options.username}`);
			args.push(`password=${this.options.password ?? ""}`);
			args.push(`readers=${this.options.username}`);
			args.push(`writers=${this.options.username}`);
		}
		this.log(`spawn: ${process.execPath} ${args.join(" ")}`);
		const child = spawn(process.execPath, args, {
			cwd: this.wikiPath,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		this.child = child;
		child.stdout.on("data", (chunk) => this.log(`[out] ${String(chunk).trimEnd()}`));
		child.stderr.on("data", (chunk) => this.log(`[err] ${String(chunk).trimEnd()}`));
		child.once("exit", (code, signal) => {
			this.log(`exit code=${code} signal=${signal ?? ""} stopping=${this.stopping}`);
			this.child = void 0;
			this.health = "stopped";
			if (!this.stopping) this.scheduleRestart();
		});
		child.once("error", (err) => {
			this.log(`spawn error: ${err.message}`);
			this.error = err.message;
			this.child = void 0;
			this.health = "failed";
			if (!this.stopping) this.scheduleRestart();
		});
		this.lastStartedAt = Date.now();
		await this.waitReady();
		return this.status();
	}
	/** Poll /status until 200 or the deadline; throws only on deadline/crash. */
	async waitReady() {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		for (;;) {
			if (this.child === void 0) throw new Error("wiki process exited before ready");
			try {
				if ((await fetch(`${this.url}/status`, { signal: AbortSignal.timeout(2e3) })).ok) {
					this.health = "running";
					this.log("ready: /status 200");
					return;
				}
			} catch {}
			if (Date.now() > deadline) {
				this.health = "failed";
				this.error = "wiki server did not become ready in time";
				this.log(this.error);
				throw new Error(this.error);
			}
			await new Promise((r) => setTimeout(r, READY_POLL_MS));
		}
	}
	scheduleRestart() {
		if (this.stopping || this.restartTimer !== void 0) return;
		const delay = this.restartDelay;
		this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_BACKOFF_MS);
		this.log(`restart scheduled in ${delay}ms`);
		this.health = "starting";
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			this.start().catch((err) => {
				this.health = "failed";
				this.error = err instanceof Error ? err.message : String(err);
				this.log(`restart failed: ${this.error}`);
			});
		}, delay);
	}
	/** One-click restart (route /dsh-tiddlywiki/restart, panel retry button). */
	async restart() {
		await this.stop();
		return this.start();
	}
	/** Deterministic teardown: cancel timers, SIGTERM, escalate to SIGKILL. */
	async stop() {
		this.stopping = true;
		if (this.restartTimer !== void 0) {
			clearTimeout(this.restartTimer);
			this.restartTimer = void 0;
		}
		const child = this.child;
		this.child = void 0;
		if (child !== void 0 && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGTERM");
			} catch {}
			await Promise.race([new Promise((r) => child.once("exit", () => r())), new Promise((r) => {
				setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {}
					r();
				}, KILL_GRACE_MS).unref?.();
			})]);
		}
		this.health = "stopped";
	}
	/** Live status view (health, url, git-independent, recent logs). */
	status() {
		return {
			status: this.health,
			url: this.url,
			port: this.port,
			wikiPath: this.wikiPath,
			pid: this.child?.pid,
			lastStartedAt: this.lastStartedAt,
			...this.error !== void 0 ? { error: this.error } : {},
			logs: [...this.logs]
		};
	}
};
//#endregion
//#region src/host/session-summary.ts
/** 会话汇总 tiddler 的 $:/temp 命名空间前缀。 */
const SESSION_SUMMARY_PREFIX = "$:/temp/dsh/session-summary/";
/** 会话内能触达 wiki 的 tiddlywiki_* 工具名（search/recent 只记检索记录，不算单篇）。 */
const NOTE_TOOL_NAMES = /* @__PURE__ */ new Set([
	"tiddlywiki_put",
	"tiddlywiki_batch_put",
	"tiddlywiki_rename",
	"tiddlywiki_get",
	"tiddlywiki_search",
	"tiddlywiki_recent"
]);
/** 递归收集后代树里所有 session id（不含根自身）。 */
function collectDescendantIds(nodes, out) {
	if (!Array.isArray(nodes)) return;
	for (const node of nodes) {
		const id = node?.session?.header?.id;
		if (typeof id === "string" && id.length > 0) {
			out.push(id);
			collectDescendantIds(node?.descendants, out);
		}
	}
}
/**
* 汇总条目会直接写进 `[[标题]]` wikitext——标题既要能安全渲染、又不能制造死链。
* 会话日志里常混入模型的示例/残缺写法（`#…`、`#标题`、带反引号的截断链接、
* 控制字符等），这类收进来会被 TW 渲染成「佚失条目」；一律过滤。
*/
function isPlausibleTitle(title) {
	if (title.length === 0 || title.length > 300) return false;
	if (title.trim().length === 0) return false;
	if (/[\u0000-\u001f\u007f]/.test(title)) return false;
	if (/[\]|`#]/.test(title)) return false;
	if (title.startsWith("…") || title === "标题") return false;
	return true;
}
/** 记录一篇笔记的触达；同标题合并（时间取最新、detail 取最新、subagent 取 AND）。 */
function record(map, entry) {
	if (entry.title.startsWith("$:/")) return;
	if (!isPlausibleTitle(entry.title)) return;
	const prev = map.get(entry.title);
	if (prev !== void 0) {
		prev.time = Math.max(prev.time, entry.time);
		if (entry.detail !== void 0) prev.detail = entry.detail;
		prev.subagent = prev.subagent && entry.subagent;
		return;
	}
	map.set(entry.title, { ...entry });
}
/** 扫助手回复文本里的 `/dsh-tiddlywiki/tw/#标题` 引用链接 → 读取。 */
function scanRefs(text, time, subagent, collected) {
	const re = /\/dsh-tiddlywiki\/tw\/#([^#)\s\]]+)/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		const raw = m[1] ?? "";
		if (raw.length === 0) continue;
		let title = raw;
		try {
			title = decodeURIComponent(raw);
		} catch {}
		if (title.length === 0) continue;
		record(collected.read, {
			title,
			action: "read",
			time,
			subagent
		});
	}
}
/** 扫描一次会话的事件日志，按 §三 规则收集笔记触达与检索记录。 */
function scanSnapshot(snap, subagent, collected) {
	const events = snap?.events;
	if (!Array.isArray(events)) return;
	for (const ev of events) {
		const type = ev?.type;
		const t = typeof ev?.time === "number" ? ev.time : Date.now();
		if (type === "tool/call") {
			const name = ev.data?.name;
			if (typeof name !== "string" || !NOTE_TOOL_NAMES.has(name)) continue;
			let args = {};
			if (typeof ev.data?.arguments === "string") try {
				args = JSON.parse(ev.data.arguments);
			} catch {
				args = {};
			}
			switch (name) {
				case "tiddlywiki_put":
					if (typeof args.title === "string" && args.title.length > 0) record(collected.produced, {
						title: args.title,
						action: "produced",
						time: t,
						subagent
					});
					break;
				case "tiddlywiki_batch_put":
					if (Array.isArray(args.items)) {
						for (const item of args.items) if (item !== null && typeof item === "object" && typeof item.title === "string") {
							const title = item.title;
							if (title.length > 0) record(collected.produced, {
								title,
								action: "produced",
								time: t,
								subagent
							});
						}
					}
					break;
				case "tiddlywiki_rename":
					if (typeof args.newTitle === "string" && args.newTitle.length > 0) {
						const old = typeof args.oldTitle === "string" && args.oldTitle.length > 0 ? args.oldTitle : void 0;
						record(collected.produced, {
							title: args.newTitle,
							action: "produced",
							time: t,
							detail: old !== void 0 ? `重命名自「${old}」` : void 0,
							subagent
						});
					}
					break;
				case "tiddlywiki_get":
					if (typeof args.title === "string" && args.title.length > 0) record(collected.read, {
						title: args.title,
						action: "read",
						time: t,
						subagent
					});
					break;
				case "tiddlywiki_search": {
					const query = typeof args.query === "string" ? args.query : "";
					const tags = Array.isArray(args.tags) ? args.tags.filter((x) => typeof x === "string") : [];
					collected.searches.push({
						kind: "search",
						query,
						tags,
						time: t,
						subagent
					});
					break;
				}
				case "tiddlywiki_recent":
					collected.searches.push({
						kind: "recent",
						query: "",
						tags: [],
						time: t,
						subagent
					});
					break;
			}
		} else if (type === "assistant/message") {
			const message = ev.data?.message;
			const content = message !== null && typeof message === "object" ? message.content : void 0;
			if (Array.isArray(content)) for (const block of content) {
				if (block === null || typeof block !== "object") continue;
				const b = block;
				if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) scanRefs(b.text, t, subagent, collected);
			}
		}
	}
}
/** 并发（8 路）查询每篇笔记的当前状态（404 → 不存在/已删除）。 */
async function enrichTitles(client, titles) {
	const out = /* @__PURE__ */ new Map();
	const enquire = async (title) => {
		try {
			const t = await client.get(title);
			if (t === void 0) return [title, {
				exists: false,
				tags: []
			}];
			const flat = typeof t.text === "string" ? t.text.replace(/\s+/g, " ").trim() : "";
			return [title, {
				exists: true,
				tags: t.tags ?? [],
				modified: typeof t.modified === "string" ? t.modified : void 0,
				snippet: flat.length > 48 ? `${flat.slice(0, 48)}…` : flat
			}];
		} catch {
			return [title, {
				exists: false,
				tags: []
			}];
		}
	};
	for (let i = 0; i < titles.length; i += 8) {
		const batch = titles.slice(i, i + 8);
		for (const [title, state] of await Promise.all(batch.map(enquire))) out.set(title, state);
	}
	return out;
}
/** epoch ms → 本地 `YYYY-MM-DD HH:mm`。 */
function fmtTime(ms) {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** TW modified ISO → 本地时间（解析失败则原样返回）。 */
function fmtModified(iso) {
	if (iso === void 0 || iso.length === 0) return "";
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? iso : fmtTime(ms);
}
/** 组装分组 wikitext：产生 / 读取（未产生过的）/ 检索记录。 */
function buildWikitext(sessionId, collected, producedTitles, readTitles, stateByTitle) {
	const lines = [];
	lines.push("! 会话相关 wiki 汇总");
	lines.push("");
	lines.push(`本页列出会话 \`${sessionId}\`（含其后代子代理）在本会话中产生 / 读取 / 检索过的知识库笔记。`);
	lines.push("");
	const producedCount = producedTitles.length;
	const readCount = readTitles.length;
	const searchCount = collected.searches.length;
	if (producedCount + readCount + searchCount === 0) {
		lines.push("> 本会话暂时没有产生、读取或检索过任何知识库笔记。");
		lines.push(">");
		lines.push("> 本页为会话自动生成的临时汇总（`$:/temp`，不落盘、不进 git，重启 TW 即消失）；需要时点 Tab 顶栏的「🔄 刷新」重新生成。");
		return lines.join("\n");
	}
	lines.push("| 产生 📝 | 读取 👀 | 检索 🔍 | 涉及会话 |", "| --- | --- | --- | --- |", `| ${producedCount} | ${readCount} | ${searchCount} | ${collected.produced.size + readTitles.length > 0 ? "本会话 + 子代理" : "本会话"} |`);
	lines.push("");
	const entryLine = (title, state, entry) => {
		const bits = [`[[${title}]]`];
		if (state === void 0 || !state.exists) bits.push("⚠️ 已删除/不存在");
		else {
			if (state.tags.length > 0) bits.push(`标签 ${state.tags.slice(0, 6).join("、")}${state.tags.length > 6 ? "…" : ""}`);
			const mod = fmtModified(state.modified);
			if (mod.length > 0) bits.push(`修改 ${mod}`);
		}
		const t = fmtTime(entry.time);
		if (t.length > 0) bits.push(`会话内 ${t}`);
		if (entry.detail !== void 0) bits.push(entry.detail);
		if (entry.subagent) bits.push("（子代理）");
		return `* ${bits.join(" · ")}`;
	};
	if (producedCount > 0) {
		lines.push("!!! 📝 产生");
		for (const title of producedTitles) {
			const entry = collected.produced.get(title);
			if (entry !== void 0) lines.push(entryLine(title, stateByTitle.get(title), entry));
		}
		lines.push("");
	}
	if (readCount > 0) {
		lines.push("!!! 👀 读取");
		for (const title of readTitles) {
			const entry = collected.read.get(title);
			if (entry !== void 0) lines.push(entryLine(title, stateByTitle.get(title), entry));
		}
		lines.push("");
	}
	if (searchCount > 0) {
		lines.push("!!! 🔍 检索记录");
		for (const r of collected.searches) {
			const bits = [];
			if (r.kind === "search") {
				bits.push(`\`tiddlywiki_search\` query=「${r.query.length > 0 ? r.query : "(空)"}」`);
				if (r.tags.length > 0) bits.push(`tags ${r.tags.join("、")}`);
			} else bits.push("`tiddlywiki_recent`（最近修改）");
			const t = fmtTime(r.time);
			if (t.length > 0) bits.push(t);
			if (r.subagent) bits.push("（子代理）");
			lines.push(`* ${bits.join(" · ")}`);
		}
		lines.push("");
	}
	lines.push("---");
	lines.push("> 本页为会话自动生成的临时汇总（`$:/temp`，不落盘、不进 git，重启 TW 即消失）；需要时点 Tab 顶栏的「🔄 刷新」重新生成。");
	return lines.join("\n");
}
/**
* 生成并写入一篇会话汇总 tiddler（$:/temp，volatile）。
* @param client  可用 TW 客户端（调用方已保证 wiki 服务在线）。
* @param sq      sessionQuery 服务（调用方已保证可用）。
* @param sessionId 目标会话 id（本会话 + 后代 subagent）。
*/
async function writeSessionSummary(client, sq, sessionId) {
	const ids = [sessionId];
	try {
		collectDescendantIds((await sq.traceSession(sessionId, AbortSignal.timeout(1e4)))?.descendants, ids);
	} catch {}
	const collected = {
		produced: /* @__PURE__ */ new Map(),
		read: /* @__PURE__ */ new Map(),
		searches: []
	};
	for (const id of ids) try {
		scanSnapshot(await sq.readSession(id), id !== sessionId, collected);
	} catch {}
	const producedTitles = [...collected.produced.keys()].sort((a, b) => (collected.produced.get(b)?.time ?? 0) - (collected.produced.get(a)?.time ?? 0));
	const readTitles = [...collected.read.keys()].filter((t) => !collected.produced.has(t)).sort((a, b) => (collected.read.get(b)?.time ?? 0) - (collected.read.get(a)?.time ?? 0));
	collected.searches.sort((a, b) => b.time - a.time);
	const text = buildWikitext(sessionId, collected, producedTitles, readTitles, await enrichTitles(client, [.../* @__PURE__ */ new Set([...producedTitles, ...readTitles])]));
	const title = `${SESSION_SUMMARY_PREFIX}${sessionId}`;
	await client.put({
		title,
		text,
		type: "text/vnd.tiddlywiki",
		tags: []
	});
	return {
		title,
		counts: {
			produced: producedTitles.length,
			read: readTitles.length,
			searches: collected.searches.length,
			sessions: ids.length
		},
		empty: producedTitles.length + readTitles.length + collected.searches.length === 0,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
}
//#endregion
//#region src/host/http.ts
/** Default cap for small JSON bodies (note/restart/config…). */
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
/** Cap for the /api passthrough body (tiddler content can be large). */
const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;
/** Cap for uploaded file bodies (/tw proxy, /upload). */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
function readBodyStream(req, limit, encoding) {
	return new Promise((resolveP, rejectP) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				rejectP(/* @__PURE__ */ new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const buf = Buffer.concat(chunks);
			resolveP(encoding ? buf.toString("utf8") : buf);
		});
		req.on("error", rejectP);
	});
}
/** Read a JSON (utf8) request body up to `limit` bytes (default MAX_JSON_BODY_BYTES). */
function readBody(req, limit = MAX_JSON_BODY_BYTES) {
	return readBodyStream(req, limit, true);
}
/** Read a raw (binary-safe) request body up to `limit` bytes (default MAX_UPLOAD_BYTES). */
function readBodyBuffer(req, limit = MAX_UPLOAD_BYTES) {
	return readBodyStream(req, limit, false);
}
/** Write a JSON response (no-store, utf-8). */
function json(res, payload, status = 200) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(payload));
}
//#endregion
//#region src/host/routes.ts
const ROUTE_PREFIX = PATH_PREFIX;
/** Tiddler type for quick-notes: Markdown, so the uploaded images/links and
*  any Markdown in the note actually render in TW (a type-less tiddler is
*  treated as plain wiki text and shows raw `![..]`/`[..]` instead). */
const NOTE_TYPE = "text/markdown";
/** Header names forwarded to the upstream TW service by the proxy routes. */
const FORWARD_HEADER_NAMES = [
	"accept",
	"accept-encoding",
	"content-type",
	"cookie",
	"authorization",
	"if-none-match",
	"if-modified-since",
	"origin",
	"referer",
	"user-agent"
];
/** Copy a safe, string-valued subset of the request headers upstream. */
function forwardHeaders(headers) {
	const out = {};
	for (const name of FORWARD_HEADER_NAMES) {
		const value = headers[name];
		if (typeof value === "string") out[name] = value;
		else if (Array.isArray(value) && value.length > 0) out[name] = value.join(", ");
	}
	return out;
}
/**
* Sanitize an uploaded filename into a safe bare name (no path separators,
* no `..`, no control characters). Returns '' when nothing usable remains.
*/
function sanitizeUploadName(input) {
	if (typeof input !== "string") return "";
	const name = basename(input.trim().replace(/[\\/]+/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").replace(/^\.+/, "").trim();
	if (name.length === 0 || name === "." || name === "..") return "";
	if (name.length > 160) return name.slice(0, 160);
	return name;
}
function pad(n) {
	return n < 10 ? `0${n}` : String(n);
}
/** Flat one-line snippet for the recent-notes picker. */
function snippetOf$1(text, max = 120) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
/** Default note title: `YYYY-MM-DD HH:mm` (design doc D6). */
function timestampTitle(date = /* @__PURE__ */ new Date()) {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/**
* Open a tiddler in TW's NATIVE editor: save the tiddler (when text is
* non-empty) as Markdown, reuse or create a DRAFT tiddler carrying
* `draft.of`/`draft.title` (TW's story view renders drafts with the
* EditTemplate — list.js: `isDraft && editTemplate`), and return the draft
* title so the client can navigate the panel iframe to `#<draftTitle>`.
* The draft carries the same `text/markdown` type as the note so saving it in
* TW keeps Markdown (a draft without a matching type would overwrite the
* note's type back to plain wiki text).
*/
async function openInTwEditor(client, title, text, tags) {
	if (text.trim().length > 0) await client.put({
		title,
		text,
		tags,
		type: NOTE_TYPE
	});
	let draftText = text;
	if (draftText.trim().length === 0) draftText = (await client.get(title))?.text ?? "";
	let draftTitle;
	try {
		const items = await client.list(void 0, true);
		for (const item of items) if (item["draft.of"] === title && typeof item.title === "string") {
			draftTitle = item.title;
			break;
		}
	} catch {}
	if (draftTitle === void 0) draftTitle = `Draft of "${title}" ${Date.now()}`;
	await client.put({
		title: draftTitle,
		text: draftText,
		"draft.of": title,
		"draft.title": title,
		type: NOTE_TYPE
	});
	return {
		title,
		draftTitle
	};
}
/** Resolve note tags from the request body: `tags` array wins, then the
*  legacy single `tag` string, then the configured default tag. */
function resolveTags(body, defaultTag) {
	if (Array.isArray(body.tags)) {
		const tags = body.tags.filter((t) => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
		if (tags.length > 0) return tags;
	}
	if (typeof body.tag === "string" && body.tag.trim().length > 0) return body.tag.trim().split(/\s+/).filter(Boolean);
	return [defaultTag];
}
function registerRoutes(ctx, deps) {
	const handleStatus = async (_req, res) => {
		const view = deps.server.status();
		let gitSummary = null;
		try {
			gitSummary = await deps.git.status(deps.getWikiPath());
		} catch {
			gitSummary = null;
		}
		json(res, {
			ok: true,
			...view,
			twProxy: TW_PROXY_PATH,
			git: gitSummary,
			note: { tag: deps.noteDefaults().tag },
			ui: deps.uiDefaults()
		});
	};
	/**
	* POST /dsh-tiddlywiki/session/summary — 生成当前会话的 wiki 汇总页（「知识库」
	* Tab 的后端）。body `{ session: <会话ID> }`；后端用 sessionQuery 读本会话（含
	* 后代 subagent）的完整事件日志，按「产生/读取/检索」收集 tiddlywiki_* 笔记，
	* 查询每篇当前状态，组装 TW wikitext 写入 `$:/temp/dsh/session-summary/<会话ID>`
	* （volatile：不落盘、不进 git），返回生成的 tiddler title 供前端 iframe 打开。
	*/
	const handleSessionSummary = async (req, res) => {
		try {
			let body = {};
			try {
				body = JSON.parse(await readBody(req));
			} catch {}
			const session = typeof body.session === "string" && body.session.trim().length > 0 ? body.session.trim() : "";
			if (session.length === 0) {
				json(res, {
					ok: false,
					error: "session is required"
				}, 400);
				return;
			}
			const client = deps.getClient();
			if (client === void 0) {
				json(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			const sq = deps.getSessionQuery();
			if (sq === void 0) {
				json(res, {
					ok: false,
					error: "session query service unavailable"
				}, 503);
				return;
			}
			json(res, {
				ok: true,
				...await writeSessionSummary(client, sq, session),
				twUrl: TW_PROXY_PATH
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* GET /dsh-tiddlywiki/agent/sessions — visible ordinary sessions for the TW
	* one-click picker (excludes subagent sessions, activity-descending). Each
	* item also carries its recorded `agentPreset` (工作模式), when known, so the
	* picker can badge existing sessions — read from the lightweight persistence
	* header list, never a full log parse.
	*/
	const handleAgentSessions = async (_req, res) => {
		try {
			const sc = deps.getSessionController();
			if (sc === void 0) {
				json(res, {
					ok: false,
					error: "session service unavailable"
				}, 503);
				return;
			}
			const list = await sc.list({}, AbortSignal.timeout(1e4));
			const presetById = {};
			const pers = deps.getSessionPersistence();
			if (pers !== void 0) try {
				const headers = await pers.list(AbortSignal.timeout(5e3));
				for (const h of headers) if (typeof h.agentPreset === "string" && h.agentPreset.length > 0) presetById[h.id] = h.agentPreset;
			} catch {}
			json(res, {
				ok: true,
				items: (list.items ?? []).filter((s) => s.parentSessionId === void 0).map((s) => ({
					sessionId: s.sessionId,
					cwd: s.cwd ?? null,
					running: !!s.running,
					blank: !!s.blank,
					updatedAt: s.updatedAt ?? 0,
					agentPreset: presetById[s.sessionId] ?? null
				})).sort((a, b) => b.updatedAt - a.updatedAt)
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* Shared gate for the TW-side send-to-agent routes: feature switch
	* (`ui.sendToAgent.enabled`) then, when a shared token is configured, the
	* `x-send-to-agent-token` header must match. Returns false after writing the
	* error response — the caller just does `if (!guard(...)) return`.
	*/
	const guardSendToAgent = (req, res) => {
		if (!deps.sendToAgentEnabled()) {
			json(res, {
				ok: false,
				error: "send-to-agent is disabled"
			}, 403);
			return false;
		}
		const token = deps.sendToAgentToken().trim();
		if (token.length === 0) return true;
		const got = req.headers["x-send-to-agent-token"];
		if ((typeof got === "string" ? got : Array.isArray(got) ? got[0] ?? "" : "") === token) return true;
		json(res, {
			ok: false,
			error: "unauthorized"
		}, 401);
		return false;
	};
	/**
	* GET /dsh-tiddlywiki/agent/modes — available "工作模式" (Agent presets) for
	* the TW picker: id/name/description per preset plus the deployment default.
	* Guards mirror the other agent routes (feature switch + optional token).
	*/
	const handleAgentModes = async (req, res) => {
		try {
			if (!guardSendToAgent(req, res)) return;
			const ap = deps.getAgentPresets();
			if (ap === void 0) {
				json(res, {
					ok: false,
					error: "agent presets service unavailable"
				}, 503);
				return;
			}
			const presets = await ap.list();
			let defaultId;
			try {
				defaultId = (await ap.resolve())?.id;
			} catch {
				defaultId = void 0;
			}
			let permissions = null;
			const pp = deps.getPermissionPresets();
			if (pp !== void 0) try {
				permissions = {
					defaultId: pp.defaultPreset ?? null,
					items: pp.names.map((n) => pp.optionOf(n))
				};
			} catch {
				permissions = null;
			}
			json(res, {
				ok: true,
				defaultId: defaultId ?? null,
				items: presets.map((p) => ({
					id: p.id,
					name: p.name ?? p.id,
					description: p.description ?? "",
					trust: p.trust ?? "user",
					broken: p.broken ?? null,
					isDefault: p.id === defaultId
				})),
				permissions
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* POST /dsh-tiddlywiki/agent/send — deliver a note to one agent session as a
	* queued user message (sessionController.prompt, the same API the GUI chat
	* input uses). Guards: feature switch, optional shared token, body shape.
	*/
	const handleAgentSend = async (req, res) => {
		try {
			if (!guardSendToAgent(req, res)) return;
			const body = JSON.parse(await readBody(req));
			const sessionId = typeof body.sessionId === "string" && body.sessionId.trim().length > 0 ? body.sessionId.trim() : "";
			const text = typeof body.text === "string" && body.text.trim().length > 0 ? body.text.trim() : "";
			if (sessionId.length === 0 || text.length === 0) {
				json(res, {
					ok: false,
					error: "sessionId and text are required"
				}, 400);
				return;
			}
			const sc = deps.getSessionController();
			if (sc === void 0) {
				json(res, {
					ok: false,
					error: "session service unavailable"
				}, 503);
				return;
			}
			const requestId = `tw-send-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
			await sc.prompt({
				requestId,
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text
				}]
			}, AbortSignal.timeout(2e4));
			json(res, {
				ok: true,
				requestId,
				sessionId
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* POST /dsh-tiddlywiki/agent/create — create (or adopt) one ordinary session
	* inside a real DSH workspace resolved from the requested path. The picker
	* uses it for "new workspace / new session": the directory is materialised so
	* a brand-new workspace actually exists on disk, the path is resolved to its
	* (idempotent) Workspace, and the session is created with `workspaceId` so it
	* lands under that workspace in the sidebar. Creating with bare `cwd` instead
	* would leave the session in the ungrouped bucket even when its working
	* directory matches an existing workspace path.
	*
	* Optional `mode` names the "工作模式" (an Agent preset id, e.g. from
	* /agent/modes); it is forwarded to `sessionController.create(agentPreset)`
	* so the new session launches under that preset. Omitted → deployment default.
	*
	* Optional `permission` names a "权限" preset (e.g. from /agent/modes'
	* `permissions` roster). After the session is created it is applied to the
	* live session's log via `permissionPresets.set` (durable knob events:
	* `permission/preset`, `sandbox/mode`, `approval/policy`), overriding the
	* deployment default pinned at creation. Omitted → keep the default.
	*/
	const handleAgentCreate = async (req, res) => {
		try {
			if (!guardSendToAgent(req, res)) return;
			const body = JSON.parse(await readBody(req));
			const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
			const mode = typeof body.mode === "string" && body.mode.trim().length > 0 ? body.mode.trim() : void 0;
			const permission = typeof body.permission === "string" && body.permission.trim().length > 0 ? body.permission.trim() : void 0;
			const pp = deps.getPermissionPresets();
			if (permission !== void 0) {
				if (pp === void 0) {
					json(res, {
						ok: false,
						error: "permission selected but the permission-presets service is unavailable"
					}, 503);
					return;
				}
				if (!pp.names.includes(permission)) {
					json(res, {
						ok: false,
						error: `unknown permission preset "${permission}" (available: ${pp.names.join(", ")})`
					}, 400);
					return;
				}
			}
			const sc = deps.getSessionController();
			if (sc === void 0) {
				json(res, {
					ok: false,
					error: "session service unavailable"
				}, 503);
				return;
			}
			const ws = deps.getWorkspaceRegistry();
			if (cwd.length > 0) await mkdir(cwd, { recursive: true });
			let created;
			let workspaceId;
			if (cwd.length > 0 && ws !== void 0) {
				workspaceId = (await ws.create(cwd)).id;
				created = await sc.create({
					workspaceId,
					agentPreset: mode
				});
			} else created = await sc.create({
				cwd: cwd.length > 0 ? cwd : void 0,
				agentPreset: mode
			});
			let permissionApplied = false;
			if (permission !== void 0) {
				const sessionsSvc = deps.getSessions();
				if (sessionsSvc !== void 0) try {
					const session = sessionsSvc.get(created.sessionId);
					if (session !== void 0) {
						pp?.set(session, permission);
						permissionApplied = true;
					}
				} catch {}
			}
			json(res, {
				ok: true,
				sessionId: created.sessionId,
				cwd: cwd || null,
				workspaceId: workspaceId ?? null,
				mode: mode ?? null,
				permission: permission ?? null,
				permissionApplied
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	const handleNote = async (req, res) => {
		try {
			const body = JSON.parse(await readBody(req));
			const text = typeof body.text === "string" && body.text.trim().length > 0 ? body.text.trim() : null;
			if (text === null) {
				json(res, {
					ok: false,
					error: "text is required"
				}, 400);
				return;
			}
			const client = deps.getClient();
			if (client === void 0) {
				json(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			const title = typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : timestampTitle();
			const tags = resolveTags(body, deps.noteDefaults().tag);
			await client.put({
				title,
				text,
				tags,
				type: NOTE_TYPE
			});
			deps.autoCommit();
			json(res, {
				ok: true,
				title,
				tag: tags.join(" "),
				tags,
				text,
				type: NOTE_TYPE
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	const handleEdit = async (req, res) => {
		try {
			const body = JSON.parse(await readBody(req));
			const client = deps.getClient();
			if (client === void 0) {
				json(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			const title = typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : timestampTitle();
			const tags = resolveTags(body, deps.noteDefaults().tag);
			const result = await openInTwEditor(client, title, typeof body.text === "string" ? body.text : "", tags);
			deps.autoCommit();
			json(res, {
				ok: true,
				...result,
				twUrl: TW_PROXY_PATH
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/** Distinct non-system tags for the quick-note tag autocomplete. The flat
	*  `tags` array feeds note-widget's chip autocomplete; the parallel `items`
	*  (tag → tiddler count) feeds the reply-stream `tiddlywiki_list_tags` tool
	*  card, so both consumers share one endpoint. */
	const handleTags = async (_req, res) => {
		const client = deps.getClient();
		if (client === void 0) {
			json(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		try {
			const items = await client.list(void 0, false);
			const counts = /* @__PURE__ */ new Map();
			for (const item of items) for (const tag of item.tags ?? []) if (tag.length > 0 && !tag.startsWith("$:/")) counts.set(tag, (counts.get(tag) ?? 0) + 1);
			const tags = [...counts.keys()].sort((a, b) => a.localeCompare(b, "zh"));
			json(res, {
				ok: true,
				tags,
				items: tags.map((tag) => ({
					tag,
					count: counts.get(tag) ?? 0
				}))
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/** Recent non-system tiddlers for the quick-note "最近" picker (newest first). */
	const handleRecent = async (req, res) => {
		const client = deps.getClient();
		if (client === void 0) {
			json(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const limitRaw = Number(url.searchParams.get("limit") ?? 15);
			const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 200)) : 15;
			json(res, {
				ok: true,
				limit,
				items: (await client.recent(limit)).map((t) => ({
					title: t.title,
					tags: t.tags ?? [],
					modified: typeof t.modified === "string" ? t.modified : null,
					snippet: snippetOf$1(t.text ?? "")
				}))
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/** Full tiddler for the quick-note "最近" picker (load into the editor). */
	const handleGet = async (req, res) => {
		const client = deps.getClient();
		if (client === void 0) {
			json(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		try {
			const title = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("title") ?? "";
			if (title.length === 0) {
				json(res, {
					ok: false,
					error: "missing title"
				}, 400);
				return;
			}
			const t = await client.get(title);
			if (t === void 0) {
				json(res, {
					ok: false,
					notFound: true,
					title
				}, 404);
				return;
			}
			const fields = {};
			for (const [k, v] of Object.entries(t)) {
				if (k === "title" || k === "text" || k === "tags") continue;
				fields[k] = v;
			}
			json(res, {
				ok: true,
				title: t.title,
				text: t.text ?? "",
				tags: t.tags ?? [],
				type: t.type ?? "text/vnd.tiddlywiki",
				modified: typeof t.modified === "string" ? t.modified : null,
				fields
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* GET /dsh-tiddlywiki/search — keyword search for the reply-stream tool card
	* (mirrors tools.ts tiddlywiki_search: same local substring/tag/since/type
	* matching via the TiddlyWebClient). Returns hit titles/tags/modified/
	* snippets so the card can list clickable wiki links.
	*/
	const handleSearch = async (req, res) => {
		const client = deps.getClient();
		if (client === void 0) {
			json(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const query = url.searchParams.get("query") ?? "";
			const tags = url.searchParams.getAll("tags").filter((t) => t.length > 0);
			const tag = url.searchParams.get("tag") ?? void 0;
			const since = url.searchParams.get("since") ?? void 0;
			const type = url.searchParams.get("type") ?? void 0;
			const limitRaw = Number(url.searchParams.get("limit") ?? 30);
			const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 200)) : 30;
			const { items, total } = await client.search(query, {
				tags,
				tag,
				since,
				type,
				limit
			});
			json(res, {
				ok: true,
				query,
				tags,
				tag: tag ?? null,
				since: since ?? null,
				type: type ?? null,
				limit,
				total,
				items: items.map((t) => ({
					title: t.title,
					tags: t.tags ?? [],
					modified: typeof t.modified === "string" ? t.modified : null,
					snippet: snippetOf$1(t.text ?? "")
				}))
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	const handleRestart = async (_req, res) => {
		try {
			await deps.server.restart();
			json(res, {
				ok: true,
				status: deps.server.status().status
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/** One-click git sync for the floating button / settings page: pull →
	*  commit → push, then return the fresh status. Mirrors the agent tool's
	*  `action=sync` (design doc §7 conflict policy — rebase conflict aborts).
	*  When the pull actually changed the working tree, the running TW child
	*  still holds the old in-memory snapshot — restart it (same port) so the
	*  UI reflects the pulled files instead of looking stale. */
	const handleSync = async (_req, res) => {
		const dir = deps.getWikiPath();
		const status = async () => {
			try {
				return await deps.git.status(dir);
			} catch {
				return null;
			}
		};
		try {
			const pulled = await deps.git.pull(dir);
			if (!pulled.ok) {
				json(res, {
					ok: false,
					action: "sync",
					message: pulled.message,
					...pulled.conflictFiles !== void 0 ? { conflictFiles: pulled.conflictFiles } : {},
					status: await status()
				}, 409);
				return;
			}
			let restarted = false;
			let restartError;
			if (pulled.changed === true) try {
				await deps.server.restart();
				restarted = true;
			} catch (err) {
				restartError = err instanceof Error ? err.message : String(err);
			}
			const committed = await deps.git.commit(dir, `sync ${(/* @__PURE__ */ new Date()).toISOString()}`);
			const pushed = await deps.git.push(dir);
			const fresh = await status();
			json(res, {
				ok: pushed.ok,
				action: "sync",
				message: pushed.ok ? "同步完成" : pushed.message,
				pull: "ok",
				...pulled.changed === true ? { changed: true } : {},
				restarted,
				...restartError !== void 0 ? { restartError } : {},
				commit: committed.message,
				push: pushed.message,
				status: fresh,
				lastSync: (/* @__PURE__ */ new Date()).toISOString()
			}, pushed.ok ? 200 : 502);
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* Save an uploaded file into the wiki's `files/` folder (git-tracked; TW's
	* core server serves it at `/files/<name>`, get-file.js — no restart
	* needed). Body is the raw file; the name arrives in `X-Filename`. A
	* collision appends `-1`, `-2`, … so nothing is ever overwritten.
	*/
	const handleUpload = async (req, res) => {
		try {
			const buf = await readBodyBuffer(req);
			let name = sanitizeUploadName(new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("name") ?? "");
			if (name.length === 0 && typeof req.headers["x-filename"] === "string") {
				let decoded = "";
				try {
					decoded = decodeURIComponent(req.headers["x-filename"]);
				} catch {
					decoded = req.headers["x-filename"];
				}
				name = sanitizeUploadName(decoded);
			}
			if (name.length === 0) {
				json(res, {
					ok: false,
					error: "missing or invalid filename"
				}, 400);
				return;
			}
			const filesDir = join(deps.getWikiPath(), "files");
			await mkdir(filesDir, { recursive: true });
			const ext = extname(name);
			const stem = ext.length > 0 ? name.slice(0, -ext.length) : name;
			let candidate = name;
			for (let i = 1;; i++) {
				try {
					await access(join(filesDir, candidate));
				} catch {
					break;
				}
				candidate = `${stem}-${i}${ext}`;
			}
			await writeFile(join(filesDir, candidate), buf);
			deps.autoCommit();
			json(res, {
				ok: true,
				name: candidate,
				path: `files/${candidate}`,
				url: `${TW_PROXY_PATH}files/${encodeURIComponent(candidate)}`,
				size: buf.length,
				type: req.headers["content-type"] ?? "application/octet-stream"
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, err instanceof Error && /too large/.test(err.message) ? 413 : 500);
		}
	};
	/** Passthrough /dsh-tiddlywiki/api/<rest> → TW root /<rest>. */
	const handleApiProxy = async (req, res) => {
		if (deps.getClient() === void 0) {
			json(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const rest = url.pathname.replace(/^\/dsh-tiddlywiki\/api/, "") || "/";
		try {
			const headers = {};
			const ct = req.headers["content-type"];
			if (typeof ct === "string") headers["content-type"] = ct;
			const method = (req.method ?? "GET").toUpperCase();
			if (method === "PUT" || method === "DELETE" || method === "POST") headers["x-requested-with"] = "TiddlyWiki";
			const init = {
				method,
				headers,
				signal: AbortSignal.timeout(15e3)
			};
			if (method === "PUT" || method === "POST") init.body = await readBody(req, MAX_PROXY_BODY_BYTES);
			const upstream = await fetch(`${deps.server.url}${rest}${url.search}`, init);
			const data = await upstream.text();
			res.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
				"cache-control": "no-store"
			});
			res.end(data);
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 502);
		}
	};
	/**
	* SAME-ORIGIN proxy /dsh-tiddlywiki/tw/<rest> → TW root /<rest>. Serves the
	* ENTIRE TW frontend (index HTML, /files/*, the TiddlyWeb API) to the
	* browser through the DSH origin, so the embedded editor works from any
	* host/domain the user reaches DSH on (loopback, LAN, Tailscale, domain,
	* HTTPS). The browser never talks to the loopback TW child directly; DSH
	* does, on the same machine. Binary responses are buffered losslessly
	* (arrayBuffer) — unlike the /api JSON proxy, this route must never .text().
	*/
	const handleTwProxy = async (req, res) => {
		if (deps.getClient() === void 0) {
			json(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const rest = url.pathname.replace(new RegExp(`^${TW_PROXY_PREFIX}(?=/|$)`), "") || "/";
		try {
			const method = (req.method ?? "GET").toUpperCase();
			const headers = forwardHeaders(req.headers);
			if (method === "PUT" || method === "DELETE" || method === "POST") headers["x-requested-with"] = "TiddlyWiki";
			const init = {
				method,
				headers,
				signal: AbortSignal.timeout(3e4)
			};
			if (method === "PUT" || method === "POST") init.body = await readBodyBuffer(req, MAX_UPLOAD_BYTES);
			const upstream = await fetch(`${deps.server.url}${rest}${url.search}`, init);
			const data = Buffer.from(await upstream.arrayBuffer());
			const responseHeaders = {
				"content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
				"cache-control": upstream.headers.get("cache-control") ?? "no-store"
			};
			for (const name of [
				"etag",
				"last-modified",
				"content-disposition"
			]) {
				const value = upstream.headers.get(name);
				if (value !== null) responseHeaders[name] = value;
			}
			res.writeHead(upstream.status, responseHeaders);
			res.end(data);
		} catch (err) {
			if (res.headersSent) {
				res.end();
				return;
			}
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 502);
		}
	};
	const disposers = [
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/status`,
			handler: (req, res) => {
				handleStatus(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/note`,
			handler: (req, res) => {
				handleNote(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/edit`,
			handler: (req, res) => {
				handleEdit(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/tags`,
			handler: (req, res) => {
				handleTags(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/recent`,
			handler: (req, res) => {
				handleRecent(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/get`,
			handler: (req, res) => {
				handleGet(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/search`,
			handler: (req, res) => {
				handleSearch(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/sync`,
			handler: (req, res) => {
				handleSync(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/upload`,
			handler: (req, res) => {
				handleUpload(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/restart`,
			handler: (req, res) => {
				handleRestart(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/session/summary`,
			handler: (req, res) => {
				handleSessionSummary(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/agent/sessions`,
			handler: (req, res) => {
				handleAgentSessions(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/agent/modes`,
			handler: (req, res) => {
				handleAgentModes(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/agent/send`,
			handler: (req, res) => {
				handleAgentSend(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/agent/create`,
			handler: (req, res) => {
				handleAgentCreate(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "prefix",
			path: `${ROUTE_PREFIX}/api`,
			handler: (req, res) => {
				handleApiProxy(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "prefix",
			path: `${TW_PROXY_PREFIX}`,
			handler: (req, res) => {
				handleTwProxy(req, res);
			}
		})
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
//#endregion
//#region src/host/config.ts
/** Config tiddler (JSON string) where the settings page stores overrides. */
const CONFIG_TIDDLER = "$:/plugins/dsh-tiddlywiki/config";
/** TW frontend API base tiddler, pointed at the same-origin DSH proxy. */
const TW_WEB_HOST_TIDDLER = "$:/config/tiddlyweb/host";
/** The legacy default TW host value this plugin replaces with the proxy. */
const TW_WEB_HOST_DEFAULT = "$protocol$//$host$/";
/**
* Default dark palette the embedded TW switches to when DSH is dark
* (mirrored in src/client/theme-sync.ts — the two bundles cannot share code).
*/
const DARK_PALETTE_DEFAULT = "$:/palettes/CupertinoDark";
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Deep-merge: `over` wins; nested plain objects merge recursively. */
function deepMerge(base, over) {
	const out = { ...base };
	for (const [key, value] of Object.entries(over)) {
		if (value === void 0) continue;
		if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
		else out[key] = value;
	}
	return out;
}
/**
* Runtime config store: caches the override tiddler and exposes the effective
* (merged) config. `load` runs at startup and after every write/restart.
*/
var ConfigStore = class {
	base;
	overrides = {};
	constructor(base) {
		this.base = base;
	}
	/** Effective config = cordis base overlaid with the user override tiddler. */
	get() {
		return deepMerge(this.base, this.overrides);
	}
	/** Reload the override tiddler (no-op when the wiki is unavailable). */
	async load(client) {
		this.overrides = {};
		if (client === void 0) return;
		try {
			const tiddler = await client.get(CONFIG_TIDDLER);
			if (tiddler !== void 0 && typeof tiddler.text === "string") {
				const parsed = JSON.parse(tiddler.text);
				if (isPlainObject(parsed)) this.overrides = parsed;
			}
		} catch {
			this.overrides = {};
		}
	}
	/** Merge a patch into the overrides and persist the tiddler. */
	async set(client, patch) {
		this.overrides = deepMerge(this.overrides, patch);
		await client.put({
			title: CONFIG_TIDDLER,
			text: JSON.stringify(this.overrides, null, 2),
			type: "application/json",
			tags: []
		});
		return this.get();
	}
};
//#endregion
//#region src/host/admin.ts
/**
* Admin surface for the plugin settings page (design doc §13, config panel).
*
* - dynamic plugin/theme management: enumerate the bundled catalog from the
*   installed tiddlywiki package, read/write the wiki's `tiddlywiki.info`
*   plugins/themes arrays, then restart the TW child so the change applies;
* - extensible config: the settings page reads/writes a config tiddler
*   ($:/plugins/dsh-tiddlywiki/config, a JSON string) that overlays the
*   cordis `config:` block — future config fields just extend the shape.
*
* Routes (all under ROUTE_PREFIX/admin, JSON):
*   GET  /admin/state   current info + catalog + effective config + status
*   POST /admin/info    { plugins?, themes? } → write info → restart TW
*   POST /admin/config  { ...patch }          → write config tiddler
*   POST /admin/restart restart the TW child
*
* @module dsh-tiddlywiki/host/admin
*/
/** Resolve the installed tiddlywiki package root (for the catalog). */
function resolveTwRoot() {
	return dirname(createRequire(import.meta.url).resolve("tiddlywiki/package.json"));
}
/** Read the wiki's tiddlywiki.info. */
async function readWikiInfo(wikiPath) {
	let raw;
	try {
		raw = await readFile(join(wikiPath, "tiddlywiki.info"), "utf8");
	} catch {
		return {
			plugins: [],
			themes: [],
			languages: []
		};
	}
	const parsed = JSON.parse(raw);
	return {
		description: parsed.description,
		plugins: parsed.plugins ?? [],
		themes: parsed.themes ?? [],
		languages: parsed.languages ?? [],
		...parsed
	};
}
/** Write the wiki's tiddlywiki.info (pretty-printed, ordering preserved). */
async function writeWikiInfo(wikiPath, info) {
	await writeFile(join(wikiPath, "tiddlywiki.info"), `${JSON.stringify(info, null, 4)}\n`, "utf8");
}
/** Enumerate bundled official plugins + themes + languages of tiddlywiki. */
async function bundledCatalog(twRoot) {
	const themeHasCss = async (dir) => {
		for (const name of ["base.tid", "styles.tid"]) try {
			if ((await readFile(join(twRoot, "themes", "tiddlywiki", dir, name), "utf8")).replace(/^[\s\S]*?\r?\n\r?\n/, "").split("\n").filter((line) => !/^\\rules\b/.test(line.trim())).join("\n").trim().length > 0) return true;
		} catch {}
		return false;
	};
	const scan = async (sub) => {
		const root = join(twRoot, sub, "tiddlywiki");
		let dirs;
		try {
			dirs = await readdir(root);
		} catch {
			return [];
		}
		const out = [];
		for (const dir of dirs) {
			let info = {};
			try {
				info = JSON.parse(await readFile(join(root, dir, "plugin.info"), "utf8"));
			} catch {
				info = {};
			}
			if (sub === "themes" && dir !== "vanilla" && !await themeHasCss(dir)) continue;
			out.push({
				name: `tiddlywiki/${dir}`,
				title: sub === "plugins" ? `$:/plugins/tiddlywiki/${dir}` : `$:/themes/tiddlywiki/${dir}`,
				label: info.name ?? dir,
				description: info.description ?? "",
				dependents: Array.isArray(info.dependents) ? info.dependents.map((dep) => dep.replace(/^\$:\/themes\/tiddlywiki\//, "tiddlywiki/")) : void 0
			});
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	};
	const scanLanguages = async () => {
		const root = join(twRoot, "languages");
		let dirs;
		try {
			dirs = await readdir(root);
		} catch {
			return [];
		}
		const out = [];
		for (const dir of dirs) {
			let info = {};
			try {
				info = JSON.parse(await readFile(join(root, dir, "plugin.info"), "utf8"));
			} catch {
				info = {};
			}
			out.push({
				name: dir,
				title: `$:/languages/${dir}`,
				label: info.name ?? dir,
				description: info.description ?? ""
			});
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	};
	const [plugins, themes, languages] = await Promise.all([
		scan("plugins"),
		scan("themes"),
		scanLanguages()
	]);
	return {
		plugins,
		themes,
		languages
	};
}
/**
* Normalize a theme selection into the tiddlywiki.info `themes` array.
*
* TW themes are SKINS with a dependency chain (plugin.info `dependents`):
*   vanilla ← snowwhite ← heavier / centralised / readonly / starlight
*   vanilla ← tight / seamless
* The ACTIVE theme is `$:/theme`, and switching to it registers the theme PLUS
* its transitive dependents (boot.js accumulatePlugin) — if a dependent isn't
* loaded, the vanilla base stylesheet is lost and the UI breaks. So we always
* emit the transitive closure, dependency-first (base first, active overlay
* last), and force vanilla in as the base. Empty selection → vanilla.
*/
function normalizeThemes(selected, deps = {}) {
	const sel = selected.filter((name) => typeof name === "string" && name.length > 0);
	if (sel.length === 0) sel.push("tiddlywiki/vanilla");
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const visit = (name) => {
		if (seen.has(name)) return;
		seen.add(name);
		for (const dep of deps[name] ?? []) if (dep !== name) visit(dep);
		out.push(name);
	};
	for (const name of sel) visit(name);
	if (!out.includes("tiddlywiki/vanilla")) out.unshift("tiddlywiki/vanilla");
	return out;
}
/**
* Ensure a language code (e.g. "zh-Hans") is in tiddlywiki.info `languages`.
* Returns whether tiddlywiki.info changed (caller decides whether to restart).
*/
async function ensureLanguage(wikiPath, twRoot, lang) {
	if (typeof lang !== "string" || lang.trim().length === 0) return false;
	const code = lang.trim();
	if (!(await bundledCatalog(twRoot)).languages.some((l) => l.name === code)) throw new Error(`unknown language plugin: ${code}`);
	const info = await readWikiInfo(wikiPath);
	const current = info.languages ?? [];
	if (current.includes(code)) return false;
	info.languages = [...current, code];
	await writeWikiInfo(wikiPath, info);
	return true;
}
function registerAdminRoutes(ctx, deps) {
	const handleState = async (_req, res) => {
		try {
			const wikiPath = deps.getWikiPath();
			const [info, catalog] = await Promise.all([readWikiInfo(wikiPath), bundledCatalog(deps.twRoot())]);
			let git = null;
			try {
				git = await new GitFace().status(wikiPath);
			} catch {
				git = null;
			}
			json(res, {
				ok: true,
				server: deps.server.status(),
				info: {
					plugins: info.plugins,
					themes: info.themes,
					languages: info.languages ?? []
				},
				catalog,
				config: deps.config.get(),
				git
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	const handleInfo = async (req, res) => {
		try {
			const body = JSON.parse(await readBody(req));
			const wikiPath = deps.getWikiPath();
			const info = await readWikiInfo(wikiPath);
			const catalog = await bundledCatalog(deps.twRoot());
			const known = new Set([...catalog.plugins, ...catalog.themes].map((c) => c.name));
			const knownLangs = new Set(catalog.languages.map((c) => c.name));
			const applyList = (field, raw) => {
				if (!Array.isArray(raw)) return info[field];
				const next = [];
				for (const name of raw) {
					if (typeof name !== "string") continue;
					if (!known.has(name) && !info[field].includes(name)) throw new Error(`unknown plugin/theme: ${name}`);
					if (!next.includes(name)) next.push(name);
				}
				return next;
			};
			const applyLanguages = (raw) => {
				if (!Array.isArray(raw)) return info.languages ?? [];
				const next = [];
				for (const code of raw) {
					if (typeof code !== "string") continue;
					if (!knownLangs.has(code) && !(info.languages ?? []).includes(code)) throw new Error(`unknown language plugin: ${code}`);
					if (!next.includes(code)) next.push(code);
				}
				return next;
			};
			info.plugins = applyList("plugins", body.plugins);
			let activatedTheme;
			if (Array.isArray(body.themes)) {
				const themeDeps = {};
				for (const theme of catalog.themes) if (theme.dependents && theme.dependents.length > 0) themeDeps[theme.name] = theme.dependents;
				let selected = applyList("themes", body.themes);
				if (typeof body.themeActive === "string" && body.themeActive.length > 0) {
					const activeName = body.themeActive;
					if (known.has(activeName) || info.themes.includes(activeName)) {
						if (!selected.includes(activeName)) selected.push(activeName);
						activatedTheme = activeName;
					}
				}
				info.themes = normalizeThemes(selected, themeDeps);
				if (activatedTheme === void 0 && info.themes.length > 0) activatedTheme = info.themes[info.themes.length - 1];
			} else info.themes = applyList("themes", body.themes);
			if (Array.isArray(body.languages)) info.languages = applyLanguages(body.languages);
			await writeWikiInfo(wikiPath, info);
			await deps.server.restart();
			if (activatedTheme !== void 0) {
				const client = deps.getClient();
				if (client !== void 0) await client.put({
					title: "$:/theme",
					text: `$:/themes/${activatedTheme}`,
					type: "text/vnd.tiddlywiki",
					tags: []
				}).catch(() => void 0);
			}
			if (Array.isArray(body.languages)) {
				const client = deps.getClient();
				if (client !== void 0) {
					const langs = info.languages ?? [];
					const active = langs.length > 0 ? `$:/languages/${langs[0]}` : "$:/languages/en-GB";
					await client.put({
						title: "$:/language",
						text: active,
						type: "text/plain",
						tags: []
					}).catch(() => void 0);
					const hint = langs.length > 0 ? langs[0] : "";
					if ((deps.config.get().uiLanguage ?? "") !== hint) await deps.config.set(client, { uiLanguage: hint }).catch(() => void 0);
				}
			}
			json(res, {
				ok: true,
				info: {
					plugins: info.plugins,
					themes: info.themes,
					languages: info.languages ?? []
				}
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 400);
		}
	};
	const handleConfig = async (req, res) => {
		try {
			const body = JSON.parse(await readBody(req));
			const client = deps.getClient();
			if (client === void 0) {
				json(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			await deps.config.set(client, body);
			json(res, {
				ok: true,
				config: deps.config.get()
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 400);
		}
	};
	const handleRestart = async (_req, res) => {
		try {
			await deps.server.restart();
			json(res, {
				ok: true,
				status: deps.server.status().status
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* GET /dsh-tiddlywiki/admin/seeds — status of every one-time seed
	* (doc-note / send-to-agent / home-index / tw-web-host) for the settings
	* page's 初始化 section.
	*/
	const handleSeeds = async (_req, res) => {
		try {
			const client = deps.getClient();
			if (client === void 0) {
				json(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			json(res, {
				ok: true,
				items: await deps.seeds.checkAll(client)
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* POST /dsh-tiddlywiki/admin/seeds/run — run one seed (or all when `id` is
	* absent); `force: true` is the manual "重新初始化" (overwrite + re-marker),
	* `force: false` keeps the one-shot write-if-missing semantics.
	*/
	const handleSeedsRun = async (req, res) => {
		try {
			const body = JSON.parse(await readBody(req));
			const id = typeof body.id === "string" && body.id.trim().length > 0 ? body.id.trim() : void 0;
			const force = body.force === true;
			const client = deps.getClient();
			if (client === void 0) {
				json(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			const results = await deps.seeds.run(client, id, force);
			const ok = results.every((r) => r.ok);
			json(res, {
				ok,
				results
			}, ok ? 200 : 400);
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* POST /dsh-tiddlywiki/admin/seeds/remove — 反初始化: remove one optional
	* seed (or all optional seeds when `id` is absent) — delete the seeded
	* tiddlers + markers so the wiki returns to the "never seeded" state.
	* Core seeds (功能必需) cannot be removed.
	*/
	const handleSeedsRemove = async (req, res) => {
		try {
			const body = JSON.parse(await readBody(req));
			const id = typeof body.id === "string" && body.id.trim().length > 0 ? body.id.trim() : void 0;
			const client = deps.getClient();
			if (client === void 0) {
				json(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			const results = await deps.seeds.remove(client, id);
			const ok = results.every((r) => r.ok);
			json(res, {
				ok,
				results
			}, ok ? 200 : 400);
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	const disposers = [
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/state`,
			handler: (req, res) => {
				handleState(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/info`,
			handler: (req, res) => {
				handleInfo(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/config`,
			handler: (req, res) => {
				handleConfig(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/restart`,
			handler: (req, res) => {
				handleRestart(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/seeds`,
			handler: (req, res) => {
				handleSeeds(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/seeds/run`,
			handler: (req, res) => {
				handleSeedsRun(req, res);
			}
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/seeds/remove`,
			handler: (req, res) => {
				handleSeedsRemove(req, res);
			}
		})
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
//#endregion
//#region src/host/seed-notes.ts
/** Note tiddler title (a normal, searchable note — not a system tiddler). */
const DOC_NOTE_TITLE = "dsh-tiddlywiki 插件说明";
/** Tag that makes the note easy to find via `tiddlywiki_search tag=docs`. */
const DOC_NOTE_TAG = "docs";
/**
* Shared tag that collects every plugin-seeded doc into the seeded home's
*「📚 插件文档」tabs strip (see seed-starter-docs.ts DSH_DOCS_TAG).
*/
const DOC_NOTE_DSH_DOCS_TAG = "dsh-docs";
/** One-time marker: its presence means "the note was offered once — hands off". */
const SEED_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-doc-note";
/** The note body, TiddlyWiki wiki-text. */
const DOC_NOTE_TEXT = `! dsh-tiddlywiki 插件说明

本插件把 **TiddlyWiki 5** 作为 DSH 的持久知识库（wiki 文件夹本身就是一个 git 仓库，随内容自动提交/同步）。

!! 它能做什么

* **10 个 agent 工具**：\`tiddlywiki_search\`（检索，支持 tags/since/type/limit 过滤）/ \`tiddlywiki_get\`（读）/ \`tiddlywiki_put\`（写）/ \`tiddlywiki_batch_put\`（批量写）/ \`tiddlywiki_rename\`（重命名+同步引用）/ \`tiddlywiki_delete\`（删）/ \`tiddlywiki_recent\`（最近修改）/ \`tiddlywiki_list_tags\`（标签清单）/ \`tiddlywiki_git_sync\`（git 同步）/ \`tiddlywiki_git_resolve\`（冲突按 tiddler 二选一）。
* **TW 编辑器面板**：侧边栏「TiddlyWiki」按钮 → 在界面中央打开完整版 TW 编辑器。
* **快速笔记**：点击聊天输入框上方或右下角「知识库」菜单里的「📝 快速笔记」——默认**直达 TW 原生编辑页**（独立小窗，草稿自动续写）；也可在设置页切回 Markdown 卡片（语法高亮、文件上传、多选 tag、草稿自动保存、Ctrl+Enter 保存）。「✏️ 在 TW 中编辑」会弹出独立小窗用 TW 原生编辑器编辑。
* **一键同步**：「知识库」按钮 → 「🔁 同步」一键 pull → commit → push，按钮上的状态点实时反映 git 状态。
* **git 同步**：写入自动防抖 commit（默认 60 秒）；手动 \`tiddlywiki_git_sync action=sync\` 做 pull → commit → push。
* **设置页**：DSH 设置 → 「TiddlyWiki 知识库」管理插件/主题/语言与运行配置（含「知识库」按钮相关显示开关）。

!! 知识库纪律（四条）

1. 开工先 \`tiddlywiki_git_sync action=pull\`（rebase + autostash，真冲突会自动 abort 并报文件）。
2. 冲突后：\`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local|keep-remote\` 按 tiddler 二选一解决，再重新 sync。
3. 收工 \`tiddlywiki_git_sync action=sync\`。
4. 插件自动 commit 兜底，手动 sync 用于需要主动推送的场合。

!! 主题与语言

* **主题**分两层：每行一个「☑ 加载」（多选 = TW 里可用的主题，依赖链自动带上）和「◉ 活动」（单选 = 当前视觉主题）。应用后自动重启 TW。
* **语言**：设置页勾选 \`zh-Hans\`（简体）并应用，TW 界面即切换为中文。

!! 说明

* 本笔记由插件在**首次启动**时自动写入（一次性：只写一次）。删除后重启 dsh web **不会自动恢复**——它从此归你所有。
* 本笔记带 \`dsh-docs\` 标签，会出现在首页「📚 插件文档」栏（与「示例与文档」seed 的教程/模板一起），不需要可自由删除。
* 更多细节见插件仓库 README。`;
/**
* Seed the doc note once per wiki (mirrors the one-shot policy). A marker
* tiddler records that the note has been offered; from then on the note is
* user-owned and is never re-created (deleting it survives restarts).
*
* With `opts.force` the note is (re)written even when it already exists and
* the marker is (re)written — the settings page uses this for
* "重新初始化". Returns whether a note was written this call. Never throws.
*/
async function seedDocNote(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await client.get("$:/plugins/dsh-tiddlywiki/seed-doc-note").catch(() => void 0) !== void 0) return false;
	}
	const existing = await client.get(DOC_NOTE_TITLE).catch(() => void 0);
	let wrote = false;
	if (force || existing === void 0) {
		await client.put({
			title: DOC_NOTE_TITLE,
			text: DOC_NOTE_TEXT,
			type: "text/vnd.tiddlywiki",
			tags: [DOC_NOTE_TAG, DOC_NOTE_DSH_DOCS_TAG]
		});
		wrote = true;
	}
	await client.put({
		title: SEED_MARKER_TITLE,
		text: "seeded-once",
		type: "text/plain",
		tags: []
	}).catch(() => void 0);
	return wrote;
}
/**
* Un-seed (反初始化): remove the doc note and its one-shot marker, returning
* the wiki to the "never offered" state. Deletion is idempotent — a tiddler
* that was already gone is simply not listed. Never throws.
*/
async function unseedDocNote(client) {
	const removed = [];
	for (const title of [DOC_NOTE_TITLE, SEED_MARKER_TITLE]) if (await client.get(title).catch(() => void 0) !== void 0) {
		await client.delete(title);
		removed.push(title);
	}
	return { removed };
}
//#endregion
//#region src/host/seed-starter-docs.ts
/** One-time marker: presence means "the docs were offered once — hands off". */
const STARTER_DOCS_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-starter-docs";
/** Shared tag that collects every plugin-seeded doc into the home docs tab. */
const DSH_DOCS_TAG = "dsh-docs";
/** The docs, exactly as seeded (user-owned afterwards, freely deletable). */
const STARTER_DOCS_ITEMS = [
	{
		title: "主题汇总页·模板",
		tags: ["索引", "dsh-docs"],
		type: "text/vnd.tiddlywiki",
		text: `\\whitespace trim

!! 📌 主题汇总页

<div style="color:#888; font-size:0.85em; border:1px dashed rgba(128,128,128,0.35); border-radius:8px; padding:6px 10px; margin-bottom:8px;">【模板】复制本页 → 改名（如「XX主题汇总」）→ 把下面两处 <code>主题A</code> 替换成你的标签名 → 保存。给笔记打上该标签即自动收录，本页无需维护。</div>

<div class="tc-message-box">自动收集带 <code>主题A</code> 标签的笔记，按最近修改排序，共 <strong>{{{[tag[主题A]!is[system]!has[draft.of]count[]]}}}</strong> 篇。</div>

<<list-links "[tag[主题A]!is[system]!has[draft.of]] +[!sort[modified]]">>

---

### 可选：自定义样式的 <$list> 版（想更花哨时用它替换上面的 list-links）

<ul>
<$list filter="[tag[主题A]!is[system]!has[draft.of]] +[!sort[modified]]">
<li><$link to=<<currentTiddler>>><$view field="title"/></$link><span style="color:#aaa; font-size:0.85em;"> · <$view field="modified" format="relativedate"/></span></li>
</$list>
</ul>

### 可选：把本页收进「一页多主题」tabs

给本页打上 <code>主题页</code> 标签、并加一个 <code>caption</code> 字段（按钮文字），然后在总览页写：<code>&lt;&lt;tabs "[tag[主题页]!is[system]]"&gt;&gt;</code>。详见 [[教程：按主题/标签做汇总页]]。
`
	},
	{
		title: "教程：按主题/标签做汇总页",
		tags: ["教程", "dsh-docs"],
		type: "text/markdown",
		text: `# 教程：按主题/标签做汇总页

> 适用：本 wiki 的 TiddlyWiki 5.3.x 内核。⚠️ 网上大量教程是 5.1/5.2 时代写的，其中 \`<<tabs "筛选器" "标签">>\` 和 \`<<count "筛选器">>\` 两种写法在本版本已**改版/移除**，照抄会报错，注意甄别。

## 核心思路（一句话）

「汇总页」不是 TW 的特殊功能，而是：**一个普通笔记 + 正文里一段筛选器（filter）**。渲染时 TW 实时从整个 wiki 挑出符合条件的笔记列出来。**新笔记只要打上对应标签，汇总页自动出现，零维护**——不用像手工目录那样每次手动更新。

## 方法一：零代码，直接用内置标签页

- 打开任意笔记，点正文底部的**标签链接**；
- 或侧边栏「标签」（标签云）里点某个标签。
- TW 会自动生成该标签的页面，列出所有带此标签的笔记。
- 优点：一行代码都不用写；缺点：不能加说明文字、不能自定义排序/样式，也做不了「多主题合一」。

## 方法二：一页一主题（最常用）

新建一个笔记（wikitext），正文写：

\`\`\`wikitext
!! 📔 日志主题汇总
<div class="tc-message-box">自动收集带 <code>日志</code> 标签的笔记，共 <strong>{{{[tag[日志]!is[system]!has[draft.of]count[]]}}}</strong> 篇，按最近修改排序。</div>

<<list-links "[tag[日志]!is[system]!has[draft.of]] +[!sort[modified]]">>
\`\`\`

各片段含义：

- \`[tag[日志]]\`：挑出所有带「日志」标签的笔记；
- \`!is[system]\`：排除 \`$:/\` 系统页；
- \`!has[draft.of]\`：排除未保存的草稿副本；
- \`+[!sort[modified]]\`：按修改时间**倒序**（\`sort[modified]\` 为正序）；
- \`{{{[...count[]]}}}\`：筛选器计数（旧版 \`<<count>>\` 宏已移除，这是 5.3 新写法）。

想自定义每行样式（带相对时间、复选框等），用你更熟悉的 \`<$list>\` 写法：

\`\`\`wikitext
<ul>
<$list filter="[tag[日志]!is[system]!has[draft.of]] +[!sort[modified]]">
<li><$link to=<<currentTiddler>>><$view field="title"/></$link><span style="color:#aaa; font-size:0.85em;"> · <$view field="modified" format="relativedate"/></span></li>
</$list>
</ul>
\`\`\`

## 方法三：一页多主题（Dashboard，5.3 新版 tabs）

5.3 的 \`tabs\` 宏签名：\`<<tabs "选中标签页的筛选器" "默认选中项">>\`。思路分两步：

1. **每个主题各建一个汇总页**（就是方法二那种），全部打上同一个标签（本插件 seed 的示例用 \`主题页\`）；要自定义按钮文字，就给该页加一个 \`caption\` 字段（如 \`📔 日志\`）。
2. **建一个总览页**，正文只写一行：

\`\`\`wikitext
<<tabs "[tag[主题页]!is[system]]" "主题页·日志">>
\`\`\`

效果：页面上方一排按钮，点哪个就内嵌显示哪个主题的汇总。第二个参数是默认展开的页（可省略，省略则初始不展开）。

> 老教程的 \`<<tabs "筛选器A" "标签A" "筛选器B" "标签B">>\` 在 5.3 已失效，别用。

本插件已 seed 了可直接运行的示例：[主题页·日志]、[主题页·决策记录]、[主题页·排障]（都带 \`主题页\` 标签），复制改造即可。

## 筛选器速查表（背熟这几行就够用）

| 想要 | 写法 |
| --- | --- |
| 某标签下的笔记 | \`[tag[主题]]\` |
| 排除系统页 / 草稿 | \`[tag[主题]!is[system]!has[draft.of]]\` |
| 修改时间倒序 / 正序 | \`+[!sort[modified]]\` / \`+[sort[modified]]\` |
| 按标题排序 | \`+[sort[title]]\` |
| 交集（同时有两个标签） | \`[tag[A]+tag[B]]\` |
| 并集（有任一标签） | \`[tag[A]] [tag[B]]\` |
| 差集（有 A 无 B） | \`[tag[A]-tag[B]]\` |
| 排除某标签 | \`-[tag[排除项]]\` |
| 限定时间段 | \`[tag[主题]modified[2026-09]]\` |
| 计数 | \`{{{[tag[主题]!is[system]count[]]}}}\`（或 \`<$count filter="[tag[主题]]"/>\`） |
| 整个 wiki 的非系统非草稿 | \`all[tiddlers]!is[system]!has[draft.of]\` |

## 进阶玩法

1. **按字段筛选**：\`[tag[todo]get[due]compare:date:lt<today>]\` 可列出「到期日早于今天」的笔记（主页的逾期看板就是这么写的）。
2. **树状目录**：\`<<toc tag:"主题">>\` 显示层级目录，适合一个主题下还有子主题的情况。
3. **模板复用**：复制 [主题汇总页·模板] 改标题和标签即可，不用每次重写。
4. **打开直达**：把 \`$:/DefaultTiddlers\` 改成 \`[[主题页·日志]]\`，启动即打开汇总页（当前默认是 [🏠 主页]）。
5. **导航收录**：给汇总页打 \`索引\` 标签，它就会从「全部笔记 / 所有文章」里消失、只作为导航页存在；再在 [🏠 主页] 的按钮区加一个入口按钮即可。
6. **标签整理**：控制台 → 工具 → 标签管理器，可重命名/合并标签，改名后所有笔记自动跟随，汇总页筛选器无需改动（筛选器按标签名匹配，自动跟随改名）。

## 配套产物清单（插件 seed 提供了什么）

- [主题页·日志]、[主题页·决策记录]、[主题页·排障] —— 单主题汇总页实例（各自可独立打开，也可作为「一页多主题」tabs 的标签页）
- [主题汇总页·模板] —— 空白模板，复制即用
- 本教程 —— 就是这一页

以上都来自「示例与文档」seed（tag \`dsh-docs\`），不需要可自由删除，删除后不会自动恢复。
`
	},
	{
		title: "主题页·日志",
		tags: [
			"主题页",
			"索引",
			"dsh-docs"
		],
		type: "text/vnd.tiddlywiki",
		text: `\\whitespace trim

!! 📔 日志主题汇总

<div class="tc-message-box">自动收集带 <code>日志</code> 标签的笔记，按最近修改排序，共 <strong>{{{[tag[日志]!is[system]!has[draft.of]count[]]}}}</strong> 篇。给笔记打上「日志」标签即自动收录，本页无需维护（做法见 [[教程：按主题/标签做汇总页]]）。</div>

<<list-links "[tag[日志]!is[system]!has[draft.of]] +[!sort[modified]]">>
`
	},
	{
		title: "主题页·决策记录",
		tags: [
			"主题页",
			"索引",
			"dsh-docs"
		],
		type: "text/vnd.tiddlywiki",
		text: `\\whitespace trim

!! 📌 决策记录主题汇总

<div class="tc-message-box">自动收集带 <code>决策记录</code> 标签的笔记，按最近修改排序，共 <strong>{{{[tag[决策记录]!is[system]!has[draft.of]count[]]}}}</strong> 篇。给笔记打上「决策记录」标签即自动收录，本页无需维护（做法见 [[教程：按主题/标签做汇总页]]）。</div>

<<list-links "[tag[决策记录]!is[system]!has[draft.of]] +[!sort[modified]]">>
`
	},
	{
		title: "主题页·排障",
		tags: [
			"主题页",
			"索引",
			"dsh-docs"
		],
		type: "text/vnd.tiddlywiki",
		text: `\\whitespace trim

!! 🔧 排障主题汇总

<div class="tc-message-box">自动收集带 <code>troubleshooting</code> 标签的笔记，按最近修改排序，共 <strong>{{{[tag[troubleshooting]!is[system]!has[draft.of]count[]]}}}</strong> 篇。给笔记打上「troubleshooting」标签即自动收录，本页无需维护（做法见 [[教程：按主题/标签做汇总页]]）。</div>

<<list-links "[tag[troubleshooting]!is[system]!has[draft.of]] +[!sort[modified]]">>
`
	}
];
/**
* Seed the starter docs once per wiki (safe-skip: same-named tiddlers already
* present are NEVER overwritten — user data stays user data). Marker-gated
* ONE-SHOT; with `opts.force` the tiddlers are (re)written and the marker
* (re)recorded — the settings page uses this for "重新初始化".
* Returns whether anything was written this call. Never throws.
*/
async function seedStarterDocs(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await client.get("$:/plugins/dsh-tiddlywiki/seed-starter-docs").catch(() => void 0) !== void 0) return false;
	}
	let wrote = false;
	for (const item of STARTER_DOCS_ITEMS) {
		const existing = await client.get(item.title).catch(() => void 0);
		if (force || existing === void 0) {
			await client.put({
				title: item.title,
				text: item.text,
				type: item.type,
				tags: item.tags
			});
			wrote = true;
		}
	}
	await client.put({
		title: STARTER_DOCS_MARKER_TITLE,
		text: "seeded-once",
		type: "text/plain",
		tags: []
	}).catch(() => void 0);
	return wrote;
}
/**
* Un-seed (反初始化): remove the starter docs and their marker. Deletion is
* idempotent — a tiddler already gone is not listed. Never throws.
*/
async function unseedStarterDocs(client) {
	const removed = [];
	for (const item of STARTER_DOCS_ITEMS) if (await client.get(item.title).catch(() => void 0) !== void 0) {
		await client.delete(item.title);
		removed.push(item.title);
	}
	if (await client.get("$:/plugins/dsh-tiddlywiki/seed-starter-docs").catch(() => void 0) !== void 0) {
		await client.delete(STARTER_DOCS_MARKER_TITLE);
		removed.push(STARTER_DOCS_MARKER_TITLE);
	}
	return { removed };
}
//#endregion
//#region src/host/seed-send-to-agent.ts
/** The packaged plugin tiddler title (a TW system tiddler, type application/json). */
const SEND_TO_AGENT_PLUGIN_TITLE = "$:/plugins/dsh/send-to-agent";
/** One-time marker: presence means "the button was offered once — hands off". */
const SEND_TO_AGENT_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-send-to-agent";
/** The bundle's JSON text (`{"tiddlers": {...}}`), exactly as TW stores it. */
const SEND_TO_AGENT_BUNDLE_TEXT = "{\n  \"tiddlers\": {\n    \"$:/plugins/dsh/send-to-agent/plugin.info\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/plugin.info\",\n      \"type\": \"application/json\",\n      \"text\": \"{\\\"title\\\":\\\"$:/plugins/dsh/send-to-agent\\\",\\\"name\\\":\\\"Send to Agent\\\",\\\"description\\\":\\\"把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）\\\",\\\"author\\\":\\\"dsh-tiddlywiki\\\",\\\"version\\\":\\\"0.3.4\\\",\\\"plugin-type\\\":\\\"plugin\\\"}\"\n    },\n    \"$:/plugins/dsh/send-to-agent/startup.js\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/startup.js\",\n      \"type\": \"application/javascript\",\n      \"module-type\": \"startup\",\n      \"text\": \"/*\\\\\\ntitle: $:/plugins/dsh/send-to-agent/startup.js\\ntype: application/javascript\\nmodule-type: startup\\n\\n\\\\*/\\n(function(){\\n\\n/*jslint node: true, browser: true */\\n/*global $tw: false */\\n\\\"use strict\\\";\\n\\nexports.name = \\\"dsh-send-to-agent\\\";\\nexports.after = [\\\"story\\\"];\\nexports.platforms = [\\\"browser\\\"];\\n\\nfunction readConfig() {\\n\\tvar config = { enabled: true, endpoint: \\\"\\\", token: \\\"\\\" };\\n\\ttry {\\n\\t\\tvar t = $tw.wiki.getTiddler(\\\"$:/plugins/dsh-tiddlywiki/config\\\");\\n\\t\\tif (t && t.fields && typeof t.fields.text === \\\"string\\\") {\\n\\t\\t\\tvar parsed = JSON.parse(t.fields.text);\\n\\t\\t\\tvar s2a = parsed && parsed.ui && parsed.ui.sendToAgent;\\n\\t\\t\\tif (s2a) {\\n\\t\\t\\t\\tif (typeof s2a.enabled === \\\"boolean\\\") { config.enabled = s2a.enabled; }\\n\\t\\t\\t\\tif (typeof s2a.endpoint === \\\"string\\\" && s2a.endpoint.length > 0) { config.endpoint = s2a.endpoint; }\\n\\t\\t\\t\\tif (typeof s2a.token === \\\"string\\\" && s2a.token.length > 0) { config.token = s2a.token; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t} catch (e) {}\\n\\treturn config;\\n}\\n\\nfunction baseEndpoint() {\\n\\tvar config = readConfig();\\n\\tif (config.endpoint.length > 0) { return config.endpoint.replace(/\\\\/+$/, \\\"\\\"); }\\n\\tif (typeof location !== \\\"undefined\\\" && location.origin) { return location.origin + \\\"/dsh-tiddlywiki\\\"; }\\n\\treturn \\\"/dsh-tiddlywiki\\\";\\n}\\n\\nfunction notify(msg) {\\n\\tif ($tw.notifier && typeof $tw.notifier.display === \\\"function\\\") {\\n\\t\\t$tw.notifier.display(msg);\\n\\t} else if (typeof alert === \\\"function\\\") {\\n\\t\\talert(msg);\\n\\t}\\n}\\n\\nfunction doSend(payload, sessionId, note) {\\n\\tvar config = readConfig();\\n\\tvar lines = [];\\n\\tlines.push(\\\"《\\\" + payload.title + \\\"》\\\");\\n\\tlines.push(\\\"标签: \\\" + (payload.tags || []).join(\\\", \\\"));\\n\\tlines.push(\\\"类型: \\\" + (payload.type || \\\"无\\\"));\\n\\tlines.push(\\\"\\\");\\n\\tlines.push(\\\"【待办说明】以下内容是我（用户）提前编辑在 TiddlyWiki 知识库中的待办事项，通过「发送给 Agent」一键发送给你处理。请按内容执行；如有任何不清楚的地方，请主动向我提问，不要臆测或擅自发挥。\\\");\\n\\tlines.push(\\\"\\\");\\n\\tlines.push(payload.text || \\\"\\\");\\n\\t// 附加说明放在消息最后：正文之后、作为我（用户）的最终补充要求，优先遵循。\\n\\tif (note && String(note).trim().length > 0) {\\n\\t\\tlines.push(\\\"\\\");\\n\\t\\tlines.push(\\\"【附加说明】\\\" + String(note).trim());\\n\\t}\\n\\tvar text = lines.join(\\\"\\\\n\\\");\\n\\tvar headers = { \\\"Content-Type\\\": \\\"application/json\\\" };\\n\\tif (config.token.length > 0) { headers[\\\"x-send-to-agent-token\\\"] = config.token; }\\n\\t$tw.utils.httpRequest({\\n\\t\\turl: baseEndpoint() + \\\"/agent/send\\\",\\n\\t\\ttype: \\\"POST\\\",\\n\\t\\theaders: headers,\\n\\t\\tdata: JSON.stringify({ sessionId: sessionId, text: text }),\\n\\t\\tcallback: function(err, data) {\\n\\t\\t\\tvar parsed = null;\\n\\t\\t\\ttry { parsed = JSON.parse(data || \\\"\\\"); } catch (e) {}\\n\\t\\t\\tif (err) { notify(\\\"发送失败：\\\" + err); return; }\\n\\t\\t\\tif (parsed && parsed.ok) {\\n\\t\\t\\t\\tnotify(\\\"已发送 ✓ 会话 \\\" + sessionId.slice(0, 8));\\n\\t\\t\\t} else {\\n\\t\\t\\t\\tnotify(\\\"发送失败：\\\" + ((parsed && parsed.error) || data || \\\"未知错误\\\"));\\n\\t\\t\\t}\\n\\t\\t}\\n\\t});\\n}\\n\\nfunction closeOverlay(overlay, escHandler) {\\n\\tif (escHandler) { document.removeEventListener(\\\"keydown\\\", escHandler); }\\n\\tif (overlay && overlay.parentNode) { overlay.parentNode.removeChild(overlay); }\\n}\\n\\nfunction showPicker(payload, items, modes, defaultId, permissions) {\\n\\tif (typeof document === \\\"undefined\\\") { return; }\\n\\t// remove any previously-open picker\\n\\tvar old = document.getElementById(\\\"dsh-send-picker\\\");\\n\\tif (old && old.parentNode) { old.parentNode.removeChild(old); }\\n\\n\\tvar state = { workspace: null, mode: \\\"\\\", note: \\\"\\\", permission: \\\"\\\" };\\n\\n\\tvar overlay = document.createElement(\\\"div\\\");\\n\\toverlay.id = \\\"dsh-send-picker\\\";\\n\\toverlay.setAttribute(\\\"style\\\", \\\"position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);z-index:99999;display:flex;align-items:center;justify-content:center;\\\");\\n\\tvar box = document.createElement(\\\"div\\\");\\n\\tbox.setAttribute(\\\"style\\\", \\\"background:#fff;color:#333;border-radius:8px;padding:14px;min-width:340px;max-width:560px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.3);font-family:system-ui,-apple-system,sans-serif;\\\");\\n\\n\\t// header\\n\\tvar header = document.createElement(\\\"div\\\");\\n\\theader.setAttribute(\\\"style\\\", \\\"display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;\\\");\\n\\tvar h = document.createElement(\\\"h3\\\");\\n\\th.setAttribute(\\\"style\\\", \\\"margin:0;font-size:15px;\\\");\\n\\th.textContent = \\\"发送给 Agent · 选择目标\\\";\\n\\tvar closeX = document.createElement(\\\"button\\\");\\n\\tcloseX.type = \\\"button\\\";\\n\\tcloseX.textContent = \\\"✕\\\";\\n\\tcloseX.title = \\\"关闭\\\";\\n\\tcloseX.setAttribute(\\\"style\\\", \\\"border:none;background:transparent;font-size:15px;cursor:pointer;color:#888;padding:2px 8px;border-radius:4px;\\\");\\n\\tcloseX.addEventListener(\\\"click\\\", function() { closeOverlay(overlay, escHandler); });\\n\\theader.appendChild(h);\\n\\theader.appendChild(closeX);\\n\\tbox.appendChild(header);\\n\\n\\t// description\\n\\tvar desc = document.createElement(\\\"p\\\");\\n\\tdesc.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;font-size:12px;color:#888;word-break:break-all;\\\");\\n\\tdesc.textContent = \\\"《\\\" + payload.title + \\\"》将作为消息注入所选会话\\\";\\n\\tbox.appendChild(desc);\\n\\n\\t// 附加说明（可选）— any extra context the user wants to attach to the\\n\\t// message, e.g. what to focus on or how to handle it.\\n\\tvar noteRow = document.createElement(\\\"div\\\");\\n\\tnoteRow.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;\\\");\\n\\tvar noteLbl = document.createElement(\\\"label\\\");\\n\\tnoteLbl.setAttribute(\\\"style\\\", \\\"display:block;font-size:12px;color:#666;margin-bottom:4px;\\\");\\n\\tnoteLbl.textContent = \\\"附加说明（可选，随笔记一起发给 Agent）\\\";\\n\\tnoteRow.appendChild(noteLbl);\\n\\tvar noteTa = document.createElement(\\\"textarea\\\");\\n\\tnoteTa.placeholder = \\\"例如：请重点看第 3 条；我希望你按 XX 方式处理…\\\";\\n\\tnoteTa.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;min-height:44px;resize:vertical;font-family:inherit;\\\");\\n\\tnoteTa.addEventListener(\\\"input\\\", function() { state.note = noteTa.value; });\\n\\tnoteRow.appendChild(noteTa);\\n\\tbox.appendChild(noteRow);\\n\\n\\t// 工作模式（Agent 预设）selector — applies to newly created sessions; the\\n\\t// modes come from GET /agent/modes (id/name/description + deployment\\n\\t// default). When the modes endpoint is unreachable (e.g. an older host) the\\n\\t// row degrades to a hint and no mode is sent — DSH uses its default.\\n\\tvar modeRow = document.createElement(\\\"div\\\");\\n\\tmodeRow.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;\\\");\\n\\tif (modes && modes.length > 0) {\\n\\t\\tvar modeLbl = document.createElement(\\\"label\\\");\\n\\t\\tmodeLbl.setAttribute(\\\"style\\\", \\\"display:block;font-size:12px;color:#666;margin-bottom:4px;\\\");\\n\\t\\tmodeLbl.textContent = \\\"工作模式（Agent 预设）— 用于新建会话\\\";\\n\\t\\tmodeRow.appendChild(modeLbl);\\n\\t\\tvar sel = document.createElement(\\\"select\\\");\\n\\t\\tsel.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;\\\");\\n\\t\\tvar optDefault = document.createElement(\\\"option\\\");\\n\\t\\toptDefault.value = \\\"\\\";\\n\\t\\toptDefault.textContent = \\\"（默认模式）\\\";\\n\\t\\tsel.appendChild(optDefault);\\n\\t\\tmodes.forEach(function(m) {\\n\\t\\t\\tvar o = document.createElement(\\\"option\\\");\\n\\t\\t\\to.value = m.id || \\\"\\\";\\n\\t\\t\\to.textContent = (m.name || m.id) + (m.isDefault ? \\\"（默认）\\\" : \\\"\\\");\\n\\t\\t\\tsel.appendChild(o);\\n\\t\\t});\\n\\t\\t// preselect the deployment default when listed\\n\\t\\tif (defaultId) {\\n\\t\\t\\tfor (var i = 0; i < sel.options.length; i++) {\\n\\t\\t\\t\\tif (sel.options[i].value === defaultId) { sel.selectedIndex = i; break; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t\\tstate.mode = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].value : \\\"\\\";\\n\\t\\tsel.addEventListener(\\\"change\\\", function() { state.mode = sel.value; });\\n\\t\\tmodeRow.appendChild(sel);\\n\\t} else {\\n\\t\\tvar modeHint = document.createElement(\\\"p\\\");\\n\\t\\tmodeHint.setAttribute(\\\"style\\\", \\\"margin:0;font-size:12px;color:#999;\\\");\\n\\t\\tmodeHint.textContent = \\\"（未获取到可用工作模式，将使用 DSH 默认模式）\\\";\\n\\t\\tmodeRow.appendChild(modeHint);\\n\\t}\\n\\tbox.appendChild(modeRow);\\n\\n\\t// 权限（权限预设）selector — applies to newly created sessions only; the\\n\\t// options come from GET /agent/modes' `permissions` roster (each bundles a\\n\\t// sandbox mode + approval policy). Existing sessions keep their own\\n\\t// permission, so this only affects \\\"新建会话并发送\\\".\\n\\tvar permRow = document.createElement(\\\"div\\\");\\n\\tpermRow.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;\\\");\\n\\tif (permissions && Array.isArray(permissions.items) && permissions.items.length > 0) {\\n\\t\\tvar permLbl = document.createElement(\\\"label\\\");\\n\\t\\tpermLbl.setAttribute(\\\"style\\\", \\\"display:block;font-size:12px;color:#666;margin-bottom:4px;\\\");\\n\\t\\tpermLbl.textContent = \\\"权限（权限预设）— 用于新建会话\\\";\\n\\t\\tpermRow.appendChild(permLbl);\\n\\t\\tvar psel = document.createElement(\\\"select\\\");\\n\\t\\tpsel.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;\\\");\\n\\t\\tpermissions.items.forEach(function(p) {\\n\\t\\t\\tvar o = document.createElement(\\\"option\\\");\\n\\t\\t\\to.value = p.value || \\\"\\\";\\n\\t\\t\\to.textContent = p.name || p.value;\\n\\t\\t\\tif (p.description) { o.title = p.description; }\\n\\t\\t\\tpsel.appendChild(o);\\n\\t\\t});\\n\\t\\t// preselect the deployment default when listed\\n\\t\\tif (permissions.defaultId) {\\n\\t\\t\\tfor (var j = 0; j < psel.options.length; j++) {\\n\\t\\t\\t\\tif (psel.options[j].value === permissions.defaultId) { psel.selectedIndex = j; break; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t\\tstate.permission = psel.options[psel.selectedIndex] ? psel.options[psel.selectedIndex].value : \\\"\\\";\\n\\t\\tpsel.addEventListener(\\\"change\\\", function() { state.permission = psel.value; });\\n\\t\\tpermRow.appendChild(psel);\\n\\t} else {\\n\\t\\tvar permHint = document.createElement(\\\"p\\\");\\n\\t\\tpermHint.setAttribute(\\\"style\\\", \\\"margin:0;font-size:12px;color:#999;\\\");\\n\\t\\tpermHint.textContent = \\\"（未获取到权限预设，新建会话将使用 DSH 默认权限）\\\";\\n\\t\\tpermRow.appendChild(permHint);\\n\\t}\\n\\tbox.appendChild(permRow);\\n\\n\\t// scrollable body\\n\\tvar body = document.createElement(\\\"div\\\");\\n\\tbody.setAttribute(\\\"style\\\", \\\"overflow:auto;flex:1;min-height:0;\\\");\\n\\tbox.appendChild(body);\\n\\n\\t// footer with cancel\\n\\tvar footer = document.createElement(\\\"div\\\");\\n\\tfooter.setAttribute(\\\"style\\\", \\\"display:flex;justify-content:flex-end;gap:8px;margin-top:10px;\\\");\\n\\tvar cancel = document.createElement(\\\"button\\\");\\n\\tcancel.type = \\\"button\\\";\\n\\tcancel.textContent = \\\"取消\\\";\\n\\tcancel.setAttribute(\\\"style\\\", \\\"padding:6px 14px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;\\\");\\n\\tcancel.addEventListener(\\\"click\\\", function() { closeOverlay(overlay, escHandler); });\\n\\tfooter.appendChild(cancel);\\n\\tbox.appendChild(footer);\\n\\n\\toverlay.appendChild(box);\\n\\tdocument.body.appendChild(overlay);\\n\\n\\t// backdrop click + Esc close\\n\\toverlay.addEventListener(\\\"click\\\", function(e) {\\n\\t\\tif (e.target === overlay) { closeOverlay(overlay, escHandler); }\\n\\t});\\n\\tvar escHandler = function(e) { if (e.key === \\\"Escape\\\") { closeOverlay(overlay, escHandler); } };\\n\\tdocument.addEventListener(\\\"keydown\\\", escHandler);\\n\\n\\t// group sessions by workspace (cwd)\\n\\tvar groups = {};\\n\\tvar order = [];\\n\\t(items || []).forEach(function(s) {\\n\\t\\tvar key = (s.cwd && String(s.cwd).length > 0) ? s.cwd : \\\"__default__\\\";\\n\\t\\tif (!groups[key]) { groups[key] = { cwd: s.cwd, sessions: [], max: 0 }; order.push(key); }\\n\\t\\tgroups[key].sessions.push(s);\\n\\t\\tif ((s.updatedAt || 0) > groups[key].max) { groups[key].max = s.updatedAt || 0; }\\n\\t});\\n\\torder.sort(function(a, b) { return groups[b].max - groups[a].max; });\\n\\n\\tfunction btnStyle() {\\n\\t\\treturn \\\"display:block;width:100%;text-align:left;padding:8px 10px;margin:4px 0;border:1px solid #ddd;border-radius:6px;background:#f7f7f7;cursor:pointer;font-size:13px;\\\";\\n\\t}\\n\\tfunction primaryBtnStyle() {\\n\\t\\treturn \\\"display:block;width:100%;text-align:center;padding:7px 10px;margin:6px 0 0;border:1px solid #4a90d9;border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer;font-size:13px;\\\";\\n\\t}\\n\\tfunction smallBtnStyle() {\\n\\t\\treturn \\\"margin:0 0 6px;padding:4px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;color:#555;\\\";\\n\\t}\\n\\n\\tfunction shortSessionLabel(s) {\\n\\t\\tvar id = s.sessionId || \\\"\\\";\\n\\t\\tvar parts = id.split(\\\"-\\\");\\n\\t\\tvar short = (parts.length > 1 ? parts[parts.length - 1] : id).slice(-10);\\n\\t\\tvar when = \\\"\\\";\\n\\t\\tif (s.updatedAt) {\\n\\t\\t\\tvar diff = Date.now() - s.updatedAt;\\n\\t\\t\\tif (diff < 60000) { when = \\\"刚刚\\\"; }\\n\\t\\t\\telse if (diff < 3600000) { when = Math.floor(diff / 60000) + \\\" 分钟前\\\"; }\\n\\t\\t\\telse if (diff < 86400000) { when = Math.floor(diff / 3600000) + \\\" 小时前\\\"; }\\n\\t\\t\\telse {\\n\\t\\t\\t\\tvar d = new Date(s.updatedAt);\\n\\t\\t\\t\\twhen = (d.getMonth() + 1) + \\\"-\\\" + d.getDate() + \\\" \\\" + (\\\"0\\\" + d.getHours()).slice(-2) + \\\":\\\" + (\\\"0\\\" + d.getMinutes()).slice(-2);\\n\\t\\t\\t}\\n\\t\\t}\\n\\t\\treturn \\\"#\\\" + short + (when ? \\\"  ·  \\\" + when : \\\"\\\") + (s.running ? \\\"  ·  ●运行中\\\" : \\\"\\\") + (s.blank ? \\\"  ·  (空)\\\" : \\\"\\\");\\n\\t}\\n\\n\\tfunction modeName(id) {\\n\\t\\tif (!id) { return \\\"\\\"; }\\n\\t\\tfor (var i = 0; i < (modes || []).length; i++) {\\n\\t\\t\\tif (modes[i].id === id) { return modes[i].name || modes[i].id; }\\n\\t\\t}\\n\\t\\treturn id;\\n\\t}\\n\\n\\tfunction render() {\\n\\t\\tbody.innerHTML = \\\"\\\";\\n\\t\\tif (state.workspace === null) { renderWorkspaces(); } else { renderSessions(state.workspace); }\\n\\t}\\n\\n\\tfunction renderWorkspaces() {\\n\\t\\tif (order.length === 0) {\\n\\t\\t\\tvar none = document.createElement(\\\"p\\\");\\n\\t\\t\\tnone.textContent = \\\"还没有任何会话——在下方新建一个吧\\\";\\n\\t\\t\\tnone.setAttribute(\\\"style\\\", \\\"color:#999;font-size:13px;margin:0 0 8px;\\\");\\n\\t\\t\\tbody.appendChild(none);\\n\\t\\t} else {\\n\\t\\t\\torder.forEach(function(key) {\\n\\t\\t\\t\\tvar g = groups[key];\\n\\t\\t\\t\\tvar label = g.cwd || \\\"(默认工作区)\\\";\\n\\t\\t\\t\\tvar b = document.createElement(\\\"button\\\");\\n\\t\\t\\t\\tb.type = \\\"button\\\";\\n\\t\\t\\t\\tb.setAttribute(\\\"style\\\", btnStyle());\\n\\t\\t\\t\\tb.textContent = \\\"📁 \\\" + label + \\\"  ·  \\\" + g.sessions.length + \\\" 个会话\\\";\\n\\t\\t\\t\\tb.title = g.cwd || \\\"默认工作区\\\";\\n\\t\\t\\t\\tb.addEventListener(\\\"click\\\", function() { state.workspace = key; render(); });\\n\\t\\t\\t\\tbody.appendChild(b);\\n\\t\\t\\t});\\n\\t\\t}\\n\\t\\t// new workspace / session\\n\\t\\tvar newRow = document.createElement(\\\"div\\\");\\n\\t\\tnewRow.setAttribute(\\\"style\\\", \\\"margin-top:10px;border-top:1px solid #eee;padding-top:8px;\\\");\\n\\t\\tvar lbl = document.createElement(\\\"p\\\");\\n\\t\\tlbl.textContent = \\\"新建工作区 / 会话\\\";\\n\\t\\tlbl.setAttribute(\\\"style\\\", \\\"margin:0 0 6px;font-size:12px;color:#666;\\\");\\n\\t\\tnewRow.appendChild(lbl);\\n\\t\\tvar input = document.createElement(\\\"input\\\");\\n\\t\\tinput.type = \\\"text\\\";\\n\\t\\tinput.placeholder = \\\"输入工作区路径，留空为默认工作区\\\";\\n\\t\\tinput.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;\\\");\\n\\t\\tnewRow.appendChild(input);\\n\\t\\tvar go = document.createElement(\\\"button\\\");\\n\\t\\tgo.type = \\\"button\\\";\\n\\t\\tgo.textContent = \\\"创建并发送\\\";\\n\\t\\tgo.setAttribute(\\\"style\\\", primaryBtnStyle());\\n\\t\\tgo.addEventListener(\\\"click\\\", function() { createAndSend(payload, input.value.trim()); });\\n\\t\\tnewRow.appendChild(go);\\n\\t\\tinput.addEventListener(\\\"keydown\\\", function(e) { if (e.key === \\\"Enter\\\") { createAndSend(payload, input.value.trim()); } });\\n\\t\\tbody.appendChild(newRow);\\n\\t}\\n\\n\\tfunction renderSessions(key) {\\n\\t\\tvar g = groups[key];\\n\\t\\tvar back = document.createElement(\\\"button\\\");\\n\\t\\tback.type = \\\"button\\\";\\n\\t\\tback.textContent = \\\"← 返回工作区列表\\\";\\n\\t\\tback.setAttribute(\\\"style\\\", smallBtnStyle());\\n\\t\\tback.addEventListener(\\\"click\\\", function() { state.workspace = null; render(); });\\n\\t\\tbody.appendChild(back);\\n\\n\\t\\tvar wsName = document.createElement(\\\"p\\\");\\n\\t\\twsName.textContent = g.cwd ? \\\"📁 \\\" + g.cwd : \\\"(默认工作区)\\\";\\n\\t\\twsName.setAttribute(\\\"style\\\", \\\"margin:0 0 6px;font-size:13px;font-weight:600;word-break:break-all;\\\");\\n\\t\\tbody.appendChild(wsName);\\n\\n\\t\\t(g.sessions || []).forEach(function(s) {\\n\\t\\t\\tvar b = document.createElement(\\\"button\\\");\\n\\t\\t\\tb.type = \\\"button\\\";\\n\\t\\t\\tb.setAttribute(\\\"style\\\", btnStyle());\\n\\t\\t\\tvar label = shortSessionLabel(s);\\n\\t\\t\\tif (s.agentPreset) { label += \\\"  ·  🧭 \\\" + modeName(s.agentPreset); }\\n\\t\\t\\tb.textContent = label;\\n\\t\\t\\tb.title = \\\"会话 \\\" + s.sessionId + (s.agentPreset ? \\\" · 工作模式 \\\" + modeName(s.agentPreset) : \\\"\\\");\\n\\t\\t\\tb.addEventListener(\\\"click\\\", function() { closeOverlay(overlay, escHandler); doSend(payload, s.sessionId, state.note); });\\n\\t\\t\\tbody.appendChild(b);\\n\\t\\t});\\n\\n\\t\\tvar newBtn = document.createElement(\\\"button\\\");\\n\\t\\tnewBtn.type = \\\"button\\\";\\n\\t\\tnewBtn.textContent = \\\"➕ 在此工作区新建会话并发送\\\";\\n\\t\\tnewBtn.setAttribute(\\\"style\\\", primaryBtnStyle());\\n\\t\\tnewBtn.addEventListener(\\\"click\\\", function() { createAndSend(payload, g.cwd); });\\n\\t\\tbody.appendChild(newBtn);\\n\\t}\\n\\n\\tfunction createAndSend(payload2, cwd) {\\n\\t\\tvar config = readConfig();\\n\\t\\tvar headers = { \\\"Content-Type\\\": \\\"application/json\\\" };\\n\\t\\tif (config.token.length > 0) { headers[\\\"x-send-to-agent-token\\\"] = config.token; }\\n\\t\\tvar body = { cwd: cwd || \\\"\\\" };\\n\\t\\tif (state.mode && String(state.mode).length > 0) { body.mode = state.mode; }\\n\\t\\tif (state.permission && String(state.permission).length > 0) { body.permission = state.permission; }\\n\\t\\t$tw.utils.httpRequest({\\n\\t\\t\\turl: baseEndpoint() + \\\"/agent/create\\\",\\n\\t\\t\\ttype: \\\"POST\\\",\\n\\t\\t\\theaders: headers,\\n\\t\\t\\tdata: JSON.stringify(body),\\n\\t\\t\\tcallback: function(err, data) {\\n\\t\\t\\t\\tvar parsed = null;\\n\\t\\t\\t\\ttry { parsed = JSON.parse(data || \\\"\\\"); } catch (e) {}\\n\\t\\t\\t\\tif (err) { notify(\\\"新建会话失败：\\\" + err); return; }\\n\\t\\t\\t\\tif (parsed && parsed.ok && parsed.sessionId) {\\n\\t\\t\\t\\t\\tcloseOverlay(overlay, escHandler);\\n\\t\\t\\t\\t\\tvar modeNote = parsed.mode ? \\\"（模式 \\\" + modeName(parsed.mode) + \\\"）\\\" : \\\"\\\";\\n\\t\\t\\t\\t\\tvar permNote = parsed.permissionApplied ? \\\"（权限 \\\" + (parsed.permission || \\\"\\\") + \\\"）\\\" : \\\"\\\";\\n\\t\\t\\t\\t\\tnotify(\\\"已创建会话并发送 ✓ \\\" + parsed.sessionId.slice(0, 8) + modeNote + permNote);\\n\\t\\t\\t\\t\\tdoSend(payload2, parsed.sessionId, state.note);\\n\\t\\t\\t\\t} else {\\n\\t\\t\\t\\t\\tnotify(\\\"新建会话失败：\\\" + ((parsed && parsed.error) || data || \\\"未知错误\\\"));\\n\\t\\t\\t\\t}\\n\\t\\t\\t}\\n\\t\\t});\\n\\t}\\n\\n\\trender();\\n}\\n\\nfunction handleSend(title) {\\n\\tif (!title) { notify(\\\"无法确定当前笔记标题\\\"); return; }\\n\\tvar tiddler = $tw.wiki.getTiddler(title);\\n\\tif (!tiddler) { notify(\\\"找不到笔记：\\\" + title); return; }\\n\\tvar config = readConfig();\\n\\tif (!config.enabled) { notify(\\\"「发送给 Agent」特性未启用（可在 TW 配置中打开）\\\"); return; }\\n\\tvar payload = {\\n\\t\\ttitle: title,\\n\\t\\ttext: tiddler.fields.text || \\\"\\\",\\n\\t\\ttags: tiddler.fields.tags || [],\\n\\t\\ttype: tiddler.fields.type || \\\"\\\"\\n\\t};\\n\\tvar headers = {};\\n\\tif (config.token.length > 0) { headers[\\\"x-send-to-agent-token\\\"] = config.token; }\\n\\t$tw.utils.httpRequest({\\n\\t\\turl: baseEndpoint() + \\\"/agent/sessions\\\",\\n\\t\\ttype: \\\"GET\\\",\\n\\t\\theaders: headers,\\n\\t\\tcallback: function(err, data) {\\n\\t\\t\\tvar parsed = null;\\n\\t\\t\\ttry { parsed = JSON.parse(data || \\\"\\\"); } catch (e) {}\\n\\t\\t\\tif (err) { notify(\\\"获取会话列表失败：\\\" + err); return; }\\n\\t\\t\\tif (!parsed || !parsed.ok || !parsed.items) { notify(\\\"获取会话列表失败：\\\" + ((parsed && parsed.error) || \\\"未知错误\\\")); return; }\\n\\t\\t\\t// fetch the available 工作模式 (Agent presets) alongside; degrade to\\n\\t\\t\\t// an empty roster (default mode) when the endpoint is missing.\\n\\t\\t\\t$tw.utils.httpRequest({\\n\\t\\t\\t\\turl: baseEndpoint() + \\\"/agent/modes\\\",\\n\\t\\t\\t\\ttype: \\\"GET\\\",\\n\\t\\t\\t\\theaders: headers,\\n\\t\\t\\t\\tcallback: function(err2, data2) {\\n\\t\\t\\t\\t\\tvar modes = [];\\n\\t\\t\\t\\t\\tvar defaultId = \\\"\\\";\\n\\t\\t\\t\\t\\tvar permissions = null;\\n\\t\\t\\t\\t\\tvar parsed2 = null;\\n\\t\\t\\t\\t\\ttry { parsed2 = JSON.parse(data2 || \\\"\\\"); } catch (e) {}\\n\\t\\t\\t\\t\\tif (!err2 && parsed2 && parsed2.ok) {\\n\\t\\t\\t\\t\\t\\tif (Array.isArray(parsed2.items)) {\\n\\t\\t\\t\\t\\t\\t\\tmodes = parsed2.items;\\n\\t\\t\\t\\t\\t\\t\\tdefaultId = parsed2.defaultId || \\\"\\\";\\n\\t\\t\\t\\t\\t\\t}\\n\\t\\t\\t\\t\\t\\tif (parsed2.permissions && Array.isArray(parsed2.permissions.items)) {\\n\\t\\t\\t\\t\\t\\t\\tpermissions = parsed2.permissions;\\n\\t\\t\\t\\t\\t\\t}\\n\\t\\t\\t\\t\\t}\\n\\t\\t\\t\\t\\tshowPicker(payload, parsed.items, modes, defaultId, permissions);\\n\\t\\t\\t\\t}\\n\\t\\t\\t});\\n\\t\\t}\\n\\t});\\n}\\n\\nexports.startup = function() {\\n\\tconsole.log(\\\"[dsh-send-to-agent] startup ran\\\");\\n\\tif (!$tw.rootWidget || typeof $tw.rootWidget.addEventListener !== \\\"function\\\") { return; }\\n\\t$tw.rootWidget.addEventListener(\\\"dsh-send-to-agent\\\", function(event) {\\n\\t\\thandleSend(event.param);\\n\\t});\\n};\\n\\n})();\\n\"\n    },\n    \"$:/plugins/dsh/send-to-agent/ui/icon\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/ui/icon\",\n      \"tags\": [\n        \"$:/tags/Image\"\n      ],\n      \"text\": \"\\\\parameters (size:\\\"22pt\\\")\\n<svg width=<<size>> height=<<size>> class=\\\"tc-image-send-to-agent tc-image-button\\\" viewBox=\\\"0 0 24 24\\\"><path d=\\\"M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z\\\"/></svg>\\n\"\n    },\n    \"$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent\",\n      \"type\": \"text/vnd.tiddlywiki\",\n      \"tags\": [\n        \"$:/tags/ViewToolbar\"\n      ],\n      \"icon\": \"$:/plugins/dsh/send-to-agent/ui/icon\",\n      \"caption\": \"发送给 Agent\",\n      \"description\": \"把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）\",\n      \"text\": \"\\\\whitespace trim\\n<$button message=\\\"dsh-send-to-agent\\\"\\n\\tparam=<<currentTiddler>>\\n\\ttooltip=\\\"把当前笔记一键发送给 DSH Agent\\\"\\n\\taria-label=\\\"把当前笔记一键发送给 DSH Agent\\\"\\n\\tclass=<<tv-config-toolbar-class>>\\n>\\n\\t<%if [<tv-config-toolbar-icons>match[yes]] %>\\n\\t\\t{{$:/plugins/dsh/send-to-agent/ui/icon}}\\n\\t<%endif%>\\n\\t<%if [<tv-config-toolbar-text>match[yes]] %>\\n\\t\\t<span class=\\\"tc-btn-text\\\">\\n\\t\\t<$text text=\\\"发送给 Agent\\\"/>\\n\\t</span>\\n\\t<%endif%>\\n</$button>\\n\"\n    },\n    \"$:/core/ui/ControlPanel/Toolbars/ItemTemplate\": {\n      \"title\": \"$:/core/ui/ControlPanel/Toolbars/ItemTemplate\",\n      \"type\": \"text/vnd.tiddlywiki\",\n      \"text\": \"\\\\define config-title()\\n$(config-base)$$(currentTiddler)$\\n\\\\end\\n\\\\whitespace trim\\n\\n<$draggable tiddler=<<currentTiddler>>>\\n<$checkbox tiddler=<<config-title>> field=\\\"text\\\" checked=\\\"show\\\" unchecked=\\\"hide\\\" default=\\\"show\\\"/>\\n&#32;\\n<span class=\\\"tc-icon-wrapper\\\"><$transclude tiddler={{!!icon}}/></span>\\n&#32;\\n<$transclude field=\\\"caption\\\"/>\\n&#32;--&#32;\\n<i class=\\\"tc-muted\\\"><$transclude field=\\\"description\\\"/></i>\\n</$draggable>\\n\"\n    }\n  }\n}";
/**
* Seed the "发送给 Agent" TW button exactly once per wiki (mirrors the doc-note
* one-shot policy). The marker records the offer; afterwards the bundle is
* user-owned — deleting it and restarting dsh web does NOT recreate it, and
* edits are never overwritten. With `opts.force` the bundle is (re)written even
* when it already exists and the marker is (re)written — the settings page uses
* this for "重新初始化". Returns whether a bundle was written this call.
* Never throws.
*/
async function seedSendToAgent(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await client.get("$:/plugins/dsh-tiddlywiki/seed-send-to-agent").catch(() => void 0) !== void 0) return false;
	}
	const existing = await client.get(SEND_TO_AGENT_PLUGIN_TITLE).catch(() => void 0);
	let wrote = false;
	if (force || existing === void 0) {
		await client.put({
			title: SEND_TO_AGENT_PLUGIN_TITLE,
			text: SEND_TO_AGENT_BUNDLE_TEXT,
			type: "application/json",
			tags: [],
			"plugin-type": "plugin",
			name: "Send to Agent",
			author: "dsh-tiddlywiki",
			version: "0.3.2",
			description: "把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）"
		});
		wrote = true;
	}
	await client.put({
		title: SEND_TO_AGENT_MARKER_TITLE,
		text: "seeded-once",
		type: "text/plain",
		tags: []
	}).catch(() => void 0);
	return wrote;
}
//#endregion
//#region src/host/seed-home.ts
/** One-time marker: presence means "the home was offered once — hands off". */
const HOME_INDEX_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-home-index";
/** The $:/DefaultTiddlers body so 🏠 主页 opens by default in fresh wikis. */
const HOME_DEFAULT_TIDDLERS = "[[🏠 主页]]";
/** The home tiddlers, exactly as seeded (user-owned afterwards). */
const HOME_INDEX_ITEMS = [
	{
		"title": "🏠 主页",
		"tags": ["索引", "TableOfContents"],
		"type": "text/vnd.tiddlywiki",
		"text": "\\whitespace trim\n\n\\define quadrant-board()\n<div style=\"display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px;\">\n<$droppable class=\"tc-quadrant tc-quadrant-q1\" effect=\"move\"\nstyle.border=\"1px solid rgba(128,128,128,0.22)\"\nstyle.border-radius=\"10px\"\nstyle.padding=\"8px 12px\"\nstyle.background=\"linear-gradient(135deg,#e74c3c1a,transparent)\"\nactions=\"\"\"<$action-setfield $tiddler=<<actionTiddler>> $field=\"q\" $value=\"q1\"/>\"\"\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🔴 重要 · 紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q1]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q1]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q1]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</$droppable>\n<$droppable class=\"tc-quadrant tc-quadrant-q2\" effect=\"move\"\nstyle.border=\"1px solid rgba(128,128,128,0.22)\"\nstyle.border-radius=\"10px\"\nstyle.padding=\"8px 12px\"\nstyle.background=\"linear-gradient(135deg,#3498db1a,transparent)\"\nactions=\"\"\"<$action-setfield $tiddler=<<actionTiddler>> $field=\"q\" $value=\"q2\"/>\"\"\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🔵 重要 · 不紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q2]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q2]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q2]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</$droppable>\n<$droppable class=\"tc-quadrant tc-quadrant-q3\" effect=\"move\"\nstyle.border=\"1px solid rgba(128,128,128,0.22)\"\nstyle.border-radius=\"10px\"\nstyle.padding=\"8px 12px\"\nstyle.background=\"linear-gradient(135deg,#f39c121a,transparent)\"\nactions=\"\"\"<$action-setfield $tiddler=<<actionTiddler>> $field=\"q\" $value=\"q3\"/>\"\"\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🟠 紧急 · 不重要 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q3]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q3]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q3]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</$droppable>\n<$droppable class=\"tc-quadrant tc-quadrant-q4\" effect=\"move\"\nstyle.border=\"1px solid rgba(128,128,128,0.22)\"\nstyle.border-radius=\"10px\"\nstyle.padding=\"8px 12px\"\nstyle.background=\"linear-gradient(135deg,#95a5a61a,transparent)\"\nactions=\"\"\"<$action-setfield $tiddler=<<actionTiddler>> $field=\"q\" $value=\"q4\"/>\"\"\">\n<div style=\"font-weight:700; margin-bottom:6px;\">⚪ 不重要 · 不紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q4]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q4]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q4]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</$droppable>\n</div>\n\\end\n\n<$set name=\"today\" value=<<now \"YYYY0MM0DD\">>>\n\n!! 🏠 主页\n\n<div class=\"tc-message-box\">待办看板与知识库入口。</div>\n\n<div style=\"display:flex; gap:8px; flex-wrap:wrap; margin:8px 0;\">\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"padding:6px 16px; border:1px solid rgba(128,128,128,0.35); border-radius:8px; font-weight:600;\">\n<$action-navigate $to=\"所有标签\"/>\n🏷 所有标签\n</$button>\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"padding:6px 16px; border:1px solid rgba(128,128,128,0.35); border-radius:8px; font-weight:600;\">\n<$action-navigate $to=\"所有文章\"/>\n📚 所有文章\n</$button>\n</div>\n\n!! 📚 插件文档\n\n<div class=\"tc-message-box\">这里收纳插件初始化时 seed 进来的说明 / 教程 / 模板。给新文档打上 <code>dsh-docs</code> 标签即自动出现在本栏；不需要可自由删除（删除后不会自动恢复）。</div>\n\n<<tabs \"[tag[dsh-docs]!is[system]]\" \"dsh-tiddlywiki 插件说明\">>\n\n!! ✍️ 快速记笔记（完整编辑器）\n\n<div class=\"tc-message-box\">直接在首页写笔记：填标题、用工具栏写正文（支持 Markdown：**加粗**、*斜体*、# 标题、- 列表、> 引用 等）、加标签，点「💾 保存」即创建新笔记（默认 Markdown，标题留空用当前时间）。勾选「同时加入待办」并选象限，可一并进入下方四象限看板。</div>\n\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:10px 12px; margin:10px 0;\">\n\n<div style=\"display:flex; gap:6px; align-items:center; margin-bottom:6px;\">\n<$edit-text tiddler=\"$:/state/home-note/title\" tag=\"input\" placeholder=\"标题（留空用当前时间）\" style=\"flex:1; min-width:200px; padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\"/>\n</div>\n\n<$edit-text tiddler=\"$:/state/home-note/text\" tag=\"textarea\" class=\"tc-edit-texteditor\" autoHeight=\"yes\" minHeight=\"150px\" placeholder=\"正文：支持 **加粗**、*斜体*、# 标题、- 列表、> 引用 等 Markdown 语法\" style=\"width:100%; box-sizing:border-box; padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\">\n<$button class=\"tc-btn-invisible\" tooltip=\"加粗\" style=\"padding:2px 8px; font-weight:700;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"wrap-selection\" prefix=\"**\" suffix=\"**\" trimSelection=\"yes\"/>B</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"斜体\" style=\"padding:2px 8px; font-style:italic;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"wrap-selection\" prefix=\"*\" suffix=\"*\" trimSelection=\"yes\"/>I</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"删除线\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"wrap-selection\" prefix=\"~~\" suffix=\"~~\" trimSelection=\"yes\"/>S</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"标题\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"prefix-lines\" character=\"#\" count=\"1\"/>H</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"无序列表\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"prefix-lines\" character=\"-\" count=\"1\"/>•</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"有序列表\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"prefix-lines\" character=\"1.\" count=\"1\"/>1.</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"引用\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"prefix-lines\" character=\">\" count=\"1\"/>❝</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"行内代码\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"wrap-selection\" prefix=\"`\" suffix=\"`\" trimSelection=\"yes\"/>&lt;/&gt;</$button>\n</$edit-text>\n\n<div style=\"display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:6px;\">\n<$edit-text tiddler=\"$:/state/home-note/tags\" tag=\"input\" placeholder=\"标签（逗号分隔，可选）\" style=\"flex:1; min-width:160px; padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\"/>\n<$checkbox tiddler=\"$:/state/home-note/todo\" field=\"text\" checked=\"yes\" unchecked=\"no\"> 同时加入待办</$checkbox>\n<$select tiddler=\"$:/state/home-note/quadrant\" default=\"q2\" style=\"padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\">\n<option value=\"q1\">Q1 重要·紧急</option>\n<option value=\"q2\">Q2 重要·不紧急</option>\n<option value=\"q3\">Q3 紧急·不重要</option>\n<option value=\"q4\">Q4 不重要·不紧急</option>\n</$select>\n</div>\n\n<div style=\"display:flex; gap:6px; align-items:center; margin-top:8px; flex-wrap:wrap;\">\n<$button class=\"tc-btn-invisible\" style=\"padding:6px 16px; border-radius:6px; border:1px solid rgba(128,128,128,0.35); font-weight:600; background:rgba(128,128,128,0.06);\">\n<$list filter=\"[{$:/state/home-note/title}!is[blank]] [{$:/state/home-note/text}!is[blank]]\">\n<$action-createtiddler\n$basetitle={{{ [{$:/state/home-note/title}!is[blank]then{$:/state/home-note/title}] ~[<now \"YYYY-MM-DD-HHmm\">] }}}\ntext={{{ [{$:/state/home-note/text}] }}}\ntags={{{ [{$:/state/home-note/tags}split[,]split[，]trim[]] [{$:/state/home-note/todo}match[yes]then[todo]] +[join[ ]] }}}\nq={{{ [{$:/state/home-note/todo}match[yes]then{$:/state/home-note/quadrant}!is[blank]] ~[{$:/state/home-note/todo}match[yes]then[q2]] }}}\ntype=\"text/markdown\"\n$savetitle=\"$:/state/home-note/last-created\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/title\" text=\"\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/text\" text=\"\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/tags\" text=\"\"/>\n</$list>\n💾 保存\n</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"清空草稿\" style=\"padding:6px 12px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\">\n<$action-setfield $tiddler=\"$:/state/home-note/title\" text=\"\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/text\" text=\"\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/tags\" text=\"\"/>\n🗑 清空\n</$button>\n<$list filter=\"[{$:/state/home-note/last-created}!is[blank]]\">\n<span style=\"color:#2e7d32; font-size:0.9em;\">✅ 已保存：<$link to={{{ [{$:/state/home-note/last-created}] }}}>{{{$:/state/home-note/last-created}}}</$link></span>\n</$list>\n</div>\n\n</div>\n\n!! ✅ 待办 · 四象限\n\n<div class=\"tc-message-box\">在上方「快速记笔记」勾选「同时加入待办」即建任务（默认 Q2 重要·不紧急）；也可以给任意笔记打上 <code>todo</code> 标签收集到下方。点任务左侧方框即完成（自动加 <code>done</code> 标签并从看板消失）。下方「未分类待办」可直接拖动到上方任一象限，拖入即自动写入 <code>q</code> 字段完成分类（象限之间也可互相拖动调整）；把象限中的待办拖回「未分类」可取消分类。</div>\n\n<div style=\"margin:6px 0; color:#555;\">📅 今日到期 <b>{{{[tag[todo]!tag[done]field:due<today>count[]]}}}</b> 件　·　⏰ 已逾期 <b>{{{[tag[todo]!tag[done]get[due]compare:date:lt<today>count[]]}}}</b> 件</div>\n\n<<quadrant-board>>\n\n<div style=\"margin-top:10px; border:1px dashed rgba(128,128,128,0.35); border-radius:10px; padding:8px 12px;\">\n<div style=\"font-weight:700; margin-bottom:6px;\">📥 未分类待办 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]!has[q]count[]]}}} 件</span> <span style=\"color:#aaa; font-weight:400; font-size:0.78em;\">· 拖到上方象限自动分类</span></div>\n<$droppable class=\"tc-todo-inbox\" effect=\"move\" actions=\"\"\"<$action-deletefield $tiddler=<<actionTiddler>> $field=\"q\"/>\"\"\">\n<$list filter=\"[tag[todo]!tag[done]!has[q]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]!has[q]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无 · 把象限中的待办拖回这里可取消分类）</div></$list>\n</$droppable>\n</div>\n\n</$set>\n"
	},
	{
		"title": "所有标签",
		"tags": ["索引", "TableOfContents"],
		"type": "text/vnd.tiddlywiki",
		"text": "\\whitespace trim\n\n\\define tag-count() [all[tiddlers]!is[system]!tag[agent-written]tag<currentTiddler>count[]]\n\\define tag-list() [all[tiddlers]!is[system]!tag[agent-written]tags[]!prefix[$:/tags/]!match[索引]]\n\n\\define agent-notes-pure() [all[tiddlers]!is[system]tag[agent-written]!tag[human-edited]count[]]\n\\define agent-notes-mixed() [all[tiddlers]!is[system]tag[agent-written]tag[human-edited]count[]]\n\\define agent-tags-pure() [all[tiddlers]!is[system]tag[agent-written]!tag[human-edited]tags[]!prefix[$:/tags/]!match[索引]!match[agent-written]!match[human-edited]]\n\\define agent-tags-mixed() [all[tiddlers]!is[system]tag[agent-written]tag[human-edited]tags[]!prefix[$:/tags/]!match[索引]!match[agent-written]!match[human-edited]]\n\\define agent-count-pure() [all[tiddlers]!is[system]tag[agent-written]!tag[human-edited]tag<currentTiddler>count[]]\n\\define agent-count-mixed() [all[tiddlers]!is[system]tag[agent-written]tag[human-edited]tag<currentTiddler>count[]]\n\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"margin:6px 0; padding:4px 10px; border:1px solid rgba(128,128,128,0.3); border-radius:6px; font-size:0.9em;\">\n<$action-navigate $to=\"🏠 主页\"/>\n← 回主页\n</$button>\n\n!! 🏷 所有标签\n\n<div class=\"tc-message-box\">按笔记数量从多到少排序，仅统计人类笔记（Agent 撰写的笔记已排除，见下方「🤖 Agent 撰写的标签」）。点击标签，查看包含该标签的所有笔记。</div>\n\n<div style=\"margin-top:12px;\">\n<$list filter=\"[subfilter<tag-list>] +[!sortsub:number<tag-count>]\">\n<$set name=\"count\" value={{{ [subfilter<tag-count>] }}}>\n<div style=\"padding:7px 2px; border-bottom:1px solid rgba(128,128,128,0.15);\">\n<$button set=\"$:/state/tag\" setTo=<<currentTiddler>> class=\"tc-btn-invisible tc-tiddlylink\" style=\"width:100%; text-align:left;\">\n<$action-navigate $to=\"标签笔记\"/>\n<span style=\"font-weight:600; font-size:1.05em;\"><<currentTiddler>></span>\n<span style=\"color:#888; font-size:0.85em; margin-left:8px;\"><<count>> 篇</span>\n</$button>\n</div>\n</$set>\n</$list>\n</div>\n\n!! 🤖 Agent 撰写的标签\n\n<div class=\"tc-message-box\">以下标签来自带有 <code>agent-written</code> 标签（由 Agent 撰写）的笔记，与上方主列表分开统计。若某篇 Agent 笔记又被人类编辑过，请给它补打 <code>human-edited</code> 标签，即归入下方「Agent + 人工」档。</div>\n\n<div style=\"font-weight:700; margin:8px 0 4px;\">🦾 纯 Agent <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[subfilter<agent-notes-pure>]}}} 篇</span></div>\n<div style=\"margin-left:10px;\">\n<$list filter=\"[subfilter<agent-tags-pure>] +[!sortsub:number<agent-count-pure>]\">\n<$set name=\"count\" value={{{ [subfilter<agent-count-pure>] }}}>\n<div style=\"padding:7px 2px; border-bottom:1px solid rgba(128,128,128,0.15);\">\n<$button set=\"$:/state/tag\" setTo=<<currentTiddler>> class=\"tc-btn-invisible tc-tiddlylink\" style=\"width:100%; text-align:left;\">\n<$action-navigate $to=\"标签笔记\"/>\n<span style=\"font-weight:600; font-size:1.05em;\"><<currentTiddler>></span>\n<span style=\"color:#888; font-size:0.85em; margin-left:8px;\"><<count>> 篇</span>\n</$button>\n</div>\n</$set>\n</$list>\n<$list filter=\"[subfilter<agent-tags-pure>count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无纯 Agent 笔记）</div></$list>\n</div>\n\n<div style=\"font-weight:700; margin:10px 0 4px;\">🤝 Agent + 人工 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[subfilter<agent-notes-mixed>]}}} 篇</span></div>\n<div style=\"margin-left:10px;\">\n<$list filter=\"[subfilter<agent-tags-mixed>] +[!sortsub:number<agent-count-mixed>]\">\n<$set name=\"count\" value={{{ [subfilter<agent-count-mixed>] }}}>\n<div style=\"padding:7px 2px; border-bottom:1px solid rgba(128,128,128,0.15);\">\n<$button set=\"$:/state/tag\" setTo=<<currentTiddler>> class=\"tc-btn-invisible tc-tiddlylink\" style=\"width:100%; text-align:left;\">\n<$action-navigate $to=\"标签笔记\"/>\n<span style=\"font-weight:600; font-size:1.05em;\"><<currentTiddler>></span>\n<span style=\"color:#888; font-size:0.85em; margin-left:8px;\"><<count>> 篇</span>\n</$button>\n</div>\n</$set>\n</$list>\n<$list filter=\"[subfilter<agent-tags-mixed>count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无「Agent + 人工」笔记）</div></$list>\n</div>\n"
	},
	{
		"title": "标签笔记",
		"tags": ["索引"],
		"type": "text/vnd.tiddlywiki",
		"text": "\\whitespace trim\n\n<$set name=\"sel\" value={{{ [{$:/state/tag}] }}}>\n\n!! 标签：<<sel>>\n\n<div class=\"tc-message-box\">包含标签 <strong><<sel>></strong> 的所有笔记（自动收集，按最近修改排序）。</div>\n\n<ul>\n<$list filter=\"[all[tiddlers]!is[system]!has[draft.of]tag<sel>] +[!sort[modified]]\">\n<li><$link to=<<currentTiddler>>><$view field=\"title\"/></$link><span style=\"color:#aaa; font-size:0.85em;\"> · <$view field=\"modified\" format=\"relativedate\"/></span></li>\n</$list>\n</ul>\n\n</$set>\n"
	}
];
/**
* Seed the home/index tiddlers exactly once per wiki (mirrors the doc-note
* one-shot policy). Also writes $:/DefaultTiddlers → [[🏠 主页]] so the
* new home opens by default. With `force` the tiddlers are overwritten with the
* built-in content and the marker is (re)written — the settings page uses this
* for "重新初始化". Returns whether anything was written this call. Never throws.
*/
async function seedHomeIndex(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await client.get("$:/plugins/dsh-tiddlywiki/seed-home-index").catch(() => void 0) !== void 0) return false;
	}
	let wrote = false;
	for (const item of HOME_INDEX_ITEMS) {
		const existing = await client.get(item.title).catch(() => void 0);
		if (force || existing === void 0) {
			await client.put({
				title: item.title,
				text: item.text,
				type: item.type,
				tags: item.tags
			});
			wrote = true;
		}
	}
	const dt = await client.get("$:/DefaultTiddlers").catch(() => void 0);
	const dtText = typeof dt?.text === "string" ? dt.text.trim() : "";
	if (force || dt === void 0 || dtText === "GettingStarted" || dtText === "[[GettingStarted]]") {
		await client.put({
			title: "$:/DefaultTiddlers",
			text: HOME_DEFAULT_TIDDLERS,
			type: "text/vnd.tiddlywiki",
			tags: []
		});
		wrote = true;
	}
	await client.put({
		title: HOME_INDEX_MARKER_TITLE,
		text: "seeded-once",
		type: "text/plain",
		tags: []
	}).catch(() => void 0);
	return wrote;
}
/**
* Un-seed (反初始化): remove the home tiddlers and their marker, restoring the
* wiki's default home only when it still points at the seeded 🏠 主页
* (a user-customised $:/DefaultTiddlers is left alone). Deletion is idempotent —
* a tiddler already gone is not listed. Never throws.
*/
async function unseedHomeIndex(client) {
	const removed = [];
	for (const item of HOME_INDEX_ITEMS) if (await client.get(item.title).catch(() => void 0) !== void 0) {
		await client.delete(item.title);
		removed.push(item.title);
	}
	if (await client.get("$:/plugins/dsh-tiddlywiki/seed-home-index").catch(() => void 0) !== void 0) {
		await client.delete(HOME_INDEX_MARKER_TITLE);
		removed.push(HOME_INDEX_MARKER_TITLE);
	}
	const dt = await client.get("$:/DefaultTiddlers").catch(() => void 0);
	if (dt !== void 0 && typeof dt.text === "string" && dt.text.trim() === "[[🏠 主页]]") {
		await client.put({
			title: "$:/DefaultTiddlers",
			text: "[[GettingStarted]]",
			type: "text/vnd.tiddlywiki",
			tags: []
		});
		removed.push("$:/DefaultTiddlers");
	}
	return { removed };
}
//#endregion
//#region src/host/seed-all-articles.ts
/** One-time marker: presence means "the page was offered once — hands off". */
const ALL_ARTICLES_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-all-articles";
/** The 所有文章 page title. */
const ALL_ARTICLES_TITLE = "所有文章";
/** The page body, exactly as seeded (user-owned afterwards). */
const ALL_ARTICLES_TEXT = `\\whitespace trim

\\define page-size() [{$:/plugins/dsh-tiddlywiki/config}jsonget[ui],[allArticles],[pageSize]else[10]]
\\define agent-list() [all[tiddlers]!is[system]!has[draft.of]!tag[索引]tag[agent-written]!tag[human-edited]!sort[modified]]
\\define human-list() [all[tiddlers]!is[system]!has[draft.of]!tag[索引]!tag[agent-written]] [all[tiddlers]!is[system]!has[draft.of]!tag[索引]tag[agent-written]tag[human-edited]] +[!sort[modified]]

<$button class="tc-btn-invisible tc-tiddlylink" style="margin:6px 0; padding:4px 10px; border:1px solid rgba(128,128,128,0.3); border-radius:6px; font-size:0.9em;">
<$action-navigate $to="🏠 主页"/>
← 回主页
</$button>

!! 📚 所有文章

<div class="tc-message-box">分两列汇总全部 wiki 条目（不含系统页、草稿与带 <code>索引</code> 标签的导航页）：左列 🤖 Agent 撰写（带 <code>agent-written</code> 且未被人工编辑）；右列 👤 人工 / 人类（不含 <code>agent-written</code> 的人类笔记 ＋ 被人工编辑过的 <code>human-edited</code> 条目，即使带 <code>agent-written</code>）。两列各自分页，每页条数可在插件设置里调整。</div>

<div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:8px;">
<div style="border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:10px 12px;">
<div style="font-weight:700; margin-bottom:6px;">🤖 Agent 撰写 <span style="color:#888; font-weight:400; font-size:0.82em;">{{{[subfilter<agent-list>count[]]}}} 篇</span></div>
<$set name="page" tiddler="$:/state/dsh/all-articles/page/agent" emptyValue="0">
<$set name="ps" value={{{ [subfilter<page-size>] }}}>
<$set name="total" value={{{ [subfilter<agent-list>count[]] }}}>
<$set name="last" value={{{ [<total>] +[divide<ps>] +[ceil[0]] +[subtract[1]] +[max[0]] }}}>
<$set name="pagec" value={{{ [<page>] +[min<last>] +[max[0]] }}}>
<$set name="offset" value={{{ [<pagec>] +[multiply<ps>] }}}>
<div>
<$list filter="[subfilter<agent-list>] +[rest<offset>] +[first<ps>]">
<div style="display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);">
<$link to=<<currentTiddler>> style="flex:1;"><$view field="title"/></$link>
<span style="color:#aaa; font-size:0.82em;"><$view field="modified" format="relativedate"/></span>
</div>
</$list>
<$list filter="[subfilter<agent-list>count[]] +[match[0]]"><div style="color:#aaa; font-size:0.85em;">（暂无）</div></$list>
</div>
<$list filter="[<total>!match[0]]">
<div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
<$list filter="[<pagec>compare:number:gt[0]]">
<$button class="tc-btn-invisible" style="padding:2px 10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px;">
<$action-setfield $tiddler="$:/state/dsh/all-articles/page/agent" $field="text" $value={{{ [<pagec>] +[subtract[1]] +[max[0]] }}}/>
◀ 上一页
</$button>
</$list>
<span style="color:#888; font-size:0.85em;">第 {{{ [<pagec>] +[add[1]] }}} / {{{ [<total>] +[divide<ps>] +[ceil[0]] }}} 页</span>
<$list filter="[<pagec>compare:number:lt<last>]">
<$button class="tc-btn-invisible" style="padding:2px 10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px;">
<$action-setfield $tiddler="$:/state/dsh/all-articles/page/agent" $field="text" $value={{{ [<pagec>] +[add[1]] +[min<last>] }}}/>
下一页 ▶
</$button>
</$list>
</div>
</$list>
</$set>
</$set>
</$set>
</$set>
</$set>
</$set>
</div>
<div style="border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:10px 12px;">
<div style="font-weight:700; margin-bottom:6px;">👤 人工 / 人类 <span style="color:#888; font-weight:400; font-size:0.82em;">{{{[subfilter<human-list>count[]]}}} 篇</span></div>
<$set name="page" tiddler="$:/state/dsh/all-articles/page/human" emptyValue="0">
<$set name="ps" value={{{ [subfilter<page-size>] }}}>
<$set name="total" value={{{ [subfilter<human-list>count[]] }}}>
<$set name="last" value={{{ [<total>] +[divide<ps>] +[ceil[0]] +[subtract[1]] +[max[0]] }}}>
<$set name="pagec" value={{{ [<page>] +[min<last>] +[max[0]] }}}>
<$set name="offset" value={{{ [<pagec>] +[multiply<ps>] }}}>
<div>
<$list filter="[subfilter<human-list>] +[rest<offset>] +[first<ps>]">
<div style="display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);">
<$link to=<<currentTiddler>> style="flex:1;"><$view field="title"/></$link>
<span style="color:#aaa; font-size:0.82em;"><$view field="modified" format="relativedate"/></span>
</div>
</$list>
<$list filter="[subfilter<human-list>count[]] +[match[0]]"><div style="color:#aaa; font-size:0.85em;">（暂无）</div></$list>
</div>
<$list filter="[<total>!match[0]]">
<div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
<$list filter="[<pagec>compare:number:gt[0]]">
<$button class="tc-btn-invisible" style="padding:2px 10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px;">
<$action-setfield $tiddler="$:/state/dsh/all-articles/page/human" $field="text" $value={{{ [<pagec>] +[subtract[1]] +[max[0]] }}}/>
◀ 上一页
</$button>
</$list>
<span style="color:#888; font-size:0.85em;">第 {{{ [<pagec>] +[add[1]] }}} / {{{ [<total>] +[divide<ps>] +[ceil[0]] }}} 页</span>
<$list filter="[<pagec>compare:number:lt<last>]">
<$button class="tc-btn-invisible" style="padding:2px 10px; border:1px solid rgba(128,128,128,0.35); border-radius:6px;">
<$action-setfield $tiddler="$:/state/dsh/all-articles/page/human" $field="text" $value={{{ [<pagec>] +[add[1]] +[min<last>] }}}/>
下一页 ▶
</$button>
</$list>
</div>
</$list>
</$set>
</$set>
</$set>
</$set>
</$set>
</$set>
</div>
</div>
`;
/**
* Seed the 所有文章 page exactly once per wiki (mirrors the doc-note one-shot
* policy). With `opts.force` the page is overwritten with the built-in content
* and the marker is (re)written — the settings page uses this for
* "重新初始化". Returns whether the page was written this call. Never throws.
*/
async function seedAllArticles(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await client.get("$:/plugins/dsh-tiddlywiki/seed-all-articles").catch(() => void 0) !== void 0) return false;
	}
	const existing = await client.get(ALL_ARTICLES_TITLE).catch(() => void 0);
	let wrote = false;
	if (force || existing === void 0) {
		await client.put({
			title: ALL_ARTICLES_TITLE,
			text: ALL_ARTICLES_TEXT,
			type: "text/vnd.tiddlywiki",
			tags: ["索引"]
		});
		wrote = true;
	}
	await client.put({
		title: ALL_ARTICLES_MARKER_TITLE,
		text: "seeded-once",
		type: "text/plain",
		tags: []
	}).catch(() => void 0);
	return wrote;
}
/**
* Un-seed (反初始化): remove the 所有文章 page and its one-shot marker.
* Deletion is idempotent — a tiddler that was already gone is not listed.
* Never throws.
*/
async function unseedAllArticles(client) {
	const removed = [];
	for (const title of [ALL_ARTICLES_TITLE, ALL_ARTICLES_MARKER_TITLE]) if (await client.get(title).catch(() => void 0) !== void 0) {
		await client.delete(title);
		removed.push(title);
	}
	return { removed };
}
//#endregion
//#region src/host/seed-ui-styles.ts
/** One-time marker: presence means "the styles were offered once — hands off". */
const UI_STYLES_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-ui-styles";
/** The stylesheets, exactly as seeded (user-owned afterwards). */
const UI_STYLE_ITEMS = [
	{
		"title": "编辑器美化 CSS",
		"tags": ["$:/tags/Stylesheet"],
		"type": "text/css",
		"text": "/* ===== 编辑器美化（TiddlyWiki 5.4 + CodeMirror）===== */\n\n/* 字体 / 字号 / 行高 */\n.tc-editor .CodeMirror {\n  font-family: \"Fira Code VF\", Consolas, \"Courier New\", monospace;\n  font-size: 14px;\n  line-height: 1.7;\n}\n\n/* 编辑区内边距（呼吸感） */\n.tc-editor .CodeMirror-lines {\n  padding: 12px 14px;\n}\n\n/* 光标颜色 */\n.tc-editor .CodeMirror-cursor {\n  border-left: 2px solid #2e80ff !important;\n}\n\n/* 当前行高亮 */\n.tc-editor .CodeMirror-activeline-background {\n  background: rgba(46, 128, 255, 0.08);\n}\n\n/* 行号 */\n.tc-editor .CodeMirror-linenumber {\n  color: #9aa0a6;\n  padding-right: 10px;\n}\n\n/* 选区配色 */\n.tc-editor .CodeMirror ::selection {\n  background: rgba(46, 128, 255, 0.22);\n}\n\n/* 工具栏按钮：圆角 + 间距 */\n.tc-editor-toolbar button {\n  border-radius: 6px;\n  margin: 0 2px 2px 0;\n}\n\n/* 编辑页标题输入框：vanilla 默认 2.35em 过大，缩小字号与内边距 */\n.tc-tiddler-frame input.tc-edit-texteditor.tc-titlebar,\n.tc-tiddler-frame .tc-titlebar.tc-edit-texteditor {\n  font-size: 1.2em !important;\n  line-height: 1.35em !important;\n  padding: 4px 8px !important;\n}\n\n/* 查看模式标题：vanilla 默认 2.35em 过大，调小一些 */\n.tc-tiddler-frame .tc-tiddler-title .tc-titlebar,\n.tc-tiddler-frame .tc-tiddler-title h2.tc-title {\n  font-size: 1.3em !important;\n  line-height: 1.1em !important;\n}\n\n/* 侧边栏站点标题（sidebar 顶部的 wiki 站名）：vanilla 默认 2.35em 过大，调小 */\n.tc-sidebar .tc-site-title {\n  font-size: 1.5em !important;\n  line-height: 1.3em !important;\n}\n"
	},
	{
		"title": "标题与按钮区分开",
		"tags": ["$:/tags/Stylesheet"],
		"type": "text/css",
		"text": ".tc-titlebar h2 {\n	display: table-header-group;\n	word-wrap:break-word;\n	word-break:break-all;\n}\n"
	},
	{
		"title": "侧边栏窄屏自动隐藏.css",
		"tags": ["$:/tags/Stylesheet"],
		"type": "text/css",
		"text": "/* ===== 侧边栏窄屏自动隐藏 =====\n   视口（TW 面板/iframe 宽度）< 960px 时自动完全隐藏右侧 TiddlyWiki 侧边栏，\n   正文占满整行；窗口变宽 >= 960px 后自动恢复。\n   断点 959px 对齐主题默认 sidebarbreakpoint=960px（vanilla/snowwhite/starlight）。\n   想改断点：改下面媒体查询里的数值即可。\n   想恢复默认：删除本 tiddler。 */\n\n@media (max-width: 959px) {\n\n	/* 侧边栏整栏隐藏（含站点标题、各 sidebar 板块） */\n	.tc-sidebar-scrollable {\n		display: none !important;\n	}\n\n	/* 右上角「显示/隐藏侧边栏」chevron 按钮一并隐藏：\n	   窄屏下侧边栏已被 CSS 隐藏，此时按钮点击只会改 $:/state/sidebar 状态、\n	   界面却看不到变化，反而误导，故隐藏 */\n	.tc-hide-sidebar-btn,\n	.tc-show-sidebar-btn {\n		display: none !important;\n	}\n\n}\n"
	},
	{
		"title": "批注弹窗样式",
		"tags": ["$:/tags/Stylesheet"],
		"type": "text/css",
		"text": "/* 批注功能弹窗美化（dsh-ann-*） */\n.dsh-ann-popup {\n	border-radius: 12px;\n	padding: 14px 16px;\n	max-width: 520px;\n	width: max-content;\n	min-width: 300px;\n	box-shadow: 0 10px 30px rgba(0,0,0,.22);\n	border: 1px solid rgba(127,127,127,.25);\n}\n.dsh-ann-popup .dsh-ann-head {\n	display: flex;\n	align-items: center;\n	justify-content: space-between;\n	gap: 10px;\n	font-weight: 700;\n	font-size: 1.02em;\n	margin-bottom: 8px;\n}\n.dsh-ann-icon-btn {\n	border: none;\n	background: transparent;\n	cursor: pointer;\n	font-size: 1em;\n	line-height: 1;\n	padding: 2px 8px;\n	border-radius: 6px;\n	opacity: .55;\n}\n.dsh-ann-icon-btn:hover { opacity: 1; background: rgba(127,127,127,.15); }\n.dsh-ann-sub { font-size: .88em; margin: 4px 0; }\n.dsh-ann-quote {\n	background: rgba(127,127,127,.14);\n	padding: 2px 8px;\n	border-radius: 6px;\n	font-style: italic;\n}\n.dsh-ann-chip {\n	display: inline-block;\n	width: 12px;\n	height: 12px;\n	border-radius: 50%;\n	margin: 0 4px 0 8px;\n	border: 1px solid rgba(0,0,0,.18);\n	vertical-align: -1px;\n}\n.dsh-ann-label { font-size: .9em; margin: 10px 0 4px; }\n.dsh-ann-input {\n	width: 100%;\n	border-radius: 8px;\n	border: 1px solid rgba(127,127,127,.35);\n	padding: 6px 9px;\n	font-size: .95em;\n	resize: vertical;\n}\n.dsh-ann-input:focus {\n	outline: none;\n	border-color: #4a90d9;\n	box-shadow: 0 0 0 2px rgba(74,144,217,.22);\n}\n.dsh-ann-actions {\n	display: flex;\n	justify-content: flex-end;\n	align-items: center;\n	gap: 8px;\n	margin-top: 12px;\n}\n.dsh-ann-btn {\n	display: inline-block;\n	border-radius: 8px;\n	padding: 5px 14px;\n	cursor: pointer;\n	border: 1px solid rgba(127,127,127,.35);\n	background: rgba(127,127,127,.08);\n	font-size: .9em;\n	text-decoration: none !important;\n}\n.dsh-ann-btn:hover { background: rgba(127,127,127,.18); }\n.dsh-ann-btn-primary {\n	background: #4a90d9;\n	border-color: #4a90d9;\n	color: #fff !important;\n}\n.dsh-ann-btn-primary:hover { background: #3a80c9; }\n.dsh-ann-colors {\n	display: flex;\n	gap: 10px;\n	margin: 10px 0 12px;\n}\n.dsh-ann-swatch {\n	width: 34px;\n	height: 34px;\n	border-radius: 50%;\n	border: 2px solid rgba(0,0,0,.14);\n	cursor: pointer;\n	padding: 0;\n	transition: transform .12s ease, box-shadow .12s ease;\n}\n.dsh-ann-swatch:hover {\n	transform: scale(1.18);\n	box-shadow: 0 2px 8px rgba(0,0,0,.28);\n}\n.dsh-ann-sel { font-size: .88em; margin-top: 4px; }\n"
	},
	{
		"title": "menubar 顶栏加高样式",
		"tags": ["$:/tags/Stylesheet"],
		"type": "text/css",
		"text": "/* ==== menubar 顶栏加高 ====\n   默认顶栏约 28px（菜单项 padding 0.5em + line-height 1）。\n   想调高度：改 min-height 数值即可（如 40 / 48 / 56px）。\n   想恢复默认：删除本 tiddler。\n   flex 布局让菜单项在加高的栏内垂直居中；窄屏汉堡展开时保持纵向堆叠。 */\n\nnav.tc-menubar ul.tc-menubar-list {\n	display: flex;\n	align-items: center;\n	box-sizing: border-box;\n	min-height: 44px;\n}\n\nnav.tc-menubar .tc-menubar-narrow ul.tc-menubar-list {\n	flex-direction: column;\n	align-items: stretch;\n}\n"
	}
];
/**
* Seed the custom stylesheet tiddlers once per wiki (mirrors the one-shot
* policy). With opts.force the tiddlers are overwritten with the built-in
* content and the marker (re)written — the settings page uses this for
* "重新初始化". Returns whether anything was written this call. Never throws.
*/
async function seedUiStyles(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await client.get("$:/plugins/dsh-tiddlywiki/seed-ui-styles").catch(() => void 0) !== void 0) return false;
	}
	let wrote = false;
	for (const item of UI_STYLE_ITEMS) {
		const existing = await client.get(item.title).catch(() => void 0);
		if (force || existing === void 0) {
			await client.put({
				title: item.title,
				text: item.text,
				type: item.type,
				tags: item.tags
			});
			wrote = true;
		}
	}
	await client.put({
		title: UI_STYLES_MARKER_TITLE,
		text: "seeded-once",
		type: "text/plain",
		tags: []
	}).catch(() => void 0);
	return wrote;
}
/**
* Un-seed (反初始化): remove the stylesheet tiddlers and their marker.
* Deletion is idempotent — a tiddler already gone is not listed. Never throws.
*/
async function unseedUiStyles(client) {
	const removed = [];
	for (const item of UI_STYLE_ITEMS) if (await client.get(item.title).catch(() => void 0) !== void 0) {
		await client.delete(item.title);
		removed.push(item.title);
	}
	if (await client.get("$:/plugins/dsh-tiddlywiki/seed-ui-styles").catch(() => void 0) !== void 0) {
		await client.delete(UI_STYLES_MARKER_TITLE);
		removed.push(UI_STYLES_MARKER_TITLE);
	}
	return { removed };
}
//#endregion
//#region src/host/seed-menubar-theme.ts
/** One-time marker: presence means "the override was offered once — hands off". */
const MENUBAR_THEME_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-menubar-theme";
/** The stylesheet tiddler that adapts the menubar to the active palette. */
const MENUBAR_THEME_TIDDLER = "$:/plugins/dsh-tiddlywiki/menubar-theme";
/**
* The override stylesheet body, exactly as seeded (user-owned afterwards).
* `<<colour background>>` / `<<colour foreground>>` resolve against the ACTIVE
* palette at render time; `!important` beats the menubar plugin's own rules
* regardless of stylesheet ordering. `\rules` mirrors the menubar plugin's own
* styles.tid (macrocallinline needed for `<<colour>>`).
*/
const MENUBAR_THEME_TEXT = `\\rules only filteredtranscludeinline transcludeinline macrodef macrocallinline

nav.tc-menubar ul.tc-menubar-list {
	background: <<colour background>> !important;
}

nav.tc-menubar li.tc-menubar-item > a,
nav.tc-menubar li.tc-menubar-item > button {
	color: <<colour foreground>> !important;
	fill: <<colour foreground>> !important;
	border-radius: 6px !important;
	transition: background-color 120ms ease, color 120ms ease;
}

nav.tc-menubar li.tc-menubar-item svg {
	fill: <<colour foreground>> !important;
}

nav.tc-menubar li.tc-menubar-item > a:hover,
nav.tc-menubar li.tc-menubar-item > button:hover {
	background: color-mix(in srgb, <<colour foreground>> 12%, transparent) !important;
	color: <<colour foreground>> !important;
	fill: <<colour foreground>> !important;
}

nav.tc-menubar li.tc-menubar-item > a:active,
nav.tc-menubar li.tc-menubar-item > button:active {
	background: color-mix(in srgb, <<colour foreground>> 20%, transparent) !important;
	color: <<colour foreground>> !important;
	fill: <<colour foreground>> !important;
}

nav.tc-menubar li.tc-menubar-item > a.tc-selected,
nav.tc-menubar li.tc-menubar-item > button.tc-selected {
	background: color-mix(in srgb, <<colour foreground>> 16%, transparent) !important;
	color: <<colour foreground>> !important;
	fill: <<colour foreground>> !important;
}

nav.tc-menubar li.tc-menubar-item > a:focus-visible,
nav.tc-menubar li.tc-menubar-item > button:focus-visible {
	outline: none !important;
	box-shadow: none !important;
}
`;
/**
* Seed the menubar theme override exactly once per wiki (mirrors the other
* one-shot seeds). With `opts.force` the tiddler is overwritten with the
* built-in content and the marker (re)written — the settings page uses this
* for "重新初始化". Returns whether anything was written this call. Never throws.
*/
async function seedMenubarTheme(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await client.get("$:/plugins/dsh-tiddlywiki/seed-menubar-theme").catch(() => void 0) !== void 0) return false;
	}
	const existing = await client.get(MENUBAR_THEME_TIDDLER).catch(() => void 0);
	let wrote = false;
	if (force || existing === void 0) {
		await client.put({
			title: MENUBAR_THEME_TIDDLER,
			text: MENUBAR_THEME_TEXT,
			type: "text/vnd.tiddlywiki",
			tags: ["$:/tags/Stylesheet"]
		});
		wrote = true;
	}
	await client.put({
		title: MENUBAR_THEME_MARKER_TITLE,
		text: "seeded-once",
		type: "text/plain",
		tags: []
	}).catch(() => void 0);
	return wrote;
}
/**
* Un-seed (反初始化): remove the menubar override stylesheet and its marker,
* returning the wiki to the pre-seed state (the tiddlywiki/menubar top bar
* falls back to its original colour-mapping behaviour). Deletion is
* idempotent — a tiddler already gone is not listed. Never throws.
*/
async function unseedMenubarTheme(client) {
	const removed = [];
	for (const title of [MENUBAR_THEME_TIDDLER, MENUBAR_THEME_MARKER_TITLE]) if (await client.get(title).catch(() => void 0) !== void 0) {
		await client.delete(title);
		removed.push(title);
	}
	return { removed };
}
//#endregion
//#region src/host/seed-clip-bridge.ts
/** The instruction tiddler's title (a normal, searchable note). */
const CLIP_BRIDGE_DOC_TITLE = "本地剪藏桥（书签小工具）";
/** One-time marker: presence = "the doc was offered once — hands off". */
const CLIP_BRIDGE_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-clip-bridge";
/**
* The bookmarklet itself (ONE line, no backticks / ${}). Mirrors the bridge's
* defaults (port 8618, empty token); users adjust the two placeholders. Used
* BOTH as the copy-paste code fence AND (HTML-attribute-escaped) as the
* draggable anchor href — keep them in sync (verify-clip-bridge.mjs asserts it).
*/
const CLIP_BRIDGE_BOOKMARKLET = `javascript:(function(){var t=(document.title||location.hostname).trim();var sel=(window.getSelection()?window.getSelection().toString():'').trim();var imgs=[],seen={};function add(u,a,c){u=String(u||'').trim();if(!u||u.indexOf('data:')===0||u.indexOf('blob:')===0||seen[u])return;seen[u]=1;imgs.push({u:u,a:(a||'').slice(0,60),c:!!c})}var mm=document.querySelector('meta[property="og:image"],meta[name="twitter:image"],link[rel="image_src"]');if(mm){var mu=mm.content||mm.href;if(mu)add(mu,'封面',true)}for(var ii=0;ii<document.images.length;ii++){var im=document.images[ii],iu=im.currentSrc||im.src;if(!iu)continue;if(im.naturalWidth&&im.naturalHeight&&(im.naturalWidth<80||im.naturalHeight<80))continue;add(iu,im.alt||im.title,false)}if(imgs.length>60)imgs=imgs.slice(0,60);var ov=document.createElement('div');ov.style.cssText='position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(10,14,20,.62);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:4vh 12px';var p=document.createElement('div');p.id='cb_p';p.style.cssText='background:#1c2128;border:1px solid #3a414c;border-radius:12px;max-width:680px;width:100%;max-height:86vh;overflow:auto;padding:16px 18px;color:#e6e6e6;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box';p.innerHTML='<div style="font-size:16px;font-weight:700">剪藏到 TiddlyWiki</div><label style="display:block;font-size:12px;opacity:.7;margin:10px 0 2px">标题</label><input id="cb_t" style="width:100%;box-sizing:border-box;background:#0f131a;border:1px solid #3a414c;border-radius:6px;color:#eee;padding:7px 9px;font-size:13px" value=""><label style="display:block;font-size:12px;opacity:.7;margin:10px 0 2px">正文 / 选中文字（可选）</label><textarea id="cb_s" rows="5" style="width:100%;box-sizing:border-box;background:#0f131a;border:1px solid #3a414c;border-radius:6px;color:#eee;padding:7px 9px;font-size:13px;resize:vertical"></textarea>';var Q=function(id){return p.querySelector('#'+id)};var grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin:10px 0';for(var j=0;j<imgs.length;j++){(function(idx){var it=imgs[idx],lab=document.createElement('label');lab.style.cssText='display:flex;flex-direction:column;gap:4px;cursor:pointer;background:#0f131a;border:1px solid #3a414c;border-radius:8px;padding:6px;overflow:hidden';var top=document.createElement('div');top.style.cssText='position:relative';var imgE=document.createElement('img');imgE.style.cssText='display:block;width:100%;height:76px;object-fit:cover;border-radius:4px;background:#000';imgE.src=it.u;imgE.loading='lazy';imgE.referrerPolicy='no-referrer';top.appendChild(imgE);if(it.c){var bd=document.createElement('span');bd.style.cssText='position:absolute;top:2px;left:2px;background:#f5a623;color:#000;font-size:10px;padding:0 4px;border-radius:3px';bd.textContent='封面';top.appendChild(bd)}var row=document.createElement('div');row.style.cssText='display:flex;align-items:center;gap:6px';var ch=document.createElement('input');ch.type='checkbox';ch.id='cb_i_'+idx;ch.checked=it.c;var nm=document.createElement('span');nm.style.cssText='font-size:11px;opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1';nm.textContent=it.a||(it.u.split('/').pop()||'');nm.title=it.u;row.appendChild(ch);row.appendChild(nm);lab.appendChild(top);lab.appendChild(row);grid.appendChild(lab)})(j)};var foot=document.createElement('div');foot.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-top:12px';var cnt=document.createElement('span');cnt.id='cb_cnt';cnt.style.cssText='font-size:12px;opacity:.75';foot.appendChild(cnt);var btns=document.createElement('div');btns.style.cssText='display:flex;gap:8px';var cancel=document.createElement('button');cancel.textContent='取消';cancel.style.cssText='cursor:pointer;background:#333a45;border:0;color:#eee;border-radius:6px;padding:7px 14px;font-size:13px';var go=document.createElement('button');go.id='cb_btn';go.textContent='剪藏';go.style.cssText='cursor:pointer;background:#2f6feb;border:0;color:#fff;border-radius:6px;padding:7px 14px;font-size:13px';btns.appendChild(cancel);btns.appendChild(go);foot.appendChild(btns);p.appendChild(grid);p.appendChild(foot);ov.appendChild(p);document.body.appendChild(ov);Q('cb_t').value=t;Q('cb_s').value=sel;function upd(){var n=0;for(var q=0;q<imgs.length;q++){var c=Q('cb_i_'+q);if(c&&c.checked)n++}cnt.textContent=(imgs.length?('共 '+imgs.length+' 张，已选 '+n+' 张'):'页面没有可选图片（仍可剪藏文字）')}upd();grid.onchange=function(){upd()};function close(){document.removeEventListener('keydown',onKey,true);if(ov.parentNode){document.body.removeChild(ov)}}var onKey=function(ev){if(ev.key==='Escape')close()};cancel.onclick=close;ov.onclick=function(ev){if(ev.target===ov)close()};p.onclick=function(ev){ev.stopPropagation()};document.addEventListener('keydown',onKey,true);function doClip(){var tt=(Q('cb_t').value||'').trim()||t;var urls=[];for(var k=0;k<imgs.length;k++){var ck=Q('cb_i_'+k);if(ck&&ck.checked)urls.push(imgs[k].u)}var btn=Q('cb_btn');btn.disabled=true;btn.textContent='剪藏中…';fetch('http://127.0.0.1:8618/clip',{method:'POST',headers:{'content-type':'application/json','x-clip-token':''},body:JSON.stringify({title:tt,url:location.href,text:(Q('cb_s').value||''),images:urls})}).then(function(r){return r.json().then(function(j){return {ok:r.ok&&!!j.ok,error:(j.error||('HTTP '+r.status)),title:j.title,images:j.images||[]}})}).then(function(res){var okN=0;for(var v=0;v<res.images.length;v++)if(res.images[v].ok)okN++;var line=res.ok?('已剪藏：'+(res.title||tt)+(res.images.length?('　图片 '+okN+'/'+res.images.length+' 成功'):'')):('剪藏失败：'+res.error);p.innerHTML='<div style="font-size:15px;font-weight:700;margin:8px 0">'+line+'</div><div style="font-size:12px;opacity:.8;margin-bottom:12px">图片以附件形式存进知识库（失败项已降级为链接）。</div><button id="cb_d" style="cursor:pointer;background:#2f6feb;border:0;color:#fff;border-radius:6px;padding:7px 14px;font-size:13px">完成</button>';Q('cb_d').onclick=close}).catch(function(e){p.innerHTML='<div style="font-size:14px;color:#ff8080;font-weight:700;margin:8px 0">剪藏桥不可达</div><div style="font-size:12px;opacity:.85;margin-bottom:12px">'+(e&&e.message?e.message:'')+'　请确认：① dsh web 在运行；② 设置页已启用「本地剪藏桥」；③ 书签里的端口与设置一致；④ 设置了 token 的话书签已带上。</div><button id="cb_d" style="cursor:pointer;background:#333a45;border:0;color:#fff;border-radius:6px;padding:7px 14px;font-size:13px">关闭</button>';Q('cb_d').onclick=close})}go.onclick=doClip})()`;
/** Escape & " < for an HTML attribute (the bookmarklet href). */
function htmlAttrEscape(s) {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
/**
* The instruction body, Markdown. Ships BOTH a draggable anchor (raw HTML;
* verified to survive TW 5.4.1 markdown rendering with its javascript: href
* intact) and the copy-paste code fence — same CLIP_BRIDGE_BOOKMARKLET.
*/
const CLIP_BRIDGE_DOC_TEXT = `# 本地剪藏桥（书签小工具）

把任意网页**一键剪藏进 TiddlyWiki**：浏览器里点一下书签，会弹出一个小浮层——确认（或修改）标题与选中文字、**勾选想要的图片**，点「剪藏」即写入本插件的知识库（默认打 \`clip\` 标签，随 wiki 自动 git commit），之后随时可在 TW 里整理、让 Agent 检索。

## 原理

DSH 进程里运行着一个只监听 **127.0.0.1**（本机回环）的 HTTP 小桥——端口默认 \`8618\`，可在设置页改。书签浮层把 {标题, URL, 选中文字, 图片 URL 列表} POST 给它，小桥经插件唯一的写入通道写进 TiddlyWiki：

- **文字** → 一篇笔记（Markdown；选了图则自动改用 wikitext，图片用 \`[img[标题]]\` 内嵌展示）；
- **图片** → 由小桥（DSH 进程侧，无浏览器跨域限制）**下载字节**，存成**二进制附件 tiddler**（\`type: image/…\` + base64 正文，即 TW 原生二进制附件形态），同一篇笔记里内嵌显示并保留 \`clip-url\` / \`clip-note\` 溯源字段；
- 某张图下载失败（防盗链/断链）→ **自动降级为链接**，不阻塞整次剪藏。

## 启用（三步）

1. **开启**：DSH 设置 →「TiddlyWiki 知识库」→ 常规配置 → 勾选 **「启用本地剪藏桥」** → 保存。**立即生效，无需重启 dsh web**（未勾选时桥不会放行任何写入）。
2. **（可选）设置 token**：强烈建议在同一处填一个 **\`bridge.token\`** 共享口令——非空后，书签请求必须带上 \`x-clip-token\` 头才能写入，防止你在浏览器里访问的任意网页偷偷往 wiki 里塞内容。**改端口（\`bridge.port\`）则需要重启 dsh web 生效**。
3. **装书签**（二选一）：
   - **拖拽安装**：按住下面这个按钮，**拖到浏览器书签栏**（或地址栏）松手即装好，自动命名为「剪藏」：

   <a href="${htmlAttrEscape(CLIP_BRIDGE_BOOKMARKLET)}" draggable="true" title="按住我，拖到浏览器书签栏即可安装" style="display:inline-block;padding:8px 16px;border-radius:8px;background:#2f6feb;color:#fff;text-decoration:none;font-size:14px;cursor:grab;margin:4px 0">📌 剪藏 — 拖到书签栏</a>

   - **复制粘贴**（部分浏览器/环境禁止从页面拖动书签时用）：浏览器书签栏新建书签，名称随意（如「剪藏」），**地址（URL）粘贴下面整段代码**。若设置了 token，把代码里 \`'x-clip-token': ''\` 的空字符串换成你的口令；若改了端口，把 \`127.0.0.1:8618\` 一起改掉：

\`\`\`javascript
${CLIP_BRIDGE_BOOKMARKLET}
\`\`\`

## 使用

打开任意网页 → 选中想保留的文字（可选）→ 点书签 → 浮层里：

- **标题**可改；**正文**自动填入选中的文字（可编辑）；
- **图片区**列出页面图片的缩略图（自动跳过 <80px 的小图标与 data:/blob: 占位，去重；页面声明了 \`og:image\` 的会标「封面」并默认勾选）——勾选想剪的（最多 10 张）；
- 点「**剪藏**」→ 提示「已剪藏：〈标题〉（图片 n/m 成功）」。

笔记以**页面标题**命名（重名自动追加 \`（2）\`、\`（3）\`…，绝不覆盖已有笔记）。**图片是二进制附件**（打开笔记直接看到图；每张带 \`clip-url\`、\`clip-note\` 字段溯源）；某张图没存成（网站防盗链等）会在笔记里留一行链接。可用「发送给 Agent」一键把整篇丢给会话整理。

## 安全说明

- 桥**只监听 127.0.0.1**，并校验请求的 \`Host\` 头（只放行 127.0.0.1 / localhost / ::1）——恶意网页即使把自己的域名解析到本机回环（DNS rebinding）也调不动它。
- **强烈建议设置 \`bridge.token\`**：不设 token 时，你在浏览器里访问的**任何网页**都能向本机桥提交内容（它们读不到回应，但能往 wiki 里写——只是污染笔记，不是执行代码）。token 只有你知道，网页拿不到。
- 图片**只下载你勾选的那几个 URL**，由 DSH 本机发起（无跨域限制），存进的是字节副本；不做任何代码执行。
- 图片附件**不参与 \`search\` / \`recent\`**（按设计排除二进制，避免刷屏）；\`get\` 对附件只返回元数据。想删某张图，直接在 TW 里删除对应 tiddler 即可。

## 配置项

| 项 | 默认 | 说明 |
|---|---|---|
| \`bridge.enabled\` | \`false\` | 是否启用剪藏桥（设置页保存后立即生效） |
| \`bridge.port\` | \`8618\` | 监听端口（改动需**重启 dsh web** 生效） |
| \`bridge.token\` | 空 | 共享口令；非空时校验 \`x-clip-token\` 请求头 |
| \`bridge.tag\` | \`clip\` | 剪藏笔记默认 tag |

## 命令行/脚本方式（可选）

不想用书签时，直接 POST 也行（适合脚本、API 调用；\`images\` 字段可选，传了就存附件）：

\`\`\`bash
curl -X POST http://127.0.0.1:8618/clip ^
  -H "content-type: application/json" ^
  -H "x-clip-token: 你的token（没设置就删掉这行）" ^
  -d "{\\"title\\":\\"测试\\",\\"url\\":\\"https://example.com\\",\\"text\\":\\"测试选中文字\\",\\"images\\":[\\"https://example.com/a.png\\"]}"
\`\`\`

成功返回 \`{"ok":true,"title":"测试",...,"images":[{"url":"...","ok":true,"title":"测试 图片 1.png"}]}\`；未启用时返回 503。

## 常见问题

- 点书签提示「剪藏桥不可达」：① dsh web 没在运行；② 设置页没勾选启用；③ 书签里的端口和设置不一致；④ 设置了 token 但书签没带上。
- 图片显示「× 失败」：多为网站防盗链/禁止外链下载，笔记里会留链接兜底；也可先在浏览器里把图片另存，再手动拖进 TW。
- 端口被占用：换一个 \`bridge.port\` 后**重启 dsh web**。
- 想彻底关掉：设置页取消勾选保存即可（端口虽在监听但拒绝任何写入），或直接改插件行 config 的 \`bridge.enabled: false\`。
`;
/**
* Seed the instruction tiddler once per wiki (mirrors seed-notes one-shot
* policy: marker = offered; from then on the doc is user-owned and never
* re-created). force re-writes doc + marker (settings page「重新初始化」).
* Never throws.
*/
async function seedClipBridge(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await client.get("$:/plugins/dsh-tiddlywiki/seed-clip-bridge").catch(() => void 0) !== void 0) return false;
	}
	const existing = await client.get(CLIP_BRIDGE_DOC_TITLE).catch(() => void 0);
	let wrote = false;
	if (force || existing === void 0) {
		await client.put({
			title: CLIP_BRIDGE_DOC_TITLE,
			text: CLIP_BRIDGE_DOC_TEXT,
			type: "text/markdown",
			tags: ["docs", "dsh-docs"]
		});
		wrote = true;
	}
	await client.put({
		title: CLIP_BRIDGE_MARKER_TITLE,
		text: "seeded-once",
		type: "text/plain",
		tags: []
	}).catch(() => void 0);
	return wrote;
}
/** 反初始化: remove the doc tiddler + its one-shot marker (idempotent). */
async function unseedClipBridge(client) {
	const removed = [];
	for (const title of [CLIP_BRIDGE_DOC_TITLE, CLIP_BRIDGE_MARKER_TITLE]) if (await client.get(title).catch(() => void 0) !== void 0) {
		await client.delete(title);
		removed.push(title);
	}
	return { removed };
}
//#endregion
//#region src/host/seed-render.ts
/** The packaged plugin tiddler title (a TW system tiddler, type application/json). */
const RENDER_PLUGIN_TITLE = "$:/plugins/dsh/render";
/** One-time marker: presence means "the route was offered once — hands off". */
const RENDER_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-render";
/** The bundle's JSON text (`{"tiddlers": {...}}`), exactly as TW stores it. */
const RENDER_BUNDLE_TEXT = "{\n  \"tiddlers\": {\n    \"$:/plugins/dsh/render/plugin.info\": {\n      \"title\": \"$:/plugins/dsh/render/plugin.info\",\n      \"type\": \"application/json\",\n      \"text\": \"{\\\"title\\\":\\\"$:/plugins/dsh/render\\\",\\\"name\\\":\\\"DSH Wiki Render\\\",\\\"description\\\":\\\"把 wiki 文本原生渲染成 HTML 片段（POST /render 服务端路由），供 DSH 回复流工具卡与 wiki 链接跳转使用\\\",\\\"author\\\":\\\"dsh-tiddlywiki\\\",\\\"version\\\":\\\"0.1.0\\\",\\\"plugin-type\\\":\\\"plugin\\\"}\"\n    },\n    \"$:/plugins/dsh/render/server-routes/render.js\": {\n      \"title\": \"$:/plugins/dsh/render/server-routes/render.js\",\n      \"type\": \"application/javascript\",\n      \"module-type\": \"route\",\n      \"text\": \"/*\\\\\\ntitle: $:/plugins/dsh/render/server-routes/render.js\\ntype: application/javascript\\nmodule-type: route\\n\\nPOST /render — native TiddlyWiki → HTML fragment for the DSH reply stream\\n\\nBody (JSON in state.data):\\n  { title }                       render an existing tiddler's wikified body\\n  { text, contextTitle?, parseAsInline? }\\n                                  render arbitrary wiki text as a fragment\\n\\\\*/\\n\\\"use strict\\\";\\n\\n/*\\nThe fragment's internal wiki links are rewritten to the SAME-ORIGIN DSH proxy\\nhash (`/dsh-tiddlywiki/tw/#<title>`) by overriding the `tv-wikilink-template`\\nvariable while rendering. Verified against tiddlywiki 5.4.1's link widget:\\n`link.js` expands `$uri_encoded$` (encodeURIComponentExtended) into the href,\\nso the default `#Title` becomes `/dsh-tiddlywiki/tw/#Title`. The DSH page's\\ndocument-level click interceptor + the embedded TW's hash navigation\\n(story.js reads the hash via decodeURIComponentSafe) both handle that href —\\nno post-hoc string rewriting needed.\\n*/\\nvar WIKILINK_TEMPLATE = \\\"/dsh-tiddlywiki/tw/#$uri_encoded$\\\";\\n\\nexports.methods = [\\\"POST\\\"];\\n\\nexports.path = /^\\\\/render$/;\\n\\nexports.info = {\\n\\tpriority: 100\\n};\\n\\nfunction sendJson(response,status,payload) {\\n\\tresponse.writeHead(status,{\\\"Content-Type\\\":\\\"application/json; charset=utf-8\\\",\\\"Cache-Control\\\":\\\"no-store\\\"});\\n\\tresponse.end(JSON.stringify(payload));\\n}\\n\\nexports.handler = function(request,response,state) {\\n\\tvar body;\\n\\ttry {\\n\\t\\tbody = JSON.parse(state.data || \\\"{}\\\");\\n\\t} catch(e) {\\n\\t\\tsendJson(response,400,{ok:false,error:\\\"invalid JSON body\\\"});\\n\\t\\treturn;\\n\\t}\\n\\ttry {\\n\\t\\tvar variables = {\\n\\t\\t\\t\\\"tv-wikilink-template\\\": WIKILINK_TEMPLATE\\n\\t\\t};\\n\\t\\tif(typeof body.title === \\\"string\\\" && body.title.length > 0) {\\n\\t\\t\\t// Render an existing tiddler's wikified body (block parse, so\\n\\t\\t\\t// headings / tables / lists render natively).\\n\\t\\t\\tvar tiddler = state.wiki.getTiddler(body.title);\\n\\t\\t\\tif(!tiddler) {\\n\\t\\t\\t\\tsendJson(response,404,{ok:false,notFound:true,title:body.title});\\n\\t\\t\\t\\treturn;\\n\\t\\t\\t}\\n\\t\\t\\tvariables.currentTiddler = body.title;\\n\\t\\t\\tvar html = state.wiki.renderText(\\\"text/html\\\",\\\"text/vnd.tiddlywiki\\\",tiddler.fields.text,{\\n\\t\\t\\t\\tparseAsInline: false,\\n\\t\\t\\t\\tvariables: variables\\n\\t\\t\\t});\\n\\t\\t\\tresponse.writeHead(200,{\\\"Content-Type\\\":\\\"text/html; charset=utf-8\\\",\\\"Cache-Control\\\":\\\"no-store\\\"});\\n\\t\\t\\tresponse.end(html);\\n\\t\\t\\treturn;\\n\\t\\t}\\n\\t\\tif(typeof body.text === \\\"string\\\") {\\n\\t\\t\\t// Render arbitrary wiki text (contextTitle gives currentTiddler so\\n\\t\\t\\t// links/transclusions resolve in that tiddler's context).\\n\\t\\t\\tif(typeof body.contextTitle === \\\"string\\\" && body.contextTitle.length > 0) {\\n\\t\\t\\t\\tvariables.currentTiddler = body.contextTitle;\\n\\t\\t\\t}\\n\\t\\t\\tvar inline = body.parseAsInline === true;\\n\\t\\t\\tvar textHtml = state.wiki.renderText(\\\"text/html\\\",\\\"text/vnd.tiddlywiki\\\",body.text,{\\n\\t\\t\\t\\tparseAsInline: inline,\\n\\t\\t\\t\\tvariables: variables\\n\\t\\t\\t});\\n\\t\\t\\tresponse.writeHead(200,{\\\"Content-Type\\\":\\\"text/html; charset=utf-8\\\",\\\"Cache-Control\\\":\\\"no-store\\\"});\\n\\t\\t\\tresponse.end(textHtml);\\n\\t\\t\\treturn;\\n\\t\\t}\\n\\t\\tsendJson(response,400,{ok:false,error:\\\"body must provide \\\\\\\"title\\\\\\\" or \\\\\\\"text\\\\\\\"\\\"});\\n\\t} catch(e) {\\n\\t\\tsendJson(response,500,{ok:false,error:String((e && e.message) || e)});\\n\\t}\\n};\\n\"\n    }\n  }\n}";
/**
* Seed the "原生渲染路由" TW plugin exactly once per wiki (mirrors the
* send-to-agent one-shot policy). The marker records the offer; afterwards the
* bundle is user-owned — deleting it and restarting dsh web does NOT recreate
* it, and edits are never overwritten. With `opts.force` the bundle is
* (re)written even when it already exists and the marker is (re)written — the
* settings page uses this for "重新初始化". Returns whether a bundle was
* written this call. Never throws.
*/
async function seedRenderRoute(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await client.get("$:/plugins/dsh-tiddlywiki/seed-render").catch(() => void 0) !== void 0) return false;
	}
	const existing = await client.get(RENDER_PLUGIN_TITLE).catch(() => void 0);
	let wrote = false;
	if (force || existing === void 0) {
		await client.put({
			title: RENDER_PLUGIN_TITLE,
			text: RENDER_BUNDLE_TEXT,
			type: "application/json",
			tags: [],
			"plugin-type": "plugin",
			name: "DSH Wiki Render",
			author: "dsh-tiddlywiki",
			version: "0.1.0",
			description: "把 wiki 文本原生渲染成 HTML 片段（POST /render 服务端路由），供 DSH 回复流工具卡与 wiki 链接跳转使用"
		});
		wrote = true;
	}
	await client.put({
		title: RENDER_MARKER_TITLE,
		text: "seeded-once",
		type: "text/plain",
		tags: []
	}).catch(() => void 0);
	return wrote;
}
//#endregion
//#region src/host/seeds.ts
const presentOf = (ctx, title) => ctx.client.get(title).then((t) => t !== void 0).catch(() => false);
/** Build the per-item detail from an unseed result. */
const removedDetail = (id, removed) => ({
	id,
	ok: true,
	wrote: false,
	detail: removed.length > 0 ? `已移除：${removed.join("、")}` : "本就不存在，无需移除"
});
/**
* Define a seed from a small spec, killing the id/title/description
* triplication and the try/catch boilerplate every registry entry used to
* repeat by hand:
*   - `presentTitle` → default check: is that tiddler present?
*   - `check`        → custom presence check (overrides presentTitle).
*   - `write`        → built-in content writer; true = (re)written this call.
*   - `run`          → custom runner (overrides the standard write wrapper;
*                      e.g. tw-web-host honors a user-chosen host value).
*   - `unseed`       → remove the seeded tiddlers + markers (removable seeds).
*/
function defineSeed(meta, impl) {
	const { id, title, description, core, startup } = meta;
	const removable = !core;
	const check = impl.check ?? (async (ctx) => {
		const present = await presentOf(ctx, impl.presentTitle ?? "");
		return {
			id,
			title,
			description,
			present,
			removable,
			detail: present ? "已存在" : "缺失"
		};
	});
	const run = impl.run ?? (async (ctx, force) => {
		try {
			const wrote = await impl.write(ctx.client, { force });
			return {
				id,
				ok: true,
				wrote,
				detail: wrote ? force ? "已重新初始化" : "已写入" : force ? "内容已是最新（未重写）" : "已存在，跳过"
			};
		} catch (err) {
			return {
				id,
				ok: false,
				wrote: false,
				error: err instanceof Error ? err.message : String(err)
			};
		}
	});
	const remove = impl.unseed === void 0 ? void 0 : async (ctx) => {
		try {
			return removedDetail(id, (await impl.unseed(ctx.client)).removed);
		} catch (err) {
			return {
				id,
				ok: false,
				wrote: false,
				error: err instanceof Error ? err.message : String(err)
			};
		}
	};
	return {
		id,
		title,
		description,
		core,
		...startup === void 0 ? {} : { startup },
		check,
		run,
		...remove === void 0 ? {} : { remove }
	};
}
/** The full registry, in display order. */
const SEED_DEFS = [
	defineSeed({
		id: "doc-note",
		title: "插件说明笔记",
		description: "「dsh-tiddlywiki 插件说明」——入门说明笔记（首次安装默认写入；ONE-SHOT，用户可改可删，标记 dsh-docs 自动进首页「📚 插件文档」栏）。",
		core: false,
		startup: true
	}, {
		presentTitle: DOC_NOTE_TITLE,
		write: seedDocNote,
		unseed: unseedDocNote
	}),
	defineSeed({
		id: "starter-docs",
		title: "示例与文档（汇总模板 / 教程 / 主题页示例）",
		description: "新手文档中心起步包：主题汇总页·模板、教程（按主题/标签做汇总页）、三个可直接运行的示例主题页（日志 / 决策记录 / 排障）。全部打 dsh-docs 标签，自动出现在首页「📚 插件文档」栏；纯示例无个人数据，同名 tiddler 已存在则安全跳过，不会覆盖。首次安装默认写入，可反初始化。",
		core: false,
		startup: true
	}, {
		check: async (ctx) => {
			const missing = [];
			for (const item of STARTER_DOCS_ITEMS) if (!await presentOf(ctx, item.title)) missing.push(item.title);
			return {
				id: "starter-docs",
				title: "示例与文档（汇总模板 / 教程 / 主题页示例）",
				description: "新手文档中心起步包：主题汇总页·模板、教程（按主题/标签做汇总页）、三个可直接运行的示例主题页（日志 / 决策记录 / 排障）。全部打 dsh-docs 标签，自动出现在首页「📚 插件文档」栏；纯示例无个人数据，同名 tiddler 已存在则安全跳过，不会覆盖。首次安装默认写入，可反初始化。",
				present: missing.length === 0,
				removable: true,
				detail: missing.length === 0 ? "已存在" : `缺失：${missing.join("、")}`
			};
		},
		write: seedStarterDocs,
		unseed: unseedStarterDocs
	}),
	defineSeed({
		id: "send-to-agent",
		title: "「发送给 Agent」按钮",
		description: "TW 笔记工具栏「发送给 Agent」按钮插件（$:/plugins/dsh/send-to-agent）——把笔记一键注入 DSH 会话。",
		core: true
	}, {
		presentTitle: SEND_TO_AGENT_PLUGIN_TITLE,
		write: seedSendToAgent
	}),
	defineSeed({
		id: "render-route",
		title: "原生渲染路由（/render）",
		description: "TW 服务端路由插件（$:/plugins/dsh/render，server-routes/render.js）——把 wiki 文本在运行中的 TW 里原生渲染成 HTML 片段，回复流工具卡与 wiki 链接跳转依赖它。seed 写入后需重启 TW 使路由生效。",
		core: true
	}, {
		presentTitle: RENDER_PLUGIN_TITLE,
		write: seedRenderRoute
	}),
	defineSeed({
		id: "home-index",
		title: "首页（主页 / 所有标签 / 标签笔记）",
		description: "默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页（🏠 主页）同时写入 $:/DefaultTiddlers。",
		core: false
	}, {
		check: async (ctx) => {
			const missing = [];
			for (const item of HOME_INDEX_ITEMS) if (!await presentOf(ctx, item.title)) missing.push(item.title);
			return {
				id: "home-index",
				title: "首页（主页 / 所有标签 / 标签笔记）",
				description: "默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页（🏠 主页）同时写入 $:/DefaultTiddlers。",
				present: missing.length === 0,
				removable: true,
				detail: missing.length === 0 ? "已存在" : `缺失：${missing.join("、")}`
			};
		},
		write: seedHomeIndex,
		unseed: unseedHomeIndex
	}),
	defineSeed({
		id: "all-articles",
		title: "所有文章（两列分页总览）",
		description: "「所有文章」——全部条目分两列（🤖 Agent 撰写 / 👤 人工·人类）各自分页展示。每页条数取插件设置 ui.allArticles.pageSize（默认 10）。",
		core: false
	}, {
		presentTitle: ALL_ARTICLES_TITLE,
		write: seedAllArticles,
		unseed: unseedAllArticles
	}),
	defineSeed({
		id: "ui-styles",
		title: "自定义样式（编辑器美化 / 窄屏侧栏 / menubar 加高 / 批注弹窗）",
		description: "5 张通用样式表（tag $:/tags/Stylesheet）：编辑器美化（CodeMirror 字体/光标/行号）、标题与按钮区分开、侧边栏窄屏自动隐藏（<960px）、menubar 顶栏加高、批注弹窗美化。纯样式无个人数据。",
		core: false
	}, {
		check: async (ctx) => {
			const missing = [];
			for (const item of UI_STYLE_ITEMS) if (!await presentOf(ctx, item.title)) missing.push(item.title);
			return {
				id: "ui-styles",
				title: "自定义样式（编辑器美化 / 窄屏侧栏 / menubar 加高 / 批注弹窗）",
				description: "5 张通用样式表（tag $:/tags/Stylesheet）：编辑器美化（CodeMirror 字体/光标/行号）、标题与按钮区分开、侧边栏窄屏自动隐藏（<960px）、menubar 顶栏加高、批注弹窗美化。纯样式无个人数据。",
				present: missing.length === 0,
				removable: true,
				detail: missing.length === 0 ? "已存在" : `缺失：${missing.join("、")}`
			};
		},
		write: seedUiStyles,
		unseed: unseedUiStyles
	}),
	defineSeed({
		id: "menubar-theme",
		title: "menubar 顶栏主题自适应",
		description: "样式表覆盖（$:/plugins/dsh-tiddlywiki/menubar-theme，tag $:/tags/Stylesheet）——把 tiddlywiki/menubar 顶栏从「默认色映射的蓝色」改为跟随当前 palette 的 background/foreground，随 DSH 主题切换（$:/palette 翻转）自动换色。",
		core: false
	}, {
		presentTitle: MENUBAR_THEME_TIDDLER,
		write: seedMenubarTheme,
		unseed: unseedMenubarTheme
	}),
	defineSeed({
		id: "clip-bridge",
		title: "本地剪藏桥（书签小工具）",
		description: "「本地剪藏桥 + 书签小工具」使用说明（Markdown 文档，带书签代码/启用步骤/安全说明）：DSH 监听 127.0.0.1 端口接收剪藏请求，浏览器书签一键把当前页标题/URL/选中文字写进知识库（配置 bridge.*，默认 clip 标签）。真功能在插件运行时代码里，此 seed 只预置说明文档。",
		core: false
	}, {
		presentTitle: CLIP_BRIDGE_DOC_TITLE,
		write: seedClipBridge,
		unseed: unseedClipBridge
	}),
	defineSeed({
		id: "tw-web-host",
		title: "TW 前端 API 基址（同源代理）",
		description: "把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。",
		core: true
	}, {
		check: async (ctx) => {
			let current;
			try {
				current = (await ctx.client.get(TW_WEB_HOST_TIDDLER))?.text?.trim();
			} catch {
				current = void 0;
			}
			const ok = current === TW_PROXY_PATH;
			return {
				id: "tw-web-host",
				title: "TW 前端 API 基址（同源代理）",
				description: "把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。",
				present: ok,
				removable: false,
				detail: ok ? `已指向 ${TW_PROXY_PATH}` : `当前：${current ?? "（缺失）"}，应为 ${TW_PROXY_PATH}`
			};
		},
		run: async (ctx, force) => {
			try {
				let current;
				try {
					current = (await ctx.client.get(TW_WEB_HOST_TIDDLER))?.text?.trim();
				} catch {
					current = void 0;
				}
				if (!force && current !== void 0 && current !== "$protocol$//$host$/") return {
					id: "tw-web-host",
					ok: true,
					wrote: false,
					detail: "已指向自定义基址，未覆盖"
				};
				await ctx.client.put({
					title: TW_WEB_HOST_TIDDLER,
					text: TW_PROXY_PATH,
					type: "text/plain",
					tags: []
				});
				return {
					id: "tw-web-host",
					ok: true,
					wrote: true,
					detail: force ? "已重新初始化（强制写回代理基址）" : "已写入代理基址"
				};
			} catch (err) {
				return {
					id: "tw-web-host",
					ok: false,
					wrote: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
	})
];
/** Check every seed, returning statuses in registry order. */
async function checkAllSeeds(ctx) {
	const out = [];
	for (const def of SEED_DEFS) try {
		out.push(await def.check(ctx));
	} catch (err) {
		out.push({
			id: def.id,
			title: def.title,
			description: def.description,
			present: false,
			removable: !def.core,
			detail: `检查失败：${err instanceof Error ? err.message : String(err)}`
		});
	}
	return out;
}
/**
* Run one seed (or all, when id is undefined). Non-force = one-shot semantics;
* force = manual "重新初始化" from the settings page. A manual run with no id
* (重新初始化 all) covers every registry item, core and optional alike.
*/
async function runSeedById(ctx, id, force) {
	const targets = id === void 0 ? SEED_DEFS : SEED_DEFS.filter((d) => d.id === id);
	if (targets.length === 0) return [{
		id: id ?? "",
		ok: false,
		wrote: false,
		error: `unknown seed: ${id}`
	}];
	const out = [];
	for (const def of targets) out.push(await def.run(ctx, force));
	return out;
}
/**
* Startup path: seed the CORE items (功能必需：发送给 Agent 按钮 + 原生渲染
* 路由 + TW 前端 API 基址) AND the STARTER items (首次安装默认：插件说明 +
* 示例与文档), all non-force (write only what is missing — a same-named
* tiddler already present is NEVER overwritten, so user data stays user data).
* Remaining optional seeds (首页 / 所有文章 / 自定义样式 / menubar 顶栏主题自
* 适应) are never forced on users — they opt in from the settings page
* 「初始化」section.
*/
async function runAllSeeds(ctx) {
	const out = [];
	for (const def of SEED_DEFS) {
		if (!def.core && def.startup !== true) continue;
		out.push(await def.run(ctx, false));
	}
	return out;
}
/**
* 反初始化 (remove): delete one non-core seed's (starter 或 optional) seeded
* tiddlers + markers, or all non-core seeds when `id` is undefined. Core
* seeds are functionally required and cannot be removed — a direct request
* for one returns an error result (and is skipped when removing all).
*/
async function removeSeedById(ctx, id) {
	if (id === void 0) {
		const out = [];
		for (const def of SEED_DEFS) {
			if (def.core || def.remove === void 0) continue;
			out.push(await def.remove(ctx));
		}
		return out;
	}
	const def = SEED_DEFS.find((d) => d.id === id);
	if (def === void 0) return [{
		id,
		ok: false,
		wrote: false,
		error: `unknown seed: ${id}`
	}];
	if (def.core) return [{
		id,
		ok: false,
		wrote: false,
		error: "该 seed 为核心项（功能必需），不可反初始化"
	}];
	if (def.remove === void 0) return [{
		id,
		ok: false,
		wrote: false,
		error: "该 seed 不支持移除"
	}];
	return [await def.remove(ctx)];
}
//#endregion
//#region src/host/tw-api.ts
const REQUEST_TIMEOUT_MS = 1e4;
/** TW's CSRF gate: writes must carry this header (TW's own UI always does). */
const CSRF_HEADER = { "x-requested-with": "TiddlyWiki" };
/** Sentinel `exclude` value: excludes nothing, so `text` stays in the list. */
const LIST_WITH_TEXT_EXCLUDE = "__dsh_tw_none__";
/**
* Recipe-list filter that keeps ONLY text-bearing tiddlers (notes): no `type`
* field at all, or a `text/*` type. Binary tiddlers (images/audio/video/fonts/
* PDF/zip…) carry their payload as a base64 `text` field — on a big wiki (e.g.
* thousands of scanned book pages) the full listing serializes 500+MB of base64
* and times every agent read out. This filter drops them SERVER-SIDE so the
* listing stays ~6MB (v0.16.20, verified on a 2418-tiddler wiki:
* 515MB/17s → 6MB/0.3s).
*
* TW 5.4.1 filter facts that matter here (all verified empirically):
* - `prefix`/`match` operators match the TITLE only — field matching needs
*   `regexp:<field>` / `field:<field>`.
* - `[has[type]]` = "has a non-empty type field"; `[has:type[]]` is a DIFFERENT
*   call (suffix "type" + empty operand) that matches everything.
* - space-separated operations UNION (no prefix = "or"); `+` means
*   intersection.
* - negated `regexp:type`/`field:type` DROP type-less tiddlers (their field
*   string is null), so "exclude binary" must be written as the positive
*   "no type OR text-ish" union below.
*
* FILENAME BUDGET (Windows, verified): the whitelist tiddler below is stored
* as a .tid file whose name contains the ENTIRE filter string, so the filter
* must stay short — a ~180-char filter produced a ~217-char filename that
* broke `git add` on Windows ("Filename too long", MAX_PATH) and killed the
* auto-committer. 86 chars keeps the file at ~123 chars even on a deep wiki
* path. (Consequence: application/json tiddlers are not searchable — on this
* wiki there are none, and they are config/data tiddlers, not notes.)
*/
const TEXT_LIST_FILTER = ["[all[tiddlers]!is[system]!has[type]]", "[all[tiddlers]!is[system]regexp:type[(?i)^text/]]"].join(" ");
/** TiddlyWeb blocks every non-default filter with 403 unless the EXACT filter
*  string is whitelisted at `$:/config/Server/ExternalFilters/<filter>` = "yes".
*  This client writes that tiddler once on 403 (self-heal, idempotent) and
*  retries; the tiddler lives in the wiki and travels with its git history. */
function externalFilterWhitelistTitle(filter) {
	return `$:/config/Server/ExternalFilters/${filter}`;
}
/** Binary MIME type prefixes — their `text` field is base64 payload, not content. */
const BINARY_TYPE_PREFIXES = [
	"image/",
	"audio/",
	"video/",
	"font/"
];
const BINARY_TYPE_EXACT = /* @__PURE__ */ new Set([
	"application/octet-stream",
	"application/pdf",
	"application/zip",
	"application/gzip",
	"application/x-gzip",
	"application/x-7z-compressed",
	"application/x-rar-compressed",
	"application/epub+zip",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);
/** True when a tiddler's `type` marks it as binary (base64 in `text`). */
function isBinaryType(type) {
	if (typeof type !== "string" || type.length === 0) return false;
	return BINARY_TYPE_PREFIXES.some((p) => type.startsWith(p)) || BINARY_TYPE_EXACT.has(type);
}
/** Split TW's whitespace-joined tags string into an array. */
function normalizeTags(tags) {
	if (tags === void 0) return void 0;
	if (Array.isArray(tags)) return tags.map(String);
	if (typeof tags === "string") {
		const parts = tags.trim().split(/\s+/).filter(Boolean);
		return parts.length > 0 ? parts : [];
	}
	return [];
}
/** Normalize a raw server tiddler (tags string → array, unknown fields nested). */
function normalizeTiddler(raw) {
	const out = { ...raw };
	const tags = normalizeTags(raw.tags);
	if (tags !== void 0) out.tags = tags;
	return out;
}
var TiddlyWebClient = class {
	baseUrl;
	constructor(baseUrl) {
		this.baseUrl = baseUrl;
	}
	async request(path, init) {
		return fetch(`${this.baseUrl}${path}`, {
			...init,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	}
	/** GET /status → { username, anonymous, space, tiddlywiki_version, ... }. */
	async status() {
		const res = await this.request("/status");
		if (!res.ok) throw new Error(`TiddlyWeb /status HTTP ${res.status}`);
		return res.json();
	}
	/** Read one tiddler; undefined when it does not exist (404). */
	async get(title) {
		const res = await this.request(`/recipes/default/tiddlers/${encodeURIComponent(title)}`);
		if (res.status === 404) return void 0;
		if (!res.ok) throw new Error(`TiddlyWeb GET /recipes/default/tiddlers/${title} HTTP ${res.status}`);
		return normalizeTiddler(await res.json());
	}
	/** Write (create or overwrite) one tiddler via PUT (204 on success). */
	async put(tiddler) {
		const title = tiddler.title;
		const res = await this.request(`/recipes/default/tiddlers/${encodeURIComponent(title)}`, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				...CSRF_HEADER
			},
			body: JSON.stringify(tiddler)
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`TiddlyWeb PUT /recipes/default/tiddlers/${title} HTTP ${res.status}: ${detail.slice(0, 300)}`);
		}
		return tiddler;
	}
	/** Delete one tiddler via the bags route (204); a missing one is a no-op. */
	async delete(title) {
		const res = await this.request(`/bags/default/tiddlers/${encodeURIComponent(title)}`, {
			method: "DELETE",
			headers: CSRF_HEADER
		});
		if (res.status === 404) return;
		if (!res.ok) throw new Error(`TiddlyWeb DELETE /bags/default/tiddlers/${title} HTTP ${res.status}`);
	}
	/**
	* List tiddlers via the default server filter. Arbitrary `filter=` queries
	* are blocked by the server (403) unless whitelisted, so callers needing a
	* subset should use search(); a supplied filter that is 403-blocked falls
	* back to the text-bearing filter.
	*
	* `includeText=true` returns only TEXT-BEARING tiddlers WITH their `text`
	* (never the base64 payloads of binary tiddlers): on 403 the whitelist
	* tiddler for TEXT_LIST_FILTER is written once and the request retried
	* (self-heal); if that write fails (read-only wiki) it degrades to the
	* skinny listing (title/tags matchable, empty snippets).
	*/
	async list(filter, includeText = false) {
		if (!includeText) return this.fetchListing(filter);
		const target = filter !== void 0 && filter.length > 0 ? filter : TEXT_LIST_FILTER;
		let res = await this.requestListWithText(target);
		if (res.status === 403) {
			await this.ensureExternalFilterWhitelist(TEXT_LIST_FILTER).catch(() => void 0);
			res = await this.requestListWithText(TEXT_LIST_FILTER);
		}
		if (res.status === 403) return this.fetchListing(void 0);
		if (!res.ok) throw new Error(`TiddlyWeb recipe list HTTP ${res.status}`);
		return this.parseList(res);
	}
	/** GET the recipe listing WITHOUT text payloads (server default excludes `text`). */
	async fetchListing(filter) {
		const params = new URLSearchParams();
		if (filter !== void 0 && filter.length > 0) params.set("filter", filter);
		const query = params.toString();
		let res = await this.request(`/recipes/default/tiddlers.json${query.length > 0 ? `?${query}` : ""}`);
		if (!res.ok && res.status === 403 && filter !== void 0 && filter.length > 0) res = await this.request("/recipes/default/tiddlers.json");
		if (!res.ok) throw new Error(`TiddlyWeb recipe list HTTP ${res.status}`);
		return this.parseList(res);
	}
	/** GET the recipe listing WITH text for a specific (whitelisted) filter. */
	async requestListWithText(filter) {
		return this.request(`/recipes/default/tiddlers.json?filter=${encodeURIComponent(filter)}&exclude=${LIST_WITH_TEXT_EXCLUDE}`);
	}
	/** Write `$:/config/Server/ExternalFilters/<filter>` = "yes" (idempotent). */
	async ensureExternalFilterWhitelist(filter) {
		await this.put({
			title: externalFilterWhitelistTitle(filter),
			text: "yes"
		});
	}
	async parseList(res) {
		const data = await res.json();
		return (Array.isArray(data) ? data : data.tiddlers ?? []).map(normalizeTiddler);
	}
	/**
	* Search text-bearing tiddlers: one request (text-bearing listing with text)
	* plus local case-insensitive substring matching on title + text, optional
	* exact tags (AND), a `since` modified-time floor, an exact `type`, capped at
	* `limit`. Robust against the server's external-filter 403 (whitelist is
	* self-healed). Binary tiddlers (images/audio/…) are NOT in the listing, so
	* they can never match — a deliberate flood guard on big wikis.
	*/
	async search(query, options = {}) {
		const items = await this.list(void 0, true);
		const needle = query.toLowerCase();
		const sinceTime = parseSince(options.since);
		const wantedTags = [...options.tags ?? [], options.tag].filter((t) => typeof t === "string" && t.trim().length > 0);
		const limit = options.limit ?? 30;
		const matched = items.filter((t) => {
			if (t.title.startsWith("$:/")) return false;
			if (!t.title.toLowerCase().includes(needle) && !(t.text ?? "").toLowerCase().includes(needle)) return false;
			if (sinceTime !== void 0) {
				const modified = typeof t.modified === "string" ? new Date(t.modified).getTime() : NaN;
				if (Number.isNaN(modified) || modified < sinceTime) return false;
			}
			if (options.type !== void 0 && options.type.length > 0 && (t.type ?? "text/vnd.tiddlywiki") !== options.type) return false;
			if (wantedTags.length > 0) {
				const tags = (t.tags ?? []).map((tag) => tag.toLowerCase());
				if (!wantedTags.every((w) => tags.includes(w.toLowerCase()))) return false;
			}
			return true;
		});
		return {
			items: matched.slice(0, limit),
			total: matched.length
		};
	}
	/**
	* List the most recently modified TEXT-BEARING (non-system, non-binary)
	* tiddlers, newest first (missing/modified-less tiddlers sort to the tail).
	* `since` keeps only tiddlers modified at/after that instant. Binary
	* attachments never appear — a book import touching hundreds of images must
	* not crowd the "最近修改" list.
	*/
	async recent(limit = 15, since) {
		const items = await this.list(void 0, true);
		const sinceTime = parseSince(since);
		const filtered = items.filter((t) => {
			if (t.title.startsWith("$:/")) return false;
			if (sinceTime !== void 0) {
				const modified = typeof t.modified === "string" ? new Date(t.modified).getTime() : NaN;
				if (Number.isNaN(modified) || modified < sinceTime) return false;
			}
			return true;
		});
		filtered.sort((a, b) => {
			const am = typeof a.modified === "string" ? new Date(a.modified).getTime() : 0;
			return (typeof b.modified === "string" ? new Date(b.modified).getTime() : 0) - am;
		});
		return filtered.slice(0, Math.max(1, Math.min(limit, 200)));
	}
	/**
	* Distinct non-system tags with their tiddler counts, most-used first then
	* zh-locale. One skinny listing request (no text payloads).
	*/
	async listTags() {
		const items = await this.list(void 0, false);
		const map = /* @__PURE__ */ new Map();
		for (const t of items) {
			if (t.title.startsWith("$:/")) continue;
			for (const tag of t.tags ?? []) {
				if (tag.startsWith("$:/")) continue;
				map.set(tag, (map.get(tag) ?? 0) + 1);
			}
		}
		return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh")).map(([tag, count]) => ({
			tag,
			count
		}));
	}
};
/** Parse a `since` value into an epoch ms, or undefined when absent/invalid. */
function parseSince(since) {
	if (typeof since !== "string" || since.trim().length === 0) return void 0;
	const ms = new Date(since.trim()).getTime();
	return Number.isNaN(ms) ? void 0 : ms;
}
//#endregion
//#region src/host/clip-bridge.ts
/**
* 本地剪藏桥（bookmarklet 剪藏小工具的后端）。
*
* A tiny loopback-only HTTP bridge that turns a browser bookmarklet's
* "剪藏" request into TiddlyWiki tiddlers. The bookmarklet (JS in the
* browser's bookmarks bar) POSTs { title, url, text, images } to the bridge;
* the bridge writes ONE note tiddler (markdown, or wikitext when images are
* stored) plus optional IMAGE ATTACHMENTS through the SAME TiddlyWebClient
* every other writer uses (D1 — there is never a second write path).
*
* Images (v0.16.25): TW 5.4.1's REST facade is JSON-only (put-tiddler.js
* JSON.parses the body — there is no binary upload route), but its binary
* tiddlers ARE representable as `{ type: image/*, text: <base64> }` — verified
* empirically: type + base64 roundtrip byte-exact, tags survive, custom fields
* nest under `fields`. So the bridge downloads each chosen image (server-side,
* no CORS; referer + UA sent for hotlink-protected CDNs), stores it as a
* binary ATTACHMENT tiddler, and embeds it in the note with `[img[Title]]`.
* A failed download degrades gracefully to a plain source-URL line.
*
* Security posture (deliberate):
* - binds `127.0.0.1` ONLY — never reachable from the network;
* - Host-header whitelist (127.0.0.1 / localhost / ::1) blocks DNS rebinding:
*   a malicious website that resolves its own domain to the loopback cannot
*   use the bridge with its own Host header;
* - optional shared `token` — when set, every write must carry
*   `x-clip-token`. The bookmarklet ships it; a random webpage on the
*   internet cannot know it, so it cannot pollute the wiki;
* - CORS preflight answered with `Access-Control-Allow-Origin: *` +
*   `Access-Control-Allow-Private-Network: true` so (a) a bookmarklet running
*   on an https page may read the response, and (b) Chromium's Private Network
*   Access preflight for public→loopback requests succeeds;
* - `enabled` is evaluated PER REQUEST against the effective (settings-page)
*   config, so toggling the flag takes effect immediately — no dsh web
*   restart. Changing the PORT still needs a restart (the listener binds once).
*
* @module dsh-tiddlywiki/host/clip-bridge
*/
/** Cap on the clipped text (characters) — plenty for a page selection. */
const MAX_CLIP_TEXT_LENGTH = 2e5;
/** Cap on a single /clip request body (bytes). */
const MAX_CLIP_BODY_BYTES = 256 * 1024;
/** Constant-time-ish string compare (token check). */
function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
/** Loopback-only Host header whitelist (DNS-rebinding defense). */
function hostAllowed(host, port) {
	if (typeof host !== "string") return false;
	const h = host.trim().toLowerCase();
	const ok = (base) => h === base || h === `${base}:${port}`;
	return ok("127.0.0.1") || ok("localhost") || ok("[::1]") || ok("::1");
}
/**
* Pick a collision-free tiddler title: `base`, then `base（2）…（20）` while an
* existing tiddler holds the name (so re-clipping the same page never
* overwrites the previous clip), then a timestamp fallback.
*/
async function resolveClipTitle(exists, base) {
	if (!await exists(base)) return base;
	for (let i = 2; i <= 20; i++) {
		const candidate = `${base}（${i}）`;
		if (!await exists(candidate)) return candidate;
	}
	return `${base}（${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace(/[T:]/g, "-")}）`;
}
/** Build the markdown tiddler for ONE TEXT-ONLY clip (no images). */
function buildClipTiddler(opts) {
	const at = opts.at ?? (/* @__PURE__ */ new Date()).toISOString();
	const selection = typeof opts.text === "string" ? opts.text.trim() : "";
	const lines = [`> 来源：${opts.url}`, ""];
	if (selection.length > 0) lines.push(selection, "");
	lines.push("---", `剪藏时间：${at}`);
	const tags = [opts.tag, ...opts.extraTags ?? []].filter((t) => t.trim().length > 0);
	return {
		title: opts.title,
		text: lines.join("\n"),
		type: "text/markdown",
		...tags.length > 0 ? { tags } : {},
		"clip-url": opts.url,
		"clip-source": opts.source ?? "bookmarklet",
		"clip-at": at
	};
}
/**
* Build the note tiddler for a clip WITH stored images: wikitext so the
* attachments render inline via `[img[Title]]` (works in the embedded TW,
* story view and /tw/render). Failed downloads degrade to plain URL lines.
*/
function buildImageNoteTiddler(opts) {
	const at = opts.at ?? (/* @__PURE__ */ new Date()).toISOString();
	const selection = typeof opts.text === "string" ? opts.text.trim() : "";
	const lines = [`> 来源：${opts.url}`, ""];
	if (selection.length > 0) lines.push(selection, "");
	lines.push("---", "!! 图片");
	for (const title of opts.stored) lines.push(`[img[${title}]]`);
	for (const f of opts.failed) lines.push(`* ${f.url}（${f.error}）`);
	lines.push("", "---", `剪藏时间：${at}`);
	const tags = [opts.tag, ...opts.extraTags ?? []].filter((t) => t.trim().length > 0);
	return {
		title: opts.title,
		text: lines.join("\n"),
		type: "text/vnd.tiddlywiki",
		...tags.length > 0 ? { tags } : {},
		"clip-url": opts.url,
		"clip-source": opts.source ?? "bookmarklet",
		"clip-at": at
	};
}
/** Build a binary attachment tiddler: `type: <mime>`, `text: <base64>`. */
function buildBinaryTiddler(opts) {
	const at = opts.at ?? (/* @__PURE__ */ new Date()).toISOString();
	const tags = [opts.tag].filter((t) => t.trim().length > 0);
	return {
		title: opts.title,
		type: opts.mime,
		text: Buffer.from(opts.buffer).toString("base64"),
		...tags.length > 0 ? { tags } : {},
		"clip-url": opts.srcUrl,
		"clip-source": opts.source ?? "bookmarklet",
		"clip-at": at,
		"clip-note": opts.noteTitle
	};
}
/** Known image extensions → mime (used when a CDN mislabels as octet-stream). */
const IMAGE_EXT_MIME = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon"
};
/**
* Decide the stored mime for a downloaded image: an `image/*` content-type
* wins; otherwise a known image extension in the URL rescues CDNs that serve
* `application/octet-stream`. null = not (recognizably) an image.
*/
function pickImageMime(contentType, url) {
	const ct = ((contentType ?? "").split(";")[0] ?? "").trim().toLowerCase();
	if (ct.startsWith("image/")) return ct;
	const ext = ((url.split("?")[0] ?? "").split(".").pop() ?? "").toLowerCase();
	if (ct === "application/octet-stream" && IMAGE_EXT_MIME[ext] !== void 0) return IMAGE_EXT_MIME[ext];
	return null;
}
/** File extension for a stored image mime. */
function imageExtensionForMime(mime) {
	const map = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
		"image/svg+xml": "svg",
		"image/avif": "avif",
		"image/bmp": "bmp",
		"image/x-icon": "ico"
	};
	if (map[mime] !== void 0) return map[mime];
	const subtype = (mime.split("/")[1] ?? "img").replace(/[^a-z0-9]/gi, "");
	return subtype.length > 0 ? subtype.slice(0, 8) : "img";
}
function cleanStr(value) {
	return typeof value === "string" ? value : "";
}
/** Validate a clip payload → normalized value or an error. */
function parseClipPayload(body) {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return {
		ok: false,
		error: "请求体必须是 JSON 对象"
	};
	const raw = body;
	const title = cleanStr(raw.title).trim().slice(0, 300);
	const url = cleanStr(raw.url).trim().slice(0, 2e3);
	const text = cleanStr(raw.text).slice(0, MAX_CLIP_TEXT_LENGTH);
	const source = cleanStr(raw.source).trim().slice(0, 40);
	let extraTags = [];
	if (Array.isArray(raw.tags)) extraTags = raw.tags.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean).slice(0, 10);
	let images = [];
	if (Array.isArray(raw.images)) images = raw.images.filter((u) => typeof u === "string").map((u) => u.trim()).filter((u) => u.length > 0 && u.length <= 2e3).slice(0, 10);
	if (title.length === 0) return {
		ok: false,
		error: "缺少 title（页面标题）"
	};
	if (url.length === 0) return {
		ok: false,
		error: "缺少 url（页面地址）"
	};
	return {
		ok: true,
		value: {
			title,
			url,
			text,
			tags: extraTags,
			source,
			images
		}
	};
}
/** CORS + no-store headers for every bridge response. */
const CORS_HEADERS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "POST, GET, OPTIONS",
	"access-control-allow-headers": "content-type, x-clip-token",
	"access-control-allow-private-network": "true",
	"access-control-max-age": "86400",
	"cache-control": "no-store"
};
/**
* The loopback clip bridge. `start(port)` binds once (127.0.0.1); config
* (enabled/token/tag) is re-resolved per request through `deps.getConfig`,
* so settings-page saves apply live. `stop()` is idempotent.
*/
var ClipBridge = class {
	deps;
	server;
	boundPort = 0;
	constructor(deps) {
		this.deps = deps;
	}
	/** The port currently bound (0 until start succeeds). */
	get port() {
		return this.boundPort;
	}
	/** Bind 127.0.0.1:port; rejects on EADDRINUSE etc. (caller logs & carries on). */
	start(port) {
		if (this.server !== void 0) return Promise.resolve();
		const server = createServer$1((req, res) => {
			this.handle(req, res).catch((err) => {
				const message = err instanceof Error ? err.message : String(err);
				this.deps.log?.(`request failed: ${message}`);
				if (!res.headersSent) this.respond(res, {
					ok: false,
					error: "内部错误"
				}, 500);
				else res.destroy();
			});
		});
		server.on("clientError", (_err, socket) => {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		});
		this.server = server;
		return new Promise((resolve, reject) => {
			const onError = (err) => {
				server.removeListener("listening", onListening);
				if (this.server === server) this.server = void 0;
				this.deps.log?.(`bind 127.0.0.1:${port} failed: ${err.message}`);
				reject(err);
			};
			const onListening = () => {
				server.removeListener("error", onError);
				const addr = server.address();
				this.boundPort = addr.port;
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(port, "127.0.0.1");
		});
	}
	/** Close the listener (idempotent; awaited by the host teardown). */
	stop() {
		const server = this.server;
		this.server = void 0;
		this.boundPort = 0;
		if (server === void 0) return Promise.resolve();
		return new Promise((resolve) => {
			server.close(() => resolve());
		});
	}
	respond(res, payload, status = 200) {
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			...CORS_HEADERS
		});
		res.end(JSON.stringify(payload));
	}
	async handle(req, res) {
		const cfg = this.deps.getConfig();
		const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
		if (req.method === "OPTIONS") {
			res.writeHead(204, CORS_HEADERS);
			res.end();
			return;
		}
		if (!hostAllowed(req.headers.host, this.boundPort)) {
			this.respond(res, {
				ok: false,
				error: "Forbidden host"
			}, 403);
			return;
		}
		if (req.method === "GET" && (urlPath === "/" || urlPath === "/health")) {
			this.respond(res, {
				ok: true,
				name: "dsh-tiddlywiki clip bridge",
				enabled: cfg.enabled,
				port: this.boundPort,
				tag: cfg.tag,
				tokenSet: cfg.token.length > 0
			});
			return;
		}
		if (req.method !== "POST" || urlPath !== "/clip") {
			this.respond(res, {
				ok: false,
				error: `未知路径 ${req.method} ${urlPath}`
			}, 404);
			return;
		}
		if (!cfg.enabled) {
			this.respond(res, {
				ok: false,
				error: "剪藏桥未启用：请在 DSH 设置 → 常规配置 勾选「启用本地剪藏桥」"
			}, 503);
			return;
		}
		if (cfg.token.length > 0) {
			const got = req.headers["x-clip-token"];
			if (typeof got !== "string" || !safeEqual(got, cfg.token)) {
				this.respond(res, {
					ok: false,
					error: "token 校验失败"
				}, 401);
				return;
			}
		}
		let body;
		try {
			body = JSON.parse(await readBody(req, MAX_CLIP_BODY_BYTES));
		} catch {
			this.respond(res, {
				ok: false,
				error: "请求体不是合法的 JSON（或过大）"
			}, 400);
			return;
		}
		const parsed = parseClipPayload(body);
		if (!parsed.ok) {
			this.respond(res, {
				ok: false,
				error: parsed.error
			}, 400);
			return;
		}
		const { title, url, text, tags, source, images } = parsed.value;
		let resolvedTitle;
		try {
			resolvedTitle = await resolveClipTitle((t) => this.deps.exists(t), title);
		} catch {
			this.respond(res, {
				ok: false,
				error: "TiddlyWiki 服务暂不可用，请稍后重试"
			}, 503);
			return;
		}
		const at = (/* @__PURE__ */ new Date()).toISOString();
		const sourceName = source.length > 0 ? source : "bookmarklet";
		const stored = [];
		const failed = [];
		const imageResults = [];
		for (let i = 0; i < images.length; i++) {
			const imageUrl = images[i];
			if (imageUrl === void 0) continue;
			try {
				const { buffer, type } = await this.deps.download(imageUrl, url);
				if (buffer.length > 15728640) throw new Error("图片超过 15MB 上限");
				const mime = pickImageMime(type, imageUrl);
				if (mime === null) throw new Error("内容不是可识别的图片");
				const ext = imageExtensionForMime(mime);
				const imageTitle = await resolveClipTitle((t) => this.deps.exists(t), `${resolvedTitle} 图片 ${i + 1}.${ext}`);
				await this.deps.write(buildBinaryTiddler({
					title: imageTitle,
					mime,
					buffer,
					srcUrl: imageUrl,
					noteTitle: resolvedTitle,
					tag: cfg.tag,
					source: sourceName,
					at
				}));
				stored.push(imageTitle);
				imageResults.push({
					url: imageUrl,
					ok: true,
					title: imageTitle
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				failed.push({
					url: imageUrl,
					error: message
				});
				imageResults.push({
					url: imageUrl,
					ok: false,
					error: message
				});
			}
		}
		const noteTiddler = stored.length > 0 || images.length > 0 ? buildImageNoteTiddler({
			title: resolvedTitle,
			url,
			...text.length > 0 ? { text } : {},
			tag: cfg.tag,
			source: sourceName,
			at,
			stored,
			failed,
			extraTags: tags
		}) : buildClipTiddler({
			title: resolvedTitle,
			url,
			...text.length > 0 ? { text } : {},
			tag: cfg.tag,
			source: sourceName,
			at,
			extraTags: tags
		});
		try {
			await this.deps.write(noteTiddler);
		} catch {
			this.respond(res, {
				ok: false,
				error: "TiddlyWiki 服务暂不可用，剪藏未写入"
			}, 503);
			return;
		}
		this.respond(res, {
			ok: true,
			title: resolvedTitle,
			url,
			tag: cfg.tag,
			source: sourceName,
			images: imageResults
		});
	}
};
//#endregion
//#region src/sdk.ts
/**
* Self-contained replacements for the @deepseek-ai runtime imports the host
* half must NEVER take from npm-mirror SDK packages (dsh-home-paths,
* dsh-tools' defineTool).
*
* Why (design doc §4.4, taskboard lesson): a published copy must not resolve
* `@deepseek-ai/dsh-tools` from the profile's node_modules — an npm-mirror
* dsh-tools there shadows the CLI-internal build for the WHOLE base layer and
* breaks the agent loop. Everything here is a pure, structure-compatible
* reimplementation of the exact behavior the registry relies on:
*
* - `dshHomePath` mirrors `join(resolve(env.DSH_HOME ?? ~/.dsh), ...segments)`;
* - `defineTool` compiles author-facing parameter specs into the same raw
*   JSON-Schema subset the registry expects and pre-validates model arguments.
*
* @module dsh-tiddlywiki/sdk
*/
/** The DSH user home (DSH_HOME overrides). */
function dshHomePath(...segments) {
	const override = process.env.DSH_HOME;
	return join(resolve(override !== void 0 && override.length > 0 ? override : join(homedir(), ".dsh")), ...segments);
}
/** Compile one value spec to the raw subset (json → annotation-only). */
function compileValue(spec) {
	const node = {};
	const description = spec.description;
	if (typeof description === "string" && description.length > 0) node.description = description;
	const type = spec.type;
	if (type === void 0 || type === "json") return node;
	if (type === "object") {
		const objectSpec = spec;
		node.type = "object";
		node.additionalProperties = objectSpec.additionalProperties;
		if (objectSpec.properties !== void 0) {
			const compiled = compilePropertyMap(objectSpec.properties);
			node.properties = compiled.properties;
			if (compiled.required !== void 0) node.required = compiled.required;
		}
		return node;
	}
	if (type === "array") {
		node.type = "array";
		const items = spec.items;
		if (items !== void 0) node.items = compileValue(items);
		return node;
	}
	node.type = type;
	const enumValues = spec.enum;
	if (enumValues !== void 0) node.enum = [...enumValues];
	const constValue = spec.const;
	if (constValue !== void 0) node.const = constValue;
	return node;
}
/** Compile a property map: properties + collected required list. */
function compilePropertyMap(spec) {
	const properties = {};
	const required = [];
	for (const [name, entry] of Object.entries(spec)) {
		const { required: isRequired, ...valueSpec } = entry;
		properties[name] = compileValue(valueSpec);
		if (isRequired === true) required.push(name);
	}
	return required.length > 0 ? {
		properties,
		required
	} : { properties };
}
/** Does a JS value match a raw-subset scalar type? */
function matchesScalarType(value, type) {
	switch (type) {
		case "string": return typeof value === "string";
		case "number": return typeof value === "number";
		case "integer": return typeof value === "number" && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		default: return true;
	}
}
/** Validate a value against the compiled subset; returns path-qualified violations. */
function validateValue(schema, value, path) {
	if (typeof schema.type !== "string" || schema.type.length === 0) return [];
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${path} must be an object`];
		const violations = [];
		const present = value;
		for (const key of schema.required ?? []) if (!(key in present)) violations.push(`${path}.${key} is required`);
		if (schema.additionalProperties === false) {
			const known = new Set(Object.keys(schema.properties ?? {}));
			for (const key of Object.keys(present)) if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`);
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) if (key in present) violations.push(...validateValue(child, present[key], `${path}.${key}`));
		return violations;
	}
	if (schema.type === "array") {
		if (!Array.isArray(value)) return [`${path} must be an array`];
		const violations = [];
		const items = schema.items;
		if (items !== void 0) value.forEach((item, index) => {
			violations.push(...validateValue(items, item, `${path}[${index}]`));
		});
		return violations;
	}
	if (!matchesScalarType(value, schema.type)) return [`${path} must be ${schema.type}`];
	const enumValues = schema.enum;
	if (enumValues !== void 0 && !enumValues.some((v) => v === value)) return [`${path} must be one of ${enumValues.map(String).join(", ")}`];
	const constValue = schema.const;
	if (constValue !== void 0 && constValue !== value) return [`${path} must be ${String(constValue)}`];
	return [];
}
/**
* Define a first-party tool: compile the parameter spec, pre-validate
* arguments, and pass through the execution.
*/
function defineTool(options) {
	const compiled = compilePropertyMap(options.parameters);
	const parameters = {
		type: "object",
		properties: compiled.properties
	};
	if (compiled.required !== void 0) parameters.required = compiled.required;
	const userExecute = options.execute;
	return {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: {},
			render(args, value) {
				return options.output.render(args, value);
			}
		},
		async execute(args, exec) {
			const violations = validateValue(parameters, args, "arguments");
			if (violations.length > 0) throw new Error(`Error: invalid arguments: ${violations.join("; ")}`);
			return userExecute(args, exec);
		}
	};
}
//#endregion
//#region src/host/tools.ts
/**
* The `tiddlywiki_*` agent tools (design doc §11, D8) plus the extension
* point: `registerTiddlywikiTools(ctx, deps)` registers tools list-style, so a
* new tool is just one more `defineTool` in the array — index.ts never changes.
*
* Toolset (v0.5):
*   search / get / put / batch_put / rename / delete / recent / list_tags /
*   git_sync / git_resolve
*
* RENDER CONTRACT (design doc §4.3): the registry feeds `output.render(args,
* value)` into the loop — the model sees ONLY the rendered text, never the raw
* JSON `value`. Every render must carry the complete facts an agent needs to
* act (titles, tags, snippets, git state); a terse UI summary starves it.
*
* @module dsh-tiddlywiki/host/tools
*/
/**
* 约定标签：标记「由 Agent 撰写」的笔记。
* 新建（title 不存在）时由 tiddlywiki_put / tiddlywiki_batch_put 自动补打；
* 首页据此把这类笔记单独列在「Agent 区块」并从主标签列表排除。
*/
const AGENT_WRITTEN_TAG = "agent-written";
/**
* Agent 写入的默认内容类型。agent 正文按约定是 Markdown，而 TW 对无 type 的
* tiddler 按 wikitext（text/vnd.tiddlywiki）解析——`##`/`**` 之类原样显示，显示
* 解析全坏（v0.16.15 起 put/batch_put 自动补该默认；wiki 已启用 tiddlywiki/markdown）。
*/
const DEFAULT_NOTE_TYPE = "text/markdown";
function snippetOf(text, max = 160) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
/** Strip dsh-tiddlywiki internal fields from a tiddler for the model. */
function pickFields(t) {
	const out = {};
	for (const [k, v] of Object.entries(t)) {
		if (k === "title" || k === "text" || k === "tags") continue;
		out[k] = v;
	}
	return out;
}
/** A put-ready copy of a tiddler (no created/modified, tags as array). */
function cleanTiddler(t) {
	const out = {
		title: t.title,
		text: t.text ?? "",
		tags: t.tags ?? []
	};
	if (typeof t.type === "string") out.type = t.type;
	for (const [k, v] of Object.entries(t)) {
		if (k === "title" || k === "text" || k === "tags" || k === "type" || k === "created" || k === "modified" || k === "fields") continue;
		out[k] = v;
	}
	return out;
}
/**
* Rewrite TiddlyWiki references to a title inside wiki text: `[[Title]]`,
* `[[display|Title]]`, `{{Title}}` → the new title. Best-effort link/text
* migration for tiddlywiki_rename; returns the rewritten text + hit count.
*/
function rewriteRefs(text, oldTitle, newTitle) {
	if (oldTitle.length === 0) return {
		text,
		count: 0
	};
	const escaped = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(\\[\\[[^\\]|]*\\|)${escaped}(\\]\\])|(\\[\\[)${escaped}(\\]\\])|(\\{\\{)${escaped}(\\}\\})`, "g");
	let count = 0;
	return {
		text: text.replace(re, (...args) => {
			const p = args;
			count++;
			return `${p[1] ?? p[3] ?? p[5] ?? ""}${newTitle}${p[2] ?? p[4] ?? p[6] ?? ""}`;
		}),
		count
	};
}
/**
* Compute the final tags for a write:
* - NEW tiddler (created by this tool) → auto-append the agent-written tag,
*   unless it is a `$:/` system tiddler (config/language/theme internals).
* - Existing tiddler → keep the caller's tags as-is (an agent maintaining a
*   human note must NOT silently claim authorship; an already agent-written
*   note keeps its tag because the caller provides the full tag list).
*/
function finalTagsForWrite(title, existing, tags) {
	if (existing !== void 0) return tags;
	if (title.startsWith("$:/")) return tags;
	if (tags.includes("agent-written")) return tags;
	return [...tags, AGENT_WRITTEN_TAG];
}
/**
* Compute the final content type for a write (mutates the tiddler in place):
* - explicit `type` (normally via fields) wins — untouched;
* - `$:/` system tiddlers keep TW's own default (config/plugin internals must
*   not be force-marked as markdown);
* - everything else defaults to Markdown (DEFAULT_NOTE_TYPE) — agent notes are
*   written in Markdown and TW would otherwise parse them as wikitext.
*/
function finalTypeForWrite(title, tiddler) {
	if (typeof tiddler.type === "string" && tiddler.type.length > 0) return { defaulted: false };
	if (title.startsWith("$:/")) return { defaulted: false };
	tiddler.type = DEFAULT_NOTE_TYPE;
	return { defaulted: true };
}
function registerTiddlywikiTools(ctx, deps) {
	const disposers = [];
	const register = (tool) => {
		disposers.push(ctx.tools.register(tool));
	};
	/** Every read/write tool needs a live TW client — shared guard for the 8
	*  wiki-facing tools (git tools operate on the repo path instead). */
	const requireWiki = () => {
		const wiki = deps.wiki();
		if (wiki === void 0) throw new Error("TiddlyWiki 服务未运行（tiddlywiki_status 可查）");
		return wiki;
	};
	register(defineTool({
		name: "tiddlywiki_search",
		description: "检索 TiddlyWiki 持久知识库：按关键词（可选 tags 数组 / since 修改时间 / type / limit）搜索非系统 tiddler，返回标题、标签、修改时间与摘要片段。二进制 tiddler（图片等附件，正文为 base64）不参与检索。",
		parameters: {
			query: {
				type: "string",
				description: "搜索关键词（大小写不敏感，子串匹配）",
				required: true
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "可选：要求同时包含的标签（AND）"
			},
			tag: {
				type: "string",
				description: "可选：单个精确标签（与 tags 同为 AND）"
			},
			since: {
				type: "string",
				description: "可选：ISO 时间（如 2026-09-01 或 2026-09-01T00:00:00Z），只返回修改时间不早于它的 tiddler"
			},
			type: {
				type: "string",
				description: "可选：精确 tiddler 类型（默认 text/vnd.tiddlywiki）"
			},
			limit: {
				type: "integer",
				description: "可选：返回条数上限（默认 30，最大 200）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const filters = [];
				if (value.tags.length > 0) filters.push(`tags=${value.tags.join(",")}`);
				if (value.since !== null) filters.push(`since=${value.since}`);
				if (value.type !== null) filters.push(`type=${value.type}`);
				const lines = [`TiddlyWiki 搜索「${value.query}」${filters.length > 0 ? ` (${filters.join(" · ")})` : ""}：命中 ${value.total} 条。`];
				if (value.results.length === 0) lines.push("没有匹配的 tiddler。");
				for (const r of value.results) {
					const tags = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
					const modified = r.modified !== null ? ` (${r.modified})` : "";
					lines.push(`- ${r.title}${tags}${modified}`);
					if (r.snippet.length > 0) lines.push(`  ${r.snippet}`);
				}
				if (value.total > value.results.length) lines.push(`（另有 ${value.total - value.results.length} 条未展开，可用 tiddlywiki_get 读取具体标题，或提高 limit）`);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		execute: async (args) => {
			const { items, total } = await requireWiki().search(args.query, {
				tags: args.tags,
				tag: args.tag,
				since: args.since,
				type: args.type,
				limit: args.limit
			});
			return {
				query: args.query,
				tags: args.tags ?? [],
				since: args.since ?? null,
				type: args.type ?? null,
				total,
				results: items.map((t) => ({
					title: t.title,
					tags: t.tags ?? [],
					modified: typeof t.modified === "string" ? t.modified : null,
					snippet: snippetOf(t.text ?? "")
				}))
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_recent",
		description: "查看 TiddlyWiki 知识库最近修改的笔记（按修改时间倒序，排除系统 tiddler 与图片等二进制附件），返回标题、标签、修改时间与摘要。适合开工时快速了解近期动态。",
		parameters: {
			limit: {
				type: "integer",
				description: "可选：返回条数（默认 15，最大 200）"
			},
			since: {
				type: "string",
				description: "可选：只返回修改时间不早于该 ISO 时间的 tiddler"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const lines = [`TiddlyWiki 最近修改（最近 ${value.results.length} 条${value.since !== null ? `，since=${value.since}` : ""}）：`];
				if (value.results.length === 0) lines.push("暂无笔记。");
				for (const r of value.results) {
					const tags = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
					lines.push(`- ${r.title}${tags} (${r.modified ?? "?"})`);
					if (r.snippet.length > 0) lines.push(`  ${r.snippet}`);
				}
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		execute: async (args) => {
			const items = await requireWiki().recent(args.limit ?? 15, args.since);
			return {
				since: args.since ?? null,
				results: items.map((t) => ({
					title: t.title,
					tags: t.tags ?? [],
					modified: typeof t.modified === "string" ? t.modified : null,
					snippet: snippetOf(t.text ?? "")
				}))
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_list_tags",
		description: "列出 TiddlyWiki 知识库现有的非系统标签及各自计数（按使用次数降序），方便决定给笔记打什么 tag。",
		parameters: {},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				if (value.tags.length === 0) return [{
					type: "text",
					text: "知识库暂无标签。"
				}];
				const lines = [`现有标签（${value.tags.length} 个，按使用次数降序）：`];
				for (const t of value.tags) lines.push(`- ${t.tag} × ${t.count}`);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		execute: async () => {
			const tags = await requireWiki().listTags();
			return {
				count: tags.length,
				tags
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_get",
		description: "读取一个 TiddlyWiki tiddler 的完整内容（标题、全文、标签、自定义字段）。二进制 tiddler（图片等附件）只返回元数据，不返回 base64 正文。",
		parameters: { title: {
			type: "string",
			description: "tiddler 标题（精确匹配）",
			required: true
		} },
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				if (value.notFound) return [{
					type: "text",
					text: `tiddler「${value.title}」不存在。可用 tiddlywiki_search 检索，或用 tiddlywiki_put 新建。`
				}];
				if (value.binary === true) {
					const lines = [`tiddler「${value.title}」是二进制附件（type=${value.binaryType ?? "?"}，base64 正文约 ${value.binaryChars ?? 0} 字符），不返回正文。`];
					if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(", ")}`);
					if (value.modified !== null) lines.push(`修改: ${value.modified}`);
					const fields = Object.entries(value.fields);
					if (fields.length > 0) lines.push(`字段: ${fields.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
					lines.push(`如需查看附件本身，可打开 [${value.title}](/dsh-tiddlywiki/tw/#${encodeURIComponent(value.title)})。`);
					return [{
						type: "text",
						text: lines.join("\n")
					}];
				}
				const lines = [`tiddler「${value.title}」`];
				if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(", ")}`);
				if (value.modified !== null) lines.push(`修改: ${value.modified}`);
				const fields = Object.entries(value.fields);
				if (fields.length > 0) lines.push(`字段: ${fields.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
				lines.push("--- 全文 ---");
				lines.push(value.text.length > 0 ? value.text : "（空）");
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		execute: async (args) => {
			const t = await requireWiki().get(args.title);
			if (t === void 0) return {
				notFound: true,
				title: args.title,
				text: "",
				tags: [],
				fields: {},
				modified: null
			};
			const binary = isBinaryType(typeof t.type === "string" ? t.type : void 0);
			const result = {
				notFound: false,
				title: t.title,
				text: binary ? "" : t.text ?? "",
				tags: t.tags ?? [],
				fields: pickFields(t),
				modified: typeof t.modified === "string" ? t.modified : null
			};
			if (binary) {
				result.binary = true;
				result.binaryType = typeof t.type === "string" ? t.type : void 0;
				result.binaryChars = (t.text ?? "").length;
			}
			return result;
		}
	}));
	register(defineTool({
		name: "tiddlywiki_put",
		description: "写入（新建或覆盖）一个 TiddlyWiki tiddler。同名覆盖；tags 为标签数组，fields 为附加自定义字段（json 对象，会写入 tiddler 字段）。写入后触发自动 commit。新建（title 不存在）时自动补打 agent-written 标签标记「由 Agent 撰写」，无需手动添加。未指定内容类型时自动默认 text/markdown（$:/ 系统条目除外）；要写原生 wikitext 需显式在 fields 传 {\"type\":\"text/vnd.tiddlywiki\"}。⚠️ fields.type 是 TW 的内容类型保留字段，不要把业务分类值（如 \"meeting\"）写进去——业务分类请放 tags。",
		parameters: {
			title: {
				type: "string",
				description: "tiddler 标题（精确匹配，覆盖同名）",
				required: true
			},
			text: {
				type: "string",
				description: "tiddler 全文（默认按 Markdown 解析）",
				required: true
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "标签数组（可选）"
			},
			fields: {
				type: "json",
				description: "附加自定义字段，如 {\"date\":\"2026-09-02\"}（可选）。注意：fields.type 是 TW 内容类型（保留字段，默认已自动补 text/markdown），不要写业务分类值"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const lines = [`已写入 tiddler「${value.title}」`];
				if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(", ")}`);
				if (value.type !== null) lines.push(`类型: ${value.type}${value.typeDefaulted === true ? "（未指定，已默认 markdown）" : ""}`);
				if (value.fields !== null) {
					const entries = Object.entries(value.fields);
					if (entries.length > 0) lines.push(`字段: ${entries.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
				}
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		execute: async (args) => {
			const wiki = requireWiki();
			const existing = await wiki.get(args.title).catch(() => void 0);
			const tags = finalTagsForWrite(args.title, existing, Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string" && t.trim().length > 0) : []);
			const tiddler = {
				title: args.title,
				text: args.text
			};
			if (tags.length > 0) tiddler.tags = tags;
			if (args.fields !== void 0 && typeof args.fields === "object" && args.fields !== null) Object.assign(tiddler, args.fields);
			const { defaulted } = finalTypeForWrite(args.title, tiddler);
			await wiki.put(tiddler);
			deps.autoCommit();
			return {
				ok: true,
				title: args.title,
				tags,
				type: typeof tiddler.type === "string" ? tiddler.type : null,
				...defaulted ? { typeDefaulted: true } : {},
				fields: args.fields ?? null
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_batch_put",
		description: "批量写入/覆盖多个 TiddlyWiki tiddler（一次工具调用）。overwrite=false 时跳过已存在的标题；返回逐条结果。写入后触发自动 commit。新建（title 不存在）的条目会自动补打 agent-written 标签，无需手动添加。未指定内容类型（fields.type）的条目自动默认 text/markdown（$:/ 系统条目除外）。",
		parameters: {
			items: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: true,
					description: "要写入的 tiddler 数组",
					properties: {
						title: {
							type: "string",
							description: "标题（精确匹配，覆盖同名）",
							required: true
						},
						text: {
							type: "string",
							description: "全文（默认按 Markdown 解析）",
							required: true
						},
						tags: {
							type: "array",
							items: { type: "string" },
							description: "标签数组（可选）"
						},
						fields: {
							type: "json",
							description: "附加自定义字段（可选）。注意：fields.type 是 TW 内容类型（保留字段，默认已自动补 text/markdown），不要写业务分类值"
						}
					}
				}
			},
			overwrite: {
				type: "boolean",
				description: "可选：true=覆盖同名（默认），false=跳过已存在的标题"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const lines = [`批量写入完成：成功 ${value.written}，跳过 ${value.skipped}，共 ${value.items.length} 条。`];
				for (const r of value.items) lines.push(`- ${r.title}：${r.written ? "已写入" : "已跳过（存在）"}`);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		execute: async (args) => {
			const wiki = requireWiki();
			const list = Array.isArray(args.items) ? args.items : [];
			if (list.length === 0) return {
				ok: true,
				written: 0,
				skipped: 0,
				items: []
			};
			const overwrite = args.overwrite !== false;
			const results = [];
			let written = 0;
			let skipped = 0;
			for (const item of list) {
				if (typeof item.title !== "string" || item.title.length === 0) throw new Error("batch_put: 每条 items 都需要非空 title");
				if (typeof item.text !== "string") throw new Error(`batch_put: items「${item.title}」缺少 text`);
				const existing = await wiki.get(item.title).catch(() => void 0);
				if (!overwrite && existing !== void 0) {
					skipped++;
					results.push({
						title: item.title,
						written: false,
						skipped: true
					});
					continue;
				}
				const tags = finalTagsForWrite(item.title, existing, Array.isArray(item.tags) ? item.tags.filter((t) => typeof t === "string" && t.trim().length > 0) : []);
				const tiddler = {
					title: item.title,
					text: item.text
				};
				if (tags.length > 0) tiddler.tags = tags;
				if (item.fields !== void 0 && typeof item.fields === "object" && item.fields !== null) Object.assign(tiddler, item.fields);
				finalTypeForWrite(item.title, tiddler);
				await wiki.put(tiddler);
				written++;
				results.push({
					title: item.title,
					written: true,
					skipped: false
				});
			}
			deps.autoCommit();
			return {
				ok: true,
				written,
				skipped,
				items: results
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_rename",
		description: "重命名一个 TiddlyWiki tiddler：把旧标题的内容复制到新标题、删除旧标题，并可选地更新其他 tiddler 里的 [[旧标题]] / {{旧标题}} 引用（最佳努力）。",
		parameters: {
			oldTitle: {
				type: "string",
				description: "当前标题",
				required: true
			},
			newTitle: {
				type: "string",
				description: "新标题",
				required: true
			},
			updateRefs: {
				type: "boolean",
				description: "可选：是否同步更新其他 tiddler 里的引用（默认 true）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const lines = [`已重命名「${value.from}」→「${value.to}」`];
				lines.push(`更新了 ${value.refsUpdated} 处引用（${value.refsTiddlers} 个 tiddler）`);
				if (value.warning !== void 0) lines.push(`注意: ${value.warning}`);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		execute: async (args) => {
			const wiki = requireWiki();
			const { oldTitle, newTitle } = args;
			if (oldTitle === newTitle) return {
				ok: true,
				from: oldTitle,
				to: newTitle,
				refsUpdated: 0,
				refsTiddlers: 0
			};
			const existing = await wiki.get(oldTitle);
			if (existing === void 0) throw new Error(`tiddler「${oldTitle}」不存在`);
			if (await wiki.get(newTitle) !== void 0) throw new Error(`新标题「${newTitle}」已存在（可先用 tiddlywiki_delete 删除）`);
			let refsUpdated = 0;
			let refsTiddlers = 0;
			let warning;
			if (args.updateRefs !== false) {
				const all = await wiki.list(void 0, true);
				for (const t of all) {
					if (t.title === oldTitle || t.title === newTitle) continue;
					if (t.title.startsWith("$:/")) continue;
					const text = t.text ?? "";
					if (text.length === 0) continue;
					const rewritten = rewriteRefs(text, oldTitle, newTitle);
					if (rewritten.count > 0) {
						await wiki.put({
							...cleanTiddler(t),
							text: rewritten.text
						});
						refsUpdated += rewritten.count;
						refsTiddlers++;
					}
				}
			}
			await wiki.put({
				...cleanTiddler(existing),
				title: newTitle
			});
			await wiki.delete(oldTitle);
			if (refsTiddlers === 0) warning = "未找到任何其他 tiddler 引用旧标题；如确实需要，可手动补充链接。";
			deps.autoCommit();
			return {
				ok: true,
				from: oldTitle,
				to: newTitle,
				refsUpdated,
				refsTiddlers,
				...warning !== void 0 ? { warning } : {}
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_delete",
		description: "删除一个 TiddlyWiki tiddler（不存在时是幂等空操作）。删除后触发自动 commit。",
		parameters: { title: {
			type: "string",
			description: "tiddler 标题（精确匹配）",
			required: true
		} },
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: `已删除 tiddler「${value.title}」。`
			}]
		},
		execute: async (args) => {
			await requireWiki().delete(args.title);
			deps.autoCommit();
			return {
				ok: true,
				title: args.title
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_git_sync",
		description: "对 TiddlyWiki 知识库的 git 仓库做同步：pull（拉取远端并 rebase 本地，冲突则 abort 并报文件）、push（推送本地提交到远端）、sync（pull → commit 本地改动 → push）。未配置 git.remote 时 push 会失败并提示。",
		parameters: {
			action: {
				type: "string",
				enum: [
					"pull",
					"push",
					"sync"
				],
				description: "要执行的 git 操作",
				required: true
			},
			message: {
				type: "string",
				description: "commit 信息（可选，仅 sync 的本地 commit 使用）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => renderSync(value)
		},
		execute: async (args) => {
			const dir = deps.wikiPath();
			/** Restart TW after a pull that changed the tree (stale snapshot drop). */
			const restartIfChanged = async (pulled) => {
				if (pulled.changed !== true || deps.restartWiki === void 0) return {};
				try {
					await deps.restartWiki();
					return { restarted: true };
				} catch (err) {
					return { restartError: err instanceof Error ? err.message : String(err) };
				}
			};
			switch (args.action) {
				case "pull": {
					const r = await deps.git.pull(dir);
					const restart = await restartIfChanged(r);
					return {
						action: args.action,
						ok: r.ok,
						message: r.message,
						...r.conflictFiles !== void 0 ? { conflictFiles: r.conflictFiles } : {},
						...r.changed === true ? { changed: true } : {},
						...restart
					};
				}
				case "push": {
					const r = await deps.git.push(dir);
					return {
						action: args.action,
						ok: r.ok,
						message: r.message
					};
				}
				case "sync": {
					const pulled = await deps.git.pull(dir);
					if (!pulled.ok) return {
						action: args.action,
						ok: false,
						message: pulled.message,
						...pulled.conflictFiles !== void 0 ? { conflictFiles: pulled.conflictFiles } : {}
					};
					const restart = await restartIfChanged(pulled);
					const committed = await deps.git.commit(dir, args.message ?? `sync ${(/* @__PURE__ */ new Date()).toISOString()}`);
					const pushed = await deps.git.push(dir);
					const status = await deps.git.status(dir);
					return {
						action: args.action,
						ok: pushed.ok,
						message: pushed.ok ? "同步完成" : pushed.message,
						pull: "ok",
						...pulled.changed === true ? { changed: true } : {},
						...restart,
						commit: committed.message,
						push: pushed.message,
						status
					};
				}
			}
		}
	}));
	register(defineTool({
		name: "tiddlywiki_git_resolve",
		description: "在 tiddlywiki_git_sync action=pull 冲突（已 abort）后，按 tiddler 二选一解决：keep-local 保留本地版本；keep-remote 用 git fetch 拉取远端并检出远端版本（需已配置 git.remote）；list 仅报告当前状态。解决后建议重新 pull/sync 整合其余改动。",
		parameters: {
			strategy: {
				type: "string",
				enum: [
					"keep-local",
					"keep-remote",
					"list"
				],
				description: "keep-local=保留本地；keep-remote=改用远端版本；list=仅报告当前 git 状态",
				required: true
			},
			files: {
				type: "array",
				items: { type: "string" },
				description: "冲突文件名数组（来自 pull 返回的 conflictFiles；list 时忽略）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const lines = [`git resolve ${value.action}: ${value.ok ? "成功" : "失败"}`];
				lines.push(`  ${value.message}`);
				if (value.files !== void 0 && value.files.length > 0) lines.push(`涉及文件: ${value.files.join(", ")}`);
				if (value.commit !== void 0) lines.push(`本地 commit: ${value.commit}`);
				if (value.status !== void 0) lines.push(`状态: ${gitStatusBits(value.status)}`);
				return [{
					type: "text",
					text: lines.join("\n")
				}];
			}
		},
		execute: async (args) => {
			const dir = deps.wikiPath();
			if (args.strategy === "list") return {
				ok: true,
				action: "list",
				message: "当前仓库状态（pull 冲突已 abort，工作区即本地版本，不会残留未合并状态）",
				status: await deps.git.status(dir)
			};
			const files = (args.files ?? []).filter((f) => typeof f === "string" && f.length > 0);
			if (files.length === 0) return {
				ok: false,
				action: args.strategy,
				message: "请提供 conflictFiles（来自 pull 返回）",
				hint: "可先执行 tiddlywiki_git_sync action=pull 查看冲突文件"
			};
			if (args.strategy === "keep-local") {
				const status = await deps.git.status(dir);
				return {
					ok: true,
					action: "keep-local",
					message: `已保留本地版本（${files.length} 个文件；abort 后本地即为工作区内容）。建议重新 tiddlywiki_git_sync action=sync 整合远端其余改动。`,
					files,
					status
				};
			}
			const fetched = await deps.git.fetch(dir);
			if (!fetched.ok) return {
				ok: false,
				action: "keep-remote",
				message: `fetch 失败（可能未配置 git.remote）：${fetched.message}`
			};
			const checked = await deps.git.checkoutFetchHead(dir, files);
			if (!checked.ok) return {
				ok: false,
				action: "keep-remote",
				message: `从远端检出失败：${checked.message}`
			};
			const committed = await deps.git.commit(dir, `resolve conflict (keep remote) ${(/* @__PURE__ */ new Date()).toISOString()}`);
			deps.autoCommit();
			const status = await deps.git.status(dir);
			return {
				ok: true,
				action: "keep-remote",
				message: `已把 ${files.length} 个冲突文件改为远端版本并提交。建议继续 tiddlywiki_git_sync action=sync 完成整合与推送。`,
				files,
				commit: committed.message,
				status
			};
		}
	}));
	return disposers;
}
/** One-line 状态 summary: 分支 … 领先 … 落后 … 工作区未提交 … 最近提交. */
function gitStatusBits(s) {
	const bits = [`分支 ${s.branch}`];
	if (s.ahead !== void 0) bits.push(`领先 ${s.ahead}`);
	if (s.behind !== void 0) bits.push(`落后 ${s.behind}`);
	if (s.dirty) bits.push(`工作区有 ${s.dirtyFiles.length} 个未提交改动`);
	if (s.lastCommit !== void 0) bits.push(`最近提交 ${s.lastCommit}`);
	return bits.join(" · ");
}
function renderSync(value) {
	const lines = [`git ${value.action}: ${value.ok ? "成功" : "失败"}`];
	lines.push(`  ${value.message}`);
	if (value.conflictFiles !== void 0 && value.conflictFiles.length > 0) {
		lines.push(`冲突文件（rebase 已 abort，勿自动覆盖）:`);
		for (const f of value.conflictFiles) lines.push(`  - ${f}`);
		lines.push("处理方式：用 tiddlywiki_git_resolve files=[以上文件] strategy=keep-local|keep-remote 按 tiddler 二选一解决，再重新 sync；也可以直接让用户处理。");
	}
	if (value.commit !== void 0) lines.push(`本地 commit: ${value.commit}`);
	if (value.push !== void 0) lines.push(`远端 push: ${value.push}`);
	if (value.changed === true) lines.push(value.restarted === true ? "本次 pull 拉取了新内容，TW 服务已自动重启（同端口），读取/搜索均为最新快照。" : "本次 pull 拉取了新内容，但 TW 服务未能自动重启（如需最新快照，请手动重启 TW）。");
	if (value.restartError !== void 0) lines.push(`TW 重启失败: ${value.restartError}`);
	if (value.status !== void 0) {
		lines.push(`状态: ${gitStatusBits(value.status)}`);
		const s = value.status;
		if (s.dirty && s.dirtyFiles.length > 0) lines.push(`  未提交: ${s.dirtyFiles.join(", ")}`);
	}
	return [{
		type: "text",
		text: lines.join("\n")
	}];
}
//#endregion
//#region src/index.ts
/**
* dsh-tiddlywiki — host half.
*
* TiddlyWiki 5 as the DSH persistent knowledge base. Wiring:
* - WikiServer spawns/kills/self-heals the TW 5 child process (loopback, auto
*   port) and scaffolds the wiki folder on first run;
* - the git face bootstraps the wiki folder as a repository and wires the
*   debounced auto-committer;
* - `tiddlywiki_*` agent tools + a system-prompt section;
* - /dsh-tiddlywiki routes when a webServer is present.
*
* Export shape follows dsh-taskboard: a function/namespace plugin —
* `name` / `inject` / `apply`, NO default export. Config arrives as the
* second apply() argument (Cordis `runtime.callback(ctx, config)`).
*
* Extra exports (WikiServer / TiddlyWebClient / GitFace / ...) exist for the
* headless selftest and future reuse; the loader only reads name/inject/apply.
*
* @module dsh-tiddlywiki
*/
/** Cordis plugin name (also the client loader id / profile row id). */
const name = "dsh-tiddlywiki";
/** Required host services (tool registry + prompt assembly). */
const inject = ["tools", "systemPrompt"];
/** 剪藏桥默认端口（与 seed 文档书签代码里的地址保持一致）。 */
const CLIP_BRIDGE_DEFAULT_PORT = 8618;
const DEFAULTS = {
	wikiRoot: "",
	wiki: "main",
	port: 0,
	git: {
		autoCommit: true,
		debounceMs: 6e4,
		remote: "",
		branch: "main"
	},
	note: { tag: "inbox" },
	bridge: {
		enabled: false,
		port: CLIP_BRIDGE_DEFAULT_PORT,
		token: "",
		tag: "clip"
	},
	ui: {
		showQuickNote: true,
		showQuickNoteDock: true,
		quickNoteMode: "native",
		sidebarLabel: "TiddlyWiki",
		showPanelStatus: true,
		showSyncButton: true,
		followDshTheme: true,
		darkPalette: DARK_PALETTE_DEFAULT,
		tabLabel: "知识库",
		showSessionTab: true,
		showRightbarTab: true,
		showBetterSidebarTab: true,
		sendToAgent: { enabled: true },
		allArticles: { pageSize: 10 }
	},
	uiLanguage: "",
	auth: {
		username: "",
		password: ""
	}
};
/**
* Point TW's frontend at the same-origin DSH proxy (remote-access mode, R1).
* The tiddlywebadaptor builds every API URL from $:/config/tiddlyweb/host; its
* default `$protocol$//$host$/` resolves to the iframe's origin ROOT, which
* 404s whenever the browser is not on the same machine as TW. Written only
* when the tiddler is missing or still the legacy default — a user override is
* honored (e.g. someone who really does expose TW on a dedicated origin).
*/
async function ensureTwWebHost(client) {
	if (client === void 0) return;
	let current;
	try {
		current = (await client.get(TW_WEB_HOST_TIDDLER))?.text;
	} catch {
		current = void 0;
	}
	if (current !== void 0 && current.trim() !== "$protocol$//$host$/") return;
	await client.put({
		title: TW_WEB_HOST_TIDDLER,
		text: TW_PROXY_PATH,
		type: "text/plain",
		tags: []
	});
}
/** Expand $VAR / ${VAR} / %VAR% from process.env (config uses $DSH_HOME). */
function expandEnvPath(input) {
	return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => process.env[k] ?? "").replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => process.env[k] ?? "").replace(/%([A-Za-z_][A-Za-z0-9_]*%)/g, (_, k) => process.env[k.slice(0, -1)] ?? "");
}
/** Resolve wikiRoot: explicit config (env-expanded) else $DSH_HOME/tiddlywiki. */
function resolveWikiRoot(config) {
	if (config.wikiRoot !== void 0 && config.wikiRoot.trim().length > 0) return expandEnvPath(config.wikiRoot.trim());
	return dshHomePath("tiddlywiki");
}
/** Write the .gitignore for TW transient artifacts (idempotent). */
async function writeGitignore(wikiPath) {
	await writeFile(join(wikiPath, ".gitignore"), [
		"# TiddlyWiki transient artifacts (auto-managed by dsh-tiddlywiki)",
		"tiddlers/$__temp_*",
		"tiddlers/$__StoryList*",
		"tiddlers/$__HistoryList*",
		"*.meta.tmp",
		""
	].join("\n"), "utf8");
}
/** Watch the wiki folders and touch the auto-committer on changes. */
function watchWiki(wikiPath, onChange) {
	const watchers = [];
	for (const dir of [join(wikiPath, "tiddlers"), wikiPath]) try {
		const watcher = watch(dir, { persistent: false }, () => onChange());
		watchers.push(watcher);
	} catch {}
	return () => {
		for (const watcher of watchers) try {
			watcher.close();
		} catch {}
	};
}
/**
* Wait until a file exists on disk (polling), up to `timeoutMs`. TW's syncer
* flushes REST writes to the filesystem on a ~250ms task timer, so a freshly
* seeded tiddler is not on disk the moment PUT resolves — a caller that must
* restart TW right after (so a seeded server route loads) has to wait for the
* flush first, or the restarted TW would boot from a stale snapshot and the
* seeded module would be missing.
*/
async function waitForFileWrite(filePath, timeoutMs = 8e3, pollMs = 150) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (existsSync(filePath)) return true;
		} catch {}
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, pollMs));
	}
}
/** System-prompt section text (design doc §11 D8). */
const PROMPT_SECTION_NAME = "dsh-tiddlywiki";
const PROMPT_SECTION_ORDER = 100;
const PROMPT_TEXT = `## TiddlyWiki 持久知识库

本机有一个 TiddlyWiki 5 持久知识库（wiki 文件夹即 git 仓库）。你可以用工具读写 tiddler：

- \`tiddlywiki_search\`（query 必填；可选 tags[]/tag、since 修改时间、type、limit）检索（图片等二进制附件不参与检索）；\`tiddlywiki_get\`（title）读全文（二进制附件只返回元数据，不含 base64 正文）；\`tiddlywiki_put\`（title, text, tags?, fields?）写/覆盖；\`tiddlywiki_batch_put\`（items[]）批量写；\`tiddlywiki_rename\`（oldTitle, newTitle, updateRefs?）重命名并尽量同步引用；\`tiddlywiki_delete\`（title）删除。
- \`tiddlywiki_recent\`（limit?, since?）看最近修改的笔记（不含图片等二进制附件）；\`tiddlywiki_list_tags\` 看现有 tag 及计数。
- \`tiddlywiki_git_sync\`（pull|push|sync）做 git 同步；\`tiddlywiki_git_resolve\`（files, strategy=keep-local|keep-remote|list）在 pull 冲突后按 tiddler 二选一解决。

知识库同步纪律（三条）：
1. 开工先 pull：\`tiddlywiki_git_sync action=pull\`（rebase + autostash；真冲突会自动 abort 并报冲突文件）。
2. 收工 commit + push：\`tiddlywiki_git_sync action=sync\`（pull → commit → push）。
3. 插件会自动防抖 commit（默认 60s），手动同步用上面的工具。

pull 冲突后：先 \`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local\`（保留本地）或 \`strategy=keep-remote\`（改用远端版本），再重新 pull/sync 整合其余改动。

把 wiki 当作长期记忆与知识沉淀的地方：会议纪要、决策记录、调研笔记、随手的想法都可存成独立 tiddler（tag 建议用 inbox/meeting/decision 等便于检索）。

**把有价值但不在当前执行范围内的想法沉淀进 wiki**：遇到「未来可能有用 / 值得做」的想法、或不在当前任务范围内但有实现价值的事项时，用 \`tiddlywiki_put\` 写成独立 tiddler，打上 \`todo\` + \`agent-written\` 标签（并附当前工作区名），正文简要说明来源（会话 / 工作区 / 项目背景），方便日后回溯，由用户决定是否继续。

用本插件自动创建笔记时，除了业务性 tag 外，请把「当前工作区（项目）的名字」也作为标签之一加上去（例如 \`tiddlywiki_put\` 的 tags 里带上当前 workspace 名），这样笔记能按项目归集、检索。

**Agent 笔记标签约定**：\`tiddlywiki_put\` / \`tiddlywiki_batch_put\` 新建笔记时，插件会自动补打 \`agent-written\` 标签（标记「由 Agent 撰写」），无需手动添加，也不要手动移除它（除非用户明确要求）。首页会把 Agent 笔记单独列在「Agent 区块」，主标签列表只统计人类笔记。若某篇 Agent 笔记后续被人类编辑过，请在该笔记上补打 \`human-edited\` 标签，首页会把它归入「Agent + 人工」档。覆盖写入已有的（人类）笔记时不会自动加 agent-written，请保持笔记原本的归属。

**内容类型约定**：agent 笔记正文默认用 **Markdown** 写；\`tiddlywiki_put\` / \`tiddlywiki_batch_put\` 未指定内容类型时自动按 \`text/markdown\` 写入（\`$:/\` 系统条目除外），无需手动指定。要写 TW 原生 wikitext 才需要在 fields 里显式传 \`{"type":"text/vnd.tiddlywiki"}\`。⚠️ \`fields.type\` 是 TW 的**内容类型**保留字段——不要把业务分类值（如 \`"meeting"\`）写进去（会破坏渲染），业务分类请放 \`tags\`。

**引用 wiki 笔记用可点击链接**：在回复流中引用某篇笔记时，用格式 \`[标题](/dsh-tiddlywiki/tw/#标题)\` 输出（标题含空格/特殊字符时做 URL 编码，如 \`A%20B\`；中文标题可直接写）。这类链接会被界面自动接管：点击后打开中央 TW 面板并跳转到该笔记的原生页面。回复里也优先用这个链接格式代替纯文本标题，让用户能一键跳到 wiki。`;
/**
* Mount the host half.
* @param ctx - the plugin context (tools + systemPrompt injected).
* @param rawConfig - the plugin row's `config:` block (Cordis second arg).
*/
function apply(ctx, rawConfig = {}) {
	const config = {
		wikiRoot: resolveWikiRoot(rawConfig),
		wiki: rawConfig.wiki ?? DEFAULTS.wiki,
		port: rawConfig.port ?? DEFAULTS.port,
		git: {
			...DEFAULTS.git,
			...rawConfig.git ?? {}
		},
		note: {
			...DEFAULTS.note,
			...rawConfig.note ?? {}
		},
		bridge: {
			...DEFAULTS.bridge,
			...rawConfig.bridge ?? {}
		},
		ui: {
			...DEFAULTS.ui,
			...rawConfig.ui ?? {},
			sendToAgent: {
				...DEFAULTS.ui.sendToAgent,
				...rawConfig.ui?.sendToAgent ?? {}
			},
			allArticles: {
				...DEFAULTS.ui.allArticles,
				...rawConfig.ui?.allArticles ?? {}
			}
		},
		uiLanguage: typeof rawConfig.uiLanguage === "string" ? rawConfig.uiLanguage.trim() : DEFAULTS.uiLanguage,
		auth: {
			...DEFAULTS.auth,
			...rawConfig.auth ?? {}
		}
	};
	const wikiPath = join(config.wikiRoot, config.wiki);
	const git = new GitFace();
	const configStore = new ConfigStore({
		note: config.note,
		git: config.git,
		ui: config.ui,
		uiLanguage: config.uiLanguage,
		bridge: config.bridge
	});
	const eff = () => configStore.get();
	const effectiveNoteTag = () => {
		const tag = eff().note?.tag;
		return typeof tag === "string" && tag.trim().length > 0 ? tag : config.note.tag;
	};
	/**
	* Effective bridge config (defaults + settings-page overlay). Used PER
	* REQUEST by the clip bridge — enabled/token/tag edits on the settings page
	* apply immediately; only the port is fixed at startup (listener binds once).
	*/
	const effectiveBridge = () => {
		const b = eff().bridge ?? {};
		const port = typeof b.port === "number" && Number.isInteger(b.port) && b.port > 0 && b.port < 65536 ? b.port : config.bridge.port;
		const token = typeof b.token === "string" ? b.token : "";
		const tag = typeof b.tag === "string" && b.tag.trim().length > 0 ? b.tag.trim() : config.bridge.tag;
		return {
			enabled: b.enabled === true,
			port,
			token,
			tag
		};
	};
	const effectiveUi = () => {
		const ui = eff().ui ?? {};
		const palette = typeof ui.darkPalette === "string" && ui.darkPalette.trim().length > 0 ? ui.darkPalette.trim() : DARK_PALETTE_DEFAULT;
		const label = typeof ui.sidebarLabel === "string" && ui.sidebarLabel.trim().length > 0 ? ui.sidebarLabel.trim() : config.ui.sidebarLabel;
		const tabLabel = typeof ui.tabLabel === "string" && ui.tabLabel.trim().length > 0 ? ui.tabLabel.trim() : config.ui.tabLabel;
		const quickNoteMode = ui.quickNoteMode === "card" ? "card" : "native";
		return {
			showQuickNote: ui.showQuickNote !== false,
			showQuickNoteDock: ui.showQuickNoteDock !== false,
			quickNoteMode,
			sidebarLabel: label,
			showPanelStatus: ui.showPanelStatus !== false,
			showSyncButton: ui.showSyncButton !== false,
			followDshTheme: ui.followDshTheme !== false,
			darkPalette: palette,
			tabLabel,
			showSessionTab: ui.showSessionTab !== false,
			showRightbarTab: ui.showRightbarTab !== false,
			showBetterSidebarTab: ui.showBetterSidebarTab !== false
		};
	};
	const disposers = [];
	const disposeAll = () => {
		for (const dispose of disposers.splice(0)) dispose();
	};
	const disposeSection = ctx.systemPrompt.section({
		name: PROMPT_SECTION_NAME,
		order: PROMPT_SECTION_ORDER,
		text: PROMPT_TEXT
	});
	ctx.effect(() => disposeSection, "dsh-tiddlywiki: prompt section");
	const server = new WikiServer({
		wikiRoot: config.wikiRoot,
		wiki: config.wiki,
		port: config.port,
		username: config.auth.username,
		password: config.auth.password
	});
	let clientCache;
	const client = () => {
		const port = server.currentPort;
		if (port === void 0) return void 0;
		clientCache ??= new TiddlyWebClient(`http://127.0.0.1:${port}`);
		return clientCache;
	};
	const clipBridge = new ClipBridge({
		getConfig: effectiveBridge,
		write: async (tiddler) => {
			const c = client();
			if (c === void 0) throw new Error("wiki not ready");
			await c.put(tiddler);
		},
		exists: async (title) => {
			const c = client();
			if (c === void 0) throw new Error("wiki not ready");
			return await c.get(title) !== void 0;
		},
		download: async (imageUrl, referer) => {
			const res = await fetch(imageUrl, {
				headers: {
					"user-agent": "Mozilla/5.0 (compatible; dsh-tiddlywiki clip bridge)",
					referer,
					accept: "image/*,*/*;q=0.8"
				},
				redirect: "follow",
				signal: AbortSignal.timeout(2e4)
			});
			if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
			const buffer = Buffer.from(await res.arrayBuffer());
			if (buffer.length === 0) throw new Error("下载内容为空");
			if (buffer.length > 15728640) throw new Error("图片超过 15MB 上限");
			return {
				buffer,
				type: res.headers.get("content-type")
			};
		},
		log: (m) => console.info("[dsh-tiddlywiki] clip bridge:", m)
	});
	ctx.effect(() => () => clipBridge.stop(), "dsh-tiddlywiki: clip bridge");
	let committer;
	let unwatch;
	const setupCommitter = () => {
		const g = eff().git ?? {};
		committer = new AutoCommitter({
			git,
			dir: wikiPath,
			enabled: g.autoCommit ?? config.git.autoCommit,
			debounceMs: g.debounceMs ?? config.git.debounceMs,
			message: () => `wiki autocommit ${(/* @__PURE__ */ new Date()).toISOString()}`,
			onError: (err) => console.warn("[dsh-tiddlywiki] autocommit:", err)
		});
		unwatch = watchWiki(wikiPath, () => committer?.touch());
		disposers.push(() => {
			committer?.dispose();
			unwatch?.();
		});
	};
	const bootstrapGit = async () => {
		const g = eff().git ?? {};
		const branch = g.branch ?? config.git.branch;
		const remote = g.remote ?? config.git.remote;
		if (!await git.isRepo(wikiPath)) {
			await git.init(wikiPath, branch);
			await writeGitignore(wikiPath);
			await git.initialCommit(wikiPath);
		} else await writeGitignore(wikiPath);
		if (remote.trim().length > 0) {
			const ensured = await git.ensureRemote(wikiPath, remote.trim());
			if (ensured.ok) {
				const first = await git.firstPush(wikiPath);
				if (!first.ok) console.warn("[dsh-tiddlywiki] first push failed (retry with tiddlywiki_git_sync):", first.message);
			} else console.warn("[dsh-tiddlywiki] git remote setup:", ensured.message);
		}
	};
	const toolsDeps = {
		wiki: client,
		git,
		wikiPath: () => wikiPath,
		noteTag: effectiveNoteTag,
		autoCommit: () => committer?.touch(),
		restartWiki: async () => {
			await server.restart();
		}
	};
	disposers.push(...registerTiddlywikiTools(ctx, toolsDeps));
	(async () => {
		try {
			await server.start();
			await configStore.load(client());
			try {
				await clipBridge.start(config.bridge.port);
				console.info(`[dsh-tiddlywiki] clip bridge listening on 127.0.0.1:${clipBridge.port} (enabled=${effectiveBridge().enabled})`);
			} catch (err) {
				console.warn("[dsh-tiddlywiki] clip bridge start:", err);
			}
			try {
				const seedClient = client();
				if (seedClient !== void 0) {
					const results = await runAllSeeds({ client: seedClient });
					for (const r of results) if (!r.ok) console.warn(`[dsh-tiddlywiki] seed ${r.id} failed:`, r.error ?? r.detail);
					if (results.some((r) => r.ok && r.wrote)) {
						if (!await waitForFileWrite(join(wikiPath, "tiddlers", "$__plugins_dsh_render.json"))) console.warn("[dsh-tiddlywiki] seeded render plugin file not seen on disk before restart");
						await server.restart();
					}
				}
			} catch (err) {
				console.warn("[dsh-tiddlywiki] seeding wiki:", err);
			}
			const uiLang = eff().uiLanguage;
			if (typeof uiLang === "string" && uiLang.trim().length > 0) try {
				const code = uiLang.trim();
				if (await ensureLanguage(wikiPath, resolveTwRoot(), code)) await server.restart();
				const langClient = client();
				if (langClient !== void 0) await langClient.put({
					title: "$:/language",
					text: `$:/languages/${code}`,
					type: "text/plain",
					tags: []
				}).catch(() => void 0);
			} catch (err) {
				console.warn("[dsh-tiddlywiki] applying uiLanguage:", err);
			}
			await bootstrapGit();
			setupCommitter();
		} catch (err) {
			console.warn("[dsh-tiddlywiki] startup issue (self-healing is armed):", err);
		}
	})();
	ctx.inject(["webServer"], (webCtx) => {
		const ws = webCtx.webServer;
		const getSessionController = () => ctx.get("sessionController");
		const getWorkspaceRegistry = () => ctx.get("workspaceRegistry");
		const getAgentPresets = () => ctx.get("agentPresets");
		const getSessionPersistence = () => ctx.get("sessionPersistence");
		const getPermissionPresets = () => ctx.get("permissionPresets");
		const getSessions = () => ctx.get("sessions");
		const getSessionQuery = () => ctx.get("sessionQuery");
		const disposeRoutes = registerRoutes({ webServer: ws }, {
			server,
			getClient: client,
			git,
			autoCommit: () => committer?.touch(),
			noteDefaults: () => ({ tag: effectiveNoteTag() }),
			uiDefaults: () => effectiveUi(),
			getWikiPath: () => wikiPath,
			getSessionController,
			getWorkspaceRegistry,
			getAgentPresets,
			getSessionPersistence,
			getPermissionPresets,
			getSessions,
			getSessionQuery,
			sendToAgentEnabled: () => eff().ui?.sendToAgent?.enabled !== false,
			sendToAgentToken: () => {
				const token = eff().ui?.sendToAgent?.token;
				return typeof token === "string" ? token : "";
			}
		});
		const disposeAdmin = registerAdminRoutes({ webServer: ws }, {
			server,
			getClient: client,
			getWikiPath: () => wikiPath,
			twRoot: resolveTwRoot,
			config: configStore,
			seeds: {
				checkAll: async (c) => checkAllSeeds({ client: c }),
				run: async (c, id, force) => runSeedById({ client: c }, id, force),
				remove: async (c, id) => removeSeedById({ client: c }, id)
			}
		});
		return () => {
			disposeRoutes();
			disposeAdmin();
		};
	});
	ctx.effect(() => () => {
		return (async () => {
			try {
				await committer?.flush();
			} catch {}
			disposeAll();
			await server.stop();
		})();
	}, "dsh-tiddlywiki: host teardown");
}
//#endregion
export { ALL_ARTICLES_MARKER_TITLE, ALL_ARTICLES_TEXT, ALL_ARTICLES_TITLE, AutoCommitter, CLIP_BRIDGE_BOOKMARKLET, CLIP_BRIDGE_DEFAULT_PORT, CLIP_BRIDGE_DOC_TEXT, CLIP_BRIDGE_DOC_TITLE, CLIP_BRIDGE_MARKER_TITLE, ClipBridge, ConfigStore, DOC_NOTE_TAG, DOC_NOTE_TEXT, DOC_NOTE_TITLE, DSH_DOCS_TAG, GitFace, HOME_DEFAULT_TIDDLERS, HOME_INDEX_ITEMS, HOME_INDEX_MARKER_TITLE, MENUBAR_THEME_MARKER_TITLE, MENUBAR_THEME_TEXT, MENUBAR_THEME_TIDDLER, PATH_PREFIX, RENDER_BUNDLE_TEXT, RENDER_MARKER_TITLE, RENDER_PLUGIN_TITLE, SEED_DEFS, SEND_TO_AGENT_BUNDLE_TEXT, SEND_TO_AGENT_MARKER_TITLE, SEND_TO_AGENT_PLUGIN_TITLE, SESSION_SUMMARY_PREFIX, STARTER_DOCS_ITEMS, STARTER_DOCS_MARKER_TITLE, TEXT_LIST_FILTER, TW_PROXY_PATH, TW_PROXY_PREFIX, TW_WEB_HOST_DEFAULT, TW_WEB_HOST_TIDDLER, TiddlyWebClient, UI_STYLES_MARKER_TITLE, UI_STYLE_ITEMS, WikiServer, apply, buildBinaryTiddler, buildClipTiddler, buildImageNoteTiddler, bundledCatalog, checkAllSeeds, deepMerge, defineTool, dshHomePath, ensureLanguage, ensureTwWebHost, hostAllowed, imageExtensionForMime, inject, isBinaryType, name, normalizeThemes, openInTwEditor, parseClipPayload, pickImageMime, readWikiInfo, registerAdminRoutes, registerRoutes, registerTiddlywikiTools, removeSeedById, resolveClipTitle, resolveTwRoot, runAllSeeds, runSeedById, seedAllArticles, seedClipBridge, seedDocNote, seedHomeIndex, seedMenubarTheme, seedRenderRoute, seedSendToAgent, seedStarterDocs, seedUiStyles, unseedClipBridge, writeSessionSummary, writeWikiInfo };

//# sourceMappingURL=index.js.map