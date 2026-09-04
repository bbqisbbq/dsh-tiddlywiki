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
				json$1(res, {
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
			json$1(res, {
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
			json$1(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* GET /dsh-tiddlywiki/agent/modes — available "工作模式" (Agent presets) for
	* the TW picker: id/name/description per preset plus the deployment default.
	* Guards mirror the other agent routes (feature switch + optional token).
	*/
	const handleAgentModes = async (req, res) => {
		try {
			if (!deps.sendToAgentEnabled()) {
				json$1(res, {
					ok: false,
					error: "send-to-agent is disabled"
				}, 403);
				return;
			}
			const token = deps.sendToAgentToken().trim();
			if (token.length > 0) {
				const got = req.headers["x-send-to-agent-token"];
				if ((typeof got === "string" ? got : Array.isArray(got) ? got[0] ?? "" : "") !== token) {
					json$1(res, {
						ok: false,
						error: "unauthorized"
					}, 401);
					return;
				}
			}
			const ap = deps.getAgentPresets();
			if (ap === void 0) {
				json$1(res, {
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
			json$1(res, {
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
			json$1(res, {
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
			if (!deps.sendToAgentEnabled()) {
				json$1(res, {
					ok: false,
					error: "send-to-agent is disabled"
				}, 403);
				return;
			}
			const token = deps.sendToAgentToken().trim();
			if (token.length > 0) {
				const got = req.headers["x-send-to-agent-token"];
				if ((typeof got === "string" ? got : Array.isArray(got) ? got[0] ?? "" : "") !== token) {
					json$1(res, {
						ok: false,
						error: "unauthorized"
					}, 401);
					return;
				}
			}
			const body = JSON.parse(await readBody$1(req));
			const sessionId = typeof body.sessionId === "string" && body.sessionId.trim().length > 0 ? body.sessionId.trim() : "";
			const text = typeof body.text === "string" && body.text.trim().length > 0 ? body.text.trim() : "";
			if (sessionId.length === 0 || text.length === 0) {
				json$1(res, {
					ok: false,
					error: "sessionId and text are required"
				}, 400);
				return;
			}
			const sc = deps.getSessionController();
			if (sc === void 0) {
				json$1(res, {
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
			json$1(res, {
				ok: true,
				requestId,
				sessionId
			});
		} catch (err) {
			json$1(res, {
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
			if (!deps.sendToAgentEnabled()) {
				json$1(res, {
					ok: false,
					error: "send-to-agent is disabled"
				}, 403);
				return;
			}
			const token = deps.sendToAgentToken().trim();
			if (token.length > 0) {
				const got = req.headers["x-send-to-agent-token"];
				if ((typeof got === "string" ? got : Array.isArray(got) ? got[0] ?? "" : "") !== token) {
					json$1(res, {
						ok: false,
						error: "unauthorized"
					}, 401);
					return;
				}
			}
			const body = JSON.parse(await readBody$1(req));
			const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
			const mode = typeof body.mode === "string" && body.mode.trim().length > 0 ? body.mode.trim() : void 0;
			const permission = typeof body.permission === "string" && body.permission.trim().length > 0 ? body.permission.trim() : void 0;
			const pp = deps.getPermissionPresets();
			if (permission !== void 0) {
				if (pp === void 0) {
					json$1(res, {
						ok: false,
						error: "permission selected but the permission-presets service is unavailable"
					}, 503);
					return;
				}
				if (!pp.names.includes(permission)) {
					json$1(res, {
						ok: false,
						error: `unknown permission preset "${permission}" (available: ${pp.names.join(", ")})`
					}, 400);
					return;
				}
			}
			const sc = deps.getSessionController();
			if (sc === void 0) {
				json$1(res, {
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
			json$1(res, {
				ok: true,
				sessionId: created.sessionId,
				cwd: cwd || null,
				workspaceId: workspaceId ?? null,
				mode: mode ?? null,
				permission: permission ?? null,
				permissionApplied
			});
		} catch (err) {
			json$1(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
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
//#region src/host/seed-send-to-agent.ts
/** The packaged plugin tiddler title (a TW system tiddler, type application/json). */
const SEND_TO_AGENT_PLUGIN_TITLE = "$:/plugins/dsh/send-to-agent";
/** One-time marker: presence means "the button was offered once — hands off". */
const SEND_TO_AGENT_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-send-to-agent";
/** The bundle's JSON text (`{"tiddlers": {...}}`), exactly as TW stores it. */
const SEND_TO_AGENT_BUNDLE_TEXT = "{\n  \"tiddlers\": {\n    \"$:/plugins/dsh/send-to-agent/plugin.info\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/plugin.info\",\n      \"type\": \"application/json\",\n      \"text\": \"{\\\"title\\\":\\\"$:/plugins/dsh/send-to-agent\\\",\\\"name\\\":\\\"Send to Agent\\\",\\\"description\\\":\\\"把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）\\\",\\\"author\\\":\\\"dsh-tiddlywiki\\\",\\\"version\\\":\\\"0.3.2\\\",\\\"plugin-type\\\":\\\"plugin\\\"}\"\n    },\n    \"$:/plugins/dsh/send-to-agent/startup.js\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/startup.js\",\n      \"type\": \"application/javascript\",\n      \"module-type\": \"startup\",\n      \"text\": \"/*\\\\\\ntitle: $:/plugins/dsh/send-to-agent/startup.js\\ntype: application/javascript\\nmodule-type: startup\\n\\n\\\\*/\\n(function(){\\n\\n/*jslint node: true, browser: true */\\n/*global $tw: false */\\n\\\"use strict\\\";\\n\\nexports.name = \\\"dsh-send-to-agent\\\";\\nexports.after = [\\\"story\\\"];\\nexports.platforms = [\\\"browser\\\"];\\n\\nfunction readConfig() {\\n\\tvar config = { enabled: true, endpoint: \\\"\\\", token: \\\"\\\" };\\n\\ttry {\\n\\t\\tvar t = $tw.wiki.getTiddler(\\\"$:/plugins/dsh-tiddlywiki/config\\\");\\n\\t\\tif (t && t.fields && typeof t.fields.text === \\\"string\\\") {\\n\\t\\t\\tvar parsed = JSON.parse(t.fields.text);\\n\\t\\t\\tvar s2a = parsed && parsed.ui && parsed.ui.sendToAgent;\\n\\t\\t\\tif (s2a) {\\n\\t\\t\\t\\tif (typeof s2a.enabled === \\\"boolean\\\") { config.enabled = s2a.enabled; }\\n\\t\\t\\t\\tif (typeof s2a.endpoint === \\\"string\\\" && s2a.endpoint.length > 0) { config.endpoint = s2a.endpoint; }\\n\\t\\t\\t\\tif (typeof s2a.token === \\\"string\\\" && s2a.token.length > 0) { config.token = s2a.token; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t} catch (e) {}\\n\\treturn config;\\n}\\n\\nfunction baseEndpoint() {\\n\\tvar config = readConfig();\\n\\tif (config.endpoint.length > 0) { return config.endpoint.replace(/\\\\/+$/, \\\"\\\"); }\\n\\tif (typeof location !== \\\"undefined\\\" && location.origin) { return location.origin + \\\"/dsh-tiddlywiki\\\"; }\\n\\treturn \\\"/dsh-tiddlywiki\\\";\\n}\\n\\nfunction notify(msg) {\\n\\tif ($tw.notifier && typeof $tw.notifier.display === \\\"function\\\") {\\n\\t\\t$tw.notifier.display(msg);\\n\\t} else if (typeof alert === \\\"function\\\") {\\n\\t\\talert(msg);\\n\\t}\\n}\\n\\nfunction doSend(payload, sessionId, note) {\\n\\tvar config = readConfig();\\n\\tvar lines = [];\\n\\tlines.push(\\\"《\\\" + payload.title + \\\"》\\\");\\n\\tlines.push(\\\"标签: \\\" + (payload.tags || []).join(\\\", \\\"));\\n\\tlines.push(\\\"类型: \\\" + (payload.type || \\\"无\\\"));\\n\\tlines.push(\\\"\\\");\\n\\tlines.push(\\\"【待办说明】以下内容是我（用户）提前编辑在 TiddlyWiki 知识库中的待办事项，通过「发送给 Agent」一键发送给你处理。请按内容执行；如有任何不清楚的地方，请主动向我提问，不要臆测或擅自发挥。\\\");\\n\\tif (note && String(note).trim().length > 0) {\\n\\t\\tlines.push(\\\"\\\");\\n\\t\\tlines.push(\\\"【附加说明】\\\" + String(note).trim());\\n\\t}\\n\\tlines.push(\\\"\\\");\\n\\tlines.push(payload.text || \\\"\\\");\\n\\tvar text = lines.join(\\\"\\\\n\\\");\\n\\tvar headers = { \\\"Content-Type\\\": \\\"application/json\\\" };\\n\\tif (config.token.length > 0) { headers[\\\"x-send-to-agent-token\\\"] = config.token; }\\n\\t$tw.utils.httpRequest({\\n\\t\\turl: baseEndpoint() + \\\"/agent/send\\\",\\n\\t\\ttype: \\\"POST\\\",\\n\\t\\theaders: headers,\\n\\t\\tdata: JSON.stringify({ sessionId: sessionId, text: text }),\\n\\t\\tcallback: function(err, data) {\\n\\t\\t\\tvar parsed = null;\\n\\t\\t\\ttry { parsed = JSON.parse(data || \\\"\\\"); } catch (e) {}\\n\\t\\t\\tif (err) { notify(\\\"发送失败：\\\" + err); return; }\\n\\t\\t\\tif (parsed && parsed.ok) {\\n\\t\\t\\t\\tnotify(\\\"已发送 ✓ 会话 \\\" + sessionId.slice(0, 8));\\n\\t\\t\\t} else {\\n\\t\\t\\t\\tnotify(\\\"发送失败：\\\" + ((parsed && parsed.error) || data || \\\"未知错误\\\"));\\n\\t\\t\\t}\\n\\t\\t}\\n\\t});\\n}\\n\\nfunction closeOverlay(overlay, escHandler) {\\n\\tif (escHandler) { document.removeEventListener(\\\"keydown\\\", escHandler); }\\n\\tif (overlay && overlay.parentNode) { overlay.parentNode.removeChild(overlay); }\\n}\\n\\nfunction showPicker(payload, items, modes, defaultId, permissions) {\\n\\tif (typeof document === \\\"undefined\\\") { return; }\\n\\t// remove any previously-open picker\\n\\tvar old = document.getElementById(\\\"dsh-send-picker\\\");\\n\\tif (old && old.parentNode) { old.parentNode.removeChild(old); }\\n\\n\\tvar state = { workspace: null, mode: \\\"\\\", note: \\\"\\\", permission: \\\"\\\" };\\n\\n\\tvar overlay = document.createElement(\\\"div\\\");\\n\\toverlay.id = \\\"dsh-send-picker\\\";\\n\\toverlay.setAttribute(\\\"style\\\", \\\"position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);z-index:99999;display:flex;align-items:center;justify-content:center;\\\");\\n\\tvar box = document.createElement(\\\"div\\\");\\n\\tbox.setAttribute(\\\"style\\\", \\\"background:#fff;color:#333;border-radius:8px;padding:14px;min-width:340px;max-width:560px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.3);font-family:system-ui,-apple-system,sans-serif;\\\");\\n\\n\\t// header\\n\\tvar header = document.createElement(\\\"div\\\");\\n\\theader.setAttribute(\\\"style\\\", \\\"display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;\\\");\\n\\tvar h = document.createElement(\\\"h3\\\");\\n\\th.setAttribute(\\\"style\\\", \\\"margin:0;font-size:15px;\\\");\\n\\th.textContent = \\\"发送给 Agent · 选择目标\\\";\\n\\tvar closeX = document.createElement(\\\"button\\\");\\n\\tcloseX.type = \\\"button\\\";\\n\\tcloseX.textContent = \\\"✕\\\";\\n\\tcloseX.title = \\\"关闭\\\";\\n\\tcloseX.setAttribute(\\\"style\\\", \\\"border:none;background:transparent;font-size:15px;cursor:pointer;color:#888;padding:2px 8px;border-radius:4px;\\\");\\n\\tcloseX.addEventListener(\\\"click\\\", function() { closeOverlay(overlay, escHandler); });\\n\\theader.appendChild(h);\\n\\theader.appendChild(closeX);\\n\\tbox.appendChild(header);\\n\\n\\t// description\\n\\tvar desc = document.createElement(\\\"p\\\");\\n\\tdesc.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;font-size:12px;color:#888;word-break:break-all;\\\");\\n\\tdesc.textContent = \\\"《\\\" + payload.title + \\\"》将作为消息注入所选会话\\\";\\n\\tbox.appendChild(desc);\\n\\n\\t// 附加说明（可选）— any extra context the user wants to attach to the\\n\\t// message, e.g. what to focus on or how to handle it.\\n\\tvar noteRow = document.createElement(\\\"div\\\");\\n\\tnoteRow.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;\\\");\\n\\tvar noteLbl = document.createElement(\\\"label\\\");\\n\\tnoteLbl.setAttribute(\\\"style\\\", \\\"display:block;font-size:12px;color:#666;margin-bottom:4px;\\\");\\n\\tnoteLbl.textContent = \\\"附加说明（可选，随笔记一起发给 Agent）\\\";\\n\\tnoteRow.appendChild(noteLbl);\\n\\tvar noteTa = document.createElement(\\\"textarea\\\");\\n\\tnoteTa.placeholder = \\\"例如：请重点看第 3 条；我希望你按 XX 方式处理…\\\";\\n\\tnoteTa.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;min-height:44px;resize:vertical;font-family:inherit;\\\");\\n\\tnoteTa.addEventListener(\\\"input\\\", function() { state.note = noteTa.value; });\\n\\tnoteRow.appendChild(noteTa);\\n\\tbox.appendChild(noteRow);\\n\\n\\t// 工作模式（Agent 预设）selector — applies to newly created sessions; the\\n\\t// modes come from GET /agent/modes (id/name/description + deployment\\n\\t// default). When the modes endpoint is unreachable (e.g. an older host) the\\n\\t// row degrades to a hint and no mode is sent — DSH uses its default.\\n\\tvar modeRow = document.createElement(\\\"div\\\");\\n\\tmodeRow.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;\\\");\\n\\tif (modes && modes.length > 0) {\\n\\t\\tvar modeLbl = document.createElement(\\\"label\\\");\\n\\t\\tmodeLbl.setAttribute(\\\"style\\\", \\\"display:block;font-size:12px;color:#666;margin-bottom:4px;\\\");\\n\\t\\tmodeLbl.textContent = \\\"工作模式（Agent 预设）— 用于新建会话\\\";\\n\\t\\tmodeRow.appendChild(modeLbl);\\n\\t\\tvar sel = document.createElement(\\\"select\\\");\\n\\t\\tsel.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;\\\");\\n\\t\\tvar optDefault = document.createElement(\\\"option\\\");\\n\\t\\toptDefault.value = \\\"\\\";\\n\\t\\toptDefault.textContent = \\\"（默认模式）\\\";\\n\\t\\tsel.appendChild(optDefault);\\n\\t\\tmodes.forEach(function(m) {\\n\\t\\t\\tvar o = document.createElement(\\\"option\\\");\\n\\t\\t\\to.value = m.id || \\\"\\\";\\n\\t\\t\\to.textContent = (m.name || m.id) + (m.isDefault ? \\\"（默认）\\\" : \\\"\\\");\\n\\t\\t\\tsel.appendChild(o);\\n\\t\\t});\\n\\t\\t// preselect the deployment default when listed\\n\\t\\tif (defaultId) {\\n\\t\\t\\tfor (var i = 0; i < sel.options.length; i++) {\\n\\t\\t\\t\\tif (sel.options[i].value === defaultId) { sel.selectedIndex = i; break; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t\\tstate.mode = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].value : \\\"\\\";\\n\\t\\tsel.addEventListener(\\\"change\\\", function() { state.mode = sel.value; });\\n\\t\\tmodeRow.appendChild(sel);\\n\\t} else {\\n\\t\\tvar modeHint = document.createElement(\\\"p\\\");\\n\\t\\tmodeHint.setAttribute(\\\"style\\\", \\\"margin:0;font-size:12px;color:#999;\\\");\\n\\t\\tmodeHint.textContent = \\\"（未获取到可用工作模式，将使用 DSH 默认模式）\\\";\\n\\t\\tmodeRow.appendChild(modeHint);\\n\\t}\\n\\tbox.appendChild(modeRow);\\n\\n\\t// 权限（权限预设）selector — applies to newly created sessions only; the\\n\\t// options come from GET /agent/modes' `permissions` roster (each bundles a\\n\\t// sandbox mode + approval policy). Existing sessions keep their own\\n\\t// permission, so this only affects \\\"新建会话并发送\\\".\\n\\tvar permRow = document.createElement(\\\"div\\\");\\n\\tpermRow.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;\\\");\\n\\tif (permissions && Array.isArray(permissions.items) && permissions.items.length > 0) {\\n\\t\\tvar permLbl = document.createElement(\\\"label\\\");\\n\\t\\tpermLbl.setAttribute(\\\"style\\\", \\\"display:block;font-size:12px;color:#666;margin-bottom:4px;\\\");\\n\\t\\tpermLbl.textContent = \\\"权限（权限预设）— 用于新建会话\\\";\\n\\t\\tpermRow.appendChild(permLbl);\\n\\t\\tvar psel = document.createElement(\\\"select\\\");\\n\\t\\tpsel.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;\\\");\\n\\t\\tpermissions.items.forEach(function(p) {\\n\\t\\t\\tvar o = document.createElement(\\\"option\\\");\\n\\t\\t\\to.value = p.value || \\\"\\\";\\n\\t\\t\\to.textContent = p.name || p.value;\\n\\t\\t\\tif (p.description) { o.title = p.description; }\\n\\t\\t\\tpsel.appendChild(o);\\n\\t\\t});\\n\\t\\t// preselect the deployment default when listed\\n\\t\\tif (permissions.defaultId) {\\n\\t\\t\\tfor (var j = 0; j < psel.options.length; j++) {\\n\\t\\t\\t\\tif (psel.options[j].value === permissions.defaultId) { psel.selectedIndex = j; break; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t\\tstate.permission = psel.options[psel.selectedIndex] ? psel.options[psel.selectedIndex].value : \\\"\\\";\\n\\t\\tpsel.addEventListener(\\\"change\\\", function() { state.permission = psel.value; });\\n\\t\\tpermRow.appendChild(psel);\\n\\t} else {\\n\\t\\tvar permHint = document.createElement(\\\"p\\\");\\n\\t\\tpermHint.setAttribute(\\\"style\\\", \\\"margin:0;font-size:12px;color:#999;\\\");\\n\\t\\tpermHint.textContent = \\\"（未获取到权限预设，新建会话将使用 DSH 默认权限）\\\";\\n\\t\\tpermRow.appendChild(permHint);\\n\\t}\\n\\tbox.appendChild(permRow);\\n\\n\\t// scrollable body\\n\\tvar body = document.createElement(\\\"div\\\");\\n\\tbody.setAttribute(\\\"style\\\", \\\"overflow:auto;flex:1;min-height:0;\\\");\\n\\tbox.appendChild(body);\\n\\n\\t// footer with cancel\\n\\tvar footer = document.createElement(\\\"div\\\");\\n\\tfooter.setAttribute(\\\"style\\\", \\\"display:flex;justify-content:flex-end;gap:8px;margin-top:10px;\\\");\\n\\tvar cancel = document.createElement(\\\"button\\\");\\n\\tcancel.type = \\\"button\\\";\\n\\tcancel.textContent = \\\"取消\\\";\\n\\tcancel.setAttribute(\\\"style\\\", \\\"padding:6px 14px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;\\\");\\n\\tcancel.addEventListener(\\\"click\\\", function() { closeOverlay(overlay, escHandler); });\\n\\tfooter.appendChild(cancel);\\n\\tbox.appendChild(footer);\\n\\n\\toverlay.appendChild(box);\\n\\tdocument.body.appendChild(overlay);\\n\\n\\t// backdrop click + Esc close\\n\\toverlay.addEventListener(\\\"click\\\", function(e) {\\n\\t\\tif (e.target === overlay) { closeOverlay(overlay, escHandler); }\\n\\t});\\n\\tvar escHandler = function(e) { if (e.key === \\\"Escape\\\") { closeOverlay(overlay, escHandler); } };\\n\\tdocument.addEventListener(\\\"keydown\\\", escHandler);\\n\\n\\t// group sessions by workspace (cwd)\\n\\tvar groups = {};\\n\\tvar order = [];\\n\\t(items || []).forEach(function(s) {\\n\\t\\tvar key = (s.cwd && String(s.cwd).length > 0) ? s.cwd : \\\"__default__\\\";\\n\\t\\tif (!groups[key]) { groups[key] = { cwd: s.cwd, sessions: [], max: 0 }; order.push(key); }\\n\\t\\tgroups[key].sessions.push(s);\\n\\t\\tif ((s.updatedAt || 0) > groups[key].max) { groups[key].max = s.updatedAt || 0; }\\n\\t});\\n\\torder.sort(function(a, b) { return groups[b].max - groups[a].max; });\\n\\n\\tfunction btnStyle() {\\n\\t\\treturn \\\"display:block;width:100%;text-align:left;padding:8px 10px;margin:4px 0;border:1px solid #ddd;border-radius:6px;background:#f7f7f7;cursor:pointer;font-size:13px;\\\";\\n\\t}\\n\\tfunction primaryBtnStyle() {\\n\\t\\treturn \\\"display:block;width:100%;text-align:center;padding:7px 10px;margin:6px 0 0;border:1px solid #4a90d9;border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer;font-size:13px;\\\";\\n\\t}\\n\\tfunction smallBtnStyle() {\\n\\t\\treturn \\\"margin:0 0 6px;padding:4px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;color:#555;\\\";\\n\\t}\\n\\n\\tfunction shortSessionLabel(s) {\\n\\t\\tvar id = s.sessionId || \\\"\\\";\\n\\t\\tvar parts = id.split(\\\"-\\\");\\n\\t\\tvar short = (parts.length > 1 ? parts[parts.length - 1] : id).slice(-10);\\n\\t\\tvar when = \\\"\\\";\\n\\t\\tif (s.updatedAt) {\\n\\t\\t\\tvar diff = Date.now() - s.updatedAt;\\n\\t\\t\\tif (diff < 60000) { when = \\\"刚刚\\\"; }\\n\\t\\t\\telse if (diff < 3600000) { when = Math.floor(diff / 60000) + \\\" 分钟前\\\"; }\\n\\t\\t\\telse if (diff < 86400000) { when = Math.floor(diff / 3600000) + \\\" 小时前\\\"; }\\n\\t\\t\\telse {\\n\\t\\t\\t\\tvar d = new Date(s.updatedAt);\\n\\t\\t\\t\\twhen = (d.getMonth() + 1) + \\\"-\\\" + d.getDate() + \\\" \\\" + (\\\"0\\\" + d.getHours()).slice(-2) + \\\":\\\" + (\\\"0\\\" + d.getMinutes()).slice(-2);\\n\\t\\t\\t}\\n\\t\\t}\\n\\t\\treturn \\\"#\\\" + short + (when ? \\\"  ·  \\\" + when : \\\"\\\") + (s.running ? \\\"  ·  ●运行中\\\" : \\\"\\\") + (s.blank ? \\\"  ·  (空)\\\" : \\\"\\\");\\n\\t}\\n\\n\\tfunction modeName(id) {\\n\\t\\tif (!id) { return \\\"\\\"; }\\n\\t\\tfor (var i = 0; i < (modes || []).length; i++) {\\n\\t\\t\\tif (modes[i].id === id) { return modes[i].name || modes[i].id; }\\n\\t\\t}\\n\\t\\treturn id;\\n\\t}\\n\\n\\tfunction render() {\\n\\t\\tbody.innerHTML = \\\"\\\";\\n\\t\\tif (state.workspace === null) { renderWorkspaces(); } else { renderSessions(state.workspace); }\\n\\t}\\n\\n\\tfunction renderWorkspaces() {\\n\\t\\tif (order.length === 0) {\\n\\t\\t\\tvar none = document.createElement(\\\"p\\\");\\n\\t\\t\\tnone.textContent = \\\"还没有任何会话——在下方新建一个吧\\\";\\n\\t\\t\\tnone.setAttribute(\\\"style\\\", \\\"color:#999;font-size:13px;margin:0 0 8px;\\\");\\n\\t\\t\\tbody.appendChild(none);\\n\\t\\t} else {\\n\\t\\t\\torder.forEach(function(key) {\\n\\t\\t\\t\\tvar g = groups[key];\\n\\t\\t\\t\\tvar label = g.cwd || \\\"(默认工作区)\\\";\\n\\t\\t\\t\\tvar b = document.createElement(\\\"button\\\");\\n\\t\\t\\t\\tb.type = \\\"button\\\";\\n\\t\\t\\t\\tb.setAttribute(\\\"style\\\", btnStyle());\\n\\t\\t\\t\\tb.textContent = \\\"📁 \\\" + label + \\\"  ·  \\\" + g.sessions.length + \\\" 个会话\\\";\\n\\t\\t\\t\\tb.title = g.cwd || \\\"默认工作区\\\";\\n\\t\\t\\t\\tb.addEventListener(\\\"click\\\", function() { state.workspace = key; render(); });\\n\\t\\t\\t\\tbody.appendChild(b);\\n\\t\\t\\t});\\n\\t\\t}\\n\\t\\t// new workspace / session\\n\\t\\tvar newRow = document.createElement(\\\"div\\\");\\n\\t\\tnewRow.setAttribute(\\\"style\\\", \\\"margin-top:10px;border-top:1px solid #eee;padding-top:8px;\\\");\\n\\t\\tvar lbl = document.createElement(\\\"p\\\");\\n\\t\\tlbl.textContent = \\\"新建工作区 / 会话\\\";\\n\\t\\tlbl.setAttribute(\\\"style\\\", \\\"margin:0 0 6px;font-size:12px;color:#666;\\\");\\n\\t\\tnewRow.appendChild(lbl);\\n\\t\\tvar input = document.createElement(\\\"input\\\");\\n\\t\\tinput.type = \\\"text\\\";\\n\\t\\tinput.placeholder = \\\"输入工作区路径，留空为默认工作区\\\";\\n\\t\\tinput.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;\\\");\\n\\t\\tnewRow.appendChild(input);\\n\\t\\tvar go = document.createElement(\\\"button\\\");\\n\\t\\tgo.type = \\\"button\\\";\\n\\t\\tgo.textContent = \\\"创建并发送\\\";\\n\\t\\tgo.setAttribute(\\\"style\\\", primaryBtnStyle());\\n\\t\\tgo.addEventListener(\\\"click\\\", function() { createAndSend(payload, input.value.trim()); });\\n\\t\\tnewRow.appendChild(go);\\n\\t\\tinput.addEventListener(\\\"keydown\\\", function(e) { if (e.key === \\\"Enter\\\") { createAndSend(payload, input.value.trim()); } });\\n\\t\\tbody.appendChild(newRow);\\n\\t}\\n\\n\\tfunction renderSessions(key) {\\n\\t\\tvar g = groups[key];\\n\\t\\tvar back = document.createElement(\\\"button\\\");\\n\\t\\tback.type = \\\"button\\\";\\n\\t\\tback.textContent = \\\"← 返回工作区列表\\\";\\n\\t\\tback.setAttribute(\\\"style\\\", smallBtnStyle());\\n\\t\\tback.addEventListener(\\\"click\\\", function() { state.workspace = null; render(); });\\n\\t\\tbody.appendChild(back);\\n\\n\\t\\tvar wsName = document.createElement(\\\"p\\\");\\n\\t\\twsName.textContent = g.cwd ? \\\"📁 \\\" + g.cwd : \\\"(默认工作区)\\\";\\n\\t\\twsName.setAttribute(\\\"style\\\", \\\"margin:0 0 6px;font-size:13px;font-weight:600;word-break:break-all;\\\");\\n\\t\\tbody.appendChild(wsName);\\n\\n\\t\\t(g.sessions || []).forEach(function(s) {\\n\\t\\t\\tvar b = document.createElement(\\\"button\\\");\\n\\t\\t\\tb.type = \\\"button\\\";\\n\\t\\t\\tb.setAttribute(\\\"style\\\", btnStyle());\\n\\t\\t\\tvar label = shortSessionLabel(s);\\n\\t\\t\\tif (s.agentPreset) { label += \\\"  ·  🧭 \\\" + modeName(s.agentPreset); }\\n\\t\\t\\tb.textContent = label;\\n\\t\\t\\tb.title = \\\"会话 \\\" + s.sessionId + (s.agentPreset ? \\\" · 工作模式 \\\" + modeName(s.agentPreset) : \\\"\\\");\\n\\t\\t\\tb.addEventListener(\\\"click\\\", function() { closeOverlay(overlay, escHandler); doSend(payload, s.sessionId, state.note); });\\n\\t\\t\\tbody.appendChild(b);\\n\\t\\t});\\n\\n\\t\\tvar newBtn = document.createElement(\\\"button\\\");\\n\\t\\tnewBtn.type = \\\"button\\\";\\n\\t\\tnewBtn.textContent = \\\"➕ 在此工作区新建会话并发送\\\";\\n\\t\\tnewBtn.setAttribute(\\\"style\\\", primaryBtnStyle());\\n\\t\\tnewBtn.addEventListener(\\\"click\\\", function() { createAndSend(payload, g.cwd); });\\n\\t\\tbody.appendChild(newBtn);\\n\\t}\\n\\n\\tfunction createAndSend(payload2, cwd) {\\n\\t\\tvar config = readConfig();\\n\\t\\tvar headers = { \\\"Content-Type\\\": \\\"application/json\\\" };\\n\\t\\tif (config.token.length > 0) { headers[\\\"x-send-to-agent-token\\\"] = config.token; }\\n\\t\\tvar body = { cwd: cwd || \\\"\\\" };\\n\\t\\tif (state.mode && String(state.mode).length > 0) { body.mode = state.mode; }\\n\\t\\tif (state.permission && String(state.permission).length > 0) { body.permission = state.permission; }\\n\\t\\t$tw.utils.httpRequest({\\n\\t\\t\\turl: baseEndpoint() + \\\"/agent/create\\\",\\n\\t\\t\\ttype: \\\"POST\\\",\\n\\t\\t\\theaders: headers,\\n\\t\\t\\tdata: JSON.stringify(body),\\n\\t\\t\\tcallback: function(err, data) {\\n\\t\\t\\t\\tvar parsed = null;\\n\\t\\t\\t\\ttry { parsed = JSON.parse(data || \\\"\\\"); } catch (e) {}\\n\\t\\t\\t\\tif (err) { notify(\\\"新建会话失败：\\\" + err); return; }\\n\\t\\t\\t\\tif (parsed && parsed.ok && parsed.sessionId) {\\n\\t\\t\\t\\t\\tcloseOverlay(overlay, escHandler);\\n\\t\\t\\t\\t\\tvar modeNote = parsed.mode ? \\\"（模式 \\\" + modeName(parsed.mode) + \\\"）\\\" : \\\"\\\";\\n\\t\\t\\t\\t\\tvar permNote = parsed.permissionApplied ? \\\"（权限 \\\" + (parsed.permission || \\\"\\\") + \\\"）\\\" : \\\"\\\";\\n\\t\\t\\t\\t\\tnotify(\\\"已创建会话并发送 ✓ \\\" + parsed.sessionId.slice(0, 8) + modeNote + permNote);\\n\\t\\t\\t\\t\\tdoSend(payload2, parsed.sessionId, state.note);\\n\\t\\t\\t\\t} else {\\n\\t\\t\\t\\t\\tnotify(\\\"新建会话失败：\\\" + ((parsed && parsed.error) || data || \\\"未知错误\\\"));\\n\\t\\t\\t\\t}\\n\\t\\t\\t}\\n\\t\\t});\\n\\t}\\n\\n\\trender();\\n}\\n\\nfunction handleSend(title) {\\n\\tif (!title) { notify(\\\"无法确定当前笔记标题\\\"); return; }\\n\\tvar tiddler = $tw.wiki.getTiddler(title);\\n\\tif (!tiddler) { notify(\\\"找不到笔记：\\\" + title); return; }\\n\\tvar config = readConfig();\\n\\tif (!config.enabled) { notify(\\\"「发送给 Agent」特性未启用（可在 TW 配置中打开）\\\"); return; }\\n\\tvar payload = {\\n\\t\\ttitle: title,\\n\\t\\ttext: tiddler.fields.text || \\\"\\\",\\n\\t\\ttags: tiddler.fields.tags || [],\\n\\t\\ttype: tiddler.fields.type || \\\"\\\"\\n\\t};\\n\\tvar headers = {};\\n\\tif (config.token.length > 0) { headers[\\\"x-send-to-agent-token\\\"] = config.token; }\\n\\t$tw.utils.httpRequest({\\n\\t\\turl: baseEndpoint() + \\\"/agent/sessions\\\",\\n\\t\\ttype: \\\"GET\\\",\\n\\t\\theaders: headers,\\n\\t\\tcallback: function(err, data) {\\n\\t\\t\\tvar parsed = null;\\n\\t\\t\\ttry { parsed = JSON.parse(data || \\\"\\\"); } catch (e) {}\\n\\t\\t\\tif (err) { notify(\\\"获取会话列表失败：\\\" + err); return; }\\n\\t\\t\\tif (!parsed || !parsed.ok || !parsed.items) { notify(\\\"获取会话列表失败：\\\" + ((parsed && parsed.error) || \\\"未知错误\\\")); return; }\\n\\t\\t\\t// fetch the available 工作模式 (Agent presets) alongside; degrade to\\n\\t\\t\\t// an empty roster (default mode) when the endpoint is missing.\\n\\t\\t\\t$tw.utils.httpRequest({\\n\\t\\t\\t\\turl: baseEndpoint() + \\\"/agent/modes\\\",\\n\\t\\t\\t\\ttype: \\\"GET\\\",\\n\\t\\t\\t\\theaders: headers,\\n\\t\\t\\t\\tcallback: function(err2, data2) {\\n\\t\\t\\t\\t\\tvar modes = [];\\n\\t\\t\\t\\t\\tvar defaultId = \\\"\\\";\\n\\t\\t\\t\\t\\tvar permissions = null;\\n\\t\\t\\t\\t\\tvar parsed2 = null;\\n\\t\\t\\t\\t\\ttry { parsed2 = JSON.parse(data2 || \\\"\\\"); } catch (e) {}\\n\\t\\t\\t\\t\\tif (!err2 && parsed2 && parsed2.ok) {\\n\\t\\t\\t\\t\\t\\tif (Array.isArray(parsed2.items)) {\\n\\t\\t\\t\\t\\t\\t\\tmodes = parsed2.items;\\n\\t\\t\\t\\t\\t\\t\\tdefaultId = parsed2.defaultId || \\\"\\\";\\n\\t\\t\\t\\t\\t\\t}\\n\\t\\t\\t\\t\\t\\tif (parsed2.permissions && Array.isArray(parsed2.permissions.items)) {\\n\\t\\t\\t\\t\\t\\t\\tpermissions = parsed2.permissions;\\n\\t\\t\\t\\t\\t\\t}\\n\\t\\t\\t\\t\\t}\\n\\t\\t\\t\\t\\tshowPicker(payload, parsed.items, modes, defaultId, permissions);\\n\\t\\t\\t\\t}\\n\\t\\t\\t});\\n\\t\\t}\\n\\t});\\n}\\n\\nexports.startup = function() {\\n\\tconsole.log(\\\"[dsh-send-to-agent] startup ran\\\");\\n\\tif (!$tw.rootWidget || typeof $tw.rootWidget.addEventListener !== \\\"function\\\") { return; }\\n\\t$tw.rootWidget.addEventListener(\\\"dsh-send-to-agent\\\", function(event) {\\n\\t\\thandleSend(event.param);\\n\\t});\\n};\\n\\n})();\\n\"\n    },\n    \"$:/plugins/dsh/send-to-agent/ui/icon\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/ui/icon\",\n      \"tags\": [\n        \"$:/tags/Image\"\n      ],\n      \"text\": \"\\\\parameters (size:\\\"22pt\\\")\\n<svg width=<<size>> height=<<size>> class=\\\"tc-image-send-to-agent tc-image-button\\\" viewBox=\\\"0 0 24 24\\\"><path d=\\\"M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z\\\"/></svg>\\n\"\n    },\n    \"$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent\",\n      \"type\": \"text/vnd.tiddlywiki\",\n      \"tags\": [\n        \"$:/tags/ViewToolbar\"\n      ],\n      \"icon\": \"$:/plugins/dsh/send-to-agent/ui/icon\",\n      \"caption\": \"发送给 Agent\",\n      \"description\": \"把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）\",\n      \"text\": \"\\\\whitespace trim\\n<$button message=\\\"dsh-send-to-agent\\\"\\n\\tparam=<<currentTiddler>>\\n\\ttooltip=\\\"把当前笔记一键发送给 DSH Agent\\\"\\n\\taria-label=\\\"把当前笔记一键发送给 DSH Agent\\\"\\n\\tclass=<<tv-config-toolbar-class>>\\n>\\n\\t<%if [<tv-config-toolbar-icons>match[yes]] %>\\n\\t\\t{{$:/plugins/dsh/send-to-agent/ui/icon}}\\n\\t<%endif%>\\n\\t<%if [<tv-config-toolbar-text>match[yes]] %>\\n\\t\\t<span class=\\\"tc-btn-text\\\">\\n\\t\\t<$text text=\\\"发送给 Agent\\\"/>\\n\\t</span>\\n\\t<%endif%>\\n</$button>\\n\"\n    },\n    \"$:/core/ui/ControlPanel/Toolbars/ItemTemplate\": {\n      \"title\": \"$:/core/ui/ControlPanel/Toolbars/ItemTemplate\",\n      \"type\": \"text/vnd.tiddlywiki\",\n      \"text\": \"title: $:/core/ui/ControlPanel/Toolbars/ItemTemplate\\n\\n\\\\define config-title()\\n$(config-base)$$(currentTiddler)$\\n\\\\end\\n\\\\whitespace trim\\n\\n<$draggable tiddler=<<currentTiddler>>>\\n<$checkbox tiddler=<<config-title>> field=\\\"text\\\" checked=\\\"show\\\" unchecked=\\\"hide\\\" default=\\\"show\\\"/>\\n&#32;\\n<span class=\\\"tc-icon-wrapper\\\"><$transclude tiddler={{!!icon}}/></span>\\n&#32;\\n<$transclude field=\\\"caption\\\"/>\\n&#32;--&#32;\\n<i class=\\\"tc-muted\\\"><$transclude field=\\\"description\\\"/></i>\\n</$draggable>\\n\"\n    }\n  }\n}";
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
			tags: []
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
/** The $:/DefaultTiddlers body so 主页 opens by default in fresh wikis. */
const HOME_DEFAULT_TIDDLERS = "[[主页]]";
/** The home tiddlers, exactly as seeded (user-owned afterwards). */
const HOME_INDEX_ITEMS = [
	{
		"title": "主页",
		"tags": ["索引"],
		"type": "text/vnd.tiddlywiki",
		"text": "\\whitespace trim\n\n\\define quadrant-board()\n<div style=\"display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px;\">\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:8px 12px; background:linear-gradient(135deg,#e74c3c1a,transparent);\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🔴 重要 · 紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q1]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q1]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q1]!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</div>\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:8px 12px; background:linear-gradient(135deg,#3498db1a,transparent);\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🔵 重要 · 不紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q2]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q2]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q2]!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</div>\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:8px 12px; background:linear-gradient(135deg,#f39c121a,transparent);\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🟠 紧急 · 不重要 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q3]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q3]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q3]!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</div>\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:8px 12px; background:linear-gradient(135deg,#95a5a61a,transparent);\">\n<div style=\"font-weight:700; margin-bottom:6px;\">⚪ 不重要 · 不紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q4]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q4]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q4]!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</div>\n</div>\n\\end\n\n<$set name=\"today\" value=<<now \"YYYY0MM0DD\">>>\n\n!! 🏠 主页\n\n<div class=\"tc-message-box\">你的待办看板（四象限）与知识库入口。快速添加一行要事、选象限即建任务；点左侧方框即完成。下方入口直达所有标签统计与所有文章列表。</div>\n\n<div style=\"display:flex; gap:8px; flex-wrap:wrap; margin:8px 0;\">\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"padding:6px 16px; border:1px solid rgba(128,128,128,0.35); border-radius:8px; font-weight:600;\">\n<$action-navigate $to=\"所有标签\"/>\n🏷 所有标签\n</$button>\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"padding:6px 16px; border:1px solid rgba(128,128,128,0.35); border-radius:8px; font-weight:600;\">\n<$action-navigate $to=\"所有文章\"/>\n📚 所有文章\n</$button>\n</div>\n\n!! ✅ 待办 · 四象限\n\n<div class=\"tc-message-box\">输入一行要事、选好象限，点「➕ 添加」即建任务（默认 Q2 重要·不紧急）。你输入的这句话会直接成为任务标题，首页一目了然。点任务左侧方框即完成（自动加 <code>done</code> 标签并从看板消失）。给任意笔记打上 <code>todo</code> 标签也会被收集到下方「未分类」，补填 <code>q</code> 字段即进入象限。</div>\n\n<div style=\"display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin:10px 0;\">\n<$edit-text tiddler=\"$:/state/todo/title\" tag=\"input\" placeholder=\"快速添加：写一句要做的事，选象限后点 ➕…\" style=\"flex:1; min-width:220px; padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\"/>\n<$select tiddler=\"$:/state/todo/quadrant\" default=\"q2\" style=\"padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\">\n<option value=\"q1\">Q1 重要·紧急</option>\n<option value=\"q2\">Q2 重要·不紧急</option>\n<option value=\"q3\">Q3 紧急·不重要</option>\n<option value=\"q4\">Q4 不重要·不紧急</option>\n</$select>\n<$button class=\"tc-btn-invisible\" style=\"padding:6px 14px; border-radius:6px; border:1px solid rgba(128,128,128,0.35); font-weight:600;\">\n<$list filter=\"[{$:/state/todo/title}!is[blank]]\">\n<$action-createtiddler $basetitle={{{[{$:/state/todo/title}]}}} tags=\"todo\" text={{{[{$:/state/todo/title}]}}} q={{{[{$:/state/todo/quadrant}!is[blank]else[q2]]}}}/>\n<$action-setfield $tiddler=\"$:/state/todo/title\" text=\"\"/>\n</$list>\n➕ 添加\n</$button>\n</div>\n\n<div style=\"margin:6px 0; color:#555;\">📅 今日到期 <b>{{{[tag[todo]!tag[done]field:due<today>count[]]}}}</b> 件　·　⏰ 已逾期 <b>{{{[tag[todo]!tag[done]get[due]compare:date:lt<today>count[]]}}}</b> 件</div>\n\n<<quadrant-board>>\n\n<$list filter=\"[tag[todo]!tag[done]!has[q]count[]!match[0]]\">\n<div style=\"margin-top:10px; border:1px dashed rgba(128,128,128,0.35); border-radius:10px; padding:8px 12px;\">\n<div style=\"font-weight:700; margin-bottom:6px;\">📥 未分类 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]!has[q]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]!has[q]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n</div>\n</$list>\n</div>\n</$list>\n\n</$set>\n"
	},
	{
		"title": "所有标签",
		"tags": ["索引"],
		"type": "text/vnd.tiddlywiki",
		"text": "\\whitespace trim\n\n\\define tag-count() [all[tiddlers]!is[system]!tag[agent-written]tag<currentTiddler>count[]]\n\\define tag-list() [all[tiddlers]!is[system]!tag[agent-written]tags[]!prefix[$:/tags/]!match[索引]]\n\n\\define agent-notes-pure() [all[tiddlers]!is[system]tag[agent-written]!tag[human-edited]count[]]\n\\define agent-notes-mixed() [all[tiddlers]!is[system]tag[agent-written]tag[human-edited]count[]]\n\\define agent-tags-pure() [all[tiddlers]!is[system]tag[agent-written]!tag[human-edited]tags[]!prefix[$:/tags/]!match[索引]!match[agent-written]!match[human-edited]]\n\\define agent-tags-mixed() [all[tiddlers]!is[system]tag[agent-written]tag[human-edited]tags[]!prefix[$:/tags/]!match[索引]!match[agent-written]!match[human-edited]]\n\\define agent-count-pure() [all[tiddlers]!is[system]tag[agent-written]!tag[human-edited]tag<currentTiddler>count[]]\n\\define agent-count-mixed() [all[tiddlers]!is[system]tag[agent-written]tag[human-edited]tag<currentTiddler>count[]]\n\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"margin:6px 0; padding:4px 10px; border:1px solid rgba(128,128,128,0.3); border-radius:6px; font-size:0.9em;\">\n<$action-navigate $to=\"主页\"/>\n← 回主页\n</$button>\n\n!! 🏷 所有标签\n\n<div class=\"tc-message-box\">按笔记数量从多到少排序，仅统计人类笔记（Agent 撰写的笔记已排除，见下方「🤖 Agent 撰写的标签」）。点击标签，查看包含该标签的所有笔记。</div>\n\n<div style=\"margin-top:12px;\">\n<$list filter=\"[subfilter<tag-list>] +[!sortsub:number<tag-count>]\">\n<$set name=\"count\" value={{{ [subfilter<tag-count>] }}}>\n<div style=\"padding:7px 2px; border-bottom:1px solid rgba(128,128,128,0.15);\">\n<$button set=\"$:/state/tag\" setTo=<<currentTiddler>> class=\"tc-btn-invisible tc-tiddlylink\" style=\"width:100%; text-align:left;\">\n<$action-navigate $to=\"标签笔记\"/>\n<span style=\"font-weight:600; font-size:1.05em;\"><<currentTiddler>></span>\n<span style=\"color:#888; font-size:0.85em; margin-left:8px;\"><<count>> 篇</span>\n</$button>\n</div>\n</$set>\n</$list>\n</div>\n\n!! 🤖 Agent 撰写的标签\n\n<div class=\"tc-message-box\">以下标签来自带有 <code>agent-written</code> 标签（由 Agent 撰写）的笔记，与上方主列表分开统计。若某篇 Agent 笔记又被人类编辑过，请给它补打 <code>human-edited</code> 标签，即归入下方「Agent + 人工」档。</div>\n\n<div style=\"font-weight:700; margin:8px 0 4px;\">🦾 纯 Agent <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[subfilter<agent-notes-pure>]}}} 篇</span></div>\n<div style=\"margin-left:10px;\">\n<$list filter=\"[subfilter<agent-tags-pure>] +[!sortsub:number<agent-count-pure>]\">\n<$set name=\"count\" value={{{ [subfilter<agent-count-pure>] }}}>\n<div style=\"padding:7px 2px; border-bottom:1px solid rgba(128,128,128,0.15);\">\n<$button set=\"$:/state/tag\" setTo=<<currentTiddler>> class=\"tc-btn-invisible tc-tiddlylink\" style=\"width:100%; text-align:left;\">\n<$action-navigate $to=\"标签笔记\"/>\n<span style=\"font-weight:600; font-size:1.05em;\"><<currentTiddler>></span>\n<span style=\"color:#888; font-size:0.85em; margin-left:8px;\"><<count>> 篇</span>\n</$button>\n</div>\n</$set>\n</$list>\n<$list filter=\"[subfilter<agent-tags-pure>!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无纯 Agent 笔记）</div></$list>\n</div>\n\n<div style=\"font-weight:700; margin:10px 0 4px;\">🤝 Agent + 人工 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[subfilter<agent-notes-mixed>]}}} 篇</span></div>\n<div style=\"margin-left:10px;\">\n<$list filter=\"[subfilter<agent-tags-mixed>] +[!sortsub:number<agent-count-mixed>]\">\n<$set name=\"count\" value={{{ [subfilter<agent-count-mixed>] }}}>\n<div style=\"padding:7px 2px; border-bottom:1px solid rgba(128,128,128,0.15);\">\n<$button set=\"$:/state/tag\" setTo=<<currentTiddler>> class=\"tc-btn-invisible tc-tiddlylink\" style=\"width:100%; text-align:left;\">\n<$action-navigate $to=\"标签笔记\"/>\n<span style=\"font-weight:600; font-size:1.05em;\"><<currentTiddler>></span>\n<span style=\"color:#888; font-size:0.85em; margin-left:8px;\"><<count>> 篇</span>\n</$button>\n</div>\n</$set>\n</$list>\n<$list filter=\"[subfilter<agent-tags-mixed>!count[]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无「Agent + 人工」笔记）</div></$list>\n</div>\n"
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
* one-shot policy). Also writes $:/DefaultTiddlers → [[主页]] so the new home
* opens by default. With `force` the tiddlers are overwritten with the
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
<$action-navigate $to="主页"/>
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
//#endregion
//#region src/host/seeds.ts
const presentOf = (ctx, title) => ctx.client.get(title).then((t) => t !== void 0).catch(() => false);
/** The full registry, in display order. */
const SEED_DEFS = [
	{
		id: "doc-note",
		title: "插件说明笔记",
		description: "「dsh-tiddlywiki 插件说明」——新 wiki 首启自动写入的入门说明（ONE-SHOT，用户可改可删）。",
		check: async (ctx) => {
			const present = await presentOf(ctx, DOC_NOTE_TITLE);
			return {
				id: "doc-note",
				title: "插件说明笔记",
				description: "「dsh-tiddlywiki 插件说明」——新 wiki 首启自动写入的入门说明（ONE-SHOT，用户可改可删）。",
				present,
				detail: present ? "已存在" : "缺失"
			};
		},
		run: async (ctx, force) => {
			try {
				const wrote = await seedDocNote(ctx.client, { force });
				return {
					id: "doc-note",
					ok: true,
					wrote,
					detail: wrote ? force ? "已重新初始化" : "已写入" : force ? "内容已是最新（未重写）" : "已存在，跳过"
				};
			} catch (err) {
				return {
					id: "doc-note",
					ok: false,
					wrote: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
	},
	{
		id: "send-to-agent",
		title: "「发送给 Agent」按钮",
		description: "TW 笔记工具栏「发送给 Agent」按钮插件（$:/plugins/dsh/send-to-agent）——把笔记一键注入 DSH 会话。",
		check: async (ctx) => {
			const present = await presentOf(ctx, SEND_TO_AGENT_PLUGIN_TITLE);
			return {
				id: "send-to-agent",
				title: "「发送给 Agent」按钮",
				description: "TW 笔记工具栏「发送给 Agent」按钮插件（$:/plugins/dsh/send-to-agent）——把笔记一键注入 DSH 会话。",
				present,
				detail: present ? "已存在" : "缺失"
			};
		},
		run: async (ctx, force) => {
			try {
				const wrote = await seedSendToAgent(ctx.client, { force });
				return {
					id: "send-to-agent",
					ok: true,
					wrote,
					detail: wrote ? force ? "已重新初始化" : "已写入" : force ? "内容已是最新（未重写）" : "已存在，跳过"
				};
			} catch (err) {
				return {
					id: "send-to-agent",
					ok: false,
					wrote: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
	},
	{
		id: "home-index",
		title: "首页（主页 / 所有标签 / 标签笔记）",
		description: "默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页同时写入 $:/DefaultTiddlers。",
		check: async (ctx) => {
			const missing = [];
			for (const item of HOME_INDEX_ITEMS) if (!await presentOf(ctx, item.title)) missing.push(item.title);
			return {
				id: "home-index",
				title: "首页（主页 / 所有标签 / 标签笔记）",
				description: "默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页同时写入 $:/DefaultTiddlers。",
				present: missing.length === 0,
				detail: missing.length === 0 ? "已存在" : `缺失：${missing.join("、")}`
			};
		},
		run: async (ctx, force) => {
			try {
				const wrote = await seedHomeIndex(ctx.client, { force });
				return {
					id: "home-index",
					ok: true,
					wrote,
					detail: wrote ? force ? "已重新初始化" : "已写入" : force ? "内容已是最新（未重写）" : "已存在，跳过"
				};
			} catch (err) {
				return {
					id: "home-index",
					ok: false,
					wrote: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
	},
	{
		id: "all-articles",
		title: "所有文章（两列分页总览）",
		description: "「所有文章」——全部条目分两列（🤖 Agent 撰写 / 👤 人工·人类）各自分页展示。每页条数取插件设置 ui.allArticles.pageSize（默认 10）。",
		check: async (ctx) => {
			const present = await presentOf(ctx, ALL_ARTICLES_TITLE);
			return {
				id: "all-articles",
				title: "所有文章（两列分页总览）",
				description: "「所有文章」——全部条目分两列（🤖 Agent 撰写 / 👤 人工·人类）各自分页展示。每页条数取插件设置 ui.allArticles.pageSize（默认 10）。",
				present,
				detail: present ? "已存在" : "缺失"
			};
		},
		run: async (ctx, force) => {
			try {
				const wrote = await seedAllArticles(ctx.client, { force });
				return {
					id: "all-articles",
					ok: true,
					wrote,
					detail: wrote ? force ? "已重新初始化" : "已写入" : force ? "内容已是最新（未重写）" : "已存在，跳过"
				};
			} catch (err) {
				return {
					id: "all-articles",
					ok: false,
					wrote: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
	},
	{
		id: "menubar-theme",
		title: "menubar 顶栏主题自适应",
		description: "样式表覆盖（$:/plugins/dsh-tiddlywiki/menubar-theme，tag $:/tags/Stylesheet）——把 tiddlywiki/menubar 顶栏从「默认色映射的蓝色」改为跟随当前 palette 的 background/foreground，随 DSH 主题切换（$:/palette 翻转）自动换色。",
		check: async (ctx) => {
			const present = await presentOf(ctx, MENUBAR_THEME_TIDDLER);
			return {
				id: "menubar-theme",
				title: "menubar 顶栏主题自适应",
				description: "样式表覆盖（$:/plugins/dsh-tiddlywiki/menubar-theme，tag $:/tags/Stylesheet）——把 tiddlywiki/menubar 顶栏从「默认色映射的蓝色」改为跟随当前 palette 的 background/foreground，随 DSH 主题切换（$:/palette 翻转）自动换色。",
				present,
				detail: present ? "已存在" : "缺失"
			};
		},
		run: async (ctx, force) => {
			try {
				const wrote = await seedMenubarTheme(ctx.client, { force });
				return {
					id: "menubar-theme",
					ok: true,
					wrote,
					detail: wrote ? force ? "已重新初始化" : "已写入" : force ? "内容已是最新（未重写）" : "已存在，跳过"
				};
			} catch (err) {
				return {
					id: "menubar-theme",
					ok: false,
					wrote: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
	},
	{
		id: "tw-web-host",
		title: "TW 前端 API 基址（同源代理）",
		description: "把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。",
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
	}
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
			detail: `检查失败：${err instanceof Error ? err.message : String(err)}`
		});
	}
	return out;
}
/**
* Run one seed (or all, when id is undefined). Non-force = one-shot semantics;
* force = manual "重新初始化" from the settings page.
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
/** Startup path: run every seed non-force (write only what is missing). */
async function runAllSeeds(ctx) {
	return runSeedById(ctx, void 0, false);
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
/**
* 约定标签：标记「由 Agent 撰写」的笔记。
* 新建（title 不存在）时由 tiddlywiki_put / tiddlywiki_batch_put 自动补打；
* 首页据此把这类笔记单独列在「Agent 区块」并从主标签列表排除。
*/
const AGENT_WRITTEN_TAG = "agent-written";
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
		description: "写入（新建或覆盖）一个 TiddlyWiki tiddler。同名覆盖；tags 为标签数组，fields 为附加自定义字段（json 对象，会写入 tiddler 字段）。写入后触发自动 commit。新建（title 不存在）时自动补打 agent-written 标签标记「由 Agent 撰写」，无需手动添加。",
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
			const existing = await wiki.get(args.title).catch(() => void 0);
			const tags = finalTagsForWrite(args.title, existing, Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string" && t.trim().length > 0) : []);
			const tiddler = {
				title: args.title,
				text: args.text
			};
			if (tags.length > 0) tiddler.tags = tags;
			if (args.fields !== void 0 && typeof args.fields === "object" && args.fields !== null) Object.assign(tiddler, args.fields);
			await wiki.put(tiddler);
			deps.autoCommit();
			return {
				ok: true,
				title: args.title,
				tags,
				fields: args.fields ?? null
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_batch_put",
		description: "批量写入/覆盖多个 TiddlyWiki tiddler（一次工具调用）。overwrite=false 时跳过已存在的标题；返回逐条结果。写入后触发自动 commit。新建（title 不存在）的条目会自动补打 agent-written 标签，无需手动添加。",
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
		showSyncButton: true,
		followDshTheme: true,
		darkPalette: DARK_PALETTE_DEFAULT,
		sendToAgent: { enabled: true }
	},
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

用本插件自动创建笔记时，除了业务性 tag 外，请把「当前工作区（项目）的名字」也作为标签之一加上去（例如 \`tiddlywiki_put\` 的 tags 里带上当前 workspace 名），这样笔记能按项目归集、检索。

**Agent 笔记标签约定**：\`tiddlywiki_put\` / \`tiddlywiki_batch_put\` 新建笔记时，插件会自动补打 \`agent-written\` 标签（标记「由 Agent 撰写」），无需手动添加，也不要手动移除它（除非用户明确要求）。首页会把 Agent 笔记单独列在「Agent 区块」，主标签列表只统计人类笔记。若某篇 Agent 笔记后续被人类编辑过，请在该笔记上补打 \`human-edited\` 标签，首页会把它归入「Agent + 人工」档。覆盖写入已有的（人类）笔记时不会自动加 agent-written，请保持笔记原本的归属。`;
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
	const effectiveUi = () => {
		const ui = eff().ui ?? {};
		const palette = typeof ui.darkPalette === "string" && ui.darkPalette.trim().length > 0 ? ui.darkPalette.trim() : DARK_PALETTE_DEFAULT;
		return {
			showQuickNote: ui.showQuickNote !== false,
			showPanelStatus: ui.showPanelStatus !== false,
			showSyncButton: ui.showSyncButton !== false,
			followDshTheme: ui.followDshTheme !== false,
			darkPalette: palette
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
				const seedClient = client();
				if (seedClient !== void 0) {
					const results = await runAllSeeds({ client: seedClient });
					for (const r of results) if (!r.ok) console.warn(`[dsh-tiddlywiki] seed ${r.id} failed:`, r.error ?? r.detail);
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
				run: async (c, id, force) => runSeedById({ client: c }, id, force)
			}
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
export { ALL_ARTICLES_MARKER_TITLE, ALL_ARTICLES_TEXT, ALL_ARTICLES_TITLE, AutoCommitter, ConfigStore, DOC_NOTE_TAG, DOC_NOTE_TEXT, DOC_NOTE_TITLE, GitFace, HOME_DEFAULT_TIDDLERS, HOME_INDEX_ITEMS, HOME_INDEX_MARKER_TITLE, MENUBAR_THEME_MARKER_TITLE, MENUBAR_THEME_TEXT, MENUBAR_THEME_TIDDLER, PATH_PREFIX, SEED_DEFS, SEND_TO_AGENT_BUNDLE_TEXT, SEND_TO_AGENT_MARKER_TITLE, SEND_TO_AGENT_PLUGIN_TITLE, TW_PROXY_PATH, TW_PROXY_PREFIX, TW_WEB_HOST_DEFAULT, TW_WEB_HOST_TIDDLER, TiddlyWebClient, WikiServer, apply, bundledCatalog, checkAllSeeds, deepMerge, defineTool, dshHomePath, ensureLanguage, ensureTwWebHost, inject, name, normalizeThemes, openInTwEditor, readWikiInfo, registerAdminRoutes, registerRoutes, registerTiddlywikiTools, resolveTwRoot, runAllSeeds, runSeedById, seedAllArticles, seedDocNote, seedHomeIndex, seedMenubarTheme, seedSendToAgent, writeWikiInfo };

//# sourceMappingURL=index.js.map