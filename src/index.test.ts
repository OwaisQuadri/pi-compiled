import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { BuildError, ensureBuilt, isBuildNeeded, lockPath, packageLockPath, progressBar, progressOf, stampPath, type BuildProgress, type BuildSpec } from "./index.ts";

function checkout(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-compiled-test-"));
	writeFileSync(join(root, "source.txt"), "v1\n");
	writeFileSync(join(root, ".gitignore"), "bin/\ncount\n");
	for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) execFileSync("git", ["-C", root, ...args]);
	return root;
}

function spec(root: string, script: string, timeoutMs?: number): BuildSpec {
	return { packageRoot: root, binary: "bin/tool", buildCommand: ["/bin/sh", "-c", script], inputs: ["source.txt"], timeoutMs };
}

test("refuses to build when an input has uncommitted changes, so modified code is never built", async () => {
	const root = checkout();
	writeFileSync(join(root, "source.txt"), "tampered\n");
	await assert.rejects(ensureBuilt(spec(root, "mkdir -p bin && touch bin/tool")), (error: BuildError) => error.code === "build-refused");
	for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
		execFileSync("git", ["-C", root, "update-index", flag, "source.txt"]);
		await assert.rejects(ensureBuilt(spec(root, "mkdir -p bin && touch bin/tool")), (error: BuildError) => error.code === "build-refused" && /assume-unchanged or skip-worktree/.test(error.message));
		execFileSync("git", ["-C", root, "update-index", flag.replace("--", "--no-"), "source.txt"]);
	}
});

test("refuses ignored files and paths outside the package, so nothing unreviewed reaches the build", async () => {
	const root = checkout();
	const build = { ...spec(root, "mkdir -p bin && touch bin/tool"), inputs: ["source.txt", "bin"] };
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin/extra"), "x");
	await assert.rejects(ensureBuilt(build), (error: BuildError) => error.code === "build-refused" && /ignored/.test(error.message));
	for (const inputs of [["../outside"], [":(top)source.txt"]]) {
		await assert.rejects(ensureBuilt({ ...spec(root, "true"), inputs }), (error: BuildError) => error.code === "build-refused" && /not inside/.test(error.message));
	}
	await assert.rejects(ensureBuilt({ ...spec(root, "true"), buildCommand: ["make"] }), (error: BuildError) => error.code === "build-refused" && /absolute/.test(error.message));
	await assert.rejects(ensureBuilt({ ...spec(root, "true"), inputs: ["sourcee.txt"] }), (error: BuildError) => error.code === "build-refused" && /does not match a committed file/.test(error.message));
	symlinkSync(tmpdir(), join(root, "outside"));
	await assert.rejects(ensureBuilt({ ...spec(root, "true"), inputs: ["outside"] }), (error: BuildError) => error.code === "build-refused" && /symbolic link/.test(error.message));
	symlinkSync("source.txt", join(root, "alias"));
	execFileSync("git", ["-C", root, "add", "alias"]);
	execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "alias"]);
	await assert.rejects(ensureBuilt({ ...spec(root, "true"), inputs: ["alias"] }), (error: BuildError) => error.code === "build-refused" && /symbolic links/.test(error.message));
});

test("with isUpstreamRequired, builds only the fetched upstream commit, so a commit made in the installed clone is never built", async () => {
	const remote = checkout();
	const root = mkdtempSync(join(tmpdir(), "pi-compiled-clone-"));
	execFileSync("git", ["clone", "-q", remote, root]);
	const build = { ...spec(root, "mkdir -p bin && touch bin/tool"), isUpstreamRequired: true };
	writeFileSync(join(root, "source.txt"), "local\n");
	execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "local"]);
	await assert.rejects(ensureBuilt(build), (error: BuildError) => error.code === "build-refused" && /not the fetched upstream commit/.test(error.message));
	execFileSync("git", ["-C", root, "reset", "-q", "--hard", "@{upstream}"]);
	assert.equal(await ensureBuilt(build), join(root, "bin/tool"));
	await assert.rejects(ensureBuilt({ ...spec(remote, "true"), isUpstreamRequired: true }), (error: BuildError) => error.code === "build-refused" && /no fetched upstream branch/.test(error.message));
});

