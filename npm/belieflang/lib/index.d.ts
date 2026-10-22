/** Metadata for a supported native platform. */
export interface PlatformInfo {
  readonly packageName: string;
  readonly target: string;
  readonly os: string;
  readonly cpu: string;
  readonly binary: string;
  readonly label: string;
}

export interface BinaryPathOptions {
  platform?: string;
  arch?: string;
  env?: Record<string, string | undefined>;
  resolve?: (id: string) => string;
}

export declare class BelBinaryError extends Error {
  readonly code:
    | 'OVERRIDE_NOT_FOUND'
    | 'UNSUPPORTED_PLATFORM'
    | 'PLATFORM_PACKAGE_MISSING'
    | 'VERSION_MISMATCH'
    | 'BINARY_MISSING';
}

/** Environment variable that overrides native binary resolution. */
export declare const BINARY_OVERRIDE_ENV: 'BELIEFLANG_BINARY';
/** Supported platforms keyed by `${process.platform}-${process.arch}`. */
export declare const PLATFORMS: Readonly<Record<string, PlatformInfo>>;
/** Launcher version; always identical to the native `bel` binary version. */
export declare const version: string;

/** Absolute path to the native Rust `bel` executable for this platform. */
export declare function binaryPath(options?: BinaryPathOptions): string;
export declare function platformKey(platform?: string, arch?: string): string;
export declare function platformPackageName(
  platform?: string,
  arch?: string,
): string | undefined;
