import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BuildError, ensureBuilt, lockPath, type BuildSpec } from "./index.ts";

function checkout(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-build-on-use-test-"));
	writeFileSync(join(root, "source.txt"), "v1\n");
	writeFileSync(join(root, ".gitignore"), "bin/\ncount\n");
	for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]]) execFileSync("git", ["-C", root, ...args]);
	return root;
}

function spec(root: string, script: string, timeoutMs?: number): BuildSpec {
	return { packageRoot: root, binary: "bin/tool", buildCommand: ["/bin/zsh", "-fc", script], inputs: ["source.txt"], timeoutMs };
}

test("refuses to build when an input has uncommitted changes, so modified code is never built", async () => {
	const root = checkout();
	writeFileSync(join(root, "source.txt"), "tampered\n");
	await assert.rejects(ensureBuilt(spec(root, "mkdir -p bin && touch bin/tool")), (error: BuildError) => error.code === "build-refused");
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
});

test("an override binary skips the build, so a prebuilt tool is used as is", async () => {
	const root = checkout();
	process.env.PI_BUILD_ON_USE_TEST_TOOL = "/usr/bin/true";
	assert.equal(await ensureBuilt({ ...spec(root, "exit 1"), overrideEnv: "PI_BUILD_ON_USE_TEST_TOOL" }), "/usr/bin/true");
	delete process.env.PI_BUILD_ON_USE_TEST_TOOL;
});

test("kills the whole process group on timeout, so a hung build leaves no orphans", async () => {
	const root = checkout();
	await assert.rejects(ensureBuilt(spec(root, "sleep 30 & print $! > grandchild; wait", 300)), (error: BuildError) => error.code === "build-timeout");
	const pid = Number(readFileSync(join(root, "grandchild"), "utf8"));
	await new Promise((done) => setTimeout(done, 100));
	assert.throws(() => process.kill(pid, 0));
});

test("a lock left by a dead process is taken over, so a crashed session does not block builds forever", async () => {
	const root = checkout();
	const build = spec(root, "mkdir -p bin && touch bin/tool");
	const dead = spawn("/usr/bin/true");
	await new Promise((done) => dead.on("close", done));
	writeFileSync(lockPath(build), String(dead.pid));
	assert.equal(await ensureBuilt(build), join(root, "bin/tool"));
	assert.equal(existsSync(lockPath(build)), false);
});

test("a lock held by a live process makes another session wait, so two sessions never build at once", async () => {
	const root = checkout();
	const build = spec(root, "mkdir -p bin && touch bin/tool");
	writeFileSync(lockPath(build), String(process.ppid));
	const result = ensureBuilt(build);
	await new Promise((done) => setTimeout(done, 400));
	assert.equal(existsSync(join(root, "bin/tool")), false);
	unlinkSync(lockPath(build));
	assert.equal(await result, join(root, "bin/tool"));
});

test("the shipped dist matches the source, so consumers never run stale code", () => {
	const out = mkdtempSync(join(tmpdir(), "pi-build-on-use-dist-"));
	const root = join(import.meta.dirname, "..");
	execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(root, "tsconfig.build.json"), "--outDir", out]);
	for (const file of ["index.js", "index.d.ts"]) assert.equal(readFileSync(join(root, "dist", file), "utf8"), readFileSync(join(out, file), "utf8"), file);
	rmSync(out, { recursive: true });
});

test("concurrent callers share one in-flight build, so the tool is not built twice", async () => {
	const root = checkout();
	const build = spec(root, "print x >> count; sleep 0.3; mkdir -p bin && touch bin/tool");
	const [first, second] = await Promise.all([ensureBuilt(build), ensureBuilt(build)]);
	assert.equal(first, second);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
});
