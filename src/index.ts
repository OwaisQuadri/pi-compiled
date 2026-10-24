import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRefusalReason, cleanupPathReason, inputsFingerprint, lockCommand } from "./validation.ts";

export { refusalReason } from "./validation.ts";

export interface BuildSpec {
	packageRoot: string;
	binary: string;
	buildCommand: string[];
	inputs: string[];
	cleanupPaths?: string[];
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
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\?|$)/g, "")
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

export function packageLockPath(root: string): string {
	const absolute = resolve(root);
	return resolve(realpathSync(dirname(absolute)), `.${basename(absolute)}.pi-package.lock`);
}

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
	const flightKey = spec.cleanupPaths === undefined ? key : `${key}\0${JSON.stringify(spec.cleanupPaths)}`;
	const existing = inFlight.get(flightKey);
	if (existing) return follow(flightKey, existing, options);
	if (spec.cleanupPaths === undefined && !(await isBuildNeeded(spec))) return key;
	const running = inFlight.get(flightKey);
	if (running) return follow(flightKey, running, options);
	const listeners = new Set<(progress: BuildProgress) => void>();
	progressListeners.set(flightKey, listeners);
	const build = buildLocked(spec, key, listeners).finally(() => {
		inFlight.delete(flightKey);
		progressListeners.delete(flightKey);
	});
	inFlight.set(flightKey, build);
	return follow(flightKey, build, options);
}

function follow(key: string, build: Promise<string>, options: BuildOptions): Promise<string> {
	const listener = options.onProgress;
	const listeners = progressListeners.get(key);
	if (!listener || !listeners) return build;
	listeners.add(listener);
	return build.finally(() => listeners.delete(listener));
}

async function nodeRuntime(): Promise<string> {
	const command = (process.env.PATH ?? "").split(delimiter).map((path) => resolve(path, "node")).find((path) => {
		try { accessSync(path, constants.X_OK); return true; } catch { return false; }
	});
	const message = "Pi compilation requires Node.js >=22.19.0. Put a supported node executable on PATH and retry.";
	if (!command) throw new BuildError("build-refused", message);
	return new Promise((done, reject) => {
		const env = Object.fromEntries(baseVariables.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
		execFile(command, ["-p", "JSON.stringify({isNode: process.release.name === 'node' && !process.versions.bun, version: process.versions.node})"], { env, timeout: 1000, maxBuffer: 1024 }, (error, stdout) => {
			try {
				const runtime = JSON.parse(stdout) as { isNode: boolean; version: string };
				const [major = 0, minor = 0] = runtime.version.split(".").map(Number);
				if (error || !runtime.isNode || !(major > 22 || major === 22 && minor >= 19)) throw new Error("unsupported runtime");
				done(command);
			} catch {
				reject(new BuildError("build-refused", message));
			}
		});
	});
}

async function buildLocked(spec: BuildSpec, key: string, listeners: Set<(progress: BuildProgress) => void>): Promise<string> {
	let refusal = cleanupPathReason(spec);
	if (!refusal) {
		try {
			refusal = await buildRefusalReason(spec);
		} catch (error) {
			if (!existsSync(key) || spec.cleanupPaths === undefined) throw error;
		}
	}
	if (refusal) throw new BuildError("build-refused", `Refused to build ${spec.binary}: ${refusal}`);
	const node = await nodeRuntime();
	if (spec.cleanupPaths === undefined) mkdirSync(dirname(key), { recursive: true });
	await run(spec, key, node, spec.timeoutMs ?? defaultTimeoutMs, listeners);
	return key;
}

const busyStatus = 75;

function lockSeconds(timeoutMs: number): number {
	return Math.max(1, Math.round(timeoutMs / 1000));
}

function lockedCommand(spec: BuildSpec, key: string, node: string, timeoutMs: number): string[] {
	const worker = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url));
	const command = [node, worker, JSON.stringify(spec)];
	return spec.cleanupPaths === undefined
		? [...lockCommand(`${key}.lock`, timeoutMs), ...command]
		: [...lockCommand(packageLockPath(spec.packageRoot), timeoutMs), ...command, "package"];
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

function run(spec: BuildSpec, key: string, node: string, timeoutMs: number, listeners: Set<(progress: BuildProgress) => void>): Promise<void> {
	const names = [...baseVariables, ...(spec.envAllowlist ?? [])];
	const env = Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
	const [command = "", ...args] = lockedCommand(spec, key, node, timeoutMs);
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
			if (status === busyStatus) return reject(new BuildError("build-busy", `Another Pi session held a build or package lock for ${key} for longer than ${lockSeconds(timeoutMs)} seconds.`));
			if (status !== 0) return reject(new BuildError(status === 77 ? "build-refused" : "build-failed", `The build failed: ${stderr.trim().split("\n").slice(-3).join(" ")}`));
			done();
		});
	});
}
