# pi-build-on-use

Builds a Pi extension's compiled tool (Swift, Rust, anything with a build command) the first time it is needed, instead of a manual setup script.

It refuses to build unless the package is its own Git checkout and every build input is committed, with no untracked or ignored files. Inputs and the binary must be inside the package, also after symbolic links are resolved, and inputs must not contain committed symbolic links. Git runs with only `PATH` and `HOME` and with the file system monitor off, so the caller's Git variables cannot fake a clean result. This stops uncommitted code from being built and signed. It does not stop code that someone committed to the clone.

## API

```ts
ensureBuilt(spec: BuildSpec): Promise<string>
isBuildNeeded(spec: BuildSpec): boolean
binaryPath(spec: BuildSpec): string
lockPath(spec: BuildSpec): string
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

class BuildError extends Error { code: "build-refused" | "build-failed" | "build-timeout" | "build-busy" }
```

`lockPath` returns the lock file for a spec. `ensureBuilt` returns the absolute binary path. The build runs in its own process group with only allowlisted variables. Concurrent calls in one process share one build. Across Pi sessions, a kernel file lock on `<binary>.lock` serializes builds (`/usr/bin/lockf` on macOS, `/usr/bin/flock` or `/bin/flock` on Linux; without one the build is refused). The kernel releases it when the holder dies. A session waits up to `timeoutMs` for the lock, then fails with `build-busy`. After it gets the lock, it skips the build when another session already made the binary. When the lock wait and the build together pass twice `timeoutMs`, the whole group is killed (`build-timeout`). The binary must exist after the build.

The build command must start with an absolute path, so it does not depend on the caller's `PATH`. A build that exits with status 75 is reported as `build-failed`, not `build-busy`. An override binary must be an absolute path to an executable file. Build scripts must write the binary to a temporary file and rename it into place: a session that finds the binary without taking the lock uses it at once.

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

List specific paths in `inputs`, never `.`. Pi installs this package into the consumer's ignored `node_modules`, so `.` always refuses the build. Keep the binary's output directory, which also holds `<binary>.lock`, out of `inputs`, and list it in `.gitignore`.

## Development

The package ships compiled JavaScript in `dist`, because Node does not strip types from files under `node_modules`. Run `npm run build` after changing `src/index.ts` and commit `dist`. A test fails when `dist` does not match the source.
