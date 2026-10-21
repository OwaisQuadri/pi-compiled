import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface BuildSpec {
	packageRoot: string;
	binary: string;
	buildCommand: string[];
	inputs: string[];
	envAllowlist?: string[];
	overrideEnv?: string;
	timeoutMs?: number;
	isUpstreamRequired?: boolean;
}

export interface BuildProgress {
	line: string;
	completed?: number;
	total?: number;
}

export interface BuildOptions {
	onProgress?: (progress: BuildProgress) => void;
}

export function progressOf(line: string): BuildProgress {
	const match = /^\[(\d+)\s*\/\s*(\d+)\]\s*(.*)$/.exec(line);
	return match ? { line: match[3] ?? "", completed: Number(match[1]), total: Number(match[2]) } : { line };
}

export function progressBar(progress: BuildProgress, width = 20): string {
	const visible = progress.line
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
		.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
		.replace(/\x1b[ -\/]*[0-~]/g, "")
		.replace(/[\x00-\x1f\x7f]/g, "");
	const line = Array.from(visible).slice(0, 120).join("");
	if (progress.completed === undefined || !progress.total) return line;
	const filled = Math.min(width, Math.round((progress.completed / progress.total) * width));
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${progress.completed}/${progress.total} ${line}`;
}

export type BuildErrorCode = "build-refused" | "build-failed" | "build-timeout" | "build-busy";

export class BuildError extends Error {
	readonly code: BuildErrorCode;

	constructor(code: BuildErrorCode, message: string) {
		super(message);
		this.name = "BuildError";
		this.code = code;
	}
}

const baseVariables = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "DEVELOPER_DIR"];
const defaultTimeoutMs = 600_000;
const inFlight = new Map<string, Promise<string>>();
const progressListeners = new Map<string, Set<(progress: BuildProgress) => void>>();

export function lockPath(spec: BuildSpec): string {
	return `${resolve(spec.packageRoot, spec.binary)}.lock`;
}

function override(spec: BuildSpec): string | undefined {
	return spec.overrideEnv ? process.env[spec.overrideEnv] || undefined : undefined;
}

export function binaryPath(spec: BuildSpec): string {
	return override(spec) ?? resolve(spec.packageRoot, spec.binary);
}

export function stampPath(spec: BuildSpec): string {
	return `${resolve(spec.packageRoot, spec.binary)}.stamp`;
}

async function inputsFingerprint(spec: BuildSpec): Promise<string> {
	const listing = await git(spec.packageRoot, ["ls-files", "-s", "--", ...spec.inputs]);
	return createHash("sha256").update(JSON.stringify([spec.buildCommand, spec.inputs])).update("\0").update(listing).digest("hex");
}

export async function isBuildNeeded(spec: BuildSpec): Promise<boolean> {
	if (override(spec) !== undefined) return false;
	if (!existsSync(resolve(spec.packageRoot, spec.binary))) return true;
	let fingerprint: string;
	try {
		fingerprint = await inputsFingerprint(spec);
	} catch {
		return false;
	}
	let stamp = "";
	try { stamp = readFileSync(stampPath(spec), "utf8"); } catch {}
	return stamp !== fingerprint;
}

export async function ensureBuilt(spec: BuildSpec, options: BuildOptions = {}): Promise<string> {
	const prebuilt = override(spec);
	if (prebuilt !== undefined) {
		try {
			if (!isAbsolute(prebuilt)) throw new Error("relative");
			accessSync(prebuilt, constants.X_OK);
		} catch {
			throw new BuildError("build-failed", `${spec.overrideEnv} names ${prebuilt}, which is not an absolute path to an executable file.`);
		}
		return prebuilt;
	}
	const key = resolve(spec.packageRoot, spec.binary);
	const existing = inFlight.get(key);
	if (existing) return follow(key, existing, options);
	if (!(await isBuildNeeded(spec))) return key;
	const running = inFlight.get(key);
	if (running) return follow(key, running, options);
	const listeners = new Set<(progress: BuildProgress) => void>();
	progressListeners.set(key, listeners);
	const build = buildLocked(spec, key, listeners).finally(() => {
		inFlight.delete(key);
		progressListeners.delete(key);
	});
	inFlight.set(key, build);
	return follow(key, build, options);
}

function follow(key: string, build: Promise<string>, options: BuildOptions): Promise<string> {
	const listener = options.onProgress;
	const listeners = progressListeners.get(key);
	if (!listener || !listeners) return build;
	listeners.add(listener);
	return build.finally(() => listeners.delete(listener));
}

function isInside(root: string, path: string): boolean {
	const relativePath = relative(root, resolve(root, path));
	return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function realPath(path: string): string {
	let existing = path;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	return resolve(realpathSync(existing), relative(existing, path));
}

const flockPaths = ["/usr/bin/flock", "/bin/flock"];

function lockTool(): string | undefined {
	return process.platform === "darwin" ? "/usr/bin/lockf" : flockPaths.find((path) => existsSync(path));
}

export async function refusalReason(spec: BuildSpec): Promise<string> {
	if (!isAbsolute(spec.buildCommand[0] ?? "")) return "the build command must start with an absolute path.";
	const outside = [spec.binary, ...spec.inputs].filter((path) => path.startsWith(":") || !isInside(spec.packageRoot, path));
	if (outside.length) return `these paths are not inside the package: ${outside.join(", ")}.`;
	const root = realpathSync(spec.packageRoot);
	const escaping = [spec.binary, ...spec.inputs].filter((path) => !isInside(root, realPath(resolve(spec.packageRoot, path))));
	if (escaping.length) return `these paths resolve outside the package through a symbolic link: ${escaping.join(", ")}.`;
	if (!lockTool()) return `no flock was found at ${flockPaths.join(" or ")}.`;
	const top = await git(spec.packageRoot, ["rev-parse", "--show-toplevel"]);
	if (realpathSync(top) !== realpathSync(spec.packageRoot)) return `the package is not its own Git checkout (${top}).`;
	if (spec.isUpstreamRequired) {
		let upstream: string;
		try {
			upstream = await git(spec.packageRoot, ["rev-parse", "--verify", "@{upstream}^{commit}"]);
		} catch {
			return "the checkout has no fetched upstream branch, and this package builds only the fetched upstream commit.";
		}
		const head = await git(spec.packageRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
		if (head !== upstream) return `HEAD ${head.slice(0, 12)} is not the fetched upstream commit ${upstream.slice(0, 12)}, and this package builds only the fetched upstream commit.`;
	}
	if (!spec.inputs.length) return "no build inputs were declared.";
	const changes = await git(spec.packageRoot, ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...spec.inputs]);
	if (changes) return `the build inputs have uncommitted or ignored changes:\n${changes}\n`;
	let listing: string;
	try {
		listing = await git(spec.packageRoot, ["ls-files", "-s", "--error-unmatch", "--", ...spec.inputs]);
	} catch (error) {
		return `a build input does not match a committed file: ${(error as Error).message}`;
	}
	const hidden = (await git(spec.packageRoot, ["ls-files", "-v", "--", ...spec.inputs])).split("\n").filter((line) => /^[a-zS] /.test(line));
	if (hidden.length) return `the build inputs are marked assume-unchanged or skip-worktree, so Git cannot see changes to them:\n${hidden.map((line) => line.slice(2)).join("\n")}\n`;
	const links = listing.split("\n").filter((line) => line.startsWith("120000 "));
	return links.length ? `the build inputs contain symbolic links:\n${links.map((line) => line.split("\t")[1]).join("\n")}\n` : "";
}

async function buildLocked(spec: BuildSpec, key: string, listeners: Set<(progress: BuildProgress) => void>): Promise<string> {
	const refusal = await refusalReason(spec);
	if (refusal) throw new BuildError("build-refused", `Refused to build ${spec.binary}: ${refusal}`);
	mkdirSync(dirname(key), { recursive: true });
	await run(spec, key, await inputsFingerprint(spec), spec.timeoutMs ?? defaultTimeoutMs, listeners);
	if (!existsSync(key)) throw new BuildError("build-failed", `The build finished but ${key} does not exist.`);
	return key;
}

const gitVariables = ["PATH", "HOME"];
const gitPaths = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];

function git(cwd: string, args: string[]): Promise<string> {
	const env = Object.fromEntries(gitVariables.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
	return new Promise((done, reject) => {
		const command = gitPaths.find((path) => existsSync(path));
		if (!command) return reject(new BuildError("build-refused", `No Git was found at ${gitPaths.join(", ")}.`));
		execFile(command, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.ignoreStat=false", "-C", cwd, ...args], { env }, (error, stdout, stderr) => {
			if (error) return reject(new BuildError("build-refused", `Could not check the package with Git (${(stderr.trim() || error.message).split("\n")[0]}).`));
			done(stdout.trimEnd());
		});
	});
}

const busyStatus = 75;

function lockSeconds(timeoutMs: number): number {
	return Math.max(1, Math.round(timeoutMs / 1000));
}

function lockedCommand(spec: BuildSpec, key: string, fingerprint: string, timeoutMs: number): string[] {
	const seconds = String(lockSeconds(timeoutMs));
	const tool = lockTool() ?? "";
	const lock = process.platform === "darwin" ? [tool, "-k", "-s", "-t", seconds, `${key}.lock`] : [tool, "-o", "-w", seconds, "-E", String(busyStatus), `${key}.lock`];
	const wrapper = `expected=$1; shift; if [ -e "$0" ] && [ "$(cat "$0.stamp" 2>/dev/null)" = "$expected" ]; then exit 0; fi; "$@"; status=$?; [ "$status" = ${busyStatus} ] && exit ${busyStatus + 1}; [ "$status" = 0 ] && printf '%s' "$expected" > "$0.stamp"; exit "$status"`;
	return [...lock, "/bin/sh", "-c", wrapper, key, fingerprint, ...spec.buildCommand];
}

const lineLimit = 4000;
const drainMs = 200;

function lines(onLine: (line: string) => void): { add: (chunk: string) => void; flush: () => void } {
	let pending = "";
	return {
		add: (chunk) => {
			const parts = (pending + chunk).split(/\r?\n|\r/);
			pending = (parts.pop() ?? "").slice(-lineLimit);
			for (const part of parts) if (part.trim()) onLine(part.trim());
		},
		flush: () => {
			if (pending.trim()) onLine(pending.trim());
			pending = "";
		},
	};
}

function ended(stream: NodeJS.ReadableStream): Promise<void> {
	return new Promise((done) => {
		stream.once("end", done);
		stream.once("close", done);
	});
}

function run(spec: BuildSpec, key: string, fingerprint: string, timeoutMs: number, listeners: Set<(progress: BuildProgress) => void>): Promise<void> {
	const names = [...baseVariables, ...(spec.envAllowlist ?? [])];
	const env = Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
	const [command = "", ...args] = lockedCommand(spec, key, fingerprint, timeoutMs);
	return new Promise((done, reject) => {
		const child = spawn(command, args, { cwd: spec.packageRoot, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		let isTimedOut = false;
		child.stderr.setEncoding("utf8");
		child.stdout.setEncoding("utf8");
		const report = (line: string) => {
			const progress = progressOf(line);
			for (const listener of listeners) {
				try {
					const result: unknown = listener(progress);
					if (result instanceof Promise) result.catch(() => undefined);
				} catch {}
			}
		};
		const stdoutLines = lines(report);
		const stderrLines = lines(report);
		const streamsEnded = Promise.all([ended(child.stdout), ended(child.stderr)]);
		child.stdout.on("data", stdoutLines.add);
		child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); stderrLines.add(chunk); });
		const timer = setTimeout(() => {
			isTimedOut = true;
			try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
			child.stdout.destroy();
			child.stderr.destroy();
			reject(new BuildError("build-timeout", `The build did not finish within ${Math.round((2 * timeoutMs) / 1000)} seconds, including the wait for the lock.`));
		}, 2 * timeoutMs);
		child.on("error", (error) => { clearTimeout(timer); reject(new BuildError("build-failed", `Could not start the build: ${error.message}`)); });
		child.on("exit", async (status) => {
			clearTimeout(timer);
			if (isTimedOut) return;
			await Promise.race([streamsEnded, new Promise((done) => setTimeout(done, drainMs))]);
			child.stdout.destroy();
			child.stderr.destroy();
			stdoutLines.flush();
			stderrLines.flush();
			if (status === busyStatus) return reject(new BuildError("build-busy", `Another Pi session held the build lock ${key}.lock for longer than ${lockSeconds(timeoutMs)} seconds.`));
			if (status !== 0) return reject(new BuildError("build-failed", `The build failed: ${stderr.trim().split("\n").slice(-3).join(" ")}`));
			done();
		});
	});
}
