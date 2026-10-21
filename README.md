# pi-compiled

Adds a compile step to Pi packages. Pi loads TypeScript as is. A package that also ships a compiled tool (Swift, Rust, anything with a build command) uses `pi-compiled` to build that tool after `pi install` and `pi update`, without a manual setup script.

## When it builds

Call `ensureBuilt` when the extension loads (`session_start`). It builds when the binary is missing, or when the committed build inputs changed since the binary was built. After each build it writes `<binary>.stamp`, a hash of the build command, the input list, and the committed inputs. Environment values, including `envAllowlist` variables, are not part of it, because they can differ between sessions; delete the binary to rebuild after changing one.

- `pi install` clones the package, so the next load builds the tool.
- `pi update` moves the clone to a new commit and runs `git clean -fdx`, which deletes the old binary, so the next load rebuilds it.
- A package loaded from a local path, or a clone updated with `git pull`, keeps the old binary. The stamp no longer matches, so the next load rebuilds it.
- A load with no changes costs one `git ls-files` call.

Pi runs `npm install` in a git package after install and update, but this does not use an npm `postinstall` script. Many machines set `ignore-scripts`, and a build that fails in `postinstall` makes `pi install` delete the clone.

## Safety

It refuses to build unless the package is its own Git checkout and every build input is committed, with no untracked or ignored files. Inputs and the binary must be inside the package, also after symbolic links are resolved, and inputs must not contain committed symbolic links. Each input must match a committed file, so a misspelled input is refused. Git runs from `/usr/bin`, `/opt/homebrew/bin`, or `/usr/local/bin` with only `PATH` and `HOME`, and with the file system monitor and `core.ignoreStat` off, so the caller's Git settings cannot fake a clean result. Inputs marked assume-unchanged or skip-worktree, including by sparse checkout, are refused. This stops uncommitted code from being built and signed. Code committed in the clone is built unless you set `isUpstreamRequired`, which also requires `HEAD` to be the fetched upstream commit (`@{upstream}`). A clone made by `pi install` from a branch tracks its remote branch, so it passes. A local commit there, or a checkout with no fetched upstream branch, is refused. An install pinned to a tag or commit is checked out detached and has no upstream, so do not set `isUpstreamRequired` for it. That check stops a stray local commit. It does not stop someone who can also rewrite the remote-tracking ref. Inputs and the upstream commit are checked once before the build starts, outside the lock, not while it runs. When the binary exists but Git cannot check the package, for example a package that is not a Git checkout, `isBuildNeeded` returns false and the existing binary is used as is, without a warning.

The checks cover the declared inputs only. A build script that reuses an ignored build cache, such as a SwiftPM scratch directory, can link files that no check saw. Build into a fresh scratch directory, or delete the cache before each build.

## API

```ts
ensureBuilt(spec: BuildSpec, options?: { onProgress?: (progress: BuildProgress) => void }): Promise<string>
progressBar(progress: BuildProgress, width?: number): string
// BuildProgress: { line: string; completed?: number; total?: number }
isBuildNeeded(spec: BuildSpec): Promise<boolean>
binaryPath(spec: BuildSpec): string
lockPath(spec: BuildSpec): string
stampPath(spec: BuildSpec): string
refusalReason(spec: BuildSpec): Promise<string>

interface BuildSpec {
  packageRoot: string;      // absolute path of the consumer's Git checkout
  binary: string;           // path of the built tool, relative to packageRoot
  buildCommand: string[];   // argv, run in packageRoot
  inputs: string[];         // Git pathspecs that must be clean
  envAllowlist?: string[];  // added to PATH HOME USER LOGNAME TMPDIR DEVELOPER_DIR
  overrideEnv?: string;     // env var naming a prebuilt binary; skips the build
  timeoutMs?: number;       // default 600000
  isUpstreamRequired?: boolean; // build only when HEAD is the fetched upstream commit
}

class BuildError extends Error { code: "build-refused" | "build-failed" | "build-timeout" | "build-busy" }
```

`ensureBuilt` returns the absolute binary path. `onProgress` receives each output line of the build, from standard output and standard error. A line that starts with a step count such as SwiftPM's `[12/340]` also carries `completed` and `total`. `progressBar` turns that into one text line, for example for `ctx.ui.setWidget`. A caller that joins a build already running in the same process gets progress from that point on. After the build exits, output is read for up to 200 ms more; when a background process keeps a pipe open, output that arrives later is dropped. The build runs in its own process group with only allowlisted variables. Concurrent calls in one process share one build. Across Pi sessions, a kernel file lock on `<binary>.lock` serializes builds (`/usr/bin/lockf` on macOS, util-linux `flock` 2.26 or later at `/usr/bin/flock` or `/bin/flock` on Linux; without one the build is refused, and BusyBox `flock` is not supported). The kernel releases it when the holder dies. A session waits up to `timeoutMs` for the lock, then fails with `build-busy`. After it gets the lock, it skips the build when another session already built the binary from the same inputs. When the lock wait and the build together pass twice `timeoutMs`, the whole group is killed (`build-timeout`). The binary must exist after the build.

The build command must start with an absolute path, so it does not depend on the caller's `PATH`. A build that exits with status 75 is reported as `build-failed`, not `build-busy`. An override binary must be an absolute path to an executable file. Build scripts must write the binary to a temporary file and rename it into place: a session that finds the binary without taking the lock uses it at once.

`isBuildNeeded` returns `false` for an existing binary when Git cannot read the package. `refusalReason` returns an empty string when a build is allowed. Use the two together to ask the user before building.

## Consumer

`package.json` (replace `<owner>` with the GitHub account that hosts this repository):

```json
"dependencies": { "pi-compiled": "github:<owner>/pi-compiled" }
```

Consumers track `main` and do not pin a tag. Do not commit `package-lock.json`, because a lockfile pins the commit; add it to `.gitignore`. npm then installs the latest `main` each time Pi installs the consumer's dependencies. Pi does that on `pi install`, and on `pi update` only when the consumer's own commit changed. Changes to `main` must therefore stay compatible with existing consumers.

`extension/index.ts`:

```ts
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "pi-compiled";

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

List specific paths in `inputs`, never `.`. Pi installs this package into the consumer's ignored `node_modules`, so `.` always refuses the build. Keep the binary's output directory, which also holds `<binary>.lock` and `<binary>.stamp`, out of `inputs`, and list it in `.gitignore`.

## Development

The package ships compiled JavaScript in `dist`, because Node does not strip types from files under `node_modules`. Run `npm run build` after changing `src/index.ts` and commit `dist`. A test fails when `dist` does not match the source.
