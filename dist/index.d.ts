export { refusalReason } from "./validation.ts";
export interface BuildSpec {
    packageRoot: string;
    binary: string;
    buildCommand: string[];
    inputs: string[];
    cleanupPaths?: string[];
    envAllowlist?: string[];
    overrideEnv?: string;
    timeoutMs?: number;
    isUpstreamRequired?: boolean;
    isGitVerificationRequired?: boolean;
}
export interface BuildProgress {
    line: string;
    completed?: number;
    total?: number;
}
export interface BuildOptions {
    onProgress?: (progress: BuildProgress) => void;
}
export declare function progressOf(line: string): BuildProgress;
export declare function progressBar(progress: BuildProgress, width?: number): string;
export type BuildErrorCode = "build-refused" | "build-failed" | "build-timeout" | "build-busy";
export declare class BuildError extends Error {
    readonly code: BuildErrorCode;
    constructor(code: BuildErrorCode, message: string);
}
export declare function packageLockPath(root: string): string;
export declare function lockPath(spec: BuildSpec): string;
export declare function binaryPath(spec: BuildSpec): string;
export declare function stampPath(spec: BuildSpec): string;
export declare function isBuildNeeded(spec: BuildSpec): Promise<boolean>;
export declare function ensureBuilt(spec: BuildSpec, options?: BuildOptions): Promise<string>;
