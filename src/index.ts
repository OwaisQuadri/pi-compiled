import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface BuildSpec {
	packageRoot: string;
	binary: string;
	buildCommand: string[];
	inputs: string[];
	envAllowlist?: string[];
	overrideEnv?: string;
	timeoutMs?: number;
}

export type BuildErrorCode = "build-refused" | "build-failed" | "build-timeout";

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

export function lockPath(spec: BuildSpec): string {
	return join(tmpdir(), `pi-build-on-use-${createHash("sha256").update(resolve(spec.packageRoot, spec.binary)).digest("hex").slice(0, 16)}.lock`);
}

export function binaryPath(spec: BuildSpec): string {
	const override = spec.overrideEnv ? process.env[spec.overrideEnv] : undefined;
	return override || resolve(spec.packageRoot, spec.binary);
}

export function isBuildNeeded(spec: BuildSpec): boolean {
	return !(spec.overrideEnv && process.env[spec.overrideEnv]) && !existsSync(resolve(spec.packageRoot, spec.binary));
}

export function ensureBuilt(spec: BuildSpec): Promise<string> {
	if (!isBuildNeeded(spec)) return Promise.resolve(binaryPath(spec));
	const key = resolve(spec.packageRoot, spec.binary);
	const existing = inFlight.get(key);
	if (existing) return existing;
	const build = buildLocked(spec, key, lockPath(spec)).finally(() => inFlight.delete(key));
	inFlight.set(key, build);
	return build;
}

export async function refusalReason(spec: BuildSpec): Promise<string> {
	const top = await git(spec.packageRoot, ["rev-parse", "--show-toplevel"]);
	if (realpathSync(top) !== realpathSync(spec.packageRoot)) return `the package is not its own Git checkout (${top}).`;
	if (!spec.inputs.length) return "no build inputs were declared.";
	const changes = await git(spec.packageRoot, ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...spec.inputs]);
	return changes ? `the build inputs have uncommitted or ignored changes:\n${changes}\n` : "";
}

async function buildLocked(spec: BuildSpec, key: string, lock: string): Promise<string> {
	const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;
	await acquire(lock, timeoutMs);
	try {
		if (existsSync(key)) return key;
		const refusal = await refusalReason(spec);
		if (refusal) throw new BuildError("build-refused", `Refused to build ${spec.binary}: ${refusal}`);
		await run(spec, timeoutMs);
		if (!existsSync(key)) throw new BuildError("build-failed", `The build finished but ${key} does not exist.`);
		return key;
	} finally {
		try { unlinkSync(lock); } catch {}
	}
}

async function acquire(lock: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const descriptor = openSync(lock, "wx");
			writeSync(descriptor, String(process.pid));
			closeSync(descriptor);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (isStale(lock)) {
			try { unlinkSync(lock); } catch {}
			continue;
		}
		if (Date.now() > deadline) throw new BuildError("build-timeout", `Another process held the build lock ${lock} for too long.`);
		await sleep(250);
	}
}

function isStale(lock: string): boolean {
	let pid: number;
	try { pid = Number(readFileSync(lock, "utf8")); } catch { return false; }
	if (!pid) return false;
	try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((done, reject) => {
		execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
			if (error) return reject(new BuildError("build-refused", `Could not check the package with Git (${(stderr.trim() || error.message).split("\n")[0]}).`));
			done(stdout.trimEnd());
		});
	});
}

function run(spec: BuildSpec, timeoutMs: number): Promise<void> {
	const names = [...baseVariables, ...(spec.envAllowlist ?? [])];
	const env = Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
	const [command, ...args] = spec.buildCommand;
	if (!command) return Promise.reject(new BuildError("build-failed", "The build command is empty."));
	return new Promise((done, reject) => {
		const child = spawn(command, args, { cwd: spec.packageRoot, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let isTimedOut = false;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
		const timer = setTimeout(() => {
			isTimedOut = true;
			try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
		}, timeoutMs);
		child.on("error", (error) => { clearTimeout(timer); reject(new BuildError("build-failed", `Could not start the build: ${error.message}`)); });
		child.on("close", (status) => {
			clearTimeout(timer);
			if (isTimedOut) return reject(new BuildError("build-timeout", `The build timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
			if (status !== 0) return reject(new BuildError("build-failed", `The build failed: ${stderr.trim().split("\n").slice(-3).join(" ")}`));
			done();
		});
	});
}
