import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
    return `${resolve(spec.packageRoot, spec.binary)}.lock`;
}
function override(spec) {
    return spec.overrideEnv ? process.env[spec.overrideEnv] || undefined : undefined;
}
export function binaryPath(spec) {
    return override(spec) ?? resolve(spec.packageRoot, spec.binary);
}
export function stampPath(spec) {
    return `${resolve(spec.packageRoot, spec.binary)}.stamp`;
}
async function inputsFingerprint(spec) {
    const listing = await git(spec.packageRoot, ["ls-files", "-s", "--", ...spec.inputs]);
    return createHash("sha256").update(JSON.stringify(spec.buildCommand)).update("\0").update(listing).digest("hex");
}
export async function isBuildNeeded(spec) {
    if (override(spec) !== undefined)
        return false;
    if (!existsSync(resolve(spec.packageRoot, spec.binary)))
        return true;
    let fingerprint;
    try {
        fingerprint = await inputsFingerprint(spec);
    }
    catch {
        return false;
    }
    let stamp = "";
    try {
        stamp = readFileSync(stampPath(spec), "utf8");
    }
    catch { }
    return stamp !== fingerprint;
}
export async function ensureBuilt(spec) {
    const prebuilt = override(spec);
    if (prebuilt !== undefined) {
        try {
            if (!isAbsolute(prebuilt))
                throw new Error("relative");
            accessSync(prebuilt, constants.X_OK);
        }
        catch {
            throw new BuildError("build-failed", `${spec.overrideEnv} names ${prebuilt}, which is not an absolute path to an executable file.`);
        }
        return prebuilt;
    }
    const key = resolve(spec.packageRoot, spec.binary);
    const existing = inFlight.get(key);
    if (existing)
        return existing;
    if (!(await isBuildNeeded(spec)))
        return key;
    const running = inFlight.get(key);
    if (running)
        return running;
    const build = buildLocked(spec, key).finally(() => inFlight.delete(key));
    inFlight.set(key, build);
    return build;
}
function isInside(root, path) {
    const relativePath = relative(root, resolve(root, path));
    return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}