test("a built binary in a package that Git cannot check is used as is, so a working tool never becomes unusable", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-compiled-plain-"));
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin/tool"), "");
	assert.equal(await isBuildNeeded(spec(root, "true")), false);
	assert.equal(await ensureBuilt(spec(root, "exit 1")), join(root, "bin/tool"));
});

test("build output reaches onProgress line by line with step counts, so the user sees how far the build is", async () => {
	const root = checkout();
	const seen: BuildProgress[] = [];
	await ensureBuilt(spec(root, "printf 'Building\\n[1/4] Compiling a\\n'; sleep 0.1; printf '[2/4] Comp'; sleep 0.1; printf 'iling b\\n'; printf 'a warning\\n' >&2; mkdir -p bin && touch bin/tool"), { onProgress: (progress) => seen.push(progress) });
	assert.deepEqual(seen.filter((progress) => progress.line !== "a warning"), [{ line: "Building" }, { line: "Compiling a", completed: 1, total: 4 }, { line: "Compiling b", completed: 2, total: 4 }]);
	assert.ok(seen.some((progress) => progress.line === "a warning"));
	rmSync(join(root, "bin/tool"));
	const first: string[] = [];
	const second: string[] = [];
	const slow = spec(root, "sleep 0.3; mkdir -p bin && touch bin/tool; printf 'Build complete!'");
	await Promise.all([ensureBuilt(slow, { onProgress: (progress) => { first.push(progress.line); } }), ensureBuilt(slow, { onProgress: async (progress) => { second.push(progress.line); throw new Error("ignored"); } })]);
	assert.deepEqual(first, ["Build complete!"]);
	assert.deepEqual(second, ["Build complete!"]);
	assert.equal(progressBar({ line: "Compiling a", completed: 1, total: 4 }, 8), "[██░░░░░░] 1/4 Compiling a");
	assert.equal(progressBar({ line: "Linking" }), "Linking");
	assert.equal(progressBar({ line: "\x1b[1;32mLinking\x1b[0m\r\x07" }), "Linking");
	assert.equal(progressBar({ line: "x".repeat(500) }).length, 120);
	assert.equal(progressBar({ line: "\x1b[38:5:196mred\x1b[>4;1m \x1b]8;;https://e.x\x07link\x1b]8;;\x1b\\ \x1b(Bdone" }), "red link done");
	assert.equal(progressBar({ line: "open \x1b]8;;https://e.x" }), "open ");
	assert.equal(progressBar({ line: "a\x1b]8;;https://e.x\x1bXb" }), "aXb");
	assert.equal(progressBar({ line: "x".repeat(119) + "😀" }), "x".repeat(119) + "😀");
	assert.equal(progressBar({ line: "x".repeat(120) + "😀" }), "x".repeat(120));
	assert.deepEqual(progressOf("[98 / 103] Compiling c"), { line: "Compiling c", completed: 98, total: 103 });
});

test("a build that exits 75 is a failure, not a busy lock, so a broken build is never retried as busy", async () => {
	await assert.rejects(ensureBuilt(spec(checkout(), "exit 75")), (error: BuildError) => error.code === "build-failed");
});

test("an override binary skips the build, so a prebuilt tool is used as is", async () => {
	const root = checkout();
	process.env.PI_COMPILED_TEST_TOOL = "/usr/bin/true";
	assert.equal(await ensureBuilt({ ...spec(root, "exit 1"), overrideEnv: "PI_COMPILED_TEST_TOOL" }), "/usr/bin/true");
	for (const path of [join(root, "missing"), "true"]) {
		process.env.PI_COMPILED_TEST_TOOL = path;
		await assert.rejects(ensureBuilt({ ...spec(root, "exit 1"), overrideEnv: "PI_COMPILED_TEST_TOOL" }), (error: BuildError) => error.code === "build-failed");
	}
	delete process.env.PI_COMPILED_TEST_TOOL;
});

test("kills the whole process group on timeout, so a hung build leaves no orphans", async () => {
	const root = checkout();
	await assert.rejects(ensureBuilt(spec(root, "sleep 30 & echo $! > grandchild; wait", 300)), (error: BuildError) => error.code === "build-timeout");
	const pid = Number(readFileSync(join(root, "grandchild"), "utf8"));
	await new Promise((done) => setTimeout(done, 100));
	assert.throws(() => process.kill(pid, 0));
});

