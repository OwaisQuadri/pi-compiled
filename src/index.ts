import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface BuildSpec {
	packageRoot: string;
	binary: string;
	buildCommand: string[];
	inputs: string[];
	envAllowlist?: string[];
	overrideEnv?: string;
	timeoutMs?: number;
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

export function lockPath(spec: BuildSpec): string {
	return `${resolve(spec.packageRoot, spec.binary)}.lock`;
}

function override(spec: BuildSpec): string | undefined {
	return spec.overrideEnv ? process.env[spec.overrideEnv] || undefined : undefined;
}

export function binaryPath(spec: BuildSpec): string {
	return override(spec) ?? resolve(spec.packageRoot, spec.binary);
}

export function isBuildNeeded(spec: BuildSpec): boolean {
	return override(spec) === undefined && !existsSync(resolve(spec.packageRoot, spec.binary));
}

export function ensureBuilt(spec: BuildSpec): Promise<string> {
	const prebuilt = override(spec);
	if (prebuilt !== undefined) {
		try {
			if (!isAbsolute(prebuilt)) throw new Error("relative");
			accessSync(prebuilt, constants.X_OK);
		} catch {
			return Promise.reject(new BuildError("build-failed", `${spec.overrideEnv} names ${prebuilt}, which is not an absolute path to an executable file.`));
		}
		return Promise.resolve(prebuilt);
	}
	if (!isBuildNeeded(spec)) return Promise.resolve(binaryPath(spec));
	const key = resolve(spec.packageRoot, spec.binary);
	const existing = inFlight.get(key);
	if (existing) return existing;
	const build = buildLocked(spec, key).finally(() => inFlight.delete(key));
	inFlight.set(key, build);
	return build;
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
	if (!spec.inputs.length) return "no build inputs were declared.";
	const changes = await git(spec.packageRoot, ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...spec.inputs]);
	if (changes) return `the build inputs have uncommitted or ignored changes:\n${changes}\n`;
	let listing: string;
	try {
		listing = await git(spec.packageRoot, ["ls-files", "-s", "--error-unmatch", "--", ...spec.inputs]);
	} catch (error) {
		return `a build input does not match a committed file: ${(error as Error).message}`;
	}
	const links = listing.split("\n").filter((line) => line.startsWith("120000 "));
	return links.length ? `the build inputs contain symbolic links:\n${links.map((line) => line.split("\t")[1]).join("\n")}\n` : "";
}

async function buildLocked(spec: BuildSpec, key: string): Promise<string> {
	const refusal = await refusalReason(spec);
	if (refusal) throw new BuildError("build-refused", `Refused to build ${spec.binary}: ${refusal}`);
	mkdirSync(dirname(key), { recursive: true });
	await run(spec, key, spec.timeoutMs ?? defaultTimeoutMs);
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
		execFile(command, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args], { env }, (error, stdout, stderr) => {
			if (error) return reject(new BuildError("build-refused", `Could not check the package with Git (${(stderr.trim() || error.message).split("\n")[0]}).`));
			done(stdout.trimEnd());
		});
	});
}

const busyStatus = 75;

function lockSeconds(timeoutMs: number): number {
	return Math.max(1, Math.round(timeoutMs / 1000));
}

function lockedCommand(spec: BuildSpec, key: string, timeoutMs: number): string[] {
	const seconds = String(lockSeconds(timeoutMs));
	const tool = lockTool() ?? "";
	const lock = process.platform === "darwin" ? [tool, "-k", "-s", "-t", seconds, `${key}.lock`] : [tool, "-o", "-w", seconds, "-E", String(busyStatus), `${key}.lock`];
	return [...lock, "/bin/sh", "-c", `test -e "$0" && exit 0; "$@"; status=$?; [ "$status" = ${busyStatus} ] && exit ${busyStatus + 1}; exit "$status"`, key, ...spec.buildCommand];
}

function run(spec: BuildSpec, key: string, timeoutMs: number): Promise<void> {
	const names = [...baseVariables, ...(spec.envAllowlist ?? [])];
	const env = Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
	const [command = "", ...args] = lockedCommand(spec, key, timeoutMs);
	return new Promise((done, reject) => {
		const child = spawn(command, args, { cwd: spec.packageRoot, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let isTimedOut = false;
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
		const timer = setTimeout(() => {
			isTimedOut = true;
			try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch {}
			child.stderr.destroy();
			reject(new BuildError("build-timeout", `The build did not finish within ${Math.round((2 * timeoutMs) / 1000)} seconds, including the wait for the lock.`));
		}, 2 * timeoutMs);
		child.on("error", (error) => { clearTimeout(timer); reject(new BuildError("build-failed", `Could not start the build: ${error.message}`)); });
		child.on("exit", (status) => {
			child.stderr.destroy();
			clearTimeout(timer);
			if (isTimedOut) return;
			if (status === busyStatus) return reject(new BuildError("build-busy", `Another Pi session held the build lock ${key}.lock for longer than ${lockSeconds(timeoutMs)} seconds.`));
			if (status !== 0) return reject(new BuildError("build-failed", `The build failed: ${stderr.trim().split("\n").slice(-3).join(" ")}`));
			done();
		});
	});
}