function realPath(path) {
    let existing = path;
    while (!existsSync(existing) && dirname(existing) !== existing)
        existing = dirname(existing);
    return resolve(realpathSync(existing), relative(existing, path));
}
const flockPaths = ["/usr/bin/flock", "/bin/flock"];
function lockTool() {
    return process.platform === "darwin" ? "/usr/bin/lockf" : flockPaths.find((path) => existsSync(path));
}
export async function refusalReason(spec) {
    if (!isAbsolute(spec.buildCommand[0] ?? ""))
        return "the build command must start with an absolute path.";
    const outside = [spec.binary, ...spec.inputs].filter((path) => path.startsWith(":") || !isInside(spec.packageRoot, path));
    if (outside.length)
        return `these paths are not inside the package: ${outside.join(", ")}.`;
    const root = realpathSync(spec.packageRoot);
    const escaping = [spec.binary, ...spec.inputs].filter((path) => !isInside(root, realPath(resolve(spec.packageRoot, path))));
    if (escaping.length)
        return `these paths resolve outside the package through a symbolic link: ${escaping.join(", ")}.`;
    if (!lockTool())
        return `no flock was found at ${flockPaths.join(" or ")}.`;
    const top = await git(spec.packageRoot, ["rev-parse", "--show-toplevel"]);
    if (realpathSync(top) !== realpathSync(spec.packageRoot))
        return `the package is not its own Git checkout (${top}).`;
    if (!spec.inputs.length)
        return "no build inputs were declared.";
    const changes = await git(spec.packageRoot, ["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ...spec.inputs]);
    if (changes)
        return `the build inputs have uncommitted or ignored changes:\n${changes}\n`;
    let listing;
    try {
        listing = await git(spec.packageRoot, ["ls-files", "-s", "--error-unmatch", "--", ...spec.inputs]);
    }
    catch (error) {
        return `a build input does not match a committed file: ${error.message}`;
    }
    const hidden = (await git(spec.packageRoot, ["ls-files", "-v", "--", ...spec.inputs])).split("\n").filter((line) => /^[a-zS] /.test(line));
    if (hidden.length)
        return `the build inputs are marked assume-unchanged or skip-worktree, so Git cannot see changes to them:\n${hidden.map((line) => line.slice(2)).join("\n")}\n`;
    const links = listing.split("\n").filter((line) => line.startsWith("120000 "));
    return links.length ? `the build inputs contain symbolic links:\n${links.map((line) => line.split("\t")[1]).join("\n")}\n` : "";
}
async function buildLocked(spec, key) {
    const refusal = await refusalReason(spec);
    if (refusal)
        throw new BuildError("build-refused", `Refused to build ${spec.binary}: ${refusal}`);
    mkdirSync(dirname(key), { recursive: true });
    await run(spec, key, await inputsFingerprint(spec), spec.timeoutMs ?? defaultTimeoutMs);
    if (!existsSync(key))
        throw new BuildError("build-failed", `The build finished but ${key} does not exist.`);
    return key;
}
const gitVariables = ["PATH", "HOME"];
const gitPaths = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
function git(cwd, args) {
    const env = Object.fromEntries(gitVariables.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
    return new Promise((done, reject) => {
        const command = gitPaths.find((path) => existsSync(path));
        if (!command)
            return reject(new BuildError("build-refused", `No Git was found at ${gitPaths.join(", ")}.`));
        execFile(command, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.ignoreStat=false", "-C", cwd, ...args], { env }, (error, stdout, stderr) => {
            if (error)
                return reject(new BuildError("build-refused", `Could not check the package with Git (${(stderr.trim() || error.message).split("\n")[0]}).`));
            done(stdout.trimEnd());
        });
    });
}
const busyStatus = 75;
function lockSeconds(timeoutMs) {
    return Math.max(1, Math.round(timeoutMs / 1000));
}
function lockedCommand(spec, key, fingerprint, timeoutMs) {
    const seconds = String(lockSeconds(timeoutMs));
    const tool = lockTool() ?? "";
    const lock = process.platform === "darwin" ? [tool, "-k", "-s", "-t", seconds, `${key}.lock`] : [tool, "-o", "-w", seconds, "-E", String(busyStatus), `${key}.lock`];
    const wrapper = `expected=$1; shift; if [ -e "$0" ] && [ "$(cat "$0.stamp" 2>/dev/null)" = "$expected" ]; then exit 0; fi; "$@"; status=$?; [ "$status" = ${busyStatus} ] && exit ${busyStatus + 1}; [ "$status" = 0 ] && printf '%s' "$expected" > "$0.stamp"; exit "$status"`;
    return [...lock, "/bin/sh", "-c", wrapper, key, fingerprint, ...spec.buildCommand];
}
function run(spec, key, fingerprint, timeoutMs) {
    const names = [...baseVariables, ...(spec.envAllowlist ?? [])];
    const env = Object.fromEntries(names.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
    const [command = "", ...args] = lockedCommand(spec, key, fingerprint, timeoutMs);
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
            child.stderr.destroy();
            reject(new BuildError("build-timeout", `The build did not finish within ${Math.round((2 * timeoutMs) / 1000)} seconds, including the wait for the lock.`));
        }, 2 * timeoutMs);
        child.on("error", (error) => { clearTimeout(timer); reject(new BuildError("build-failed", `Could not start the build: ${error.message}`)); });
        child.on("exit", (status) => {
            child.stderr.destroy();
            clearTimeout(timer);
            if (isTimedOut)
                return;
            if (status === busyStatus)
                return reject(new BuildError("build-busy", `Another Pi session held the build lock ${key}.lock for longer than ${lockSeconds(timeoutMs)} seconds.`));
            if (status !== 0)
                return reject(new BuildError("build-failed", `The build failed: ${stderr.trim().split("\n").slice(-3).join(" ")}`));
            done();
        });
    });
}