test("a build that leaves a process holding stdout succeeds promptly, so a toolchain daemon does not hold up the result", async () => {
	const root = checkout();
	const started = Date.now();
	assert.equal(await ensureBuilt(spec(root, "sleep 30 & echo $! > daemon; mkdir -p bin && touch bin/tool", 5000)), join(root, "bin/tool"));
	assert.ok(Date.now() - started < 3000);
	process.kill(Number(readFileSync(join(root, "daemon"), "utf8")), "SIGKILL");
});

test("a build that leaves a process holding stderr succeeds and releases the lock, so a toolchain daemon neither fakes a timeout nor blocks later builds", async () => {
	const root = checkout();
	const build = spec(root, "sleep 30 >&2 & echo $! > daemon; mkdir -p bin && touch bin/tool", 300);
	assert.equal(await ensureBuilt(build), join(root, "bin/tool"));
	rmSync(join(root, "bin/tool"));
	assert.equal(await ensureBuilt({ ...build, buildCommand: ["/bin/sh", "-c", "touch bin/tool"] }), join(root, "bin/tool"));
	process.kill(Number(readFileSync(join(root, "daemon"), "utf8")), "SIGKILL");
});

function holdLock(lock: string, script: string) {
	mkdirSync(dirname(lock), { recursive: true });
	const tool = process.platform === "darwin" ? ["/usr/bin/lockf", "-k"] : [existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock"];
	return spawn(tool[0] ?? "", [...tool.slice(1), lock, "/bin/sh", "-c", script], { cwd: dirname(dirname(lock)), detached: true });
}

test("two Pi processes building at once run one build, so sessions never build over each other", async () => {
	const root = checkout();
	const build = spec(root, "echo x >> count; sleep 0.5; mkdir -p bin && touch bin/tool");
	const script = `const { ensureBuilt } = await import(${JSON.stringify(join(import.meta.dirname, "index.ts"))}); await ensureBuilt(${JSON.stringify(build)});`;
	const other = spawn(process.execPath, ["--input-type=module", "-e", script]);
	const [status] = await Promise.all([new Promise((done) => other.on("close", done)), ensureBuilt(build)]);
	assert.equal(status, 0);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
});

test("a binary built from older inputs is rebuilt, so pi update never keeps a stale tool", async () => {
	const root = checkout();
	const build = spec(root, "echo x >> count; mkdir -p bin && touch bin/tool");
	await ensureBuilt(build);
	await ensureBuilt(build);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
	writeFileSync(join(root, "source.txt"), "v2\n");
	execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "v2"]);
	assert.equal(await isBuildNeeded(build), true);
	await ensureBuilt(build);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\nx\n");
	assert.equal(await isBuildNeeded(build), false);
	assert.equal(await isBuildNeeded({ ...build, inputs: ["source.txt", ".gitignore"] }), true);
});

test("a lock is released when its holder dies, and a held lock fails as busy, so a crashed session never blocks builds", async () => {
	const root = checkout();
	const build = spec(root, "mkdir -p bin && touch bin/tool", 1000);
	const holder = holdLock(lockPath(build), "sleep 30");
	await new Promise((done) => setTimeout(done, 200));
	await assert.rejects(ensureBuilt(build), (error: BuildError) => error.code === "build-busy");
	process.kill(-(holder.pid ?? 0), "SIGKILL");
	await new Promise((done) => holder.on("close", done));
	assert.equal(await ensureBuilt(build), join(root, "bin/tool"));
});

test("the shipped dist matches the source, so consumers never run stale code", () => {
	const out = mkdtempSync(join(tmpdir(), "pi-compiled-dist-"));
	const root = join(import.meta.dirname, "..");
	execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(root, "tsconfig.build.json"), "--outDir", out]);
	assert.deepEqual(readdirSync(join(root, "dist")).sort(), readdirSync(out).sort());
	for (const file of readdirSync(out)) assert.equal(readFileSync(join(root, "dist", file), "utf8"), readFileSync(join(out, file), "utf8"), file);
	rmSync(out, { recursive: true });
});

