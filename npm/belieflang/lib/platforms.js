'use strict';

/**
 * Supported native platforms for the `bel` executable.
 *
 * This table is the single definition shared by the npm launcher (at runtime)
 * and the release tooling in `scripts/release/` (at build time). Keys follow
 * Node's `${process.platform}-${process.arch}` convention.
 *
 * Linux binaries are statically linked against musl, so a single package per
 * architecture runs on both glibc (Debian, Ubuntu, Fedora, RHEL, ...) and musl
 * (Alpine) distributions.
 */
const PLATFORMS = Object.freeze({
  'darwin-arm64': Object.freeze({
    packageName: '@belieflang/cli-darwin-arm64',
    target: 'aarch64-apple-darwin',
    os: 'darwin',
    cpu: 'arm64',
    binary: 'bel',
    label: 'macOS (Apple Silicon, ARM64)',
  }),
  'darwin-x64': Object.freeze({
    packageName: '@belieflang/cli-darwin-x64',
    target: 'x86_64-apple-darwin',
    os: 'darwin',
    cpu: 'x64',
    binary: 'bel',
    label: 'macOS (Intel, x86_64)',
  }),
  'linux-x64': Object.freeze({
    packageName: '@belieflang/cli-linux-x64',
    target: 'x86_64-unknown-linux-musl',
    os: 'linux',
    cpu: 'x64',
    binary: 'bel',
    label: 'Linux (x86_64, static musl; runs on glibc and musl distributions)',
  }),
  'linux-arm64': Object.freeze({
    packageName: '@belieflang/cli-linux-arm64',
    target: 'aarch64-unknown-linux-musl',
    os: 'linux',
    cpu: 'arm64',
    binary: 'bel',
    label: 'Linux (ARM64, static musl; runs on glibc and musl distributions)',
  }),
  'win32-x64': Object.freeze({
    packageName: '@belieflang/cli-win32-x64',
    target: 'x86_64-pc-windows-msvc',
    os: 'win32',
    cpu: 'x64',
    binary: 'bel.exe',
    label: 'Windows (x86_64)',
  }),
});

module.exports = { PLATFORMS };
