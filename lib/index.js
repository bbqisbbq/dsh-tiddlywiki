import { createRequire } from "node:module";
import { existsSync, watch } from "node:fs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { homedir } from "node:os";
//#region \0rolldown/runtime.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};
//#endregion
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
var git_exports = /* @__PURE__ */ __exportAll({
	AutoCommitter: () => AutoCommitter,
	GitFace: () => GitFace
});
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
//#region src/host/routes.ts
const ROUTE_PREFIX = PATH_PREFIX;
/** Max JSON body for note/restart. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Max passthrough body (tiddler content can be large). */
const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;
/** Max uploaded file body. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Tiddler type for quick-notes: Markdown, so the uploaded images/links and
*  any Markdown in the note actually render in TW (a type-less tiddler is
*  treated as plain wiki text and shows raw `![..]`/`[..]` instead). */
const NOTE_TYPE = "text/markdown";
function readBody$1(req, limit = MAX_BODY_BYTES) {
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
		req.on("end", () => resolveP(Buffer.concat(chunks).toString("utf8")));
		req.on("error", rejectP);
	});
}
/** Read a raw (binary-safe) request body up to `limit` bytes. */
function readBodyBuffer(req, limit = MAX_UPLOAD_BYTES) {
	return new Promise((resolveP, rejectP) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				rejectP(/* @__PURE__ */ new Error("file too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolveP(Buffer.concat(chunks)));
		req.on("error", rejectP);
	});
}
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
function json$1(res, payload, status = 200) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
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
		json$1(res, {
			ok: true,
			...view,
			twProxy: TW_PROXY_PATH,
			git: gitSummary,
			note: { tag: deps.noteDefaults().tag },
			ui: deps.uiDefaults()
		});
	};
	const handleNote = async (req, res) => {
		try {
			const body = JSON.parse(await readBody$1(req));
			const text = typeof body.text === "string" && body.text.trim().length > 0 ? body.text.trim() : null;
			if (text === null) {
				json$1(res, {
					ok: false,
					error: "text is required"
				}, 400);
				return;
			}
			const client = deps.getClient();
			if (client === void 0) {
				json$1(res, {
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
			json$1(res, {
				ok: true,
				title,
				tag: tags.join(" "),
				tags,
				text,
				type: NOTE_TYPE
			});
		} catch (err) {
			json$1(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	const handleEdit = async (req, res) => {
		try {
			const body = JSON.parse(await readBody$1(req));
			const client = deps.getClient();
			if (client === void 0) {
				json$1(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			const title = typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : timestampTitle();
			const tags = resolveTags(body, deps.noteDefaults().tag);
			const result = await openInTwEditor(client, title, typeof body.text === "string" ? body.text : "", tags);
			deps.autoCommit();
			json$1(res, {
				ok: true,
				...result,
				twUrl: TW_PROXY_PATH
			});
		} catch (err) {
			json$1(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/** Distinct non-system tags for the quick-note tag autocomplete. */
	const handleTags = async (_req, res) => {
		const client = deps.getClient();
		if (client === void 0) {
			json$1(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		try {
			const items = await client.list(void 0, false);
			const tags = /* @__PURE__ */ new Set();
			for (const item of items) for (const tag of item.tags ?? []) if (tag.length > 0 && !tag.startsWith("$:/")) tags.add(tag);
			json$1(res, {
				ok: true,
				tags: [...tags].sort((a, b) => a.localeCompare(b, "zh"))
			});
		} catch (err) {
			json$1(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/** Recent non-system tiddlers for the quick-note "最近" picker (newest first). */
	const handleRecent = async (req, res) => {
		const client = deps.getClient();
		if (client === void 0) {
			json$1(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const limitRaw = Number(url.searchParams.get("limit") ?? 15);
			const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 200)) : 15;
			json$1(res, {
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
			json$1(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/** Full tiddler for the quick-note "最近" picker (load into the editor). */
	const handleGet = async (req, res) => {
		const client = deps.getClient();
		if (client === void 0) {
			json$1(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		try {
			const title = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("title") ?? "";
			if (title.length === 0) {
				json$1(res, {
					ok: false,
					error: "missing title"
				}, 400);
				return;
			}
			const t = await client.get(title);
			if (t === void 0) {
				json$1(res, {
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
			json$1(res, {
				ok: true,
				title: t.title,
				text: t.text ?? "",
				tags: t.tags ?? [],
				type: t.type ?? "text/vnd.tiddlywiki",
				fields
			});
		} catch (err) {
			json$1(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	const handleRestart = async (_req, res) => {
		try {
			await deps.server.restart();
			json$1(res, {
				ok: true,
				status: deps.server.status().status
			});
		} catch (err) {
			json$1(res, {
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
				json$1(res, {
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
			json$1(res, {
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
			json$1(res, {
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
				json$1(res, {
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
			json$1(res, {
				ok: true,
				name: candidate,
				path: `files/${candidate}`,
				url: `${TW_PROXY_PATH}files/${encodeURIComponent(candidate)}`,
				size: buf.length,
				type: req.headers["content-type"] ?? "application/octet-stream"
			});
		} catch (err) {
			json$1(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, err instanceof Error && /too large/.test(err.message) ? 413 : 500);
		}
	};
	/** Passthrough /dsh-tiddlywiki/api/<rest> → TW root /<rest>. */
	const handleApiProxy = async (req, res) => {
		if (deps.getClient() === void 0) {
			json$1(res, {
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
			if (method === "PUT" || method === "POST") init.body = await readBody$1(req, MAX_PROXY_BODY_BYTES);
			const upstream = await fetch(`${deps.server.url}${rest}${url.search}`, init);
			const data = await upstream.text();
			res.writeHead(upstream.status, {
				"content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
				"cache-control": "no-store"
			});
			res.end(data);
		} catch (err) {
			json$1(res, {
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
			json$1(res, {
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
			json$1(res, {
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
function json(res, payload, status = 200) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(payload));
}
async function readBody(req, limit = 1024 * 1024) {
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
		req.on("end", () => resolveP(Buffer.concat(chunks).toString("utf8")));
		req.on("error", rejectP);
	});
}
function registerAdminRoutes(ctx, deps) {
	const handleState = async (_req, res) => {
		try {
			const wikiPath = deps.getWikiPath();
			const [info, catalog] = await Promise.all([readWikiInfo(wikiPath), bundledCatalog(deps.twRoot())]);
			let git = null;
			try {
				const { GitFace } = await Promise.resolve().then(() => git_exports);
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
/** One-time marker: its presence means "the note was offered once — hands off". */
const SEED_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-doc-note";
/** The note body, TiddlyWiki wiki-text. */
const DOC_NOTE_TEXT = `! dsh-tiddlywiki 插件说明

本插件把 **TiddlyWiki 5** 作为 DSH 的持久知识库（wiki 文件夹本身就是一个 git 仓库，随内容自动提交/同步）。

!! 它能做什么

* **10 个 agent 工具**：\`tiddlywiki_search\`（检索，支持 tags/since/type/limit 过滤）/ \`tiddlywiki_get\`（读）/ \`tiddlywiki_put\`（写）/ \`tiddlywiki_batch_put\`（批量写）/ \`tiddlywiki_rename\`（重命名+同步引用）/ \`tiddlywiki_delete\`（删）/ \`tiddlywiki_recent\`（最近修改）/ \`tiddlywiki_list_tags\`（标签清单）/ \`tiddlywiki_git_sync\`（git 同步）/ \`tiddlywiki_git_resolve\`（冲突按 tiddler 二选一）。
* **TW 编辑器面板**：侧边栏「TiddlyWiki」按钮 → 在界面中央打开完整版 TW 编辑器。
* **快速笔记**：右下角「知识库」悬浮按钮 → 「📝 快速笔记」写随手记（Markdown 高亮、文件上传、多选/自动补全 tag，草稿自动保存到本地），\`Ctrl+Enter\` 保存；「🕘 最近」可一键载入旧笔记继续编辑；「✏️ 在 TW 中编辑」会弹出独立小窗用 TW 原生编辑器编辑。
* **一键同步**：「知识库」按钮 → 「🔁 同步」一键 pull → commit → push，按钮上的状态点实时反映 git 状态。
* **git 同步**：写入自动防抖 commit（默认 60 秒）；手动 \`tiddlywiki_git_sync action=sync\` 做 pull → commit → push。
* **设置页**：DSH 设置 → 「TiddlyWiki 知识库」管理插件/主题/语言与运行配置（含「知识库」按钮相关显示开关）。

!! 知识库纪律（三条）

1. 开工先 \`tiddlywiki_git_sync action=pull\`（rebase + autostash，真冲突会自动 abort 并报文件）。
2. 冲突后：\`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local|keep-remote\` 按 tiddler 二选一解决，再重新 sync。
3. 收工 \`tiddlywiki_git_sync action=sync\`。
4. 插件自动 commit 兜底，手动 sync 用于需要主动推送的场合。

!! 主题与语言

* **主题**分两层：每行一个「☑ 加载」（多选 = TW 里可用的主题，依赖链自动带上）和「◉ 活动」（单选 = 当前视觉主题）。应用后自动重启 TW。
* **语言**：设置页勾选 \`zh-Hans\`（简体）并应用，TW 界面即切换为中文。

!! 说明

* 本笔记由插件在**首次启动**时自动写入（一次性：只写一次）。删除后重启 dsh web **不会自动恢复**——它从此归你所有。
* 更多细节见插件仓库 README。`;
/**
* Seed the doc note exactly once per wiki. A marker tiddler records that the
* note has been offered; from then on the note is user-owned and is never
* re-created (deleting it survives restarts). Returns whether a note was
* written this call. Never throws.
*/
async function seedDocNote(client) {
	if (await client.get("$:/plugins/dsh-tiddlywiki/seed-doc-note").catch(() => void 0) !== void 0) return false;
	const existing = await client.get(DOC_NOTE_TITLE).catch(() => void 0);
	let wrote = false;
	if (existing === void 0) {
		await client.put({
			title: DOC_NOTE_TITLE,
			text: DOC_NOTE_TEXT,
			type: "text/vnd.tiddlywiki",
			tags: [DOC_NOTE_TAG]
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
//#endregion
//#region src/host/tw-api.ts
const REQUEST_TIMEOUT_MS = 1e4;
/** TW's CSRF gate: writes must carry this header (TW's own UI always does). */
const CSRF_HEADER = { "x-requested-with": "TiddlyWiki" };
/** Sentinel `exclude` value: excludes nothing, so `text` stays in the list. */
const LIST_WITH_TEXT_EXCLUDE = "__dsh_tw_none__";
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
	* back to the default listing.
	*/
	async list(filter, includeText = false) {
		const params = new URLSearchParams();
		if (includeText) params.set("exclude", LIST_WITH_TEXT_EXCLUDE);
		if (filter !== void 0 && filter.length > 0) params.set("filter", filter);
		const query = params.toString();
		let res = await this.request(`/recipes/default/tiddlers.json${query.length > 0 ? `?${query}` : ""}`);
		if (!res.ok && res.status === 403 && filter !== void 0 && filter.length > 0) {
			const retry = new URLSearchParams();
			if (includeText) retry.set("exclude", LIST_WITH_TEXT_EXCLUDE);
			const retryQuery = retry.toString();
			res = await this.request(`/recipes/default/tiddlers.json${retryQuery.length > 0 ? `?${retryQuery}` : ""}`);
		}
		if (!res.ok) throw new Error(`TiddlyWeb recipe list HTTP ${res.status}`);
		const data = await res.json();
		return (Array.isArray(data) ? data : data.tiddlers ?? []).map(normalizeTiddler);
	}
	/**
	* Search non-system tiddlers: one request (default listing with text) plus
	* local case-insensitive substring matching on title + text, optional exact
	* tags (AND), a `since` modified-time floor, an exact `type`, capped at
	* `limit`. Robust against the server's external-filter 403.
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
	* List the most recently modified NON-SYSTEM tiddlers, newest first
	* (missing/modified-less tiddlers sort to the tail). `since` keeps only
	* tiddlers modified at/after that instant.
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
function registerTiddlywikiTools(ctx, deps) {
	const disposers = [];
	const register = (tool) => {
		disposers.push(ctx.tools.register(tool));
	};
	register(defineTool({
		name: "tiddlywiki_search",
		description: "检索 TiddlyWiki 持久知识库：按关键词（可选 tags 数组 / since 修改时间 / type / limit）搜索非系统 tiddler，返回标题、标签、修改时间与摘要片段。",
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
			const wiki = deps.wiki();
			if (wiki === void 0) throw new Error("TiddlyWiki 服务未运行（tiddlywiki_status 可查）");
			const { items, total } = await wiki.search(args.query, {
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
		description: "查看 TiddlyWiki 知识库最近修改的笔记（按修改时间倒序，排除系统 tiddler），返回标题、标签、修改时间与摘要。适合开工时快速了解近期动态。",
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
			const wiki = deps.wiki();
			if (wiki === void 0) throw new Error("TiddlyWiki 服务未运行（tiddlywiki_status 可查）");
			const items = await wiki.recent(args.limit ?? 15, args.since);
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
			const wiki = deps.wiki();
			if (wiki === void 0) throw new Error("TiddlyWiki 服务未运行（tiddlywiki_status 可查）");
			const tags = await wiki.listTags();
			return {
				count: tags.length,
				tags
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_get",
		description: "读取一个 TiddlyWiki tiddler 的完整内容（标题、全文、标签、自定义字段）。",
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
			const wiki = deps.wiki();
			if (wiki === void 0) throw new Error("TiddlyWiki 服务未运行（tiddlywiki_status 可查）");
			const t = await wiki.get(args.title);
			if (t === void 0) return {
				notFound: true,
				title: args.title,
				text: "",
				tags: [],
				fields: {},
				modified: null
			};
			return {
				notFound: false,
				title: t.title,
				text: t.text ?? "",
				tags: t.tags ?? [],
				fields: pickFields(t),
				modified: typeof t.modified === "string" ? t.modified : null
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_put",
		description: "写入（新建或覆盖）一个 TiddlyWiki tiddler。同名覆盖；tags 为标签数组，fields 为附加自定义字段（json 对象，会写入 tiddler 字段）。写入后触发自动 commit。",
		parameters: {
			title: {
				type: "string",
				description: "tiddler 标题（精确匹配，覆盖同名）",
				required: true
			},
			text: {
				type: "string",
				description: "tiddler 全文（wiki 文本）",
				required: true
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "标签数组（可选）"
			},
			fields: {
				type: "json",
				description: "附加自定义字段，如 {\"type\":\"meeting\",\"date\":\"2026-09-02\"}（可选）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const lines = [`已写入 tiddler「${value.title}」`];
				if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(", ")}`);
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
			const wiki = deps.wiki();
			if (wiki === void 0) throw new Error("TiddlyWiki 服务未运行（tiddlywiki_status 可查）");
			const tiddler = {
				title: args.title,
				text: args.text
			};
			if (Array.isArray(args.tags) && args.tags.length > 0) tiddler.tags = args.tags;
			if (args.fields !== void 0 && typeof args.fields === "object" && args.fields !== null) Object.assign(tiddler, args.fields);
			await wiki.put(tiddler);
			deps.autoCommit();
			return {
				ok: true,
				title: args.title,
				tags: args.tags ?? [],
				fields: args.fields ?? null
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_batch_put",
		description: "批量写入/覆盖多个 TiddlyWiki tiddler（一次工具调用）。overwrite=false 时跳过已存在的标题；返回逐条结果。写入后触发自动 commit。",
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
							description: "全文（wiki 文本）",
							required: true
						},
						tags: {
							type: "array",
							items: { type: "string" },
							description: "标签数组（可选）"
						},
						fields: {
							type: "json",
							description: "附加自定义字段（可选）"
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
			const wiki = deps.wiki();
			if (wiki === void 0) throw new Error("TiddlyWiki 服务未运行（tiddlywiki_status 可查）");
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
				if (!overwrite) {
					if (await wiki.get(item.title).catch(() => void 0) !== void 0) {
						skipped++;
						results.push({
							title: item.title,
							written: false,
							skipped: true
						});
						continue;
					}
				}
				const tiddler = {
					title: item.title,
					text: item.text
				};
				if (Array.isArray(item.tags) && item.tags.length > 0) tiddler.tags = item.tags;
				if (item.fields !== void 0 && typeof item.fields === "object" && item.fields !== null) Object.assign(tiddler, item.fields);
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
			const wiki = deps.wiki();
			if (wiki === void 0) throw new Error("TiddlyWiki 服务未运行（tiddlywiki_status 可查）");
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
			await wiki.put(cleanTiddler(existing));
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
			const wiki = deps.wiki();
			if (wiki === void 0) throw new Error("TiddlyWiki 服务未运行（tiddlywiki_status 可查）");
			await wiki.delete(args.title);
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
				if (value.status !== void 0) {
					const s = value.status;
					const bits = [`分支 ${s.branch}`];
					if (s.ahead !== void 0) bits.push(`领先 ${s.ahead}`);
					if (s.behind !== void 0) bits.push(`落后 ${s.behind}`);
					if (s.dirty) bits.push(`工作区有 ${s.dirtyFiles.length} 个未提交改动`);
					if (s.lastCommit !== void 0) bits.push(`最近提交 ${s.lastCommit}`);
					lines.push(`状态: ${bits.join(" · ")}`);
				}
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
		const s = value.status;
		const bits = [`分支 ${s.branch}`];
		if (s.ahead !== void 0) bits.push(`领先 ${s.ahead}`);
		if (s.behind !== void 0) bits.push(`落后 ${s.behind}`);
		if (s.dirty) bits.push(`工作区有 ${s.dirtyFiles.length} 个未提交改动`);
		if (s.lastCommit !== void 0) bits.push(`最近提交 ${s.lastCommit}`);
		lines.push(`状态: ${bits.join(" · ")}`);
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
	ui: {
		showQuickNote: true,
		showPanelStatus: true,
		showSyncButton: true
	},
	auth: {
		username: "",
		password: ""
	}
};
/** Config tiddler steering TW's frontend API base (tiddlywebadaptor). */
const TW_WEB_HOST_TIDDLER = "$:/config/tiddlyweb/host";
/** The legacy default value this plugin replaces with the same-origin proxy. */
const TW_WEB_HOST_DEFAULT = "$protocol$//$host$/";
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
	if (current !== void 0 && current.trim() !== TW_WEB_HOST_DEFAULT) return;
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
/** System-prompt section text (design doc §11 D8). */
const PROMPT_SECTION_NAME = "dsh-tiddlywiki";
const PROMPT_SECTION_ORDER = 100;
const PROMPT_TEXT = `## TiddlyWiki 持久知识库

本机有一个 TiddlyWiki 5 持久知识库（wiki 文件夹即 git 仓库）。你可以用工具读写 tiddler：

- \`tiddlywiki_search\`（query 必填；可选 tags[]/tag、since 修改时间、type、limit）检索；\`tiddlywiki_get\`（title）读全文；\`tiddlywiki_put\`（title, text, tags?, fields?）写/覆盖；\`tiddlywiki_batch_put\`（items[]）批量写；\`tiddlywiki_rename\`（oldTitle, newTitle, updateRefs?）重命名并尽量同步引用；\`tiddlywiki_delete\`（title）删除。
- \`tiddlywiki_recent\`（limit?, since?）看最近修改的笔记；\`tiddlywiki_list_tags\` 看现有 tag 及计数。
- \`tiddlywiki_git_sync\`（pull|push|sync）做 git 同步；\`tiddlywiki_git_resolve\`（files, strategy=keep-local|keep-remote|list）在 pull 冲突后按 tiddler 二选一解决。

知识库同步纪律（三条）：
1. 开工先 pull：\`tiddlywiki_git_sync action=pull\`（rebase + autostash；真冲突会自动 abort 并报冲突文件）。
2. 收工 commit + push：\`tiddlywiki_git_sync action=sync\`（pull → commit → push）。
3. 插件会自动防抖 commit（默认 60s），手动同步用上面的工具。

pull 冲突后：先 \`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local\`（保留本地）或 \`strategy=keep-remote\`（改用远端版本），再重新 pull/sync 整合其余改动。

把 wiki 当作长期记忆与知识沉淀的地方：会议纪要、决策记录、调研笔记、随手的想法都可存成独立 tiddler（tag 建议用 inbox/meeting/decision 等便于检索）。

用本插件自动创建笔记时，除了业务性 tag 外，请把「当前工作区（项目）的名字」也作为标签之一加上去（例如 \`tiddlywiki_put\` 的 tags 里带上当前 workspace 名），这样笔记能按项目归集、检索。`;
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
		ui: {
			...DEFAULTS.ui,
			...rawConfig.ui ?? {}
		},
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
		ui: config.ui
	});
	const eff = () => configStore.get();
	const effectiveNoteTag = () => {
		const tag = eff().note?.tag;
		return typeof tag === "string" && tag.trim().length > 0 ? tag : config.note.tag;
	};
	const effectiveUi = () => ({
		showQuickNote: eff().ui?.showQuickNote !== false,
		showPanelStatus: eff().ui?.showPanelStatus !== false,
		showSyncButton: eff().ui?.showSyncButton !== false
	});
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
				await ensureTwWebHost(client());
			} catch (err) {
				console.warn("[dsh-tiddlywiki] ensuring $:/config/tiddlyweb/host:", err);
			}
			try {
				const seedClient = client();
				if (seedClient !== void 0) await seedDocNote(seedClient);
			} catch (err) {
				console.warn("[dsh-tiddlywiki] seeding doc note:", err);
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
		const disposeRoutes = registerRoutes({ webServer: ws }, {
			server,
			getClient: client,
			git,
			autoCommit: () => committer?.touch(),
			noteDefaults: () => ({ tag: effectiveNoteTag() }),
			uiDefaults: () => effectiveUi(),
			getWikiPath: () => wikiPath
		});
		const disposeAdmin = registerAdminRoutes({ webServer: ws }, {
			server,
			getClient: client,
			getWikiPath: () => wikiPath,
			twRoot: resolveTwRoot,
			config: configStore
		});
		return () => {
			disposeRoutes();
			disposeAdmin();
		};
	});
	ctx.effect(() => () => {
		(async () => {
			try {
				await committer?.flush();
			} catch {}
			disposeAll();
			await server.stop();
		})();
	}, "dsh-tiddlywiki: host teardown");
}
//#endregion
export { AutoCommitter, ConfigStore, DOC_NOTE_TAG, DOC_NOTE_TEXT, DOC_NOTE_TITLE, GitFace, PATH_PREFIX, TW_PROXY_PATH, TW_PROXY_PREFIX, TW_WEB_HOST_TIDDLER, TiddlyWebClient, WikiServer, apply, bundledCatalog, deepMerge, defineTool, dshHomePath, ensureLanguage, ensureTwWebHost, inject, name, normalizeThemes, openInTwEditor, readWikiInfo, registerAdminRoutes, registerRoutes, resolveTwRoot, seedDocNote, writeWikiInfo };

//# sourceMappingURL=index.js.map