test("concurrent callers share one in-flight build, so the tool is not built twice", async () => {
	const root = checkout();
	const build = spec(root, "echo x >> count; sleep 0.3; mkdir -p bin && touch bin/tool");
	const [first, second] = await Promise.all([ensureBuilt(build), ensureBuilt(build)]);
	assert.equal(first, second);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
});

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!existsSync(path) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
	assert.ok(existsSync(path), path);
}

function stopHolder(holder: ReturnType<typeof holdLock>): Promise<void> {
	const stopped = new Promise<void>((done) => holder.once("close", () => done()));
	process.kill(-(holder.pid ?? 0), "SIGKILL");
	return stopped;
}

test("dangerous cleanup declarations are refused before building or deleting working files", async () => {
	const root = checkout();
	const outside = mkdtempSync(join(tmpdir(), "pi-compiled-sentinel-"));
	writeFileSync(join(outside, "keep"), "outside");
	mkdirSync(join(root, "tracked"));
	writeFileSync(join(root, "tracked/keep"), "tracked");
	execFileSync("git", ["-C", root, "add", "tracked"]);
	execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "tracked"]);
	renameSync(join(root, ".git"), join(root, "metadata"));
	writeFileSync(join(root, ".git"), "gitdir: metadata\n");
	symlinkSync(outside, join(root, "alias"));
	symlinkSync("missing", join(root, "dangling"));
	mkdirSync(join(root, "scratch"));
	writeFileSync(join(root, "scratch/live.lock"), "lock");
	const paths = ["", ".", "..", "/", outside, "../outside", "a/../scratch", "a//b", "scratch/", "*.tmp", "a?", "[ab]", "{a,b}", ":(top)scratch", "a\\b", ".git", ".GIT/objects", "node_modules/cache", "package.json", "bin", "bin/tool", "bin/tool.stamp", "bin/tool.lock", "BIN/TOOL", "source.txt", "tracked", "TRACKED", "metadata", "alias", "alias/keep", "dangling", "scratch"];
	for (const path of paths) {
		await assert.rejects(ensureBuilt({ ...spec(root, "echo built > count; touch bin/tool"), cleanupPaths: [path] }), (error: BuildError) => error.code === "build-refused", path);
	}
	assert.equal(existsSync(join(root, "count")), false);
	assert.equal(existsSync(stampPath(spec(root, "true"))), false);
	assert.equal(readFileSync(join(outside, "keep"), "utf8"), "outside");
	assert.equal(readFileSync(join(root, "tracked/keep"), "utf8"), "tracked");
	assert.equal(readFileSync(join(root, "scratch/live.lock"), "utf8"), "lock");
	symlinkSync(root, join(outside, "package"));
	await assert.rejects(ensureBuilt({ ...spec(join(outside, "package"), "true"), cleanupPaths: [] }), (error: BuildError) => error.code === "build-refused");
});

test("successful cleanup keeps the binary and stamp and missing scratch does not rebuild", async () => {
	const root = checkout();
	const outside = mkdtempSync(join(tmpdir(), "pi-compiled-sentinel-"));
	writeFileSync(join(outside, "keep"), "outside");
	mkdirSync(join(root, "scratch"));
	symlinkSync(outside, join(root, "scratch/outside-alias"));
	const build = { ...spec(root, "echo x >> count; mkdir -p bin scratch; echo scratch > scratch/cache; ln -s ../source.txt scratch/input-alias; echo working > bin/new; mv bin/new bin/tool"), cleanupPaths: ["scratch", "missing"] };
	assert.equal(await ensureBuilt(build), join(root, "bin/tool"));
	assert.equal(existsSync(join(root, "scratch")), false);
	assert.equal(await isBuildNeeded(build), false);
	await ensureBuilt(build);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "working\n");
	assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "v1\n");
	assert.equal(readFileSync(join(outside, "keep"), "utf8"), "outside");
	assert.ok(existsSync(lockPath(build)));
	assert.ok(existsSync(packageLockPath(root)));
});

