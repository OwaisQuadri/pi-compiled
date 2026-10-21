export interface BuildSpec {
    packageRoot: string;
    binary: string;
    buildCommand: string[];
    inputs: string[];
    envAllowlist?: string[];
    overrideEnv?: string;
    timeoutMs?: number;
}
export type BuildErrorCode = "build-refused" | "build-failed" | "build-timeout" | "build-busy";
export declare class BuildError extends Error {
    readonly code: BuildErrorCode;
    constructor(code: BuildErrorCode, message: string);
}
export declare function lockPath(spec: BuildSpec): string;
export declare function binaryPath(spec: BuildSpec): string;
export declare function isBuildNeeded(spec: BuildSpec): boolean;
export declare function ensureBuilt(spec: BuildSpec): Promise<string>;
export declare function refusalReason(spec: BuildSpec): Promise<string>;
