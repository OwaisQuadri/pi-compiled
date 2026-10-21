# pi-build-on-use

Builds a Pi extension's compiled tool (Swift, Rust, anything with a build command) the first time it is needed, instead of a manual setup script.

It refuses to build unless the package is its own Git checkout and every build input is committed, with no untracked or ignored files. An agent therefore cannot get modified code built and signed.

## API

```ts
ensureBuilt(spec: BuildSpec): Promise<string>
isBuildNeeded(spec: BuildSpec): boolean
binaryPath(spec: BuildSpec): string
refusalReason(spec: BuildSpec): Promise<string>

interface BuildSpec {
  packageRoot: string;      // absolute path of the consumer's Git checkout
  binary: string;           // path of the built tool, relative to packageRoot
  buildCommand: string[];   // argv, run in packageRoot
  inputs: string[];         // Git pathspecs that must be clean
  envAllowlist?: string[];  // added to PATH HOME USER LOGNAME TMPDIR DEVELOPER_DIR
  overrideEnv?: string;     // env var naming a prebuilt binary; skips the build
  timeoutMs?: number;       // default 600000
}

class BuildError extends Error { code: "build-refused" | "build-failed" | "build-timeout" }
```

`ensureBuilt` returns the absolute binary path. The build runs in its own process group with only allowlisted variables. On timeout the whole group is killed. Concurrent calls in one process share one build, and a lock file in the temp directory serializes builds across Pi sessions. The binary must exist after the build.

`refusalReason` returns an empty string when a build is allowed. Use it with `isBuildNeeded` to ask the user before building.

## Consumer

`package.json` (replace `<owner>` with the GitHub account that hosts this repository):

```json
"dependencies": { "pi-build-on-use": "github:<owner>/pi-build-on-use#v0.1.0" }
```

`extension/index.ts`:

```ts
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "pi-build-on-use";

const helper = {
  packageRoot: fileURLToPath(new URL("..", import.meta.url)),
  binary: "bin/my-helper",
  buildCommand: ["/bin/zsh", "-f", "scripts/build.zsh"],
  inputs: ["Package.swift", "Package.resolved", "Sources", "scripts"],
  envAllowlist: ["MY_SIGNING_IDENTITY"],
  overrideEnv: "MY_HELPER",
};

pi.on("session_start", async (_event, ctx) => {
  try { await ensureBuilt(helper); }
  catch (error) { ctx.ui.notify(`my-extension: ${(error as Error).message}`, "warning"); }
});
```

Keep the binary's output directory out of `inputs`, and list it in `.gitignore`.