test("failed or timed-out builds preserve a working binary and stamp and never clean scratch", async () => {
	const root = checkout();
	await ensureBuilt(spec(root, "echo working > bin/tool"));
	const stamp = readFileSync(stampPath(spec(root, "true")), "utf8");
	for (const [script, code] of [["exit 1", "build-failed"], ["sleep 30", "build-timeout"]]) {
		await assert.rejects(ensureBuilt({ ...spec(root, `mkdir -p scratch; echo keep > scratch/cache; ${script}`, 500), cleanupPaths: ["scratch"] }), (error: BuildError) => error.code === code);
		assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "working\n");
		assert.equal(readFileSync(stampPath(spec(root, "true")), "utf8"), stamp);
		assert.equal(readFileSync(join(root, "scratch/cache"), "utf8"), "keep\n");
	}
	writeFileSync(join(root, "source.txt"), "dirty\n");
	await assert.rejects(ensureBuilt({ ...spec(root, "true"), cleanupPaths: ["scratch"] }), (error: BuildError) => error.code === "build-refused");
	assert.equal(readFileSync(stampPath(spec(root, "true")), "utf8"), stamp);
	assert.ok(existsSync(join(root, "scratch/cache")));
});

test("zero exit without a binary neither stamps success nor removes scratch", async () => {
	const root = checkout();
	const build = { ...spec(root, "mkdir scratch; touch scratch/keep"), cleanupPaths: ["scratch"] };
	await assert.rejects(ensureBuilt(build), (error: BuildError) => error.code === "build-failed");
	assert.equal(existsSync(stampPath(build)), false);
	assert.ok(existsSync(join(root, "scratch/keep")));
});

test("cleanup refusal after a build retries without recompilation and never unlinks a lock", async () => {
	const root = checkout();
	const build = { ...spec(root, "echo x >> count; mkdir scratch; touch scratch/live.lock; echo working > bin/tool"), cleanupPaths: ["scratch"] };
	const seen: string[] = [];
	assert.equal(await ensureBuilt(build, { onProgress: ({ line }) => seen.push(line) }), join(root, "bin/tool"));
	assert.deepEqual(seen, ["Pi cleanup deferred: generated output could not be safely removed; retry on next load."]);
	const inode = statSync(join(root, "scratch/live.lock")).ino;
	const holder = holdLock(join(root, "scratch/live.lock"), `touch '${join(root, "inner-ready")}'; sleep 30`);
	await waitForFile(join(root, "inner-ready"));
	try {
		await ensureBuilt(build);
		assert.equal(statSync(join(root, "scratch/live.lock")).ino, inode);
	} finally {
		await stopHolder(holder);
	}
	rmSync(join(root, "scratch/live.lock"));
	await ensureBuilt(build);
	assert.equal(existsSync(join(root, "scratch")), false);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
});

test("a filesystem cleanup failure returns usable output and retries matching inputs", { skip: process.getuid?.() === 0 }, async () => {
	const root = checkout();
	const build = { ...spec(root, "echo x >> count; mkdir scratch; touch scratch/cache; chmod 500 scratch; echo working > bin/tool"), cleanupPaths: ["scratch"] };
	const seen: string[] = [];
	await ensureBuilt(build, { onProgress: ({ line }) => seen.push(line) });
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "working\n");
	assert.equal(await isBuildNeeded(build), false);
	assert.ok(seen.some((line) => line.startsWith("Pi cleanup deferred:")));
	chmodSync(join(root, "scratch"), 0o700);
	await ensureBuilt(build);
	assert.equal(existsSync(join(root, "scratch")), false);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
});

test("cleanup opt-in waits for the outer package lock even on a matching binary and survives owner death", async () => {
	const root = checkout();
	const build = { ...spec(root, "echo x >> count; touch bin/tool", 1000), cleanupPaths: [] };
	await ensureBuilt(build);
	const lock = packageLockPath(root);
	assert.equal(lock, join(realpathSync(dirname(root)), `.${basename(root)}.pi-package.lock`));
	const inode = statSync(lock).ino;
	const holder = holdLock(lock, `touch '${join(root, "ready")}'; sleep 30`);
	await waitForFile(join(root, "ready"));
	try {
		await assert.rejects(ensureBuilt(build), (error: BuildError) => error.code === "build-busy");
		assert.equal(await ensureBuilt({ ...build, cleanupPaths: undefined }), join(root, "bin/tool"));
		const candidate = checkout();
		assert.notEqual(packageLockPath(candidate), lock);
		await ensureBuilt({ ...spec(candidate, "touch bin/tool"), cleanupPaths: [] });
	} finally {
		await stopHolder(holder);
	}
	await ensureBuilt(build);
	assert.equal(statSync(lock).ino, inode);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
});

