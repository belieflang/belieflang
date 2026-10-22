'use strict';

// Launcher tests. `node` itself acts as a stand-in native binary through the
// BELIEFLANG_BINARY override, so argument, stdio, exit-code, and signal
// forwarding can be verified on every platform without a Rust build.
// Set BEL_REAL_BINARY=/path/to/bel to additionally exercise a real binary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const launcher = require('../lib/index.js');
const pkg = require('../package.json');

const BEL_JS = path.join(__dirname, '..', 'bin', 'bel.js');
const isWindows = process.platform === 'win32';

function runLauncher(args, options = {}) {
  return spawnSync(process.execPath, [BEL_JS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BELIEFLANG_BINARY: process.execPath, ...options.env },
    input: options.input,
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'belieflang-launcher-'));
}

function fakePlatformPackage(root, name, version, binary) {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  if (binary) fs.writeFileSync(path.join(dir, 'bin', binary), '');
  return dir;
}

test('package metadata pins every platform package to the launcher version', () => {
  const expected = Object.values(launcher.PLATFORMS).map((p) => p.packageName).sort();
  assert.deepEqual(Object.keys(pkg.optionalDependencies).sort(), expected);
  for (const spec of Object.values(pkg.optionalDependencies)) assert.equal(spec, pkg.version);
  assert.equal(launcher.version, pkg.version);
  assert.equal(pkg.bin.bel, 'bin/bel.js');
  assert.equal(pkg.scripts.preinstall, undefined);
  assert.equal(pkg.scripts.install, undefined);
  assert.equal(pkg.scripts.postinstall, undefined);
});

test('forwards arguments verbatim, including spaces, quotes, and unicode', () => {
  const args = ['plain', 'with space', 'quote"d', "it's", 'ünïcødé', '--trace', ''];
  const result = runLauncher(['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('forwards non-zero exit codes', () => {
  for (const code of [0, 1, 2, 7, 42]) {
    const result = runLauncher(['-e', `process.exit(${code})`]);
    assert.equal(result.status, code);
  }
});

test('passes stdin through and keeps stdout and stderr separate', () => {
  const script =
    'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{process.stdout.write("out:"+d);process.stderr.write("err:"+d)})';
  const result = runLauncher(['-e', script], { input: 'hello bel' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'out:hello bel');
  assert.equal(result.stderr, 'err:hello bel');
});

test('re-raises the signal that terminated the native process', { skip: isWindows }, () => {
  const result = runLauncher(['-e', 'process.kill(process.pid, "SIGTERM"); setTimeout(()=>{}, 5000)']);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.status, null);
});

test('forwards SIGTERM and SIGINT delivered to the launcher', { skip: isWindows }, async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const script =
      `process.on("${signal}",()=>{process.stdout.write("got ${signal}");process.exit(42)});` +
      'process.stdout.write("ready");setInterval(()=>{},1000)';
    const child = spawn(process.execPath, [BEL_JS, '-e', script], {
      env: { ...process.env, BELIEFLANG_BINARY: process.execPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve({ code, sig })));
    await new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('ready')) resolve();
      });
    });
    child.kill(signal);
    const { code } = await exited;
    assert.equal(code, 42, `launcher should exit with the child's code after ${signal}`);
    assert.match(stdout, new RegExp(`got ${signal}`));
  }
});

test('reports unsupported platforms with the supported list and alternatives', () => {
  assert.throws(
    () => launcher.binaryPath({ platform: 'aix', arch: 'ppc64', env: {} }),
    (error) => {
      assert.equal(error.code, 'UNSUPPORTED_PLATFORM');
      assert.match(error.message, /Unsupported platform "aix-ppc64"/);
      assert.match(error.message, /linux-x64/);
      assert.match(error.message, /cargo install bel-cli/);
      assert.match(error.message, /github\.com\/belieflang\/belieflang\/releases/);
      return true;
    },
  );
});

test('reports a missing optional platform package with reinstall guidance', () => {
  const resolve = () => {
    throw Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' });
  };
  assert.throws(
    () => launcher.binaryPath({ platform: 'linux', arch: 'x64', env: {}, resolve }),
    (error) => {
      assert.equal(error.code, 'PLATFORM_PACKAGE_MISSING');
      assert.match(error.message, /@belieflang\/cli-linux-x64/);
      assert.match(error.message, /--include=optional/);
      return true;
    },
  );
});

test('surfaces launcher errors on stderr with exit code 1', () => {
  const result = spawnSync(process.execPath, [BEL_JS, '--version'], {
    encoding: 'utf8',
    env: { ...process.env, BELIEFLANG_BINARY: path.join(tempDir(), 'missing-bel') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^belieflang: BELIEFLANG_BINARY is set to/);
});

test('resolves the binary from the matching platform package', () => {
  const root = tempDir();
  const info = launcher.PLATFORMS['linux-arm64'];
  const dir = fakePlatformPackage(root, info.packageName, pkg.version, info.binary);
  const resolve = (id) => require.resolve(id, { paths: [root] });
  const resolved = launcher.binaryPath({ platform: 'linux', arch: 'arm64', env: {}, resolve });
  assert.equal(fs.realpathSync(resolved), fs.realpathSync(path.join(dir, 'bin', info.binary)));
});

test('rejects a platform package whose version differs from the launcher', () => {
  const root = tempDir();
  const info = launcher.PLATFORMS['darwin-arm64'];
  fakePlatformPackage(root, info.packageName, '0.0.1', info.binary);
  const resolve = (id) => require.resolve(id, { paths: [root] });
  assert.throws(
    () => launcher.binaryPath({ platform: 'darwin', arch: 'arm64', env: {}, resolve }),
    (error) => error.code === 'VERSION_MISMATCH',
  );
});

test('rejects a platform package without its binary', () => {
  const root = tempDir();
  const info = launcher.PLATFORMS['win32-x64'];
  fakePlatformPackage(root, info.packageName, pkg.version, null);
  const resolve = (id) => require.resolve(id, { paths: [root] });
  assert.throws(
    () => launcher.binaryPath({ platform: 'win32', arch: 'x64', env: {}, resolve }),
    (error) => error.code === 'BINARY_MISSING',
  );
});

test('runs a real native bel binary when BEL_REAL_BINARY is provided', { skip: !process.env.BEL_REAL_BINARY }, () => {
  const result = runLauncher(['--version'], { env: { BELIEFLANG_BINARY: process.env.BEL_REAL_BINARY } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `bel ${pkg.version}`);
});
