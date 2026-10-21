import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
export class BuildError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "BuildError";
        this.code = code;
    }
}
const baseVariables = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "DEVELOPER_DIR"];
const defaultTimeoutMs = 600_000;
const inFlight = new Map();
export function lockPath(spec) {
    return join(tmpdir(), `pi-build-on-use-${createHash("sha256").update(resolve(spec.packageRoot, spec.binary)).digest("hex").slice(0, 16)}.lock`);
}
export function binaryPath(spec) {
    const override = spec.overrideEnv ? process.env[spec.overrideEnv] : undefined;
    return override || resolve(spec.packageRoot, spec.binary);
}
export function isBuildNeeded(spec) {
    return !(spec.overrideEnv && process.env[spec.overrideEnv]) && !existsSync(resolve(spec.packageRoot, spec.binary));
}
export function ensureBuilt(spec) {
    if (!isBuildNeeded(spec))
        return Promise.resolve(binaryPath(spec));
    const key = resolve(spec.packageRoot, spec.binary);
    const existing = inFlight.get(key);
    if (existing)
        return existing;
    const build = buildLocked(spec, key, lockPath(spec)).finally(() => inFlight.delete(key));
    inFlight.set(key, build);
    return build;
}
function isInside(root, path) {
    const relativePath = relative(root, resolve(root, path));
    return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}
export async function refusalReason(spec) {
    const outside = [spec.binary, ...spec.inputs].filter((path) => path.startsWith(":") || !isInside(spec.packageRoot, path));
    if (outside.length)
        return `these paths are not inside the package: ${outside.join(", ")}.`;
    const top = await git(spec.packageRoot, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(top) !== realpathSync(spec.packageRoot))
        return `the package is not its own Git checkout (${top}).`;
    if (!spec.inputs.length)
        return "no build inputs were declared.";
    const changes = await git(spec.packageRoot, ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...spec.inputs]);
    return changes ? `the build inputs have uncommitted or ignored changes:\n${changes}\n` : "";
}
async function buildLocked(spec, key, lock) {
    const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;
    await acquire(lock, timeoutMs);
    try {
        if (existsSync(key))
            return key;
        const refusal = await refusalReason(spec);
        if (refusal)
            throw new BuildError("build-refused", `Refused to build ${spec.binary}: ${refusal}`);
        await run(spec, timeoutMs);
        if (!existsSync(key))
            throw new BuildError("build-failed", `The build finished but ${key} does not exist.`);
        return key;
    }
    finally {
        try {
            unlinkSync(lock);
        }
        catch { }
    }
}
function isLinked(source, target) {
    try {
        linkSync(source, target);
        return true;
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        return false;
    }
}
async function acquire(lock, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const claim = `${lock}.${process.pid}.${randomUUID()}`;
    writeFileSync(claim, String(process.pid));
    try {
        for (;;) {
            if (isLinked(claim, lock))
                return;
            const owner = lockOwner(lock);
            if (owner !== undefined && !isAlive(owner)) {
                const stale = `${lock}.stale.${randomUUID()}`;
                try {
                    renameSync(lock, stale);
                }
                catch {
                    continue;
                }
                if (lockOwner(stale) !== owner)
                    isLinked(stale, lock);
                unlinkSync(stale);
                continue;
            }
            if (Date.now() > deadline)
                throw new BuildError("build-busy", `Another Pi session held the build lock ${lock} for longer than ${Math.round(timeoutMs / 1000)} seconds.`);
            await sleep(250);
        }
    }
    finally {
        unlinkSync(claim);
    }
}
function lockOwner(path) {
    try {
        const pid = Number(readFileSync(path, "utf8"));
        return pid > 0 ? pid : undefined;
    }
    catch {
        return undefined;
    }
}
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== "ESRCH";
    }
}
const gitVariables = ["PATH", "HOME"];
function git(cwd, args) {
    const env = Object.fromEntries(gitVariables.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
    return new Promise((done, reject) => {
        execFile("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, ...args], { env }, (error, stdout, stderr) => {
            if (error)
                return reject(new BuildError("build-refused", `Could not check the package with Git (${(stderr.trim() || error.message).split("\n")[0]}).`));
            done(stdout.trimEnd());
        });
    });
}
function run(spec, timeoutMs) {
    const names = [...baseVariables, ...(spec.envAllowlist ?? [])];
    const env = Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
    const [command, ...args] = spec.buildCommand;
    if (!command)
        return Promise.reject(new BuildError("build-failed", "The build command is empty."));
    return new Promise((done, reject) => {
        const child = spawn(command, args, { cwd: spec.packageRoot, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        let isTimedOut = false;
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
        const timer = setTimeout(() => {
            isTimedOut = true;
            try {
                if (child.pid)
                    process.kill(-child.pid, "SIGKILL");
            }
            catch { }
        }, timeoutMs);
        child.on("error", (error) => { clearTimeout(timer); reject(new BuildError("build-failed", `Could not start the build: ${error.message}`)); });
        child.on("close", (status) => {
            clearTimeout(timer);
            if (isTimedOut)
                return reject(new BuildError("build-timeout", `The build timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
            if (status !== 0)
                return reject(new BuildError("build-failed", `The build failed: ${stderr.trim().split("\n").slice(-3).join(" ")}`));
            done();
        });
    });
}