test("committed inputs and cleanup targets are revalidated after waiting for the binary lock", async () => {
	const root = checkout();
	const build = { ...spec(root, "echo built > count; touch bin/tool", 5000), cleanupPaths: ["scratch"] };
	const holder = holdLock(lockPath(build), `touch '${join(root, "ready")}'; sleep 30`);
	await waitForFile(join(root, "ready"));
	const pending = ensureBuilt(build);
	await waitForFile(packageLockPath(root));
	await new Promise((done) => setTimeout(done, 200));
	writeFileSync(join(root, "source.txt"), "tampered\n");
	await stopHolder(holder);
	await assert.rejects(pending, (error: BuildError) => error.code === "build-refused");
	assert.equal(existsSync(join(root, "count")), false);
	execFileSync("git", ["-C", root, "checkout", "--", "source.txt"]);
	const second = holdLock(lockPath(build), `touch '${join(root, "ready2")}'; sleep 30`);
	await waitForFile(join(root, "ready2"));
	const cleanupPending = ensureBuilt(build);
	await new Promise((done) => setTimeout(done, 200));
	symlinkSync(tmpdir(), join(root, "scratch"));
	await stopHolder(second);
	await assert.rejects(cleanupPending, (error: BuildError) => error.code === "build-refused");
	assert.equal(existsSync(join(root, "count")), false);
});

test("two adopted compiler processes serialize build and cleanup under package and binary locks", async () => {
	const root = checkout();
	const build = { ...spec(root, "echo x >> count; sleep 0.3; mkdir scratch; touch scratch/cache; touch bin/tool"), cleanupPaths: ["scratch"] };
	const script = `const { ensureBuilt } = await import(${JSON.stringify(join(import.meta.dirname, "../dist/index.js"))}); await ensureBuilt(${JSON.stringify(build)});`;
	const other = spawn(process.execPath, ["--input-type=module", "-e", script]);
	const [status] = await Promise.all([new Promise((done) => other.once("close", done)), ensureBuilt(build)]);
	assert.equal(status, 0);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
	assert.equal(existsSync(join(root, "scratch")), false);
	assert.equal(await isBuildNeeded(build), false);
});

test("overrides and unverifiable Git fallback never grant cleanup permission", async () => {
	const root = checkout();
	mkdirSync(join(root, "scratch"));
	writeFileSync(join(root, "scratch/keep"), "keep");
	process.env.PI_COMPILED_TEST_TOOL = "/usr/bin/true";
	try {
		await ensureBuilt({ ...spec(root, "exit 1"), overrideEnv: "PI_COMPILED_TEST_TOOL", cleanupPaths: ["scratch"] });
	} finally {
		delete process.env.PI_COMPILED_TEST_TOOL;
	}
	assert.equal(existsSync(packageLockPath(root)), false);
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin/tool"), "working");
	rmSync(join(root, ".git"), { recursive: true });
	assert.equal(await ensureBuilt({ ...spec(root, "exit 1"), cleanupPaths: ["scratch"] }), join(root, "bin/tool"));
	assert.equal(readFileSync(join(root, "scratch/keep"), "utf8"), "keep");
	assert.equal(existsSync(stampPath(spec(root, "true"))), false);
});

test("a standalone host executable is never used as the private worker interpreter", async () => {
	const root = checkout();
	const standalone = join(root, "standalone");
	writeFileSync(standalone, `#!/bin/sh\nprintf launched > '${join(root, "wrong-runtime")}'\nexit 1\n`, { mode: 0o755 });
	const original = process.execPath;
	try {
		process.execPath = standalone;
		await ensureBuilt({ ...spec(root, "printf working > bin/tool"), cleanupPaths: [] });
	} finally {
		process.execPath = original;
	}
	assert.equal(existsSync(join(root, "wrong-runtime")), false);
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "working");
});

