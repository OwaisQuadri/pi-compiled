import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { BuildError, ensureBuilt, isBuildNeeded, lockPath, type BuildSpec } from "./index.ts";

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
	await assert.rejects(ensureBuilt({ ...spec(remote, "true"), isUpstreamRequired: true }), (error: BuildError) => error.code === "build-refused" && /no upstream branch/.test(error.message));
});

test("a package that Git cannot check still reports that it needs a build, so the refusal reaches the user", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-compiled-plain-"));
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin/tool"), "");
	assert.equal(await isBuildNeeded(spec(root, "true")), true);
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
	for (const file of ["index.js", "index.d.ts"]) assert.equal(readFileSync(join(root, "dist", file), "utf8"), readFileSync(join(out, file), "utf8"), file);
	rmSync(out, { recursive: true });
});

test("concurrent callers share one in-flight build, so the tool is not built twice", async () => {
	const root = checkout();
	const build = spec(root, "echo x >> count; sleep 0.3; mkdir -p bin && touch bin/tool");
	const [first, second] = await Promise.all([ensureBuilt(build), ensureBuilt(build)]);
	assert.equal(first, second);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
});
