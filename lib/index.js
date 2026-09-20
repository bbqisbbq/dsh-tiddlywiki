import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { createServer, isIP } from "node:net";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { createServer as createServer$1, get } from "node:http";
import { get as get$1 } from "node:https";
import { lookup } from "node:dns/promises";
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
* **Commit guard (v0.23.4, 真实事故)**: `git pull --rebase --autostash` can end
* with the REBASE succeeding but the autostash RE-APPLY conflicting. `rebase
* --abort` then has nothing to abort, so the conflict markers stay in the
* working tree while every subsequent `git add -A && commit` (the 60s
* AutoCommitter included) happily **commits and pushes them** — on 2026-09-17
* that is exactly how `<<<<<<< Updated upstream` got permanently written into
* this wiki's config tiddler, which in turn made the plugin unable to parse its
* own config for a day (wechat stayed off + prompt.extra silently inactive).
* `commit()` therefore REFUSES a conflicted tree up front (see
* `conflictState()`), and `pull()` re-checks after its abort.
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
/**
* A conflict block's opening/closing line. Only the LABELLED forms count
* (`<<<<<<< HEAD`, `>>>>>>> Stashed changes`): a bare `=======` is far too
* common in real content (Markdown setext headings, ASCII dividers) to treat
* as evidence of a conflict.
*/
const CONFLICT_MARKER_RE = /^(?:<{7}|>{7}) /m;
/**
* In-progress git operations that make a plain `git commit` the WRONG move.
*
* ⚠️ `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` are deliberately NOT in
* this list: with those, `git commit` IS how you conclude the operation once the
* conflicts are resolved and staged — refusing them would make a resolved merge
* permanently uncommittable (v0.23.4, caught by the real-git E2E). They are still
* covered by the two content-based checks below: an *unresolved* merge shows up
* as unmerged index entries and/or leftover conflict blocks.
*/
const CONFLICT_STATE_REFS = [["rebase", "REBASE_HEAD"]];
/**
* Thrown by `GitFace.commit()` when the tree must NOT be committed. Carries the
* offending files so a route/tool can tell the user exactly what to resolve.
*/
var GitConflictStateError = class extends Error {
	reason;
	files;
	constructor(message, reason, files) {
		super(message);
		this.reason = reason;
		this.files = files;
		this.name = "GitConflictStateError";
	}
};
function parseCount(line, re) {
	const m = line.match(re);
	return m === null ? void 0 : Number(m[1]);
}
var GitFace = class {
	exec;
	readTextFile;
	/**
	* FIFO mutex for the index-touching operations (`commit` and `pull
	* --rebase`). The debounced AutoCommitter can fire while an explicit
	* `tiddlywiki_git_sync` is rebasing; both would fight over
	* `.git/index.lock` and intermittently fail. Per-instance, so a second
	* GitFace (e.g. the settings page's status probe) is unaffected.
	*/
	lock = Promise.resolve();
	withLock(fn) {
		const run = this.lock.then(fn, fn);
		this.lock = run.then(() => void 0, () => void 0);
		return run;
	}
	constructor(exec = defaultExec, readTextFile = (path) => readFileSync(path, "utf8")) {
		this.exec = exec;
		this.readTextFile = readTextFile;
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
	* a commit actually happened. Serialized against `pull()` (index.lock).
	*/
	commit(dir, message) {
		return this.withLock(() => this.commitUnlocked(dir, message));
	}
	async commitUnlocked(dir, message) {
		const conflict = await this.conflictState(dir, { contentScan: true });
		if (conflict.conflicted) throw new GitConflictStateError(describeConflict(conflict), conflict.reason, conflict.files);
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
		const conflict = await this.conflictState(dir, { contentScan: dirty });
		return {
			exists: true,
			branch,
			dirty,
			dirtyFiles,
			remote,
			...lastCommit !== void 0 ? { lastCommit } : {},
			...ahead !== void 0 ? { ahead } : {},
			...behind !== void 0 ? { behind } : {},
			...conflict.conflicted ? { conflict: {
				reason: conflict.reason,
				files: conflict.files
			} } : {}
		};
	}
	/** `git pull --rebase --autostash`; on conflict: abort + report files.
	*  On success, `changed: true` means HEAD actually moved (files came in /
	*  commits were replayed) — callers use it to decide whether a running TW
	*  child needs a restart to drop its stale in-memory snapshot.
	*  Serialized against `commit()` (index.lock). */
	pull(dir) {
		return this.withLock(() => this.pullUnlocked(dir));
	}
	async pullUnlocked(dir) {
		const before = await this.exec(["rev-parse", "HEAD"], {
			cwd: dir,
			timeout: QUICK_TIMEOUT_MS
		});
		const beforeHead = before.ok ? before.stdout.trim() : "";
		const preexistingRebase = await this.hasRebaseInProgress(dir);
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
		const rebaseNow = await this.hasRebaseInProgress(dir);
		const ourRebase = rebaseNow && !preexistingRebase;
		if (ourRebase) await this.exec(["rebase", "--abort"], {
			cwd: dir,
			timeout: HEAVY_TIMEOUT_MS
		});
		const after = await this.conflictState(dir);
		const files = after.conflicted ? [.../* @__PURE__ */ new Set([...conflictFiles, ...after.files])] : conflictFiles;
		const note = after.conflicted ? `（rebase --abort 之后工作树仍有冲突：${after.reason}）` : "";
		const userRebaseNote = rebaseNow && !ourRebase ? "（检测到你自己的 rebase 正在进行中，已保留不动——请先手动完成或 abort 它再同步）" : "";
		const reason = (r.stderr.trim() || r.stdout.trim()).slice(0, 500);
		return {
			ok: false,
			message: files.length > 0 ? `conflict in ${files.join(", ")}${ourRebase ? " (rebase aborted)" : ""}${note}${userRebaseNote}: ${reason}` : `pull failed${note}${userRebaseNote}: ${reason}`,
			...files.length > 0 ? { conflictFiles: files } : {}
		};
	}
	/** Is a rebase in progress in `dir`? (`REBASE_HEAD` or the on-disk state dirs.) */
	async hasRebaseInProgress(dir) {
		const r = await this.exec([
			"rev-parse",
			"-q",
			"--verify",
			"REBASE_HEAD"
		], {
			cwd: dir,
			timeout: QUICK_TIMEOUT_MS
		});
		if (r.ok && r.stdout.trim().length > 0) return true;
		return existsSync(join(dir, ".git", "rebase-merge")) || existsSync(join(dir, ".git", "rebase-apply"));
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
	/**
	* Is the working tree in an unresolved conflict state? (v0.23.4)
	*
	* Three sources, cheapest first — a pure `git` probe unless `contentScan`
	* is on:
	*   1. an in-progress operation (`MERGE_HEAD` / `REBASE_HEAD` / …);
	*   2. unmerged index entries (`diff --diff-filter=U`);
	*   3. a conflict BLOCK left in a changed file (the autostash-reapply case:
	*      git itself is no longer mid-operation, so only the text shows it).
	*/
	async conflictState(dir, options = {}) {
		for (const [label, ref] of CONFLICT_STATE_REFS) {
			const r = await this.exec([
				"rev-parse",
				"-q",
				"--verify",
				ref
			], {
				cwd: dir,
				timeout: QUICK_TIMEOUT_MS
			});
			if (r.ok && r.stdout.trim().length > 0) return {
				conflicted: true,
				reason: `${label} in progress`,
				files: await this.unmergedFiles(dir)
			};
		}
		const unmerged = await this.unmergedFiles(dir);
		if (unmerged.length > 0) return {
			conflicted: true,
			reason: "unmerged paths",
			files: unmerged
		};
		if (options.contentScan !== true) return {
			conflicted: false,
			reason: "",
			files: []
		};
		const marked = [];
		for (const file of await this.changedFiles(dir)) if (this.fileHasConflictMarkers(join(dir, file))) marked.push(file);
		return marked.length > 0 ? {
			conflicted: true,
			reason: "conflict markers in working tree",
			files: marked
		} : {
			conflicted: false,
			reason: "",
			files: []
		};
	}
	/** Working-tree files a commit would touch: modified, staged and untracked. */
	async changedFiles(dir) {
		const out = /* @__PURE__ */ new Set();
		for (const args of [
			[
				"diff",
				"--name-only",
				"HEAD"
			],
			[
				"diff",
				"--cached",
				"--name-only"
			],
			[
				"ls-files",
				"--others",
				"--exclude-standard"
			]
		]) {
			const r = await this.exec(args, {
				cwd: dir,
				timeout: QUICK_TIMEOUT_MS
			});
			if (!r.ok) continue;
			for (const line of r.stdout.split("\n")) {
				const name = line.trim();
				if (name.length > 0) out.add(name);
			}
		}
		return [...out];
	}
	/**
	* Does this file contain a conflict block? Read failures and binary content
	* are treated as "no" — the guard is a safety net, not a content auditor.
	*/
	fileHasConflictMarkers(absPath) {
		try {
			const text = this.readTextFile(absPath);
			if (text.includes("\0")) return false;
			return CONFLICT_MARKER_RE.test(text);
		} catch {
			return false;
		}
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
* Wording for a refused commit — shared by the error, the AutoCommitter log and
* the `/sync` 409 body so all three say the same actionable thing.
*/
function describeConflict(state) {
	const shown = state.files.slice(0, 5);
	const more = state.files.length > shown.length ? ` 等 ${state.files.length} 个文件` : "";
	const where = shown.length > 0 ? `涉及 ${shown.join("、")}${more}` : "（未列出具体文件）";
	return `拒绝提交：工作树处于未解决的冲突状态（${state.reason}），${where}。带着冲突标记提交会把坏内容写进 git 历史（v0.23.3 的真实事故：wiki 配置 tiddler 被提交了 <<<<<<< 标记，插件随即解析不了自己的配置）。请先解决冲突（tiddlywiki_git_resolve 或手动编辑）再同步。`;
}
/**
* Debounced auto-committer: every wiki write calls `touch()`; the commit
* fires once writes settle for `debounceMs`. Disable with git.autoCommit.
*/
var AutoCommitter = class {
	options;
	timer;
	disposed = false;
	/**
	* Signature of the conflict we already reported. The debounce fires every
	* 60s and a leftover conflict block stays put until a human fixes it, so
	* reporting on every tick would bury the log; report once per distinct state
	* (v0.23.4) and reset the moment a commit succeeds.
	*/
	lastBlocked;
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
			this.lastBlocked = void 0;
			this.options.onCommit?.(result);
		} catch (err) {
			if (err instanceof GitConflictStateError) {
				const signature = `${err.reason}|${err.files.join(",")}`;
				if (signature === this.lastBlocked) return;
				this.lastBlocked = signature;
			}
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
/**
* 真正「没有 type 字段」的条目（v0.19.1）。
*
* 必须靠过滤器判定：TW 服务端在 listing 与单条 GET 里都会给无 type 的条目
* **补上** `text/vnd.tiddlywiki`（`tiddlerFields.type = tiddlerFields.type ||
* "text/vnd.tiddlywiki"`），所以响应里的 `type` 永远非空，客户端无法区分
* 「本来是 wikitext」与「压根没有 type」。过滤器在服务端按真实字段求值，返回
* 的标题就是真的没有 type 的那些。串长 36 字符（白名单 tiddler 文件名 = 整个
* filter，必须短）。
*/
const MISSING_TYPE_FILTER = "[all[tiddlers]!is[system]!has[type]]";
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
/**
* Parse a tiddler date field. TW's REST listing returns dates in the COMPACT
* form (`20260101000000000` = YYYYMMDDhhmmssSSS, UTC), NOT ISO — the old code
* fed that to `new Date()`, got Invalid Date, and therefore made every
* `since`-filtered search/recent return nothing (v0.19.0). Both forms are
* accepted here; undefined = absent/unparseable.
*/
function parseTiddlerDate(value) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/.exec(value.trim());
	if (compact !== null) return Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]), Number(compact[4]), Number(compact[5]), Number(compact[6]), Number(compact[7]));
	const ms = new Date(value.trim()).getTime();
	return Number.isNaN(ms) ? void 0 : ms;
}
/** Normalize a tiddler date field to ISO-8601 (for display), or null. */
function toIsoDateString(value) {
	const ms = parseTiddlerDate(value);
	return ms === void 0 ? null : new Date(ms).toISOString();
}
/**
* Format an instant in TW's own date-field format: `YYYYMMDDhhmmssSSS` (UTC,
* 17 digits) — byte-for-byte what `$tw.utils.stringifyDate()` writes, which is
* the inverse of `parseTiddlerDate()` above.
*
* TW's `created`/`modified` tiddlerfield modules parse with `$tw.utils.parseDate`
* and stringify with `$tw.utils.stringifyDate`, so a Date produced by either
* round-trips. Sending ISO-8601 instead would still be PARSED correctly (the
* date parser is lenient) but the on-disk `.tid`/`.meta` would differ from what
* the TW editor writes — keeping the two write paths byte-identical is the whole
* point of v0.22.10, so writers must use this function.
*
* (Local time is deliberately NOT used: TW stores UTC and renders in the
* viewer's zone, so a local-time string would shift every displayed date.)
*/
function formatTiddlerDate(value) {
	const d = value instanceof Date ? value : new Date(value);
	const pad = (n, width = 2) => String(n).padStart(width, "0");
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}`;
}
/**
* Fill missing `created`/`modified` on a tiddler about to be PUT (v0.22.10).
*
* SAFETY NET, not the policy: `buildWriteTiddler()` owns the semantics (new
* tiddler ⇒ both = now; overwrite ⇒ keep the base `created`, refresh `modified`).
* This only guarantees the INVARIANT that every tiddler this plugin writes
* carries both fields, including the write paths that deliberately hand-build
* their PUT (clip bridge, seeds, config, `/upload`, session summary) and any
* future one.
*
* Why it matters: TW's server-side write path never stamps these fields
* (`put-tiddler.js` just does `addTiddler(new $tw.Tiddler(fields, {title}))`;
* `getCreationFields()`/`getModificationFields()` are only called by TW's own
* UI). A stored tiddler without `modified` is read by `sortTiddlers` as
* `fields[sortField] || ""`, so `!sort[modified]` sinks it to the LAST slot —
* the note looks like it was never collected.
*
* Existing values are NEVER overwritten: explicit timestamps (a trash snapshot
* copied from the original, a restore, or a caller that set them on purpose)
* must survive.
*/
function ensureTiddlerTimestamps(tiddler, now = /* @__PURE__ */ new Date()) {
	const stamp = formatTiddlerDate(now);
	const hasCreated = typeof tiddler.created === "string" && tiddler.created.trim().length > 0;
	const hasModified = typeof tiddler.modified === "string" && tiddler.modified.trim().length > 0;
	if (!hasCreated) tiddler.created = hasModified ? tiddler.modified : stamp;
	if (!hasModified) tiddler.modified = stamp;
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
/** Raised when TW's `/render` route answers 404 (unknown tiddler title).
*
*  Carries a STRUCTURAL flag instead of relying on the message text (v0.22.8):
*  `/render`'s caller (`routes.ts`) used to re-derive "not found" with
*  `/HTTP 404/.test(err.message)`, so any rewording of the message — or a 404
*  raised for another reason — turned a client-visible `notFound` into a 502.
*/
var RenderNotFoundError = class extends Error {
	notFound = true;
	constructor(message) {
		super(message);
		this.name = "RenderNotFoundError";
	}
};
var TiddlyWebClient = class TiddlyWebClient {
	baseUrl;
	/** Preemptive Basic credentials, when the wiki runs in locked-down mode. */
	authHeader;
	/**
	* Short-TTL cache for the TEXT-bearing listing. `search` / `recent` /
	* `listTags`-style calls each pull the whole listing (≈6MB on a 5k-tiddler
	* wiki); a burst of tool calls re-downloaded and re-parsed it every time.
	* Cached as a PROMISE so concurrent callers share one request, invalidated by
	* every write this client performs (v0.19.0).
	*/
	textListing;
	/**
	* Same short-TTL + in-flight-merge cache for the SKINNY listings (v0.19.1):
	* `/tags` (`list(TEXT_LIST_FILTER, false)`) and the lint title/dedup listings
	* each pull the whole title list; without a cache every `/status`-adjacent
	* poll and every lint re-downloaded + re-parsed it. Keyed by filter string
	* ('' = server default listing).
	*/
	skinnyListings = /* @__PURE__ */ new Map();
	static TEXT_LISTING_TTL_MS = 2e3;
	/** Drop the listing caches — called after any write so reads never go stale. */
	invalidateListing() {
		this.textListing = void 0;
		this.skinnyListings.clear();
	}
	constructor(baseUrl, auth) {
		this.baseUrl = baseUrl;
		const username = typeof auth?.username === "string" ? auth.username : "";
		if (username.length > 0) {
			const password = typeof auth?.password === "string" ? auth.password : "";
			this.authHeader = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
		}
	}
	async request(path, init) {
		const headers = { ...init?.headers ?? {} };
		if (this.authHeader !== void 0) headers.authorization = this.authHeader;
		return fetch(`${this.baseUrl}${path}`, {
			...init,
			headers,
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
	/**
	* Render a tiddler (or raw wiki text) to an HTML fragment through TW's own
	* `/render` server route — the bundle the `render-route` seed installs.
	*
	* READ-ONLY, but the route is a POST (handler contract) and TW's server gates
	* POST behind the writer CSRF header, so the CSRF header is sent like a write.
	* Throws on 404 (`notFound`) so callers can distinguish "no such tiddler".
	*/
	async render(body) {
		const res = await this.request("/render", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...CSRF_HEADER
			},
			body: JSON.stringify(body)
		});
		if (res.status === 404) throw new RenderNotFoundError("TiddlyWeb POST /render HTTP 404: tiddler not found");
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`TiddlyWeb POST /render HTTP ${res.status}: ${detail.slice(0, 200)}`);
		}
		return res.text();
	}
	/**
	* Write (create or overwrite) one tiddler via PUT (204 on success).
	*
	* Every write goes through here, so this is also where the timestamp INVARIANT
	* is enforced (v0.22.10): a tiddler without `modified` would be sorted as an
	* empty string by TW's `sortTiddlers` and sink to the bottom of every
	* `!sort[modified]` page. `buildWriteTiddler()` decides the real semantics
	* (keep `created` on overwrite, refresh `modified`); this only fills gaps for
	* the paths that build their PUT by hand.
	*/
	async put(tiddler) {
		ensureTiddlerTimestamps(tiddler);
		const title = tiddler.title;
		const res = await this.request(`/recipes/default/tiddlers/${encodeURIComponent(title)}`, {
			method: "PUT",
			headers: {
				"content-type": "application/json",
				...CSRF_HEADER
			},
			body: JSON.stringify(tiddler)
		});
		this.invalidateListing();
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
		this.invalidateListing();
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
		if (!includeText) {
			const key = filter ?? "";
			const cached = this.skinnyListings.get(key);
			if (cached !== void 0 && Date.now() - cached.at < TiddlyWebClient.TEXT_LISTING_TTL_MS) return cached.value;
			const pending = this.fetchListing(filter);
			this.skinnyListings.set(key, {
				at: Date.now(),
				value: pending
			});
			pending.catch(() => {
				if (this.skinnyListings.get(key)?.value === pending) this.skinnyListings.delete(key);
			});
			return pending;
		}
		if (filter !== void 0 && filter.length > 0) return this.fetchTextListing(filter, false);
		const cached = this.textListing;
		if (cached !== void 0 && Date.now() - cached.at < TiddlyWebClient.TEXT_LISTING_TTL_MS) return cached.value;
		const pending = this.fetchTextListing(TEXT_LIST_FILTER, true);
		this.textListing = {
			at: Date.now(),
			value: pending
		};
		pending.catch(() => {
			if (this.textListing?.value === pending) this.textListing = void 0;
		});
		return pending;
	}
	/**
	* Fetch a text-bearing listing for `filter`, self-healing the external-filter
	* whitelist on 403. `allowSkinnyFallback` is true only for the plugin's OWN
	* default filter (TEXT_LIST_FILTER), where degrading to the skinny listing is
	* a documented last resort on a read-only wiki; an explicit caller filter
	* propagates the 403 instead.
	*/
	async fetchTextListing(filter, allowSkinnyFallback) {
		let res = await this.requestListWithText(filter);
		if (res.status === 403) {
			await this.ensureExternalFilterWhitelist(filter).catch(() => void 0);
			res = await this.requestListWithText(filter);
		}
		if (res.status === 403) {
			if (allowSkinnyFallback) return this.fetchListing(void 0);
			throw new Error(`TiddlyWeb 拒绝该 filter（未在 $:/config/Server/ExternalFilters 白名单中）：${filter.slice(0, 100)}`);
		}
		if (!res.ok) throw new Error(`TiddlyWeb recipe list HTTP ${res.status}`);
		return this.parseList(res);
	}
	/** GET the recipe listing WITHOUT text payloads (server default excludes `text`). */
	async fetchListing(filter) {
		const params = new URLSearchParams();
		if (filter !== void 0 && filter.length > 0) params.set("filter", filter);
		const query = params.toString();
		let res = await this.request(`/recipes/default/tiddlers.json${query.length > 0 ? `?${query}` : ""}`);
		if (!res.ok && res.status === 403 && filter !== void 0 && filter.length > 0) {
			await this.ensureExternalFilterWhitelist(filter).catch(() => void 0);
			res = await this.request(`/recipes/default/tiddlers.json?${query}`);
			if (!res.ok && res.status === 403) throw new Error(`TiddlyWeb 拒绝该 filter（未在 $:/config/Server/ExternalFilters 白名单中）：${filter.slice(0, 100)}`);
		}
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
	* Search text-bearing tiddlers: one request (text-bearing listing with text,
	* short-TTL cached) plus local case-insensitive substring matching on title,
	* tags and text, optional exact tags (AND), a `since` modified-time floor, an
	* exact `type`, an exact custom `field`+`value` pair, and a `limit`.
	*
	* Results are RANKED (title hit > tag hit > body hit count, then newest
	* first) rather than returned in listing order, and `limit` is clamped to
	* 1…200 like the HTTP route always did (v0.19.0). Binary tiddlers are not in
	* the listing at all, so they can never flood the results.
	*
	* v0.24.0 — MULTI-TERM: the query is split on whitespace and EVERY term must
	* match somewhere (title / tags / body), i.e. AND. Before this the whole
	* string was one substring needle, so `"书籍 索引"` looked for the literal
	* `书籍 索引` (with the space) and returned 0 hits while each word matched
	* dozens — a query shape every model produces naturally, and one that reads
	* as "the knowledge base is empty" rather than as a syntax error.
	*/
	async search(query, options = {}) {
		const items = await this.list(void 0, true);
		const terms = query.split(/\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
		if (terms.length === 0) return {
			items: [],
			total: 0
		};
		const sinceTime = parseSince(options.since);
		const wantedTags = [...options.tags ?? [], options.tag].filter((t) => typeof t === "string" && t.trim().length > 0);
		const limit = clampLimit(options.limit, 30);
		const fieldName = typeof options.field === "string" && options.field.length > 0 ? options.field : void 0;
		const fieldValue = typeof options.value === "string" ? options.value : void 0;
		const matched = [];
		for (const t of items) {
			if (t.title.startsWith("$:/")) continue;
			const lowerTitle = t.title.toLowerCase();
			const lowerTags = (t.tags ?? []).map((tag) => tag.toLowerCase());
			const lowerText = (t.text ?? "").toLowerCase();
			let score = 0;
			let allTerms = true;
			for (const term of terms) {
				const inTitle = lowerTitle.includes(term);
				const inTags = lowerTags.some((tag) => tag.includes(term));
				const occurrences = countOccurrences(lowerText, term);
				if (!inTitle && !inTags && occurrences === 0) {
					allTerms = false;
					break;
				}
				if (inTitle) score += 6;
				if (inTags) score += 3;
				score += Math.min(occurrences, 5);
			}
			if (!allTerms) continue;
			if (sinceTime !== void 0) {
				const modified = parseTiddlerDate(t.modified);
				if (modified === void 0 || modified < sinceTime) continue;
			}
			if (options.type !== void 0 && options.type.length > 0 && (t.type ?? "text/vnd.tiddlywiki") !== options.type) continue;
			if (wantedTags.length > 0) {
				if (!wantedTags.every((w) => lowerTags.includes(w.toLowerCase()))) continue;
			}
			if (fieldName !== void 0) {
				const actual = t[fieldName];
				if (typeof actual !== "string") continue;
				if (fieldValue !== void 0 && actual !== fieldValue) continue;
			}
			matched.push({
				t,
				score
			});
		}
		matched.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return modifiedAt(b.t) - modifiedAt(a.t);
		});
		return {
			items: matched.slice(0, limit).map((entry) => entry.t),
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
				const modified = parseTiddlerDate(t.modified);
				if (modified === void 0 || modified < sinceTime) return false;
			}
			return true;
		});
		filtered.sort((a, b) => modifiedAt(b) - modifiedAt(a));
		return filtered.slice(0, Math.max(1, Math.min(limit, 200)));
	}
	/** Full tag vocabulary + its size, so callers that cap can still report the
	*  total ("showing 200 of N") — one listing request either way. */
	async tagStats() {
		const items = await this.list(TEXT_LIST_FILTER, false);
		const map = /* @__PURE__ */ new Map();
		for (const t of items) {
			if (t.title.startsWith("$:/")) continue;
			for (const tag of t.tags ?? []) {
				if (tag.startsWith("$:/")) continue;
				map.set(tag, (map.get(tag) ?? 0) + 1);
			}
		}
		const tags = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh")).map(([tag, count]) => ({
			tag,
			count
		}));
		return {
			total: tags.length,
			tags
		};
	}
};
/** Clamp a caller-supplied limit into 1…200 (default when absent/invalid).
*  Module-private (v0.22.8): its only caller is `search()` above, and the HTTP
*  route has its own (param-parsing) clamp — exporting it invited a third copy. */
function clampLimit(limit, fallback) {
	return Math.max(1, Math.min(typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : fallback, 200));
}
/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
	if (needle.length === 0) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count++;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}
/** `modified` as epoch ms (0 when absent/unparseable) — for result ranking. */
function modifiedAt(tiddler) {
	return parseTiddlerDate(tiddler.modified) ?? 0;
}
/** Parse a `since` value into an epoch ms, or undefined when absent/invalid. */
function parseSince(since) {
	if (typeof since !== "string" || since.trim().length === 0) return void 0;
	const ms = new Date(since.trim()).getTime();
	return Number.isNaN(ms) ? void 0 : ms;
}
//#endregion
//#region src/host/ready-policy.ts
/**
* TiddlyWiki child readiness policy (v0.22.5).
*
* WHY THIS MODULE EXISTS — the production incident it fixes:
* a 5000-tiddler / 26MB wiki on a cold file cache needed ~44s from `spawn` to
* TW's own "Serving on http://127.0.0.1:…" line (verified from the /status ring
* buffer: spawn 01:43:51 → first stdout 01:44:35). The old code had a single
* hard 20s deadline, so it threw `wiki server did not become ready in time`,
* which:
*   1. aborted the whole startup pipeline (config load / seeds / clip bridge)
*      even though the wiki WAS coming up;
*   2. wrote `health = 'failed'` + a sticky error that nothing ever cleared —
*      no one re-probed after the deadline, so `/status` (panel, FAB, tooltip)
*      kept reporting a fault while TW served normally.
*
* The policy is now three-staged:
*   soft window  (default 60s, configurable 5s–600s) — ONE warning, keep waiting;
*   hard window  (3× the soft window)                — the attempt fails;
*   late watch   (see wiki.ts)                       — a live child that answers
*                                                      later still clears the fault.
*
* The loop is deliberately pure: `probe` / `isAlive` / clock / `sleep` are all
* injected, so `scripts/verify-ready-policy.mjs` drives it with a virtual clock
* (no real TW, no wall-clock flakiness).
*
* @module dsh-tiddlywiki/host/ready-policy
*/
/** Default soft readiness window: a slow boot only warns, it does not fail. */
const READY_TIMEOUT_DEFAULT_MS = 6e4;
/** Lower bound accepted from config (below this a big wiki would still be flaky). */
const READY_TIMEOUT_MIN_MS = 5e3;
/** Upper bound accepted from config. */
const READY_TIMEOUT_MAX_MS = 6e5;
/** Hard window = soft × this factor; only then is the attempt declared failed. */
const READY_HARD_FACTOR = 3;
/** Poll cadence while inside the soft window. */
const READY_POLL_MS = 500;
/** Slower cadence once the soft window passed (a slow boot needs patience, not 2 Hz). */
const READY_SLOW_POLL_MS = 2e3;
/**
* Normalize a configured readiness window. Anything non-finite / non-positive
* falls back to the default; the result is clamped into [MIN, MAX] so a typo in
* the settings page can neither fail at 0ms nor hold startup for hours.
*/
function normalizeReadyTimeoutMs(value) {
	return Math.min(READY_TIMEOUT_MAX_MS, Math.max(READY_TIMEOUT_MIN_MS, typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : READY_TIMEOUT_DEFAULT_MS));
}
/** The hard deadline derived from a (possibly unnormalized) soft window. */
function readyHardTimeoutMs(softMs) {
	return normalizeReadyTimeoutMs(softMs) * 3;
}
/**
* Poll until the child answers, exits, or the hard deadline passes.
*
* Returns instead of throwing so the caller owns the health/error bookkeeping;
* a probe that rejects counts as "not ready yet" (TW closes the socket while it
* is still loading, and that is not an error).
*/
async function awaitReady(deps) {
	const now = deps.now ?? (() => Date.now());
	const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const soft = normalizeReadyTimeoutMs(deps.softTimeoutMs);
	const hard = soft * 3;
	const startedAt = now();
	let warned = false;
	for (;;) {
		if (!deps.isAlive()) return "exited";
		let ok = false;
		try {
			ok = await deps.probe();
		} catch {
			ok = false;
		}
		if (ok) return "ready";
		const elapsed = now() - startedAt;
		if (!warned && elapsed >= soft) {
			warned = true;
			deps.onSlow?.(elapsed, hard);
		}
		if (elapsed >= hard) return "timeout";
		await sleep(elapsed >= soft ? READY_SLOW_POLL_MS : 500);
	}
}
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
/** Late-ready watch: cadence and lifetime after the hard deadline passed. */
const LATE_READY_POLL_MS = 5e3;
/** How long the late-ready watch keeps probing a child that outlived the deadline. */
const LATE_READY_WINDOW_MS = 10 * 6e4;
/** Backoff ceiling for crash restarts. */
const MAX_RESTART_BACKOFF_MS = 3e4;
/** SIGTERM → SIGKILL escalation grace. */
const KILL_GRACE_MS = 3e3;
/** Ring-buffer cap for the stdout/stderr log. */
const LOG_BUFFER_LIMIT = 200;
/** One-shot scaffold timeout for `--init server`. */
const INIT_TIMEOUT_MS = 3e4;
/**
* `anon-username` for the anonymous loopback spawn (v0.22.9).
*
* This MUST stay the literal `"GUEST"`. TW's TiddlyWeb adaptor derives its
* login flag as `json.username !== "GUEST"` (tiddlywebadaptor.js:93), so any
* other value — including any real person's name — still reports as logged in,
* and syncer.js then overwrites `$:/status/UserName` with whatever `/status`
* returns. Only this sentinel makes the syncer leave the user's signature
* alone. Exported so the regression gate asserts the exact string instead of
* re-typing it.
*/
const ANON_USERNAME = "GUEST";
/** Resolve the absolute entry of the installed `tiddlywiki` package. */
function resolveTwEntry() {
	return createRequire(import.meta.url).resolve("tiddlywiki/tiddlywiki.js");
}
var WikiServer = class {
	options;
	child;
	/**
	* The wiki folder this server currently serves. MUTABLE since v0.22.0: a
	* runtime switch calls {@link setLocation} while the child is stopped.
	*/
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
	/** In-flight start() promise: single-flight guard (v0.19.0). */
	startPromise;
	/** In-flight restart(): two concurrent restarts must not spawn two children (v0.19.1). */
	restartPromise;
	/** Set by a successful readiness probe; a crash BEFORE readiness means the
	*  auto-chosen port may have been taken, so it is re-probed on restart. */
	wasReady = false;
	/** Soft readiness window (ms, default 60s) — runtime-editable via {@link setReadyTimeout}. */
	readyTimeoutMs;
	/** Pending tick of the late-ready watch (v0.22.5), unref'ed. */
	lateReadyTimer;
	/** End timestamp of the armed late-ready watch (undefined = not armed). */
	lateReadyWatchUntil;
	constructor(options) {
		this.options = options;
		this.wikiPath = resolve(options.wikiRoot, options.wiki);
		this.location = {
			root: options.wikiRoot,
			name: options.wiki
		};
		this.logLimit = options.logBufferLimit ?? LOG_BUFFER_LIMIT;
		this.readyTimeoutMs = normalizeReadyTimeoutMs(options.readyTimeoutMs);
	}
	/**
	* The wiki folder this server currently serves (v0.22.0: mutable — a runtime
	* switch calls {@link setLocation} while the child is stopped).
	*/
	/** Last location applied through {@link setLocation} / the constructor. */
	location;
	/** Current location (root + folder name), for the settings page. */
	get currentLocation() {
		return { ...this.location };
	}
	/**
	* Point this server at a DIFFERENT wiki folder (runtime switch, v0.22.0).
	*
	* Refuses while a child is running: a switch that forgot the folder while the
	* old process still served it would leave `/status`, the REST client and the
	* git face describing two different wikis. Callers stop() first (see
	* `switchWiki()` in host/wiki-switch.ts), then start() again.
	*
	* The bound port is INTENTIONALLY kept: reusing it across a switch keeps the
	* iframe src and the cached REST client valid (same reasoning as restart()).
	*/
	setLocation(location) {
		if (this.child !== void 0) throw new Error("wiki 必须先在停止状态下才能切换位置");
		const next = resolve(location.root, location.name);
		if (next === this.wikiPath) {
			this.location = {
				root: location.root,
				name: location.name
			};
			return;
		}
		this.location = {
			root: location.root,
			name: location.name
		};
		this.wikiPath = next;
		this.wasReady = false;
		this.error = void 0;
		if (this.child === void 0) this.health = "stopped";
		this.log(`location → ${next}`);
	}
	/** Base URL of the TW service, once a port is bound (root, no path prefix). */
	get url() {
		return this.port === void 0 ? void 0 : `http://127.0.0.1:${this.port}`;
	}
	/**
	* Update the readiness window (v0.22.5).
	*
	* Applies to the NEXT start()/restart(): the settings page saves
	* `startup.readyTimeoutMs` and the host calls this on every config change, so
	* a user with an even slower wiki can raise it without restarting dsh web.
	* Values are clamped by ready-policy.ts (5s–600s; anything invalid → default).
	*/
	setReadyTimeout(value) {
		const next = normalizeReadyTimeoutMs(value);
		if (next === this.readyTimeoutMs) return;
		this.readyTimeoutMs = next;
		this.log(`ready timeout → ${next}ms (hard deadline ${readyHardTimeoutMs(next)}ms)`);
	}
	/** The soft readiness window currently in effect (settings page / diagnostics). */
	get currentReadyTimeoutMs() {
		return this.readyTimeoutMs;
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
	*
	* SINGLE-FLIGHT (v0.19.0): two concurrent callers (double restart click, a
	* restart racing the self-heal timer) both used to pass the
	* `child !== undefined` check, probe their own port and spawn a child each —
	* the loser became an orphan process holding a port until dsh web exited.
	*/
	async start() {
		if (this.startPromise !== void 0) return this.startPromise;
		const run = this.startOnce();
		this.startPromise = run;
		try {
			return await run;
		} finally {
			this.startPromise = void 0;
		}
	}
	async startOnce() {
		this.stopping = false;
		this.restartDelay = 1e3;
		this.clearLateReadyWatch();
		this.error = void 0;
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
		} else args.push(`anon-username=${ANON_USERNAME}`);
		if (this.stopping) {
			this.log("start aborted: stop() was requested while resolving the port");
			return this.status();
		}
		this.log(`spawn: ${process.execPath} ${args.map((a) => /^password=/.test(a) ? "password=***" : a).join(" ")}`);
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
			if (this.child !== child) {
				this.log(`exit code=${code} signal=${signal ?? ""} (superseded child — ignored)`);
				return;
			}
			this.log(`exit code=${code} signal=${signal ?? ""} stopping=${this.stopping}`);
			this.child = void 0;
			this.health = "stopped";
			if (!this.stopping) {
				if (this.options.port === 0 && !this.wasReady) this.port = void 0;
				this.scheduleRestart();
			}
		});
		child.once("error", (err) => {
			this.log(`spawn error: ${err.message}`);
			this.error = err.message;
			if (this.child !== child) return;
			this.child = void 0;
			this.health = "failed";
			if (!this.stopping) this.scheduleRestart();
		});
		this.lastStartedAt = Date.now();
		this.wasReady = false;
		await this.waitReady();
		return this.status();
	}
	/**
	* Preemptive Basic header for the readiness probe. Locked-down mode
	* (`username` configured) puts /status behind TW's `readers` list: an
	* anonymous probe gets 401 forever and the wiki would never be reported
	* ready. Shared with the late-ready watch below.
	*/
	authHeaders() {
		if (this.options.username === void 0 || this.options.username.length === 0) return void 0;
		return { authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password ?? ""}`, "utf8").toString("base64")}` };
	}
	/** One /status probe: true = 200 OK. Never throws (a refused socket while TW
	*  is still loading is "not ready yet", not an error). */
	async probeStatus(headers) {
		if (this.port === void 0) return false;
		try {
			return (await fetch(`http://127.0.0.1:${this.port}/status`, {
				signal: AbortSignal.timeout(2e3),
				...headers !== void 0 ? { headers } : {}
			})).ok;
		} catch {
			return false;
		}
	}
	/**
	* Wait for readiness (v0.22.5 policy, see ready-policy.ts).
	*
	* Throws only when the child EXITED before ready, or when the HARD deadline
	* (3× the soft window) passed with the child still silent. Passing the soft
	* window is a warning, not a verdict: a 5000-tiddler wiki can legitimately
	* need 40s+ on a cold cache, and failing there aborted seeding/config/clip
	* bridge for a wiki that was about to serve. On a hard timeout the child is
	* LEFT RUNNING and a bounded late-ready watch is armed, so `/status` stops
	* reporting a fault the moment TW really answers.
	*/
	async waitReady() {
		const headers = this.authHeaders();
		const outcome = await awaitReady({
			probe: () => this.probeStatus(headers),
			isAlive: () => this.child !== void 0,
			softTimeoutMs: this.readyTimeoutMs,
			onSlow: (elapsedMs, hardTimeoutMs) => {
				this.health = "starting";
				this.error = void 0;
				this.log(`slow start: /status not ready after ${Math.round(elapsedMs / 1e3)}s — still loading (hard deadline ${Math.round(hardTimeoutMs / 1e3)}s)`);
			}
		});
		if (outcome === "ready") {
			this.health = "running";
			this.wasReady = true;
			this.error = void 0;
			this.log("ready: /status 200");
			return;
		}
		if (outcome === "timeout") {
			const hard = readyHardTimeoutMs(this.readyTimeoutMs);
			this.health = "failed";
			this.error = `wiki server did not become ready in time (${Math.round(hard / 1e3)}s)`;
			this.log(this.error);
			this.armLateReadyWatch();
			throw new Error(this.error);
		}
		throw new Error("wiki process exited before ready");
	}
	/**
	* Keep a low-frequency probe on a child that outlived the readiness deadline
	* (v0.22.5). Bounded and `unref`ed (never holds the process open); cancelled
	* by stop() and superseded by the next start(). It only ever PROMOTES the
	* status — it never spawns, kills, or writes anything.
	*/
	armLateReadyWatch() {
		const child = this.child;
		if (child === void 0 || this.stopping || this.lateReadyTimer !== void 0 || this.lateReadyWatchUntil !== void 0) return;
		const deadline = Date.now() + LATE_READY_WINDOW_MS;
		this.lateReadyWatchUntil = deadline;
		const headers = this.authHeaders();
		this.log(`late-ready watch armed (up to ${Math.round(LATE_READY_WINDOW_MS / 6e4)}min)`);
		const tick = async () => {
			this.lateReadyTimer = void 0;
			if (this.stopping || this.child !== child || this.health === "running") {
				this.lateReadyWatchUntil = void 0;
				return;
			}
			if (await this.probeStatus(headers)) {
				this.health = "running";
				this.wasReady = true;
				this.error = void 0;
				this.lateReadyWatchUntil = void 0;
				this.log("ready (late): /status 200 — cleared the stale startup failure");
				return;
			}
			if (Date.now() >= deadline) {
				this.lateReadyWatchUntil = void 0;
				this.log("late-ready watch gave up (child never answered /status)");
				return;
			}
			this.lateReadyTimer = setTimeout(() => {
				tick();
			}, LATE_READY_POLL_MS);
			this.lateReadyTimer.unref?.();
		};
		this.lateReadyTimer = setTimeout(() => {
			tick();
		}, LATE_READY_POLL_MS);
		this.lateReadyTimer.unref?.();
	}
	/** Cancel a pending late-ready watch (stop / new attempt / teardown). */
	clearLateReadyWatch() {
		if (this.lateReadyTimer !== void 0) {
			clearTimeout(this.lateReadyTimer);
			this.lateReadyTimer = void 0;
		}
		this.lateReadyWatchUntil = void 0;
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
	/**
	* One-click restart (routes `/restart`, `/sync`, every `/admin/*` restart).
	*
	* SINGLE-FLIGHT (v0.19.1): the route-level mutex in routes.ts could not cover
	* the admin routes (separate closure), so two concurrent restarts — a double
	* click, or `/restart` racing `/admin/seeds/run` — used to run `stop()` twice
	* and spawn two children; the loser became an orphan process holding a port
	* until dsh web exited. Serializing here fixes every caller at once.
	*/
	async restart() {
		if (this.restartPromise !== void 0) return this.restartPromise;
		const run = (async () => {
			await this.stop();
			return this.start();
		})();
		this.restartPromise = run;
		try {
			return await run;
		} finally {
			this.restartPromise = void 0;
		}
	}
	/** Deterministic teardown: cancel timers, SIGTERM, escalate to SIGKILL. */
	async stop() {
		this.stopping = true;
		if (this.restartTimer !== void 0) {
			clearTimeout(this.restartTimer);
			this.restartTimer = void 0;
		}
		this.clearLateReadyWatch();
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
			if (child.exitCode === null && child.signalCode === null) await Promise.race([new Promise((r) => child.once("exit", () => r())), new Promise((r) => {
				setTimeout(r, 1e3).unref?.();
			})]);
		}
		if (this.child === void 0) this.health = "stopped";
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
//#region src/host/text-util.ts
/**
* Small text/date helpers shared by the host modules (v0.20.0, extended v0.22.8).
*
* `snippetOf` used to exist as two identical private copies (tools.ts for the
* `tiddlywiki_recent` render, routes.ts for the quick-note/recent/search JSON)
* with two different default widths — a drift waiting to happen.
*
* v0.22.8 added `formatLocalMinute`: the note/draft title builder (routes.ts)
* and the session-summary page builder (session-summary.ts) each formatted the
* same `YYYY-MM-DD HH:mm` shape by hand — the PARSE half of this contract is
* already centralised in `parseTiddlerDate`, so the format half belongs here too.
*
* @module dsh-tiddlywiki/host/text-util
*/
/** Flat one-line snippet: whitespace collapsed, truncated with an ellipsis. */
function snippetOf(text, max = 160) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
/**
* Local `YYYY-MM-DD HH:mm` for a Date or an epoch-ms value.
*
* Two-digit zero padding is deliberate (that is the shape both callers already
* emitted, and it is what the wiki's own title convention uses). An invalid
* Date / non-finite number yields `''` rather than `NaN-NaN-…`.
*/
function formatLocalMinute(value) {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (n) => n < 10 ? `0${n}` : String(n);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
//#endregion
//#region src/host/session-summary.ts
/**
* 会话相关 wiki 汇总（会话顶部「知识库」Tab 的后端）——把一次 DSH 会话（含其后代
* subagent）在本会话中产生 / 读取 / 检索过的 wiki 笔记汇总成一篇 TW wikitext，写入
* TW 的 volatile 命名空间 `$:/temp/dsh/session-summary/<会话ID>`。
*
* 判定来源（设计定稿，探查验证）：
* - Host 服务 `sessionQuery`（可选注入）：`readSession(sessionId)` 返回完整事件日志
*   （events 升序），`traceSession` 返回祖先/后代树。绝不直接解析
*   `~/.dsh/sessions` 目录下的 session 文件——那是 zstd 压缩的。
* - `tool/call` 事件精确记录每次 `tiddlywiki_*` 调用的 `name` 与
*   `arguments`（JSON 字符串）。
* - `assistant/message` 事件 `message.content` 的 text 块可扫
*   `/dsh-tiddlywiki/tw/#...` 引用链接（视为「读取」）。
*
* 归类规则（§三 定稿）：
*   产生 📝 tiddlywiki_put / batch_put / rename（arguments 取 title）
*   读取 👀 tiddlywiki_get（title）+ 助手回复里的 wiki 引用链接
*   检索 🔍 search / recent（记关键词，不算单篇）
*   范围   本会话 + 后代 subagent（traceSession 递归，仅子代理触达的笔记标注）
*
* 渲染（§四）：写入 `$:/temp/...`——TW 5.4.1 默认 `$:/config/SyncFilter` 显式
* `-[prefix[$:/temp/]]`（core/wiki/config/SyncFilter.tid），服务端 syncer 从不把
* $:/temp 落盘：内存态、不进 git、TW 重启即消失（已实测：PUT 204、tiddlers/ 无文件、
* git clean）。TW 用自己主题/链接/导航原生渲染，不另造 UI。
*
* @module dsh-tiddlywiki/host/session-summary
*/
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
/**
* Bounds so one enormous session tree cannot make the「知识库」Tab unresponsive:
* the summary reads every listed session's FULL event log and then probes each
* touched tiddler over REST.
*/
const MAX_SESSIONS = 40;
const MAX_SEARCH_RECORDS = 200;
const MAX_ENRICH_TITLES = 300;
/** 递归收集后代树里所有 session id（不含根自身，超过上限即停）。 */
function collectDescendantIds(nodes, out) {
	if (!Array.isArray(nodes)) return;
	for (const node of nodes) {
		if (out.length >= MAX_SESSIONS) return;
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
							detail: old !== void 0 && isPlausibleTitle(old) ? `重命名自「${old}」` : void 0,
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
					if (collected.searches.length >= MAX_SEARCH_RECORDS) break;
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
					if (collected.searches.length < MAX_SEARCH_RECORDS) collected.searches.push({
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
/**
* 内联文本净化（v0.19.3）：汇总 wikitext 会被 TW 渲染成 HTML 片段再注入 DSH 页面，
* 而 TW 的解析器**原样透传 HTML**。凡是来自会话日志/请求体的字符串（sessionId、
* rename 的旧标题、检索词）都要先转义 HTML 元字符并去掉控制字符，别指望上层净化。
*/
function escapeInline(text, max = 200) {
	return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[[\]|]/g, " ").slice(0, max);
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
				tags: [],
				unknown: true
			}];
		}
	};
	for (let i = 0; i < titles.length; i += 8) {
		const batch = titles.slice(i, i + 8);
		for (const [title, state] of await Promise.all(batch.map(enquire))) out.set(title, state);
	}
	return out;
}
/** epoch ms → 本地 `YYYY-MM-DD HH:mm`（与 routes.ts 的 timestampTitle 共用一份实现）。 */
function fmtTime(ms) {
	return formatLocalMinute(ms);
}
/**
* TW `modified` → 本地时间（解析失败则原样返回）。
*
* v0.20.0: the REST layer returns the COMPACT form (`20260101000000000`,
* YYYYMMDDhhmmssSSS UTC), which `Date.parse()` rejects with NaN — the summary
* therefore printed the raw 17-digit string. `parseTiddlerDate` handles both
* the compact and the ISO form (same rule as the rest of the host).
*/
function fmtModified(value) {
	if (value === void 0 || value.length === 0) return "";
	const ms = parseTiddlerDate(value);
	return ms === void 0 ? value : fmtTime(ms);
}
/** 组装分组 wikitext：产生 / 读取（未产生过的）/ 检索记录。 */
function buildWikitext(sessionId, collected, producedTitles, readTitles, stateByTitle) {
	const lines = [];
	lines.push("! 会话相关 wiki 汇总");
	lines.push("");
	lines.push(`本页列出会话 \`${escapeInline(sessionId, 120)}\`（含其后代子代理）在本会话中产生 / 读取 / 检索过的知识库笔记。`);
	lines.push("");
	const producedCount = producedTitles.length;
	const readCount = readTitles.length;
	const searchCount = collected.searches.length;
	const anySubagent = [...collected.produced.values()].some((e) => e.subagent) || [...collected.read.values()].some((e) => e.subagent) || collected.searches.some((s) => s.subagent);
	if (producedCount + readCount + searchCount === 0) {
		lines.push("> 本会话暂时没有产生、读取或检索过任何知识库笔记。");
		lines.push(">");
		lines.push("> 本页为会话自动生成的临时汇总（`$:/temp`，不落盘、不进 git，重启 TW 即消失）；需要时点 Tab 顶栏的「🔄 刷新」重新生成。");
		return lines.join("\n");
	}
	lines.push("| 产生 📝 | 读取 👀 | 检索 🔍 | 涉及会话 |", "| --- | --- | --- | --- |", `| ${producedCount} | ${readCount} | ${searchCount} | ${anySubagent ? "本会话 + 子代理" : "本会话"} |`);
	lines.push("");
	const entryLine = (title, state, entry) => {
		const bits = [`[[${title}]]`];
		if (state === void 0) bits.push("（未探测，超出单次查询上限）");
		else if (state.unknown === true) bits.push("⚠️ 状态未知（查询失败）");
		else if (!state.exists) bits.push("⚠️ 已删除/不存在");
		else {
			if (state.tags.length > 0) bits.push(`标签 ${state.tags.slice(0, 6).map((tag) => escapeInline(tag, 40)).join("、")}${state.tags.length > 6 ? "…" : ""}`);
			const mod = fmtModified(state.modified);
			if (mod.length > 0) bits.push(`修改 ${mod}`);
		}
		const t = fmtTime(entry.time);
		if (t.length > 0) bits.push(`会话内 ${t}`);
		if (entry.detail !== void 0) bits.push(escapeInline(entry.detail, 200));
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
				bits.push(`\`tiddlywiki_search\` query=「${r.query.length > 0 ? escapeInline(r.query, 120) : "(空)"}」`);
				if (r.tags.length > 0) bits.push(`tags ${r.tags.map((tag) => escapeInline(tag, 40)).join("、")}`);
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
	const text = buildWikitext(sessionId, collected, producedTitles, readTitles, await enrichTitles(client, [.../* @__PURE__ */ new Set([...producedTitles, ...readTitles])].slice(0, MAX_ENRICH_TITLES)));
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
/**
* Constant-time string comparison for shared tokens: both sides are hashed
* first, so neither the content nor the LENGTH of the expected token leaks
* through timing (v0.19.0). One implementation for every caller — routes.ts
* and clip-bridge.ts each carried a private copy (v0.20.0).
*/
function safeTokenEqual(a, b) {
	return timingSafeEqual(createHash("sha256").update(a, "utf8").digest(), createHash("sha256").update(b, "utf8").digest());
}
/** Default cap for small JSON bodies (note/restart/config…). */
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
/** Cap for the /api passthrough body (tiddler content can be large). */
const MAX_PROXY_BODY_BYTES = 16 * 1024 * 1024;
/** Cap for uploaded file bodies (/tw proxy, /upload). */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
function readBodyStream(req, limit, encoding) {
	return new Promise((resolveP, rejectP) => {
		let size = 0;
		let settled = false;
		const chunks = [];
		const fail = (err) => {
			if (settled) return;
			settled = true;
			rejectP(err);
		};
		const succeed = (value) => {
			if (settled) return;
			settled = true;
			resolveP(value);
		};
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				fail(/* @__PURE__ */ new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			const buf = Buffer.concat(chunks);
			succeed(encoding ? buf.toString("utf8") : buf);
		});
		req.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
		req.on("aborted", () => fail(/* @__PURE__ */ new Error("request aborted before the body was fully received")));
		req.on("close", () => {
			if (!req.readableEnded) fail(/* @__PURE__ */ new Error("request closed before the body was read"));
		});
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
/**
* Map a thrown error to an HTTP status. Oversized bodies are a client problem
* (413), everything else is ours (500) — the routes used to answer 500 for
* `/note` and `/admin/*` but 413 for `/upload` for the identical condition.
*/
function errorStatus(err) {
	const message = err instanceof Error ? err.message : String(err);
	return /body too large/i.test(message) ? 413 : 500;
}
/**
* Wrap an async route handler so a rejected promise can never become an
* unhandled rejection (v0.19.3).
*
* WHY: every registration used to be `void handleX(req, res)`, and the host
* installs no `unhandledRejection` handler — Node's default policy then EXITS
* the whole dsh web process, while the client request hangs with no response.
* A handler that throws (including a sync throw before its own try block, e.g.
* `new URL(req.url)` outside the try in the proxies) now always ends in a
* response: 413/500 JSON, or a bare `end()` when headers are already sent.
*/
function guardHandler(handler) {
	return (req, res) => {
		handler(req, res).catch((err) => {
			try {
				if (!res.headersSent) json(res, {
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				}, errorStatus(err));
				else res.end();
			} catch {}
		});
	};
}
/**
* True when a NON-GET/HEAD/OPTIONS request is a cross-site (CSRF) request.
*
* Every legitimate caller of these routes is same-origin: the DSH GUI, the
* embedded TW (served through the `/tw` proxy), and the TW-side "发送给 Agent"
* button all run on the DSH origin. A page from another site can still fire a
* simple request at a loopback/LAN-reachable DSH, and the browser tags it with
* `Origin` / `Sec-Fetch-Site` — which is what we reject here.
*
* Only WRITES are checked: a cross-site navigation (Sec-Fetch-Site
* `cross-site`) must still be able to open `/tw/` in a new tab, and cross-site
* GETs cannot read the response (no CORS headers) so they cannot exfiltrate.
* Requests that carry neither header (curl, server-to-server, old browsers)
* are allowed on purpose: this is CSRF hardening, NOT an auth boundary — the
* host's own auth is what protects a network-exposed DSH.
*/
function isCrossSiteWrite(req) {
	const method = (req.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
	const siteHeader = req.headers["sec-fetch-site"];
	if ((typeof siteHeader === "string" ? siteHeader.toLowerCase() : Array.isArray(siteHeader) ? String(siteHeader[0] ?? "").toLowerCase() : "") === "cross-site") return true;
	const originHeader = req.headers.origin;
	const origin = typeof originHeader === "string" ? originHeader : Array.isArray(originHeader) ? String(originHeader[0] ?? "") : "";
	if (origin.length === 0) return false;
	if (origin === "null") return true;
	const host = req.headers.host;
	if (typeof host !== "string" || host.length === 0) return false;
	try {
		return new URL(origin).host.toLowerCase() !== host.toLowerCase();
	} catch {
		return true;
	}
}
/**
* Guard for a route handler: enforces the expected HTTP method(s), then the
* CSRF check for writes. Returns true after writing the error response — the
* caller just does `if (rejectCrossSiteWrite(req, res, ['POST'])) return`.
*
* WHY the method check is mandatory (v0.19.0): the host webserver dispatches
* routes by PATHNAME ONLY (dsh-host-webserver matches `rawPath` and calls the
* handler, no method filter), and `isCrossSiteWrite` deliberately IGNORES
* read methods. Together that meant `GET /dsh-tiddlywiki/sync` ran a
* pull+commit+push, `GET /restart` restarted the TW child and `GET /upload`
* wrote a file — all reachable from any web page with a bare
* `<img src="http://127.0.0.1:3080/dsh-tiddlywiki/sync">`, since browsers send
* no Origin/Sec-Fetch-Site that we would reject on a GET. Declaring the method
* per route closes that class: a cross-site GET now gets 405 and no effect.
*
* @param allowedMethods when given, any other method → 405 (no side effect).
*/
function rejectCrossSiteWrite(req, res, allowedMethods) {
	const method = (req.method ?? "GET").toUpperCase();
	if (allowedMethods !== void 0 && !allowedMethods.includes(method)) {
		res.writeHead(405, {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			allow: [...allowedMethods, "OPTIONS"].join(", ")
		});
		res.end(JSON.stringify({
			ok: false,
			error: `method not allowed: ${method}`
		}));
		return true;
	}
	if (!isCrossSiteWrite(req)) return false;
	json(res, {
		ok: false,
		error: "cross-site request rejected"
	}, 403);
	return true;
}
/** Read-only route guard: GET/HEAD only, no side effects on any other method. */
function rejectNonRead(req, res) {
	return rejectCrossSiteWrite(req, res, ["GET", "HEAD"]);
}
//#endregion
//#region src/host/sanitize.ts
/**
* TiddlyWiki 渲染片段的白名单净化器（v0.19.1，安全）。
*
* 背景：`/render` 把 tiddler 正文渲染成 HTML 片段，客户端（回复流工具卡 +
* 会话「知识库」Tab）用 `dangerouslySetInnerHTML` 注入 **DSH 同源页面**。
* TW 的 wikitext/markdown 解析器只剥 `on*` 事件属性（`<script>` 会变成
* `<safe-script>`），但 `<iframe src="javascript:…">`、`<a href="javascript:…">`、
* `<form action="javascript:…">` 之类会**原样通过**（headless 实测）——一段
* 写进 wiki 的正文就能在 DSH 页面里执行脚本（可调 `/dsh-tiddlywiki/*` 管理路由）。
*
* 因此所有要注入 DSH 页面的 TW 片段都必须先过这里。策略是**白名单 + 丢弃**，
* 不是黑名单补丁：
*   - 丢掉整棵子树：script/style/iframe/frame/frameset/object/applet/form/
*     base/meta/link/noscript/template/svg/math/xmp/plaintext/listing/
*     basefont/bgsound/title；
*   - 丢掉任何 `on*` 属性、`srcdoc`、`srcset`；
*   - URL 属性（href/src/xlink:href/action/poster/data/…）只允许
*     http/https/mailto/tel、相对路径/锚点，以及栅格 `data:image/*`
*     （`data:image/svg+xml` 与 `data:text/html` 一律拒绝）；
*   - 属性值先做实体解码 + 去控制符再判 scheme，挡住 `&#106;avascript:`、
*     `java\tscript:` 这类混淆；
*   - 其它未知标签/属性原样保留（TW 片段大量使用 `tc-*`/`$`/`data-*`）。
*
* 纯字符串实现（不依赖 DOM）：host 侧在返回给浏览器之前净化，且能被
* `scripts/verify-render-sanitizer.mjs` 在 Node 里逐条断言。
*
* @module dsh-tiddlywiki/host/sanitize
*/
/** 连内容一起丢掉的元素（其 innerText 也不可信，直接跳过到闭合标签之后）。 */
const DROP_WITH_CONTENT = /* @__PURE__ */ new Set([
	"script",
	"style",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"applet",
	"form",
	"base",
	"meta",
	"link",
	"noscript",
	"template",
	"svg",
	"math",
	"xmp",
	"plaintext",
	"listing",
	"basefont",
	"bgsound",
	"title"
]);
/** 自闭合（void）元素——不需要闭合标签。 */
const VOID_ELEMENTS = /* @__PURE__ */ new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr"
]);
/** 需要做 scheme 检查的 URL 属性。 */
const URL_ATTRIBUTES = /* @__PURE__ */ new Set([
	"href",
	"src",
	"xlink:href",
	"action",
	"formaction",
	"poster",
	"data",
	"dynsrc",
	"lowsrc",
	"background",
	"cite",
	"longdesc",
	"usemap",
	"manifest"
]);
/** 直接丢弃的属性（不参与 URL 检查）。 */
const DROP_ATTRIBUTES = /* @__PURE__ */ new Set([
	"srcdoc",
	"srcset",
	"formaction",
	"action",
	"ping"
]);
/** 允许的 URL scheme（其余带 scheme 的值一律拒绝）。 */
const ALLOWED_SCHEMES = /* @__PURE__ */ new Set([
	"http",
	"https",
	"mailto",
	"tel"
]);
/** 允许的 data: 图片 MIME（栅格；SVG 可携带脚本，拒绝）。 */
const ALLOWED_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)[;,]/i;
/**
* 数字实体 → 字符，**越界一律丢弃**。
*
* ⚠️ 不能只判 `code > 0`（v0.22.8）：`&#1114112;`（= 0x110000，比 Unicode 上限
* 0x10FFFF 多 1）和 `&#x110000;` 都会让 `String.fromCodePoint()` 抛 `RangeError`，
* 而调用链在 `sanitizeTwFragment()` 里**没有 try** —— 一条正文形如
* `<a href="&#1114112;javascript:…">` 的笔记就能让 `POST /render` 直接 500/502，
* 连带打坏回复流工具卡与会话「知识库」Tab（渲染片段是共用出口）。
* 上限必须显式判掉，任何非有限/越界的码点都返回空串（与既有「非法实体丢弃」一致）。
*/
function codePointToChar(code) {
	return Number.isFinite(code) && code > 0 && code <= 1114111 ? String.fromCodePoint(code) : "";
}
/** HTML 实体解码（只覆盖判定 scheme 需要的那些；数字实体 + 关键命名实体）。 */
function decodeEntities(value) {
	return value.replace(/&#x([0-9a-f]+);?/gi, (_m, hex) => codePointToChar(Number.parseInt(hex, 16))).replace(/&#(\d+);?/g, (_m, dec) => codePointToChar(Number.parseInt(dec, 10))).replace(/&(colon|tab|newline|sol|period);/gi, (m) => {
		const key = m.slice(1, -1).toLowerCase();
		return key === "colon" ? ":" : key === "tab" ? "	" : key === "newline" ? "\n" : key === "sol" ? "/" : ".";
	}).replace(/&amp;/gi, "&");
}
/** 该属性值是否是安全的 URL（相对路径/锚点/白名单 scheme/栅格 data 图片）。 */
function isSafeUrl(rawValue) {
	const value = decodeEntities(rawValue).replace(/[\u0000-\u0020\u007f\u00a0]+/g, "").trim();
	if (value.length === 0) return true;
	if (value.startsWith("#") || value.startsWith("/") || value.startsWith("?") || value.startsWith(".")) return true;
	const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(value);
	if (schemeMatch === null) return true;
	const scheme = (schemeMatch[1] ?? "").toLowerCase();
	if (scheme === "data") return ALLOWED_DATA_IMAGE.test(value);
	return ALLOWED_SCHEMES.has(scheme);
}
/** 属性名是否允许保留。 */
function isSafeAttributeName(name) {
	const lower = name.toLowerCase();
	if (lower.startsWith("on")) return false;
	if (DROP_ATTRIBUTES.has(lower)) return false;
	return /^[a-z_:][a-z0-9_:.-]*$/i.test(name);
}
/**
* 重新输出属性值时的转义：只去控制符、只转义双引号。
*
* ⚠️ 不要转义 `&`：源值里的 `&amp;` 是**已经实体化**的文本（TW 渲染输出），
* 再转一次会变成 `&amp;amp;`，浏览器解码后 URL 里就多了一个字面 `&amp;`
* （实测踩过：`?b=1&amp;c=2` 被改成 `?b=1&amp;amp;c=2`）。`"` 必须转义，
* 否则单引号形式的属性值里的引号会逃出双引号上下文。
*/
function escapeAttr(value) {
	return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/"/g, "&quot;");
}
/**
* 解析 `<` 起始处的一个标签。返回 null 表示不是标签（当普通文本处理）。
* 严格性重要：属性值支持双引号/单引号/无引号三种写法，未闭合的属性值
* （例如 `<img src=x onerror="…>` 里带引号却没闭合）会被吞到 `>` 或字符串末尾，
* 后续照样被丢弃，不会漏出可执行内容。
*/
function parseTag(html, start) {
	let i = start + 1;
	if (i >= html.length) return null;
	let closing = false;
	if (html[i] === "/") {
		closing = true;
		i++;
	}
	const nameStart = i;
	while (i < html.length && /[a-zA-Z0-9:_-]/.test(html[i])) i++;
	const name = html.slice(nameStart, i);
	if (name.length === 0) return null;
	const attrs = [];
	for (;;) {
		while (i < html.length && /\s/.test(html[i])) i++;
		if (i >= html.length) return null;
		const ch = html[i];
		if (ch === ">") return {
			end: i + 1,
			name,
			closing,
			selfClosing: false,
			attrs
		};
		if (ch === "/") {
			i++;
			while (i < html.length && /\s/.test(html[i])) i++;
			if (i < html.length && html[i] === ">") return {
				end: i + 1,
				name,
				closing,
				selfClosing: true,
				attrs
			};
			continue;
		}
		const nameStart2 = i;
		while (i < html.length && !/[\s=/>]/.test(html[i])) i++;
		const attrName = html.slice(nameStart2, i);
		if (attrName.length === 0) return null;
		while (i < html.length && /\s/.test(html[i])) i++;
		let value = "";
		if (i < html.length && html[i] === "=") {
			i++;
			while (i < html.length && /\s/.test(html[i])) i++;
			const quote = html[i];
			if (quote === "\"" || quote === "'") {
				i++;
				const valueStart = i;
				while (i < html.length && html[i] !== quote) i++;
				value = html.slice(valueStart, i);
				if (i < html.length) i++;
			} else {
				const valueStart = i;
				while (i < html.length && !/[\s>]/.test(html[i])) i++;
				value = html.slice(valueStart, i);
			}
		}
		attrs.push({
			name: attrName,
			value
		});
	}
}
/** 从 `from` 起找到 `</name` 之后的位置（找不到 → 字符串末尾）。 */
function skipElement(html, from, name) {
	const lower = html.toLowerCase();
	const needle = `</${name.toLowerCase()}`;
	const close = lower.indexOf(needle, from);
	if (close < 0) return html.length;
	const gt = html.indexOf(">", close + needle.length);
	return gt < 0 ? html.length : gt + 1;
}
/**
* 净化一个 TW 渲染片段：返回可以安全 `innerHTML` 的 HTML 字符串。
* 未知标签/属性保留；危险元素整棵丢掉；危险属性丢掉；危险 URL 丢掉。
*/
function sanitizeTwFragment(html) {
	if (typeof html !== "string" || html.length === 0) return "";
	const out = [];
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt < 0) {
			out.push(html.slice(i));
			break;
		}
		out.push(html.slice(i, lt));
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			i = end < 0 ? html.length : end + 3;
			continue;
		}
		if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
			const end = html.indexOf(">", lt);
			i = end < 0 ? html.length : end + 1;
			continue;
		}
		const tag = parseTag(html, lt);
		if (tag === null) {
			out.push("&lt;");
			i = lt + 1;
			continue;
		}
		const name = tag.name.toLowerCase();
		if (DROP_WITH_CONTENT.has(name)) {
			i = tag.closing || tag.selfClosing || VOID_ELEMENTS.has(name) ? tag.end : skipElement(html, tag.end, name);
			continue;
		}
		if (tag.closing) {
			if (!VOID_ELEMENTS.has(name)) out.push(`</${name}>`);
			i = tag.end;
			continue;
		}
		const safeAttrs = [];
		for (const attr of tag.attrs) {
			if (!isSafeAttributeName(attr.name)) continue;
			const lower = attr.name.toLowerCase();
			if (URL_ATTRIBUTES.has(lower) && !isSafeUrl(attr.value)) continue;
			safeAttrs.push(`${attr.name}="${escapeAttr(attr.value)}"`);
		}
		const attrText = safeAttrs.length > 0 ? ` ${safeAttrs.join(" ")}` : "";
		out.push(`<${name}${attrText}>`);
		i = tag.end;
	}
	return out.join("");
}
//#endregion
//#region src/host/seed-util.ts
/**
* Shared helpers for the ONE-SHOT seeds (`src/host/seed-*.ts`).
*
* ERROR POLICY (v0.18.0). A seed may only treat a tiddler as "missing" when the
* server actually answered 404 — `TiddlyWebClient.get()` already does exactly
* that (404 → `undefined`, everything else throws). Seeds must therefore NOT
* wrap reads in `.catch(() => undefined)`: that turned a transient failure (TW
* restarting, timeout, 5xx) into "the user has no such tiddler", after which the
* NON-force startup seeds happily `put()` the built-in content and OVERWROTE
* user-owned tiddlers (`$:/DefaultTiddlers`, the send-to-agent / render plugin
* bundles, the doc note…). Letting the error propagate makes the seed report
* `ok:false` and skip the write, which is the safe outcome.
*
* MARKER CONTENT HASHES (v0.22.0). A one-shot marker used to be the literal
* text `seeded-once` — enough to mean "offered once", useless for telling
* whether the BUILT-IN content changed since (which the settings page needs to
* say 「有更新」) or whether the USER edited their copy (which must never be
* overwritten silently). The marker is now JSON:
*
*     { "version": 1, "hashes": { "<title>": "<sha256/16>" }, "at": "<ISO>" }
*
* Old markers (`seeded-once`) are read as `legacy` and compared by TEXT
* instead: identical to the built-in → ownership is proven and the marker is
* upgraded in place; different → reported as "maybe updated / maybe edited",
* never silently rewritten.
*
* The marker write stays best-effort (it is bookkeeping, not user content) but
* is logged instead of silently swallowed, so a broken one-shot guarantee is at
* least visible.
*
* @module dsh-tiddlywiki/host/seed-util
*/
/** Marker schema version (bump only on an incompatible change). */
const SEED_MARKER_VERSION = 1;
/** Short content hash used for markers (16 hex chars of sha256). */
function hashText(text) {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
/**
* Read one tiddler for a seed. 404 → `undefined`; every other failure (network,
* timeout, 5xx, auth) propagates to the caller, which turns it into a failed
* seed result instead of an overwrite.
*/
function readSeedTiddler(client, title) {
	return client.get(title);
}
/** Parse a marker tiddler's text (never throws). */
function parseSeedMarker(text) {
	if (typeof text !== "string" || text.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return { legacy: true };
		const hashes = parsed.hashes;
		if (typeof hashes !== "object" || hashes === null) return { legacy: true };
		const clean = {};
		for (const [title, value] of Object.entries(hashes)) if (typeof value === "string" && value.length > 0) clean[title] = value;
		return { marker: {
			version: typeof parsed.version === "number" ? parsed.version : 1,
			hashes: clean
		} };
	} catch {
		return { legacy: true };
	}
}
/**
* Read a seed marker. 404 → `{}` (never seeded); a read FAILURE propagates like
* every other seed read (v0.18.0 error policy).
*/
async function readSeedMarker(client, title) {
	const tiddler = await readSeedTiddler(client, title);
	if (tiddler === void 0) return {};
	return parseSeedMarker(typeof tiddler.text === "string" ? tiddler.text : "");
}
/**
* Write a one-shot marker. Best-effort: a failure is logged (never silent) and
* does not fail the seed — the content write already succeeded and the marker
* only records "offered once" + which built-in content was written.
*/
async function writeSeedMarker(client, title, hashes) {
	const payload = {
		version: 1,
		hashes: hashes ?? {},
		at: (/* @__PURE__ */ new Date()).toISOString()
	};
	try {
		await client.put({
			title,
			text: JSON.stringify(payload),
			type: "application/json",
			tags: []
		});
	} catch (err) {
		console.warn(`[dsh-tiddlywiki] seed marker write failed (${title}):`, err instanceof Error ? err.message : err);
	}
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

<div style="color:#888; font-size:0.85em; border:1px dashed rgba(128,128,128,0.35); border-radius:8px; padding:6px 10px; margin-bottom:8px;">【模板】复制本页 → 改名（如「XX主题汇总」）→ 把正文里的 <code>主题A</code> 全部替换成你的标签名 → 保存。给笔记打上该标签即自动收录，本页无需维护。</div>

<div class="tc-message-box">自动收集带 <code>主题A</code> 标签的笔记，按最近修改排序，共 <strong>{{{[tag[主题A]!is[system]!has[draft.of]count[]]}}}</strong> 篇。</div>

<<list-links "[tag[主题A]!is[system]!has[draft.of]] +[!sort[modified]]">>

---

> 想自定义每行样式，或把本页收进「一页多主题」tabs？见 [[教程：按主题/标签做汇总页]]。
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
* Returns whether anything was written this call. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function seedStarterDocs(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-starter-docs") !== void 0) return false;
	}
	let wrote = false;
	for (const item of STARTER_DOCS_ITEMS) {
		const existing = await readSeedTiddler(client, item.title);
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
	await writeSeedMarker(client, STARTER_DOCS_MARKER_TITLE);
	return wrote;
}
/**
* Un-seed (反初始化): remove the starter docs and their marker. Deletion is
* idempotent — a tiddler already gone is not listed. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function unseedStarterDocs(client) {
	const removed = [];
	for (const item of STARTER_DOCS_ITEMS) if (await readSeedTiddler(client, item.title) !== void 0) {
		await client.delete(item.title);
		removed.push(item.title);
	}
	if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-starter-docs") !== void 0) {
		await client.delete(STARTER_DOCS_MARKER_TITLE);
		removed.push(STARTER_DOCS_MARKER_TITLE);
	}
	return { removed };
}
//#endregion
//#region src/host/prompt.ts
/**
* System-prompt section for the plugin (v0.21.0).
*
* WHY THIS MODULE EXISTS
* ----------------------
* Until v0.20.1 the section text was a hand-written template literal inside
* `src/index.ts` that **duplicated the tool schemas in prose**. It drifted
* exactly as expected: the signature catalogue was last touched in v0.19.0,
* while v0.19.4 (list_tags limit), v0.19.5 (delete/attach/batch_put
* concurrency tokens + attach's refuse-to-overwrite) and v0.20.1 (append
* `fields`) all changed the tools — so the injected prompt advertised 6 stale
* signatures for four releases.
*
* The fix has two halves:
*   1. `slim` (default) drops the parameter catalogue entirely — the model
*      already receives every tool's schema, so the section only carries the
*      conventions the schemas CANNOT express (sync discipline, workspace
*      tags, agent-written/human-edited, clickable wiki links). Nothing left
*      to drift.
*   2. `full` still offers a signature index, but it is **generated from the
*      live tool registry** (`tiddlywikiToolSummary()`), so it can never go
*      stale again.
*
* Both modes are composed from the same governance blocks; the verify script
* asserts every block survives in both (a re-write may not silently drop a
* rule the user relies on).
*
* v0.22.7 — DRAFT PREVIEW: `normalizePromptPreview()` + `describePrompt()`
* let the settings page render the text for the values currently in its form
* (before 保存配置). Until then the preview could only read the SAVED config, so
* switching 形态 and hitting 预览 showed the old text — byte-identical, which
* read as "the two modes are the same".
*
* @module dsh-tiddlywiki/host/prompt
*/
/** Prompt section name (stable id; a re-registration replaces the old one). */
const PROMPT_SECTION_NAME = "dsh-tiddlywiki";
/** Prompt section order (the plugin's section sits before plan/team policy). */
const PROMPT_SECTION_ORDER = 100;
/** Selectable prompt shapes. `slim` is the default since v0.21.0. */
const PROMPT_MODES = ["slim", "full"];
/** Default prompt shape (config `prompt.mode`; v0.21.0 switched to `slim`). */
const DEFAULT_PROMPT_MODE = "slim";
/**
* Whitelist an untrusted preview body (`POST /admin/prompt`) down to the five
* rendering inputs, with type checks. Unknown keys and wrong types are DROPPED
* (so a malformed body degrades to the built-in defaults instead of throwing),
* and `mode` is only accepted when it is a known value — the same
* "unknown falls back to slim" rule `normalizePromptMode()` applies later.
*/
function normalizePromptPreview(input) {
	const src = typeof input === "object" && input !== null ? input : {};
	const out = {};
	if (typeof src.enabled === "boolean") out.enabled = src.enabled;
	if (src.mode === "slim" || src.mode === "full") out.mode = src.mode;
	if (typeof src.extra === "string") out.extra = src.extra;
	if (typeof src.override === "string") out.override = src.override;
	if (typeof src.wechat === "boolean") out.wechat = src.wechat;
	return out;
}
/**
* Describe ONE prompt configuration: the built text plus the effective
* `enabled`/`mode` the settings page labels it with.
*
* Both the saved config (`GET /admin/prompt`, `applyPrompt()`) and the settings
* form's unsaved draft (`POST /admin/prompt`) go through here, so a preview can
* never disagree with what a save would inject (v0.22.7).
*/
function describePrompt(config, tools) {
	const enabled = config.enabled !== false;
	return {
		enabled,
		mode: normalizePromptMode(config.mode),
		text: buildPromptText({
			enabled,
			mode: config.mode,
			extra: config.extra,
			override: config.override,
			tools,
			wechat: config.wechat
		})
	};
}
/** Normalise a config value to a known mode (unknown values fall back to slim). */
function normalizePromptMode(value) {
	return value === "full" ? "full" : DEFAULT_PROMPT_MODE;
}
/**
* Neutralise `{{…}}` groups in USER-provided prompt text.
*
* DSH interpolates `{{name}}` in every section before delivery and **throws**
* on an unknown or malformed name — one `{{cwd}}` typed into `prompt.extra`
* would break system-prompt assembly for every session. A zero-width space
* between the braces keeps the text readable while making it literal prose
* (the interpolation scanner no longer sees a `{{` group).
*/
function escapePromptBraces(text) {
	return text.replace(/\{(?=\{)/g, "{​");
}
/** Governance block: how to write without clobbering human edits. */
const WRITE_RULES = `### 写入与并发
- 覆盖或删除已有笔记前先 \`tiddlywiki_get\` 读一次，把读到的 \`modified\`（或 \`revision\`）作为 \`expectedModified\`（或 \`expectedRevision\`）传回去；若期间有人（在 TW 编辑器里）改过，写入会被拒绝并告诉你当前值——此时重新读一遍再决定，**不要用 \`force\` 硬覆盖**。\`tiddlywiki_attach\` 对同名已有条目默认拒绝写入，理由相同（要覆盖得显式 \`force: true\`）。
- 纯增量内容（日志、批注、清单）优先用 \`tiddlywiki_append\`，不必读全文。
- 覆盖既有条目时**不传 \`tags\` 就保留原有标签、自定义字段与内容类型**（只改正文）；显式传 \`tags\` 才整体替换标签，要改内容类型用 \`fields.type\`。
- 内容类型：新笔记默认写成 Markdown（工具自动补 \`text/markdown\`，\`$:/\` 系统条目除外）；覆盖或追加既有条目时保留它原有的 \`type\`。要写 TW 原生 wikitext 才显式传 \`fields: {"type":"text/vnd.tiddlywiki"}\`。⚠️ \`fields.type\` 是 TW 的**内容类型**保留字段，业务分类请放 \`tags\`。`;
/** Governance block: the three-step git discipline + conflict recovery. */
const SYNC_RULES = `### 同步纪律（三条）
1. 开工先 pull：\`tiddlywiki_git_sync action=pull\`（rebase + autostash；真冲突会自动 abort 并报冲突文件）。
2. 收工 commit + push：\`tiddlywiki_git_sync action=sync\`（pull → commit → push）。
3. 插件会自动防抖 commit（默认 60s），需要立刻同步时用上面的工具。
pull 冲突后：先 \`tiddlywiki_git_resolve files=[冲突文件] strategy=keep-local\`（保留本地）或 \`strategy=keep-remote\`（改用远端版本），再重新 pull/sync 整合其余改动。`;
/** Governance block: knowledge-base conventions (tags, memory, links). */
const NOTE_RULES = `### 笔记约定
- wiki 是长期记忆：会议纪要、决策记录、调研笔记、随手的想法都存成独立 tiddler（tag 用 inbox/meeting/decision 等便于检索）。
- **值得做但不在当前范围内的想法**：用 \`tiddlywiki_put\` 写成独立 tiddler、打 \`todo\`，正文简述来源（会话 / 工作区 / 项目背景），由用户决定是否继续。
- **工作区标记自动打**：新建笔记自动带 \`ws/<项目名>\` 标签与 \`workspace\` 字段（取自会话工作目录），**不要手动再加**；只有内容显然属于**另一个**项目时才显式写 \`workspace\` 字段。
- **检索先窄后宽**：\`tiddlywiki_search\` 先在工作区内查、没命中才自动扩到全库，回执写明实际范围——**「工作区内 0 条」不等于库里没有**。查询按空白切词、**全部词命中**才算（AND）。
- **阶段性内容标时效**：会过期的笔记（版本记录 / 部署步骤 / 排期 / 临时方案 / 一次性口令）写时带 \`valid-until: YYYY-MM-DD\`（硬过期）或 \`review-after: YYYY-MM-DD\`（该复查）；被取代时写 \`superseded-by: [[新笔记]]\` 并打 \`superseded\` 标签、**保留旧笔记**。**淘汰只由人决定**，不要自行删除。
- \`agent-written\` 由工具自动补打，别手动加或删；人类编辑过 Agent 笔记后补 \`human-edited\`。
- **引用笔记用可点击链接**：\`[标题](/dsh-tiddlywiki/tw/#标题)\`（空格等特殊字符做 URL 编码；中文可直写）。点击会打开中央 TW 面板并跳转，优先用它代替纯文本标题。`;
/**
* Publish-metadata rule, appended ONLY when `wechat.enabled` is on (v0.23.0).
*
* The WeChat publishing feature is opt-in and needs its own install (opencli +
* a browser extension — see docs/wechat-publish-setup.md), so users who never
* enabled it must not see this line: the slim prompt had ~5 characters of
* headroom left and every line costs context in EVERY session.
*/
const PUBLISH_RULE = `- **对外发布前**：先读 [[发布元数据规范]]（\`pub-state\`/\`no-publish\`），别重发或误发。`;
/**
* Governance blocks that MUST survive in every mode — exported so
* `scripts/verify-prompt.mjs` can assert a re-write never silently drops one.
*/
const PROMPT_GOVERNANCE_BLOCKS = [
	WRITE_RULES,
	SYNC_RULES,
	NOTE_RULES
];
/**
* One line per tool: `bullet \`name\`（p1, p2?, …）`; `?` marks an optional
* parameter. Shared by the `full` prompt catalogue and by the TW-side doc seed
* (which reuses it as wikitext bullets), so both stay generated (v0.22.0).
*/
function toolSignatureLines(tools, bullet = "-") {
	return tools.map((tool) => {
		if (tool.params.length === 0) return `${bullet} \`${tool.name}\``;
		const params = tool.params.map((p) => p.required ? p.name : `${p.name}?`).join(", ");
		return `${bullet} \`${tool.name}\`（${params}）`;
	});
}
/** Heading + a one-line capability pointer (slim intro). */
function slimIntro(count) {
	return `## TiddlyWiki 持久知识库

本机有一个 TiddlyWiki 5 持久知识库（wiki 文件夹即 git 仓库）。插件提供 ${count} 个 \`tiddlywiki_*\` 工具：检索/读写/批量/增量追加/重命名/删除与回收站/反向链接/附件/体检/git 同步与冲突解决。**参数与返回契约以各工具 schema 的 description 为准**，本段只补充 schema 表达不了的约定。`;
}
/** Heading + the generated signature catalogue (full intro). */
function fullIntro(tools) {
	const lines = toolSignatureLines(tools).join("\n");
	return `## TiddlyWiki 持久知识库

本机有一个 TiddlyWiki 5 持久知识库（wiki 文件夹即 git 仓库）。可用工具（${tools.length} 个，\`?\` 表示可选参数；详细契约以各工具的 description 为准）：

${lines}`;
}
/**
* Build the section text.
*
* Composition order: body → `extra`. The body is `override` when non-empty,
* otherwise the built-in text for `mode`. User text is brace-escaped (see
* `escapePromptBraces`); the built-in text is not (it never contains `{{`).
* Returns `''` when `enabled === false` — callers must then register no
* section at all rather than an empty one.
*/
function buildPromptText(options) {
	if (options.enabled === false) return "";
	const tools = options.tools ?? [];
	const override = typeof options.override === "string" ? options.override.trim() : "";
	const intro = normalizePromptMode(options.mode) === "full" ? fullIntro(tools) : slimIntro(tools.length);
	const notes = options.wechat === true ? `${NOTE_RULES}\n${PUBLISH_RULE}` : NOTE_RULES;
	const body = override.length > 0 ? escapePromptBraces(override) : [
		intro,
		WRITE_RULES,
		SYNC_RULES,
		notes
	].join("\n\n");
	const extra = typeof options.extra === "string" ? escapePromptBraces(options.extra.trim()) : "";
	return extra.length > 0 ? `${body}\n\n${extra}` : body;
}
//#endregion
//#region src/host/seed-notes.ts
/** Note tiddler title (a normal, searchable note — not a system tiddler). */
const DOC_NOTE_TITLE = "dsh-tiddlywiki 插件说明";
/** Tag that makes the note easy to find via `tiddlywiki_search tag=docs`. */
const DOC_NOTE_TAG = "docs";
/**
* Shared tag that collects every plugin-seeded doc into the seeded home's
*「📚 插件文档」tabs strip.
*
* Alias of `DSH_DOCS_TAG` (v0.22.8): this module used to declare its OWN copy of
* the same literal, so the doc note and the starter docs shared a tag only by
* coincidence — changing one spelled the home's tabs strip empty for the other.
* Kept as a named alias because it reads better at the call site below.
*/
const DOC_NOTE_DSH_DOCS_TAG = DSH_DOCS_TAG;
/** One-time marker: its presence means "the note was offered once — hands off". */
const SEED_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-doc-note";
/** The note body, TiddlyWiki wiki-text. */
const DOC_NOTE_HEAD = `! dsh-tiddlywiki 插件说明

本插件把 **TiddlyWiki 5** 作为 DSH 的持久知识库（wiki 文件夹本身就是一个 git 仓库，随内容自动提交/同步）。

!! 它能做什么
`;
/**
* Tool-list bullet for the doc note, GENERATED from the live tool registry
* (v0.22.0). The note used to hard-code 「10 个 agent 工具」 and was 5 tools
* behind by the time anyone noticed — the same class of drift the prompt
* catalogue had. With no registry available (headless callers) it degrades to
* a pointer instead of an outdated list.
*/
function docToolBullet(tools) {
	if (tools.length === 0) return "* **agent 工具**：`tiddlywiki_*` 系列（检索 / 读写 / 批量写 / 增量追加 / 重命名 / 删除与回收站 / 反向链接 / 附件 / 体检 / git 同步与冲突解决）——完整清单与参数见 DSH 设置页与各工具的 schema。";
	return ["* **" + String(tools.length) + " 个 agent 工具**（参数以工具 schema 为准，`?` 表示可选）：", ...toolSignatureLines(tools, "* ")].join("\n");
}
const DOC_NOTE_TAIL = `* **TW 编辑器面板**：侧边栏「TiddlyWiki」按钮 → 在界面中央打开完整版 TW 编辑器。
* **快速笔记**：点击聊天输入框上方或右下角「知识库」菜单里的「📝 快速笔记」——默认**直达 TW 原生编辑页**（独立小窗，草稿自动续写）；也可在设置页切回 Markdown 卡片（语法高亮、文件上传、多选 tag、草稿自动保存、Ctrl+Enter 保存）。「✏️ 在 TW 中编辑」会弹出独立小窗用 TW 原生编辑器编辑。
* **一键同步**：「知识库」按钮 → 「🔁 同步」一键 pull → commit → push，按钮上的状态点实时反映 git 状态。
* **git 同步**：写入自动防抖 commit（默认 60 秒）；手动 \`tiddlywiki_git_sync action=sync\` 做 pull → commit → push。
* **设置页**：DSH 设置 → 「TiddlyWiki 知识库」管理插件/主题/语言与运行配置（含「知识库」按钮相关显示开关）。
* **注入给 Agent 的提示词可配置**（设置页「系统提示词」区块）：默认**精简版**只约定同步纪律/标签/链接格式（工具参数由工具 schema 提供，不重复）；可切完整版（附参数索引）、追加自定义规范（\`extra\`）、整段替换（\`override\`）或整体停用。保存即生效，无需重启 dsh web；点「查看当前注入文本」可预览下一步实际注入的全文。

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
* The doc note text. `tools` should be the live registry summary
* (`tiddlywikiToolSummary()`), so the tool list can never go stale.
*/
function docNoteText(tools = []) {
	return `${DOC_NOTE_HEAD}${docToolBullet(tools)}${DOC_NOTE_TAIL}`;
}
/** Back-compat constant: the note as built without a live registry. */
const DOC_NOTE_TEXT = docNoteText();
/**
* Seed the doc note once per wiki (mirrors the one-shot policy). A marker
* tiddler records that the note has been offered; from then on the note is
* user-owned and is never re-created (deleting it survives restarts).
*
* With `opts.force` the note is (re)written even when it already exists and
* the marker is (re)written — the settings page uses this for
* "重新初始化". Returns whether a note was written this call. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function seedDocNote(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-doc-note") !== void 0) return false;
	}
	const existing = await readSeedTiddler(client, DOC_NOTE_TITLE);
	let wrote = false;
	if (force || existing === void 0) {
		await client.put({
			title: DOC_NOTE_TITLE,
			text: docNoteText(opts?.tools ?? []),
			type: "text/vnd.tiddlywiki",
			tags: [DOC_NOTE_TAG, DOC_NOTE_DSH_DOCS_TAG]
		});
		wrote = true;
	}
	await writeSeedMarker(client, SEED_MARKER_TITLE);
	return wrote;
}
/**
* Un-seed (反初始化): remove the doc note and its one-shot marker, returning
* the wiki to the "never offered" state. Deletion is idempotent — a tiddler
* that was already gone is simply not listed. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function unseedDocNote(client) {
	const removed = [];
	for (const title of [DOC_NOTE_TITLE, SEED_MARKER_TITLE]) if (await readSeedTiddler(client, title) !== void 0) {
		await client.delete(title);
		removed.push(title);
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
const SEND_TO_AGENT_BUNDLE_TEXT = "{\n  \"tiddlers\": {\n    \"$:/plugins/dsh/send-to-agent/plugin.info\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/plugin.info\",\n      \"type\": \"application/json\",\n      \"text\": \"{\\\"title\\\":\\\"$:/plugins/dsh/send-to-agent\\\",\\\"name\\\":\\\"Send to Agent\\\",\\\"description\\\":\\\"把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）\\\",\\\"author\\\":\\\"dsh-tiddlywiki\\\",\\\"version\\\":\\\"0.3.5\\\",\\\"plugin-type\\\":\\\"plugin\\\"}\"\n    },\n    \"$:/plugins/dsh/send-to-agent/startup.js\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/startup.js\",\n      \"type\": \"application/javascript\",\n      \"module-type\": \"startup\",\n      \"text\": \"/*\\\\\\ntitle: $:/plugins/dsh/send-to-agent/startup.js\\ntype: application/javascript\\nmodule-type: startup\\n\\n\\\\*/\\n(function(){\\n\\n/*jslint node: true, browser: true */\\n/*global $tw: false */\\n\\\"use strict\\\";\\n\\nexports.name = \\\"dsh-send-to-agent\\\";\\nexports.after = [\\\"story\\\"];\\nexports.platforms = [\\\"browser\\\"];\\n\\nfunction readConfig() {\\n\\tvar config = { enabled: true, endpoint: \\\"\\\", token: \\\"\\\" };\\n\\ttry {\\n\\t\\tvar t = $tw.wiki.getTiddler(\\\"$:/plugins/dsh-tiddlywiki/config\\\");\\n\\t\\tif (t && t.fields && typeof t.fields.text === \\\"string\\\") {\\n\\t\\t\\tvar parsed = JSON.parse(t.fields.text);\\n\\t\\t\\tvar s2a = parsed && parsed.ui && parsed.ui.sendToAgent;\\n\\t\\t\\tif (s2a) {\\n\\t\\t\\t\\tif (typeof s2a.enabled === \\\"boolean\\\") { config.enabled = s2a.enabled; }\\n\\t\\t\\t\\tif (typeof s2a.endpoint === \\\"string\\\" && s2a.endpoint.length > 0) { config.endpoint = s2a.endpoint; }\\n\\t\\t\\t\\tif (typeof s2a.token === \\\"string\\\" && s2a.token.length > 0) { config.token = s2a.token; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t} catch (e) {}\\n\\treturn config;\\n}\\n\\nfunction baseEndpoint() {\\n\\tvar config = readConfig();\\n\\tif (config.endpoint.length > 0) { return config.endpoint.replace(/\\\\/+$/, \\\"\\\"); }\\n\\tif (typeof location !== \\\"undefined\\\" && location.origin) { return location.origin + \\\"/dsh-tiddlywiki\\\"; }\\n\\treturn \\\"/dsh-tiddlywiki\\\";\\n}\\n\\n/*\\nShow a transient message.\\n\\nTW's notifier renders a TIDDLER by title and does **nothing at all** when that\\ntiddler does not exist (core/modules/utils/dom/notifier.js: \\\"Don't do anything\\nif the tiddler doesn't exist\\\"). Passing free text as the title — which is what\\nthis function used to do — therefore made every success/failure notice of the\\n「发送给 Agent」 button invisible: the user clicked, chose a session, and saw\\nnothing. Store the message in a $:/temp tiddler first (volatile: never synced,\\nnever written to disk) and display THAT title.\\n*/\\nvar NOTICE_TITLE = \\\"$:/temp/dsh/send-to-agent/notice\\\";\\nfunction notify(msg) {\\n\\ttry {\\n\\t\\tif ($tw.wiki && $tw.notifier && typeof $tw.notifier.display === \\\"function\\\" && typeof $tw.wiki.addTiddler === \\\"function\\\") {\\n\\t\\t\\t$tw.wiki.addTiddler({ title: NOTICE_TITLE, text: String(msg), type: \\\"text/vnd.tiddlywiki\\\" });\\n\\t\\t\\t$tw.notifier.display(NOTICE_TITLE);\\n\\t\\t\\treturn;\\n\\t\\t}\\n\\t} catch (e) {}\\n\\tif (typeof alert === \\\"function\\\") { alert(msg); }\\n}\\n\\nfunction doSend(payload, sessionId, note) {\\n\\tvar config = readConfig();\\n\\tvar lines = [];\\n\\tlines.push(\\\"《\\\" + payload.title + \\\"》\\\");\\n\\tlines.push(\\\"标签: \\\" + (payload.tags || []).join(\\\", \\\"));\\n\\tlines.push(\\\"类型: \\\" + (payload.type || \\\"无\\\"));\\n\\tlines.push(\\\"\\\");\\n\\tlines.push(\\\"【待办说明】以下内容是我（用户）提前编辑在 TiddlyWiki 知识库中的待办事项，通过「发送给 Agent」一键发送给你处理。请按内容执行；如有任何不清楚的地方，请主动向我提问，不要臆测或擅自发挥。\\\");\\n\\tlines.push(\\\"\\\");\\n\\tlines.push(payload.text || \\\"\\\");\\n\\t// 附加说明放在消息最后：正文之后、作为我（用户）的最终补充要求，优先遵循。\\n\\tif (note && String(note).trim().length > 0) {\\n\\t\\tlines.push(\\\"\\\");\\n\\t\\tlines.push(\\\"【附加说明】\\\" + String(note).trim());\\n\\t}\\n\\tvar text = lines.join(\\\"\\\\n\\\");\\n\\tvar headers = { \\\"Content-Type\\\": \\\"application/json\\\" };\\n\\tif (config.token.length > 0) { headers[\\\"x-send-to-agent-token\\\"] = config.token; }\\n\\t$tw.utils.httpRequest({\\n\\t\\turl: baseEndpoint() + \\\"/agent/send\\\",\\n\\t\\ttype: \\\"POST\\\",\\n\\t\\theaders: headers,\\n\\t\\tdata: JSON.stringify({ sessionId: sessionId, text: text }),\\n\\t\\tcallback: function(err, data) {\\n\\t\\t\\tvar parsed = null;\\n\\t\\t\\ttry { parsed = JSON.parse(data || \\\"\\\"); } catch (e) {}\\n\\t\\t\\tif (err) { notify(\\\"发送失败：\\\" + err); return; }\\n\\t\\t\\tif (parsed && parsed.ok) {\\n\\t\\t\\t\\tnotify(\\\"已发送 ✓ 会话 \\\" + sessionId.slice(0, 8));\\n\\t\\t\\t} else {\\n\\t\\t\\t\\tnotify(\\\"发送失败：\\\" + ((parsed && parsed.error) || data || \\\"未知错误\\\"));\\n\\t\\t\\t}\\n\\t\\t}\\n\\t});\\n}\\n\\nfunction closeOverlay(overlay, escHandler) {\\n\\tif (escHandler) { document.removeEventListener(\\\"keydown\\\", escHandler); }\\n\\tif (overlay && overlay.parentNode) { overlay.parentNode.removeChild(overlay); }\\n}\\n\\nfunction showPicker(payload, items, modes, defaultId, permissions) {\\n\\tif (typeof document === \\\"undefined\\\") { return; }\\n\\t// remove any previously-open picker\\n\\tvar old = document.getElementById(\\\"dsh-send-picker\\\");\\n\\tif (old && old.parentNode) { old.parentNode.removeChild(old); }\\n\\n\\tvar state = { workspace: null, mode: \\\"\\\", note: \\\"\\\", permission: \\\"\\\" };\\n\\n\\tvar overlay = document.createElement(\\\"div\\\");\\n\\toverlay.id = \\\"dsh-send-picker\\\";\\n\\toverlay.setAttribute(\\\"style\\\", \\\"position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);z-index:99999;display:flex;align-items:center;justify-content:center;\\\");\\n\\tvar box = document.createElement(\\\"div\\\");\\n\\tbox.setAttribute(\\\"style\\\", \\\"background:#fff;color:#333;border-radius:8px;padding:14px;min-width:340px;max-width:560px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.3);font-family:system-ui,-apple-system,sans-serif;\\\");\\n\\n\\t// header\\n\\tvar header = document.createElement(\\\"div\\\");\\n\\theader.setAttribute(\\\"style\\\", \\\"display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;\\\");\\n\\tvar h = document.createElement(\\\"h3\\\");\\n\\th.setAttribute(\\\"style\\\", \\\"margin:0;font-size:15px;\\\");\\n\\th.textContent = \\\"发送给 Agent · 选择目标\\\";\\n\\tvar closeX = document.createElement(\\\"button\\\");\\n\\tcloseX.type = \\\"button\\\";\\n\\tcloseX.textContent = \\\"✕\\\";\\n\\tcloseX.title = \\\"关闭\\\";\\n\\tcloseX.setAttribute(\\\"style\\\", \\\"border:none;background:transparent;font-size:15px;cursor:pointer;color:#888;padding:2px 8px;border-radius:4px;\\\");\\n\\tcloseX.addEventListener(\\\"click\\\", function() { closeOverlay(overlay, escHandler); });\\n\\theader.appendChild(h);\\n\\theader.appendChild(closeX);\\n\\tbox.appendChild(header);\\n\\n\\t// description\\n\\tvar desc = document.createElement(\\\"p\\\");\\n\\tdesc.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;font-size:12px;color:#888;word-break:break-all;\\\");\\n\\tdesc.textContent = \\\"《\\\" + payload.title + \\\"》将作为消息注入所选会话\\\";\\n\\tbox.appendChild(desc);\\n\\n\\t// 附加说明（可选）— any extra context the user wants to attach to the\\n\\t// message, e.g. what to focus on or how to handle it.\\n\\tvar noteRow = document.createElement(\\\"div\\\");\\n\\tnoteRow.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;\\\");\\n\\tvar noteLbl = document.createElement(\\\"label\\\");\\n\\tnoteLbl.setAttribute(\\\"style\\\", \\\"display:block;font-size:12px;color:#666;margin-bottom:4px;\\\");\\n\\tnoteLbl.textContent = \\\"附加说明（可选，随笔记一起发给 Agent）\\\";\\n\\tnoteRow.appendChild(noteLbl);\\n\\tvar noteTa = document.createElement(\\\"textarea\\\");\\n\\tnoteTa.placeholder = \\\"例如：请重点看第 3 条；我希望你按 XX 方式处理…\\\";\\n\\tnoteTa.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;min-height:44px;resize:vertical;font-family:inherit;\\\");\\n\\tnoteTa.addEventListener(\\\"input\\\", function() { state.note = noteTa.value; });\\n\\tnoteRow.appendChild(noteTa);\\n\\tbox.appendChild(noteRow);\\n\\n\\t// 工作模式（Agent 预设）selector — applies to newly created sessions; the\\n\\t// modes come from GET /agent/modes (id/name/description + deployment\\n\\t// default). When the modes endpoint is unreachable (e.g. an older host) the\\n\\t// row degrades to a hint and no mode is sent — DSH uses its default.\\n\\tvar modeRow = document.createElement(\\\"div\\\");\\n\\tmodeRow.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;\\\");\\n\\tif (modes && modes.length > 0) {\\n\\t\\tvar modeLbl = document.createElement(\\\"label\\\");\\n\\t\\tmodeLbl.setAttribute(\\\"style\\\", \\\"display:block;font-size:12px;color:#666;margin-bottom:4px;\\\");\\n\\t\\tmodeLbl.textContent = \\\"工作模式（Agent 预设）— 用于新建会话\\\";\\n\\t\\tmodeRow.appendChild(modeLbl);\\n\\t\\tvar sel = document.createElement(\\\"select\\\");\\n\\t\\tsel.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;\\\");\\n\\t\\tvar optDefault = document.createElement(\\\"option\\\");\\n\\t\\toptDefault.value = \\\"\\\";\\n\\t\\toptDefault.textContent = \\\"（默认模式）\\\";\\n\\t\\tsel.appendChild(optDefault);\\n\\t\\tmodes.forEach(function(m) {\\n\\t\\t\\tvar o = document.createElement(\\\"option\\\");\\n\\t\\t\\to.value = m.id || \\\"\\\";\\n\\t\\t\\to.textContent = (m.name || m.id) + (m.isDefault ? \\\"（默认）\\\" : \\\"\\\");\\n\\t\\t\\tsel.appendChild(o);\\n\\t\\t});\\n\\t\\t// preselect the deployment default when listed\\n\\t\\tif (defaultId) {\\n\\t\\t\\tfor (var i = 0; i < sel.options.length; i++) {\\n\\t\\t\\t\\tif (sel.options[i].value === defaultId) { sel.selectedIndex = i; break; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t\\tstate.mode = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].value : \\\"\\\";\\n\\t\\tsel.addEventListener(\\\"change\\\", function() { state.mode = sel.value; });\\n\\t\\tmodeRow.appendChild(sel);\\n\\t} else {\\n\\t\\tvar modeHint = document.createElement(\\\"p\\\");\\n\\t\\tmodeHint.setAttribute(\\\"style\\\", \\\"margin:0;font-size:12px;color:#999;\\\");\\n\\t\\tmodeHint.textContent = \\\"（未获取到可用工作模式，将使用 DSH 默认模式）\\\";\\n\\t\\tmodeRow.appendChild(modeHint);\\n\\t}\\n\\tbox.appendChild(modeRow);\\n\\n\\t// 权限（权限预设）selector — applies to newly created sessions only; the\\n\\t// options come from GET /agent/modes' `permissions` roster (each bundles a\\n\\t// sandbox mode + approval policy). Existing sessions keep their own\\n\\t// permission, so this only affects \\\"新建会话并发送\\\".\\n\\tvar permRow = document.createElement(\\\"div\\\");\\n\\tpermRow.setAttribute(\\\"style\\\", \\\"margin:0 0 8px;\\\");\\n\\tif (permissions && Array.isArray(permissions.items) && permissions.items.length > 0) {\\n\\t\\tvar permLbl = document.createElement(\\\"label\\\");\\n\\t\\tpermLbl.setAttribute(\\\"style\\\", \\\"display:block;font-size:12px;color:#666;margin-bottom:4px;\\\");\\n\\t\\tpermLbl.textContent = \\\"权限（权限预设）— 用于新建会话\\\";\\n\\t\\tpermRow.appendChild(permLbl);\\n\\t\\tvar psel = document.createElement(\\\"select\\\");\\n\\t\\tpsel.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;\\\");\\n\\t\\tpermissions.items.forEach(function(p) {\\n\\t\\t\\tvar o = document.createElement(\\\"option\\\");\\n\\t\\t\\to.value = p.value || \\\"\\\";\\n\\t\\t\\to.textContent = p.name || p.value;\\n\\t\\t\\tif (p.description) { o.title = p.description; }\\n\\t\\t\\tpsel.appendChild(o);\\n\\t\\t});\\n\\t\\t// preselect the deployment default when listed\\n\\t\\tif (permissions.defaultId) {\\n\\t\\t\\tfor (var j = 0; j < psel.options.length; j++) {\\n\\t\\t\\t\\tif (psel.options[j].value === permissions.defaultId) { psel.selectedIndex = j; break; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t\\tstate.permission = psel.options[psel.selectedIndex] ? psel.options[psel.selectedIndex].value : \\\"\\\";\\n\\t\\tpsel.addEventListener(\\\"change\\\", function() { state.permission = psel.value; });\\n\\t\\tpermRow.appendChild(psel);\\n\\t} else {\\n\\t\\tvar permHint = document.createElement(\\\"p\\\");\\n\\t\\tpermHint.setAttribute(\\\"style\\\", \\\"margin:0;font-size:12px;color:#999;\\\");\\n\\t\\tpermHint.textContent = \\\"（未获取到权限预设，新建会话将使用 DSH 默认权限）\\\";\\n\\t\\tpermRow.appendChild(permHint);\\n\\t}\\n\\tbox.appendChild(permRow);\\n\\n\\t// scrollable body\\n\\tvar body = document.createElement(\\\"div\\\");\\n\\tbody.setAttribute(\\\"style\\\", \\\"overflow:auto;flex:1;min-height:0;\\\");\\n\\tbox.appendChild(body);\\n\\n\\t// footer with cancel\\n\\tvar footer = document.createElement(\\\"div\\\");\\n\\tfooter.setAttribute(\\\"style\\\", \\\"display:flex;justify-content:flex-end;gap:8px;margin-top:10px;\\\");\\n\\tvar cancel = document.createElement(\\\"button\\\");\\n\\tcancel.type = \\\"button\\\";\\n\\tcancel.textContent = \\\"取消\\\";\\n\\tcancel.setAttribute(\\\"style\\\", \\\"padding:6px 14px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;\\\");\\n\\tcancel.addEventListener(\\\"click\\\", function() { closeOverlay(overlay, escHandler); });\\n\\tfooter.appendChild(cancel);\\n\\tbox.appendChild(footer);\\n\\n\\toverlay.appendChild(box);\\n\\tdocument.body.appendChild(overlay);\\n\\n\\t// backdrop click + Esc close\\n\\toverlay.addEventListener(\\\"click\\\", function(e) {\\n\\t\\tif (e.target === overlay) { closeOverlay(overlay, escHandler); }\\n\\t});\\n\\tvar escHandler = function(e) { if (e.key === \\\"Escape\\\") { closeOverlay(overlay, escHandler); } };\\n\\tdocument.addEventListener(\\\"keydown\\\", escHandler);\\n\\n\\t// group sessions by workspace (cwd)\\n\\tvar groups = {};\\n\\tvar order = [];\\n\\t(items || []).forEach(function(s) {\\n\\t\\tvar key = (s.cwd && String(s.cwd).length > 0) ? s.cwd : \\\"__default__\\\";\\n\\t\\tif (!groups[key]) { groups[key] = { cwd: s.cwd, sessions: [], max: 0 }; order.push(key); }\\n\\t\\tgroups[key].sessions.push(s);\\n\\t\\tif ((s.updatedAt || 0) > groups[key].max) { groups[key].max = s.updatedAt || 0; }\\n\\t});\\n\\torder.sort(function(a, b) { return groups[b].max - groups[a].max; });\\n\\n\\tfunction btnStyle() {\\n\\t\\treturn \\\"display:block;width:100%;text-align:left;padding:8px 10px;margin:4px 0;border:1px solid #ddd;border-radius:6px;background:#f7f7f7;cursor:pointer;font-size:13px;\\\";\\n\\t}\\n\\tfunction primaryBtnStyle() {\\n\\t\\treturn \\\"display:block;width:100%;text-align:center;padding:7px 10px;margin:6px 0 0;border:1px solid #4a90d9;border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer;font-size:13px;\\\";\\n\\t}\\n\\tfunction smallBtnStyle() {\\n\\t\\treturn \\\"margin:0 0 6px;padding:4px 10px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;color:#555;\\\";\\n\\t}\\n\\n\\tfunction shortSessionLabel(s) {\\n\\t\\tvar id = s.sessionId || \\\"\\\";\\n\\t\\tvar parts = id.split(\\\"-\\\");\\n\\t\\tvar short = (parts.length > 1 ? parts[parts.length - 1] : id).slice(-10);\\n\\t\\tvar when = \\\"\\\";\\n\\t\\tif (s.updatedAt) {\\n\\t\\t\\tvar diff = Date.now() - s.updatedAt;\\n\\t\\t\\tif (diff < 60000) { when = \\\"刚刚\\\"; }\\n\\t\\t\\telse if (diff < 3600000) { when = Math.floor(diff / 60000) + \\\" 分钟前\\\"; }\\n\\t\\t\\telse if (diff < 86400000) { when = Math.floor(diff / 3600000) + \\\" 小时前\\\"; }\\n\\t\\t\\telse {\\n\\t\\t\\t\\tvar d = new Date(s.updatedAt);\\n\\t\\t\\t\\twhen = (d.getMonth() + 1) + \\\"-\\\" + d.getDate() + \\\" \\\" + (\\\"0\\\" + d.getHours()).slice(-2) + \\\":\\\" + (\\\"0\\\" + d.getMinutes()).slice(-2);\\n\\t\\t\\t}\\n\\t\\t}\\n\\t\\treturn \\\"#\\\" + short + (when ? \\\"  ·  \\\" + when : \\\"\\\") + (s.running ? \\\"  ·  ●运行中\\\" : \\\"\\\") + (s.blank ? \\\"  ·  (空)\\\" : \\\"\\\");\\n\\t}\\n\\n\\tfunction modeName(id) {\\n\\t\\tif (!id) { return \\\"\\\"; }\\n\\t\\tfor (var i = 0; i < (modes || []).length; i++) {\\n\\t\\t\\tif (modes[i].id === id) { return modes[i].name || modes[i].id; }\\n\\t\\t}\\n\\t\\treturn id;\\n\\t}\\n\\n\\tfunction render() {\\n\\t\\tbody.innerHTML = \\\"\\\";\\n\\t\\tif (state.workspace === null) { renderWorkspaces(); } else { renderSessions(state.workspace); }\\n\\t}\\n\\n\\tfunction renderWorkspaces() {\\n\\t\\tif (order.length === 0) {\\n\\t\\t\\tvar none = document.createElement(\\\"p\\\");\\n\\t\\t\\tnone.textContent = \\\"还没有任何会话——在下方新建一个吧\\\";\\n\\t\\t\\tnone.setAttribute(\\\"style\\\", \\\"color:#999;font-size:13px;margin:0 0 8px;\\\");\\n\\t\\t\\tbody.appendChild(none);\\n\\t\\t} else {\\n\\t\\t\\torder.forEach(function(key) {\\n\\t\\t\\t\\tvar g = groups[key];\\n\\t\\t\\t\\tvar label = g.cwd || \\\"(默认工作区)\\\";\\n\\t\\t\\t\\tvar b = document.createElement(\\\"button\\\");\\n\\t\\t\\t\\tb.type = \\\"button\\\";\\n\\t\\t\\t\\tb.setAttribute(\\\"style\\\", btnStyle());\\n\\t\\t\\t\\tb.textContent = \\\"📁 \\\" + label + \\\"  ·  \\\" + g.sessions.length + \\\" 个会话\\\";\\n\\t\\t\\t\\tb.title = g.cwd || \\\"默认工作区\\\";\\n\\t\\t\\t\\tb.addEventListener(\\\"click\\\", function() { state.workspace = key; render(); });\\n\\t\\t\\t\\tbody.appendChild(b);\\n\\t\\t\\t});\\n\\t\\t}\\n\\t\\t// new workspace / session\\n\\t\\tvar newRow = document.createElement(\\\"div\\\");\\n\\t\\tnewRow.setAttribute(\\\"style\\\", \\\"margin-top:10px;border-top:1px solid #eee;padding-top:8px;\\\");\\n\\t\\tvar lbl = document.createElement(\\\"p\\\");\\n\\t\\tlbl.textContent = \\\"新建工作区 / 会话\\\";\\n\\t\\tlbl.setAttribute(\\\"style\\\", \\\"margin:0 0 6px;font-size:12px;color:#666;\\\");\\n\\t\\tnewRow.appendChild(lbl);\\n\\t\\tvar input = document.createElement(\\\"input\\\");\\n\\t\\tinput.type = \\\"text\\\";\\n\\t\\tinput.placeholder = \\\"输入工作区路径，留空为默认工作区\\\";\\n\\t\\tinput.setAttribute(\\\"style\\\", \\\"width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;\\\");\\n\\t\\tnewRow.appendChild(input);\\n\\t\\tvar go = document.createElement(\\\"button\\\");\\n\\t\\tgo.type = \\\"button\\\";\\n\\t\\tgo.textContent = \\\"创建并发送\\\";\\n\\t\\tgo.setAttribute(\\\"style\\\", primaryBtnStyle());\\n\\t\\tgo.addEventListener(\\\"click\\\", function() { createAndSend(payload, input.value.trim()); });\\n\\t\\tnewRow.appendChild(go);\\n\\t\\tinput.addEventListener(\\\"keydown\\\", function(e) { if (e.key === \\\"Enter\\\") { createAndSend(payload, input.value.trim()); } });\\n\\t\\tbody.appendChild(newRow);\\n\\t}\\n\\n\\tfunction renderSessions(key) {\\n\\t\\tvar g = groups[key];\\n\\t\\tvar back = document.createElement(\\\"button\\\");\\n\\t\\tback.type = \\\"button\\\";\\n\\t\\tback.textContent = \\\"← 返回工作区列表\\\";\\n\\t\\tback.setAttribute(\\\"style\\\", smallBtnStyle());\\n\\t\\tback.addEventListener(\\\"click\\\", function() { state.workspace = null; render(); });\\n\\t\\tbody.appendChild(back);\\n\\n\\t\\tvar wsName = document.createElement(\\\"p\\\");\\n\\t\\twsName.textContent = g.cwd ? \\\"📁 \\\" + g.cwd : \\\"(默认工作区)\\\";\\n\\t\\twsName.setAttribute(\\\"style\\\", \\\"margin:0 0 6px;font-size:13px;font-weight:600;word-break:break-all;\\\");\\n\\t\\tbody.appendChild(wsName);\\n\\n\\t\\t(g.sessions || []).forEach(function(s) {\\n\\t\\t\\tvar b = document.createElement(\\\"button\\\");\\n\\t\\t\\tb.type = \\\"button\\\";\\n\\t\\t\\tb.setAttribute(\\\"style\\\", btnStyle());\\n\\t\\t\\tvar label = shortSessionLabel(s);\\n\\t\\t\\tif (s.agentPreset) { label += \\\"  ·  🧭 \\\" + modeName(s.agentPreset); }\\n\\t\\t\\tb.textContent = label;\\n\\t\\t\\tb.title = \\\"会话 \\\" + s.sessionId + (s.agentPreset ? \\\" · 工作模式 \\\" + modeName(s.agentPreset) : \\\"\\\");\\n\\t\\t\\tb.addEventListener(\\\"click\\\", function() { closeOverlay(overlay, escHandler); doSend(payload, s.sessionId, state.note); });\\n\\t\\t\\tbody.appendChild(b);\\n\\t\\t});\\n\\n\\t\\tvar newBtn = document.createElement(\\\"button\\\");\\n\\t\\tnewBtn.type = \\\"button\\\";\\n\\t\\tnewBtn.textContent = \\\"➕ 在此工作区新建会话并发送\\\";\\n\\t\\tnewBtn.setAttribute(\\\"style\\\", primaryBtnStyle());\\n\\t\\tnewBtn.addEventListener(\\\"click\\\", function() { createAndSend(payload, g.cwd); });\\n\\t\\tbody.appendChild(newBtn);\\n\\t}\\n\\n\\tfunction createAndSend(payload2, cwd) {\\n\\t\\tvar config = readConfig();\\n\\t\\tvar headers = { \\\"Content-Type\\\": \\\"application/json\\\" };\\n\\t\\tif (config.token.length > 0) { headers[\\\"x-send-to-agent-token\\\"] = config.token; }\\n\\t\\tvar body = { cwd: cwd || \\\"\\\" };\\n\\t\\tif (state.mode && String(state.mode).length > 0) { body.mode = state.mode; }\\n\\t\\tif (state.permission && String(state.permission).length > 0) { body.permission = state.permission; }\\n\\t\\t$tw.utils.httpRequest({\\n\\t\\t\\turl: baseEndpoint() + \\\"/agent/create\\\",\\n\\t\\t\\ttype: \\\"POST\\\",\\n\\t\\t\\theaders: headers,\\n\\t\\t\\tdata: JSON.stringify(body),\\n\\t\\t\\tcallback: function(err, data) {\\n\\t\\t\\t\\tvar parsed = null;\\n\\t\\t\\t\\ttry { parsed = JSON.parse(data || \\\"\\\"); } catch (e) {}\\n\\t\\t\\t\\tif (err) { notify(\\\"新建会话失败：\\\" + err); return; }\\n\\t\\t\\t\\tif (parsed && parsed.ok && parsed.sessionId) {\\n\\t\\t\\t\\t\\tcloseOverlay(overlay, escHandler);\\n\\t\\t\\t\\t\\tvar modeNote = parsed.mode ? \\\"（模式 \\\" + modeName(parsed.mode) + \\\"）\\\" : \\\"\\\";\\n\\t\\t\\t\\t\\tvar permNote = parsed.permissionApplied ? \\\"（权限 \\\" + (parsed.permission || \\\"\\\") + \\\"）\\\" : \\\"\\\";\\n\\t\\t\\t\\t\\tnotify(\\\"已创建会话并发送 ✓ \\\" + parsed.sessionId.slice(0, 8) + modeNote + permNote);\\n\\t\\t\\t\\t\\tdoSend(payload2, parsed.sessionId, state.note);\\n\\t\\t\\t\\t} else {\\n\\t\\t\\t\\t\\tnotify(\\\"新建会话失败：\\\" + ((parsed && parsed.error) || data || \\\"未知错误\\\"));\\n\\t\\t\\t\\t}\\n\\t\\t\\t}\\n\\t\\t});\\n\\t}\\n\\n\\trender();\\n}\\n\\nfunction handleSend(title) {\\n\\tif (!title) { notify(\\\"无法确定当前笔记标题\\\"); return; }\\n\\tvar tiddler = $tw.wiki.getTiddler(title);\\n\\tif (!tiddler) { notify(\\\"找不到笔记：\\\" + title); return; }\\n\\tvar config = readConfig();\\n\\tif (!config.enabled) { notify(\\\"「发送给 Agent」特性未启用（可在 TW 配置中打开）\\\"); return; }\\n\\tvar payload = {\\n\\t\\ttitle: title,\\n\\t\\ttext: tiddler.fields.text || \\\"\\\",\\n\\t\\ttags: tiddler.fields.tags || [],\\n\\t\\ttype: tiddler.fields.type || \\\"\\\"\\n\\t};\\n\\tvar headers = {};\\n\\tif (config.token.length > 0) { headers[\\\"x-send-to-agent-token\\\"] = config.token; }\\n\\t$tw.utils.httpRequest({\\n\\t\\turl: baseEndpoint() + \\\"/agent/sessions\\\",\\n\\t\\ttype: \\\"GET\\\",\\n\\t\\theaders: headers,\\n\\t\\tcallback: function(err, data) {\\n\\t\\t\\tvar parsed = null;\\n\\t\\t\\ttry { parsed = JSON.parse(data || \\\"\\\"); } catch (e) {}\\n\\t\\t\\tif (err) { notify(\\\"获取会话列表失败：\\\" + err); return; }\\n\\t\\t\\tif (!parsed || !parsed.ok || !parsed.items) { notify(\\\"获取会话列表失败：\\\" + ((parsed && parsed.error) || \\\"未知错误\\\")); return; }\\n\\t\\t\\t// fetch the available 工作模式 (Agent presets) alongside; degrade to\\n\\t\\t\\t// an empty roster (default mode) when the endpoint is missing.\\n\\t\\t\\t$tw.utils.httpRequest({\\n\\t\\t\\t\\turl: baseEndpoint() + \\\"/agent/modes\\\",\\n\\t\\t\\t\\ttype: \\\"GET\\\",\\n\\t\\t\\t\\theaders: headers,\\n\\t\\t\\t\\tcallback: function(err2, data2) {\\n\\t\\t\\t\\t\\tvar modes = [];\\n\\t\\t\\t\\t\\tvar defaultId = \\\"\\\";\\n\\t\\t\\t\\t\\tvar permissions = null;\\n\\t\\t\\t\\t\\tvar parsed2 = null;\\n\\t\\t\\t\\t\\ttry { parsed2 = JSON.parse(data2 || \\\"\\\"); } catch (e) {}\\n\\t\\t\\t\\t\\tif (!err2 && parsed2 && parsed2.ok) {\\n\\t\\t\\t\\t\\t\\tif (Array.isArray(parsed2.items)) {\\n\\t\\t\\t\\t\\t\\t\\tmodes = parsed2.items;\\n\\t\\t\\t\\t\\t\\t\\tdefaultId = parsed2.defaultId || \\\"\\\";\\n\\t\\t\\t\\t\\t\\t}\\n\\t\\t\\t\\t\\t\\tif (parsed2.permissions && Array.isArray(parsed2.permissions.items)) {\\n\\t\\t\\t\\t\\t\\t\\tpermissions = parsed2.permissions;\\n\\t\\t\\t\\t\\t\\t}\\n\\t\\t\\t\\t\\t}\\n\\t\\t\\t\\t\\tshowPicker(payload, parsed.items, modes, defaultId, permissions);\\n\\t\\t\\t\\t}\\n\\t\\t\\t});\\n\\t\\t}\\n\\t});\\n}\\n\\nexports.startup = function() {\\n\\tconsole.log(\\\"[dsh-send-to-agent] startup ran\\\");\\n\\tif (!$tw.rootWidget || typeof $tw.rootWidget.addEventListener !== \\\"function\\\") { return; }\\n\\t$tw.rootWidget.addEventListener(\\\"dsh-send-to-agent\\\", function(event) {\\n\\t\\thandleSend(event.param);\\n\\t});\\n};\\n\\n})();\\n\"\n    },\n    \"$:/plugins/dsh/send-to-agent/ui/icon\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/ui/icon\",\n      \"tags\": [\n        \"$:/tags/Image\"\n      ],\n      \"text\": \"\\\\parameters (size:\\\"22pt\\\")\\n<svg width=<<size>> height=<<size>> class=\\\"tc-image-send-to-agent tc-image-button\\\" viewBox=\\\"0 0 24 24\\\"><path d=\\\"M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z\\\"/></svg>\\n\"\n    },\n    \"$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent\": {\n      \"title\": \"$:/plugins/dsh/send-to-agent/ui/ViewToolbar/SendToAgent\",\n      \"type\": \"text/vnd.tiddlywiki\",\n      \"tags\": [\n        \"$:/tags/ViewToolbar\"\n      ],\n      \"icon\": \"$:/plugins/dsh/send-to-agent/ui/icon\",\n      \"caption\": \"发送给 Agent\",\n      \"description\": \"把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）\",\n      \"text\": \"\\\\whitespace trim\\n<$button message=\\\"dsh-send-to-agent\\\"\\n\\tparam=<<currentTiddler>>\\n\\ttooltip=\\\"把当前笔记一键发送给 DSH Agent\\\"\\n\\taria-label=\\\"把当前笔记一键发送给 DSH Agent\\\"\\n\\tclass=<<tv-config-toolbar-class>>\\n>\\n\\t<%if [<tv-config-toolbar-icons>match[yes]] %>\\n\\t\\t{{$:/plugins/dsh/send-to-agent/ui/icon}}\\n\\t<%endif%>\\n\\t<%if [<tv-config-toolbar-text>match[yes]] %>\\n\\t\\t<span class=\\\"tc-btn-text\\\">\\n\\t\\t<$text text=\\\"发送给 Agent\\\"/>\\n\\t</span>\\n\\t<%endif%>\\n</$button>\\n\"\n    },\n    \"$:/core/ui/ControlPanel/Toolbars/ItemTemplate\": {\n      \"title\": \"$:/core/ui/ControlPanel/Toolbars/ItemTemplate\",\n      \"type\": \"text/vnd.tiddlywiki\",\n      \"text\": \"\\\\define config-title()\\n$(config-base)$$(currentTiddler)$\\n\\\\end\\n\\\\whitespace trim\\n\\n<$draggable tiddler=<<currentTiddler>>>\\n<$checkbox tiddler=<<config-title>> field=\\\"text\\\" checked=\\\"show\\\" unchecked=\\\"hide\\\" default=\\\"show\\\"/>\\n&#32;\\n<span class=\\\"tc-icon-wrapper\\\"><$transclude tiddler={{!!icon}}/></span>\\n&#32;\\n<$transclude field=\\\"caption\\\"/>\\n&#32;--&#32;\\n<i class=\\\"tc-muted\\\"><$transclude field=\\\"description\\\"/></i>\\n</$draggable>\\n\"\n    }\n  }\n}";
/**
* Seed the "发送给 Agent" TW button exactly once per wiki (mirrors the doc-note
* one-shot policy). The marker records the offer; afterwards the bundle is
* user-owned — deleting it and restarting dsh web does NOT recreate it, and
* edits are never overwritten. With `opts.force` the bundle is (re)written even
* when it already exists and the marker is (re)written — the settings page uses
* this for "重新初始化". Returns whether a bundle was written this call.
* Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function seedSendToAgent(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-send-to-agent") !== void 0) return false;
	}
	const existing = await readSeedTiddler(client, SEND_TO_AGENT_PLUGIN_TITLE);
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
			version: "0.3.5",
			description: "把当前笔记一键发送给 DSH Agent（TiddlyWiki → DSH 会话注入）"
		});
		wrote = true;
	}
	await writeSeedMarker(client, SEND_TO_AGENT_MARKER_TITLE);
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
		"text": "\\whitespace trim\n\n\\define quadrant-board()\n<div style=\"display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px;\">\n<$droppable class=\"tc-quadrant tc-quadrant-q1\" effect=\"move\"\nstyle.border=\"1px solid rgba(128,128,128,0.22)\"\nstyle.border-radius=\"10px\"\nstyle.padding=\"8px 12px\"\nstyle.background=\"linear-gradient(135deg,#e74c3c1a,transparent)\"\nactions=\"\"\"<$action-setfield $tiddler=<<actionTiddler>> $field=\"q\" $value=\"q1\"/>\"\"\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🔴 重要 · 紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q1]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q1]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q1]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</$droppable>\n<$droppable class=\"tc-quadrant tc-quadrant-q2\" effect=\"move\"\nstyle.border=\"1px solid rgba(128,128,128,0.22)\"\nstyle.border-radius=\"10px\"\nstyle.padding=\"8px 12px\"\nstyle.background=\"linear-gradient(135deg,#3498db1a,transparent)\"\nactions=\"\"\"<$action-setfield $tiddler=<<actionTiddler>> $field=\"q\" $value=\"q2\"/>\"\"\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🔵 重要 · 不紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q2]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q2]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q2]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</$droppable>\n<$droppable class=\"tc-quadrant tc-quadrant-q3\" effect=\"move\"\nstyle.border=\"1px solid rgba(128,128,128,0.22)\"\nstyle.border-radius=\"10px\"\nstyle.padding=\"8px 12px\"\nstyle.background=\"linear-gradient(135deg,#f39c121a,transparent)\"\nactions=\"\"\"<$action-setfield $tiddler=<<actionTiddler>> $field=\"q\" $value=\"q3\"/>\"\"\">\n<div style=\"font-weight:700; margin-bottom:6px;\">🟠 紧急 · 不重要 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q3]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q3]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q3]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</$droppable>\n<$droppable class=\"tc-quadrant tc-quadrant-q4\" effect=\"move\"\nstyle.border=\"1px solid rgba(128,128,128,0.22)\"\nstyle.border-radius=\"10px\"\nstyle.padding=\"8px 12px\"\nstyle.background=\"linear-gradient(135deg,#95a5a61a,transparent)\"\nactions=\"\"\"<$action-setfield $tiddler=<<actionTiddler>> $field=\"q\" $value=\"q4\"/>\"\"\">\n<div style=\"font-weight:700; margin-bottom:6px;\">⚪ 不重要 · 不紧急 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]field:q[q4]count[]]}}} 件</span></div>\n<$list filter=\"[tag[todo]!tag[done]field:q[q4]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n<$list filter=\"[<currentTiddler>get[due]!is[blank]]\"><span style=\"color:#888; font-size:0.8em;\"><$view field=\"due\" format=\"date\" template=\"MM-DD\"/></span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]field:q[q4]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无）</div></$list>\n</$droppable>\n</div>\n\\end\n\n<$set name=\"today\" value=<<now \"YYYY0MM0DD\">>>\n\n!! 🏠 主页\n\n<div class=\"tc-message-box\">待办看板与知识库入口。</div>\n\n<div style=\"display:flex; gap:8px; flex-wrap:wrap; margin:8px 0;\">\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"padding:6px 16px; border:1px solid rgba(128,128,128,0.35); border-radius:8px; font-weight:600;\">\n<$action-navigate $to=\"所有标签\"/>\n🏷 所有标签\n</$button>\n<$button class=\"tc-btn-invisible tc-tiddlylink\" style=\"padding:6px 16px; border:1px solid rgba(128,128,128,0.35); border-radius:8px; font-weight:600;\">\n<$action-navigate $to=\"所有文章\"/>\n📚 所有文章\n</$button>\n</div>\n\n!! 📚 插件文档\n\n<div class=\"tc-message-box\">这里收纳插件初始化时 seed 进来的说明 / 教程 / 模板。给新文档打上 <code>dsh-docs</code> 标签即自动出现在本栏；不需要可自由删除（删除后不会自动恢复）。</div>\n\n<<tabs \"[tag[dsh-docs]!is[system]]\" \"dsh-tiddlywiki 插件说明\">>\n\n!! ✍️ 快速记笔记（完整编辑器）\n\n<div class=\"tc-message-box\">直接在首页写笔记：填标题、用工具栏写正文（支持 Markdown：**加粗**、*斜体*、# 标题、- 列表、> 引用 等）、加标签，点「💾 保存」即创建新笔记（默认 Markdown，标题留空用当前时间）。勾选「同时加入待办」并选象限，可一并进入下方四象限看板。</div>\n\n<div style=\"border:1px solid rgba(128,128,128,0.22); border-radius:10px; padding:10px 12px; margin:10px 0;\">\n\n<div style=\"display:flex; gap:6px; align-items:center; margin-bottom:6px;\">\n<$edit-text tiddler=\"$:/state/home-note/title\" tag=\"input\" placeholder=\"标题（留空用当前时间）\" style=\"flex:1; min-width:200px; padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\"/>\n</div>\n\n<$edit-text tiddler=\"$:/state/home-note/text\" tag=\"textarea\" class=\"tc-edit-texteditor\" autoHeight=\"yes\" minHeight=\"150px\" placeholder=\"正文：支持 **加粗**、*斜体*、# 标题、- 列表、> 引用 等 Markdown 语法\" style=\"width:100%; box-sizing:border-box; padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\">\n<$button class=\"tc-btn-invisible\" tooltip=\"加粗\" style=\"padding:2px 8px; font-weight:700;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"wrap-selection\" prefix=\"**\" suffix=\"**\" trimSelection=\"yes\"/>B</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"斜体\" style=\"padding:2px 8px; font-style:italic;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"wrap-selection\" prefix=\"*\" suffix=\"*\" trimSelection=\"yes\"/>I</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"删除线\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"wrap-selection\" prefix=\"~~\" suffix=\"~~\" trimSelection=\"yes\"/>S</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"标题\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"prefix-lines\" character=\"#\" count=\"1\"/>H</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"无序列表\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"prefix-lines\" character=\"-\" count=\"1\"/>•</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"有序列表\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"prefix-lines\" character=\"1.\" count=\"1\"/>1.</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"引用\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"prefix-lines\" character=\">\" count=\"1\"/>❝</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"行内代码\" style=\"padding:2px 8px;\"><$action-sendmessage $message=\"tm-edit-text-operation\" $param=\"wrap-selection\" prefix=\"`\" suffix=\"`\" trimSelection=\"yes\"/>&lt;/&gt;</$button>\n</$edit-text>\n\n<div style=\"display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:6px;\">\n<$edit-text tiddler=\"$:/state/home-note/tags\" tag=\"input\" placeholder=\"标签（逗号分隔，可选）\" style=\"flex:1; min-width:160px; padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\"/>\n<$checkbox tiddler=\"$:/state/home-note/todo\" field=\"text\" checked=\"yes\" unchecked=\"no\"> 同时加入待办</$checkbox>\n<$select tiddler=\"$:/state/home-note/quadrant\" default=\"q2\" style=\"padding:6px 10px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\">\n<option value=\"q1\">Q1 重要·紧急</option>\n<option value=\"q2\">Q2 重要·不紧急</option>\n<option value=\"q3\">Q3 紧急·不重要</option>\n<option value=\"q4\">Q4 不重要·不紧急</option>\n</$select>\n</div>\n\n<div style=\"display:flex; gap:6px; align-items:center; margin-top:8px; flex-wrap:wrap;\">\n<$button class=\"tc-btn-invisible\" style=\"padding:6px 16px; border-radius:6px; border:1px solid rgba(128,128,128,0.35); font-weight:600; background:rgba(128,128,128,0.06);\">\n<$list filter=\"[{$:/state/home-note/title}!is[blank]] [{$:/state/home-note/text}!is[blank]]\">\n<$action-createtiddler\n$basetitle={{{ [{$:/state/home-note/title}!is[blank]then{$:/state/home-note/title}] ~[<now \"YYYY-0MM-0DD-0hh0mm\">] }}}\ntext={{{ [{$:/state/home-note/text}] }}}\ntags={{{ [{$:/state/home-note/tags}split[,]split[，]trim[]] [{$:/state/home-note/todo}match[yes]then[todo]] +[join[ ]] }}}\nq={{{ [{$:/state/home-note/todo}match[yes]then{$:/state/home-note/quadrant}!is[blank]] ~[{$:/state/home-note/todo}match[yes]then[q2]] }}}\ntype=\"text/markdown\"\n$savetitle=\"$:/temp/home-note/last-created\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/title\" text=\"\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/text\" text=\"\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/tags\" text=\"\"/>\n</$list>\n💾 保存\n</$button>\n<$button class=\"tc-btn-invisible\" tooltip=\"清空草稿\" style=\"padding:6px 12px; border-radius:6px; border:1px solid rgba(128,128,128,0.3);\">\n<$action-setfield $tiddler=\"$:/state/home-note/title\" text=\"\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/text\" text=\"\"/>\n<$action-setfield $tiddler=\"$:/state/home-note/tags\" text=\"\"/>\n🗑 清空\n</$button>\n<$list filter=\"[{$:/temp/home-note/last-created}!is[blank]]\">\n<span style=\"color:#2e7d32; font-size:0.9em;\">✅ 已保存：<$link to={{{ [{$:/temp/home-note/last-created}] }}}>{{{$:/temp/home-note/last-created}}}</$link></span>\n</$list>\n</div>\n\n</div>\n\n!! ✅ 待办 · 四象限\n\n<div class=\"tc-message-box\">在上方「快速记笔记」勾选「同时加入待办」即建任务（默认 Q2 重要·不紧急）；也可以给任意笔记打上 <code>todo</code> 标签收集到下方。点任务左侧方框即完成（自动加 <code>done</code> 标签并从看板消失）。下方「未分类待办」可直接拖动到上方任一象限，拖入即自动写入 <code>q</code> 字段完成分类（象限之间也可互相拖动调整）；把象限中的待办拖回「未分类」可取消分类。</div>\n\n<div style=\"margin:6px 0; color:#555;\">📅 今日到期 <b>{{{[tag[todo]!tag[done]field:due<today>count[]]}}}</b> 件　·　⏰ 已逾期 <b>{{{[tag[todo]!tag[done]get[due]compare:date:lt<today>count[]]}}}</b> 件</div>\n\n<<quadrant-board>>\n\n<div style=\"margin-top:10px; border:1px dashed rgba(128,128,128,0.35); border-radius:10px; padding:8px 12px;\">\n<div style=\"font-weight:700; margin-bottom:6px;\">📥 未分类待办 <span style=\"color:#888; font-weight:400; font-size:0.82em;\">{{{[tag[todo]!tag[done]!has[q]count[]]}}} 件</span> <span style=\"color:#aaa; font-weight:400; font-size:0.78em;\">· 拖到上方象限自动分类</span></div>\n<$droppable class=\"tc-todo-inbox\" effect=\"move\" actions=\"\"\"<$action-deletefield $tiddler=<<actionTiddler>> $field=\"q\"/>\"\"\">\n<$list filter=\"[tag[todo]!tag[done]!has[q]sort[modified]]\">\n<div style=\"display:flex; gap:6px; align-items:baseline; padding:3px 0; border-bottom:1px dashed rgba(128,128,128,0.15);\">\n<$checkbox tiddler=<<currentTiddler>> tag=\"done\"/>\n<$link to=<<currentTiddler>> style=\"flex:1; cursor:grab;\"><$view field=\"title\"/></$link>\n<$list filter=\"[<currentTiddler>get[due]compare:date:lt<today>]\"><span style=\"color:#c0392b; font-size:0.78em;\">逾期</span></$list>\n</div>\n</$list>\n<$list filter=\"[tag[todo]!tag[done]!has[q]count[]match[0]]\"><div style=\"color:#aaa; font-size:0.85em;\">（暂无 · 把象限中的待办拖回这里可取消分类）</div></$list>\n</$droppable>\n</div>\n\n</$set>\n"
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
* for "重新初始化". Returns whether anything was written this call. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function seedHomeIndex(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-home-index") !== void 0) return false;
	}
	let wrote = false;
	for (const item of HOME_INDEX_ITEMS) {
		const existing = await readSeedTiddler(client, item.title);
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
	const dt = await readSeedTiddler(client, "$:/DefaultTiddlers");
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
	await writeSeedMarker(client, HOME_INDEX_MARKER_TITLE);
	return wrote;
}
/**
* Un-seed (反初始化): remove the home tiddlers and their marker, restoring the
* wiki's default home only when it still points at the seeded 🏠 主页
* (a user-customised $:/DefaultTiddlers is left alone). Deletion is idempotent —
* a tiddler already gone is not listed. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function unseedHomeIndex(client) {
	const removed = [];
	for (const item of HOME_INDEX_ITEMS) if (await readSeedTiddler(client, item.title) !== void 0) {
		await client.delete(item.title);
		removed.push(item.title);
	}
	if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-home-index") !== void 0) {
		await client.delete(HOME_INDEX_MARKER_TITLE);
		removed.push(HOME_INDEX_MARKER_TITLE);
	}
	const dt = await readSeedTiddler(client, "$:/DefaultTiddlers");
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
* "重新初始化". Returns whether the page was written this call. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function seedAllArticles(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-all-articles") !== void 0) return false;
	}
	const existing = await readSeedTiddler(client, ALL_ARTICLES_TITLE);
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
	await writeSeedMarker(client, ALL_ARTICLES_MARKER_TITLE);
	return wrote;
}
/**
* Un-seed (反初始化): remove the 所有文章 page and its one-shot marker.
* Deletion is idempotent — a tiddler that was already gone is not listed.
* Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function unseedAllArticles(client) {
	const removed = [];
	for (const title of [ALL_ARTICLES_TITLE, ALL_ARTICLES_MARKER_TITLE]) if (await readSeedTiddler(client, title) !== void 0) {
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
* "重新初始化". Returns whether anything was written this call. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function seedUiStyles(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-ui-styles") !== void 0) return false;
	}
	let wrote = false;
	for (const item of UI_STYLE_ITEMS) {
		const existing = await readSeedTiddler(client, item.title);
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
	await writeSeedMarker(client, UI_STYLES_MARKER_TITLE);
	return wrote;
}
/**
* Un-seed (反初始化): remove the stylesheet tiddlers and their marker.
* Deletion is idempotent — a tiddler already gone is not listed. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function unseedUiStyles(client) {
	const removed = [];
	for (const item of UI_STYLE_ITEMS) if (await readSeedTiddler(client, item.title) !== void 0) {
		await client.delete(item.title);
		removed.push(item.title);
	}
	if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-ui-styles") !== void 0) {
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
* for "重新初始化". Returns whether anything was written this call. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function seedMenubarTheme(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-menubar-theme") !== void 0) return false;
	}
	const existing = await readSeedTiddler(client, MENUBAR_THEME_TIDDLER);
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
	await writeSeedMarker(client, MENUBAR_THEME_MARKER_TITLE);
	return wrote;
}
/**
* Un-seed (反初始化): remove the menubar override stylesheet and its marker,
* returning the wiki to the pre-seed state (the tiddlywiki/menubar top bar
* falls back to its original colour-mapping behaviour). Deletion is
* idempotent — a tiddler already gone is not listed. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function unseedMenubarTheme(client) {
	const removed = [];
	for (const title of [MENUBAR_THEME_TIDDLER, MENUBAR_THEME_MARKER_TITLE]) if (await readSeedTiddler(client, title) !== void 0) {
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
/**
* The drag-install href: `javascript:` + percent-ENCODED code. v0.16.27 used
* HTML-entity escaping (&quot;/&amp;/&lt;) which BREAKS dragged bookmarks —
* real-Chrome experiment: `a.href` keeps the raw attribute (no entity decode),
* so the stored bookmark executes the entitized text → SyntaxError. Chrome
* DOES percent-decode javascript: URLs before executing (verified: encoded
* alert sets a flag), and %XX needs no attribute escaping — so encoding is the
* correct distribution form. decodeURIComponent(encoded) === the clean code
* (guarded in verify-clip-bridge.mjs).
*/
const CLIP_BRIDGE_DRAG_HREF = `javascript:${encodeURIComponent(CLIP_BRIDGE_BOOKMARKLET.slice(11))}`;
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

   <a href="${CLIP_BRIDGE_DRAG_HREF}" draggable="true" title="按住我，拖到浏览器书签栏即可安装" style="display:inline-block;padding:8px 16px;border-radius:8px;background:#2f6feb;color:#fff;text-decoration:none;font-size:14px;cursor:grab;margin:4px 0">📌 剪藏 — 拖到书签栏</a>

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
* Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function seedClipBridge(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-clip-bridge") !== void 0) return false;
	}
	const existing = await readSeedTiddler(client, CLIP_BRIDGE_DOC_TITLE);
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
	await writeSeedMarker(client, CLIP_BRIDGE_MARKER_TITLE);
	return wrote;
}
/** 反初始化: remove the doc tiddler + its one-shot marker (idempotent). */
async function unseedClipBridge(client) {
	const removed = [];
	for (const title of [CLIP_BRIDGE_DOC_TITLE, CLIP_BRIDGE_MARKER_TITLE]) if (await readSeedTiddler(client, title) !== void 0) {
		await client.delete(title);
		removed.push(title);
	}
	return { removed };
}
//#endregion
//#region src/host/seed-publish-spec.ts
/** The spec tiddler's title (a normal, searchable note; also the pointer target). */
const PUBLISH_SPEC_TITLE = "发布元数据规范";
/** One-time marker: presence = "the doc was offered once — hands off". */
const PUBLISH_SPEC_MARKER_TITLE = "$:/dsh-tiddlywiki/publish-spec-seeded";
/**
* The doc body. Markdown (the plugin's default note type). Kept deliberately
* concrete: an agent must be able to pick the right field without guessing.
*/
const PUBLISH_SPEC_TEXT = `# 发布元数据规范

> 用途：记录每篇笔记**对外发布的状态**，让 agent 在发布前能判断「这篇发过没有 / 能不能发」。
> 由 \`tools/wechat/\` 的发布流程使用；插件与 agent 都以此文件为唯一事实来源。

## 为什么需要它

wiki 里既有**早已发到公众号**的文章，也有**明确不能发**的内容（草稿、私事、未定稿）。
没有这层元数据，agent 只能靠猜——要么重复发布已上线的文章，要么把不该发的推出去。

## 字段（自定义字段，不是标签）

按**平台分字段**，便于将来加平台（\`pub-zhihu-*\`、\`pub-juejin-*\` 直接平铺）：

| 字段 | 含义 | 取值示例 |
|---|---|---|
| \`pub-state\` | 能不能发 | \`draft\`（未发，可发）/ \`published\`（已发）/ \`excluded\`（明确不发） |
| \`pub-platform\` | 最近发布的平台（多平台用逗号） | \`wechat\` 或 \`wechat,zhihu\` |
| \`pub-wechat-at\` | 公众号发表时间 | \`2026-09-17 15:30\` |
| \`pub-wechat-title\` | **发表时用的标题**（仅在和 TW 标题不同才写） | \`中年失业自救指南\` |
| \`pub-wechat-url\` | 发表后的链接 | \`https://mp.weixin.qq.com/s/xxx\` |
| \`pub-note\` | 备注（人看的补充说明） | \`删改后重发过一版\` |

**没有 \`pub-state\` 的条目 = 未知状态**。agent 应当把它当作「需要人确认」，而不是「可以随便发」。

## 标签（给人看的镜像）

\`\`\`
no-publish   ← 明确不可发布（与 pub-state: excluded 保持一致）
\`\`\`

标签的好处是 TW 界面里一眼可见、可点进去列出全部不可发条目；
\`pub-state\` 则是给 agent 程序化判断用的。**两者应保持一致**——如果只改一个，以字段为准。

## agent 的发布前检查（约定）

发布前**按顺序**做三件事：

1. 读 \`pub-state\`：是 \`published\` → **默认不重发**，除非用户明确要求或带 \`--force\`。
2. 看 \`no-publish\` 标签 / \`pub-state: excluded\` → **提醒用户这篇被标为不可发**。
3. 都通过 → 发布。

⚠️ **当前策略是「只告警，不阻断」**：adapter 发现上述情况会打印醒目警告并继续执行，
由用户/agent 决定是否中止。**不要**把警告当失败。

## 发布后回写（agent 负责）

发布成功后，agent 用 \`tiddlywiki_put\` 把这几个字段写回该笔记：

\`\`\`
pub-state: published
pub-platform: wechat
pub-wechat-at: <发表时间，从 adapter 输出或当前时间取>
pub-wechat-title: <仅当与 TW 标题不同时>
pub-wechat-url: <若能拿到>
\`\`\`

⚠️ \`tiddlywiki_put\` 覆盖时**不传 \`tags\` 就保留原标签**、只补 \`fields\` 里的自定义字段，
所以回写不会动到既有标签与正文。

## 存量回填

早于本规范、来源可辨的公众号文章，用 \`source-path\` 判定：路径含 \`公众号\` 的
（如 \`Articles\\公众号\\杂七杂八\\打工记.md\`）即视为已发布，回填：

\`\`\`
pub-state: published
pub-platform: wechat
\`\`\`

发表时间若无法考证就**留空**——不要编造时间。

## 相关

- 发布工具与安装说明见仓库 \`tools/wechat/\` 与 \`docs/wechat-publish-setup.md\`
- 设计依据见 \`docs/plans/2026-09-17-wechat-publish-design.md\`

> 本文档属于**可选功能**：只有设置页开启「微信公众号发布」（\`wechat.enabled\`）时，
> 插件才会在启动时写入它；关闭时不写、也不注入任何发布相关提示词。
> 因此「打开设置开关」与「本文档存在」应当是同进同退的。
`;
/** Write the doc + marker (ONE-SHOT when \`force\` is false). */
async function seedPublishSpec(client, opts) {
	if (!(opts?.force === true)) {
		if (await readSeedTiddler(client, "$:/dsh-tiddlywiki/publish-spec-seeded") !== void 0) return false;
	}
	await client.put({
		title: PUBLISH_SPEC_TITLE,
		text: PUBLISH_SPEC_TEXT,
		tags: ["dsh-docs", "dsh-tiddlywiki"],
		type: "text/markdown"
	});
	await writeSeedMarker(client, PUBLISH_SPEC_MARKER_TITLE, { [PUBLISH_SPEC_TITLE]: hashText(PUBLISH_SPEC_TEXT) });
	return true;
}
/** Remove the doc + marker (反初始化). */
async function unseedPublishSpec(client) {
	const removed = [];
	for (const title of [PUBLISH_SPEC_TITLE, PUBLISH_SPEC_MARKER_TITLE]) try {
		await client.delete(title);
		removed.push(title);
	} catch {}
	return { removed };
}
//#endregion
//#region src/host/seed-wechat-docs.ts
/** The guide tiddler's title (a normal, searchable note; tagged dsh-docs). */
const WECHAT_DOCS_TITLE = "微信公众号发布指南";
/** One-time marker: presence = "the doc was offered once — hands off". */
const WECHAT_DOCS_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-wechat-docs";
/**
* The guide body — byte-identical to docs/wechat-publish-setup.md (the seed
* registry's `content` declaration re-exports the same constant, so the
* v0.22.0 content-hash bookkeeping guards exactly these bytes).
*/
const WECHAT_DOCS_TEXT = "# 微信公众号发布：换机器还原指南\n\n> **这是可选功能，默认关闭，需要额外安装。** 插件本体**不含**它：真正干活的是仓库\n> `tools/wechat/` 下的 opencli adapter + Browser Bridge 浏览器扩展。**不安装／不开启，\n> 插件的其他功能完全不受影响**（不注入发布相关提示词、不往 wiki 写发布规范文档）。\n>\n> 目的：在**另一台机器**上无缝还原「TiddlyWiki 笔记 → 微信公众号」的发布能力。\n> 本机（开发机）已验证全程可跑；本文按顺序照做即可复现。\n>\n> 关键结论先讲：**整套发布走浏览器自动化，不依赖公众号服务端 API**——因为\n> 2025-07 起官方已回收个人主体账号的「发布能力」接口权限（详见 §5）。\n\n---\n\n## 0. 它是可选功能：需要什么、不影响什么\n\n| | 说明 |\n|---|---|\n| **默认状态** | **关闭**（`wechat.enabled` 默认 `false`） |\n| **开启方式** | DSH 设置 →「TiddlyWiki 知识库」→「可选功能：微信公众号发布」→ 勾选 → 保存配置 |\n| **开启后有什么变化** | ① 注入提示词多一行「发布前先读发布元数据规范」；② 启动时把该规范文档写进 wiki（同名不覆盖）。**仅此两项**——不会安装任何东西、不会启用任何后台服务 |\n| **不开启会怎样** | 提示词里没有发布相关文字；wiki 里不会出现「发布元数据规范」；其他功能一切照旧 |\n| **插件会替你做安装吗** | **不会**。opencli 与浏览器扩展必须你手动装（见 §1–§2）——这属于插件外部的工具链 |\n| **要额外装什么** | ① opencli（npm 包）② Browser Bridge 浏览器扩展 ③ 浏览器登录公众号 |\n| **凭据如何保存** | 不保存任何凭据：复用浏览器已有登录态（cookie）。脚本不接触 AppSecret |\n\n> 一句话：**开关只控制「插件要不要配合这个流程」，不负责装工具链。**\n\n---\n\n## 1. 一分钟总览\n\n```\nTiddlyWiki 笔记（tiddler）\n   │  标题\n   ▼\nDSH 的 POST /dsh-tiddlywiki/render        ← TW 自己渲染成语义 HTML（含代码高亮）\n   │  纯语义 HTML（无内联样式）\n   ▼\nwechat-html.js  decorate()                ← 补内联样式（微信唯一认的形式）\n   │  带内联样式的 HTML\n   ▼\nopencli + Browser Bridge 扩展             ← 驱动你已登录的浏览器\n   │  填标题/作者/摘要 + insertHTML 写正文 + 传图 + 设封面 + 存草稿\n   ▼\n公众号草稿箱（mp.weixin.qq.com）\n   │  （可选 --publish）\n   ▼\n点「发表」→ ⚠️ 管理员扫码确认 → 发布成功\n```\n\n**一条命令**（在第二台机器上，装好后）：\n\n```bash\nopencli weixin publish-note \"笔记标题\" --trace retain-on-failure -f json\n```\n\n---\n\n## 1. 需要安装/准备的东西\n\n按顺序做；**最后一步才是打开插件里的开关**（开关只影响提示词与文档，装不上工具链）。\n\n| # | 项目 | 怎么装 | 验证 |\n|---|---|---|---|\n| 1 | **Node.js ≥ 22** | 官网安装包 | `node -v` |\n| 2 | **DSH** + **dsh-tiddlywiki 插件** | 本仓库的插件（含 wiki） | `curl http://127.0.0.1:3080/dsh-tiddlywiki/status` |\n| 3 | **opencli** | `npm install -g @jackwener/opencli` | `opencli --version` |\n| 4 | **Browser Bridge 扩展** | 见 §2（二选一） | `opencli doctor` 显示 `Extension: connected` |\n| 5 | **Chrome/Edge + 公众号登录** | 浏览器登录 mp.weixin.qq.com | 能进后台首页 |\n| 6 | **本仓库的 adapter** | `node tools/wechat/install-wechat-adapters.mjs` | 脚本自检输出 ✔ |\n| 7 | **打开插件开关** | 设置 →「TiddlyWiki 知识库」→「可选功能：微信公众号发布」勾选 → 保存配置 | 提示词预览里出现「发布元数据规范」一行 |\n\n> **opencli 版本建议 ≥ 1.8.7**（本方案在该版本实测通过；1.7.x 的 `browser`\n> 子命令语法不同，且内置 weixin adapter 不完整）。\n>\n> **新版 npm 的 allowScripts 机制会拦 opencli 的 postinstall 脚本**（安装时打\n> warning）：**无害，可忽略**——postinstall 只装 bash/zsh/fish 补全（Windows 用不上），\n> adapters 随 npm 包自带，功能不受影响。\n>\n> 第 7 步之前，插件不会注入任何发布相关提示词、也不会往 wiki 写「发布元数据规范」。\n> 也就是说：**没装好工具链时开关可以一直关着，不影响任何其他功能。**\n\n### 自动化的终点：草稿箱（2026-09-17 与用户确认的策略）\n\n**adapter 负责到「草稿落盘」为止**：填标题/作者/摘要、写正文、传图、设封面、存草稿。\n**发表由人工在后台完成**——点「发表」时平台会弹确认对话框（原创声明、作者、留言\n设置等）以及最后的管理员扫码；原创声明涉及账号权益，人工点最稳妥。`--publish`\n选项保留（best-effort：点「发表」后轮询等扫码），但**不处理中途弹窗**，遇到弹窗\n会一直等到超时。\n\n---\n\n## 2. 安装 Browser Bridge 扩展（关键前置）\n\n扩展**不在 npm 包里**，必须单独装。二选一：\n\n**方式 A — Chrome Web Store（推荐）**\n1. 打开 https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk\n2. 点「添加至 Chrome」\n\n**方式 B — GitHub Releases（Web Store 打不开时）**\n1. 到 https://github.com/jackwener/opencli/releases 下载 `opencli-extension-v*.zip`\n2. 解压到某个固定目录\n3. 浏览器打开 `chrome://extensions` → 开启右上角「开发者模式」\n4. 点「加载已解压的扩展程序」→ 选择解压出的目录\n\n> ⚠️ GitHub 的 ext release **经常落后于 Web Store**（2026-09-17 实测只到\n> `ext-v1.0.21`，Web Store 已是 1.0.24）。**扩展版本以 Chrome Web Store 为准**；\n> GitHub 方式只作 Web Store 打不开时的离线兜底。\n\n**验证**：\n\n```bash\nopencli doctor\n# 期望： [OK] Daemon: running ...\n#        [OK] Extension: connected (vX.Y.Z)\n#        [OK] Connectivity: connected\n#        Everything looks good!\n```\n\n若报 `Extension: not connected`：确认浏览器在运行、扩展已启用；再 `opencli daemon stop` 后重跑 `opencli doctor`（daemon 会自动重启）。\n\n---\n\n## 3. 装 adapter 并试跑\n\n```bash\ncd <本仓库>\nnode tools/wechat/install-wechat-adapters.mjs\n```\n\n脚本会把 `tools/wechat/*.js` 复制到 `~/.opencli/clis/weixin/`（Windows：`C:\\Users\\<你>\\.opencli\\clis\\weixin\\`）。\n这些是**私有 adapter**，放在该目录即可被 opencli 自动发现，**无需任何构建**。\n\n然后：\n\n```bash\n# ① 先干跑：只做 TW 渲染 + 排版装饰，导出预览，不碰微信\nopencli weixin publish-note \"某篇笔记标题\" --preview ./out --trace retain-on-failure\n\n#    → 用浏览器打开 ./out.html 肉眼确认排版\n#    （注意：--preview 仍会继续执行发布流程；只想预览时看文件即可，或 Ctrl-C）\n\n# ② 真发到草稿箱\nopencli weixin publish-note \"某篇笔记标题\" --trace retain-on-failure -f json\n\n# ③ 带封面（公众号封面必填，否则草稿显示\"内容不完整\"）\nopencli weixin publish-note \"某篇笔记标题\" --cover ./cover.png --trace retain-on-failure -f json\n\n# ④ 直接发表（⚠️ 会真发文章，需管理员扫码）\nopencli weixin publish-note \"某篇笔记标题\" --publish --trace retain-on-failure -f json\n\n# ⑤ 正文多图（v0.23.2+）：TW 笔记内嵌 [img[...]] 经 /render 变成 data URI，\n#    publish-note 传不了（微信存草稿时过滤非 mmbiz 图）——用 publish-note-imgs：\nopencli weixin publish-note-imgs \"某篇笔记标题\" --images <图片目录> --trace retain-on-failure -f json\nopencli weixin publish-note-imgs \"某篇笔记标题\" --images \"01.png|02.png|03.png\" -f json\n#    · --images 传目录时按文件名排序 = 正文图片出现顺序（封面图排第一）\n#    · 也可用 | 分隔的路径列表精确指定顺序\n#    · 流程：先逐张上传 CDN → 按 DOM 顺序重写正文 src → insertHTML → 选封面 → 存草稿\n#    · 发表前同样读 pub-state / no-publish（只告警不阻断），--publish 可直接发表\n```\n\n### 3.6 在 TiddlyWiki 里点按钮发布（v0.23.3，日常推荐）\n\n不想敲命令时，用**笔记工具栏的「发布到公众号」按钮**（嵌入式 TW 面板、右侧栏 tab、原生编辑弹窗里都在）：\n\n1. 设置页勾选「可选功能：微信公众号发布」并保存 → 重启 dsh web 后，启动 seed 会把按钮插件\n   `$:/plugins/dsh/wechat-publish` 写进 wiki（老 wiki 也可在设置页「初始化」区单独写它）。\n2. 打开任意笔记 → 工具栏点「发布到公众号」→ 按钮**先预检**（opencli 跑不跑得起来、adapter 缺哪些文件），\n   再弹确认框（自动列出 `no-publish` / `pub-state` 警告）→ 点「开始存草稿」。\n3. 宿主进程起一个**后台任务**，覆盖层每 2 秒显示状态与日志尾部。**只到草稿箱为止，不自动发表。**\n\n按钮背后的三条路由（同源；写操作有方法 + CSRF 守卫；`wechat.enabled` 关着时一律 403）：\n\n| 路由 | 方法 | 作用 |\n|---|---|---|\n| `/dsh-tiddlywiki/wechat/ready` | GET | 预检：`opencli --version` 能否跑通、adapter 缺哪些文件 |\n| `/dsh-tiddlywiki/wechat/publish` | POST | 起任务（body `{title, adapter?}`）；单并发，第二次调用 409 |\n| `/dsh-tiddlywiki/wechat/publish/status` | GET | 轮询任务（`?id=`；不带 id 取最新/正在跑的那个） |\n\n可配项（设置页目前只暴露 `enabled`，其余写进配置 tiddler\n`$:/plugins/dsh-tiddlywiki/config` 的 `wechat` 块，保存即生效）：\n\n| 键 | 默认 | 说明 |\n|---|---|---|\n| `wechat.enabled` | `false` | 总开关；关着时按钮不写入、三条路由 403 |\n| `wechat.adapter` | `publish-note` | 换成 `publish-note-imgs` 走正文内嵌多图（需该 adapter 已装） |\n| `wechat.command` | `opencli` | CLI 路径（装了别名、不在 PATH 时用） |\n| `wechat.token` | 空 | 非空时要求请求头 `x-wechat-publish-token`（按钮会自动带上） |\n| `wechat.dsn` | 空 | adapter 回连 DSH 的基址；留空按请求端口推导 `http://127.0.0.1:<端口>/dsh-tiddlywiki` |\n| `wechat.endpoint` | 空 | **只被 TW 侧读**：覆盖按钮请求的基址（默认 `location.origin + /dsh-tiddlywiki`）；反向代理/远程访问场景用 |\n\n⚠️ 宿主用 **`--title-file`**（v0.23.3 新增参数）把标题经 UTF-8 文件交给 adapter：标题不进 argv，\n否则 Windows 上 `opencli` 的 `.cmd` shim 会把 `&`/`|`/`^` 当命令分隔符，中文标题还会被 cmd 的\n代码页解码成乱码。位置参数 `<title>` 照旧可用（两者都给时位置参数优先）。\n⚠️ 按钮**不替你发表**：发表要管理员扫码（§4.2），请在公众号后台点「发表」。\n\n---\n\n## 3.5 发布元数据（重要：避免重发/误发）\n\nwiki 里既有**早已发布**的文章，也有**明确不能发**的内容。没有记录，agent 只能猜——\n要么重复发已上线的，要么把不该发的推出去。\n\n**规范全文在 wiki 里**：笔记「**发布元数据规范**」（随插件 seed 分发，`dsh-docs` 标签，\n开机自动写入；也可手动跑 `npx tsx tools/wechat/seed-publish-spec-now.mts` 立即写入）。\n注入给 agent 的系统提示词里只有一句指针（slim 预算只剩几十字符，放不下全文）。\n\n### 字段（自定义字段，不是标签）\n\n| 字段 | 含义 | 示例 |\n|---|---|---|\n| `pub-state` | 能不能发 | `draft` / `published` / `excluded` |\n| `pub-platform` | 最近发布的平台（多平台逗号分隔） | `wechat` |\n| `pub-wechat-at` | 公众号发表时间 | `2026-09-17 15:30` |\n| `pub-wechat-title` | 发表时的标题（**仅当与 TW 标题不同才写**） | `中年失业自救指南` |\n| `pub-wechat-url` | 发表后的链接 | `https://mp.weixin.qq.com/s/xxx` |\n| `pub-note` | 备注 | `删改后重发过一版` |\n\n**没有 `pub-state` = 未知状态**，应当当作「需要人确认」，而不是「可以随便发」。\n\n标签 `no-publish` 是给人看的镜像（TW 界面一眼可见、可筛）；`pub-state: excluded` 给\nagent 程序化判断。**两者应一致，冲突时以字段为准。**\n\n### ⚠️ 命名冲突（别占用）\n\n实测本 wiki 里这三个名字**已被占用**，方案特意避开：\n\n- `publish` / `publishyear` 字段 → Obsidian 导入的**书籍**条目用作「出版社 / 出版年」\n  （值形如「新世界出版社」「2011-09-01」）。\n- `发布记录` 标签 → 本插件自己的**版本发布说明**。\n\n### 发布前检查：只告警，不阻断\n\n`publish-note` 会读 `pub-state` / `no-publish`，命中就打印醒目警告，**然后继续执行**\n（2026-09-17 明确选定的策略）。`--force` 只改措辞，不改变行为：\n\n```\n⚠️ 「某篇」已发布过（平台 wechat）。这可能是重复发布——确认无误再继续；确实要重发请加 --force。\n```\n\n### 回写（agent 负责）\n\n发布成功后，命令的 `detail` 里会带一句**建议回写值**，例如：\n\n```\n建议回写：pub-state=published, pub-platform=wechat, pub-wechat-at=\"2026-09-17 17:50\"\n```\n\nagent 据此用 `tiddlywiki_put` 写回（**不传 `tags` 就保留原标签**，只补 `fields`）：\n\n```\ntiddlywiki_put(title=\"某篇\", text=<原正文>, fields={\"pub-state\":\"published\", \"pub-platform\":\"wechat\", \"pub-wechat-at\":\"...\"})\n```\n\n> ⚠️ 用工具时 `text` 会被覆盖，**务必带上原正文**。别像我一样用裸 REST PUT 只发一段\n> 文字——那会把笔记正文清空（真实踩过，靠 git 恢复）。\n\n### 存量回填\n\n早于本规范、来源可辨（`source-path` 含「公众号」）的文章，用脚本回填：\n\n```bash\n# 默认 dry-run，只打印将改什么\nnode tools/wechat/backfill-publish-state.mjs\n\n# 确认后真写\nnode tools/wechat/backfill-publish-state.mjs --write\n\n# 指定标题 / 平台 / 匹配子串\nnode tools/wechat/backfill-publish-state.mjs --title \"打工记\" --title \"鱼\" --write\nnode tools/wechat/backfill-publish-state.mjs --match 公众号 --platform wechat --write\n```\n\n脚本纪律（**请勿改成「只写字段」的裸 PUT**）：每条都先 GET **完整** tiddler（含\ntext/tags/type/created），**只添加** `pub-*` 字段后整体写回；已有 `pub-state` 的跳过\n（幂等）；正文为空的跳过（宁可不动）；**发表时间无法考证就留空，不编造**。\n\n---\n\n## 4. ⚠️ 三个必须知道的坑\n\n### 4.1 所有命令都要带 `--trace retain-on-failure`\n\n不带会对 `mp.weixin.qq.com` 稳定报：\n\n```\nNavigation rejected\n```\n\n**实测**：trace 开 → 5/5 成功；trace 关 → 8/8 失败。这是 opencli 1.8.7 的 bug\n（源码里 trace 只做录像，理论上不该影响导航）。已试过无效的绕法：\n`--site-session ephemeral`、`--keep-tab false`、`--window foreground/background`、\n重置标签页、重启 daemon。**唯一有效就是加 trace。**\n\n### 4.2 发表必须管理员扫码（无法自动化）\n\n后台点「发表」后，微信要求**管理员微信扫码确认**。这不是技术能绕开的账号安全机制。\n所以「一键发布」的真实含义是：\n\n> agent/脚本 完成素材、排版、上传、填表、进草稿箱 —— **你只需扫一次码**。\n\n`--publish` 会自动点「发表」并在终端提示你扫码，然后轮询结果（默认等 180s，\n可用 `--timeout` 调整）。\n\n### 4.3 「发表」≠「群发」（别搞混）\n\n| 操作 | 推送粉丝 | 占群发额度 | 需要扫码 |\n|---|---|---|---|\n| **发表**（本方案默认） | 否（仅生成永久链接） | 否，不限次数 | 是 |\n| **群发** | 是 | 个人订阅号 1 天 1 次 | 是 |\n\n两者都要扫码 → 默认选**不吃额度**的「发表」。\n\n### 4.4 发表阶段的确认弹窗 adapter 不处理（v0.23.x 现状）\n\n`publishDraft` 点完「发表」后**只轮询成功信号**，不会点任何平台弹窗。发表链路上\n还有：原创声明/作者/留言设置等**确认对话框**（2026-09-17 人工发表实测必经）与最后\n的管理员扫码。所以**推荐流程到草稿箱为止**（见 §1），发表环节人工做；`--publish`\n只是 best-effort，遇到弹窗会卡到超时。排错见 §8。\n\n---\n\n## 5. 为什么不用官方 API（背景，避免走回头路）\n\n公众号发布的服务端链路是 `access_token → draft/add → freepublish/submit`。但：\n\n- **2025 年 7 月起，官方回收「发布能力」接口对个人主体、企业未认证、不支持认证账号的调用权限**\n  （[发布能力文档](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html) 原文注）。\n  个人主体无法做微信认证 → `freepublish/submit` 不可用。\n- 草稿箱 `draft/add` 文档未列该限制，但 48001 / `api unauthorized` 是常见返回。\n- 即便可用，还叠加：**本机公网出口 IP 必须加入 API IP 白名单**（否则 61004/40164）、\n  封面 `thumb_media_id` 必须是**永久素材**、正文图片必须是 `media/uploadimg` 产出的\n  mmbiz 地址（外链图被过滤）。\n\n**而后台网页端从未受影响**——这是所有个人号日常发文的方式。所以本方案驱动网页端。\n\n---\n\n## 6. 文件清单（本方案包含什么）\n\n```\ntools/wechat/\n├── wechat-html.js      # 排版装饰器：语义 HTML → 内联样式 HTML（主题表在这里改）\n├── weixin-flow.js      # 浏览器流程：登录检测/填表/写正文/传图/设封面/存草稿/发表\n├── create-article.js   # 命令：从本地 HTML 文件建草稿（可选发表）\n├── publish-note.js     # 命令：从 TW 笔记建草稿（主入口，含 --preview；单图 --cover）\n├── publish-note-imgs.js # 命令：多图版——正文内嵌 data URI 图全部上传 CDN 再发布\n└── install-wechat-adapters.mjs  # 一键安装到 ~/.opencli/clis/weixin/\n```\n\n装到本机后对应 `~/.opencli/clis/weixin/` 下的同名文件。\n改排版只需改 `tools/wechat/wechat-html.js` 里的 `ELEMENT_STYLES`，重跑安装脚本即可。\n\n---\n\n## 7. 技术实现要点（改代码前必读）\n\n### 7.1 正文写入必须用 `insertHTML`，不能用 `insertText`\n\n微信编辑器是 **ProseMirror**。`document.execCommand('insertHTML', …)` 保留内联样式；\n`insertText` 会把 HTML/Markdown 当**字面文本**（opencli 内置的 `weixin create-draft`\n就是这样——实测后台 digest 里 `# 一级标题` 和 `**加粗**` 的符号原样保留）。\n\n### 7.2 图片上传必须用 DataTransfer，不能用 `page.setFileInput`\n\n`page.setFileInput` 依赖 CDP 的 `Page.fileChooserOpened` 事件，本机（opencli 1.8.7 +\n扩展 v1.0.24 + Edge）**稳定失败**：\n\n```\nPage.fileChooserOpened not received within 5s\n```\n\n（[issue #1582](https://github.com/jackwener/OpenCLI/issues/1582) 显示扩展/CLI 版本不匹配确有历史问题。）\n\n**绕过办法**——在页面上下文用 DataTransfer 直接把 File 塞进 `input.files`：\n\n```js\nconst bin = atob(base64)\nconst arr = new Uint8Array(bin.length)\nfor (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)\nconst file = new File([arr], 'cover.png', { type: 'image/png' })\nconst dt = new DataTransfer()\ndt.items.add(file)\ninput.files = dt.files\ninput.dispatchEvent(new Event('change', { bubbles: true }))\n```\n\n实测图片真的上了 `mmbiz.qpic.cn`。**代价：字节要以 base64 穿过 evaluate → 单图限 8MB。**\n\n### 7.3 微信编辑器会剥 `<style>` 和 class，只认内联 `style`\n\n实测：注入 `<style>h1{color:red}</style>` → `hasStyleTag: false`；\n注入 `style=\"font-size:20px\"` → 原样保留。\n而 **TiddlyWiki 的 `/render` 输出零内联样式**（纯语义 HTML + class）——\n这正是需要 `wechat-html.js` 装饰器的原因。\n\n### 7.4 轮询里绝不能读 `document.body.innerText`（v0.23.0 实测踩坑）\n\n微信编辑器 DOM 极大，读一次 `body.innerText` **强制整页 layout，实测单次 evaluate\n≈17 秒**。早期 `saveDraft` / `publishDraft` 的轮询用它找成功提示，8 次轮询把整个命令\n拖过 210s 超时——**最坑的是草稿其实已经保存成功**，用户看到的是超时失败（假阴性）。\n\n现在只查少量 toast 节点（`.weui-desktop-toast` / `.weui-desktop-msg` / `#js_save_success`）\n和 URL，都是 O(1) 操作。修复后 `saveDraft` 从 **137 秒降到 3.9 秒**。\n\n`scripts/verify-wechat-adapters.mjs` 有回归守门（已反向验证：塞回去即红）。\n\n### 7.5 其他踩过的坑\n\n- 图片下拉必须**按文案**点「本地上传」：用 `items[0]` 点完 file input 仍不可见。\n- 正文是编辑器页**最后一个** `contenteditable`。\n- 回读校验必须**忽略所有空白**：编辑器 innerText 会在块级元素间插空白、把空格转 nbsp，\n  直接用原始字符串比对必假阴性。\n- 保存按钮的文案兜底**特意不含「发表/发布」**，防止误点发布。\n- 草稿列表显示「图文内容不完整」**只表示缺封面**，不代表写入失败。\n- `<pre>` 内的 `<code>` 不能套用行内代码样式（粉底 + 内边距会很难看），\n  `wechat-html.js` 里用 `preDepth` 特判。\n\n---\n\n## 8. 排错\n\n| 现象 | 原因 / 处理 |\n|---|---|\n| `Navigation rejected` | 忘了 `--trace retain-on-failure` |\n| `AUTH_REQUIRED` / 提示登录 | 浏览器里 `mp.weixin.qq.com` 登录态过期 → 重新扫码登录 |\n| `Extension: not connected` | 扩展没装/没启用，或浏览器没运行 → 见 §2 |\n| `Page.fileChooserOpened not received` | 不应再出现（已改用 DataTransfer）；若出现说明源码被改回 setFileInput |\n| 找不到笔记 | tiddler 标题要**完全精确**（含空格/标点）；`opencli weixin publish-note \"标题\"` |\n| `/render 返回 HTTP 404` | 标题不存在；先用 `tiddlywiki_search` 或 TW 面板确认 |\n| 无法连接 DSH | `--dsn` 默认 `http://127.0.0.1:3080/dsh-tiddlywiki`；DSH 没跑或端口不同就改它 |\n| 草稿显示「内容不完整」 | 缺封面 → 传 `--cover`（或用 publish-note-imgs 从正文第一张自动设） |\n| 图片没上传 | 单图 > 8MB（DataTransfer 限制）→ 先压缩 |\n| 发表卡住超时 | 没扫码，或扫码没完成 → 调大 `--timeout`；若卡在原创声明/留言等确认弹窗 → 推荐流程本就到草稿箱为止，到后台人工点发表（见 §1、§4.4） |\n| `stale page identity` | 命令执行中标签页被手工关闭/导航了。**草稿不丢**——重开编辑页续作：`https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&appmsgid=<id>&idx=0&token=<token>`（token 用 `opencli browser wx eval 'location.href.match(/token=(\\d+)/)[1]'` 从后台首页取） |\n| 封面警告「设置失败」但草稿其实有封面 | 已知**误报**（校验时机太早）；以草稿箱实际显示为准（2026-09-17 实测：`list_ex` 接口 `cover` 字段已是 mmbiz 地址）。v0.23.2 起改为轮询校验 |\n| 用 eval 诊断后台状态时读到「未实名」「未设置头像和名称」等提示 | ⚠️ 后台 DOM 里常残留**不可见的历史 toast 节点**——查询必须过滤可见性（`offsetHeight > 0`），勿把残留文案当实时状态（2026-09-17 踩过：据此误判账号被平台拦截，实际账号正常并成功发表含原创声明）。同理，判断原创声明是否生效以草稿箱/发表记录为准，勿只看侧栏文案 |\n| 需要核实草稿是否落盘 | 后台 ajax：`/cgi-bin/appmsg?action=list_ex&type=77&orderby=create_time&token=<token>&f=json&begin=0&count=5`（在 mp.weixin.qq.com 页面上下文执行；`cover`/`digest`/`update_time` 一目了然）；发表记录：`/cgi-bin/appmsgpublish?sub=list&...&f=json`（`publish_page.publish_list[].publish_info` 里是 JSON 字符串，含 `content_url`） |\n\n---\n\n## 9. 安全与隐私\n\n- **不存任何公众号凭据**：全程复用浏览器已有登录态（cookie），脚本不接触 AppSecret。\n- **不落盘密钥**：adapter 只读本地图片路径，不写任何 token。\n- **低频使用**：不做规避风控的行为伪装；默认走「发表」（不推送粉丝、不占额度）。\n- wiki 里的配置 tiddler 与本方案无关——本方案零配置。\n\n---\n\n## 10. 参考\n\n- [opencli](https://github.com/jackwener/opencli) — 把网站变成 CLI，复用浏览器登录态\n- [微信「发布能力」文档（2025-07 权限回收）](https://developers.weixin.qq.com/doc/subscription/guide/product/publish.html)\n- [微信「新增草稿」draft/add](https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html)\n- [微信服务端 API 调用说明（IP 白名单）](https://developers.weixin.qq.com/doc/subscription/guide/dev/api/)\n- 设计文档：`docs/plans/2026-09-17-wechat-publish-design.md`\n";
/** Write the doc + marker (ONE-SHOT when `force` is false). */
async function seedWechatDocs(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-wechat-docs") !== void 0) return false;
	}
	const existing = await readSeedTiddler(client, WECHAT_DOCS_TITLE);
	let wrote = false;
	if (force || existing === void 0) {
		await client.put({
			title: WECHAT_DOCS_TITLE,
			text: WECHAT_DOCS_TEXT,
			type: "text/markdown",
			tags: ["dsh-docs", "dsh-tiddlywiki"]
		});
		wrote = true;
	}
	await writeSeedMarker(client, WECHAT_DOCS_MARKER_TITLE);
	return wrote;
}
/** Remove the doc + marker (反初始化). */
async function unseedWechatDocs(client) {
	const removed = [];
	for (const title of [WECHAT_DOCS_TITLE, WECHAT_DOCS_MARKER_TITLE]) try {
		await client.delete(title);
		removed.push(title);
	} catch {}
	return { removed };
}
//#endregion
//#region src/host/seed-wechat-publish.ts
/** The packaged plugin tiddler title (a TW system tiddler, type application/json). */
const WECHAT_PUBLISH_PLUGIN_TITLE = "$:/plugins/dsh/wechat-publish";
/** One-time marker: presence means "the button was offered once — hands off". */
const WECHAT_PUBLISH_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-wechat-publish";
/** The bundle's JSON text (`{"tiddlers": {...}}`), exactly as TW stores it. */
const WECHAT_PUBLISH_BUNDLE_TEXT = "{\n  \"tiddlers\": {\n    \"$:/plugins/dsh/wechat-publish/plugin.info\": {\n      \"title\": \"$:/plugins/dsh/wechat-publish/plugin.info\",\n      \"type\": \"application/json\",\n      \"text\": \"{\\\"title\\\":\\\"$:/plugins/dsh/wechat-publish\\\",\\\"name\\\":\\\"WeChat Publish\\\",\\\"description\\\":\\\"把当前笔记一键存到微信公众号草稿箱（TiddlyWiki → DSH → 浏览器自动化）\\\",\\\"author\\\":\\\"dsh-tiddlywiki\\\",\\\"version\\\":\\\"0.2.0\\\",\\\"plugin-type\\\":\\\"plugin\\\"}\"\n    },\n    \"$:/plugins/dsh/wechat-publish/startup.js\": {\n      \"title\": \"$:/plugins/dsh/wechat-publish/startup.js\",\n      \"type\": \"application/javascript\",\n      \"module-type\": \"startup\",\n      \"text\": \"/*\\\\\\ntitle: $:/plugins/dsh/wechat-publish/startup.js\\ntype: application/javascript\\nmodule-type: startup\\n\\n\\\\*/\\n(function(){\\n\\n/*jslint node: true, browser: true */\\n/*global $tw: false */\\n\\\"use strict\\\";\\n\\nexports.name = \\\"dsh-wechat-publish\\\";\\nexports.after = [\\\"story\\\"];\\nexports.platforms = [\\\"browser\\\"];\\n\\n// The one-shot confirm overlay. Kept as a DOM id (not a closure variable)\\n// because the poller and the overlay are wired together long after the\\n// overlay was built — see publishAndPoll().\\nvar OVERLAY_ID = \\\"dsh-wechat-publish-overlay\\\";\\n// Stop polling after 10 minutes. The browser flow uploads every inlined image\\n// one by one, so a long article is slow, but a job that never settles must not\\n// keep a 2s timer alive for the rest of the page's life.\\nvar POLL_INTERVAL_MS = 2000;\\nvar POLL_TIMEOUT_MS = 10 * 60 * 1000;\\n// How much of job.log to show (a full adapter run can log megabytes).\\nvar LOG_TAIL_CHARS = 2000;\\n\\n// Mirrors the host's DEFAULT_ADAPTER. `wechat.enabled` is false by default:\\n// browser automation against the 公众号 backend is an OPT-IN feature that\\n// needs opencli + the Browser Bridge extension installed separately.\\nfunction readConfig() {\\n\\tvar config = { enabled: false, endpoint: \\\"\\\", token: \\\"\\\", adapter: \\\"publish-note\\\" };\\n\\ttry {\\n\\t\\tvar t = $tw.wiki.getTiddler(\\\"$:/plugins/dsh-tiddlywiki/config\\\");\\n\\t\\tif (t && t.fields && typeof t.fields.text === \\\"string\\\") {\\n\\t\\t\\tvar parsed = JSON.parse(t.fields.text);\\n\\t\\t\\tvar wechat = parsed && parsed.wechat;\\n\\t\\t\\tif (wechat) {\\n\\t\\t\\t\\tif (typeof wechat.enabled === \\\"boolean\\\") { config.enabled = wechat.enabled; }\\n\\t\\t\\t\\tif (typeof wechat.endpoint === \\\"string\\\" && wechat.endpoint.length > 0) { config.endpoint = wechat.endpoint; }\\n\\t\\t\\t\\tif (typeof wechat.token === \\\"string\\\" && wechat.token.length > 0) { config.token = wechat.token; }\\n\\t\\t\\t\\tif (wechat.adapter === \\\"publish-note\\\" || wechat.adapter === \\\"publish-note-imgs\\\") { config.adapter = wechat.adapter; }\\n\\t\\t\\t}\\n\\t\\t}\\n\\t} catch (e) {}\\n\\treturn config;\\n}\\n\\nfunction baseEndpoint() {\\n\\tvar config = readConfig();\\n\\tif (config.endpoint.length > 0) { return config.endpoint.replace(/\\\\/+$/, \\\"\\\"); }\\n\\tif (typeof location !== \\\"undefined\\\" && location.origin) { return location.origin + \\\"/dsh-tiddlywiki\\\"; }\\n\\treturn \\\"/dsh-tiddlywiki\\\";\\n}\\n\\nfunction authHeaders() {\\n\\tvar headers = { \\\"Content-Type\\\": \\\"application/json\\\" };\\n\\tvar config = readConfig();\\n\\t// Must match the host's readToken(): the token only travels in this header,\\n\\t// never in the URL, so it cannot leak through history/referer/proxy logs.\\n\\tif (config.token.length > 0) { headers[\\\"x-wechat-publish-token\\\"] = config.token; }\\n\\treturn headers;\\n}\\n\\n/*\\nShow a transient message.\\n\\nTW's notifier renders a TIDDLER by title and does **nothing at all** when that\\ntiddler does not exist (core/modules/utils/dom/notifier.js: \\\"Don't do anything\\nif the tiddler doesn't exist\\\"). Passing free text as the title — the mistake\\nthe 「发送给 Agent」 button shipped with — makes every notice a silent no-op.\\nStore the message in a $:/temp tiddler first (volatile: never synced, never\\nwritten to disk) and display THAT title.\\n*/\\nvar NOTICE_TITLE = \\\"$:/temp/dsh/wechat-publish/notice\\\";\\nfunction notify(msg) {\\n\\ttry {\\n\\t\\tif ($tw.wiki && $tw.notifier && typeof $tw.notifier.display === \\\"function\\\" && typeof $tw.wiki.addTiddler === \\\"function\\\") {\\n\\t\\t\\t$tw.wiki.addTiddler({ title: NOTICE_TITLE, text: String(msg), type: \\\"text/vnd.tiddlywiki\\\" });\\n\\t\\t\\t$tw.notifier.display(NOTICE_TITLE);\\n\\t\\t\\treturn;\\n\\t\\t}\\n\\t} catch (e) {}\\n\\tif (typeof alert === \\\"function\\\") { alert(msg); }\\n}\\n\\n/*\\nParse a response body. The host answers every failure with a JSON body AND a\\nnon-2xx status, and $tw.utils.httpRequest reports those as\\n`callback(\\\"Error/XMLHttpRequest: 403\\\", body, xhr)` — i.e. err is a localized\\nstring and the body is still handed over. So parse first, then decide: the\\nbody's `error` is the readable truth, err is the fallback.\\n*/\\nfunction parseJob(data) {\\n\\ttry { return JSON.parse(data || \\\"\\\"); } catch (e) { return null; }\\n}\\nfunction failText(err, parsed, data, fallback) {\\n\\tif (parsed && parsed.error) { return String(parsed.error); }\\n\\tif (err) { return String(err); }\\n\\tif (data) { return String(data); }\\n\\treturn fallback || \\\"未知错误\\\";\\n}\\n\\nfunction closeOverlay() {\\n\\tvar overlay = document.getElementById(OVERLAY_ID);\\n\\tif (overlay) {\\n\\t\\tif (typeof overlay.__dshStopPolling === \\\"function\\\") { overlay.__dshStopPolling(); }\\n\\t\\tif (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }\\n\\t}\\n}\\n\\nfunction makeBox() {\\n\\tvar box = document.createElement(\\\"div\\\");\\n\\tbox.setAttribute(\\\"style\\\", \\\"background:#fff;color:#333;border-radius:8px;padding:16px;max-width:520px;width:92vw;max-height:82vh;overflow:auto;box-shadow:0 8px 30px rgba(0,0,0,.3);font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.6;\\\");\\n\\treturn box;\\n}\\n\\nfunction makeRow(parent, weight, text, color) {\\n\\tvar el = document.createElement(weight === \\\"h\\\" ? \\\"h3\\\" : \\\"p\\\");\\n\\tel.setAttribute(\\\"style\\\", (weight === \\\"h\\\" ? \\\"margin:0 0 8px;font-size:15px;\\\" : \\\"margin:0 0 8px;\\\") + (color ? \\\"color:\\\" + color + \\\";\\\" : \\\"\\\") + \\\"word-break:break-all;\\\");\\n\\tel.textContent = text;\\n\\tparent.appendChild(el);\\n\\treturn el;\\n}\\n\\nfunction makeButton(label, primary) {\\n\\tvar b = document.createElement(\\\"button\\\");\\n\\tb.type = \\\"button\\\";\\n\\tb.textContent = label;\\n\\tb.setAttribute(\\\"style\\\", primary\\n\\t\\t? \\\"padding:7px 16px;border:1px solid #4a90d9;border-radius:6px;background:#4a90d9;color:#fff;cursor:pointer;font-size:13px;\\\"\\n\\t\\t: \\\"padding:7px 16px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:13px;color:#444;\\\");\\n\\treturn b;\\n}\\n\\nfunction setDisabled(btn, disabled) {\\n\\tbtn.disabled = !!disabled;\\n\\tbtn.style.opacity = disabled ? \\\"0.5\\\" : \\\"1\\\";\\n\\tbtn.style.cursor = disabled ? \\\"default\\\" : \\\"pointer\\\";\\n}\\n\\n/*\\nBuild the confirm overlay. Returns the box plus the pieces the caller mutates:\\n  {overlay, box, status, actions, logs, logPre}\\nOnly ever one overlay at a time (a second click replaces the first), and Esc /\\nbackdrop click / ✕ all funnel through closeOverlay() so the poller is stopped.\\n*/\\nfunction createOverlay(title) {\\n\\tvar previous = document.getElementById(OVERLAY_ID);\\n\\tif (previous) { closeOverlay(); }\\n\\n\\tvar overlay = document.createElement(\\\"div\\\");\\n\\toverlay.id = OVERLAY_ID;\\n\\toverlay.setAttribute(\\\"style\\\", \\\"position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.35);z-index:99999;display:flex;align-items:center;justify-content:center;\\\");\\n\\tvar box = makeBox();\\n\\n\\tvar header = document.createElement(\\\"div\\\");\\n\\theader.setAttribute(\\\"style\\\", \\\"display:flex;align-items:center;justify-content:space-between;gap:8px;\\\");\\n\\tvar h = document.createElement(\\\"h3\\\");\\n\\th.setAttribute(\\\"style\\\", \\\"margin:0;font-size:15px;\\\");\\n\\th.textContent = \\\"发布到公众号 · \\\" + title;\\n\\tvar closeX = document.createElement(\\\"button\\\");\\n\\tcloseX.type = \\\"button\\\";\\n\\tcloseX.textContent = \\\"✕\\\";\\n\\tcloseX.title = \\\"关闭（停止轮询）\\\";\\n\\tcloseX.setAttribute(\\\"style\\\", \\\"border:none;background:transparent;font-size:15px;cursor:pointer;color:#888;padding:2px 8px;border-radius:4px;\\\");\\n\\tcloseX.addEventListener(\\\"click\\\", function() { closeOverlay(); });\\n\\theader.appendChild(h);\\n\\theader.appendChild(closeX);\\n\\tbox.appendChild(header);\\n\\n\\tvar status = document.createElement(\\\"div\\\");\\n\\tstatus.setAttribute(\\\"style\\\", \\\"margin:6px 0 10px;white-space:pre-wrap;\\\");\\n\\tbox.appendChild(status);\\n\\n\\tvar logs = document.createElement(\\\"div\\\");\\n\\tlogs.setAttribute(\\\"style\\\", \\\"margin:8px 0 0;\\\");\\n\\tvar logCaption = document.createElement(\\\"p\\\");\\n\\tlogCaption.setAttribute(\\\"style\\\", \\\"margin:0 0 4px;font-size:12px;color:#888;\\\");\\n\\tlogCaption.textContent = \\\"运行日志（最近 \\\" + LOG_TAIL_CHARS + \\\" 字符）：\\\";\\n\\tvar logPre = document.createElement(\\\"pre\\\");\\n\\tlogPre.setAttribute(\\\"style\\\", \\\"margin:0;max-height:32vh;overflow:auto;background:#1e1e1e;color:#ddd;border-radius:6px;padding:8px;font-size:11px;white-space:pre-wrap;word-break:break-all;\\\");\\n\\tlogs.appendChild(logCaption);\\n\\tlogs.appendChild(logPre);\\n\\tlogs.style.display = \\\"none\\\";\\n\\tbox.appendChild(logs);\\n\\n\\tvar actions = document.createElement(\\\"div\\\");\\n\\tactions.setAttribute(\\\"style\\\", \\\"display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap;\\\");\\n\\tbox.appendChild(actions);\\n\\n\\toverlay.appendChild(box);\\n\\tdocument.body.appendChild(overlay);\\n\\n\\toverlay.addEventListener(\\\"click\\\", function(e) { if (e.target === overlay) { closeOverlay(); } });\\n\\tvar escHandler = function(e) { if (e.key === \\\"Escape\\\") { closeOverlay(); } };\\n\\tdocument.addEventListener(\\\"keydown\\\", escHandler);\\n\\t// The Esc listener lived on `document`: it must die with the overlay,\\n\\t// otherwise every open/close cycle leaks one keydown handler.\\n\\toverlay.__dshCleanup = function() { document.removeEventListener(\\\"keydown\\\", escHandler); };\\n\\treturn { overlay: overlay, box: box, status: status, actions: actions, logs: logs, logPre: logPre };\\n}\\n\\n/*\\nThe plain-text confirm body. The「只存草稿」/「需要扫码」/「复用已登录浏览器」\\nsentences are the contract of the whole feature (v0.23.2 起策略就是「到草稿箱为止」):\\nusers must not expect a one-click public post, and must know their session is\\nreused rather than a stored credential.\\n*/\\nfunction confirmationText(title) {\\n\\treturn \\\"笔记：《\\\" + title + \\\"》\\\\n\\\\n\\\"\\n\\t\\t+ \\\"只存到草稿箱，不会自动发表；发表需你在浏览器里扫码。\\\\n\\\"\\n\\t\\t+ \\\"脚本会复用你已登录的浏览器（不保存任何凭据）。\\\\n\\\"\\n\\t\\t+ \\\"首次运行可能需要一两分钟（图片要逐张上传）。\\\";\\n}\\n\\n/*\\nA warning row for notes the 发布元数据规范 marks as off-limits. Read from the\\ntiddler's custom FIELDS (not tags alone): `pub-state: excluded` and the\\n`no-publish` tag are the two mirrors the spec keeps in sync. This only warns —\\nthe host does not block (see docs: 只告警不阻断), so the user stays in control.\\n*/\\nfunction publishWarnings(title) {\\n\\tvar tiddler = $tw.wiki.getTiddler(title);\\n\\tvar fields = (tiddler && tiddler.fields) || {};\\n\\tvar tags = fields.tags || [];\\n\\tvar state = fields[\\\"pub-state\\\"] ? String(fields[\\\"pub-state\\\"]) : \\\"\\\";\\n\\tvar warnings = [];\\n\\tif (state === \\\"published\\\") { warnings.push(\\\"这篇笔记的 pub-state 是 published —— 可能已经发表过，请确认不要重复发布。\\\"); }\\n\\tif (state === \\\"excluded\\\") { warnings.push(\\\"这篇笔记的 pub-state 是 excluded —— 规范里标为「明确不发」。\\\"); }\\n\\tif (tags.indexOf(\\\"no-publish\\\") !== -1) { warnings.push(\\\"这篇笔记带着 no-publish 标签 —— 规范里标为「不可发布」。\\\"); }\\n\\treturn warnings;\\n}\\n\\nfunction showError(title, msg, silent) {\\n\\tvar ui = createOverlay(title);\\n\\tui.overlay.__dshCleanup();\\n\\tmakeRow(ui.status, \\\"p\\\", \\\"⚠️ \\\" + msg, \\\"#c0392b\\\");\\n\\tvar cancel = makeButton(\\\"关闭\\\", false);\\n\\tcancel.addEventListener(\\\"click\\\", function() { closeOverlay(); });\\n\\tui.actions.appendChild(cancel);\\n\\t// `silent` for the callers that already fire their own toast — one failure\\n\\t// must produce exactly one notification, not two.\\n\\tif (!silent) { notify(\\\"发布到公众号失败：\\\" + msg); }\\n}\\n\\n/*\\nGET /wechat/ready. The endpoint answers 200 with `ok:true` whenever the feature\\nis on — an INSTALLATION problem is deliberately not an HTTP error (see the host\\nroute), it is reported inside the body as `opencli.ok=false` / `adapters.missing`.\\nSo `parsed.ok` alone must never be read as \\\"ready\\\": gating on it would skip both\\nchecks and let the user confirm a publish that is guaranteed to fail 503.\\nReturns an actionable message for a CONCRETE problem, or null otherwise.\\n\\nThis was measured, not guessed: with a body of\\n`{ok:true, adapters:{publishNote:false,…}}` an earlier draft still rendered the\\nconfirm dialog, because the readiness check was keyed off `parsed.ok`.\\n*/\\nfunction readinessProblem(parsed, adapter) {\\n\\tif (!parsed) { return null; }\\n\\tif (parsed.enabled === false) {\\n\\t\\treturn \\\"微信发布未启用：请在 DSH 设置 →「TiddlyWiki 知识库」→「可选功能：微信公众号发布」勾选并保存。\\\";\\n\\t}\\n\\tvar ready = parsed.ready || parsed;\\n\\tif (ready.opencli && ready.opencli.ok === false) {\\n\\t\\treturn \\\"未检测到可用的 opencli —— 发布依赖它驱动浏览器。\\\\n请先按 docs/wechat-publish-setup.md 安装 opencli，然后运行：\\\\nnode <插件目录>/tools/wechat/install-wechat-adapters.mjs\\\";\\n\\t}\\n\\tvar adapters = ready.adapters;\\n\\tif (!adapters) { return null; }\\n\\tvar missing = Array.isArray(adapters.missing) ? adapters.missing : [];\\n\\t// v0.23.4：`stale` = 文件都在但**版本过旧**（旧版 adapter 不认宿主的\\n\\t// `--title-file`，点了按钮才会在 opencli 里报「缺少必填参数」）。措辞必须\\n\\t// 与「缺失」分开，否则用户会去重装一遍同样的旧文件。\\n\\tvar stale = Array.isArray(adapters.stale) ? adapters.stale : [];\\n\\tvar installHint = \\\"\\\\n请运行（路径相对插件目录，npm 安装时是 node_modules/dsh-tiddlywiki）：\\\\n\\\"\\n\\t\\t+ \\\"node <插件目录>/tools/wechat/install-wechat-adapters.mjs\\\";\\n\\tif (stale.length > 0) {\\n\\t\\treturn \\\"发布脚本（adapter）版本过旧：\\\" + stale.join(\\\"、\\\") + \\\"。\\\\n\\\"\\n\\t\\t\\t+ \\\"旧版不认识宿主的 --title-file（标题走文件、不进命令行），直接发布会在 opencli 里报「缺少必填参数」。\\\"\\n\\t\\t\\t+ installHint;\\n\\t}\\n\\t// Only the selected adapter matters: a wiki can publish plain notes long\\n\\t// before the multi-image adapter is installed.\\n\\tvar needed = adapter === \\\"publish-note-imgs\\\" ? \\\"publishNoteImgs\\\" : \\\"publishNote\\\";\\n\\tif (adapters[needed] === false || missing.length > 0) {\\n\\t\\treturn \\\"缺少发布脚本（adapter）：\\\" + (missing.length > 0 ? missing.join(\\\"、\\\") : needed) + \\\"。\\\"\\n\\t\\t\\t+ installHint;\\n\\t}\\n\\treturn null;\\n}\\n\\n/** The concrete problem, or the transport error / host message when there is none. */\\nfunction describeNotReady(parsed, err, data, adapter) {\\n\\tvar problem = readinessProblem(parsed, adapter);\\n\\tif (problem !== null) { return problem; }\\n\\treturn \\\"无法检查发布环境：\\\" + failText(err, parsed, data, \\\"未知错误\\\");\\n}\\n\\n/*\\nPOST /wechat/publish, then poll GET /wechat/publish/status?id=… every 2s until\\nthe job settles. A 409 (another job running) is surfaced verbatim — the host\\nalready names the running jobId, which is what the user needs to go look at it.\\n*/\\nfunction publishAndPoll(title, adapter) {\\n\\tvar ui = createOverlay(title);\\n\\tsetDisabled(ui.actions, true);\\n\\tui.actions.innerHTML = \\\"\\\";\\n\\tmakeRow(ui.status, \\\"p\\\", \\\"正在提交发布任务…\\\", \\\"#555\\\");\\n\\n\\tvar stopped = false;\\n\\tvar timer = null;\\n\\tfunction stopPolling() {\\n\\t\\tstopped = true;\\n\\t\\tif (timer !== null) { clearInterval(timer); timer = null; }\\n\\t}\\n\\t// closeOverlay() calls this through the overlay node, so EVERY close path\\n\\t// (✕ / Esc / backdrop / programmatic) stops the 2s polling loop.\\n\\tui.overlay.__dshStopPolling = function() {\\n\\t\\tstopPolling();\\n\\t\\tui.overlay.__dshCleanup();\\n\\t};\\n\\n\\tfunction addCloseButton(onClose) {\\n\\t\\tvar close = makeButton(\\\"关闭\\\", false);\\n\\t\\tclose.addEventListener(\\\"click\\\", function() { closeOverlay(); if (onClose) { onClose(); } });\\n\\t\\tui.actions.appendChild(close);\\n\\t}\\n\\n\\tfunction renderJob(job) {\\n\\t\\tvar lines = [];\\n\\t\\tif (job.state === \\\"running\\\") { lines.push(\\\"⏳ 正在发布…\\\"); }\\n\\t\\telse if (job.state === \\\"ok\\\") { lines.push(\\\"✅ \\\" + (job.message || \\\"已存到公众号草稿箱\\\")); }\\n\\t\\telse if (job.state === \\\"error\\\") { lines.push(\\\"❌ 发布失败\\\" + (job.exitCode !== undefined ? \\\"（exit \\\" + job.exitCode + \\\"）\\\" : \\\"\\\")); }\\n\\t\\telse { lines.push(\\\"状态：\\\" + String(job.state || \\\"未知\\\")); }\\n\\t\\tif (job.message && job.state !== \\\"ok\\\") { lines.push(String(job.message)); }\\n\\t\\tif (job.state === \\\"ok\\\") {\\n\\t\\t\\tlines.push(\\\"\\\");\\n\\t\\t\\tlines.push(\\\"建议回写发布元数据（用 tiddlywiki_put 补 fields，别动 tags）：\\\");\\n\\t\\t\\tlines.push(\\\"pub-state: published · pub-platform: wechat · pub-wechat-at: <发表时间>\\\");\\n\\t\\t\\tlines.push(\\\"若实际发表时间/标题与本文不同，再补 pub-wechat-title / pub-wechat-url。\\\");\\n\\t\\t}\\n\\t\\tui.status.textContent = lines.join(\\\"\\\\n\\\");\\n\\t\\tif (job.log) {\\n\\t\\t\\tui.logs.style.display = \\\"\\\";\\n\\t\\t\\tui.logPre.textContent = String(job.log).slice(-LOG_TAIL_CHARS);\\n\\t\\t\\tui.logPre.scrollTop = ui.logPre.scrollHeight;\\n\\t\\t}\\n\\t}\\n\\n\\tfunction poll(jobId) {\\n\\t\\t$tw.utils.httpRequest({\\n\\t\\t\\turl: baseEndpoint() + \\\"/wechat/publish/status?id=\\\" + encodeURIComponent(jobId),\\n\\t\\t\\ttype: \\\"GET\\\",\\n\\t\\t\\theaders: authHeaders(),\\n\\t\\t\\tcallback: function(err, data) {\\n\\t\\t\\t\\tif (stopped) { return; }\\n\\t\\t\\t\\tvar parsed = parseJob(data);\\n\\t\\t\\t\\tif (err || !parsed || !parsed.ok || !parsed.job) {\\n\\t\\t\\t\\t\\t// A transient poll failure must not end the job: show it and\\n\\t\\t\\t\\t\\t// keep polling — the job is still running on the host.\\n\\t\\t\\t\\t\\tmakeRow(ui.status, \\\"p\\\", \\\"⚠️ 查询状态失败：\\\" + failText(err, parsed, data, \\\"未知错误\\\") + \\\"（继续重试…）\\\", \\\"#c0392b\\\");\\n\\t\\t\\t\\t\\treturn;\\n\\t\\t\\t\\t}\\n\\t\\t\\t\\tvar job = parsed.job;\\n\\t\\t\\t\\trenderJob(job);\\n\\t\\t\\t\\tif (job.state === \\\"ok\\\" || job.state === \\\"error\\\") {\\n\\t\\t\\t\\t\\tstopPolling();\\n\\t\\t\\t\\t\\tui.overlay.__dshCleanup();\\n\\t\\t\\t\\t\\tui.actions.innerHTML = \\\"\\\";\\n\\t\\t\\t\\t\\taddCloseButton();\\n\\t\\t\\t\\t\\t// Sync a one-shot toast: the overlay may be closed (or the\\n\\t\\t\\t\\t\\t// TW panel hidden) before the user reads it.\\n\\t\\t\\t\\t\\tnotify(job.state === \\\"ok\\\"\\n\\t\\t\\t\\t\\t\\t? \\\"已存到公众号草稿箱 ✓《\\\" + title + \\\"》\\\"\\n\\t\\t\\t\\t\\t\\t: \\\"发布到公众号失败：《\\\" + title + \\\"》\\\" + (job.message ? \\\"（\\\" + job.message + \\\"）\\\" : \\\"\\\"));\\n\\t\\t\\t\\t}\\n\\t\\t\\t}\\n\\t\\t});\\n\\t}\\n\\n\\t$tw.utils.httpRequest({\\n\\t\\turl: baseEndpoint() + \\\"/wechat/publish\\\",\\n\\t\\ttype: \\\"POST\\\",\\n\\t\\theaders: authHeaders(),\\n\\t\\tdata: JSON.stringify({ title: title, adapter: adapter }),\\n\\t\\tcallback: function(err, data) {\\n\\t\\t\\tif (stopped) { return; }\\n\\t\\t\\tvar parsed = parseJob(data);\\n\\t\\t\\tif (err || !parsed || !parsed.ok) {\\n\\t\\t\\t\\t// The 503 body carries a `ready` snapshot (opencli + adapters)\\n\\t\\t\\t\\t// whose install advice is more useful than the raw error; for\\n\\t\\t\\t\\t// every other failure (400/401/403/409) the host's own `error`\\n\\t\\t\\t\\t// is already the actionable text, so it is kept as-is.\\n\\t\\t\\t\\tvar advice = readinessProblem(parsed, adapter);\\n\\t\\t\\t\\tvar detail = advice !== null\\n\\t\\t\\t\\t\\t? advice + \\\"\\\\n\\\" + failText(err, parsed, data, \\\"未知错误\\\")\\n\\t\\t\\t\\t\\t: failText(err, parsed, data, \\\"未知错误\\\");\\n\\t\\t\\t\\tstopPolling();\\n\\t\\t\\t\\tui.overlay.__dshCleanup();\\n\\t\\t\\t\\tui.actions.innerHTML = \\\"\\\";\\n\\t\\t\\t\\tif (parsed && parsed.jobId) { detail += \\\"\\\\n（正在运行的任务：\\\" + parsed.jobId + \\\"）\\\"; }\\n\\t\\t\\t\\tmakeRow(ui.status, \\\"p\\\", \\\"⚠️ \\\" + detail, \\\"#c0392b\\\");\\n\\t\\t\\t\\taddCloseButton();\\n\\t\\t\\t\\tnotify(\\\"发布到公众号失败：\\\" + failText(err, parsed, data, \\\"未知错误\\\"));\\n\\t\\t\\t\\treturn;\\n\\t\\t\\t}\\n\\t\\t\\tvar jobId = parsed.jobId;\\n\\t\\t\\tmakeRow(ui.status, \\\"p\\\", \\\"任务已提交（\\\" + jobId + \\\"），每 2 秒查询进度…\\\", \\\"#555\\\");\\n\\t\\t\\taddCloseButton();\\n\\t\\t\\tpoll(jobId);\\n\\t\\t\\ttimer = setInterval(function() { poll(jobId); }, POLL_INTERVAL_MS);\\n\\t\\t\\t// Hard stop: the host has its own timeouts, but the page must not\\n\\t\\t\\t// poll forever if a job somehow never settles.\\n\\t\\t\\tsetTimeout(function() {\\n\\t\\t\\t\\tif (!stopped && timer !== null) {\\n\\t\\t\\t\\t\\tstopPolling();\\n\\t\\t\\t\\t\\tmakeRow(ui.status, \\\"p\\\", \\\"⚠️ 超过 10 分钟仍未结束，已停止查询。请到公众号后台确认草稿是否已保存。\\\", \\\"#c0392b\\\");\\n\\t\\t\\t\\t}\\n\\t\\t\\t}, POLL_TIMEOUT_MS);\\n\\t\\t}\\n\\t});\\n}\\n\\nfunction checkReadyThenConfirm(title, adapter) {\\n\\tvar ui = createOverlay(title);\\n\\tsetDisabled(ui.actions, true);\\n\\tui.actions.innerHTML = \\\"\\\";\\n\\tmakeRow(ui.status, \\\"p\\\", \\\"正在检查发布环境…\\\", \\\"#555\\\");\\n\\n\\t$tw.utils.httpRequest({\\n\\t\\turl: baseEndpoint() + \\\"/wechat/ready\\\",\\n\\t\\ttype: \\\"GET\\\",\\n\\t\\theaders: authHeaders(),\\n\\t\\tcallback: function(err, data) {\\n\\t\\t\\tvar parsed = parseJob(data);\\n\\t\\t\\t// `parsed.ok` is NOT the readiness signal (see readinessProblem):\\n\\t\\t\\t// the endpoint returns ok:true even when opencli/adapters are\\n\\t\\t\\t// missing, and reports those inside the body.\\n\\t\\t\\tvar problem = readinessProblem(parsed, adapter);\\n\\t\\t\\tif (problem !== null) {\\n\\t\\t\\t\\tcloseOverlay();\\n\\t\\t\\t\\t// The overlay shows the fix; the toast mirrors it once.\\n\\t\\t\\t\\tshowError(title, problem);\\n\\t\\t\\t\\treturn;\\n\\t\\t\\t}\\n\\t\\t\\t// Ready → rebuild the overlay as the confirm dialog.\\n\\t\\t\\tcloseOverlay();\\n\\t\\t\\tvar ui2 = createOverlay(title);\\n\\t\\t\\tmakeRow(ui2.status, \\\"p\\\", confirmationText(title), \\\"#444\\\");\\n\\t\\t\\tpublishWarnings(title).forEach(function(w) {\\n\\t\\t\\t\\tmakeRow(ui2.status, \\\"p\\\", \\\"⚠️ \\\" + w, \\\"#c0392b\\\");\\n\\t\\t\\t});\\n\\t\\t\\tvar cancel = makeButton(\\\"取消\\\", false);\\n\\t\\t\\tcancel.addEventListener(\\\"click\\\", function() { closeOverlay(); });\\n\\t\\t\\tvar go = makeButton(\\\"开始存草稿\\\", true);\\n\\t\\t\\tgo.addEventListener(\\\"click\\\", function() { closeOverlay(); publishAndPoll(title, adapter); });\\n\\t\\t\\tui2.actions.appendChild(cancel);\\n\\t\\t\\tui2.actions.appendChild(go);\\n\\t\\t}\\n\\t});\\n}\\n\\nfunction handlePublish(title) {\\n\\t// Whole handler is wrapped by the caller: a throw inside a startup module\\n\\t// aborts the rest of TW's startup (other plugins' modules never run).\\n\\tif (!title) { notify(\\\"无法确定当前笔记标题\\\"); return; }\\n\\tvar tiddler = $tw.wiki.getTiddler(title);\\n\\tif (!tiddler) { notify(\\\"找不到笔记：\\\" + title); return; }\\n\\tvar config = readConfig();\\n\\tif (!config.enabled) {\\n\\t\\tnotify(\\\"「发布到公众号」未启用：请在 DSH 设置 →「TiddlyWiki 知识库」→「微信公众号发布」勾选并保存后重试。\\\");\\n\\t\\treturn;\\n\\t}\\n\\tcheckReadyThenConfirm(title, config.adapter);\\n}\\n\\nexports.startup = function() {\\n\\tconsole.log(\\\"[dsh-wechat-publish] startup ran\\\");\\n\\tif (!$tw.rootWidget || typeof $tw.rootWidget.addEventListener !== \\\"function\\\") { return; }\\n\\t$tw.rootWidget.addEventListener(\\\"dsh-wechat-publish\\\", function(event) {\\n\\t\\ttry {\\n\\t\\t\\thandlePublish(event.param);\\n\\t\\t} catch (e) {\\n\\t\\t\\t// Never let a startup-module exception escape: TW runs every startup\\n\\t\\t\\t// module in one loop, so a throw here breaks unrelated plugins.\\n\\t\\t\\ttry { notify(\\\"发布到公众号失败：\\\" + (e && e.message ? e.message : e)); } catch (e2) {}\\n\\t\\t\\ttry { console.log(\\\"[dsh-wechat-publish] handler error\\\", e); } catch (e3) {}\\n\\t\\t}\\n\\t});\\n};\\n\\n})();\\n\"\n    },\n    \"$:/plugins/dsh/wechat-publish/ui/icon\": {\n      \"title\": \"$:/plugins/dsh/wechat-publish/ui/icon\",\n      \"tags\": [\n        \"$:/tags/Image\"\n      ],\n      \"text\": \"\\\\parameters (size:\\\"22pt\\\")\\n<svg width=<<size>> height=<<size>> class=\\\"tc-image-wechat-publish tc-image-button\\\" viewBox=\\\"0 0 24 24\\\"><path d=\\\"M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z\\\"/></svg>\\n\"\n    },\n    \"$:/plugins/dsh/wechat-publish/ui/ViewToolbar/PublishToWechat\": {\n      \"title\": \"$:/plugins/dsh/wechat-publish/ui/ViewToolbar/PublishToWechat\",\n      \"type\": \"text/vnd.tiddlywiki\",\n      \"tags\": [\n        \"$:/tags/ViewToolbar\"\n      ],\n      \"icon\": \"$:/plugins/dsh/wechat-publish/ui/icon\",\n      \"caption\": \"发布到公众号\",\n      \"description\": \"把当前笔记一键存到微信公众号草稿箱（TiddlyWiki → DSH → 浏览器自动化）\",\n      \"text\": \"\\\\whitespace trim\\n<$button message=\\\"dsh-wechat-publish\\\"\\n\\tparam=<<currentTiddler>>\\n\\ttooltip=\\\"把当前笔记存到微信公众号草稿箱\\\"\\n\\taria-label=\\\"把当前笔记存到微信公众号草稿箱\\\"\\n\\tclass=<<tv-config-toolbar-class>>\\n>\\n\\t<%if [<tv-config-toolbar-icons>match[yes]] %>\\n\\t\\t{{$:/plugins/dsh/wechat-publish/ui/icon}}\\n\\t<%endif%>\\n\\t<%if [<tv-config-toolbar-text>match[yes]] %>\\n\\t\\t<span class=\\\"tc-btn-text\\\">\\n\\t\\t<$text text=\\\"发布到公众号\\\"/>\\n\\t</span>\\n\\t<%endif%>\\n</$button>\\n\"\n    },\n    \"$:/core/ui/ControlPanel/Toolbars/ItemTemplate\": {\n      \"title\": \"$:/core/ui/ControlPanel/Toolbars/ItemTemplate\",\n      \"type\": \"text/vnd.tiddlywiki\",\n      \"text\": \"\\\\define config-title()\\n$(config-base)$$(currentTiddler)$\\n\\\\end\\n\\\\whitespace trim\\n\\n<$draggable tiddler=<<currentTiddler>>>\\n<$checkbox tiddler=<<config-title>> field=\\\"text\\\" checked=\\\"show\\\" unchecked=\\\"hide\\\" default=\\\"show\\\"/>\\n&#32;\\n<span class=\\\"tc-icon-wrapper\\\"><$transclude tiddler={{!!icon}}/></span>\\n&#32;\\n<$transclude field=\\\"caption\\\"/>\\n&#32;--&#32;\\n<i class=\\\"tc-muted\\\"><$transclude field=\\\"description\\\"/></i>\\n</$draggable>\\n\"\n    }\n  }\n}";
/**
* Seed the「发布到公众号」TW button exactly once per wiki (mirrors the
* send-to-agent one-shot policy). The marker records the offer; afterwards the
* bundle is user-owned — deleting it and restarting dsh web does NOT recreate
* it, and edits are never overwritten. With `opts.force` the bundle is
* (re)written even when it already exists and the marker is (re)written — the
* settings page uses this for "重新初始化". Returns whether a bundle was
* written this call. Throws when a read fails (the seed registry reports it as
* `ok:false`).
*/
async function seedWechatPublish(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-wechat-publish") !== void 0) return false;
	}
	const existing = await readSeedTiddler(client, WECHAT_PUBLISH_PLUGIN_TITLE);
	let wrote = false;
	if (force || existing === void 0) {
		await client.put({
			title: WECHAT_PUBLISH_PLUGIN_TITLE,
			text: WECHAT_PUBLISH_BUNDLE_TEXT,
			type: "application/json",
			tags: [],
			"plugin-type": "plugin",
			name: "WeChat Publish",
			author: "dsh-tiddlywiki",
			version: "0.2.0",
			description: "把当前笔记一键存到微信公众号草稿箱（TiddlyWiki → DSH → 浏览器自动化）"
		});
		wrote = true;
	}
	await writeSeedMarker(client, WECHAT_PUBLISH_MARKER_TITLE);
	return wrote;
}
/** Remove the bundle + marker (反初始化). */
async function unseedWechatPublish(client) {
	const removed = [];
	for (const title of [WECHAT_PUBLISH_PLUGIN_TITLE, WECHAT_PUBLISH_MARKER_TITLE]) try {
		await client.delete(title);
		removed.push(title);
	} catch {}
	return { removed };
}
//#endregion
//#region src/host/seed-render.ts
/** The packaged plugin tiddler title (a TW system tiddler, type application/json). */
const RENDER_PLUGIN_TITLE = "$:/plugins/dsh/render";
/** One-time marker: presence means "the route was offered once — hands off". */
const RENDER_MARKER_TITLE = "$:/plugins/dsh-tiddlywiki/seed-render";
/**
* On-disk tiddler filename for RENDER_PLUGIN_TITLE (TW's FileSystemAdaptor
* encoding: `$:` → `$__`, `/` → `_`). Callers that must restart TW so the
* seeded server route loads poll for this file after a seed run.
*/
const RENDER_PLUGIN_FILE = "$__plugins_dsh_render.json";
/** The bundle's JSON text (`{"tiddlers": {...}}`), exactly as TW stores it. */
const RENDER_BUNDLE_TEXT = "{\n  \"tiddlers\": {\n    \"$:/plugins/dsh/render/plugin.info\": {\n      \"title\": \"$:/plugins/dsh/render/plugin.info\",\n      \"type\": \"application/json\",\n      \"text\": \"{\\\"title\\\":\\\"$:/plugins/dsh/render\\\",\\\"name\\\":\\\"DSH Wiki Render\\\",\\\"description\\\":\\\"把 wiki 文本原生渲染成 HTML 片段（POST /render 服务端路由），供 DSH 回复流工具卡与 wiki 链接跳转使用\\\",\\\"author\\\":\\\"dsh-tiddlywiki\\\",\\\"version\\\":\\\"0.2.0\\\",\\\"plugin-type\\\":\\\"plugin\\\"}\"\n    },\n    \"$:/plugins/dsh/render/server-routes/render.js\": {\n      \"title\": \"$:/plugins/dsh/render/server-routes/render.js\",\n      \"type\": \"application/javascript\",\n      \"module-type\": \"route\",\n      \"text\": \"/*\\\\\\ntitle: $:/plugins/dsh/render/server-routes/render.js\\ntype: application/javascript\\nmodule-type: route\\n\\nPOST /render — native TiddlyWiki → HTML fragment for the DSH reply stream\\n\\nBody (JSON in state.data):\\n  { title }                       render an existing tiddler's body with ITS type\\n  { text, type?, contextTitle?, parseAsInline? }\\n                                  render arbitrary content as a fragment\\n\\\\*/\\n\\\"use strict\\\";\\n\\n/*\\nThe fragment's internal wiki links are rewritten to the SAME-ORIGIN DSH proxy\\nhash (`/dsh-tiddlywiki/tw/#<title>`) by overriding the `tv-wikilink-template`\\nvariable while rendering. Verified against tiddlywiki 5.4.1's link widget:\\n`link.js` expands `$uri_encoded$` (encodeURIComponentExtended) into the href,\\nso the default `#Title` becomes `/dsh-tiddlywiki/tw/#Title`. The DSH page's\\ndocument-level click interceptor + the embedded TW's hash navigation\\n(story.js reads the hash via decodeURIComponentSafe) both handle that href —\\nno post-hoc string rewriting needed.\\n*/\\nvar WIKILINK_TEMPLATE = \\\"/dsh-tiddlywiki/tw/#$uri_encoded$\\\";\\n\\nexports.methods = [\\\"POST\\\"];\\n\\nexports.path = /^\\\\/render$/;\\n\\nexports.info = {\\n\\tpriority: 100\\n};\\n\\nfunction sendJson(response,status,payload) {\\n\\tresponse.writeHead(status,{\\\"Content-Type\\\":\\\"application/json; charset=utf-8\\\",\\\"Cache-Control\\\":\\\"no-store\\\"});\\n\\tresponse.end(JSON.stringify(payload));\\n}\\n\\nexports.handler = function(request,response,state) {\\n\\tvar body;\\n\\ttry {\\n\\t\\tbody = JSON.parse(state.data || \\\"{}\\\");\\n\\t} catch(e) {\\n\\t\\tsendJson(response,400,{ok:false,error:\\\"invalid JSON body\\\"});\\n\\t\\treturn;\\n\\t}\\n\\ttry {\\n\\t\\tvar variables = {\\n\\t\\t\\t\\\"tv-wikilink-template\\\": WIKILINK_TEMPLATE\\n\\t\\t};\\n\\t\\tif(typeof body.title === \\\"string\\\" && body.title.length > 0) {\\n\\t\\t\\t// Render an existing tiddler's body with ITS OWN content type (block\\n\\t\\t\\t// parse, so headings / tables / lists render natively). The type must\\n\\t\\t\\t// be honored: dsh-tiddlywiki writes agent notes as `text/markdown`\\n\\t\\t\\t// (tiddlywiki/markdown is enabled), and hardcoding wikitext rendered\\n\\t\\t\\t// every markdown note as source (`## x` became a wikitext list).\\n\\t\\t\\t// $tw.utils.getParser() falls back to text/vnd.tiddlywiki when no\\n\\t\\t\\t// parser is registered for the type, so passing the raw type is safe.\\n\\t\\t\\tvar tiddler = state.wiki.getTiddler(body.title);\\n\\t\\t\\tif(!tiddler) {\\n\\t\\t\\t\\tsendJson(response,404,{ok:false,notFound:true,title:body.title});\\n\\t\\t\\t\\treturn;\\n\\t\\t\\t}\\n\\t\\t\\tvariables.currentTiddler = body.title;\\n\\t\\t\\tvar tiddlerType = typeof tiddler.fields.type === \\\"string\\\" && tiddler.fields.type.length > 0\\n\\t\\t\\t\\t? tiddler.fields.type\\n\\t\\t\\t\\t: \\\"text/vnd.tiddlywiki\\\";\\n\\t\\t\\tvar html = state.wiki.renderText(\\\"text/html\\\",tiddlerType,tiddler.fields.text,{\\n\\t\\t\\t\\tparseAsInline: false,\\n\\t\\t\\t\\tvariables: variables\\n\\t\\t\\t});\\n\\t\\t\\tresponse.writeHead(200,{\\\"Content-Type\\\":\\\"text/html; charset=utf-8\\\",\\\"Cache-Control\\\":\\\"no-store\\\"});\\n\\t\\t\\tresponse.end(html);\\n\\t\\t\\treturn;\\n\\t\\t}\\n\\t\\tif(typeof body.text === \\\"string\\\") {\\n\\t\\t\\t// Render arbitrary wiki text (contextTitle gives currentTiddler so\\n\\t\\t\\t// links/transclusions resolve in that tiddler's context). `type`\\n\\t\\t\\t// optionally selects the parser (e.g. text/markdown); the default is\\n\\t\\t\\t// wikitext, and unknown types fall back to it inside TW.\\n\\t\\t\\tif(typeof body.contextTitle === \\\"string\\\" && body.contextTitle.length > 0) {\\n\\t\\t\\t\\tvariables.currentTiddler = body.contextTitle;\\n\\t\\t\\t}\\n\\t\\t\\tvar inline = body.parseAsInline === true;\\n\\t\\t\\tvar bodyType = typeof body.type === \\\"string\\\" && body.type.length > 0 ? body.type : \\\"text/vnd.tiddlywiki\\\";\\n\\t\\t\\tvar textHtml = state.wiki.renderText(\\\"text/html\\\",bodyType,body.text,{\\n\\t\\t\\t\\tparseAsInline: inline,\\n\\t\\t\\t\\tvariables: variables\\n\\t\\t\\t});\\n\\t\\t\\tresponse.writeHead(200,{\\\"Content-Type\\\":\\\"text/html; charset=utf-8\\\",\\\"Cache-Control\\\":\\\"no-store\\\"});\\n\\t\\t\\tresponse.end(textHtml);\\n\\t\\t\\treturn;\\n\\t\\t}\\n\\t\\tsendJson(response,400,{ok:false,error:\\\"body must provide \\\\\\\"title\\\\\\\" or \\\\\\\"text\\\\\\\"\\\"});\\n\\t} catch(e) {\\n\\t\\tsendJson(response,500,{ok:false,error:String((e && e.message) || e)});\\n\\t}\\n};\\n\"\n    }\n  }\n}";
/**
* Seed the "原生渲染路由" TW plugin exactly once per wiki (mirrors the
* send-to-agent one-shot policy). The marker records the offer; afterwards the
* bundle is user-owned — deleting it and restarting dsh web does NOT recreate
* it, and edits are never overwritten. With `opts.force` the bundle is
* (re)written even when it already exists and the marker is (re)written — the
* settings page uses this for "重新初始化". Returns whether a bundle was
* written this call. Throws when a read fails (the seed registry reports it as `ok:false`).
*/
async function seedRenderRoute(client, opts) {
	const force = opts?.force === true;
	if (!force) {
		if (await readSeedTiddler(client, "$:/plugins/dsh-tiddlywiki/seed-render") !== void 0) return false;
	}
	const existing = await readSeedTiddler(client, RENDER_PLUGIN_TITLE);
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
			version: "0.2.0",
			description: "把 wiki 文本原生渲染成 HTML 片段（POST /render 服务端路由），供 DSH 回复流工具卡与 wiki 链接跳转使用"
		});
		wrote = true;
	}
	await writeSeedMarker(client, RENDER_MARKER_TITLE);
	return wrote;
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
* The config tiddler EXISTS but cannot be understood (v0.23.4).
*
* `set()` used to fall back to the in-memory cache when the stored text failed
* to parse — and right after a failed `load()` that cache is EMPTY, so a single
* settings-page save silently replaced the whole config with just the fields
* the form happened to send. That is exactly what happened on 2026-09-18 after
* a leftover `<<<<<<<` conflict block (committed by the auto-committer) made
* the tiddler unparseable: `prompt.extra` / `git.remote` / `ui.*` were wiped.
* Saving is now REFUSED instead, and the reason is surfaced to the user.
*/
var ConfigUnreadableError = class extends Error {
	raw;
	constructor(message, raw) {
		super(message);
		this.raw = raw;
		this.name = "ConfigUnreadableError";
	}
};
/** User-facing explanation for a refused save (kept next to the config tiddler name). */
function describeUnreadableConfig() {
	return `配置 tiddler ${CONFIG_TIDDLER} 存在但不是合法 JSON（常见原因：git 冲突标记 <<<<<<< 残留，或手工编辑出错）。为避免抹掉其它设置，本次保存已被拒绝。请先修好该 tiddler（或删除它、回落到 cordis config 块）再保存。`;
}
/**
* Runtime config store: caches the override tiddler and exposes the effective
* (merged) config. `load` runs at startup and after every write/restart.
*/
var ConfigStore = class {
	base;
	overrides = {};
	/** Set when the stored tiddler exists but cannot be parsed (v0.23.4). */
	lastParseError;
	constructor(base) {
		this.base = base;
	}
	/** Effective config = cordis base overlaid with the user override tiddler. */
	get() {
		return deepMerge(this.base, this.overrides);
	}
	/**
	* Why the stored config is unusable, or undefined when everything is fine.
	* `/admin/state` exposes this so the settings page can show a banner instead
	* of pretending the (ignored) overrides are in effect.
	*/
	parseError() {
		return this.lastParseError;
	}
	/**
	* Reload the override tiddler (no-op when the wiki is unavailable).
	*
	* A MISSING tiddler (404) legitimately means "no overrides" and clears the
	* cache. A transient FAILURE (wiki restarting, timeout, 5xx) must NOT: wiping
	* the cache on error silently reverted every user setting for the rest of the
	* session, and the next `set()` then persisted a config tiddler without the
	* user's other overrides.
	*
	* A tiddler that exists but does not PARSE is a third case (v0.23.4): the
	* cache is kept (writes are refused, so nothing can be lost) and the failure
	* is recorded for the UI — see ConfigUnreadableError.
	*/
	async load(client) {
		if (client === void 0) {
			this.overrides = {};
			this.lastParseError = void 0;
			return;
		}
		let tiddler;
		try {
			tiddler = await client.get(CONFIG_TIDDLER);
		} catch (err) {
			console.warn("[dsh-tiddlywiki] config tiddler unreadable, keeping cached overrides:", err instanceof Error ? err.message : err);
			return;
		}
		if (tiddler === void 0) {
			this.overrides = {};
			this.lastParseError = void 0;
			return;
		}
		const raw = typeof tiddler.text === "string" ? tiddler.text : "";
		try {
			const parsed = JSON.parse(raw);
			if (!isPlainObject(parsed)) throw new Error("config tiddler is not a JSON object");
			this.overrides = parsed;
			this.lastParseError = void 0;
		} catch {
			this.lastParseError = describeUnreadableConfig();
			console.warn("[dsh-tiddlywiki] config tiddler is not valid JSON, keeping cached overrides; saving is blocked until it is fixed");
		}
	}
	/**
	* Merge a patch into the overrides and persist the tiddler.
	*
	* The patch is merged onto the STORED overrides (re-read here), not just the
	* in-memory cache: if the startup `load()` failed transiently, saving one
	* setting must not drop every other override the user had stored.
	*
	* ⚠️ When the stored tiddler exists but is UNPARSEABLE this THROWS
	* (v0.23.4) instead of merging onto an empty cache — see ConfigUnreadableError.
	*/
	async set(client, patch) {
		let stored = this.overrides;
		let existingCreated;
		let storedText;
		try {
			const tiddler = await client.get(CONFIG_TIDDLER);
			if (tiddler !== void 0 && typeof tiddler.text === "string") {
				storedText = tiddler.text;
				const parsed = JSON.parse(tiddler.text);
				if (!isPlainObject(parsed)) throw new Error("config tiddler is not a JSON object");
				stored = parsed;
			}
			if (tiddler !== void 0 && typeof tiddler.created === "string" && tiddler.created.trim().length > 0) existingCreated = tiddler.created;
		} catch (err) {
			if (storedText !== void 0) {
				this.lastParseError = describeUnreadableConfig();
				throw new ConfigUnreadableError(describeUnreadableConfig(), storedText);
			}
		}
		this.overrides = deepMerge(stored, patch);
		await client.put({
			title: CONFIG_TIDDLER,
			text: JSON.stringify(this.overrides, null, 2),
			type: "application/json",
			tags: [],
			...existingCreated !== void 0 ? { created: existingCreated } : {}
		});
		return this.get();
	}
};
//#endregion
//#region src/host/seeds.ts
/**
* Wait until a file exists on disk (polling), up to `timeoutMs`.
*
* TW's syncer flushes REST writes to the filesystem on a ~250ms task timer, so
* a freshly seeded tiddler is not on disk the moment PUT resolves. A caller
* that must restart TW right after (so a seeded SERVER-route plugin loads) has
* to wait for the flush first — otherwise the restarted TW boots from a stale
* snapshot, loses every in-memory write that had not been flushed yet, and the
* seeded route is missing.
*
* `newerThanMs` makes the wait meaningful when the file ALREADY exists: it must
* also have been (re)written after that timestamp, which is what a re-seed
* produces. Without it an existing file would satisfy the wait immediately and
* the caller would restart TW over in-flight writes (the v0.18.0 regression the
* seeds-admin verify test caught).
*/
async function waitForFileWrite(filePath, timeoutMs = 8e3, pollMs = 150, newerThanMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			if (existsSync(filePath)) {
				if (newerThanMs === void 0) return true;
				if (statSync(filePath).mtimeMs >= newerThanMs) return true;
			}
		} catch {}
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, pollMs));
	}
}
/** The only seed that carries a TW SERVER route — it needs a TW restart to load. */
const RESTART_REQUIRED_SEED_IDS = ["render-route"];
/**
* Flush sentinel. TW's REST layer answers 204 as soon as the tiddler is in the
* in-memory store; the filesystem syncer writes it on a ~250ms timer. A restart
* in that window boots from the OLD snapshot and silently loses every write
* still queued — the v0.18.0 review caught it for the render plugin file, but
* any write could be lost (force-all repeatedly lost `tw-web-host`).
*
* A sentinel alone is NOT enough (v0.22.0). TW's syncer defers a title whose
* last save is younger than `throttleInterval` (`$:/config/SyncThrottleInterval`,
* default 1s): `chooseNextTask()` picks the first title that `hasChanged` AND is
* ready, and SKIPS throttled ones — so the sentinel (a different, never-saved
* title) can land while another dirty title is still deferred. v0.19.0's
* "probe landed ⇒ queue drained" assumption is therefore false, and the extra
* marker writes of v0.22.0 were enough to make `tw-web-host` the deferred title
* every time. See `flushPendingWrites()` for the two-phase fix.
*/
const FLUSH_PROBE_TITLE = "$:/plugins/dsh-tiddlywiki/flush-probe";
/** TW default `$:/config/SyncThrottleInterval` (ms) when the tiddler is absent. */
const DEFAULT_SYNC_THROTTLE_MS = 1e3;
/** Read TW's sync throttle interval (ms), clamped; a read failure → the default. */
async function readSyncThrottleMs(client) {
	try {
		const raw = (await client.get("$:/config/SyncThrottleInterval"))?.text?.trim();
		const parsed = raw === void 0 || raw.length === 0 ? NaN : Number.parseInt(raw, 10);
		if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SYNC_THROTTLE_MS;
		return Math.min(parsed, 1e4);
	} catch {
		return DEFAULT_SYNC_THROTTLE_MS;
	}
}
/**
* Flush the syncer queue before a restart.
*
* Returns true only when the store is provably QUIESCENT. Two phases, because a
* single probe can overtake a throttled title (see the doc block above):
*
*   1. write probe A and wait for A on disk — this drains everything the syncer
*      is willing to write now;
*   2. wait out one throttle window (no writes of ours in between), then write
*      probe B and wait for IT. Any title still dirty after phase 1 becomes
*      ready inside that window and is written, so only the probe remains.
*
* Returns false on timeout / a failed probe PUT; callers treat that as a warning
* (the operation still proceeds — this is best-effort hardening, not a gate).
*/
async function flushPendingWrites(client, tiddlersDir, timeoutMs = 12e3) {
	const deadline = Date.now() + timeoutMs;
	const probeAndWait = async (phase) => {
		const stamp = `flush ${phase} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
		try {
			await client.put({
				title: FLUSH_PROBE_TITLE,
				text: stamp
			});
		} catch {
			return false;
		}
		for (;;) {
			try {
				for (const name of readdirSync(tiddlersDir)) {
					if (!name.includes("dsh-tiddlywiki_flush-probe")) continue;
					try {
						if (readFileSync(join(tiddlersDir, name), "utf8").includes(stamp)) return true;
					} catch {}
				}
			} catch {}
			if (Date.now() >= deadline) return false;
			await new Promise((r) => setTimeout(r, 150));
		}
	};
	if (!await probeAndWait("a")) return false;
	const waitMs = Math.min(await readSyncThrottleMs(client) + 400, 4e3);
	await new Promise((r) => setTimeout(r, waitMs));
	return probeAndWait("b");
}
/** Did one of the RESTART_REQUIRED seeds actually write something? */
function needsRestartAfterSeeds(results) {
	return results.some((r) => r.ok && r.wrote && RESTART_REQUIRED_SEED_IDS.includes(r.id));
}
/**
* THE ONLY SANCTIONED WAY TO STOP OR RESTART THE TW CHILD (v0.24.1).
*
* WHY THIS WRAPPER EXISTS
* -----------------------
* Ironclad rule #1 ("drain the syncer queue before restarting TW") had four
* call sites and only three of them obeyed it. The two manual restart routes
* (`POST /restart`, `POST /admin/restart`), the plugins/themes restart in
* `POST /admin/info` and the knowledge-base switch (`stopServer`) all killed the
* child with writes still queued — and a queued write is simply lost, silently,
* exactly like the v0.19.0 `tw-web-host` loss. A rule that lives only in prose
* gets re-broken by the next person who adds a restart.
*
* So the drain is now INSIDE the primitive: a caller cannot stop TW without
* going through it, and `scripts/verify-restart-drain.mjs` asserts that no
* `server.restart()` / `server.stop()` call site exists outside this wrapper.
*
* Best-effort by design: a failed drain logs and still stops (refusing to
* restart would leave the user unable to recover from a wedged TW). Returns
* whether the store was provably quiescent — callers surface it in their
* response so an incomplete drain is observable rather than silent.
*/
async function drainThenStop(options) {
	const drained = options.client === void 0 ? true : await flushPendingWrites(options.client, options.tiddlersDir).catch(() => false);
	if (!drained) options.log?.("syncer queue may not be fully drained — writes still queued at restart time could be lost");
	await options.stop();
	return drained;
}
/**
* Presence probe for a seed's `check`. A 404 means "missing"; every other
* failure PROPAGATES (the caller `checkAllSeeds` turns it into a failed check)
* — swallowing it here would report "缺失" for a service that is merely
* unavailable and invite an overwrite.
*/
const presentOf = (ctx, title) => ctx.client.get(title).then((t) => t !== void 0);
/** Build the per-item detail from an unseed result. */
const removedDetail = (id, removed) => ({
	id,
	ok: true,
	wrote: false,
	detail: removed.length > 0 ? `已移除：${removed.join("、")}` : "本就不存在，无需移除"
});
/**
* Compare a seed's built-in content with what is in the wiki + with the hashes
* recorded when it was seeded (v0.22.0).
*
* Decision table (per tiddler):
*   - recorded hash === current built-in  → nothing changed;
*   - recorded hash !== current built-in  → the built-in MOVED ON (`updateAvailable`);
*   - stored text    !== recorded hash    → a human edited it (`userModified: true`);
*   - no recorded hash + text === built-in → LEGACY marker (pre-hash); ownership
*     is proven, so the caller may upgrade the marker;
*   - no recorded hash + text !== built-in → either the user edited it or the
*     built-in changed: `updateAvailable` with `userModified: undefined`
*     (unknown) — never silently overwrite on that basis.
*/
async function inspectSeedContent(ctx, content, markerTitle) {
	const markerState = markerTitle === void 0 ? {} : await readSeedMarker(ctx.client, markerTitle);
	const hashes = markerState.marker?.hashes ?? {};
	const missing = [];
	let updateAvailable = false;
	let userModified = false;
	let legacyMarker = markerState.legacy === true;
	for (const item of content) {
		const current = await readSeedTiddler(ctx.client, item.title);
		if (current === void 0) {
			missing.push(item.title);
			continue;
		}
		const stored = typeof current.text === "string" ? current.text : "";
		const builtinHash = hashText(item.text);
		const recorded = hashes[item.title];
		if (recorded !== void 0) {
			if (recorded !== builtinHash) updateAvailable = true;
			if (hashText(stored) !== recorded) userModified = true;
		} else if (stored === item.text) legacyMarker = true;
		else {
			updateAvailable = true;
			if (userModified !== true) userModified = void 0;
		}
	}
	return {
		missing,
		updateAvailable,
		userModified,
		legacyMarker
	};
}
/**
* Record/refresh the marker's content hashes after a run (v0.22.0). Only
* tiddlers whose stored text equals the built-in text are hashed — that is what
* "we own this content" means, and it keeps user-edited copies out of the
* bookkeeping. Existing hashes are merged (never dropped), so a run that
* skipped an edited tiddler does not forget the others.
*/
async function refreshSeedMarker(content, markerTitle, ctx, previousHashes) {
	try {
		const hashes = { ...previousHashes };
		for (const item of await content(ctx)) {
			const current = await readSeedTiddler(ctx.client, item.title);
			if ((current === void 0 ? void 0 : typeof current.text === "string" ? current.text : "") === item.text) hashes[item.title] = hashText(item.text);
		}
		if (!(Object.keys(hashes).length === Object.keys(previousHashes).length && Object.keys(hashes).every((key) => hashes[key] === previousHashes[key]))) await writeSeedMarker(ctx.client, markerTitle, hashes);
	} catch (err) {
		console.warn(`[dsh-tiddlywiki] seed marker hash refresh failed (${markerTitle}):`, err instanceof Error ? err.message : err);
	}
}
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
	const { id, title, description, core, startup, markerTitle } = meta;
	const removable = !core;
	if (impl.check === void 0 && (impl.presentTitle === void 0 || impl.presentTitle.length === 0)) throw new Error(`seed "${id}" needs either presentTitle or check`);
	if (impl.run === void 0 && impl.write === void 0) throw new Error(`seed "${id}" needs either write or run`);
	const presenceCheck = impl.check ?? (async (ctx) => {
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
	/**
	* A `content`-declaring seed reports update/modification state ALONGSIDE its
	* own presence check. ⚠️ This must wrap the custom check, not be skipped when
	* one exists: `starter-docs` / `home-index` / `ui-styles` all have custom
	* checks AND custom runners, and an earlier version of this wiring silently
	* left them without update detection (the gap was invisible because the E2E
	* only covered `doc-note`).
	*/
	const check = impl.content === void 0 ? presenceCheck : async (ctx) => {
		const base = await presenceCheck(ctx);
		const state = await inspectSeedContent(ctx, await impl.content(ctx), markerTitle);
		const missingDetail = state.missing.length > 0 ? `缺失：${state.missing.join("、")}` : base.detail ?? "缺失";
		const bits = [base.present ? base.detail ?? "已存在" : missingDetail];
		if (state.updateAvailable) bits.push("内置内容有更新");
		if (state.userModified === true) bits.push("本地已修改");
		else if (state.userModified === void 0 && state.updateAvailable) bits.push("无法确认是否本地已修改");
		else if (state.legacyMarker) bits.push("更新检测尚未启用（重新初始化一次即可）");
		return {
			...base,
			updateAvailable: state.updateAvailable,
			userModified: state.userModified,
			legacyMarker: state.legacyMarker,
			detail: bits.join(" · ")
		};
	};
	/**
	* Run wrapper. It ALWAYS wraps (v0.22.0): a custom `run` still needs the
	* marker-hash refresh afterwards, which is what makes「内置内容有更新」work
	* for the seeds that write through their own runner.
	*/
	const run = async (ctx, force) => {
		try {
			const previous = markerTitle === void 0 ? {} : (await readSeedMarker(ctx.client, markerTitle)).marker?.hashes ?? {};
			const result = impl.run !== void 0 ? await impl.run(ctx, force) : await (async () => {
				const wrote = await impl.write(ctx.client, {
					force,
					tools: ctx.tools
				});
				return {
					id,
					ok: true,
					wrote,
					detail: wrote ? force ? "已重新初始化" : "已写入" : force ? "内容已是最新（未重写）" : "已存在，跳过"
				};
			})();
			if (impl.content !== void 0 && markerTitle !== void 0 && result.ok) await refreshSeedMarker(impl.content, markerTitle, ctx, previous);
			return result;
		} catch (err) {
			return {
				id,
				ok: false,
				wrote: false,
				error: err instanceof Error ? err.message : String(err)
			};
		}
	};
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
		...markerTitle === void 0 ? {} : { markerTitle },
		...impl.gate === void 0 ? {} : { gate: impl.gate },
		...impl.content === void 0 ? {} : { content: impl.content },
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
		markerTitle: SEED_MARKER_TITLE,
		core: false,
		startup: true
	}, {
		content: async (ctx) => [{
			title: DOC_NOTE_TITLE,
			text: docNoteText(ctx.tools ?? [])
		}],
		presentTitle: DOC_NOTE_TITLE,
		write: seedDocNote,
		unseed: unseedDocNote
	}),
	defineSeed({
		id: "starter-docs",
		title: "示例与文档（汇总模板 / 教程 / 主题页示例）",
		description: "新手文档中心起步包：主题汇总页·模板、教程（按主题/标签做汇总页）、三个可直接运行的示例主题页（日志 / 决策记录 / 排障）。全部打 dsh-docs 标签，自动出现在首页「📚 插件文档」栏；纯示例无个人数据，同名 tiddler 已存在则安全跳过，不会覆盖。首次安装默认写入，可反初始化。",
		markerTitle: STARTER_DOCS_MARKER_TITLE,
		core: false,
		startup: true
	}, {
		content: async () => STARTER_DOCS_ITEMS.map((i) => ({
			title: i.title,
			text: i.text
		})),
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
		markerTitle: SEND_TO_AGENT_MARKER_TITLE,
		core: true
	}, {
		content: async () => [{
			title: SEND_TO_AGENT_PLUGIN_TITLE,
			text: SEND_TO_AGENT_BUNDLE_TEXT
		}],
		presentTitle: SEND_TO_AGENT_PLUGIN_TITLE,
		write: seedSendToAgent
	}),
	defineSeed({
		id: "render-route",
		title: "原生渲染路由（/render）",
		description: "TW 服务端路由插件（$:/plugins/dsh/render，server-routes/render.js）——把 wiki 文本在运行中的 TW 里原生渲染成 HTML 片段，回复流工具卡与 wiki 链接跳转依赖它。seed 写入后需重启 TW 使路由生效。",
		markerTitle: RENDER_MARKER_TITLE,
		core: true
	}, {
		content: async () => [{
			title: RENDER_PLUGIN_TITLE,
			text: RENDER_BUNDLE_TEXT
		}],
		presentTitle: RENDER_PLUGIN_TITLE,
		write: seedRenderRoute
	}),
	defineSeed({
		id: "home-index",
		title: "首页（主页 / 所有标签 / 标签笔记）",
		description: "默认主页：四象限待办 + 「所有标签」「所有文章」入口；所有标签：标签统计 + Agent 区块（纯 Agent / Agent+人工）；标签笔记：按标签浏览。系统提示承诺的首页由这里 seed，主页（🏠 主页）同时写入 $:/DefaultTiddlers。",
		markerTitle: HOME_INDEX_MARKER_TITLE,
		core: false
	}, {
		content: async () => HOME_INDEX_ITEMS.map((i) => ({
			title: i.title,
			text: i.text
		})),
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
		markerTitle: ALL_ARTICLES_MARKER_TITLE,
		core: false
	}, {
		content: async () => [{
			title: ALL_ARTICLES_TITLE,
			text: ALL_ARTICLES_TEXT
		}],
		presentTitle: ALL_ARTICLES_TITLE,
		write: seedAllArticles,
		unseed: unseedAllArticles
	}),
	defineSeed({
		id: "ui-styles",
		title: "自定义样式（编辑器美化 / 窄屏侧栏 / menubar 加高 / 批注弹窗）",
		description: "5 张通用样式表（tag $:/tags/Stylesheet）：编辑器美化（CodeMirror 字体/光标/行号）、标题与按钮区分开、侧边栏窄屏自动隐藏（<960px）、menubar 顶栏加高、批注弹窗美化。纯样式无个人数据。",
		markerTitle: UI_STYLES_MARKER_TITLE,
		core: false
	}, {
		content: async () => UI_STYLE_ITEMS.map((i) => ({
			title: i.title,
			text: i.text
		})),
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
		markerTitle: MENUBAR_THEME_MARKER_TITLE,
		core: false
	}, {
		content: async () => [{
			title: MENUBAR_THEME_TIDDLER,
			text: MENUBAR_THEME_TEXT
		}],
		presentTitle: MENUBAR_THEME_TIDDLER,
		write: seedMenubarTheme,
		unseed: unseedMenubarTheme
	}),
	defineSeed({
		id: "clip-bridge",
		title: "本地剪藏桥（书签小工具）",
		description: "「本地剪藏桥 + 书签小工具」使用说明（Markdown 文档，带书签代码/启用步骤/安全说明）：DSH 监听 127.0.0.1 端口接收剪藏请求，浏览器书签一键把当前页标题/URL/选中文字写进知识库（配置 bridge.*，默认 clip 标签）。真功能在插件运行时代码里，此 seed 只预置说明文档。",
		markerTitle: CLIP_BRIDGE_MARKER_TITLE,
		core: false
	}, {
		content: async () => [{
			title: CLIP_BRIDGE_DOC_TITLE,
			text: CLIP_BRIDGE_DOC_TEXT
		}],
		presentTitle: CLIP_BRIDGE_DOC_TITLE,
		write: seedClipBridge,
		unseed: unseedClipBridge
	}),
	defineSeed({
		id: "publish-spec",
		title: "发布元数据规范（可选：需开启微信公众号发布）",
		description: "「发布元数据规范」文档（Markdown）：约定用 pub-state / pub-platform / pub-wechat-* 等自定义字段记录每篇笔记的对外发布状态（已发/未发/不可发），以及 no-publish 标签约定；供发布流程与 agent 判断「这篇发过没有、能不能发」使用。**属于可选功能**：仅当设置页开启「微信发布」（wechat.enabled）时启动才会写入，否则完全跳过。",
		markerTitle: PUBLISH_SPEC_MARKER_TITLE,
		core: false,
		startup: true
	}, {
		content: async () => [{
			title: PUBLISH_SPEC_TITLE,
			text: PUBLISH_SPEC_TEXT
		}],
		presentTitle: PUBLISH_SPEC_TITLE,
		write: seedPublishSpec,
		unseed: unseedPublishSpec,
		gate: (ctx) => ctx.wechat === true
	}),
	defineSeed({
		id: "wechat-setup",
		title: "微信公众号发布指南（可选：需开启微信公众号发布）",
		description: "「微信公众号发布指南」文档（Markdown，逐字节等于仓库 docs/wechat-publish-setup.md）：在另一台机器上还原发布能力的完整步骤——opencli 安装、Browser Bridge 浏览器扩展、公众号登录、装 adapter、试跑命令、发布元数据、三个必须知道的坑（trace / 扫码 / 发表≠群发）、排错表。**属于可选功能**：仅当设置页开启「微信发布」（wechat.enabled）时启动才会写入，否则完全跳过（与发布元数据规范同进同退）。",
		markerTitle: WECHAT_DOCS_MARKER_TITLE,
		core: false,
		startup: true
	}, {
		content: async () => [{
			title: WECHAT_DOCS_TITLE,
			text: WECHAT_DOCS_TEXT
		}],
		presentTitle: WECHAT_DOCS_TITLE,
		write: seedWechatDocs,
		unseed: unseedWechatDocs,
		gate: (ctx) => ctx.wechat === true
	}),
	defineSeed({
		id: "wechat-publish",
		title: "「发布到公众号」按钮（可选：需开启微信公众号发布）",
		description: "TW 笔记工具栏「发布到公众号」按钮插件（$:/plugins/dsh/wechat-publish）——把当前笔记一键存进公众号**草稿箱**（宿主进程调 opencli 驱动你已登录的浏览器；发表需人工扫码，脚本不做）。按钮先做预检（opencli + adapter 是否就位），再起一个可轮询的后台任务并显示进度。**属于可选功能**：仅当设置页开启「微信发布」（wechat.enabled）时启动才会写入，否则完全跳过（与发布元数据规范 / 公众号发布指南同进同退）。",
		markerTitle: WECHAT_PUBLISH_MARKER_TITLE,
		core: false,
		startup: true
	}, {
		content: async () => [{
			title: WECHAT_PUBLISH_PLUGIN_TITLE,
			text: WECHAT_PUBLISH_BUNDLE_TEXT
		}],
		presentTitle: WECHAT_PUBLISH_PLUGIN_TITLE,
		write: seedWechatPublish,
		unseed: unseedWechatPublish,
		gate: (ctx) => ctx.wechat === true
	}),
	defineSeed({
		id: "tw-web-host",
		title: "TW 前端 API 基址（同源代理）",
		description: "把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。",
		core: true
	}, {
		check: async (ctx) => {
			const current = (await ctx.client.get(TW_WEB_HOST_TIDDLER))?.text?.trim();
			const present = typeof current === "string" && current.length > 0 && current !== "$protocol$//$host$/";
			return {
				id: "tw-web-host",
				title: "TW 前端 API 基址（同源代理）",
				description: "把 $:/config/tiddlyweb/host 指向 DSH 同源代理，嵌入式 TW 才能经 DSH origin 访问（远程访问模式的前提）。",
				present,
				removable: false,
				detail: present ? current === TW_PROXY_PATH ? `已指向 ${TW_PROXY_PATH}` : `已指向自定义基址 ${current}（保留，不会覆盖）` : `当前：${current ?? "（缺失）"}，应为 ${TW_PROXY_PATH}`
			};
		},
		run: async (ctx, force) => {
			try {
				const current = (await ctx.client.get(TW_WEB_HOST_TIDDLER))?.text?.trim();
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
		if (def.gate !== void 0 && !def.gate(ctx)) continue;
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
//#region src/host/write-policy.ts
/** 约定标签：标记「由 Agent 撰写」的笔记（新建时自动补打）。 */
const AGENT_WRITTEN_TAG = "agent-written";
/** 约定标签：标记「Agent 撰写后又经人类编辑」的笔记。 */
const HUMAN_EDITED_TAG = "human-edited";
/** Agent / 人类笔记的默认内容类型（TW 对无 type 的条目按 wikitext 解析）。 */
const DEFAULT_NOTE_TYPE = "text/markdown";
/**
* 构造 PUT body 时跳过的字段（身份/内容）。
*
* ⚠️ `type` **不在**这里（v0.20.1 修复）：它曾被误列为跳过字段，于是
* `cleanTiddler(existing)` 把条目的内容类型丢掉，`finalTypeForWrite()` 随后又
* 补上默认的 `text/markdown`（或干脆不写 type → TW 回落 `text/vnd.tiddlywiki`）。
* 结果：任何「覆盖已有条目」的路径都会静默改掉类型——
*   - `text/css` 的样式条目被改成 `text/markdown` → 整篇 CSS 被当 Markdown 渲染；
*   - `text/markdown` 笔记被改成 `text/vnd.tiddlywiki` → `##`/`**粗体**`/表格全按
*     wikitext 解析（磁盘上 `.md` + `.meta` 也变成 `.tid`）。
* 内容类型是条目的解析方式，必须与 tags/自定义字段一样按「以已有条目为基底」保留。
*
* ⚠️ `created`/`modified` 也**不再**在这里（v0.22.10 修复）：它们曾被当成「TW 自己
* 拥有的时间戳，服务端会补」而丢弃——**TW 的服务端写路径从不补这两个字段**
* （`core-server` 的 put 路由只是 `addTiddler(new $tw.Tiddler(fields,{title}))`，
* `getCreationFields()`/`getModificationFields()` 只在 TW **自己的 UI** 里被调用；
* 实测 `tiddlywiki_put` 新建条目落盘只有 tags/title/type）。于是插件写下的条目在
* `+[!sort[modified]]` 这类页面上被 `sortTiddlers` 的 `fields[sortField] || ""`
* 当空串——降序时**沉到最后一名**，看起来就像「没被收录」。现在这两个字段由
* `buildWriteTiddler()` 负责写入（见 `stampTiddlerTimes`），与 TW 编辑器行为一致。
*/
const CLEAN_SKIP_FIELDS = /* @__PURE__ */ new Set([
	"title",
	"text",
	"tags",
	"fields"
]);
/**
* 调用方**不得**通过 `fields` 覆盖的保留字段：它们是条目的身份/内容，时间戳
* 归 TW 所有。`type` 故意放行——那是显式指定内容类型的正规入口。
*/
const RESERVED_TIDDLER_FIELDS = /* @__PURE__ */ new Set([
	"title",
	"text",
	"tags",
	"created",
	"modified"
]);
/**
* TW 服务端 GET/listing 会为缺省 `type` 的条目**补上** `text/vnd.tiddlywiki`
* （get-tiddler.js / get-tiddlers-json.js 都有 `type = type || "text/vnd.tiddlywiki"`），
* 而 `bag` 也是响应里补的传输字段。回写时把这两个透传回去要么污染文件（type）、
* 要么被 TW 自行剥掉（bag/revision），所以从展示与回写里都排除。
*/
const TRANSPORT_FIELDS = /* @__PURE__ */ new Set([
	"bag",
	"revision",
	"recipe",
	"uri",
	"permissions"
]);
/** 写入冲突（乐观并发令牌不匹配）：路由层把它映射成 HTTP 409。 */
var WriteConflictError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "WriteConflictError";
	}
};
/**
* 把单条 GET 返回的字段**摊平**成模型/路由可直接读的形状：
* 嵌套 `fields` 里的自定义字段提到顶层，`bag`/`revision` 等传输字段排除。
*/
function flattenTiddlerFields(tiddler) {
	const out = {};
	for (const [key, value] of Object.entries(tiddler)) {
		if (key === "title" || key === "text" || key === "tags" || key === "fields") continue;
		if (TRANSPORT_FIELDS.has(key)) continue;
		out[key] = value;
	}
	const nested = tiddler.fields;
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) for (const [key, value] of Object.entries(nested)) {
		if (key === "title" || key === "text" || key === "tags" || key === "fields") continue;
		if (value === void 0) continue;
		if (out[key] === void 0) out[key] = value;
	}
	return out;
}
/**
* 由已有条目构造一份可 PUT 的副本：字段摊平、tags 归数组、TW 拥有的时间戳丢掉。
* `type` 保留（含服务端补的默认值——语义等价，且能防止 Markdown 笔记被回退成
* wikitext；用户若显式改名内容类型，走 `fields.type`）。
*/
function cleanTiddler(t) {
	const out = {
		title: t.title,
		text: t.text ?? "",
		tags: t.tags ?? []
	};
	for (const [k, v] of Object.entries(t)) {
		if (CLEAN_SKIP_FIELDS.has(k) || TRANSPORT_FIELDS.has(k)) continue;
		out[k] = v;
	}
	const nested = t.fields;
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) for (const [k, v] of Object.entries(nested)) {
		if (CLEAN_SKIP_FIELDS.has(k) || TRANSPORT_FIELDS.has(k) || v === void 0) continue;
		out[k] = v;
	}
	return out;
}
/**
* 合并调用方显式提供的自定义字段（跳过保留字段与 undefined）。
*
* 模块私有（v0.22.8）：它只被 buildWriteTiddler 调用，导出会让「写策略只有一个
* 入口」这条约定出现第二个可绕过的门。`verify-write-policy.mjs` 断的是
* `buildWriteTiddler`/`cleanTiddler` 的对外行为，不需要这个内部步骤。
*/
function applyCustomFields(tiddler, fields) {
	if (fields === void 0 || fields === null || typeof fields !== "object") return;
	for (const [key, value] of Object.entries(fields)) {
		if (RESERVED_TIDDLER_FIELDS.has(key)) continue;
		if (value === void 0) continue;
		tiddler[key] = value;
	}
}
/** 归一化工具/路由的 `tags` 参数（非数组或全空 → undefined）。 */
function normalizeTagArg(tags) {
	if (!Array.isArray(tags)) return void 0;
	const list = tags.filter((t) => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
	return list.length > 0 ? list : void 0;
}
/**
* 计算最终标签（模块私有，v0.22.8）：只被 `buildWriteTiddler` 调用，导出会让
* 「新条目补 agent-written」这条规则出现绕过 buildWriteTiddler 的第二条路。
*
* - 已存在的条目 → 调用方给什么就是什么（不给 = 保留基底里的原标签）；
* - 新条目 + `agentTag` → 自动补 `agent-written`（`$:/` 系统条目除外）；
* - 新条目 + 人类入口（`agentTag: false`，如快速笔记 / `/note`）→ 不补，
*   人类写的笔记不该被标成 agent 撰写。
*/
function finalTagsForWrite(title, existing, tags, agentTag) {
	if (existing !== void 0) return tags;
	if (!agentTag) return tags;
	if (title.startsWith("$:/")) return tags;
	if (tags.includes("agent-written")) return tags;
	return [...tags, AGENT_WRITTEN_TAG];
}
/**
* 计算最终内容类型（原地改 tiddler）：显式 type 优先；**只有新建条目**才回落
* Markdown，`$:/` 条目保持 TW 默认。
*
* v0.20.1：`isNew=false`（覆盖既有条目）时**绝不**发明类型——基底里有什么就是
* 什么；基底没有 type（极少数情况）也保持「没有」，让 TW 继续按 wikitext 处理，
* 而不是把它升级成 Markdown。改类型是调用方的显式动作（`fields.type`）。
*/
function finalTypeForWrite(title, tiddler, isNew = true) {
	if (typeof tiddler.type === "string" && tiddler.type.length > 0) return { defaulted: false };
	if (!isNew) return { defaulted: false };
	if (title.startsWith("$:/")) return { defaulted: false };
	tiddler.type = DEFAULT_NOTE_TYPE;
	return { defaulted: true };
}
/**
* 给要写出的条目补 `created`/`modified`（v0.22.10），语义与 TW 编辑器一致：
*
* | 情形 | created | modified |
* |---|---|---|
* | 新建（含首次写入的 `$:/`） | 当前时刻 | 当前时刻 |
* | 覆盖既有条目、基底有 created | **基底原值** | 当前时刻 |
* | 覆盖既有条目、基底无 created（迁移存量） | 当前时刻 | 当前时刻 |
*
* 为什么必须由插件来写：TW 的 `getCreationFields()`/`getModificationFields()`
* 只在 **TW 自己的 UI**（`$tw.wiki.setTiddlerData`、navigation/editor widgets…）
* 里被调用；服务端的 PUT 路由只做
* `state.wiki.addTiddler(new $tw.Tiddler(fields, {title: title}))`，**不会补**
* 这两个字段。所以「服务端会补」这个假设是错的，缺 `modified` 的条目会被
* `sortTiddlers` 的 `fields[sortField] || ""` 当成空串——`!sort[modified]` 降序时
* 直接沉到最后一名（用户看到的现象：新日记在「主题页·日志」里排 175/175）。
*
* 值是 TW 的紧凑格式 `YYYYMMDDhhmmssSSS`（UTC），与 `$tw.utils.stringifyDate()`
* 逐字节一致，TW 的日期字段模块能正常 parse/stringify/显示。
*/
function stampTiddlerTimes(tiddler, existing, now = /* @__PURE__ */ new Date()) {
	const stamp = formatTiddlerDate(now);
	tiddler.created = (typeof existing?.created === "string" && existing.created.trim().length > 0 ? existing.created : void 0) ?? stamp;
	tiddler.modified = stamp;
}
/**
* 构造一次写要 PUT 的 tiddler。
*
* - 已有条目 → 以其为基底（标签、自定义字段、**内容类型**、**created** 全部保留）；
* - 新条目 → `{title, text}` + 默认/显式标签（`$:/` 不带 agent 标签）；
* - `fields` 逐个覆盖；`type` 未指定时**仅新建条目**补 Markdown（`$:/` 除外）；
* - `created`/`modified` 一律补写（v0.22.10，见 `stampTiddlerTimes`）——TW 的服务端
*   写路径**不会**补这两个字段，缺它们的条目会在 `!sort[modified]` 里沉底。
*/
function buildWriteTiddler(title, text, options = {}) {
	const { existing, fields } = options;
	const agentTag = options.agentTag !== false;
	const tiddler = existing !== void 0 ? {
		...cleanTiddler(existing),
		title,
		text
	} : {
		title,
		text
	};
	if (options.tags !== void 0) {
		const finalTags = finalTagsForWrite(title, existing, options.tags, agentTag);
		if (finalTags.length > 0) tiddler.tags = finalTags;
		else delete tiddler.tags;
	} else if (existing === void 0) {
		const finalTags = finalTagsForWrite(title, void 0, options.defaultTags !== void 0 && options.defaultTags.length > 0 ? options.defaultTags : [], agentTag);
		if (finalTags.length > 0) tiddler.tags = finalTags;
	}
	applyCustomFields(tiddler, fields);
	const { defaulted } = finalTypeForWrite(title, tiddler, existing === void 0);
	stampTiddlerTimes(tiddler, existing, options.now);
	return {
		tiddler,
		typeDefaulted: defaulted
	};
}
/**
* 乐观并发守卫：调用方可以传 `tiddlywiki_get` 读到的 `modified` 或 `revision`；
* 与当前值不一致就拒绝写入，避免覆盖人类在 TW 编辑器里的并发修改。
*
* ⚠️ 两个令牌是 **AND**，不是 OR（v0.23.5 修复）。旧实现「`modified` 命中就放行、
* 否则再看 `revision`」，有两个真实缺陷：
*   1. `revision` 是 TW `wiki.js` 里的**内存**计数器（`changeCount`），**不持久化**，
*      重启后每条回到 1。调用方读到 `revision: 1` → 人类改动 → 一次 pull/重启让
*      计数复位 → 带 `expectedRevision: 1` 的写入被判「一致」而**静默覆盖**人类改动。
*   2. 同时传两个令牌**并不会更安全**：`modified` 不匹配时会落到 `revision` 分支
*      继续写，等于调用方以为有两重保护、实际只有一重。
* 现在：**给了哪个令牌就必须匹配哪个**，任一不匹配即拒。只给一个令牌时语义不变
* （`revision` 仍是「刚 PUT 还没落盘」条目的唯一可用令牌，只是不再当作强令牌）。
*/
function assertNoConflict(title, existing, expected) {
	if (expected.force === true || existing === void 0) return;
	const wantsModified = expected.expectedModified !== void 0;
	const wantsRevision = expected.expectedRevision !== void 0;
	if (!wantsModified && !wantsRevision) return;
	let modifiedOk = true;
	if (wantsModified) {
		const expectedMs = parseTiddlerDate(expected.expectedModified);
		const currentMs = parseTiddlerDate(existing.modified);
		modifiedOk = expectedMs !== void 0 && currentMs !== void 0 && expectedMs === currentMs;
	}
	const currentRevision = existing.revision;
	const revisionOk = wantsRevision ? currentRevision !== void 0 && String(currentRevision) === String(expected.expectedRevision) : true;
	if (modifiedOk && revisionOk) return;
	const failed = [!modifiedOk ? "modified" : null, !revisionOk ? "revision" : null].filter(Boolean).join("、");
	const revisionHint = !revisionOk && modifiedOk ? "（注意：revision 是 TW 的内存计数器，重启/拉取后会复位——它只能证明「读到过」，长时间跨度的写入请用 expectedModified）" : "";
	throw new WriteConflictError(`写入冲突：tiddler「${title}」在你读取之后已被改动（不匹配的令牌：${failed}；当前 revision=${currentRevision ?? "?"} modified=${toIsoDateString(existing.modified) ?? "?"}；期望 revision=${expected.expectedRevision ?? "?"} modified=${expected.expectedModified ?? "?"}）。${revisionHint}请重新读取最新内容后重试；确认要用你的版本覆盖时可传 force: true。`);
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
//#region src/host/wechat-publish.ts
/**
* 微信公众号发布的宿主侧执行器（v0.23.3）。
*
* 背景：发布能力的**真身**是仓库 `tools/wechat/` 下那两个 opencli adapter
* (`publish-note` / `publish-note-imgs`)，它们驱动用户已登录的 Chrome 把一篇
* TiddlyWiki 笔记排好版存进公众号草稿箱。CLI 用法见 docs/wechat-publish-setup.md。
*
* 本模块把那条命令**包成一个可查询的后台任务**，好让 TW 工具栏按钮
* （`$:/plugins/dsh/wechat-publish`，可选功能，见 seedWechatPublish）能一键触发：
*
*   TW 按钮 → POST /wechat/publish → 这里 spawn opencli → 轮询
*   GET /wechat/publish/status → 覆盖层显示进度 → 存草稿成功/失败
*
* 四个必须讲清楚的设计点（都是踩出来的，别改回去）：
*
*  1. **标题不进 argv，走 UTF-8 文件**。Windows 上 `opencli` 是 `.cmd` shim，
*     Node 的 `spawn('opencli', …)` 直接 ENOENT，必须经 cmd.exe 才跑得起来 ——
*     于是标题里的 `&`/`|`/`^`/引号会变成命令注入面，中文标题还会被 cmd 的代码页
*     解码成乱码。现在宿主写 `<jobDir>/<id>.title`，argv 里只有我们自己生成的路径
*     （配合 adapter 的 `--title-file`，见 weixin-flow.resolveNoteTitle）。
*  2. **必须是一个 job，不是一次请求**。命令要跑几十秒到几分钟（多图更久，
*     发表还要等扫码），TW 的 `$tw.utils.httpRequest` 和 webserver 都不会陪你等。
*  3. **`--trace retain-on-failure` 是承重参数**（不带就对 mp.weixin.qq.com 稳定
*     报 `Navigation rejected`，实测 trace 开 5/5 成功、关 8/8 失败），所以它写死在
*     组装逻辑里，不暴露给调用方。
*  4. **就绪预检要认版本，不能只认文件**。`~/.opencli/clis/weixin/` 是用户态目录：
*     装着旧版 adapter 时文件一个不少，但旧入口把标题当**必填位置参数**、根本不认
*     `--title-file`（宿主只用 `--title-file`）—— 预检报「就绪」，用户点下按钮才
*     报「缺少必填参数」（v0.23.3 的真实事故）。所以 `scanAdapterDir` 除了
*     `missing` 还返回 `stale`，按**符号存在性**判版本（见 WECHAT_ADAPTER_MARKER）。
*
* 单并发：同一时刻只允许一个发布任务（`start()` 返回 busy）。这与路由的
* `/sync` `/restart` 互斥是同一思路 —— 两个 opencli 同时抢一个浏览器标签页没有
* 任何好处，只会互相踩。
*
* @module dsh-tiddlywiki/host/wechat-publish
*/
/** The two publish adapters this runner may drive (whitelist — never free text). */
const WECHAT_ADAPTERS = ["publish-note", "publish-note-imgs"];
/** Default adapter: the one that works with the four core adapter files. */
const DEFAULT_WECHAT_ADAPTER = "publish-note";
/** Default CLI (config `wechat.command` overrides it, e.g. an absolute path). */
const DEFAULT_WECHAT_COMMAND = "opencli";
/**
* Files each adapter needs in the opencli adapter directory. Mirrors
* install-wechat-adapters.mjs FILES (both publish adapters import the shared
* flow + decorator, so a half-installed directory must be reported as missing).
*/
const WECHAT_ADAPTER_FILES = {
	"publish-note": [
		"publish-note.js",
		"wechat-html.js",
		"weixin-flow.js"
	],
	"publish-note-imgs": [
		"publish-note-imgs.js",
		"wechat-html.js",
		"weixin-flow.js"
	]
};
/** The shared flow module every adapter imports (`resolveNoteTitle` lives here). */
const WECHAT_FLOW_FILE = "weixin-flow.js";
/** The argv key each entry adapter must declare to accept `--title-file`. */
const WECHAT_TITLE_FILE_ARG = "titleFile";
/**
* The one symbol only a v0.23.3+ install exports.
*
* Why symbol presence instead of file size or mtime: `~/.opencli/clis/weixin/`
* is a plain user-owned folder that `install-wechat-adapters.mjs` copies files
* into, so neither size nor timestamp says WHICH version is installed — an old
* adapter re-copied yesterday looks brand new, and a re-formatted (but current)
* file can shrink. The failure being guarded is behavioural, not cosmetic: a
* pre-v0.23.3 `publish-note.js` takes the title as a *required positional*
* argument and has never heard of `--title-file`, while the host only ever
* sends `--title-file` (the title must not enter argv, see module header) — so
* every file "exists", the readiness probe says 就绪, and the run dies with
* 「缺少必填参数」 only after the user presses the button (the v0.23.3
* accident). Symbol presence is the only cheap, exact answer to "can this file
* do what we are about to ask of it?".
*/
const WECHAT_ADAPTER_MARKER = "resolveNoteTitle";
/**
* file → a matcher deciding whether that file is CURRENT.
*
* ⚠️ A plain `includes(WECHAT_ADAPTER_MARKER)` is NOT enough (a guard-script
* fixture fooled itself this way): an old file that merely MENTIONS the symbol
* in a comment would pass. Match the actual definition instead —
*   - `weixin-flow.js` must **export** `resolveNoteTitle`;
*   - the entry adapters must **declare** the `titleFile` argument.
* `wechat-html.js` (the shared decorator) carries no version-specific contract,
* so it is never reported as stale.
*/
const WECHAT_FRESHNESS_MATCHERS = {
	[WECHAT_FLOW_FILE]: new RegExp(`export\\s+function\\s+${WECHAT_ADAPTER_MARKER}\\s*\\(`),
	"publish-note.js": new RegExp(`name:\\s*['"]${WECHAT_TITLE_FILE_ARG}['"]`),
	"publish-note-imgs.js": new RegExp(`name:\\s*['"]${WECHAT_TITLE_FILE_ARG}['"]`)
};
/** Captured output per stream; the job view only exposes the tail. */
const MAX_JOB_OUTPUT_CHARS = 64e3;
/** How much of the log the TW overlay shows (keeps the JSON response small). */
const JOB_LOG_TAIL_CHARS = 4e3;
/** How many finished jobs to remember for post-mortem lookups. */
const JOB_HISTORY_LIMIT = 20;
/**
* Normalize the raw `wechat` config block. Unknown/garbage values fall back to
* the defaults rather than reaching the spawn path — this object is built from a
* user-editable tiddler, so every field is treated as untrusted input.
*/
function normalizeWechatConfig(raw) {
	const source = typeof raw === "object" && raw !== null ? raw : {};
	const command = typeof source.command === "string" && source.command.trim().length > 0 ? source.command.trim() : DEFAULT_WECHAT_COMMAND;
	const token = typeof source.token === "string" ? source.token.trim() : "";
	const adapter = WECHAT_ADAPTERS.includes(source.adapter) ? source.adapter : DEFAULT_WECHAT_ADAPTER;
	const dsn = typeof source.dsn === "string" ? source.dsn.trim() : "";
	return {
		enabled: source.enabled === true,
		command,
		token,
		adapter,
		dsn
	};
}
/** True when a value may be embedded in the cmd.exe command line (v0.23.3). */
function isSafeCliValue(value) {
	return value.length > 0 && !/["&|<>^%\r\n\t\u0000-\u001f]/.test(value);
}
/**
* Validate the `--dsn` value: a plain http(s) URL without credentials, query or
* fragment (the adapters append `/render` and `/get` themselves).
*/
function isSafeDsn(dsn) {
	return /^https?:\/\/[A-Za-z0-9._-]+(:\d{1,5})?(\/[A-Za-z0-9._\-/]*)?$/.test(dsn);
}
/**
* Build the argv-equivalent for one publish run. Pure + exported so the guard
* script can assert the Windows shim path and the "no title in argv" property
* without spawning anything.
*
* Windows: `opencli` resolves through PATHEXT to `opencli.cmd`, which
* CreateProcess cannot execute — hence `cmd.exe /d /s /c "<line>"` with
* `windowsVerbatimArguments` so Node does not re-quote our already-quoted line.
*/
function buildPublishInvocation(opts) {
	if (!WECHAT_ADAPTERS.includes(opts.adapter)) throw new Error(`unsupported wechat adapter: ${String(opts.adapter)}`);
	if (!isSafeCliValue(opts.command)) throw new Error(`wechat.command contains characters that cannot be passed to the CLI: ${JSON.stringify(opts.command)}`);
	if (!isSafeCliValue(opts.titleFile)) throw new Error(`title file path is not safe for the command line: ${JSON.stringify(opts.titleFile)}`);
	if (!isSafeDsn(opts.dsn)) throw new Error(`invalid wechat dsn: ${JSON.stringify(opts.dsn)}`);
	const args = [
		"weixin",
		opts.adapter,
		"--title-file",
		opts.titleFile,
		"--dsn",
		opts.dsn,
		"--trace",
		"retain-on-failure",
		"-f",
		"json"
	];
	if (opts.platform === "win32") {
		const quote = (value) => value.includes(" ") ? `"${value}"` : value;
		const line = [quote(opts.command), ...args.map(quote)].join(" ");
		return {
			file: process.env.ComSpec !== void 0 && process.env.ComSpec.length > 0 ? process.env.ComSpec : "cmd.exe",
			args: [
				"/d",
				"/s",
				"/c",
				line
			],
			windowsVerbatimArguments: true
		};
	}
	return {
		file: opts.command,
		args,
		windowsVerbatimArguments: false
	};
}
/** `opencli --version`, used by the readiness probe. */
function buildVersionInvocation(opts) {
	if (!isSafeCliValue(opts.command)) throw new Error(`wechat.command contains characters that cannot be passed to the CLI: ${JSON.stringify(opts.command)}`);
	if (opts.platform === "win32") {
		const quote = (value) => value.includes(" ") ? `"${value}"` : value;
		return {
			file: process.env.ComSpec !== void 0 && process.env.ComSpec.length > 0 ? process.env.ComSpec : "cmd.exe",
			args: [
				"/d",
				"/s",
				"/c",
				`${quote(opts.command)} --version`
			],
			windowsVerbatimArguments: true
		};
	}
	return {
		file: opts.command,
		args: ["--version"],
		windowsVerbatimArguments: false
	};
}
/** Keep the first `limit` characters (stdout of a long run must not grow forever). */
function capOutput(text, limit = MAX_JOB_OUTPUT_CHARS) {
	return text.length <= limit ? text : text.slice(0, limit);
}
/** The tail of a log, with the last `limit` characters (overlay display). */
function tailOf(text, limit = JOB_LOG_TAIL_CHARS) {
	const trimmed = text.trim();
	return trimmed.length <= limit ? trimmed : trimmed.slice(trimmed.length - limit);
}
/**
* Turn the adapter's exit into a user-facing verdict.
*
* `-f json` prints one JSON row (`[{status,title,detail}]`); a 0 exit is only
* "ok" when we can say WHAT happened — everything else is reported as an error
* carrying the last stderr line (the adapters write their real failure there).
*/
function interpretPublishOutcome(input) {
	const row = readJsonRow(input.stdout);
	if (input.code === 0) {
		if (row !== void 0) {
			const message = [typeof row.status === "string" ? row.status : "", typeof row.detail === "string" ? row.detail : ""].filter((s) => s.length > 0).join(" · ");
			return {
				state: "ok",
				message: message.length > 0 ? message.slice(0, 500) : "命令已完成"
			};
		}
		return {
			state: "ok",
			message: "命令已完成（未解析到结构化回执）"
		};
	}
	const lastErr = lastNonEmptyLine(input.stderr);
	const lastOut = lastNonEmptyLine(input.stdout);
	const detail = lastErr.length > 0 ? lastErr : lastOut;
	return {
		state: "error",
		message: (detail.length > 0 ? detail : `命令退出码 ${String(input.code)}`).slice(0, 500)
	};
}
/** Find the last parseable JSON row in the adapter's stdout. */
function readJsonRow(stdout) {
	const lines = stdout.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i].trim();
		if (!line.startsWith("[") && !line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line);
			const row = Array.isArray(parsed) ? parsed[0] : parsed;
			if (typeof row === "object" && row !== null) return row;
		} catch {}
	}
}
function lastNonEmptyLine(text) {
	const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	return lines.length > 0 ? lines[lines.length - 1] : "";
}
/** The default job dir (also used by the route's readiness view). */
function defaultWechatJobDir() {
	return dshHomePath("dsh-tiddlywiki", "wechat-publish");
}
/**
* Runs at most one publish at a time and remembers the recent history.
*
* The class owns the child process lifecycle, so it must be disposed with the
* plugin (hot reload / shutdown): `dispose()` kills a running child instead of
* leaving an orphan opencli/Chrome tab behind (the Windows-orphan lesson from
* WikiServer applies here too).
*/
var WechatPublishRunner = class {
	deps;
	jobs = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.deps = deps;
	}
	get spawn() {
		return this.deps.spawn ?? spawn;
	}
	get now() {
		return (this.deps.now ?? Date.now)();
	}
	running() {
		for (const job of this.jobs.values()) if (job.view.state === "running") return job;
	}
	/** The newest job of any state (the TW overlay polls with no id after a restart). */
	newest() {
		let found;
		for (const job of this.jobs.values()) found = job;
		return found;
	}
	status(id) {
		const record = id === void 0 || id.length === 0 ? this.running() ?? this.newest() : this.jobs.get(id);
		return record === void 0 ? void 0 : snapshot(record.view);
	}
	/**
	* Start one publish. `title` is the tiddler title (written to a UTF-8 file —
	* never argv), `dsn` is the loopback DSH base the adapter calls back into.
	*/
	start(request) {
		const busy = this.running();
		if (busy !== void 0) return {
			ok: false,
			busy: true,
			job: snapshot(busy.view)
		};
		const title = request.title.trim();
		if (title.length === 0) return {
			ok: false,
			busy: false,
			error: "title is required"
		};
		const adapter = request.adapter ?? this.deps.adapter?.() ?? "publish-note";
		const command = this.deps.command();
		const jobDir = this.deps.jobDir ?? defaultWechatJobDir();
		const id = randomUUID().replace(/-/g, "").slice(0, 16);
		const titleFile = join(jobDir, `${id}.title`);
		const logFile = join(jobDir, `${id}.log`);
		let invocation;
		try {
			invocation = buildPublishInvocation({
				platform: this.deps.platform ?? process.platform,
				command,
				adapter,
				titleFile,
				dsn: request.dsn
			});
		} catch (err) {
			return {
				ok: false,
				busy: false,
				error: err instanceof Error ? err.message : String(err)
			};
		}
		try {
			mkdirSync(jobDir, { recursive: true });
			writeFileSync(titleFile, title, "utf8");
		} catch (err) {
			return {
				ok: false,
				busy: false,
				error: `无法写入标题文件：${err instanceof Error ? err.message : String(err)}`
			};
		}
		const record = {
			view: {
				id,
				title,
				adapter,
				state: "running",
				startedAt: this.now,
				message: "正在调用 opencli…",
				log: ""
			},
			stdout: "",
			stderr: ""
		};
		this.jobs.set(id, record);
		this.trimHistory();
		let child;
		try {
			child = this.spawn(invocation.file, invocation.args, {
				cwd: jobDir,
				env: process.env,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				windowsVerbatimArguments: invocation.windowsVerbatimArguments
			});
		} catch (err) {
			this.fail(record, `无法启动 ${command}：${err instanceof Error ? err.message : String(err)}`);
			return {
				ok: true,
				job: snapshot(record.view)
			};
		}
		record.child = child;
		this.deps.log?.(`[dsh-tiddlywiki] wechat publish started: ${id} (${adapter})`);
		const append = (stream, chunk) => {
			record[stream] = capOutput(record[stream] + chunk);
			try {
				appendFileSync(logFile, chunk, "utf8");
			} catch {}
		};
		child.stdout?.on("data", (buf) => append("stdout", buf.toString("utf8")));
		child.stderr?.on("data", (buf) => append("stderr", buf.toString("utf8")));
		child.on("error", (err) => {
			this.fail(record, `无法启动 ${command}：${err.message}（是否已安装 opencli？）`);
		});
		child.on("close", (code) => {
			if (record.view.state !== "running") return;
			if (record.timer !== void 0) clearTimeout(record.timer);
			const verdict = interpretPublishOutcome({
				code,
				stdout: record.stdout,
				stderr: record.stderr
			});
			record.view.state = verdict.state;
			record.view.message = verdict.message;
			record.view.exitCode = code ?? void 0;
			record.view.endedAt = this.now;
			record.view.log = tailOf(`${record.stdout}\n${record.stderr}`);
			this.deps.log?.(`[dsh-tiddlywiki] wechat publish ${verdict.state}: ${id} — ${verdict.message}`);
		});
		const timeoutMs = this.deps.timeoutMs ?? 9e5;
		record.timer = setTimeout(() => {
			if (record.view.state !== "running") return;
			this.killTree(child);
			this.fail(record, `发布任务超时（${Math.round(timeoutMs / 6e4)} 分钟）：已终止 opencli`);
		}, timeoutMs);
		record.timer.unref?.();
		return {
			ok: true,
			job: snapshot(record.view)
		};
	}
	/**
	* Kill the child AND its descendants.
	*
	* On Windows the direct child is `cmd.exe`, which in turn runs the
	* `opencli.cmd` shim and node — `child.kill()` would only reap cmd.exe and
	* leave the real work running (observed as a live process still holding the
	* job directory, i.e. `EBUSY` when the directory is removed). `taskkill /T`
	* is the only way to take the whole tree down; POSIX uses the plain kill
	* (opencli reaps its own children there).
	*/
	killTree(child) {
		const pid = child.pid;
		if (pid !== void 0 && (this.deps.platform ?? process.platform) === "win32") try {
			spawnSync("taskkill", [
				"/pid",
				String(pid),
				"/T",
				"/F"
			], { stdio: "ignore" });
		} catch {}
		try {
			child.kill();
		} catch {}
	}
	/** Kill a running child + drop timers (plugin teardown / hot reload). */
	dispose() {
		for (const record of this.jobs.values()) {
			if (record.timer !== void 0) clearTimeout(record.timer);
			if (record.view.state === "running" && record.child !== void 0) this.killTree(record.child);
		}
	}
	fail(record, message) {
		if (record.timer !== void 0) clearTimeout(record.timer);
		record.view.state = "error";
		record.view.message = message;
		record.view.endedAt = this.now;
		record.view.log = tailOf(`${record.stdout}\n${record.stderr}`);
	}
	/** Keep the newest JOB_HISTORY_LIMIT records (Map preserves insertion order). */
	trimHistory() {
		while (this.jobs.size > JOB_HISTORY_LIMIT) {
			const oldest = [...this.jobs.entries()].find(([, record]) => record.view.state !== "running");
			if (oldest === void 0) return;
			this.jobs.delete(oldest[0]);
		}
	}
};
function snapshot(view) {
	return { ...view };
}
/** Where opencli keeps private adapters (`install-wechat-adapters.mjs` target). */
function defaultAdaptersDir(home = homedir()) {
	return join(home, ".opencli", "clis", "weixin");
}
/**
* Which adapter files exist in `dir` **and are new enough to be driven by this
* host**.
*
* `missing` and `stale` are deliberately disjoint and each keeps its literal
* meaning: a file is either absent or present-and-unusable, never both (an old
* file must not be reported as "missing" — the user would go re-install files
* that are already on disk and end up exactly where they started).
*
* A missing/unreadable directory means "nothing installed"; a read failure on a
* file we must inspect (EACCES, deleted mid-scan, a directory in its place…)
* counts as stale — this feeds a readiness report that must always answer, so it
* never throws.
*/
function scanAdapterDir(dir, readDir = (path) => readdirSync(path), readFile = (path) => readFileSync(path, "utf8")) {
	let present = [];
	try {
		present = readDir(dir);
	} catch {
		present = [];
	}
	const has = (file) => present.includes(file);
	const required = [.../* @__PURE__ */ new Set([...WECHAT_ADAPTER_FILES["publish-note"], ...WECHAT_ADAPTER_FILES["publish-note-imgs"]])];
	const missing = required.filter((file) => !has(file));
	const stale = required.filter((file) => {
		const matcher = WECHAT_FRESHNESS_MATCHERS[file];
		if (matcher === void 0 || !has(file)) return false;
		try {
			return !matcher.test(readFile(join(dir, file)));
		} catch {
			return true;
		}
	});
	const staleSet = new Set(stale);
	const usable = (adapter) => WECHAT_ADAPTER_FILES[adapter].every((file) => has(file) && !staleSet.has(file));
	return {
		publishNote: usable("publish-note"),
		publishNoteImgs: usable("publish-note-imgs"),
		missing,
		stale
	};
}
/** `opencli --version` with a timeout; never throws. */
async function probeOpencli(opts) {
	let invocation;
	try {
		invocation = buildVersionInvocation({
			platform: opts.platform ?? process.platform,
			command: opts.command
		});
	} catch {
		return {
			ok: false,
			version: ""
		};
	}
	return await new Promise((resolve) => {
		const spawnFn = opts.spawn ?? spawn;
		let done = false;
		let out = "";
		let timer;
		const finish = (result) => {
			if (done) return;
			done = true;
			if (timer !== void 0) clearTimeout(timer);
			resolve(result);
		};
		let child;
		try {
			child = spawnFn(invocation.file, invocation.args, {
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				windowsVerbatimArguments: invocation.windowsVerbatimArguments
			});
		} catch {
			resolve({
				ok: false,
				version: ""
			});
			return;
		}
		timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			finish({
				ok: false,
				version: ""
			});
		}, opts.timeoutMs ?? 1e4);
		timer.unref?.();
		child.stdout?.on("data", (buf) => {
			out += buf.toString("utf8");
		});
		child.on("error", () => finish({
			ok: false,
			version: ""
		}));
		child.on("close", (code) => {
			const version = out.trim().split(/\r?\n/)[0]?.trim() ?? "";
			finish({
				ok: code === 0 && version.length > 0,
				version
			});
		});
	});
}
/**
* Full readiness report for the TW button (and for the 503 body of a failed
* start): is the CLI there, and are the adapter files installed **and current**?
*
* `ok` keeps its v0.23.3 meaning (enabled && CLI ok && at least one adapter is
* usable) — `stale` is additive data for the caller's message, so existing
* callers that only read `ok` are unaffected.
*/
async function checkWechatReady(opts) {
	const dir = opts.adaptersDir ?? defaultAdaptersDir();
	const adapters = scanAdapterDir(dir, opts.readDir ?? ((p) => readdirSync(p)));
	const opencli = await probeOpencli({
		command: opts.command,
		...opts.platform === void 0 ? {} : { platform: opts.platform },
		...opts.spawn === void 0 ? {} : { spawn: opts.spawn },
		...opts.probeTimeoutMs === void 0 ? {} : { timeoutMs: opts.probeTimeoutMs }
	});
	return {
		ok: opts.enabled && opencli.ok && (adapters.publishNote || adapters.publishNoteImgs),
		enabled: opts.enabled,
		command: opts.command,
		opencli,
		adapters: {
			dir,
			publishNote: adapters.publishNote,
			publishNoteImgs: adapters.publishNoteImgs,
			missing: adapters.missing,
			stale: adapters.stale
		}
	};
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
* Extensions that the browser would execute ON THE DSH ORIGIN: `/upload`
* writes into `wiki/files/`, which TW's core server serves back through the
* same-origin `/tw` proxy with an extension-derived Content-Type. An uploaded
* `.html`/`.svg` would therefore be same-origin script (able to read
* `/admin/state` and write the wiki), i.e. self-XSS with a persistence layer.
* Documents/images/archives stay allowed; only the executable-by-browser set is
* refused (v0.19.0).
*/
const DANGEROUS_UPLOAD_EXTENSIONS = /* @__PURE__ */ new Set([
	".html",
	".htm",
	".xhtml",
	".shtml",
	".hta",
	".svg",
	".xml",
	".xsl",
	".xslt",
	".js",
	".mjs",
	".cjs",
	".swf",
	".htc"
]);
/** Windows device names: `NUL.txt` cannot be created and makes the route 500. */
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/**
* Sanitize an uploaded filename into a safe bare name (no path separators,
* no `..`, no control characters). Returns '' when nothing usable remains.
*/
function sanitizeUploadName(input) {
	if (typeof input !== "string") return "";
	let name = basename(input.trim().replace(/[\\/]+/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").replace(/^\.+/, "").trim();
	if (name.length === 0 || name === "." || name === "..") return "";
	name = name.replace(/[. ]+$/, "");
	if (name.length === 0) return "";
	if (WINDOWS_RESERVED_NAMES.test(name)) name = `_${name}`;
	if (name.length > 160) name = name.slice(0, 160);
	return name;
}
/**
* Strip credentials embedded in a git remote URL (`https://user:token@host/x`)
* before it reaches an unauthenticated HTTP response (v0.19.0). The token in a
* remote URL is a real secret and `/status` is reachable without credentials.
*/
function redactRemoteUrl(remote) {
	return remote.replace(/\/\/[^/@\s]+@/g, "//***@");
}
/**
* Redact secrets that can appear in the TW child's captured stdout/stderr log
* (the spawn line carries `password=…`). Belt-and-braces on top of the
* redaction in wiki.ts, because `/status` is unauthenticated.
*/
function redactLogLines(logs) {
	return logs.map((line) => line.replace(/(password=)\S+/gi, "$1***").replace(/(authorization:\s*basic\s+)[A-Za-z0-9+/=]+/gi, "$1***"));
}
/** Max `limit` accepted by the list routes (bounded payloads, v0.19.4). */ const MAX_LIST_LIMIT = 200;
/** Max `limit` accepted by `/tags` — the tag list is a small wrapper around one
*  full listing, so a larger cap is fine while still bounding the payload. */
const MAX_TAGS_LIMIT = 500;
/** Clamp a `limit` query param. `fallback` covers absent/unparsable values. */
function readLimit(url, fallback, max = MAX_LIST_LIMIT) {
	const raw = url.searchParams.get("limit");
	if (raw === null || raw.trim().length === 0) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), max)) : fallback;
}
/** Optional `limit` query param: `undefined` when absent/unparsable (= no cap). */
function readOptionalLimit(url, max) {
	const raw = url.searchParams.get("limit");
	if (raw === null || raw.trim().length === 0) return void 0;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return void 0;
	return Math.max(1, Math.min(Math.floor(parsed), max));
}
/** Default note title: `YYYY-MM-DD HH:mm` (design doc D6). Shared formatter —
*  session-summary.ts used to carry a second, byte-identical copy (v0.22.8). */
function timestampTitle(date = /* @__PURE__ */ new Date()) {
	return formatLocalMinute(date);
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
async function openInTwEditor(client, title, text, tags, options = {}) {
	const existing = await client.get(title);
	assertNoConflict(title, existing, options);
	if (text.trim().length > 0) {
		const { tiddler } = buildWriteTiddler(title, text, {
			existing,
			tags,
			defaultTags: options.defaultTags,
			agentTag: false
		});
		await client.put(tiddler);
	}
	const draftText = text.trim().length > 0 ? text : existing?.text ?? "";
	const draftType = typeof existing?.type === "string" && existing.type.length > 0 ? existing.type : NOTE_TYPE;
	const canonical = `Draft of "${title}"`;
	let draftTitle;
	/** true = the draft tiddler already existed and owns unsaved user content. */
	let draftExists = false;
	let canonicalFree;
	try {
		canonicalFree = await client.get(canonical) === void 0;
	} catch {
		canonicalFree = void 0;
	}
	if (canonicalFree === true) draftTitle = canonical;
	else {
		try {
			const items = await client.list(void 0, false);
			for (const item of items) if (item["draft.of"] === title && typeof item.title === "string") {
				draftTitle = item.title;
				draftExists = true;
				break;
			}
		} catch {}
		if (draftTitle === void 0) draftTitle = `${canonical} ${Date.now()}`;
	}
	if (!draftExists || text.trim().length > 0) {
		const draftCreated = typeof existing?.created === "string" && existing.created.trim().length > 0 ? existing.created : void 0;
		await client.put({
			title: draftTitle,
			text: draftText,
			"draft.of": title,
			"draft.title": title,
			type: draftType,
			...draftCreated !== void 0 ? { created: draftCreated } : {},
			modified: formatTiddlerDate(/* @__PURE__ */ new Date())
		});
	}
	return {
		title,
		draftTitle
	};
}
/**
* Resolve note tags from the request body: `tags` array wins, then the legacy
* single `tag` string. Returns **undefined** when the body asks for nothing —
* the caller (`buildWriteTiddler`) then preserves the existing note's tags
* (v0.19.1 data safety) or falls back to the configured default for new notes.
* The old version always returned `[defaultTag]`, so re-saving an existing note
* under its own title silently replaced its tags with the default.
*/
function resolveTags(body) {
	if (Array.isArray(body.tags)) {
		const tags = body.tags.filter((t) => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
		if (tags.length > 0) return tags;
	}
	if (typeof body.tag === "string" && body.tag.trim().length > 0) return body.tag.trim().split(/\s+/).filter(Boolean);
}
/** Body fields accepted by the note routes for optimistic concurrency. */
function conflictTokens(body) {
	return {
		...typeof body.expectedModified === "string" && body.expectedModified.length > 0 ? { expectedModified: body.expectedModified } : {},
		...typeof body.expectedRevision === "string" || typeof body.expectedRevision === "number" ? { expectedRevision: body.expectedRevision } : {},
		...body.force === true ? { force: true } : {}
	};
}
function registerRoutes(ctx, deps) {
	/**
	* `/status` is polled by the GUI (30s), every mounted TW frame and the FAB,
	* and each call shells out to up to five `git` processes — so the git summary
	* is cached for a couple of seconds. Any route that mutates the repo
	* invalidates it so a sync/upload is reflected immediately.
	*/
	const GIT_STATUS_TTL_MS = 2e3;
	/** Cached git-status PROMISE (not value): a burst of concurrent /status polls
	*  then shares ONE probe instead of each spawning up to five git processes
	*  (v0.19.0 — value-caching still let every concurrent miss run its own). */
	let gitStatusCache;
	const invalidateGitStatus = () => {
		gitStatusCache = void 0;
	};
	const cachedGitStatus = () => {
		if (gitStatusCache !== void 0 && Date.now() - gitStatusCache.at < GIT_STATUS_TTL_MS) return gitStatusCache.value;
		const pending = (async () => {
			try {
				const view = await deps.git.status(deps.getWikiPath());
				return {
					...view,
					remote: redactRemoteUrl(typeof view.remote === "string" ? view.remote : "")
				};
			} catch {
				return null;
			}
		})();
		gitStatusCache = {
			at: Date.now(),
			value: pending
		};
		return pending;
	};
	/**
	* Serialize the heavyweight mutating routes (restart / sync). A burst of
	* concurrent calls used to stack pull/restart operations on top of each
	* other (and a restart racing a restart is what left orphan TW children).
	* A second concurrent caller gets 429 instead of piling on (v0.19.0).
	*/
	let mutationInFlight;
	const beginMutation = (label) => {
		if (mutationInFlight !== void 0) return false;
		mutationInFlight = label;
		return true;
	};
	const endMutation = () => {
		mutationInFlight = void 0;
	};
	/**
	* Titles the browser-facing TW surfaces must never serve (v0.19.3 / v0.20.0).
	*
	* `$:/plugins/dsh-tiddlywiki/config` holds the shared tokens and the git
	* remote (possibly with a PAT); `/tw` and `/api` forward ANY path to the
	* loopback TW child, whose TiddlyWeb REST answers for `$:/…` titles — a
	* route-level guard on `/get` was therefore trivially bypassed by
	* `GET /dsh-tiddlywiki/tw/recipes/default/tiddlers/%24%3A%2Fplugins%2F…`
	* (verified). The whole plugin namespace is blocked: nothing under it is
	* needed by the TW frontend, and the host itself talks to TW directly.
	*
	* v0.20.0: the SAME predicate now also guards `POST /render`, which had been
	* left open — TW's `/render` route renders ANY tiddler by title, so
	* `{"title":"$:/plugins/dsh-tiddlywiki/config"}` returned the raw config
	* (tokens + PAT in plain text inside `<pre><code>`, where the fragment
	* sanitizer keeps it). Verified end-to-end against a scratch wiki before the
	* fix. Every route that turns a caller-supplied title into TW output must use
	* `isBlockedProxyTitle`.
	*/
	const BLOCKED_PROXY_TITLE_PREFIXES = ["$:/plugins/dsh-tiddlywiki/"];
	/** True when a caller-supplied tiddler title addresses the secret namespace. */
	const isBlockedProxyTitle = (title) => BLOCKED_PROXY_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix));
	/**
	* True when a proxied pathname addresses a blocked (secret-bearing) tiddler.
	*
	* Decodes the WHOLE path rather than looking for a literal `/tiddlers/` marker
	* (v0.23.5). TW core's `get-tiddler-html.js` route is a SINGLE segment
	* (`path = /^\/([^\/]+)$/`) decoded with `decodeURIComponentSafe`, so
	* `GET /tw/%24%3A%2Fplugins%2Fdsh-tiddlywiki%2Fconfig` reached the config
	* tiddler while the old marker check saw no `/tiddlers/` at all (verified
	* before the fix: 200, 715 bytes of config JSON on both `/tw` and `/api`).
	* Raw, once- and twice-decoded forms are all checked so double-encoding cannot
	* slip through either.
	*/
	const isBlockedProxyPath = (pathname) => {
		let candidate = pathname;
		for (let i = 0; i < 3; i += 1) {
			if (BLOCKED_PROXY_TITLE_PREFIXES.some((prefix) => candidate.includes(prefix))) return true;
			let next = candidate;
			try {
				next = decodeURIComponent(candidate);
			} catch {}
			if (next === candidate) break;
			candidate = next;
		}
		return BLOCKED_PROXY_TITLE_PREFIXES.some((prefix) => candidate.includes(prefix));
	};
	/**
	* Does caller-supplied CONTENT reference the protected namespace? (v0.23.5)
	* TW's `/render` resolves `{{…}}` transclusions server-side, so the `text`
	* branch was a second way to print the config tiddler: verified before the fix,
	* `POST /render {"text":"{{$:/plugins/dsh-tiddlywiki/config}}"}` returned 200
	* with the config JSON inside `<pre><code>` — the fragment sanitizer only strips
	* tags, it cannot know the text is a secret.
	*/
	const referencesBlockedTitle = (value) => value !== void 0 && BLOCKED_PROXY_TITLE_PREFIXES.some((prefix) => value.includes(prefix));
	const handleStatus = async (req, res) => {
		if (rejectNonRead(req, res)) return;
		const view = deps.server.status();
		const gitSummary = await cachedGitStatus();
		json(res, {
			ok: true,
			...view,
			logs: redactLogLines(view.logs),
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
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
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
			if (!/^[A-Za-z0-9._:-]{1,120}$/.test(session)) {
				json(res, {
					ok: false,
					error: "session id has an unsupported format"
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
			}, errorStatus(err));
		}
	};
	/**
	* GET /dsh-tiddlywiki/agent/sessions — visible ordinary sessions for the TW
	* one-click picker (excludes subagent sessions, activity-descending). Each
	* item also carries its recorded `agentPreset` (工作模式), when known, so the
	* picker can badge existing sessions — read from the lightweight persistence
	* header list, never a full log parse.
	*/
	const handleAgentSessions = async (req, res) => {
		try {
			if (rejectNonRead(req, res)) return;
			if (!guardSendToAgent(req, res)) return;
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
			}, errorStatus(err));
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
		if (safeTokenEqual(typeof got === "string" ? got : Array.isArray(got) ? got[0] ?? "" : "", token)) return true;
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
			if (rejectNonRead(req, res)) return;
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
			}, errorStatus(err));
		}
	};
	/**
	* POST /dsh-tiddlywiki/agent/send — deliver a note to one agent session as a
	* queued user message (sessionController.prompt, the same API the GUI chat
	* input uses). Guards: feature switch, optional shared token, body shape.
	*/
	const handleAgentSend = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
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
			const accepted = await sc.prompt({
				requestId,
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text
				}]
			}, AbortSignal.timeout(2e4));
			if (accepted !== void 0 && accepted.accepted === false) {
				json(res, {
					ok: false,
					error: "会话未接受该消息（可能已结束或正忙）",
					requestId,
					sessionId
				}, 409);
				return;
			}
			json(res, {
				ok: true,
				requestId,
				sessionId
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
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
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
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
			if (mode !== void 0) {
				const ap = deps.getAgentPresets();
				if (ap === void 0) {
					json(res, {
						ok: false,
						error: "agent presets service unavailable"
					}, 503);
					return;
				}
				try {
					const presets = await ap.list();
					if (!presets.some((preset) => preset.id === mode)) {
						json(res, {
							ok: false,
							error: `unknown agent preset "${mode}" (available: ${presets.map((preset) => preset.id).join(", ")})`
						}, 400);
						return;
					}
				} catch (err) {
					json(res, {
						ok: false,
						error: `cannot validate agent preset: ${err instanceof Error ? err.message : String(err)}`
					}, 503);
					return;
				}
			}
			const ws = deps.getWorkspaceRegistry();
			if (cwd.length > 0) {
				if (!isAbsolute(cwd)) {
					json(res, {
						ok: false,
						error: "cwd must be an absolute path"
					}, 400);
					return;
				}
				try {
					if (!(await stat(cwd)).isDirectory()) {
						json(res, {
							ok: false,
							error: "cwd exists but is not a directory"
						}, 400);
						return;
					}
				} catch {
					await mkdir(cwd, { recursive: true });
				}
			}
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
			}, errorStatus(err));
		}
	};
	const handleNote = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
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
			if (title.startsWith("$:/")) {
				json(res, {
					ok: false,
					error: "title must not be a system tiddler ($:/…)"
				}, 400);
				return;
			}
			const tags = resolveTags(body);
			const existing = await client.get(title);
			assertNoConflict(title, existing, conflictTokens(body));
			const { tiddler } = buildWriteTiddler(title, text, {
				existing,
				tags,
				defaultTags: [deps.noteDefaults().tag],
				agentTag: false
			});
			await client.put(tiddler);
			deps.autoCommit();
			invalidateGitStatus();
			const finalTags = tiddler.tags ?? [];
			json(res, {
				ok: true,
				title,
				tag: finalTags.join(" "),
				tags: finalTags,
				text,
				type: typeof tiddler.type === "string" ? tiddler.type : NOTE_TYPE
			});
		} catch (err) {
			if (err instanceof WriteConflictError) {
				json(res, {
					ok: false,
					error: err.message,
					conflict: true
				}, 409);
				return;
			}
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	const handleEdit = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
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
			if (title.startsWith("$:/")) {
				json(res, {
					ok: false,
					error: "title must not be a system tiddler ($:/…)"
				}, 400);
				return;
			}
			const result = await openInTwEditor(client, title, typeof body.text === "string" ? body.text : "", resolveTags(body), {
				defaultTags: [deps.noteDefaults().tag],
				...conflictTokens(body)
			});
			deps.autoCommit();
			invalidateGitStatus();
			json(res, {
				ok: true,
				...result,
				twUrl: TW_PROXY_PATH
			});
		} catch (err) {
			if (err instanceof WriteConflictError) {
				json(res, {
					ok: false,
					error: err.message,
					conflict: true
				}, 409);
				return;
			}
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	/** Distinct non-system tags for the quick-note tag autocomplete. The flat
	*  `tags` array feeds note-widget's chip autocomplete; the parallel `items`
	*  (tag → tiddler count) feeds the reply-stream `tiddlywiki_list_tags` tool
	*  card, so both consumers share one endpoint.
	*
	*  Query params (v0.19.4): `limit` caps the payload (absent = every tag, so
	*  the autocomplete keeps its full vocabulary), `sort=count` orders by usage
	*  (default `alpha`). `tags`/`items` are always the same set in the same
	*  order, plus `total`/`truncated` so a capped caller can say "N of M". */
	const handleTags = async (req, res) => {
		if (rejectNonRead(req, res)) return;
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
			const limit = readOptionalLimit(url, MAX_TAGS_LIMIT);
			const byCount = (url.searchParams.get("sort") ?? "alpha") === "count";
			const { total, tags: all } = await client.tagStats();
			const ordered = byCount ? all : [...all].sort((a, b) => a.tag.localeCompare(b.tag, "zh"));
			const picked = limit === void 0 ? ordered : ordered.slice(0, limit);
			json(res, {
				ok: true,
				tags: picked.map((t) => t.tag),
				items: picked,
				total,
				truncated: picked.length < total
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	/** Recent non-system tiddlers for the quick-note "最近" picker (newest first). */
	const handleRecent = async (req, res) => {
		if (rejectNonRead(req, res)) return;
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
			const limit = readLimit(url, 15);
			const since = url.searchParams.get("since") ?? void 0;
			const items = await client.recent(limit, since);
			json(res, {
				ok: true,
				limit,
				since: since ?? null,
				items: items.map((t) => ({
					title: t.title,
					tags: t.tags ?? [],
					modified: toIsoDateString(t.modified),
					snippet: snippetOf(t.text ?? "", 120)
				}))
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	/** Full tiddler for the quick-note "最近" picker (load into the editor). */
	const handleGet = async (req, res) => {
		if (rejectNonRead(req, res)) return;
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
			if (isBlockedProxyTitle(title)) {
				json(res, {
					ok: false,
					error: "system tiddler not exposed"
				}, 403);
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
			const binary = isBinaryType(typeof t.type === "string" ? t.type : void 0);
			json(res, {
				ok: true,
				title: t.title,
				text: binary ? "" : t.text ?? "",
				binary,
				binaryChars: binary ? (t.text ?? "").length : void 0,
				tags: t.tags ?? [],
				type: t.type ?? "text/vnd.tiddlywiki",
				modified: toIsoDateString(t.modified),
				revision: t.revision ?? null,
				fields: flattenTiddlerFields(t)
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	/**
	* GET /dsh-tiddlywiki/search — keyword search for the reply-stream tool card
	* (mirrors tools.ts tiddlywiki_search: same local substring/tag/since/type
	* matching via the TiddlyWebClient). Returns hit titles/tags/modified/
	* snippets so the card can list clickable wiki links.
	*/
	const handleSearch = async (req, res) => {
		if (rejectNonRead(req, res)) return;
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
			const field = url.searchParams.get("field") ?? void 0;
			const value = url.searchParams.get("value") ?? void 0;
			const limit = readLimit(url, 30);
			const { items, total } = await client.search(query, {
				tags,
				tag,
				since,
				type,
				field,
				value,
				limit
			});
			json(res, {
				ok: true,
				query,
				tags,
				tag: tag ?? null,
				since: since ?? null,
				type: type ?? null,
				field: field ?? null,
				value: value ?? null,
				limit,
				total,
				items: items.map((t) => ({
					title: t.title,
					tags: t.tags ?? [],
					modified: toIsoDateString(t.modified),
					snippet: snippetOf(t.text ?? "", 120)
				}))
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	const handleRestart = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
			if (!beginMutation("restart")) {
				json(res, {
					ok: false,
					error: "另一个重启/同步正在进行中，请稍候"
				}, 429);
				return;
			}
			let drained = true;
			try {
				drained = await drainThenStop({
					client: deps.getClient(),
					tiddlersDir: join(deps.getWikiPath(), "tiddlers"),
					stop: () => deps.server.restart(),
					log: (message) => console.warn("[dsh-tiddlywiki]", message)
				});
			} finally {
				endMutation();
			}
			json(res, {
				ok: true,
				status: deps.server.status().status,
				drained
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	/** One-click git sync for the floating button / settings page: pull →
	*  commit → push, then return the fresh status. Mirrors the agent tool's
	*  `action=sync` (design doc §7 conflict policy — rebase conflict aborts).
	*  When the pull actually changed the working tree, the running TW child
	*  still holds the old in-memory snapshot — restart it (same port) so the
	*  UI reflects the pulled files instead of looking stale. */
	const handleSync = async (req, res) => {
		if (rejectCrossSiteWrite(req, res, ["POST"])) return;
		if (!beginMutation("sync")) {
			json(res, {
				ok: false,
				error: "另一个重启/同步正在进行中，请稍候"
			}, 429);
			return;
		}
		invalidateGitStatus();
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
				if (!await drainThenStop({
					client: deps.getClient(),
					tiddlersDir: join(dir, "tiddlers"),
					stop: () => deps.server.restart(),
					log: (message) => console.warn("[dsh-tiddlywiki]", message)
				})) console.warn("[dsh-tiddlywiki] sync: syncer queue may not be drained before restart");
				restarted = true;
			} catch (err) {
				restartError = err instanceof Error ? err.message : String(err);
			}
			let committed;
			try {
				committed = await deps.git.commit(dir, `sync ${(/* @__PURE__ */ new Date()).toISOString()}`);
			} catch (err) {
				if (err instanceof GitConflictStateError) {
					json(res, {
						ok: false,
						action: "sync",
						message: err.message,
						conflictFiles: err.files,
						pull: "ok",
						status: await status()
					}, 409);
					return;
				}
				throw err;
			}
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
			}, errorStatus(err));
		} finally {
			endMutation();
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
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
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
			const extension = extname(name).toLowerCase();
			if (DANGEROUS_UPLOAD_EXTENSIONS.has(extension)) {
				json(res, {
					ok: false,
					error: `不允许上传可执行/可脚本化的文件类型：${extension}`
				}, 400);
				return;
			}
			const filesDir = join(deps.getWikiPath(), "files");
			await mkdir(filesDir, { recursive: true });
			const ext = extname(name);
			const stem = ext.length > 0 ? name.slice(0, -ext.length) : name;
			let candidate = "";
			let wrote = false;
			for (let i = 0; i <= 1e4 && !wrote; i++) {
				candidate = i === 0 ? name : `${stem}-${i}${ext}`;
				try {
					await writeFile(join(filesDir, candidate), buf, { flag: "wx" });
					wrote = true;
				} catch (err) {
					if (err.code !== "EEXIST") throw err;
				}
			}
			if (!wrote) {
				json(res, {
					ok: false,
					error: "同名文件过多，请换一个文件名"
				}, 409);
				return;
			}
			deps.autoCommit();
			invalidateGitStatus();
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
			}, errorStatus(err));
		}
	};
	/**
	* POST /dsh-tiddlywiki/render — the ONLY render endpoint the GUI uses.
	*
	* Proxies to TW's own `/render` server route (installed by the `render-route`
	* seed) and **sanitizes the fragment before it leaves the host**.
	*
	* WHY (v0.19.1, security): the reply-stream tool card and the session
	* 「知识库」 Tab inject that HTML with `dangerouslySetInnerHTML` inside the DSH
	* page. TW's wikitext/markdown parsers only strip `on*` attributes — measured
	* against the live `/render`: `<iframe src="javascript:…">`,
	* `<a href="javascript:…">` and `<form action="javascript:…">` all pass
	* through, i.e. any note text (agent-written, clipped, imported) could run
	* script on the DSH origin and call the unauthenticated `/dsh-tiddlywiki/*`
	* routes. Sanitizing host-side also protects wikis whose ONE-SHOT render
	* bundle predates this fix (the client can never see raw TW output).
	*/
	const handleRender = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
			const client = deps.getClient();
			if (client === void 0) {
				json(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			let body = {};
			try {
				body = JSON.parse(await readBody(req, MAX_PROXY_BODY_BYTES));
			} catch (err) {
				const status = errorStatus(err);
				if (status !== 500) {
					json(res, {
						ok: false,
						error: err instanceof Error ? err.message : String(err)
					}, status);
					return;
				}
				json(res, {
					ok: false,
					error: "invalid JSON body"
				}, 400);
				return;
			}
			const title = typeof body.title === "string" ? body.title.trim() : "";
			const text = typeof body.text === "string" ? body.text : void 0;
			if (title.length === 0 && text === void 0) {
				json(res, {
					ok: false,
					error: "body must provide \"title\" or \"text\""
				}, 400);
				return;
			}
			if (isBlockedProxyTitle(title)) {
				json(res, {
					ok: false,
					error: "system tiddler not exposed"
				}, 403);
				return;
			}
			if (referencesBlockedTitle(text) || referencesBlockedTitle(typeof body.contextTitle === "string" ? body.contextTitle : void 0)) {
				json(res, {
					ok: false,
					error: "system tiddler not exposed"
				}, 403);
				return;
			}
			const request = title.length > 0 ? { title } : {
				text,
				...typeof body.type === "string" && body.type.length > 0 ? { type: body.type } : {},
				...typeof body.contextTitle === "string" && body.contextTitle.length > 0 ? { contextTitle: body.contextTitle } : {},
				...body.parseAsInline === true ? { parseAsInline: true } : {}
			};
			const safe = sanitizeTwFragment(await client.render(request));
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"content-length": Buffer.byteLength(safe, "utf8")
			});
			res.end(safe);
		} catch (err) {
			if (err instanceof RenderNotFoundError || err?.notFound === true) {
				json(res, {
					ok: false,
					notFound: true,
					error: err instanceof Error ? err.message : String(err)
				}, 404);
				return;
			}
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 502);
		}
	};
	/** Passthrough /dsh-tiddlywiki/api/<rest> → TW root /<rest>. */
	const handleApiProxy = async (req, res) => {
		if (rejectCrossSiteWrite(req, res, [
			"GET",
			"HEAD",
			"POST",
			"PUT",
			"DELETE",
			"OPTIONS"
		])) return;
		if (deps.getClient() === void 0) {
			json(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const rest = url.pathname.replace(/^\/dsh-tiddlywiki\/api/, "") || "/";
			if (isBlockedProxyPath(rest)) {
				json(res, {
					ok: false,
					error: "system tiddler not exposed"
				}, 403);
				return;
			}
			const headers = forwardHeaders(req.headers);
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
		if (rejectCrossSiteWrite(req, res, [
			"GET",
			"HEAD",
			"POST",
			"PUT",
			"DELETE",
			"OPTIONS"
		])) return;
		if (deps.getClient() === void 0) {
			json(res, {
				ok: false,
				error: "wiki service is not running"
			}, 503);
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const rest = url.pathname.replace(new RegExp(`^${TW_PROXY_PREFIX}(?=/|$)`), "") || "/";
		if (isBlockedProxyPath(rest)) {
			json(res, {
				ok: false,
				error: "system tiddler not exposed"
			}, 403);
			return;
		}
		try {
			const method = (req.method ?? "GET").toUpperCase();
			const headers = forwardHeaders(req.headers);
			if (method === "PUT" || method === "DELETE" || method === "POST") headers["x-requested-with"] = "TiddlyWiki";
			const abort = new AbortController();
			const timeout = AbortSignal.timeout(3e4);
			const init = {
				method,
				headers,
				signal: typeof AbortSignal.any === "function" ? AbortSignal.any([abort.signal, timeout]) : timeout
			};
			if (method === "PUT" || method === "POST") init.body = await readBodyBuffer(req, MAX_UPLOAD_BYTES);
			else if (req.readableEnded === false && (req.headers["content-length"] !== void 0 || req.headers["transfer-encoding"] !== void 0)) req.resume();
			const upstream = await fetch(`${deps.server.url}${rest}${url.search}`, init);
			const responseHeaders = {
				"content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
				"cache-control": upstream.headers.get("cache-control") ?? "no-store"
			};
			for (const name of [
				"etag",
				"last-modified",
				"content-disposition",
				"accept-ranges"
			]) {
				const value = upstream.headers.get(name);
				if (value !== null) responseHeaders[name] = value;
			}
			const challenge = upstream.headers.get("www-authenticate");
			if (challenge !== null) responseHeaders["www-authenticate"] = challenge;
			res.writeHead(upstream.status, responseHeaders);
			if (upstream.body === null) {
				res.end();
				return;
			}
			const body = Readable.fromWeb(upstream.body);
			await new Promise((resolveP, rejectP) => {
				body.on("error", rejectP);
				res.on("error", rejectP);
				res.on("close", () => {
					try {
						abort.abort();
					} catch {}
					try {
						body.destroy();
					} catch {}
					resolveP();
				});
				res.on("finish", () => resolveP());
				body.pipe(res);
			});
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
	/**
	* Shared gate for the TW-side 公众号发布 routes (v0.23.3): opt-in feature
	* switch (`wechat.enabled`, default OFF) then, when a shared token is
	* configured, the `x-wechat-publish-token` header must match. Mirror of
	* `guardSendToAgent` — the feature is off by default, so an unconfigured
	* deployment answers 403 instead of starting browser automation.
	*/
	const guardWechat = (req, res) => {
		const config = deps.wechatConfig();
		if (!config.enabled) {
			json(res, {
				ok: false,
				error: "wechat publishing is disabled"
			}, 403);
			return false;
		}
		const token = config.token.trim();
		if (token.length === 0) return true;
		const got = req.headers["x-wechat-publish-token"];
		if (safeTokenEqual(typeof got === "string" ? got : Array.isArray(got) ? got[0] ?? "" : "", token)) return true;
		json(res, {
			ok: false,
			error: "unauthorized"
		}, 401);
		return false;
	};
	/**
	* GET /dsh-tiddlywiki/wechat/ready — precheck for the TW toolbar button:
	* is opencli on PATH and are the adapter files installed? 200 whenever the
	* feature is on; the caller reads `opencli.ok` / `adapters.*` (an installation
	* problem is NOT an HTTP error — the button shows it as an actionable notice).
	*/
	const handleWechatReady = async (req, res) => {
		try {
			if (rejectNonRead(req, res)) return;
			if (!guardWechat(req, res)) return;
			const ready = await deps.wechatReady();
			json(res, {
				ok: true,
				enabled: ready.enabled,
				command: ready.command,
				opencli: ready.opencli,
				adapters: ready.adapters
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	/**
	* The loopback DSN the adapter calls back into (`fetch /render`): the DSH web
	* port this very request arrived on, so opencli (a local process) reaches the
	* same server regardless of which hostname the browser used. `wechat.dsn`
	* overrides it for exotic setups.
	*/
	const wechatDsn = (req) => {
		const configured = deps.wechatConfig().dsn;
		if (configured.length > 0) return configured;
		const port = req.socket.localPort;
		return port === void 0 ? "" : `http://127.0.0.1:${port}${ROUTE_PREFIX}`;
	};
	/**
	* POST /dsh-tiddlywiki/wechat/publish — start ONE publish job.
	*
	* Body `{title, adapter?}`. The heavy work happens in the runner (spawned
	* opencli), so this returns a job id immediately; the TW overlay then polls
	* `/wechat/publish/status`. A second concurrent call gets 409: two opencli
	* runs would fight over the same browser tab.
	*/
	const handleWechatPublish = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
			if (!guardWechat(req, res)) return;
			let body = {};
			try {
				body = JSON.parse(await readBody(req));
			} catch {}
			const title = typeof body.title === "string" ? body.title.trim() : "";
			if (title.length === 0) {
				json(res, {
					ok: false,
					error: "title is required"
				}, 400);
				return;
			}
			if (title.length > 300) {
				json(res, {
					ok: false,
					error: "title is too long"
				}, 400);
				return;
			}
			if (isBlockedProxyTitle(title)) {
				json(res, {
					ok: false,
					error: "unsupported title"
				}, 400);
				return;
			}
			const requested = body.adapter === void 0 ? void 0 : String(body.adapter);
			if (requested !== void 0 && !WECHAT_ADAPTERS.includes(requested)) {
				json(res, {
					ok: false,
					error: `unsupported adapter: ${requested}`
				}, 400);
				return;
			}
			const runner = deps.wechatRunner();
			if (runner === void 0) {
				json(res, {
					ok: false,
					error: "publish runner unavailable"
				}, 503);
				return;
			}
			const client = deps.getClient();
			if (client !== void 0) {
				if (await client.get(title) === void 0) {
					json(res, {
						ok: false,
						error: `wiki 里找不到笔记「${title}」`
					}, 400);
					return;
				}
			}
			const adapter = requested ?? deps.wechatConfig().adapter;
			const ready = await deps.wechatReady();
			const adapterReady = adapter === "publish-note-imgs" ? ready.adapters.publishNoteImgs : ready.adapters.publishNote;
			if (!ready.opencli.ok || !adapterReady) {
				const stale = ready.adapters.stale ?? [];
				const staleNote = stale.length > 0 ? `adapter 版本过旧（缺 --title-file）：${stale.join("、")}` : null;
				json(res, {
					ok: false,
					error: !ready.opencli.ok ? `找不到 opencli（wechat.command=${ready.command}）：请先 npm install -g @jackwener/opencli` : (staleNote ?? `opencli 里还没有 weixin adapter（缺 ${ready.adapters.missing.join("、") || adapter}）`) + "：请运行 node tools/wechat/install-wechat-adapters.mjs",
					ready
				}, 503);
				return;
			}
			const result = runner.start({
				title,
				adapter,
				dsn: wechatDsn(req)
			});
			if (!result.ok) {
				if (result.busy) {
					json(res, {
						ok: false,
						error: "a publish job is already running",
						jobId: result.job.id
					}, 409);
					return;
				}
				json(res, {
					ok: false,
					error: result.error
				}, 400);
				return;
			}
			json(res, {
				ok: true,
				jobId: result.job.id,
				title: result.job.title,
				adapter: result.job.adapter
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	/**
	* GET /dsh-tiddlywiki/wechat/publish/status — poll one job (`?id=`), or the
	* current/newest one when the id is omitted (the overlay loses its id when the
	* page reloads mid-publish). `job: null` = nothing has run yet.
	*/
	const handleWechatPublishStatus = async (req, res) => {
		try {
			if (rejectNonRead(req, res)) return;
			if (!guardWechat(req, res)) return;
			const runner = deps.wechatRunner();
			if (runner === void 0) {
				json(res, {
					ok: false,
					error: "publish runner unavailable"
				}, 503);
				return;
			}
			const id = (new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "").trim();
			const job = runner.status(id.length > 0 ? id : void 0);
			if (job === void 0) {
				if (id.length > 0) {
					json(res, {
						ok: false,
						error: "unknown job"
					}, 404);
					return;
				}
				json(res, {
					ok: true,
					job: null
				});
				return;
			}
			json(res, {
				ok: true,
				job
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	const disposers = [
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/status`,
			handler: guardHandler(handleStatus)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/note`,
			handler: guardHandler(handleNote)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/edit`,
			handler: guardHandler(handleEdit)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/tags`,
			handler: guardHandler(handleTags)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/recent`,
			handler: guardHandler(handleRecent)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/get`,
			handler: guardHandler(handleGet)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/search`,
			handler: guardHandler(handleSearch)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/render`,
			handler: guardHandler(handleRender)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/sync`,
			handler: guardHandler(handleSync)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/upload`,
			handler: guardHandler(handleUpload)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/restart`,
			handler: guardHandler(handleRestart)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/session/summary`,
			handler: guardHandler(handleSessionSummary)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/agent/sessions`,
			handler: guardHandler(handleAgentSessions)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/agent/modes`,
			handler: guardHandler(handleAgentModes)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/agent/send`,
			handler: guardHandler(handleAgentSend)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/agent/create`,
			handler: guardHandler(handleAgentCreate)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/wechat/ready`,
			handler: guardHandler(handleWechatReady)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/wechat/publish`,
			handler: guardHandler(handleWechatPublish)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/wechat/publish/status`,
			handler: guardHandler(handleWechatPublishStatus)
		}),
		ctx.webServer.register({
			kind: "prefix",
			path: `${ROUTE_PREFIX}/api`,
			handler: guardHandler(handleApiProxy)
		}),
		ctx.webServer.register({
			kind: "prefix",
			path: `${TW_PROXY_PREFIX}`,
			handler: guardHandler(handleTwProxy)
		})
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
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
*   GET  /admin/state    current info + catalog + effective config + status
*   POST /admin/info     { plugins?, themes? } → write info → restart TW
*   POST /admin/config   { ...patch }          → write config tiddler
*   GET  /admin/prompt   the prompt text injected right now (SAVED config)
*   POST /admin/prompt   { enabled?, mode?, extra?, override? } → the text for
*                        a DRAFT config (v0.22.7); writes nothing
*   POST /admin/restart  restart the TW child
*
* @module dsh-tiddlywiki/host/admin
*/
/** Resolve the installed tiddlywiki package root (for the catalog). */
function resolveTwRoot() {
	return dirname(createRequire(import.meta.url).resolve("tiddlywiki/package.json"));
}
/**
* Read the wiki's tiddlywiki.info.
*
* ONLY a missing file (ENOENT) means "no configuration yet" (first run). Every
* other failure — EACCES/EBUSY, a truncated write, malformed JSON — PROPAGATES:
* the settings page used to receive an empty config object, rewrite the file
* from it and thereby DELETE the existing plugins/themes/`build`/hand-written
* fields (v0.19.0 — the AGENTS §8 "don't treat a read failure as absence" rule,
* applied to this path at last).
*/
async function readWikiInfo(wikiPath) {
	const file = join(wikiPath, "tiddlywiki.info");
	let raw;
	try {
		raw = await readFile(file, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return {
			plugins: [],
			themes: [],
			languages: []
		};
		throw new Error(`读取 tiddlywiki.info 失败：${err instanceof Error ? err.message : String(err)}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("tiddlywiki.info 不是合法 JSON；请先修复该文件再保存设置（已保留原文件）");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("tiddlywiki.info 顶层不是对象；请先修复该文件再保存设置（已保留原文件）");
	const obj = parsed;
	return {
		...obj,
		description: obj.description,
		plugins: Array.isArray(obj.plugins) ? obj.plugins : [],
		themes: Array.isArray(obj.themes) ? obj.themes : [],
		languages: Array.isArray(obj.languages) ? obj.languages : []
	};
}
/**
* Write the wiki's tiddlywiki.info (pretty-printed, ordering preserved).
* Keeps a `.bak` of the previous content and swaps the new content in via a
* temp file + rename, so a crash or a full disk cannot leave a truncated file
* behind (readWikiInfo now refuses to guess at one).
*/
async function writeWikiInfo(wikiPath, info) {
	const file = join(wikiPath, "tiddlywiki.info");
	try {
		await writeFile(`${file}.bak`, await readFile(file, "utf8"), "utf8");
	} catch {}
	const tmp = `${file}.tmp`;
	await writeFile(tmp, `${JSON.stringify(info, null, 4)}\n`, "utf8");
	await rename(tmp, file);
}
/**
* Ensure one bundled official plugin is listed in tiddlywiki.info `plugins`
* (idempotent). Returns whether the file changed — the caller restarts TW.
*
* WHY (v0.19.0): `WikiServer.ensureWiki()` scaffolds a fresh wiki with
* `--init server`, and that edition ships ONLY tiddlyweb/filesystem/highlight.
* The plugin nevertheless writes every agent note, quick-note, draft and clip
* as `text/markdown`, and the `text/markdown` parser is provided exclusively by
* the `tiddlywiki/markdown` plugin — without it a brand-new install renders
* every Markdown note as raw wikitext/source. The author's own wiki already had
* the plugin (added by an earlier import workflow), which is why this went
* unnoticed.
*/
async function ensurePlugin(wikiPath, twRoot, name) {
	const info = await readWikiInfo(wikiPath);
	if (info.plugins.includes(name)) return false;
	if (!(await bundledCatalog(twRoot)).plugins.some((p) => p.name === name)) throw new Error(`unknown bundled plugin: ${name}`);
	info.plugins = [...info.plugins, name];
	await writeWikiInfo(wikiPath, info);
	return true;
}
/**
* The theme the TW runtime is ACTUALLY showing, as a catalog-style name
* (`tiddlywiki/heavier`), or undefined when unknown (wiki down, no `$:/theme`).
*
* `$:/theme` holds the active theme title and is normally written as
* `$:/themes/<name>` (that is what this route's own POST writes), but a user
* who picked a theme in TW's Control Panel can leave the fully-qualified
* title there — strip the prefix so both shapes compare against the catalog.
* Without this the settings page could only guess "the last loaded theme"
* (v0.22.3), and one click on 应用主题 silently overwrote the real choice.
*/
async function readActiveThemeName(client) {
	try {
		const tiddler = await client?.get("$:/theme");
		const raw = typeof tiddler?.text === "string" ? tiddler.text.trim() : "";
		if (raw.length === 0) return void 0;
		return raw.startsWith("$:/themes/") ? raw.slice(10) : raw;
	} catch {
		return;
	}
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
* Point `$:/language` at a language plugin — but ONLY when the stored text
* differs (v0.24.2).
*
* WHY THE CONDITIONAL WRITE MATTERS
* ---------------------------------
* Both callers used to PUT this tiddler unconditionally: on EVERY dsh web
* startup (`uiLanguage` auto-apply) and on every languages change. The body was
* identical every time, but TW stamps a fresh `created`/`modified` into the
* `.meta` file, so on a two-machine setup BOTH sides rewrote the same lines and
* `git pull` conflicted on `tiddlers/$__language.txt.meta` **every single time**
* — the repo's git log already carries a commit whose whole job was cleaning up
* one of those leftovers. Same cause produced two conflict rounds in one session
* on 2026-09-20.
*
* Returns whether anything was written (`changed: false` is the common case).
*
* ⚠️ A READ FAILURE MUST NOT BE TREATED AS "ALREADY CORRECT" (ironclad rule #3):
* `client.get()` only returns undefined on a 404; anything else throws, and we
* then write. Skipping on a transient read error would leave the user's language
* pinned to the wrong value with no way to fix it.
*/
async function pinLanguageTiddler(client, desired, log) {
	let existing;
	try {
		existing = await client.get("$:/language");
	} catch (err) {
		log?.("reading $:/language failed — writing it anyway", err);
	}
	if (existing !== void 0 && existing.text === desired) return false;
	await client.put({
		title: "$:/language",
		text: desired,
		type: "text/plain",
		tags: []
	});
	return true;
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
/**
* Sentinel returned instead of a stored secret (`bridge.token` /
* `ui.sendToAgent.token`) by `GET /admin/state` and by `POST /admin/config`'s
* echo. `/admin/*` is an unauthenticated surface (only CSRF-hardened), and the
* config tiddler legitimately carries shared tokens — handing them to any
* caller of the loopback/LAN-reachable GUI is a real leak (v0.19.3). The
* settings page renders the sentinel verbatim; posting it back is a no-op
* (`stripMaskedSecrets` drops it), so the real value never leaves the host.
*/
const MASKED_SECRET = "********";
/**
* Mask secrets (and credentials inside the git remote URL) for an HTTP caller.
*
* v0.20.0: `auth.password` is masked too. The v0.19.3 implementation (and the
* docs) claimed it was, but only `bridge.token` / `ui.sendToAgent.token` /
* `git.remote` were handled — a config tiddler carrying `auth.password` (the
* config tiddler is a wiki tiddler; a user can hand-edit it) was echoed in
* clear text by the unauthenticated `GET /admin/state`. `passwordSet` mirrors
* the `tokenSet` flag so the settings UI can show "a password is stored"
* without ever receiving it.
*/
function maskConfigSecrets(config) {
	const bridge = config.bridge ?? {};
	const ui = config.ui ?? {};
	const sendToAgent = ui.sendToAgent ?? {};
	const git = config.git ?? {};
	const auth = config.auth ?? {};
	const wechat = config.wechat ?? {};
	const maskToken = (value) => typeof value === "string" && value.length > 0 ? MASKED_SECRET : "";
	return {
		...config,
		wechat: {
			...wechat,
			token: maskToken(wechat.token),
			tokenSet: typeof wechat.token === "string" && wechat.token.length > 0
		},
		auth: {
			...auth,
			password: maskToken(auth.password),
			passwordSet: typeof auth.password === "string" && auth.password.length > 0
		},
		git: {
			...git,
			remote: typeof git.remote === "string" ? redactRemoteUrl(git.remote) : git.remote
		},
		bridge: {
			...bridge,
			token: maskToken(bridge.token),
			tokenSet: typeof bridge.token === "string" && bridge.token.length > 0
		},
		ui: {
			...ui,
			sendToAgent: {
				...sendToAgent,
				token: maskToken(sendToAgent.token),
				tokenSet: typeof sendToAgent.token === "string" && sendToAgent.token.length > 0
			}
		}
	};
}
/**
* Drop the masked placeholders from an incoming config patch so saving the
* settings page never overwrites a stored secret with `********` (or the
* redacted git remote with `https://***@…`). `bridge.token`/`ui.sendToAgent.token`
* are cleared only when the caller actually sends an empty string.
*/
function stripMaskedSecrets(patch, current) {
	const copy = { ...patch };
	const cleanToken = (container) => {
		if (typeof container !== "object" || container === null) return container;
		const obj = { ...container };
		if (obj.token === "********") delete obj.token;
		delete obj.tokenSet;
		return obj;
	};
	if (copy.bridge !== void 0) copy.bridge = cleanToken(copy.bridge);
	if (copy.wechat !== void 0) copy.wechat = cleanToken(copy.wechat);
	if (copy.auth !== void 0 && typeof copy.auth === "object" && copy.auth !== null) {
		const auth = { ...copy.auth };
		if (auth.password === "********") delete auth.password;
		delete auth.passwordSet;
		copy.auth = auth;
	}
	if (copy.ui !== void 0) {
		const ui = typeof copy.ui === "object" && copy.ui !== null ? { ...copy.ui } : copy.ui;
		if (typeof ui === "object" && ui !== null && ui.sendToAgent !== void 0) ui.sendToAgent = cleanToken(ui.sendToAgent);
		copy.ui = ui;
	}
	if (copy.git !== void 0 && typeof copy.git === "object" && copy.git !== null) {
		const git = { ...copy.git };
		const storedRemote = typeof current.git?.remote === "string" ? current.git.remote : "";
		if (typeof git.remote === "string" && storedRemote.length > 0 && git.remote === redactRemoteUrl(storedRemote)) delete git.remote;
		copy.git = git;
	}
	return copy;
}
function registerAdminRoutes(ctx, deps) {
	const handleState = async (req, res) => {
		try {
			if (rejectNonRead(req, res)) return;
			const wikiPath = deps.getWikiPath();
			const [info, catalog] = await Promise.all([readWikiInfo(wikiPath), bundledCatalog(deps.twRoot())]);
			let git = null;
			try {
				const status = await new GitFace().status(wikiPath);
				git = {
					...status,
					remote: redactRemoteUrl(status.remote ?? "")
				};
			} catch {
				git = null;
			}
			const view = deps.server.status();
			const themeActive = await readActiveThemeName(deps.getClient());
			json(res, {
				ok: true,
				server: {
					...view,
					logs: redactLogLines(view.logs)
				},
				info: {
					plugins: info.plugins,
					themes: info.themes,
					languages: info.languages ?? [],
					themeActive
				},
				catalog,
				config: maskConfigSecrets(deps.config.get()),
				configError: deps.config.parseError() ?? null,
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
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
			const body = JSON.parse(await readBody(req));
			const wikiPath = deps.getWikiPath();
			let info;
			try {
				info = await readWikiInfo(wikiPath);
			} catch (err) {
				json(res, {
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				}, 500);
				return;
			}
			const catalog = await bundledCatalog(deps.twRoot());
			const known = new Set([...catalog.plugins, ...catalog.themes].map((c) => c.name));
			const knownLangs = new Set(catalog.languages.map((c) => c.name));
			/** Snapshot for the no-op guard below (JSON compare is enough here). */
			const beforeInfo = JSON.stringify(info);
			/** Set only when the request carried a themes array with a resolvable active pick. */
			let activatedTheme;
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
			try {
				info.plugins = applyList("plugins", body.plugins);
				if (Array.isArray(body.themes)) {
					const themeDeps = {};
					for (const theme of catalog.themes) if (theme.dependents && theme.dependents.length > 0) themeDeps[theme.name] = theme.dependents;
					const selected = applyList("themes", body.themes);
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
			} catch (err) {
				json(res, {
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				}, 400);
				return;
			}
			const changed = JSON.stringify(info) !== beforeInfo;
			if (changed) {
				await writeWikiInfo(wikiPath, info);
				await drainThenStop({
					client: deps.getClient(),
					tiddlersDir: join(deps.getWikiPath(), "tiddlers"),
					stop: () => deps.server.restart(),
					log: (message) => console.warn("[dsh-tiddlywiki]", message)
				});
			}
			if (Array.isArray(body.themes) && activatedTheme !== void 0) {
				const client = deps.getClient();
				if (client !== void 0) await client.put({
					title: "$:/theme",
					text: `$:/themes/${activatedTheme}`,
					type: "text/vnd.tiddlywiki",
					tags: []
				}).catch((err) => {
					console.warn("[dsh-tiddlywiki] activating theme failed:", err);
				});
			}
			if (Array.isArray(body.languages)) {
				const client = deps.getClient();
				if (client !== void 0) {
					const langs = info.languages ?? [];
					await pinLanguageTiddler(client, langs.length > 0 ? `$:/languages/${langs[0]}` : "$:/languages/en-GB", (message, err) => {
						if (err === void 0) console.warn("[dsh-tiddlywiki]", message);
						else console.warn("[dsh-tiddlywiki] pinning $:/language failed:", err);
					});
					const hint = langs.length > 0 ? langs[0] : "";
					if ((deps.config.get().uiLanguage ?? "") !== hint) await deps.config.set(client, { uiLanguage: hint }).catch(() => void 0);
				}
			}
			json(res, {
				ok: true,
				changed,
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
			}, 500);
		}
	};
	const handleConfig = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
			const body = JSON.parse(await readBody(req));
			const client = deps.getClient();
			if (client === void 0) {
				json(res, {
					ok: false,
					error: "wiki service is not running"
				}, 503);
				return;
			}
			await deps.config.set(client, stripMaskedSecrets(body, deps.config.get()));
			deps.onConfigChanged?.();
			json(res, {
				ok: true,
				config: maskConfigSecrets(deps.config.get())
			});
		} catch (err) {
			if (err instanceof ConfigUnreadableError) {
				json(res, {
					ok: false,
					error: err.message
				}, 409);
				return;
			}
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	const handleRestart = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
			const drained = await drainThenStop({
				client: deps.getClient(),
				tiddlersDir: join(deps.getWikiPath(), "tiddlers"),
				stop: () => deps.server.restart(),
				log: (message) => console.warn("[dsh-tiddlywiki]", message)
			});
			json(res, {
				ok: true,
				status: deps.server.status().status,
				drained
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
	const handleSeeds = async (req, res) => {
		try {
			if (rejectNonRead(req, res)) return;
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
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
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
			const seedStartedAt = Date.now();
			const results = await deps.seeds.run(client, id, force);
			let restarted = false;
			let restartError;
			if (needsRestartAfterSeeds(results)) try {
				if (!await waitForFileWrite(join(deps.getWikiPath(), "tiddlers", "$__plugins_dsh_render.json"), 8e3, 150, seedStartedAt)) console.warn("[dsh-tiddlywiki] seeded render plugin file not seen on disk before restart");
				if (!await drainThenStop({
					client,
					tiddlersDir: join(deps.getWikiPath(), "tiddlers"),
					stop: () => deps.server.restart(),
					log: (message) => console.warn("[dsh-tiddlywiki]", message)
				})) console.warn("[dsh-tiddlywiki] seed writes may not have been flushed before restart");
				restarted = true;
			} catch (err) {
				restartError = err instanceof Error ? err.message : String(err);
				console.warn("[dsh-tiddlywiki] restart after seeding failed:", restartError);
			}
			const ok = results.every((r) => r.ok);
			json(res, {
				ok,
				results,
				restarted,
				...restartError !== void 0 ? { restartError } : {}
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
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
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
	/**
	* GET /dsh-tiddlywiki/admin/prompt — the system-prompt text that would be
	* injected right now, with the effective mode/enabled flag (v0.21.0). The
	* settings page renders it verbatim so a prompt edit is never a black box.
	* Read-only + CSRF-hardened like every other admin read.
	*
	* POST /dsh-tiddlywiki/admin/prompt — same answer for a DRAFT config sent in
	* the body (v0.22.7). The settings page previews what its form currently
	* holds, before 保存配置: the dropdown's value lived only in the browser DOM,
	* so switching 形态 and previewing used to show the still-SAVED text
	* (byte-identical) and read as "the two modes are the same". Nothing is
	* persisted here — `enabled/mode/extra/override` go through the same builder
	* `applyPrompt()` uses, so the draft cannot disagree with a later save.
	*/
	const handlePrompt = async (req, res) => {
		try {
			if ((req.method ?? "GET").toUpperCase() === "POST") {
				if (rejectCrossSiteWrite(req, res, ["POST"])) return;
				const raw = (await readBody(req)).trim();
				let body = {};
				if (raw.length > 0) try {
					body = JSON.parse(raw);
				} catch {
					json(res, {
						ok: false,
						error: "invalid JSON body"
					}, 400);
					return;
				}
				const prompt = deps.getPrompt?.(normalizePromptPreview(body));
				if (prompt === void 0) {
					json(res, {
						ok: false,
						error: "prompt preview is not available"
					}, 503);
					return;
				}
				json(res, {
					ok: true,
					draft: true,
					enabled: prompt.enabled,
					mode: prompt.mode,
					length: prompt.text.length,
					text: prompt.text
				});
				return;
			}
			if (rejectNonRead(req, res)) return;
			const prompt = deps.getPrompt?.();
			if (prompt === void 0) {
				json(res, {
					ok: false,
					error: "prompt preview is not available"
				}, 503);
				return;
			}
			json(res, {
				ok: true,
				draft: false,
				enabled: prompt.enabled,
				mode: prompt.mode,
				length: prompt.text.length,
				text: prompt.text
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	/**
	* GET /dsh-tiddlywiki/admin/wiki/location — the folder the plugin currently
	* serves, how that was decided (pointer file / cordis config / default), the
	* config default to fall back to, and the wiki-looking folders next to it
	* (settings-page「知识库位置」, v0.22.0). Read-only + CSRF-hardened.
	*/
	const handleWikiLocation = async (req, res) => {
		try {
			if (rejectNonRead(req, res)) return;
			if (deps.wiki === void 0) {
				json(res, {
					ok: false,
					error: "wiki location is not available"
				}, 503);
				return;
			}
			json(res, {
				ok: true,
				...await deps.wiki.info()
			});
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, 500);
		}
	};
	/**
	* POST /dsh-tiddlywiki/admin/wiki/switch { root, name } — repoint the running
	* plugin at another wiki folder (v0.22.0). Serialized against itself by the
	* host; a failure is reported with `rolledBack` so the page can say whether
	* the old wiki is still serving.
	*/
	const handleWikiSwitch = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
			if (deps.wiki === void 0) {
				json(res, {
					ok: false,
					error: "wiki location is not available"
				}, 503);
				return;
			}
			const body = JSON.parse(await readBody(req));
			const result = await deps.wiki.switch({
				root: body.root,
				name: body.name
			});
			json(res, result.ok ? {
				...result,
				status: deps.server.status().status
			} : result, result.ok ? 200 : 400);
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	/**
	* POST /dsh-tiddlywiki/admin/wiki/reset — 「恢复为配置默认」: delete the pointer
	* file and (when needed) switch back to the cordis default folder (v0.22.0).
	*/
	const handleWikiReset = async (req, res) => {
		try {
			if (rejectCrossSiteWrite(req, res, ["POST"])) return;
			if (deps.wiki === void 0) {
				json(res, {
					ok: false,
					error: "wiki location is not available"
				}, 503);
				return;
			}
			const result = await deps.wiki.reset();
			json(res, result.ok ? {
				...result,
				status: deps.server.status().status
			} : result, result.ok ? 200 : 400);
		} catch (err) {
			json(res, {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			}, errorStatus(err));
		}
	};
	const disposers = [
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/state`,
			handler: guardHandler(handleState)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/prompt`,
			handler: guardHandler(handlePrompt)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/wiki/location`,
			handler: guardHandler(handleWikiLocation)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/wiki/switch`,
			handler: guardHandler(handleWikiSwitch)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/wiki/reset`,
			handler: guardHandler(handleWikiReset)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/info`,
			handler: guardHandler(handleInfo)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/config`,
			handler: guardHandler(handleConfig)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/restart`,
			handler: guardHandler(handleRestart)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/seeds`,
			handler: guardHandler(handleSeeds)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/seeds/run`,
			handler: guardHandler(handleSeedsRun)
		}),
		ctx.webServer.register({
			kind: "exact",
			path: `${ROUTE_PREFIX}/admin/seeds/remove`,
			handler: guardHandler(handleSeedsRemove)
		})
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
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
/** Loopback-only Host header whitelist (DNS-rebinding defense). */
function hostAllowed(host, port) {
	if (typeof host !== "string") return false;
	const h = host.trim().toLowerCase();
	const ok = (base) => h === base || h === `${base}:${port}`;
	return ok("127.0.0.1") || ok("localhost") || ok("[::1]") || ok("::1");
}
/** IPv4 ranges that must never be fetched on behalf of a web page. */
const PRIVATE_V4_PATTERNS = [
	/^0\./,
	/^10\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.0\.0\./,
	/^192\.0\.2\./,
	/^192\.88\.99\./,
	/^192\.168\./,
	/^198\.1[89]\./,
	/^198\.51\.100\./,
	/^203\.0\.113\./,
	/^22[4-9]\./,
	/^23\d\./,
	/^24\d\./,
	/^25[0-5]\./
];
/** Parse a dotted-quad IPv4 into 4 bytes, or null. */
function parseIpv4(input) {
	const parts = input.split(".");
	if (parts.length !== 4) return null;
	const out = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const value = Number(part);
		if (value > 255) return null;
		out.push(value);
	}
	return out;
}
/**
* Expand ANY IPv6 textual form (compressed `::`, expanded, embedded dotted
* IPv4 tail, zone id, bracketed) into exactly 16 bytes — or null when it is not
* a valid IPv6 literal. Written by hand because the guard must be total:
* `net.isIP()` accepts forms such as `0:0:0:0:0:0:0:1` (which IS `::1`) that the
* old prefix-regex guard let through.
*/
function ipv6ToBytes(input) {
	let ip = input.trim().toLowerCase();
	if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
	const zone = ip.indexOf("%");
	if (zone >= 0) ip = ip.slice(0, zone);
	const halves = ip.split("::");
	if (halves.length > 2) return null;
	const parseGroups = (text) => {
		if (text.length === 0) return [];
		const out = [];
		for (const group of text.split(":")) {
			if (group.length === 0) return null;
			if (group.includes(".")) {
				const v4 = parseIpv4(group);
				if (v4 === null) return null;
				out.push((v4[0] ?? 0) * 256 + (v4[1] ?? 0), (v4[2] ?? 0) * 256 + (v4[3] ?? 0));
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
			out.push(Number.parseInt(group, 16));
		}
		return out;
	};
	const head = parseGroups(halves[0] ?? "");
	if (head === null) return null;
	let groups;
	if (halves.length === 2) {
		const tail = parseGroups(halves[1] ?? "");
		if (tail === null) return null;
		const missing = 8 - head.length - tail.length;
		if (missing < 0) return null;
		groups = [
			...head,
			...new Array(missing).fill(0),
			...tail
		];
	} else groups = head;
	if (groups.length !== 8) return null;
	const bytes = [];
	for (const group of groups) bytes.push(group >> 8 & 255, group & 255);
	return bytes;
}
/**
* True for loopback / link-local / private / unique-local / CGNAT / multicast
* addresses. IPv6 is judged on its PARSED BYTES, not on string prefixes
* (v0.19.0): `0:0:0:0:0:0:0:1`, `::0:1` and `::ffff:7f00:1` all denote `::1` /
* `127.0.0.1` and were previously ALLOWED, i.e. the SSRF guard was bypassable.
* IPv4-mapped (`::ffff:0:0/96`), IPv4-compatible (`::/96`) and 6to4
* (`2002::/16`) forms embed an IPv4 address and are judged as that address.
*/
function isPrivateAddress(address) {
	const raw = address.trim().toLowerCase();
	const ip = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
	const family = isIP(ip);
	if (family === 4) return PRIVATE_V4_PATTERNS.some((re) => re.test(ip));
	if (family !== 6) return false;
	const bytes = ipv6ToBytes(ip);
	if (bytes === null) return true;
	const isZero = (slice) => slice.every((b) => b === 0);
	const at = (index) => bytes[index] ?? 0;
	const v4 = (offset) => `${at(offset)}.${at(offset + 1)}.${at(offset + 2)}.${at(offset + 3)}`;
	if (isZero(bytes)) return true;
	if (isZero(bytes.slice(0, 15)) && at(15) === 1) return true;
	if ((at(0) & 254) === 252) return true;
	if (at(0) === 254 && (at(1) & 192) === 128) return true;
	if (at(0) === 255) return true;
	if (at(0) === 32 && at(1) === 1 && at(2) === 13 && at(3) === 184) return true;
	if (isZero(bytes.slice(0, 10)) && at(10) === 255 && at(11) === 255) return isPrivateAddress(v4(12));
	if (at(0) === 32 && at(1) === 2) return isPrivateAddress(v4(2));
	if (at(0) === 0 && at(1) === 100 && at(2) === 255 && at(3) === 155) return isPrivateAddress(v4(12));
	if (isZero(bytes.slice(0, 12))) return isPrivateAddress(v4(12));
	return false;
}
/**
* SSRF guard for a clip image URL. The bridge downloads on behalf of a page in
* the user's browser, so it must never become a proxy into the local network
* (or a cloud metadata endpoint). Rejects non-http(s) schemes, loopback/LAN
* hostnames, literal private addresses, and public names that RESOLVE to a
* private address. Redirects are re-validated per hop by the caller.
*
* v0.20.0: this used to be a second, hand-maintained copy of the policy inside
* `resolvePublicTarget` (the two had to be kept in sync by hand). It now simply
* performs the same resolve-and-validate step and discards the pinned target;
* `downloadClipImage` still pins the approved address, so the check is not
* duplicated at connect time either.
*/
async function assertPublicImageUrl(rawUrl) {
	await resolvePublicTarget(rawUrl);
}
/**
* Resolve one image URL to a PUBLIC address and PIN it. The guard validates the
* DNS answer here; the request then connects to that exact address (custom
* `lookup`), so a rebinding domain cannot pass the check with a public answer
* and then be re-resolved to 127.0.0.1 at connect time (v0.19.0 — the previous
* implementation validated the name and then let `fetch` resolve it again).
*/
async function resolvePublicTarget(rawUrl) {
	let url;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("图片地址不是合法 URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`不支持的图片协议 ${url.protocol}`);
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) throw new Error("拒绝下载内网主机名的图片");
	const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	const literalFamily = isIP(literal);
	if (literalFamily !== 0) {
		if (isPrivateAddress(literal)) throw new Error("拒绝下载内网地址的图片");
		return {
			url,
			address: literal,
			family: literalFamily
		};
	}
	let addresses;
	try {
		addresses = await lookup(host, { all: true });
	} catch {
		throw new Error(`图片主机无法解析：${host}`);
	}
	if (addresses.length === 0) throw new Error(`图片主机无法解析：${host}`);
	if (addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error("拒绝下载解析到内网地址的图片");
	const first = addresses[0];
	if (first === void 0) throw new Error(`图片主机无法解析：${host}`);
	return {
		url,
		address: first.address,
		family: first.family
	};
}
/** One GET against an already-validated, pinned target (no redirect following). */
function requestImageHop(target, referer, maxBytes, timeoutMs) {
	return new Promise((resolveP, rejectP) => {
		const isHttps = target.url.protocol === "https:";
		const requester = isHttps ? get$1 : get;
		const pinnedLookup = (_hostname, options, callback) => {
			if (options.all === true) {
				callback(null, [{
					address: target.address,
					family: target.family
				}]);
				return;
			}
			callback(null, target.address, target.family);
		};
		const request = requester({
			protocol: target.url.protocol,
			hostname: target.url.hostname,
			port: target.url.port.length > 0 ? Number(target.url.port) : isHttps ? 443 : 80,
			path: `${target.url.pathname}${target.url.search}`,
			method: "GET",
			headers: {
				"user-agent": "Mozilla/5.0 (compatible; dsh-tiddlywiki clip bridge)",
				referer,
				accept: "image/*,*/*;q=0.8",
				"accept-encoding": "identity"
			},
			lookup: pinnedLookup
		}, (res) => {
			const status = res.statusCode ?? 0;
			if (status >= 300 && status < 400) {
				const location = res.headers.location;
				res.resume();
				if (location === void 0 || location.length === 0) {
					rejectP(/* @__PURE__ */ new Error(`重定向缺少 Location（HTTP ${status}）`));
					return;
				}
				resolveP({
					buffer: Buffer.alloc(0),
					type: void 0,
					redirect: new URL(location, target.url).href
				});
				return;
			}
			if (status < 200 || status >= 300) {
				res.resume();
				rejectP(/* @__PURE__ */ new Error(`下载失败 HTTP ${status}`));
				return;
			}
			const declared = Number(res.headers["content-length"] ?? NaN);
			if (Number.isFinite(declared) && declared > maxBytes) {
				res.destroy();
				rejectP(/* @__PURE__ */ new Error("图片超过 15MB 上限"));
				return;
			}
			const chunks = [];
			let size = 0;
			res.on("data", (chunk) => {
				size += chunk.length;
				if (size > maxBytes) {
					res.destroy();
					rejectP(/* @__PURE__ */ new Error("图片超过 15MB 上限"));
					return;
				}
				chunks.push(chunk);
			});
			res.on("end", () => {
				if (size === 0) {
					rejectP(/* @__PURE__ */ new Error("下载内容为空"));
					return;
				}
				resolveP({
					buffer: Buffer.concat(chunks),
					type: res.headers["content-type"]
				});
			});
			res.on("error", rejectP);
		});
		request.on("timeout", () => {
			request.destroy(/* @__PURE__ */ new Error("图片下载超时"));
		});
		request.on("error", rejectP);
		request.setTimeout(timeoutMs);
	});
}
/**
* Download one clip image with the full SSRF posture: every hop is validated
* AND pinned, redirects are followed manually (max `maxRedirects`), the byte
* cap is enforced while streaming, and compression is disabled.
*/
async function downloadClipImage(imageUrl, referer, options = {}) {
	const maxBytes = options.maxBytes ?? 15728640;
	const maxRedirects = options.maxRedirects ?? 3;
	const timeoutMs = options.timeoutMs ?? 2e4;
	let current = imageUrl;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const result = await requestImageHop(await resolvePublicTarget(current), referer, maxBytes, timeoutMs);
		if (result.redirect !== void 0) {
			current = result.redirect;
			continue;
		}
		return {
			buffer: result.buffer,
			type: result.type
		};
	}
	throw new Error(`图片重定向次数超过 ${maxRedirects} 次`);
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
				server.on("error", (err) => {
					this.deps.log?.(`server error after listen: ${err.message}`);
				});
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
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				resolve();
			};
			try {
				server.closeAllConnections?.();
			} catch {}
			server.close(() => finish());
			setTimeout(finish, 1e3).unref?.();
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
				enabled: cfg.enabled
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
			if (typeof got !== "string" || !safeTokenEqual(got, cfg.token)) {
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
				await assertPublicImageUrl(imageUrl);
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
//#region src/host/workspace.ts
/**
* Workspace / project marking for agent-created notes (v0.24.0).
*
* WHY THIS MODULE EXISTS
* ----------------------
* The injected prompt has always ASKED the model to tag new notes with the
* current workspace name, and that is exactly the kind of housekeeping a model
* stops doing after a few turns. The plugin can do it itself: a tool's
* `execute(args, exec)` receives a `ToolRunContext`, whose `agent.id` is the
* calling session, and `sessions.get(id).header.cwd` is that session's working
* directory. So the project name is knowable at write time without asking
* anyone — see `ToolsDeps.workspaceName`.
*
* TWO CARRIERS, ON PURPOSE (user decision 2026-09-20)
* ---------------------------------------------------
*   - tag `ws/<id>`     — clickable and groupable inside the TiddlyWiki UI;
*   - field `workspace` — exact filtering through `tiddlywiki_search`'s existing
*     `field`/`value` parameters, with zero tag-list pollution.
* `id` is the canonical, sanitised project name and is identical in both.
*
* ⚠️ THE `ws/` PREFIX IS LOAD-BEARING. A bare `<name>` collides with real
* business tags: on the author's wiki the workspace `dsh-tiddlywiki` already
* names 2510 notes (imported book chapters), so an unprefixed workspace tag
* would make "search inside my workspace" return those 2510 chapters — the
* feature would be worse than useless. Do not "simplify" the prefix away.
*
* @module dsh-tiddlywiki/host/workspace
*/
/** Tag prefix for the workspace marker (`ws/<id>`). */
const WORKSPACE_TAG_PREFIX = "ws/";
/** Custom field carrying the canonical workspace id. */
const WORKSPACE_FIELD = "workspace";
/**
* Directory basenames that are never a "project".
*
* Tagging every note `tmp` (or `users`) is pure noise AND useless for narrowing —
* the tag would carry no information. Kept deliberately short and
* lowercase-compared.
*
* KNOWN LIMITATION (documented, not a bug): these are *container* directory
* names only. A session whose cwd IS the home directory ends with the login name
* (`C:\Users\bbq` → `bbq`, `/home/me` → `me`), which is NOT matched here and
* therefore yields `ws/<login>`. That bucket is coarse but truthful — it is
* exactly where those notes were written, and the alternative (comparing against
* `os.homedir()`) would drag a filesystem dependency into this pure module and
* still miss a symlinked or volume-mounted home.
*/
const GENERIC_DIRS = /* @__PURE__ */ new Set([
	"",
	"home",
	"users",
	"tmp",
	"temp",
	"root",
	"desktop",
	"documents",
	"downloads"
]);
/**
* Last path segment of a session cwd — the raw project name.
* Undefined when there is nothing to take (missing, empty, or a bare root).
*
* ⚠️ A DRIVE ROOT MUST YIELD NOTHING (v0.24.0, found by
* `scripts/verify-workspace.mjs`): stripping the trailing separator turns
* `C:\` into the segment `C:`, which is a valid-looking name that would tag
* every note in a drive-root session `ws/C:`. There is no project there, so the
* only correct answer is undefined.
*/
function workspaceNameFromCwd(cwd) {
	if (typeof cwd !== "string") return void 0;
	const trimmed = cwd.trim().replace(/[\\/]+$/, "");
	if (trimmed.length === 0) return void 0;
	const segments = trimmed.split(/[\\/]/).filter((s) => s.length > 0);
	const base = segments.length > 0 ? segments[segments.length - 1] ?? "" : "";
	if (base.length === 0) return void 0;
	if (/^[A-Za-z]:$/.test(base)) return void 0;
	return base;
}
/**
* Canonicalise a raw project name into the workspace id, or undefined when it
* cannot carry meaning.
*
* TiddlyWiki tags are whitespace-separated, and `[ ] { } | < > "` break tag and
* filter syntax (the same set `isJunkTag()` treats as a write accident). Those
* become `-`; everything else — CJK included — is left alone so the tag stays
* recognisable in the UI.
*/
function normalizeWorkspaceName(raw) {
	if (typeof raw !== "string") return void 0;
	const cleaned = raw.trim().replace(/[\s[\]{}|<>"$]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
	if (cleaned.length === 0) return void 0;
	if (GENERIC_DIRS.has(cleaned.toLowerCase())) return void 0;
	return cleaned;
}
/** The tag for a canonical workspace id. */
function workspaceTagName(id) {
	return `ws/${id}`;
}
/** The `{id, tag}` marker for a session cwd, or undefined when unusable. */
function workspaceMarkFromCwd(cwd) {
	const id = normalizeWorkspaceName(workspaceNameFromCwd(cwd));
	if (id === void 0) return void 0;
	return {
		id,
		tag: workspaceTagName(id)
	};
}
//#endregion
//#region src/host/tools.ts
/**
* The `tiddlywiki_*` agent tools (design doc §11, D8) plus the extension
* point: `registerTiddlywikiTools(ctx, deps)` registers tools list-style, so a
* new tool is just one more `defineTool` in the array — index.ts never changes.
*
* Toolset (v0.19):
*   search / get / put / batch_put / append / rename / delete / trash /
*   backlinks / attach / lint / recent / list_tags / git_sync / git_resolve
*
* RENDER CONTRACT (design doc §4.3): the registry feeds `output.render(args,
* value)` into the loop — the model sees ONLY the rendered text, never the raw
* JSON `value`. Every render must carry the complete facts an agent needs to
* act (titles, tags, snippets, git state); a terse UI summary starves it.
*
* @module dsh-tiddlywiki/host/tools
*/
/**
* Summaries of the tools registered by the LAST `registerTiddlywikiTools()`
* pass — the single source for the `full` prompt catalogue and for
* `scripts/verify-prompt.mjs` (v0.21.0).
*
* History: the prompt carried a HAND-WRITTEN parameter catalogue that was last
* updated in v0.19.0 and silently drifted 6 signatures behind the tools by
* v0.20.1. Collecting them here from the same definitions that reach the model
* makes that class of drift impossible.
*/
const REGISTERED_TOOL_SUMMARY = [];
/** Tool summaries of the last registration pass (empty before one has run). */
function tiddlywikiToolSummary() {
	return REGISTERED_TOOL_SUMMARY;
}
/**
* Session id of the caller, when the runtime supplies one.
*
* `ToolRunContext.agent.id` is the calling session (verified against the host
* SDK's `ToolExecutionInput.agent`), which is what lets the plugin resolve
* "which project is this note from?" all by itself (v0.24.0).
*/
function sessionIdOf(exec) {
	const id = (exec?.agent)?.id;
	return typeof id === "string" && id.length > 0 ? id : void 0;
}
/**
* The workspace marker to add to a NEW note created by this call, or undefined
* (no session, no cwd, unusable name, or the feature is off).
*
* Applied on CREATE only — an overwrite keeps whatever the note already has, and
* never grows a workspace tag it was not created with.
*/
function workspaceMarkFor(deps, exec) {
	if (deps.workspaceName === void 0) return void 0;
	if (deps.workspaceMarkEnabled?.() === false) return void 0;
	const sessionId = sessionIdOf(exec);
	if (sessionId === void 0) return void 0;
	return workspaceMarkFromCwd(deps.workspaceName(sessionId));
}
/**
* Merge the workspace marker into a NEW note's explicit tags and fields.
*
* ADDITIVE, never replacing: the caller's tags are kept in front and the caller's
* own `workspace` field (if it set one) wins, so an explicit value is never
* silently overwritten. Returns the inputs untouched when there is no marker.
*/
function withWorkspaceMark(mark, tags, fields) {
	if (mark === void 0) return {
		tags,
		fields
	};
	const nextTags = tags === void 0 || tags.length === 0 ? [mark.tag] : tags.includes(mark.tag) ? tags : [...tags, mark.tag];
	const nextFields = { ...fields ?? {} };
	const explicit = nextFields[WORKSPACE_FIELD];
	if (typeof explicit !== "string" || explicit.trim().length === 0) nextFields[WORKSPACE_FIELD] = mark.id;
	return {
		tags: nextTags,
		fields: nextFields,
		workspace: mark.id
	};
}
/**
* Snippet centred on the FIRST match of `query` (v0.19.0). The old snippet was
* always the first 160 characters of the note, so a hit deep inside a long note
* showed the model text that did not contain the term it searched for.
*
* v0.24.0: search is multi-term AND, so the whole query may never appear
* literally. Fall back to the earliest individual term before giving up, or a
* perfectly good hit would still render the head of the note.
*/
function snippetAround(text, query, max = 160) {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	const lower = flat.toLowerCase();
	const candidates = [query.trim().toLowerCase(), ...query.split(/\s+/).map((s) => s.trim().toLowerCase())].filter((needle) => needle.length > 0);
	let at = -1;
	let needleLength = 0;
	for (const needle of candidates) {
		const found = lower.indexOf(needle);
		if (found < 0) continue;
		if (at < 0 || found < at) {
			at = found;
			needleLength = needle.length;
		}
	}
	if (at < 0) return `${flat.slice(0, max)}…`;
	const half = Math.max(0, Math.floor((max - needleLength) / 2));
	const start = Math.max(0, at - half);
	const end = Math.min(flat.length, start + max);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < flat.length ? "…" : "";
	return `${prefix}${flat.slice(start, end)}${suffix}`;
}
/** Trash namespace for soft-deleted tiddlers (system titles: never listed by
*  the default recipe filter, so deleted notes stop appearing in search/recent
*  while staying recoverable). */
const TRASH_PREFIX = "$:/dsh-tiddlywiki/trash/";
/**
* Trash INDEX tiddler. A `$:/`-titled tiddler cannot be ENUMERATED through the
* recipe listing at all: a fresh wiki has `$:/config/SyncSystemTiddlersFromServer
* = "no"`, and `get-tiddlers-json.js` then appends `+[!is[system]]` to every
* filter (verified). The trash therefore keeps its own index and reads it with a
* plain GET (which works for system titles). (v0.19.0)
*/
const TRASH_INDEX_TITLE = "$:/dsh-tiddlywiki/trash-index";
/** Build the trash title that holds one soft-deleted tiddler. */
function trashTitleFor(title, at = /* @__PURE__ */ new Date()) {
	const stamp = at.toISOString().replace(/[:.]/g, "-");
	return `${TRASH_PREFIX}${stamp}/${title}`;
}
/**
* Read the trash index.
*
* `readOk:false` distinguishes「索引读不到」(a failure: 5xx/timeout/auth — the
* tool layer MUST stop, because overwriting the index with whatever we managed
* to read would drop every earlier entry and orphan those trashed tiddlers) from
*「索引不存在」(404 = a brand-new wiki with an empty trash) and「JSON 坏了」
* (rebuildable: the trash tiddlers themselves are still there, only the index
* entries are lost).
*
* Swallowing the error into `[]` was the v0.19.4 defect: one transient failure
* during `tiddlywiki_delete` rewrote the whole index to a single-entry array.
*/
async function readTrashIndex(wiki) {
	let tiddler;
	try {
		tiddler = await wiki.get(TRASH_INDEX_TITLE);
	} catch {
		return {
			readOk: false,
			corrupted: false,
			entries: []
		};
	}
	if (tiddler === void 0 || typeof tiddler.text !== "string" || tiddler.text.trim().length === 0) return {
		readOk: true,
		corrupted: false,
		entries: []
	};
	try {
		const parsed = JSON.parse(tiddler.text);
		if (!Array.isArray(parsed)) return {
			readOk: true,
			corrupted: true,
			entries: []
		};
		return {
			readOk: true,
			corrupted: false,
			entries: parsed.filter((entry) => {
				if (typeof entry !== "object" || entry === null) return false;
				const e = entry;
				return typeof e.trash === "string" && typeof e.of === "string";
			}).map((e) => ({
				trash: e.trash,
				of: e.of,
				at: typeof e.at === "string" ? e.at : ""
			}))
		};
	} catch {
		return {
			readOk: true,
			corrupted: true,
			entries: []
		};
	}
}
/** Persist the trash index. */
async function writeTrashIndex(wiki, entries) {
	await wiki.put({
		title: TRASH_INDEX_TITLE,
		text: JSON.stringify(entries, null, 2),
		type: "application/json",
		tags: []
	});
}
/** Raised when the trash index cannot be read: the operation must abort rather
*  than rebuild the index from an empty base (data-loss guard, v0.19.5). */
var TrashIndexUnavailableError = class extends Error {
	constructor() {
		super("回收站索引暂时读不到（TiddlyWiki 可能正在重启或超时）；为避免覆盖索引、丢回收站记录，本次操作已中止，请稍后重试。");
		this.name = "TrashIndexUnavailableError";
	}
};
/** Mime types offered by `tiddlywiki_attach` for local files. */
const ATTACH_MIME_BY_EXT = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	avif: "image/avif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	pdf: "application/pdf",
	zip: "application/zip",
	txt: "text/plain",
	md: "text/markdown",
	json: "application/json",
	csv: "text/csv",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	mp4: "video/mp4",
	epub: "application/epub+zip"
};
/** Size cap for one attachment (mirrors the clip bridge's image cap). */
const MAX_ATTACH_BYTES = 15 * 1024 * 1024;
/**
* Count references to `target` inside wiki text: `[[target]]`,
* `[[display|target]]`, `[[target|display]]` is NOT a reference to target as a
* link target in TW (the first part is the text, the second the target), so
* only the second position counts, plus `{{target}}` transclusions.
*/
function countRefsTo(text, target) {
	if (target.length === 0) return 0;
	const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patterns = [
		new RegExp(`\\[\\[${escaped}\\]\\]`, "g"),
		new RegExp(`\\[\\[[^\\]|]*\\|${escaped}\\]\\]`, "g"),
		new RegExp(`\\{\\{${escaped}\\}\\}`, "g")
	];
	let count = 0;
	for (const re of patterns) count += (text.match(re) ?? []).length;
	return count;
}
/**
* Junk tags produced by tooling mistakes rather than by a human. The live wiki
* still carries `筛选器错误: Missing [ in filter expression` from the v0.16.22
* filter bug — a lint must be able to find that class of damage again.
*
* EXPORTED (v0.24.0) so `scripts/verify-workspace.mjs` can assert the automatic
* `ws/<id>` tags are never junk: the two character sets (here and in
* `normalizeWorkspaceName`) must stay in agreement, and this is the only place
* that can catch a future edit to just one of them.
*/
function isJunkTag(tag) {
	if (tag.length === 0) return false;
	if (/筛选器错误|Missing \[|in filter expression/i.test(tag)) return true;
	if (/[[\]{}|<>]/.test(tag)) return true;
	if (/^(in|filter|expression|Missing|tags:)$/i.test(tag)) return true;
	if (/^[A-Za-z]:\\/.test(tag)) return true;
	if (tag.trim() !== tag) return true;
	return false;
}
/**
* tiddler 的非内容字段（自定义字段 + 内容类型 + 时间戳 + revision），供模型读。
*
* v0.19.1 修复：单条 GET 把自定义字段**嵌在 `fields` 里**，旧实现只把顶层条目
* 抄一遍，于是渲染出来的 `字段:` 行是 `fields=[object Object]` —— `q`/`due`/
* `clip-url`/`workspace` 这些笔记元数据对模型完全不可见（实测）。现在统一走
* `flattenTiddlerFields()` 摊平，并显式带上 `revision`（乐观并发令牌）。
*/
function pickFields(t) {
	const out = flattenTiddlerFields(t);
	if (t.revision !== void 0) out.revision = t.revision;
	return out;
}
/**
* 覆盖写入前后内容类型的差异（v0.20.1）。内容类型决定 TW 用哪个 parser，静默变化
* 会让 CSS 被当 Markdown、Markdown 笔记被当 wikitext，所以覆盖路径必须把这个差异
* 回执给模型。只有两边都拿得到 `type` 且不同才报告（新建 → 无 from）。
*/
function typeChangeOf(existing, next) {
	if (existing === void 0) return {};
	const from = typeof existing.type === "string" && existing.type.length > 0 ? existing.type : void 0;
	const to = typeof next.type === "string" && next.type.length > 0 ? next.type : void 0;
	if (from === void 0 || to === void 0 || from === to) return {};
	return { typeChanged: {
		from,
		to
	} };
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
* Insert `addition` at the end of the section introduced by `heading` (Markdown
* `#`/`##`… or wikitext `!`/`!!`…). Falls back to appending at the end of the
* document when the heading is not found. Used by tiddlywiki_append so an agent
* can add to one section of a long note without rewriting the whole file.
*/
function insertIntoSection(base, heading, addition) {
	const lines = base.split("\n");
	const headingText = (line) => {
		const md = /^#{1,6}\s+(.*)$/.exec(line);
		if (md !== null) return (md[1] ?? "").trim();
		const tw = /^!{1,6}\s*(.*)$/.exec(line);
		if (tw !== null) return (tw[1] ?? "").trim();
		return null;
	};
	const start = lines.findIndex((line) => headingText(line) === heading);
	if (start < 0) return base.trim().length === 0 ? addition : `${base.replace(/\s+$/, "")}\n\n${addition}`;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) if (headingText(lines[i] ?? "") !== null) {
		end = i;
		break;
	}
	const before = lines.slice(0, end).join("\n").replace(/\s+$/, "");
	const after = lines.slice(end).join("\n");
	const head = `${before}\n\n${addition}`;
	return after.trim().length === 0 ? head : `${head}\n\n${after.replace(/^\s+/, "")}`;
}
function registerTiddlywikiTools(ctx, deps) {
	const disposers = [];
	REGISTERED_TOOL_SUMMARY.length = 0;
	const register = (tool) => {
		const properties = tool.parameters.properties ?? {};
		const required = Array.isArray(tool.parameters.required) ? tool.parameters.required : [];
		REGISTERED_TOOL_SUMMARY.push({
			name: tool.name,
			params: Object.keys(properties).map((name) => ({
				name,
				required: required.includes(name)
			}))
		});
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
		description: "检索 TiddlyWiki 持久知识库：按关键词（可选 tags 数组 / since 修改时间 / type / field+value / limit）搜索非系统 tiddler，按相关度排序返回标题、标签、修改时间与命中处上下文片段。二进制 tiddler（图片等附件，正文为 base64）不参与检索。查询按空白切词、**所有词都必须命中**（AND）。若当前会话属于某个工作区，会**先在该工作区内检索、命中为空才自动扩大到全库**，回执会写明用了哪个范围。",
		parameters: {
			query: {
				type: "string",
				description: "搜索关键词（大小写不敏感，子串匹配；命中标题/标签/正文，标题命中权重最高）。多词按空白切分，**全部词都要命中**才算（AND）——例如「部署 步骤」只返回同时含这两词的笔记"
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
				description: "可选：精确 tiddler 类型。⚠️ 不传则不限类型（推荐）；插件默认把笔记写成 text/markdown，传 \"text/vnd.tiddlywiki\" 会把 Markdown 笔记全部排除"
			},
			field: {
				type: "string",
				description: "可选：按自定义字段过滤（如 \"q\"、\"clip-url\"、\"workspace\"）"
			},
			value: {
				type: "string",
				description: "可选：field 必须等于该值（不传则只要求该字段存在）"
			},
			limit: {
				type: "integer",
				description: "可选：返回条数上限（默认 30，最大 200）"
			}
		},
		output: { render: (_args, value) => {
			const filters = [];
			if (value.tags.length > 0) filters.push(`tags=${value.tags.join(",")}`);
			if (value.since !== null) filters.push(`since=${value.since}`);
			if (value.type !== null) filters.push(`type=${value.type}`);
			if (value.field !== null) filters.push(`field=${value.field}${value.value !== null ? `=${value.value}` : ""}`);
			let scope = "";
			if (value.workspace !== null && value.scope === "workspace") scope = ` · 已在工作区 ws/${value.workspace} 内缩小范围`;
			else if (value.workspace !== null && value.fellBack) scope = ` · 工作区 ws/${value.workspace} 内 0 条，已扩大到全库`;
			const lines = [`TiddlyWiki 搜索「${value.query}」${filters.length > 0 ? ` (${filters.join(" · ")})` : ""}：命中 ${value.total} 条${scope}（按相关度排序）。`];
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
		} },
		execute: async (args, exec) => {
			const wiki = requireWiki();
			const options = {
				tags: args.tags,
				tag: args.tag,
				since: args.since,
				type: args.type,
				field: args.field,
				value: args.value,
				limit: args.limit
			};
			const mark = (args.tags?.length ?? 0) > 0 || args.tag !== void 0 || args.field !== void 0 || args.value !== void 0 ? void 0 : workspaceMarkFor(deps, exec);
			let narrowed;
			if (mark !== void 0) narrowed = await wiki.search(args.query, {
				...options,
				tags: [mark.tag]
			});
			const usedWorkspace = narrowed !== void 0 && narrowed.total > 0;
			const { items, total } = usedWorkspace ? narrowed : await wiki.search(args.query, options);
			return {
				query: args.query,
				tags: args.tags ?? [],
				since: args.since ?? null,
				type: args.type ?? null,
				field: args.field ?? null,
				value: args.value ?? null,
				total,
				workspace: mark?.id ?? null,
				scope: usedWorkspace ? "workspace" : "all",
				fellBack: mark !== void 0 && !usedWorkspace,
				results: items.map((t) => ({
					title: t.title,
					tags: t.tags ?? [],
					modified: toIsoDateString(t.modified),
					snippet: snippetAround(t.text ?? "", args.query)
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
		output: { render: (_args, value) => {
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
		} },
		execute: async (args) => {
			const items = await requireWiki().recent(args.limit ?? 15, args.since);
			return {
				since: args.since ?? null,
				results: items.map((t) => ({
					title: t.title,
					tags: t.tags ?? [],
					modified: toIsoDateString(t.modified),
					snippet: snippetOf(t.text ?? "")
				}))
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_list_tags",
		description: "列出 TiddlyWiki 知识库现有的非系统标签及各自计数（按使用次数降序），方便决定给笔记打什么 tag。默认最多返回 200 个（`limit` 可调，上限 1000），被截断时结果里会带 total/truncated。",
		parameters: { limit: {
			type: "integer",
			description: "可选：最多返回多少个标签（按使用次数降序），默认 200，上限 1000。"
		} },
		output: { render: (_args, value) => {
			if (value.tags.length === 0) return [{
				type: "text",
				text: "知识库暂无标签。"
			}];
			const lines = [value.truncated ? `现有标签（共 ${value.total} 个，仅列出使用最多的 ${value.tags.length} 个，按使用次数降序）：` : `现有标签（${value.total} 个，按使用次数降序）：`];
			for (const t of value.tags) lines.push(`- ${t.tag} × ${t.count}`);
			if (value.truncated) lines.push(`（其余 ${value.total - value.tags.length} 个较少使用的标签未列出；需要时可提高 limit 重试）`);
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
		execute: async (args) => {
			const stats = await requireWiki().tagStats();
			const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.min(Math.floor(args.limit), 1e3)) : 200;
			const tags = stats.tags.slice(0, limit);
			return {
				count: tags.length,
				total: stats.total,
				truncated: tags.length < stats.total,
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
		output: { render: (_args, value) => {
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
		} },
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
				modified: toIsoDateString(t.modified)
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
		description: "写入（新建或覆盖）一个 TiddlyWiki tiddler。同名覆盖；**覆盖已有条目时，未传的 tags / 自定义字段 / 内容类型都会原样保留**（不会静默丢掉笔记原有的标签、字段或 type；显式传 tags 才整体替换标签）。写入后触发防抖自动 commit（默认 60s；手动同步用 tiddlywiki_git_sync）。新建（title 不存在）时自动补打 agent-written 标签标记「由 Agent 撰写」，无需手动添加；同时按当前会话工作目录自动打 `ws/<项目名>` 工作区标签与 `workspace` 字段（可用配置 `note.workspaceMark` 关闭；要归到别的项目就显式传 fields.workspace）。内容类型：**只有新建**条目且未指定时才默认 text/markdown（$:/ 系统条目除外）——覆盖 text/css、wikitext 等既有条目时保持原类型；要改类型用 fields 传 {\"type\":\"...\"}。⚠️ fields.type 是 TW 的内容类型保留字段，不要把业务分类值（如 \"meeting\"）写进去——业务分类请放 tags。",
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
				description: "附加自定义字段，如 {\"date\":\"2026-09-02\"}（可选）。fields.type 是**改内容类型的正规入口**（如 {\"type\":\"text/css\"}）：新建条目未指定时默认 text/markdown，覆盖既有条目时保留原类型。注意不要把业务分类值（如 \"meeting\"）写进 type——业务分类请放 tags"
			},
			expectedModified: {
				type: "string",
				description: "可选：乐观并发保护。传 tiddlywiki_get 读到的 modified 值，若该条目已被他人改动则拒绝写入（避免覆盖人类在 TW 编辑器里的修改）"
			},
			expectedRevision: {
				type: "integer",
				description: "可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision（刚写入、还没落盘的条目没有 modified，此时用 revision）"
			},
			force: {
				type: "boolean",
				description: "可选：true 时忽略 expectedModified/expectedRevision 强制覆盖（默认 false）"
			}
		},
		output: { render: (_args, value) => {
			const lines = [`已写入 tiddler「${value.title}」`];
			if (value.workspace !== void 0) lines.push(`已自动标记工作区: ws/${value.workspace}（字段 ${WORKSPACE_FIELD}）`);
			if (value.tags.length > 0) lines.push(`标签: ${value.tags.join(", ")}`);
			if (value.type !== null) lines.push(`类型: ${value.type}${value.typeDefaulted === true ? "（新建且未指定，已默认 markdown）" : ""}`);
			if (value.typeChanged !== void 0) lines.push(`⚠️ 内容类型已从 ${value.typeChanged.from} 改为 ${value.typeChanged.to}（覆盖前请确认这是你要的）`);
			if (value.fields !== null) {
				const entries = Object.entries(value.fields);
				if (entries.length > 0) lines.push(`字段: ${entries.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
			}
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
		execute: async (args, exec) => {
			const wiki = requireWiki();
			if (args.title.trim().length === 0) throw new Error("tiddlywiki_put: title 不能为空");
			const existing = await wiki.get(args.title);
			assertNoConflict(args.title, existing, {
				expectedModified: args.expectedModified,
				expectedRevision: args.expectedRevision,
				force: args.force
			});
			const tags = normalizeTagArg(args.tags);
			if (existing !== void 0 && isBinaryType(typeof existing.type === "string" ? existing.type : void 0)) {
				const wantedType = typeof args.fields?.type === "string" ? args.fields.type : void 0;
				if (!(args.force === true || wantedType !== void 0 && !isBinaryType(wantedType))) throw new Error(`tiddlywiki_put: 「${args.title}」是二进制附件（type=${String(existing.type)}，正文为 base64），直接写文本会把附件写坏。要替换附件请用 tiddlywiki_attach；确实要转成文本条目，请显式传 fields: {"type":"text/markdown"}（或 force: true）。`);
			}
			const marked = existing === void 0 && !args.title.startsWith("$:/") ? withWorkspaceMark(workspaceMarkFor(deps, exec), tags, args.fields) : {
				tags,
				fields: args.fields
			};
			const { tiddler, typeDefaulted } = buildWriteTiddler(args.title, args.text, {
				existing,
				tags: marked.tags,
				fields: marked.fields
			});
			await wiki.put(tiddler);
			deps.autoCommit();
			return {
				ok: true,
				title: args.title,
				tags: tiddler.tags ?? [],
				type: typeof tiddler.type === "string" ? tiddler.type : null,
				...typeDefaulted ? { typeDefaulted: true } : {},
				...typeChangeOf(existing, tiddler),
				fields: marked.fields ?? null,
				...marked.workspace !== void 0 ? { workspace: marked.workspace } : {}
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_batch_put",
		description: "批量写入/覆盖多个 TiddlyWiki tiddler（一次工具调用）。overwrite=false 时跳过已存在的标题；返回逐条结果（单条失败不影响其余条目，失败原因逐条列出）。写入后触发防抖自动 commit（默认 60s）。新建（title 不存在）的条目会自动补打 agent-written 标签与 `ws/<项目名>` 工作区标记，无需手动添加。内容类型：只有**新建**条目未指定 fields.type 时才默认 text/markdown（$:/ 系统条目除外）；**覆盖既有条目时保留其原有 type/tags/自定义字段**。",
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
							description: "标题（精确匹配，覆盖同名）"
						},
						text: {
							type: "string",
							description: "全文（默认按 Markdown 解析）"
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
		output: { render: (_args, value) => {
			const lines = [`批量写入完成：成功 ${value.written}，跳过 ${value.skipped}，失败 ${value.failed}，共 ${value.items.length} 条。`];
			for (const r of value.items) {
				const ws = r.workspace !== void 0 ? `（已标记工作区 ws/${r.workspace}）` : "";
				lines.push(`- ${r.title}：${r.written ? `已写入${ws}` : r.skipped ? "已跳过（存在）" : `失败（${r.error ?? "未知错误"}）`}`);
			}
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
		execute: async (args, exec) => {
			const wiki = requireWiki();
			const list = Array.isArray(args.items) ? args.items : [];
			if (list.length === 0) return {
				ok: true,
				written: 0,
				skipped: 0,
				failed: 0,
				items: []
			};
			const overwrite = args.overwrite !== false;
			const results = new Array(list.length);
			let written = 0;
			let skipped = 0;
			let failed = 0;
			const writeOne = async (item, index) => {
				const title = typeof item?.title === "string" ? item.title : "";
				try {
					if (title.length === 0) throw new Error("缺少非空 title");
					if (typeof item.text !== "string") throw new Error("缺少 text");
					const existing = await wiki.get(title);
					if (!overwrite && existing !== void 0) {
						skipped++;
						results[index] = {
							title,
							written: false,
							skipped: true,
							failed: false
						};
						return;
					}
					const marked = existing === void 0 && !title.startsWith("$:/") ? withWorkspaceMark(workspaceMarkFor(deps, exec), normalizeTagArg(item.tags), item.fields) : {
						tags: normalizeTagArg(item.tags),
						fields: item.fields
					};
					const { tiddler } = buildWriteTiddler(title, item.text, {
						existing,
						tags: marked.tags,
						fields: marked.fields
					});
					await wiki.put(tiddler);
					written++;
					results[index] = {
						title,
						written: true,
						skipped: false,
						failed: false,
						...marked.workspace !== void 0 ? { workspace: marked.workspace } : {}
					};
				} catch (err) {
					failed++;
					results[index] = {
						title: title.length > 0 ? title : "(无标题)",
						written: false,
						skipped: false,
						failed: true,
						error: err instanceof Error ? err.message : String(err)
					};
				}
			};
			const workers = Math.max(1, Math.min(4, list.length));
			let next = 0;
			await Promise.all(Array.from({ length: workers }, async () => {
				for (;;) {
					const index = next++;
					if (index >= list.length) return;
					await writeOne(list[index], index);
				}
			}));
			deps.autoCommit();
			return {
				ok: failed === 0,
				written,
				skipped,
				failed,
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
		output: { render: (_args, value) => {
			const lines = [`已重命名「${value.from}」→「${value.to}」`];
			lines.push(`更新了 ${value.refsUpdated} 处引用（${value.refsTiddlers} 个 tiddler）`);
			if (value.warning !== void 0) lines.push(`注意: ${value.warning}`);
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
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
						const { tiddler } = buildWriteTiddler(t.title, rewritten.text, { existing: t });
						await wiki.put(tiddler);
						refsUpdated += rewritten.count;
						refsTiddlers++;
					}
				}
			}
			const { tiddler: renamed } = buildWriteTiddler(newTitle, existing.text ?? "", { existing });
			await wiki.put(renamed);
			let deleteFailed;
			try {
				await wiki.delete(oldTitle);
			} catch (err) {
				deleteFailed = err instanceof Error ? err.message : String(err);
			}
			if (refsTiddlers === 0) warning = "未找到任何其他 tiddler 引用旧标题；如确实需要，可手动补充链接。";
			if (deleteFailed !== void 0) {
				const partial = `新标题「${newTitle}」已写入，但旧标题「${oldTitle}」删除失败（${deleteFailed}）：现在两个标题都存在同一份内容，请手动删除旧标题。`;
				warning = warning === void 0 ? partial : `${warning} ${partial}`;
			}
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
		description: "删除一个 TiddlyWiki tiddler（不存在时是幂等空操作）。默认是**软删除**：内容移入回收站（$:/dsh-tiddlywiki/trash/…，不再出现在检索/最近列表里）后删除原条目，可用 tiddlywiki_trash 恢复；permanent=true 才真正永久删除。删除后触发自动 commit。",
		parameters: {
			title: {
				type: "string",
				description: "tiddler 标题（精确匹配）",
				required: true
			},
			permanent: {
				type: "boolean",
				description: "可选：true = 永久删除（回收站也拿不回来，仅剩 git 历史）；默认 false = 移入回收站"
			},
			expectedModified: {
				type: "string",
				description: "可选：乐观并发保护。传 tiddlywiki_get 读到的 modified；若条目在你读取之后被改动（人类在 TW 编辑器里改过）则拒绝删除"
			},
			expectedRevision: {
				type: "integer",
				description: "可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision"
			},
			force: {
				type: "boolean",
				description: "可选：true 时忽略 expectedModified/expectedRevision 强制删除（默认 false）"
			}
		},
		output: { render: (_args, value) => [{
			type: "text",
			text: value.trashed === true ? `已把 tiddler「${value.title}」移入回收站（$:/dsh-tiddlywiki/trash/，可用 tiddlywiki_trash action=restore 恢复）。` : `已永久删除 tiddler「${value.title}」。`
		}] },
		execute: async (args) => {
			const wiki = requireWiki();
			const existing = await wiki.get(args.title);
			assertNoConflict(args.title, existing, {
				expectedModified: args.expectedModified,
				expectedRevision: args.expectedRevision,
				force: args.force
			});
			const canTrash = existing !== void 0 && args.permanent !== true && !args.title.startsWith("$:/dsh-tiddlywiki/trash/") && !args.title.startsWith("$:/");
			if (args.title === "$:/dsh-tiddlywiki/trash-index" && existing !== void 0) throw new Error(`tiddlywiki_delete: 「${TRASH_INDEX_TITLE}」是回收站索引，删掉它会让回收站里的条目全部变成不可恢复的孤儿（列不出、恢复不了、也清不掉）。要清空回收站请用 tiddlywiki_trash action=empty；确实要丢弃索引请显式传 permanent: true。`);
			if (!canTrash) {
				await wiki.delete(args.title);
				deps.autoCommit();
				return {
					ok: true,
					title: args.title,
					trashed: false
				};
			}
			const trashTitle = trashTitleFor(args.title);
			const at = (/* @__PURE__ */ new Date()).toISOString();
			const index = await readTrashIndex(wiki);
			if (!index.readOk || index.corrupted) throw new TrashIndexUnavailableError();
			const { tiddler: trashTiddler } = buildWriteTiddler(trashTitle, existing.text ?? "", { existing });
			trashTiddler.created = existing.created ?? trashTiddler.created;
			trashTiddler.modified = existing.modified ?? trashTiddler.modified;
			await wiki.put({
				...trashTiddler,
				"trash-of": args.title,
				"trash-at": at
			});
			await wiki.delete(args.title);
			index.entries.push({
				trash: trashTitle,
				of: args.title,
				at
			});
			await writeTrashIndex(wiki, index.entries);
			deps.autoCommit();
			return {
				ok: true,
				title: args.title,
				trashed: true,
				trashTitle
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_trash",
		description: "回收站（软删除的笔记）：action=list 列出、action=restore 恢复某条、action=empty 清空。配合 tiddlywiki_delete（默认软删除）使用。",
		parameters: {
			action: {
				type: "string",
				enum: [
					"list",
					"restore",
					"empty"
				],
				description: "list=列出回收站；restore=恢复（需 title）；empty=永久清空",
				required: true
			},
			title: {
				type: "string",
				description: "action=restore 时的原标题（也接受回收站标题）"
			},
			limit: {
				type: "integer",
				description: "action=list 的返回上限（默认 30，最大 200）"
			}
		},
		output: { render: (_args, value) => {
			const lines = [`回收站 ${value.action}：${value.message}`];
			for (const item of value.items ?? []) lines.push(`- ${item.title}（删除于 ${item.at ?? "?"}${item.of !== void 0 ? `，原名「${item.of}」` : ""}）`);
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
		execute: async (args) => {
			const wiki = requireWiki();
			const index = await readTrashIndex(wiki);
			if (!index.readOk) throw new TrashIndexUnavailableError();
			if (index.corrupted) throw new Error("回收站索引已损坏（JSON 解析失败），本次操作已中止以免误删记录；可手动检查 $:/dsh-tiddlywiki/trash-index 后重试。");
			const indexed = index.entries;
			if (args.action === "list") {
				const limit = Math.max(1, Math.min(args.limit ?? 30, 200));
				return {
					action: "list",
					message: `共 ${indexed.length} 条`,
					items: indexed.slice(-limit).reverse().map((entry) => ({
						title: entry.trash,
						at: entry.at,
						of: entry.of
					}))
				};
			}
			if (args.action === "empty") {
				for (const entry of indexed) await wiki.delete(entry.trash);
				await writeTrashIndex(wiki, []);
				deps.autoCommit();
				return {
					action: "empty",
					message: `已清空 ${indexed.length} 条`
				};
			}
			const wanted = typeof args.title === "string" ? args.title.trim() : "";
			if (wanted.length === 0) throw new Error("tiddlywiki_trash: action=restore 需要 title");
			const match = indexed.slice().reverse().find((entry) => entry.of === wanted || entry.trash === wanted);
			if (match === void 0) throw new Error(`回收站里没有「${wanted}」`);
			const stored = await wiki.get(match.trash);
			if (stored === void 0) {
				await writeTrashIndex(wiki, indexed.filter((entry) => entry.trash !== match.trash));
				throw new Error(`回收站条目「${match.trash}」已不存在（索引已清理）`);
			}
			if (await wiki.get(match.of) !== void 0) throw new Error(`无法恢复：标题「${match.of}」已被占用，请先处理现有条目`);
			const { tiddler: restored } = buildWriteTiddler(match.of, stored.text ?? "", { existing: stored });
			restored.created = stored.created ?? restored.created;
			restored.modified = stored.modified ?? restored.modified;
			delete restored["trash-of"];
			delete restored["trash-at"];
			await wiki.put(restored);
			await wiki.delete(match.trash);
			await writeTrashIndex(wiki, indexed.filter((entry) => entry.trash !== match.trash));
			deps.autoCommit();
			return {
				action: "restore",
				message: `已恢复「${match.of}」`,
				items: []
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_append",
		description: "向已有 tiddler 追加/前插文本，或写入指定标题段落的末尾（无需先读全文、不会整篇覆盖）——适合日志、批注、清单的增量写入。条目不存在时默认新建（createIfMissing=false 则报错）。**写入既有条目走与 tiddlywiki_put 同一套写策略**：原有 tags、自定义字段与**内容类型**全部保留（不会把 Markdown 笔记改成 wikitext、也不会把 CSS 改成 Markdown）；可用 fields 显式覆盖字段/类型。新建条目未指定内容类型时才默认 text/markdown（并像 tiddlywiki_put 一样自动补 agent-written 与 `ws/<项目名>` 工作区标记）。",
		parameters: {
			title: {
				type: "string",
				description: "tiddler 标题",
				required: true
			},
			text: {
				type: "string",
				description: "要追加/前插的文本（默认按 Markdown 写；既有条目保持它自己的内容类型）",
				required: true
			},
			mode: {
				type: "string",
				enum: ["append", "prepend"],
				description: "可选：append（默认，追加到末尾）/ prepend（插到开头）"
			},
			heading: {
				type: "string",
				description: "可选：append 时改为插入到该标题（Markdown # 或 wikitext ! 标题，按标题文本匹配）对应段落的末尾"
			},
			createIfMissing: {
				type: "boolean",
				description: "可选：条目不存在时是否新建（默认 true）"
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "可选：标签（不传则保留既有条目的原标签；新建条目会额外自动补 agent-written）"
			},
			fields: {
				type: "json",
				description: "可选：显式覆盖的自定义字段（如 {\"type\":\"text/css\"}）。不传则保留既有条目的原字段与内容类型"
			}
		},
		output: { render: (_args, value) => {
			const lines = [`${value.created ? "已新建并写入" : "已增量写入"} tiddler「${value.title}」（${value.mode}${value.heading !== null ? ` · 段落「${value.heading}」` : ""}）：新增 ${value.added} 字符，现共 ${value.total} 字符。`];
			if (value.type !== null) lines.push(`类型: ${value.type}${value.typeDefaulted === true ? "（新建且未指定，已默认 markdown）" : ""}`);
			if (value.typeChanged !== void 0) lines.push(`⚠️ 内容类型已从 ${value.typeChanged.from} 改为 ${value.typeChanged.to}`);
			if (value.workspace !== void 0) lines.push(`已自动标记工作区: ws/${value.workspace}（字段 ${WORKSPACE_FIELD}）`);
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
		execute: async (args, exec) => {
			const wiki = requireWiki();
			const title = args.title.trim();
			if (title.length === 0) throw new Error("tiddlywiki_append: title 不能为空");
			const existing = await wiki.get(title);
			if (existing === void 0 && args.createIfMissing === false) throw new Error(`tiddler「${title}」不存在（createIfMissing=false）`);
			const mode = args.mode === "prepend" ? "prepend" : "append";
			const base = existing?.text ?? "";
			const addition = args.text;
			let next;
			if (mode === "append" && typeof args.heading === "string" && args.heading.trim().length > 0) next = insertIntoSection(base, args.heading.trim(), addition);
			else if (mode === "prepend") next = base.trim().length === 0 ? addition : `${addition}\n\n${base}`;
			else next = base.trim().length === 0 ? addition : `${base.replace(/\s+$/, "")}\n\n${addition}`;
			const appendMarked = existing === void 0 && !title.startsWith("$:/") ? withWorkspaceMark(workspaceMarkFor(deps, exec), normalizeTagArg(args.tags), args.fields) : {
				tags: normalizeTagArg(args.tags),
				fields: args.fields
			};
			const { tiddler, typeDefaulted } = buildWriteTiddler(title, next, {
				existing,
				tags: appendMarked.tags,
				fields: appendMarked.fields
			});
			await wiki.put(tiddler);
			deps.autoCommit();
			return {
				ok: true,
				title,
				mode,
				heading: mode === "append" && typeof args.heading === "string" && args.heading.trim().length > 0 ? args.heading.trim() : null,
				created: existing === void 0,
				added: addition.length,
				total: next.length,
				type: typeof tiddler.type === "string" ? tiddler.type : null,
				...appendMarked.workspace !== void 0 ? { workspace: appendMarked.workspace } : {},
				...typeDefaulted ? { typeDefaulted: true } : {},
				...typeChangeOf(existing, tiddler)
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_backlinks",
		description: "查反向链接：哪些笔记引用了目标 tiddler（[[标题]] / [[显示|标题]] / {{标题}}），以及哪些笔记把它当作标签。用于知识图谱导航、改动前评估影响面。",
		parameters: {
			title: {
				type: "string",
				description: "目标 tiddler 标题",
				required: true
			},
			includeTags: {
				type: "boolean",
				description: "可选：是否把「以该标题为标签」的笔记也算作反向链接（默认 true）"
			},
			limit: {
				type: "integer",
				description: "可选：最多返回多少条（默认 30，最大 200）"
			}
		},
		output: { render: (_args, value) => {
			const lines = [`「${value.title}」的反向链接：${value.total} 条（引用 ${value.linkCount} · 标签 ${value.tagCount}）`];
			if (value.items.length === 0) lines.push("没有任何笔记引用它。");
			for (const item of value.items) lines.push(`- ${item.title}（${item.via === "tag" ? "标签" : `${item.refs} 处引用`}）`);
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
		execute: async (args) => {
			const wiki = requireWiki();
			const target = args.title.trim();
			if (target.length === 0) throw new Error("tiddlywiki_backlinks: title 不能为空");
			const includeTags = args.includeTags !== false;
			const limit = Math.max(1, Math.min(args.limit ?? 30, 200));
			const items = await wiki.list(void 0, true);
			const hits = [];
			let linkCount = 0;
			let tagCount = 0;
			for (const t of items) {
				if (t.title === target || t.title.startsWith("$:/")) continue;
				const refs = countRefsTo(t.text ?? "", target);
				const tagged = includeTags && (t.tags ?? []).includes(target);
				if (refs === 0 && !tagged) continue;
				if (refs > 0) linkCount++;
				if (tagged) tagCount++;
				hits.push({
					title: t.title,
					refs,
					via: refs > 0 ? "link" : "tag",
					modified: toIsoDateString(t.modified)
				});
			}
			hits.sort((a, b) => b.refs - a.refs || a.title.localeCompare(b.title, "zh"));
			return {
				title: target,
				total: hits.length,
				linkCount,
				tagCount,
				items: hits.slice(0, limit)
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_attach",
		description: "把一个本机文件或公网 http(s) 地址存成 wiki 的二进制附件 tiddler（图片 / PDF / 压缩包等，type + base64 正文，随 wiki 进 git）。可选把附件嵌入/链接进某篇笔记。这是 agent 唯一能写入二进制附件的途径。",
		parameters: {
			title: {
				type: "string",
				description: "附件 tiddler 标题（同时决定其在 wiki 里的名字）",
				required: true
			},
			path: {
				type: "string",
				description: "本机绝对路径（与 url 二选一）"
			},
			url: {
				type: "string",
				description: "公网 http(s) 地址（与 path 二选一；含 SSRF 守卫，拒绝内网/回环地址）"
			},
			tags: {
				type: "array",
				items: { type: "string" },
				description: "可选：附件标签"
			},
			noteTitle: {
				type: "string",
				description: "可选：把该附件嵌入到这篇笔记末尾（图片用 [img[标题]]，其它用 [[标题]] 链接）"
			},
			expectedModified: {
				type: "string",
				description: "可选：乐观并发保护，仅在同名 tiddler 已存在时有意义（传 tiddlywiki_get 读到的 modified）"
			},
			expectedRevision: {
				type: "integer",
				description: "可选：乐观并发保护的另一种令牌——传 tiddlywiki_get 返回字段里的 revision"
			},
			force: {
				type: "boolean",
				description: "可选：true 时忽略 expectedModified/expectedRevision，允许覆盖同名 tiddler（默认 false；即便覆盖也会保留其 tags 与自定义字段）"
			}
		},
		output: { render: (_args, value) => {
			const lines = [`已保存附件「${value.title}」（${value.mime}，${value.bytes} 字节，base64 约 ${value.chars} 字符）`];
			if (value.source !== null) lines.push(`来源: ${value.source}`);
			if (value.embedInto !== null) lines.push(`已嵌入笔记「${value.embedInto}」`);
			lines.push(`打开: [${value.title}](/dsh-tiddlywiki/tw/#${encodeURIComponent(value.title)})`);
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
		execute: async (args) => {
			const wiki = requireWiki();
			const title = args.title.trim();
			if (title.length === 0) throw new Error("tiddlywiki_attach: title 不能为空");
			const hasPath = typeof args.path === "string" && args.path.trim().length > 0;
			if (hasPath === (typeof args.url === "string" && args.url.trim().length > 0)) throw new Error("tiddlywiki_attach: path 与 url 必须且只能提供一个");
			let buffer;
			let mime;
			let source;
			if (hasPath) {
				const filePath = args.path.trim();
				if (!isAbsolute(filePath)) throw new Error("tiddlywiki_attach: path 必须是绝对路径");
				const info = await stat(filePath);
				if (!info.isFile()) throw new Error(`tiddlywiki_attach: ${basename(filePath)} 不是普通文件`);
				if (info.size > 15728640) throw new Error(`tiddlywiki_attach: 文件超过 ${Math.floor(MAX_ATTACH_BYTES / 1024 / 1024)}MB 上限`);
				buffer = await readFile(filePath);
				const ext = extname(filePath).slice(1).toLowerCase();
				mime = ATTACH_MIME_BY_EXT[ext] ?? "application/octet-stream";
				source = filePath;
			} else {
				const imageUrl = args.url.trim();
				const downloaded = await downloadClipImage(imageUrl, "");
				buffer = downloaded.buffer;
				const ext = extname(new URL(imageUrl).pathname).slice(1).toLowerCase();
				mime = downloaded.type?.split(";")[0]?.trim() || ATTACH_MIME_BY_EXT[ext] || "application/octet-stream";
				source = imageUrl;
			}
			if (buffer.length === 0) throw new Error("tiddlywiki_attach: 内容为空");
			if (buffer.length > 15728640) throw new Error(`tiddlywiki_attach: 内容超过 ${Math.floor(MAX_ATTACH_BYTES / 1024 / 1024)}MB 上限`);
			const existing = await wiki.get(title);
			assertNoConflict(title, existing, {
				expectedModified: args.expectedModified,
				expectedRevision: args.expectedRevision,
				force: args.force
			});
			if (existing !== void 0 && args.force !== true) throw new Error(`tiddlywiki_attach: 标题「${title}」已存在（type=${typeof existing.type === "string" ? existing.type : "?"}）。为避免静默覆盖既有笔记，请换一个附件标题；确认要覆盖时传 force: true（tags 与自定义字段仍会保留）。`);
			const explicitTags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === "string" && t.trim().length > 0) : void 0;
			const { tiddler } = buildWriteTiddler(title, buffer.toString("base64"), {
				existing,
				...explicitTags !== void 0 && explicitTags.length > 0 ? { tags: explicitTags } : {},
				fields: {
					type: mime,
					"attach-source": source,
					"attach-at": (/* @__PURE__ */ new Date()).toISOString()
				}
			});
			await wiki.put(tiddler);
			let embedInto = null;
			if (typeof args.noteTitle === "string" && args.noteTitle.trim().length > 0) {
				embedInto = args.noteTitle.trim();
				const note = await wiki.get(embedInto);
				const safeTitle = title.replace(/\]\]/g, "] ]");
				const embed = mime.startsWith("image/") ? `[img[${safeTitle}]]` : `[[${safeTitle}]]`;
				const text = note === void 0 ? embed : `${(note.text ?? "").replace(/\s+$/, "")}\n\n${embed}`;
				const { tiddler: noteTiddler } = buildWriteTiddler(embedInto, text, { existing: note });
				await wiki.put(noteTiddler);
			}
			deps.autoCommit();
			return {
				ok: true,
				title,
				mime,
				bytes: buffer.length,
				chars: buffer.toString("base64").length,
				source,
				embedInto
			};
		}
	}));
	register(defineTool({
		name: "tiddlywiki_lint",
		description: "知识库体检（**只读，绝不改动任何笔记**）：找出垃圾/异常标签、指向不存在条目的死链、空笔记、疑似 Markdown 却缺 type 的笔记，以及**时效性内容**（已过期 / 待复查 / 建议复查的候选）。返回按类别分组的问题清单与建议；淘汰与否完全由你决定。",
		parameters: {
			limit: {
				type: "integer",
				description: "可选：每类最多返回多少条示例（默认 10，最大 100）"
			},
			checks: {
				type: "array",
				items: { type: "string" },
				description: "可选：只跑指定检查（junk-tags / broken-links / empty-notes / missing-type / stale）"
			},
			staleAfterDays: {
				type: "integer",
				description: "可选：`stale` 检查里「长期未改动」的阈值天数（默认 180）。只影响候选的判定，不影响 valid-until / review-after 的硬判定"
			}
		},
		output: { render: (_args, value) => {
			const lines = [`知识库体检：扫描 ${value.scanned} 条文本笔记，发现 ${value.issues.reduce((sum, i) => sum + i.count, 0)} 个问题。`];
			if (value.issues.length === 0) lines.push("没有发现问题。");
			for (const issue of value.issues) {
				lines.push(`- ${issue.kind}：${issue.count} 处 — ${issue.hint}`);
				for (const sample of issue.samples) lines.push(`    · ${sample}`);
			}
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
		execute: async (args) => {
			const wiki = requireWiki();
			const limit = Math.max(1, Math.min(args.limit ?? 10, 100));
			const wanted = Array.isArray(args.checks) && args.checks.length > 0 ? new Set(args.checks) : void 0;
			const want = (kind) => wanted === void 0 || wanted.has(kind);
			const items = await wiki.list(void 0, true);
			const titles = want("broken-links") ? new Set((await wiki.list()).map((t) => t.title)) : new Set(items.map((t) => t.title));
			const typelessTitles = want("missing-type") ? new Set((await wiki.list(MISSING_TYPE_FILTER)).map((t) => t.title)) : /* @__PURE__ */ new Set();
			const issues = [];
			if (want("junk-tags")) {
				const samples = [];
				let count = 0;
				for (const t of items) for (const tag of t.tags ?? []) {
					if (!isJunkTag(tag)) continue;
					count++;
					if (samples.length < limit) samples.push(`「${t.title}」的标签「${tag}」`);
				}
				if (count > 0) issues.push({
					kind: "junk-tags",
					count,
					hint: "明显是写入事故产生的标签（如筛选器错误文本）；用 tiddlywiki_put 重写该条目的 tags 清理",
					samples
				});
			}
			if (want("broken-links")) {
				const samples = [];
				let count = 0;
				const linkRe = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|(?<!\{)\{\{(?!\{)([^}]+)\}\}/g;
				for (const t of items) {
					const text = t.text ?? "";
					let match;
					while ((match = linkRe.exec(text)) !== null) {
						const target = (match[3] ?? match[2] ?? match[1] ?? "").trim();
						if (target.length === 0 || target.startsWith("$:/") || /^(https?|mailto|file):/.test(target)) continue;
						if (target.includes("$") || target.includes("<")) continue;
						if (target.startsWith("{")) continue;
						if (titles.has(target)) continue;
						count++;
						if (samples.length < limit) samples.push(`「${t.title}」→「${target}」`);
					}
				}
				if (count > 0) issues.push({
					kind: "broken-links",
					count,
					hint: "被引用条目标题不存在；确认是笔误还是应新建该条目",
					samples
				});
			}
			if (want("empty-notes")) {
				const samples = [];
				let count = 0;
				for (const t of items) {
					if (t.title.startsWith("$:/")) continue;
					if (isBinaryType(typeof t.type === "string" ? t.type : void 0)) continue;
					if ((t.text ?? "").trim().length === 0) {
						count++;
						if (samples.length < limit) samples.push(`「${t.title}」`);
					}
				}
				if (count > 0) issues.push({
					kind: "empty-notes",
					count,
					hint: "正文为空的笔记；补内容或删除",
					samples
				});
			}
			if (want("missing-type")) {
				const samples = [];
				let count = 0;
				for (const t of items) {
					if (t.title.startsWith("$:/")) continue;
					if (!typelessTitles.has(t.title)) continue;
					const text = t.text ?? "";
					if (/^#{1,6}\s|\n#{1,6}\s|^\s*[-*]\s|\*\*[^*]+\*\*/m.test(text)) {
						count++;
						if (samples.length < limit) samples.push(`「${t.title}」（无 type 字段，当前按 wikitext 渲染）`);
					}
				}
				if (count > 0) issues.push({
					kind: "missing-type",
					count,
					hint: "正文像 Markdown 但条目没有 type 字段，TW 会按 wikitext 渲染；用 tiddlywiki_put 的 fields.type 明确内容类型",
					samples
				});
			}
			if (want("stale")) {
				const now = Date.now();
				const staleAfterDays = Math.max(1, Math.min(args.staleAfterDays ?? 180, 3650));
				const staleAfterMs = staleAfterDays * 24 * 60 * 60 * 1e3;
				const expired = [];
				const review = [];
				const candidates = [];
				let expiredCount = 0;
				let reviewCount = 0;
				let candidateCount = 0;
				for (const t of items) {
					if (t.title.startsWith("$:/")) continue;
					const validUntil = typeof t["valid-until"] === "string" ? parseTiddlerDate(t["valid-until"]) : void 0;
					if (validUntil !== void 0 && validUntil < now) {
						expiredCount++;
						if (expired.length < limit) expired.push(`「${t.title}」（valid-until 已过）`);
					}
					const reviewAfter = typeof t["review-after"] === "string" ? parseTiddlerDate(t["review-after"]) : void 0;
					if (reviewAfter !== void 0 && reviewAfter < now) {
						reviewCount++;
						if (review.length < limit) review.push(`「${t.title}」（review-after 已到）`);
					}
					if (validUntil !== void 0 || reviewAfter !== void 0) continue;
					const modified = parseTiddlerDate(t.modified);
					if (!(modified === void 0 || now - modified > staleAfterMs)) continue;
					const tags = t.tags ?? [];
					const versionTag = tags.find((tag) => /^v?\d+\.\d+(\.\d+)?$/.test(tag.trim()));
					const doneTag = tags.some((tag) => tag.trim() === "done");
					if (versionTag !== void 0 || doneTag) {
						candidateCount++;
						if (candidates.length < limit) candidates.push(`「${t.title}」（${versionTag !== void 0 ? `版本标签 ${versionTag}` : "done 标签"}，${staleAfterDays} 天未改动）`);
					}
				}
				if (expiredCount > 0) issues.push({
					kind: "stale-expired",
					count: expiredCount,
					hint: "`valid-until` 已过期——内容按声明已失效。建议：确认后改成新内容、或打 归档 / superseded 标签、或（确认无用再）tiddlywiki_delete（默认进回收站，可恢复）",
					samples: expired
				});
				if (reviewCount > 0) issues.push({
					kind: "stale-review",
					count: reviewCount,
					hint: "`review-after` 到期——该复查是否仍然适用。建议：复查后更新 `review-after`，或把结论写进正文",
					samples: review
				});
				if (candidateCount > 0) issues.push({
					kind: "stale-candidates",
					count: candidateCount,
					hint: `**候选，非判定**：带版本号或 done 标签且 ${staleAfterDays} 天未改动，值得人工扫一眼。建议：确认过期的加 valid-until / superseded-by 字段或归档标签；仍有效的更新一下 modified 即可`,
					samples: candidates
				});
			}
			return {
				scanned: items.length,
				issues
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
		output: { render: (_args, value) => renderSync(value) },
		execute: async (args) => {
			const dir = deps.wikiPath();
			/** Restart TW after a pull that changed the tree (stale snapshot drop). */
			const restartIfChanged = async (pulled) => {
				if (pulled.changed !== true || deps.restartWiki === void 0) return {};
				try {
					await flushPendingWrites(requireWiki(), join(dir, "tiddlers")).catch(() => void 0);
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
					let committed;
					try {
						committed = await deps.git.commit(dir, args.message ?? `sync ${(/* @__PURE__ */ new Date()).toISOString()}`);
					} catch (err) {
						if (err instanceof GitConflictStateError) return {
							action: args.action,
							ok: false,
							message: err.message,
							conflictFiles: err.files,
							...restart
						};
						throw err;
					}
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
		output: { render: (_args, value) => {
			const lines = [`git resolve ${value.action}: ${value.ok ? "成功" : "失败"}`];
			lines.push(`  ${value.message}`);
			if (value.files !== void 0 && value.files.length > 0) lines.push(`涉及文件: ${value.files.join(", ")}`);
			if (value.commit !== void 0) lines.push(`本地 commit: ${value.commit}`);
			if (value.status !== void 0) lines.push(`状态: ${gitStatusBits(value.status)}`);
			return [{
				type: "text",
				text: lines.join("\n")
			}];
		} },
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
			let committed;
			try {
				committed = await deps.git.commit(dir, `resolve conflict (keep remote) ${(/* @__PURE__ */ new Date()).toISOString()}`);
			} catch (err) {
				if (err instanceof GitConflictStateError) return {
					ok: false,
					action: "keep-remote",
					message: err.message,
					files: err.files
				};
				throw err;
			}
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
//#region src/host/wiki-location.ts
/**
* Where the wiki lives (v0.22.0 runtime switching).
*
* WHY A FILE OUTSIDE THE WIKI
* ---------------------------
* The settings page stores its overrides in the wiki itself
* (`$:/plugins/dsh-tiddlywiki/config`). "Which wiki am I?" cannot live there:
* switching to another wiki would take the setting with it (the new wiki would
* read its own config tiddler and forget the choice). The active location is
* therefore a small pointer file under the DSH home, outside every wiki:
*
*     $DSH_HOME/dsh-tiddlywiki/location.json
*     { "version": 1, "active": { "root": "D:/notes", "name": "main" } }
*
* PRECEDENCE (see `resolveWikiLocation()` in src/index.ts):
*     state file  >  cordis `config:` block  >  $DSH_HOME/tiddlywiki + "main"
*
* The cordis block keeps acting as the *default* — 「恢复为配置默认」 simply
* deletes the pointer file. A malformed pointer is reported (never silently
* acted upon) and falls back to the default, so a hand-edited JSON cannot make
* the plugin boot somewhere unexpected.
*
* @module dsh-tiddlywiki/host/wiki-location
*/
/** Pointer file schema version (bumped only on an incompatible change). */
const LOCATION_STATE_VERSION = 1;
/** Default pointer file: `$DSH_HOME/dsh-tiddlywiki/location.json`. */
function defaultLocationStateFile() {
	return dshHomePath("dsh-tiddlywiki", "location.json");
}
/**
* Expand `$VAR` / `${VAR}` / `%VAR%` from process.env (config uses `$DSH_HOME`).
* Moved here (v0.22.0) so both `resolveWikiRoot()` and the location module
* expand user input identically — the settings page accepts the same syntax as
* the cordis config block.
*/
function expandEnvPath(input, env = process.env) {
	return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => env[name] ?? "").replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => env[name] ?? "").replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, name) => env[name] ?? "");
}
/**
* Normalise + validate a candidate location.
*
* `root` must be ABSOLUTE (a relative root would resolve against the dsh web
* process cwd, i.e. "wherever it happened to be launched from" — the docs say
* so, and now the code refuses to store it). `name` is a single folder name;
* `.` means "the root folder itself".
*/
function normalizeLocation(input) {
	const rawRoot = typeof input.root === "string" ? input.root.trim() : "";
	if (rawRoot.length === 0) return { error: "路径不能为空" };
	const root = expandEnvPath(rawRoot);
	if (root.includes("\0")) return { error: "路径含非法字符" };
	if (!isAbsolute(root)) return { error: `请使用绝对路径（当前：${root}）——相对路径会按 dsh web 的启动目录解析` };
	const rawName = typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim() : "main";
	if (rawName !== "." && (rawName.includes("/") || rawName.includes("\\") || rawName === ".." || isAbsolute(rawName))) return { error: `文件夹名不能包含路径分隔符（当前：${rawName}）` };
	return { location: {
		root: resolve(root),
		name: rawName
	} };
}
/** Absolute folder a location points at. */
function locationPath(location) {
	return resolve(location.root, location.name);
}
/** Read the pointer file. Missing → `{}`; malformed → `{ error }` (never throws). */
async function readLocationState(file = defaultLocationStateFile()) {
	let raw;
	try {
		raw = await readFile(file, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return {};
		return { error: `位置指针文件读不到（${file}）：${err instanceof Error ? err.message : String(err)}` };
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: `位置指针文件不是合法 JSON（${file}）——已回退到配置默认值` };
	}
	if (typeof parsed !== "object" || parsed === null) return { error: `位置指针文件格式不对（${file}）` };
	const active = parsed.active;
	if (typeof active !== "object" || active === null) return { error: `位置指针文件缺少 active 字段（${file}）` };
	const normalized = normalizeLocation(active);
	if (normalized.location === void 0) return { error: `位置指针内容非法（${normalized.error ?? "未知原因"}）——已回退到配置默认值` };
	return { active: normalized.location };
}
/** Write the pointer file atomically (tmp + rename, mkdir -p). */
async function writeLocationState(location, file = defaultLocationStateFile()) {
	const payload = JSON.stringify({
		version: 1,
		active: location,
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	}, null, 2);
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	await writeFile(tmp, payload, "utf8");
	await rename(tmp, file);
}
/** Delete the pointer file (「恢复为配置默认」). Missing file is a no-op. */
async function clearLocationState(file = defaultLocationStateFile()) {
	await rm(file, { force: true });
}
/**
* Folders under `root` that look like a TiddlyWiki server wiki (they contain
* `tiddlywiki.info`), for the settings-page picker. `root` itself is reported
* as `"."` when it is a wiki. Bounded: an unreadable/short directory is not an
* error — the picker is a convenience, never a requirement.
*/
async function listWikiCandidates(root, limit = 30) {
	const names = [];
	try {
		if (!(await stat(root)).isDirectory()) return names;
		try {
			await stat(join(root, "tiddlywiki.info"));
			names.push(".");
		} catch {}
		const entries = await readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			if (names.length >= limit) break;
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			try {
				await stat(join(root, entry.name, "tiddlywiki.info"));
				names.push(entry.name);
			} catch {}
		}
	} catch {}
	return names.sort((a, b) => a.localeCompare(b));
}
//#endregion
//#region src/host/wiki-switch.ts
/**
* Runtime wiki switching (v0.22.0).
*
* Rebinding the plugin from wiki A to wiki B is a *stateful* operation: the TW
* child, the auto-committer, the fs watcher and the config-tiddler overlay all
* hold the old folder. Doing it half-way leaves the process describing two
* different wikis, so the sequence below is deliberately boring:
*
*   stop child → release extras → repoint → start child → reload config
*   → core-bootstrap the new wiki → re-arm extras → persist the pointer
*
* The pointer is written LAST: if any earlier step fails we roll the server
* back to the old folder and the on-disk pointer still names the working wiki,
* so a dsh web restart can never land on a half-initialised target.
*
* The orchestration is separated from src/index.ts so it can be driven by a
* real test (scripts/verify-wiki-switch.mjs) with a real WikiServer and two
* temp folders — the rollback path is the part that must not rot.
*
* @module dsh-tiddlywiki/host/wiki-switch
*/
/**
* Switch to `input` (root + folder name, same shape as the cordis config).
* Never throws: failures are returned, and the previous wiki is restored.
*/
async function switchWiki(deps, input) {
	const normalized = normalizeLocation(input);
	if (normalized.location === void 0) return {
		ok: false,
		error: normalized.error ?? "位置非法",
		rolledBack: true
	};
	const target = normalized.location;
	const targetPath = locationPath(target);
	const previous = deps.currentLocation();
	const previousPath = deps.currentPath();
	if (targetPath === previousPath) return {
		ok: true,
		location: target,
		path: targetPath
	};
	const restore = async () => {
		try {
			await deps.stopServer();
			deps.applyLocation(previous ?? {
				root: previousPath,
				name: "."
			});
			await deps.startServer();
			await deps.reloadConfig();
			deps.log?.(`wiki switch rolled back to ${previousPath}`);
			return true;
		} catch (err) {
			deps.log?.(`wiki switch rollback FAILED: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		} finally {
			try {
				deps.setupExtras();
			} catch (err) {
				deps.log?.(`wiki switch rollback: re-arming extras failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
	try {
		await deps.stopServer();
		await deps.teardownExtras();
		deps.applyLocation(target);
		await deps.startServer();
		await deps.reloadConfig();
		await deps.bootstrap();
		deps.setupExtras();
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			rolledBack: await restore()
		};
	}
	try {
		await deps.savePointer(target);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		deps.log?.(`wiki switch: pointer write failed: ${message}`);
		return {
			ok: true,
			location: target,
			path: targetPath,
			warning: `位置已切换，但指针文件写入失败（重启 dsh web 后会回到原知识库）：${message}`
		};
	}
	return {
		ok: true,
		location: target,
		path: targetPath
	};
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
/**
* Official plugin whose parser every note this plugin writes depends on
* (`text/markdown`). `--init server` does NOT include it — see ensurePlugin().
*/
const MARKDOWN_PLUGIN = "tiddlywiki/markdown";
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
	note: {
		tag: "inbox",
		workspaceMark: true
	},
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
		sendToAgent: { enabled: true },
		allArticles: { pageSize: 10 }
	},
	startup: { readyTimeoutMs: READY_TIMEOUT_DEFAULT_MS },
	wechat: {
		enabled: false,
		command: "opencli",
		token: "",
		adapter: "publish-note",
		dsn: ""
	},
	uiLanguage: "",
	auth: {
		username: "",
		password: ""
	}
};
/**
* Resolve the DEFAULT wikiRoot: explicit config (env-expanded) else
* $DSH_HOME/tiddlywiki. The runtime pointer file can override it — see
* `readLocationState()` in host/wiki-location.ts.
*/
function resolveWikiRoot(config) {
	if (config.wikiRoot !== void 0 && config.wikiRoot.trim().length > 0) return expandEnvPath(config.wikiRoot.trim());
	return dshHomePath("tiddlywiki");
}
/**
* Ensure the wiki's `.gitignore` covers TW's transient artifacts, WITHOUT
* clobbering rules the user added.
*
* This used to rewrite the whole file on every start, silently deleting any
* custom ignore rules the user had put in `wiki/.gitignore`. Now the file is
* only touched when one of the managed lines is missing, and the user's own
* content is preserved verbatim.
*/
const MANAGED_GITIGNORE_LINES = [
	"tiddlers/$__temp_*",
	"tiddlers/$__StoryList*",
	"tiddlers/$__HistoryList*",
	"*.meta.tmp",
	"tiddlers/$__plugins_dsh-tiddlywiki_flush-probe.tid",
	"tiddlers/$__plugins_dsh-tiddlywiki_flush-probe.txt",
	"tiddlers/$__plugins_dsh-tiddlywiki_flush-probe.txt.meta"
];
async function writeGitignore(wikiPath) {
	const file = join(wikiPath, ".gitignore");
	let current = "";
	try {
		current = await readFile(file, "utf8");
	} catch {}
	const existing = current.split(/\r?\n/).map((line) => line.trim());
	const missing = MANAGED_GITIGNORE_LINES.filter((line) => !existing.includes(line));
	if (missing.length === 0) return;
	const block = [
		"# TiddlyWiki transient artifacts (auto-managed by dsh-tiddlywiki)",
		...missing,
		""
	].join("\n");
	await writeFile(file, `${current.length === 0 ? "" : current.endsWith("\n") ? `${current}\n` : `${current}\n\n`}${block}`, "utf8");
}
/** Watch the wiki folders and touch the auto-committer on changes. */
function watchWiki(wikiPath, onChange) {
	const watchers = [];
	for (const dir of [join(wikiPath, "tiddlers"), wikiPath]) try {
		const watcher = watch(dir, { persistent: false }, () => onChange());
		watcher.on("error", (err) => {
			console.warn("[dsh-tiddlywiki] wiki watcher error (auto-commit still runs on our own writes):", err.message);
		});
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
*
* The implementation lives in host/seeds.ts (shared with the settings page's
* seed-run route), which is where `waitForFileWrite` is imported from.
*/
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
		},
		startup: {
			...DEFAULTS.startup,
			...rawConfig.startup ?? {}
		},
		wechat: {
			...DEFAULTS.wechat,
			...rawConfig.wechat ?? {}
		}
	};
	let wikiPath = join(config.wikiRoot, config.wiki);
	/** Pointer file the runtime switch persists (outside every wiki, see wiki-location.ts). */
	const locationStateFile = defaultLocationStateFile();
	const git = new GitFace();
	const configStore = new ConfigStore({
		note: config.note,
		git: config.git,
		ui: config.ui,
		uiLanguage: config.uiLanguage,
		bridge: config.bridge,
		startup: config.startup,
		wechat: config.wechat
	});
	const eff = () => configStore.get();
	const effectiveNoteTag = () => {
		const tag = eff().note?.tag;
		return typeof tag === "string" && tag.trim().length > 0 ? tag : config.note.tag;
	};
	/**
	* Whether agent-created notes get the automatic workspace marker (v0.24.0):
	* tag `ws/<project>` + field `workspace`. Default ON (cordis default true);
	* the settings-page overlay can turn it off, and an explicit `false` there wins.
	*/
	const effectiveWorkspaceMark = () => {
		const value = eff().note?.workspaceMark;
		return typeof value === "boolean" ? value : config.note.workspaceMark;
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
			showRightbarTab: ui.showRightbarTab !== false
		};
	};
	const disposers = [];
	const disposeAll = () => {
		for (const dispose of disposers.splice(0)) dispose();
	};
	/**
	* Effective 公众号发布 config (cordis base + settings-page overlay), read PER
	* REQUEST: enabling the feature, switching the adapter or rotating the token
	* applies without a dsh web restart. `normalizeWechatConfig` is the single
	* place that turns the loose config-tiddler JSON into the typed shape — a
	* garbage `adapter`/`command` falls back to the defaults instead of reaching
	* the spawned command line.
	*/
	const effectiveWechat = () => normalizeWechatConfig(eff().wechat);
	/**
	* WeChat publish runner (v0.23.3): owns the opencli child process behind the
	* TW toolbar button. Construction spawns nothing (the CLI is resolved per
	* run), and it is disposed with the plugin so a running publish never
	* outlives dsh web and leaves an orphan browser tab.
	*/
	const wechatRunner = new WechatPublishRunner({
		command: () => effectiveWechat().command,
		adapter: () => effectiveWechat().adapter,
		log: (message) => console.warn(message)
	});
	disposers.push(() => wechatRunner.dispose());
	let disposePromptSection;
	let currentPromptText;
	/**
	* Built text for the current effective config (also the saved-state preview).
	* The signature catalogue for `full` mode comes from the live tool registry,
	* never from hand-written prose (v0.21.0 — the old copy had drifted).
	*
	* `wechat.enabled` (v0.23.0) is read here too: it is NOT a `prompt.*` field but
	* it gates the publish rule, and the WeChat feature is opt-in + separately
	* installed, so users who never enabled it must see no publishing text.
	*/
	const promptText = () => {
		const cfg = eff();
		return describePrompt({
			...cfg.prompt ?? {},
			wechat: (cfg.wechat ?? {}).enabled === true
		}, tiddlywikiToolSummary()).text;
	};
	const applyPrompt = () => {
		const next = promptText();
		if (next === currentPromptText) return;
		currentPromptText = next;
		disposePromptSection?.();
		disposePromptSection = void 0;
		if (next.length === 0) return;
		disposePromptSection = ctx.systemPrompt.section({
			name: PROMPT_SECTION_NAME,
			order: 100,
			text: next
		});
	};
	disposers.push(() => {
		disposePromptSection?.();
		disposePromptSection = void 0;
	});
	const server = new WikiServer({
		wikiRoot: config.wikiRoot,
		wiki: config.wiki,
		port: config.port,
		username: config.auth.username,
		password: config.auth.password,
		readyTimeoutMs: config.startup.readyTimeoutMs
	});
	/**
	* Readiness window from the EFFECTIVE config (v0.22.5): the settings page
	* saves `startup.readyTimeoutMs`, and this re-applies it to the running
	* server — it takes effect on the next start()/restart() without a dsh web
	* restart. Values are clamped by host/ready-policy.ts.
	*/
	const applyServerTuning = () => {
		server.setReadyTimeout(eff().startup?.readyTimeoutMs);
	};
	let clientCache;
	let clientPort;
	const client = () => {
		const port = server.currentPort;
		if (port === void 0) return void 0;
		if (clientCache === void 0 || clientPort !== port) {
			clientCache = new TiddlyWebClient(`http://127.0.0.1:${port}`, {
				username: config.auth.username,
				password: config.auth.password
			});
			clientPort = port;
		}
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
			const result = await downloadClipImage(imageUrl, referer);
			return {
				buffer: result.buffer,
				type: result.type ?? null
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
	};
	const teardownCommitter = async () => {
		try {
			unwatch?.();
		} catch {}
		unwatch = void 0;
		const current = committer;
		committer = void 0;
		try {
			await current?.flush();
		} catch {}
		current?.dispose();
	};
	disposers.push(() => {
		teardownCommitter();
	});
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
		autoCommit: () => committer?.touch(),
		restartWiki: async () => {
			await server.restart();
		},
		workspaceName: (sessionId) => {
			const header = (ctx.get("sessions")?.get(sessionId))?.header;
			return typeof header?.cwd === "string" ? header.cwd : void 0;
		},
		workspaceMarkEnabled: () => effectiveWorkspaceMark()
	};
	disposers.push(...registerTiddlywikiTools(ctx, toolsDeps));
	applyPrompt();
	let disposed = false;
	/**
	* Core-bootstrap the CURRENT `wikiPath`: markdown parser plugin, the core +
	* starter seeds, and the configured UI language. Extracted from the startup
	* task (v0.22.0) because a runtime wiki switch must run exactly this on the
	* new folder — the two paths must not drift apart.
	*
	* Only `render-route` needs a TW restart (it carries a SERVER route loaded at
	* boot); plain-content seeds must NOT restart, or the syncer's unflushed REST
	* writes would be lost.
	*/
	const bootstrapWiki = async () => {
		const seedClient = client();
		if (seedClient === void 0) return;
		let pluginAdded = false;
		try {
			pluginAdded = await ensurePlugin(wikiPath, resolveTwRoot(), MARKDOWN_PLUGIN);
			if (pluginAdded) console.info(`[dsh-tiddlywiki] enabled ${MARKDOWN_PLUGIN} for this wiki`);
		} catch (err) {
			console.warn(`[dsh-tiddlywiki] enabling ${MARKDOWN_PLUGIN}:`, err);
		}
		const seedStartedAt = Date.now();
		const results = await runAllSeeds({
			client: seedClient,
			tools: tiddlywikiToolSummary(),
			wechat: (eff().wechat ?? {}).enabled === true
		});
		for (const r of results) if (!r.ok) console.warn(`[dsh-tiddlywiki] seed ${r.id} failed:`, r.error ?? r.detail);
		if (needsRestartAfterSeeds(results)) {
			if (!await waitForFileWrite(join(wikiPath, "tiddlers", "$__plugins_dsh_render.json"), 8e3, 150, seedStartedAt)) console.warn("[dsh-tiddlywiki] seeded render plugin file not seen on disk before restart");
			if (!await flushPendingWrites(seedClient, join(wikiPath, "tiddlers"))) console.warn("[dsh-tiddlywiki] seed writes may not have been flushed before restart");
			if (!disposed) await server.restart();
		} else if (pluginAdded) {
			if (!disposed) await server.restart();
		}
		const uiLang = eff().uiLanguage;
		if (typeof uiLang === "string" && uiLang.trim().length > 0) try {
			const code = uiLang.trim();
			if (await ensureLanguage(wikiPath, resolveTwRoot(), code) && !disposed) await server.restart();
			const langClient = client();
			if (langClient !== void 0) await pinLanguageTiddler(langClient, `$:/languages/${code}`, (message, err) => {
				if (err === void 0) console.warn("[dsh-tiddlywiki]", message);
				else console.warn("[dsh-tiddlywiki] pinning $:/language failed:", err);
			}).catch(() => void 0);
		} catch (err) {
			console.warn("[dsh-tiddlywiki] applying uiLanguage:", err);
		}
	};
	const startupTask = (async () => {
		try {
			const saved = await readLocationState(locationStateFile);
			if (saved.error !== void 0) console.warn("[dsh-tiddlywiki]", saved.error);
			if (saved.active !== void 0) {
				server.setLocation(saved.active);
				wikiPath = locationPath(saved.active);
				console.info(`[dsh-tiddlywiki] wiki location (pointer file): ${wikiPath}`);
			}
			await server.start();
			if (disposed) {
				await server.stop().catch(() => void 0);
				return;
			}
			await configStore.load(client());
			applyPrompt();
			applyServerTuning();
			if (disposed) {
				await server.stop().catch(() => void 0);
				return;
			}
			try {
				await clipBridge.start(effectiveBridge().port);
				console.info(`[dsh-tiddlywiki] clip bridge listening on 127.0.0.1:${clipBridge.port} (enabled=${effectiveBridge().enabled})`);
			} catch (err) {
				console.warn("[dsh-tiddlywiki] clip bridge start:", err);
			}
			if (disposed) {
				try {
					await clipBridge.stop();
				} catch {}
				await server.stop().catch(() => void 0);
				return;
			}
			try {
				await bootstrapWiki();
			} catch (err) {
				console.warn("[dsh-tiddlywiki] seeding wiki:", err);
			}
		} catch (err) {
			console.warn("[dsh-tiddlywiki] startup issue (self-healing is armed):", err);
		}
		if (disposed) return;
		try {
			await bootstrapGit();
			if (disposed) return;
			setupCommitter();
		} catch (err) {
			console.warn("[dsh-tiddlywiki] git bootstrap failed:", err);
		}
	})();
	const defaultLocation = {
		root: config.wikiRoot,
		name: config.wiki
	};
	/** Source of the CURRENT location, for the settings page. */
	const locationSource = async () => {
		const state = await readLocationState(locationStateFile);
		if (state.active !== void 0 && locationPath(state.active) === wikiPath) return "state";
		return typeof rawConfig.wikiRoot === "string" && rawConfig.wikiRoot.trim().length > 0 ? "config" : "default";
	};
	const locationInfo = async () => {
		const state = await readLocationState(locationStateFile);
		const current = server.currentLocation;
		return {
			current: {
				...current,
				path: wikiPath,
				source: await locationSource()
			},
			default: {
				...defaultLocation,
				path: locationPath(defaultLocation)
			},
			stateFile: locationStateFile,
			candidates: await listWikiCandidates(current.root),
			...state.error !== void 0 ? { error: state.error } : {}
		};
	};
	/** Single-flight guard: two concurrent switches would fight over the child. */
	let switching = false;
	const runSwitch = async (target, persist) => {
		if (switching) return {
			ok: false,
			error: "正在切换知识库，请稍候再试",
			rolledBack: true
		};
		if (disposed) return {
			ok: false,
			error: "插件正在卸载，已取消切换",
			rolledBack: false
		};
		switching = true;
		try {
			const result = await switchWiki({
				currentLocation: () => server.currentLocation,
				currentPath: () => wikiPath,
				stopServer: async () => {
					await drainThenStop({
						client: client(),
						tiddlersDir: join(wikiPath, "tiddlers"),
						stop: () => server.stop(),
						log: (message) => console.warn("[dsh-tiddlywiki]", message)
					});
				},
				applyLocation: (nextLocation) => {
					server.setLocation({
						root: nextLocation.root,
						name: nextLocation.name
					});
					wikiPath = locationPath(nextLocation);
					clientCache = void 0;
					clientPort = void 0;
				},
				startServer: async () => {
					await server.start();
				},
				teardownExtras: () => teardownCommitter(),
				setupExtras: () => {
					setupCommitter();
				},
				reloadConfig: async () => {
					await configStore.load(client());
					applyPrompt();
				},
				bootstrap: async () => {
					await bootstrapWiki();
					await bootstrapGit();
				},
				savePointer: persist,
				log: (message) => console.warn("[dsh-tiddlywiki]", message)
			}, target);
			if (disposed) teardownCommitter();
			return result;
		} finally {
			switching = false;
		}
	};
	/** Switch to another folder and remember the choice. */
	const switchWikiLocation = (target) => runSwitch(target, async (t) => {
		await writeLocationState(t, locationStateFile);
	});
	/**
	* 「恢复为配置默认」: drop the pointer and go back to the cordis default. The
	* pointer must be cleared EVEN when the current folder already IS the default
	* (otherwise the stale pointer would win again after the next restart).
	*/
	const resetWikiLocation = async () => {
		if (locationPath(defaultLocation) === wikiPath) {
			await clearLocationState(locationStateFile);
			return {
				ok: true,
				location: defaultLocation,
				path: wikiPath
			};
		}
		return runSwitch(defaultLocation, async () => {
			await clearLocationState(locationStateFile);
		});
	};
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
			},
			wechatConfig: () => effectiveWechat(),
			wechatRunner: () => wechatRunner,
			wechatReady: () => checkWechatReady({
				enabled: effectiveWechat().enabled,
				command: effectiveWechat().command
			})
		});
		const disposeAdmin = registerAdminRoutes({ webServer: ws }, {
			server,
			getClient: client,
			getWikiPath: () => wikiPath,
			twRoot: resolveTwRoot,
			config: configStore,
			onConfigChanged: () => {
				applyPrompt();
				applyServerTuning();
			},
			getPrompt: (draft) => describePrompt(draft ?? eff().prompt ?? {}, tiddlywikiToolSummary()),
			wiki: {
				info: locationInfo,
				switch: switchWikiLocation,
				reset: resetWikiLocation
			},
			seeds: {
				checkAll: async (c) => checkAllSeeds({
					client: c,
					tools: tiddlywikiToolSummary()
				}),
				run: async (c, id, force) => runSeedById({
					client: c,
					tools: tiddlywikiToolSummary()
				}, id, force),
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
			disposed = true;
			try {
				await Promise.race([startupTask.catch(() => void 0), new Promise((r) => {
					setTimeout(r, 3e3).unref?.();
				})]);
			} catch {}
			try {
				await committer?.flush();
			} catch {}
			disposeAll();
			await server.stop();
		})();
	}, "dsh-tiddlywiki: host teardown");
}
//#endregion
export { AGENT_WRITTEN_TAG, ALL_ARTICLES_MARKER_TITLE, ALL_ARTICLES_TEXT, ALL_ARTICLES_TITLE, ANON_USERNAME, AutoCommitter, CLIP_BRIDGE_BOOKMARKLET, CLIP_BRIDGE_DEFAULT_PORT, CLIP_BRIDGE_DOC_TEXT, CLIP_BRIDGE_DOC_TITLE, CLIP_BRIDGE_DRAG_HREF, CLIP_BRIDGE_MARKER_TITLE, ClipBridge, ConfigStore, ConfigUnreadableError, DEFAULT_NOTE_TYPE, DEFAULT_PROMPT_MODE, DEFAULT_WECHAT_ADAPTER, DEFAULT_WECHAT_COMMAND, DOC_NOTE_TAG, DOC_NOTE_TEXT, DOC_NOTE_TITLE, DSH_DOCS_TAG, GitConflictStateError, GitFace, HOME_DEFAULT_TIDDLERS, HOME_INDEX_ITEMS, HOME_INDEX_MARKER_TITLE, HUMAN_EDITED_TAG, LOCATION_STATE_VERSION, MARKDOWN_PLUGIN, MASKED_SECRET, MENUBAR_THEME_MARKER_TITLE, MENUBAR_THEME_TEXT, MENUBAR_THEME_TIDDLER, MISSING_TYPE_FILTER, PATH_PREFIX, PROMPT_GOVERNANCE_BLOCKS, PROMPT_MODES, PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, READY_HARD_FACTOR, READY_POLL_MS, READY_SLOW_POLL_MS, READY_TIMEOUT_DEFAULT_MS, READY_TIMEOUT_MAX_MS, READY_TIMEOUT_MIN_MS, RENDER_BUNDLE_TEXT, RENDER_MARKER_TITLE, RENDER_PLUGIN_FILE, RENDER_PLUGIN_TITLE, SEED_DEFS, SEED_MARKER_VERSION, SEND_TO_AGENT_BUNDLE_TEXT, SEND_TO_AGENT_MARKER_TITLE, SEND_TO_AGENT_PLUGIN_TITLE, SESSION_SUMMARY_PREFIX, STARTER_DOCS_ITEMS, STARTER_DOCS_MARKER_TITLE, TEXT_LIST_FILTER, TRASH_INDEX_TITLE, TRASH_PREFIX, TW_PROXY_PATH, TW_PROXY_PREFIX, TW_WEB_HOST_DEFAULT, TW_WEB_HOST_TIDDLER, TiddlyWebClient, TrashIndexUnavailableError, UI_STYLES_MARKER_TITLE, UI_STYLE_ITEMS, WECHAT_ADAPTERS, WECHAT_ADAPTER_FILES, WECHAT_ADAPTER_MARKER, WECHAT_DOCS_MARKER_TITLE, WECHAT_DOCS_TEXT, WECHAT_DOCS_TITLE, WECHAT_PUBLISH_BUNDLE_TEXT, WECHAT_PUBLISH_MARKER_TITLE, WECHAT_PUBLISH_PLUGIN_TITLE, WORKSPACE_FIELD, WORKSPACE_TAG_PREFIX, WechatPublishRunner, WikiServer, WriteConflictError, apply, assertNoConflict, assertPublicImageUrl, awaitReady, buildBinaryTiddler, buildClipTiddler, buildImageNoteTiddler, buildPromptText, buildPublishInvocation, buildVersionInvocation, buildWriteTiddler, bundledCatalog, capOutput, checkAllSeeds, checkWechatReady, cleanTiddler, clearLocationState, deepMerge, defaultAdaptersDir, defaultLocationStateFile, defaultWechatJobDir, defineTool, describeConflict, describePrompt, describeUnreadableConfig, docNoteText, downloadClipImage, drainThenStop, dshHomePath, ensureLanguage, ensurePlugin, ensureTiddlerTimestamps, escapeInline, escapePromptBraces, expandEnvPath, flattenTiddlerFields, flushPendingWrites, formatTiddlerDate, hashText, hostAllowed, imageExtensionForMime, inject, interpretPublishOutcome, isBinaryType, isJunkTag, isPrivateAddress, isSafeCliValue, isSafeDsn, isSafeUrl, listWikiCandidates, locationPath, maskConfigSecrets, name, needsRestartAfterSeeds, normalizeLocation, normalizePromptMode, normalizePromptPreview, normalizeReadyTimeoutMs, normalizeThemes, normalizeWechatConfig, normalizeWorkspaceName, openInTwEditor, parseClipPayload, parseSeedMarker, parseTiddlerDate, pickImageMime, pinLanguageTiddler, readActiveThemeName, readLocationState, readSeedMarker, readWikiInfo, readyHardTimeoutMs, registerAdminRoutes, registerRoutes, registerTiddlywikiTools, removeSeedById, resolveClipTitle, resolveTwRoot, runAllSeeds, runSeedById, sanitizeTwFragment, scanAdapterDir, seedAllArticles, seedClipBridge, seedDocNote, seedHomeIndex, seedMenubarTheme, seedRenderRoute, seedSendToAgent, seedStarterDocs, seedUiStyles, seedWechatDocs, seedWechatPublish, stripMaskedSecrets, switchWiki, tailOf, tiddlywikiToolSummary, toIsoDateString, toolSignatureLines, unseedClipBridge, unseedWechatDocs, unseedWechatPublish, waitForFileWrite, workspaceMarkFromCwd, workspaceNameFromCwd, workspaceTagName, writeLocationState, writeSeedMarker, writeSessionSummary, writeWikiInfo };

//# sourceMappingURL=index.js.map