test("missing or unsupported Node refuses before binary stamp or cleanup mutation", async () => {
	const root = checkout();
	const build = { ...spec(root, "printf working > bin/tool"), cleanupPaths: ["scratch"] };
	await ensureBuilt(build);
	const stamp = readFileSync(stampPath(build), "utf8");
	mkdirSync(join(root, "scratch"));
	writeFileSync(join(root, "scratch/keep"), "keep");
	const runtimeDirectory = mkdtempSync(join(tmpdir(), "pi-compiled-runtime-"));
	const original = process.env.PATH;
	try {
		process.env.PATH = runtimeDirectory;
		for (const runtime of [undefined, { isNode: true, version: "22.18.0" }, { isNode: false, version: "26.0.0" }]) {
			if (runtime) writeFileSync(join(runtimeDirectory, "node"), `#!/bin/sh\nprintf '%s' '${JSON.stringify(runtime)}'\n`, { mode: 0o755 });
			await assert.rejects(ensureBuilt(build), (error: BuildError) => error.code === "build-refused" && /Node.js >=22.19.0/.test(error.message));
			assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "working");
			assert.equal(readFileSync(stampPath(build), "utf8"), stamp);
			assert.equal(readFileSync(join(root, "scratch/keep"), "utf8"), "keep");
		}
	} finally {
		if (original === undefined) delete process.env.PATH;
		else process.env.PATH = original;
	}
});

test("an outer package lock prevents creation of build files before package mutation finishes", async () => {
	const root = checkout();
	const build = { ...spec(root, "touch bin/tool", 1000), cleanupPaths: [] };
	const holder = holdLock(packageLockPath(root), `touch '${join(root, "ready")}'; sleep 30`);
	await waitForFile(join(root, "ready"));
	try {
		await assert.rejects(ensureBuilt(build), (error: BuildError) => error.code === "build-busy");
		assert.equal(existsSync(join(root, "bin")), false);
	} finally {
		await stopHolder(holder);
	}
	await ensureBuilt(build);
});

test("cleanup cannot delete the resolved target of an internal binary symlink", async () => {
	const root = checkout();
	mkdirSync(join(root, "bin"));
	mkdirSync(join(root, "scratch"));
	writeFileSync(join(root, "scratch/tool"), "working");
	symlinkSync("../scratch/tool", join(root, "bin/tool"));
	await assert.rejects(ensureBuilt({ ...spec(root, "echo built > count"), cleanupPaths: ["scratch"] }), (error: BuildError) => error.code === "build-refused");
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "working");
	assert.equal(existsSync(join(root, "count")), false);
});

test("failure and a surviving pipe writer retain scratch until a verified successful retry", async () => {
	const root = checkout();
	const script = "echo x >> count; mkdir -p scratch; printf keep > scratch/cache; if [ -f fail ]; then exit 1; fi; if [ -f hang ]; then (sleep 30 & echo $! > sleeper; wait; printf late > scratch/late) & echo $! > writer; exit 0; fi; cat source.txt > bin/new; mv bin/new bin/tool";
	const build = { ...spec(root, script, 1000), cleanupPaths: ["scratch"] };
	await ensureBuilt(build);
	const stamp = readFileSync(stampPath(build), "utf8");
	writeFileSync(join(root, "source.txt"), "v2\n");
	execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "v2"]);
	writeFileSync(join(root, "fail"), "");
	await assert.rejects(ensureBuilt(build), (error: BuildError) => error.code === "build-failed");
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "v1\n");
	assert.equal(readFileSync(stampPath(build), "utf8"), stamp);
	assert.equal(readFileSync(join(root, "scratch/cache"), "utf8"), "keep");
	rmSync(join(root, "fail"));
	writeFileSync(join(root, "hang"), "");
	let isSettled = false;
	const pending = ensureBuilt(build).then(() => undefined, (error: BuildError) => error).finally(() => { isSettled = true; });
	await waitForFile(join(root, "writer"));
	await waitForFile(join(root, "sleeper"));
	const writer = Number(readFileSync(join(root, "writer"), "utf8"));
	const sleeper = Number(readFileSync(join(root, "sleeper"), "utf8"));
	assert.doesNotThrow(() => process.kill(writer, 0));
	await new Promise((done) => setTimeout(done, 200));
	assert.equal(isSettled, false);
	assert.equal(readFileSync(join(root, "scratch/cache"), "utf8"), "keep");
	assert.equal((await pending)?.code, "build-timeout");
	await new Promise((done) => setTimeout(done, 100));
	assert.throws(() => process.kill(writer, 0));
	assert.throws(() => process.kill(sleeper, 0));
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "v1\n");
	assert.equal(readFileSync(stampPath(build), "utf8"), stamp);
	assert.equal(existsSync(join(root, "scratch/late")), false);
	rmSync(join(root, "hang"));
	await ensureBuilt(build);
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "v2\n");
	assert.notEqual(readFileSync(stampPath(build), "utf8"), stamp);
	assert.equal(existsSync(join(root, "scratch")), false);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\nx\nx\nx\n");
	assert.equal(await isBuildNeeded(build), false);
});

