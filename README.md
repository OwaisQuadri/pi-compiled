# pi-compiled

Adds a compile step to Pi packages. Pi loads TypeScript as is. A package that also ships a compiled tool (Swift, Rust, anything with a build command) uses `pi-compiled` to build that tool after `pi install` and `pi update`, without a manual setup script.

## When it builds

Call `ensureBuilt` when the extension loads (`session_start`). It builds when the binary is missing, or when the committed build inputs changed since the binary was built. After each build it writes `<binary>.stamp`, a hash of the build command, the input list, and the committed inputs. Environment values, including `envAllowlist` variables, are not part of it, because they can differ between sessions; delete the binary to rebuild after changing one.

- `pi install` clones the package, so the next load builds the tool.
- `pi update` moves the clone to a new commit and runs `git clean -fdx`, which deletes the old binary, so the next load rebuilds it.
- A package loaded from a local path, or a clone updated with `git pull`, keeps the old binary. The stamp no longer matches, so the next load rebuilds it.
- Without `cleanupPaths`, a load with no changes costs one `git ls-files` call and takes no lock.

Pi runs `npm install` in a git package after install and update, but this does not use an npm `postinstall` script. Many machines set `ignore-scripts`, and a build that fails in `postinstall` makes `pi install` delete the clone.

## Safety

It refuses to build unless the package is its own Git checkout and every build input is committed, with no untracked or ignored files. Inputs and the binary must be inside the package, also after symbolic links are resolved, and inputs must not contain committed symbolic links. Each input must match a committed file, so a misspelled input is refused. Git runs from `/usr/bin`, `/opt/homebrew/bin`, or `/usr/local/bin` with only `PATH` and `HOME`, and with the file system monitor and `core.ignoreStat` off, so the caller's Git settings cannot fake a clean result. Inputs marked assume-unchanged or skip-worktree, including by sparse checkout, are refused. This stops uncommitted code from being built and signed. Code committed in the clone is built unless you set `isUpstreamRequired`, which also requires `HEAD` to be the fetched upstream commit (`@{upstream}`). A clone made by `pi install` from a branch tracks its remote branch, so it passes. A local commit there, or a checkout with no fetched upstream branch, is refused. An install pinned to a tag or commit is checked out detached and has no upstream, so do not set `isUpstreamRequired` for it. That check stops a stray local commit. It does not stop someone who can also rewrite the remote-tracking ref. Inputs and the upstream commit are checked again after acquiring the build lock. These checks do not prevent changes by processes that ignore the locking protocol. When the binary exists but Git cannot check the package, for example a package that is not a Git checkout, `isBuildNeeded` returns false and the existing binary is used as is, without a warning.

The checks cover the declared inputs only. A build script that reuses an ignored build cache, such as a SwiftPM scratch directory, can link files that no check saw. Build into a fresh scratch directory, or delete the cache before each build.

## API

```ts
ensureBuilt(spec: BuildSpec, options?: { onProgress?: (progress: BuildProgress) => void }): Promise<string>
progressBar(progress: BuildProgress, width?: number): string
// BuildProgress: { line: string; completed?: number; total?: number }
isBuildNeeded(spec: BuildSpec): Promise<boolean>
binaryPath(spec: BuildSpec): string
lockPath(spec: BuildSpec): string
packageLockPath(root: string): string
stampPath(spec: BuildSpec): string
refusalReason(spec: BuildSpec): Promise<string>

interface BuildSpec {
  packageRoot: string;      // absolute path of the consumer's Git checkout
  binary: string;           // path of the built tool, relative to packageRoot
  buildCommand: string[];   // argv, run in packageRoot
  inputs: string[];         // Git pathspecs that must be clean
  cleanupPaths?: string[];
  envAllowlist?: string[];  // added to PATH HOME USER LOGNAME TMPDIR DEVELOPER_DIR
  overrideEnv?: string;     // env var naming a prebuilt binary; skips the build
  timeoutMs?: number;       // default 600000
  isUpstreamRequired?: boolean; // build only when HEAD is the fetched upstream commit
}

class BuildError extends Error { code: "build-refused" | "build-failed" | "build-timeout" | "build-busy" }
```

