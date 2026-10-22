'use strict';

/**
 * Locates the native Rust `bel` executable shipped in the platform-specific
 * optional dependency (for example `@belieflang/cli-linux-x64`).
 *
 * This package intentionally contains no BeliefLang interpreter. All program
 * execution happens in the native binary. JavaScript consumers that previously
 * imported the historical TypeScript runtime (`belieflang@0.1.x`) can use
 * `binaryPath()` to spawn the native CLI instead.
 */

const fs = require('fs');
const path = require('path');
const { PLATFORMS } = require('./platforms.js');

const pkg = require('../package.json');

/** Version of this launcher; always identical to the native binary version. */
const version = pkg.version;

/** Environment variable that overrides binary resolution (custom builds, testing). */
const BINARY_OVERRIDE_ENV = 'BELIEFLANG_BINARY';

class BelBinaryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BelBinaryError';
    this.code = code;
  }
}

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function supportedPlatformList() {
  return Object.entries(PLATFORMS)
    .map(([key, info]) => `  - ${key.padEnd(12)} ${info.label}`)
    .join('\n');
}

const ALTERNATIVES =
  'Alternatives:\n' +
  '  - Install with Cargo:  cargo install bel-cli --version ' +
  version +
  ' --locked\n' +
  '  - Download a binary:   https://github.com/belieflang/belieflang/releases\n' +
  '  - Then point the launcher at it with the ' +
  BINARY_OVERRIDE_ENV +
  ' environment variable, or run it directly.';

function ensureExecutable(file, platform) {
  if (platform === 'win32') return;
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    // Some package managers or archive tools drop the executable bit.
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      // Spawning will report EACCES with a helpful message if this failed.
    }
  }
}

/**
 * Resolve the absolute path to the native `bel` executable.
 *
 * @param {object} [options]
 * @param {string} [options.platform] defaults to process.platform
 * @param {string} [options.arch] defaults to process.arch
 * @param {object} [options.env] defaults to process.env
 * @param {(id: string) => string} [options.resolve] module resolver (defaults to require.resolve)
 * @returns {string}
 */
function binaryPath(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const env = options.env || process.env;
  const resolve = options.resolve || require.resolve;

  const override = env[BINARY_OVERRIDE_ENV];
  if (override) {
    if (!fs.existsSync(override)) {
      throw new BelBinaryError(
        `${BINARY_OVERRIDE_ENV} is set to "${override}", but that file does not exist.`,
        'OVERRIDE_NOT_FOUND',
      );
    }
    return path.resolve(override);
  }

  const key = platformKey(platform, arch);
  const info = PLATFORMS[key];
  if (!info) {
    throw new BelBinaryError(
      `Unsupported platform "${key}". The belieflang npm package ships native ` +
        `binaries for:\n${supportedPlatformList()}\n\n${ALTERNATIVES}`,
      'UNSUPPORTED_PLATFORM',
    );
  }

  let manifestPath;
  try {
    manifestPath = resolve(`${info.packageName}/package.json`);
  } catch {
    throw new BelBinaryError(
      `The native binary package "${info.packageName}" for ${key} is not installed.\n\n` +
        'It is an optional dependency of belieflang and is skipped when optional ' +
        'dependencies are disabled (for example --omit=optional, --no-optional, ' +
        'or a lockfile generated on a different platform). Reinstall with optional ' +
        'dependencies enabled:\n' +
        `  npm install -g belieflang@${version} --include=optional\n\n` +
        ALTERNATIVES,
      'PLATFORM_PACKAGE_MISSING',
    );
  }

  const platformPkg = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (platformPkg.version !== version) {
    throw new BelBinaryError(
      `Version mismatch: belieflang@${version} requires ${info.packageName}@${version}, ` +
        `but ${platformPkg.version} is installed. Reinstall belieflang so that both ` +
        'packages come from the same release.',
      'VERSION_MISMATCH',
    );
  }

  const file = path.join(path.dirname(manifestPath), 'bin', info.binary);
  if (!fs.existsSync(file)) {
    throw new BelBinaryError(
      `The package ${info.packageName}@${platformPkg.version} is installed but does not ` +
        `contain bin/${info.binary}. The installation may be corrupted; reinstall belieflang.`,
      'BINARY_MISSING',
    );
  }
  ensureExecutable(file, platform);
  return file;
}

/** Name of the optional dependency that provides the binary for a platform. */
function platformPackageName(platform = process.platform, arch = process.arch) {
  const info = PLATFORMS[platformKey(platform, arch)];
  return info ? info.packageName : undefined;
}

module.exports = {
  BINARY_OVERRIDE_ENV,
  BelBinaryError,
  PLATFORMS,
  binaryPath,
  platformKey,
  platformPackageName,
  version,
};
