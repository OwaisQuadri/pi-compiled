import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BuildError, lockPath, stampPath } from "./index.js";
export async function inputsFingerprint(spec) {
    const listing = await git(spec.packageRoot, ["ls-files", "-s", "--", ...spec.inputs]);
    return createHash("sha256").update(JSON.stringify([spec.buildCommand, spec.inputs])).update("\0").update(listing).digest("hex");
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
export function lockTool() {
    return process.platform === "darwin" ? "/usr/bin/lockf" : flockPaths.find((path) => existsSync(path));
}
export function lockCommand(path, timeoutMs) {
    const seconds = String(Math.max(1, Math.round(timeoutMs / 1000)));
    const tool = lockTool() ?? "";
    return process.platform === "darwin" ? [tool, "-k", "-s", "-t", seconds, path] : [tool, "-o", "-w", seconds, "-E", "75", path];
}
function isOverlapping(first, second) {
    const normalizedFirst = first.normalize("NFC").toLowerCase();
    const normalizedSecond = second.normalize("NFC").toLowerCase();
    return normalizedFirst === normalizedSecond || isInside(normalizedFirst, normalizedSecond) || isInside(normalizedSecond, normalizedFirst);
}
function isProtectedName(name) {
    return /^(?:\.git|node_modules|package\.json)$/i.test(name) || /\.lock$/i.test(name);
}
function treeReason(path) {
    let entry;
    try {
        entry = lstatSync(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return "";
        throw error;
    }
    if (!entry.isDirectory())
        return "";
    for (const name of readdirSync(path)) {
        if (isProtectedName(name))
            return "a cleanup path contains protected package files or locks.";
        const reason = treeReason(resolve(path, name));
        if (reason)
            return reason;
    }
    return "";
}
export function cleanupPathReason(spec) {
    if (spec.cleanupPaths === undefined)
        return "";
    if (!Array.isArray(spec.cleanupPaths))
        return "cleanupPaths must be an array of literal relative paths.";
    const root = resolve(spec.packageRoot);
    if (lstatSync(root).isSymbolicLink())
        return "the cleanup package root must not be a symbolic link.";
    const protectedPaths = [spec.binary, stampPath(spec), lockPath(spec), ...spec.inputs];
    for (const path of spec.cleanupPaths) {
        if (typeof path !== "string" || !path || /[\x00-\x1f\x7f\\:*?\[\]{}]/.test(path) || isAbsolute(path) || path.split("/").some((part) => !part || part === "." || part === ".." || isProtectedName(part)))
            return "cleanup paths must be nonempty literal package-relative paths without traversal, magic or protected names.";
        const target = resolve(root, path);
        if (!isInside(root, target) || protectedPaths.some((protectedPath) => isOverlapping(target, resolve(root, protectedPath))))
            return "a cleanup path overlaps build inputs, the binary, stamp or lock.";
    }
    return "";
}
export async function cleanupReason(spec) {
    const pathReason = cleanupPathReason(spec);
    if (pathReason || spec.cleanupPaths === undefined || !spec.cleanupPaths.length)
        return pathReason;
    const root = realpathSync(spec.packageRoot);
    const inputFiles = (await git(root, ["ls-files", "-z", "--", ...spec.inputs])).split("\0").filter(Boolean);
    const gitDirectory = realPath(resolve(root, await git(root, ["rev-parse", "--absolute-git-dir"])));
    const commonDirectory = realPath(resolve(root, await git(root, ["rev-parse", "--git-common-dir"])));
    const outputPaths = [resolve(spec.packageRoot, spec.binary), stampPath(spec), lockPath(spec)].map(realPath);
    for (const path of spec.cleanupPaths) {
        const target = resolve(root, path);
        if ([gitDirectory, commonDirectory].some((directory) => isOverlapping(target, directory)))
            return "a cleanup path overlaps Git metadata.";
        if (outputPaths.some((output) => isOverlapping(target, output)))
            return "a cleanup path overlaps the resolved binary, stamp or lock.";
        if (inputFiles.some((input) => isOverlapping(target, resolve(root, input))))
            return "a cleanup path overlaps build inputs.";
        let ancestor = root;
        for (const part of path.split("/")) {
            ancestor = resolve(ancestor, part);
            try {
                if (lstatSync(ancestor).isSymbolicLink())
                    return "a cleanup path has a symbolic link target or ancestor.";
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
        if (await git(root, ["ls-files", "-z", "--", `:(literal,icase)${path}`]))
            return "a cleanup path contains tracked files.";
        const reason = treeReason(target);
        if (reason)
            return reason;
    }
    return "";
}
export async function refusalReason(spec) {
    return (await buildRefusalReason(spec)) || await cleanupReason(spec);
}
export async function buildRefusalReason(spec) {
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
    if (spec.isUpstreamRequired) {
        let upstream;
        try {
            upstream = await git(spec.packageRoot, ["rev-parse", "--verify", "@{upstream}^{commit}"]);
        }
        catch {
            return "the checkout has no fetched upstream branch, and this package builds only the fetched upstream commit.";
        }
        const head = await git(spec.packageRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
        if (head !== upstream)
            return `HEAD ${head.slice(0, 12)} is not the fetched upstream commit ${upstream.slice(0, 12)}, and this package builds only the fetched upstream commit.`;
    }
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
