import { type BuildSpec } from "./index.ts";
export declare function inputsFingerprint(spec: BuildSpec): Promise<string>;
export declare function lockTool(): string | undefined;
export declare function lockCommand(path: string, timeoutMs: number): string[];
export declare function cleanupPathReason(spec: BuildSpec): string;
export declare function cleanupReason(spec: BuildSpec): Promise<string>;
export declare function refusalReason(spec: BuildSpec): Promise<string>;
export declare function buildRefusalReason(spec: BuildSpec): Promise<string>;