`ensureBuilt` returns the absolute binary path. `onProgress` receives each output line of the build, from standard output and standard error. A line that starts with a step count such as SwiftPM's `[12/340]` or `[12 / 340]` also carries `completed` and `total`. `progressBar` turns that into one text line without terminal escape sequences (CSI, OSC and two-character escapes) or control characters, at most 120 Unicode code points of build output, for example for `ctx.ui.setWidget`. A caller that joins a build already running in the same process gets progress from that point on. Without `cleanupPaths`, output is read for up to 200 ms after the build exits; when a background process keeps a pipe open, output that arrives later is dropped. Adopted builds instead wait for the build's output pipes to close under both locks. The build runs in its own process group with only allowlisted variables. Concurrent calls in one process share one build. Across Pi sessions, a kernel file lock on `<binary>.lock` serializes builds (`/usr/bin/lockf` on macOS, util-linux `flock` 2.26 or later at `/usr/bin/flock` or `/bin/flock` on Linux; without one the build is refused, and BusyBox `flock` is not supported). The kernel releases it when the holder dies. A session waits up to `timeoutMs` for each lock, then fails with `build-busy`. After it gets the lock, it skips the build when another session already built the binary from the same inputs. When the lock wait and the build together pass twice `timeoutMs`, the whole group is killed (`build-timeout`). The output must be a file after the build. Only then is a temporary stamp renamed into place.

The private lock worker requires an actual Node.js executable, version 22.19.0 or later, on the caller's `PATH`. It verifies that runtime before creating build files. Missing or unsupported Node produces `build-refused` with a retry instruction. The host's `process.execPath` can be a compiled Pi executable; it is not used to select the interpreter. Overrides and the legacy unchanged-binary fast path do not need this worker.

The build command must start with an absolute path, so it does not depend on the caller's `PATH`. A build that exits with status 75 is reported as `build-failed`, not `build-busy`. An override binary must be an absolute path to an executable file. Build scripts must write the binary to a temporary file and rename it into place: a session that finds the binary without taking the lock uses it at once.

`isBuildNeeded` returns `false` for an existing binary when Git cannot read the package. `refusalReason` returns an empty string when a build is allowed. Use the two together to ask the user before building.

## Generated-output cleanup

Set `cleanupPaths` to exact generated-output paths relative to `packageRoot`, for example `["target/build"]`. Omission keeps the legacy fast path and binary-only locking. Presence, including `[]`, acquires a stable outer package lock before the binary lock. All checks, build execution, output validation, stamp publication and deletion run within the cross-process locks.

`packageLockPath(root)` returns the canonical parent directory plus `.<package-basename>.pi-package.lock`. The parent must exist. The helper does not create files. Package managers must use the same kernel lock backend and acquire this lock before mutation. A manager can hold the active-package lock while compiling a uniquely named candidate: the candidate has a different package lock. Never unlink lock files, even after owner death. Older compiler versions do not participate in this protocol; stop their builds before adopting it.

Cleanup paths must be nonempty literals, not root, absolute, traversal, glob or Git-magic paths. Symlink targets and ancestors are refused, including a symlink package root. Nested symlinks are unlinked without traversing their targets. Cleanup cannot overlap tracked files, declared inputs, the executable, its stamp or locks, Git metadata, `package.json`, or `node_modules`. Protected package names and `*.lock` files inside a cleanup tree also block deletion. Overlap checks conservatively ignore case. Keep the executable and generated scratch in separate directories.

The compiler validates cleanup before building and again immediately before each deletion. It cleans only after a successful build with verified output and stamp, or after verifying matching output and stamp on a retry. Missing scratch succeeds. A cleanup failure leaves usable output in place and sends one fixed, bounded diagnostic through `onProgress`; the next call retries cleanup without rebuilding matching inputs. Cleanup does not run after refusal, build failure, timeout, missing output, an override, or the existing-binary fallback when Git cannot verify inputs. Build scripts still own atomic binary replacement and must not change the working executable on failure.

A failed or interrupted build has no verified new output and stamp. Deleting its scratch could also race a writer that has not stopped. The compiler retains that scratch, kills the whole owned process group on timeout, and takes both locks again on retry. The retry must finish a successful build before bounded cleanup can run. Scripts must tolerate retained scratch and use a fresh build cache when needed.

Adopted build scripts must join every writer before returning. The compiler waits for inherited output pipes to close before publishing the stamp or deleting scratch; a surviving pipe writer reaches the normal timeout without cleanup. Do not detach a writer that closes its pipes and continues changing outputs: the compiler cannot detect that prohibited case portably. The legacy no-cleanup daemon behavior is unchanged.

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

The package ships compiled JavaScript in `dist`, because Node does not strip types from files under `node_modules`. Run `npm run build` after changing compiler source and commit all of `dist`, including the private worker and validation module. A test fails when `dist` does not match the source.
