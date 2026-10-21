import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BuildError, ensureBuilt, type BuildSpec } from "./index.ts";

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

test("kills the whole process group on timeout, so a hung build leaves no orphans", async () => {
	const root = checkout();
	await assert.rejects(ensureBuilt(spec(root, "sleep 30 & print $! > grandchild; wait", 300)), (error: BuildError) => error.code === "build-timeout");
	const pid = Number(readFileSync(join(root, "grandchild"), "utf8"));
	await new Promise((done) => setTimeout(done, 100));
	assert.throws(() => process.kill(pid, 0));
});

test("concurrent callers share one in-flight build, so the tool is not built twice", async () => {
	const root = checkout();
	const build = spec(root, "print x >> count; sleep 0.3; mkdir -p bin && touch bin/tool");
	const [first, second] = await Promise.all([ensureBuilt(build), ensureBuilt(build)]);
	assert.equal(first, second);
	assert.equal(readFileSync(join(root, "count"), "utf8"), "x\n");
});
