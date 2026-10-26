import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BuildError, stampPath } from "./index.js";
import { buildRefusalReason, cleanupPathReason, cleanupReason, inputsFingerprint, lockCommand } from "./validation.js";
async function cleanup(spec) {
    for (const path of spec.cleanupPaths ?? []) {
        try {
            const reason = await cleanupReason({ ...spec, cleanupPaths: [path] });
            if (reason)
                throw new Error(reason);
            rmSync(resolve(spec.packageRoot, path), { recursive: true, force: true });
        }
        catch {
            process.stderr.write("Pi cleanup deferred: generated output could not be safely removed; retry on next load.\n");
            return;
        }
    }
}
async function build(spec) {
    const key = resolve(spec.packageRoot, spec.binary);
    const pathReason = cleanupPathReason(spec);
    if (pathReason)
        throw new BuildError("build-refused", pathReason);
    let fingerprint;
    try {
        fingerprint = await inputsFingerprint(spec);
    }
    catch (error) {
        if (!spec.isGitVerificationRequired && existsSync(key))
            return;
        throw error;
    }
    const refusal = await buildRefusalReason(spec);
    if (refusal)
        throw new BuildError("build-refused", refusal);
    let stamp = "";
    try {
        stamp = readFileSync(stampPath(spec), "utf8");
    }
    catch { }
    if (existsSync(key) && statSync(key).isFile() && stamp === fingerprint) {
        await cleanup(spec);
        return;
    }
    const cleanupRefusal = await cleanupReason(spec);
    if (cleanupRefusal)
        throw new BuildError("build-refused", cleanupRefusal);
    await new Promise((done, reject) => {
        const [command = "", ...args] = spec.buildCommand;
        const isAdopted = spec.cleanupPaths !== undefined;
        const child = spawn(command, args, { cwd: spec.packageRoot, stdio: isAdopted ? ["ignore", "pipe", "pipe"] : "inherit" });
        child.stdout?.pipe(process.stdout, { end: false });
        child.stderr?.pipe(process.stderr, { end: false });
        child.once("error", reject);
        child.once(isAdopted ? "close" : "exit", (status) => status === 0 ? done() : reject(new BuildError("build-failed", "The build command failed.")));
    });
    if (!existsSync(key) || !statSync(key).isFile())
        throw new BuildError("build-failed", "The build finished but its output is missing or is not a file.");
    const temporary = `${stampPath(spec)}.${process.pid}.tmp`;
    writeFileSync(temporary, fingerprint, { flag: "wx" });
    renameSync(temporary, stampPath(spec));
    await cleanup(spec);
}
async function withPackageLock(spec) {
    const key = resolve(spec.packageRoot, spec.binary);
    let refusal = cleanupPathReason(spec);
    if (!refusal) {
        try {
            refusal = await buildRefusalReason(spec);
        }
        catch (error) {
            if (spec.isGitVerificationRequired || !existsSync(key))
                throw error;
        }
    }
    if (refusal)
        throw new BuildError("build-refused", refusal);
    mkdirSync(dirname(key), { recursive: true });
    const [command = "", ...args] = lockCommand(`${key}.lock`, spec.timeoutMs ?? 600_000);
    return new Promise((done, reject) => {
        const child = spawn(command, [...args, process.execPath, fileURLToPath(import.meta.url), JSON.stringify(spec)], { cwd: spec.packageRoot, stdio: "inherit" });
        child.once("error", reject);
        child.once("exit", (status) => done(status ?? 1));
    });
}
try {
    const spec = JSON.parse(process.argv[2] ?? "");
    if (process.argv[3] === "package")
        process.exitCode = await withPackageLock(spec);
    else
        await build(spec);
}
catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "The build failed."}\n`);
    process.exitCode = error instanceof BuildError && error.code === "build-refused" ? 77 : 1;
}