test("a killed adopted build group retains working output and scratch for a safe retry", async () => {
	const root = checkout();
	await ensureBuilt(spec(root, "printf working > bin/tool"));
	const stamp = readFileSync(stampPath(spec(root, "true")), "utf8");
	const build = { ...spec(root, "mkdir -p scratch; printf keep > scratch/cache; if [ -f hang ]; then ps -o pgid= -p $$ > group.tmp; mv group.tmp group; sleep 30; fi; printf rebuilt > bin/new; mv bin/new bin/tool", 5000), cleanupPaths: ["scratch"] };
	writeFileSync(join(root, "hang"), "");
	const pending = ensureBuilt(build).then(() => undefined, (error: BuildError) => error);
	await waitForFile(join(root, "group"));
	const group = Number(readFileSync(join(root, "group"), "utf8").trim());
	assert.ok(group > 0 && group !== process.pid);
	process.kill(-group, "SIGKILL");
	assert.equal((await pending)?.code, "build-failed");
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "working");
	assert.equal(readFileSync(stampPath(build), "utf8"), stamp);
	assert.equal(readFileSync(join(root, "scratch/cache"), "utf8"), "keep");
	rmSync(join(root, "hang"));
	await ensureBuilt(build);
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "rebuilt");
	assert.equal(existsSync(join(root, "scratch")), false);
	assert.equal(await isBuildNeeded(build), false);
});

test("a standalone Bun host dynamically loads the shipped compiler and uses external Node", (context) => {
	const bun = (process.env.PATH ?? "").split(delimiter).map((path) => join(path, "bun")).find((path) => existsSync(path));
	if (!bun) return context.skip("Bun is not available to build the standalone host fixture.");
	const root = checkout();
	const hostRoot = mkdtempSync(join(tmpdir(), "pi-compiled-host-"));
	context.after(() => rmSync(hostRoot, { recursive: true, force: true }));
	const entry = join(hostRoot, "host.ts");
	const host = join(hostRoot, "host");
	writeFileSync(entry, "const { ensureBuilt } = await import(process.argv[2]); console.log(JSON.stringify({ host: process.execPath, binary: await ensureBuilt(JSON.parse(process.argv[3])) }));\n");
	const compiled = spawnSync(bun, ["build", "--compile", `--compile-executable-path=${bun}`, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", entry, "--outfile", host], { cwd: hostRoot, encoding: "utf8", timeout: 30_000 });
	assert.equal(compiled.status, 0, compiled.stderr);
	assert.doesNotMatch(compiled.stdout + compiled.stderr, /\bwarn(?:ing)?\b/i);
	const build = { ...spec(root, "mkdir scratch; touch scratch/cache; printf working > bin/tool"), cleanupPaths: ["scratch"] };
	const result = execFileSync(host, [join(import.meta.dirname, "../dist/index.js"), JSON.stringify(build)], { encoding: "utf8", timeout: 10_000 });
	const loaded = JSON.parse(result) as { host: string; binary: string };
	assert.equal(realpathSync(loaded.host), realpathSync(host));
	assert.equal(loaded.binary, join(root, "bin/tool"));
	assert.equal(readFileSync(join(root, "bin/tool"), "utf8"), "working");
	assert.ok(existsSync(stampPath(build)));
	assert.equal(existsSync(join(root, "scratch")), false);
});
