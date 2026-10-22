#!/usr/bin/env node
'use strict';

// Thin launcher for the native Rust `bel` executable. It contains no
// interpreter: it resolves the platform binary and forwards arguments,
// stdio, exit codes, and termination signals.

const { spawn } = require('child_process');
const { binaryPath } = require('../lib/index.js');

let bin;
try {
  bin = binaryPath();
} catch (error) {
  process.stderr.write(`belieflang: ${error.message}\n`);
  process.exit(1);
}

const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' });

// POSIX: forward termination signals delivered to the launcher (for example
// `kill <pid>` from a process manager) to the native process. Windows has no
// POSIX signals; Ctrl+C reaches the child through the shared console, so the
// launcher only needs to stay alive until the child exits.
const FORWARDED_SIGNALS =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGBREAK']
    : ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGUSR2'];

const handlers = new Map();
for (const signal of FORWARDED_SIGNALS) {
  const handler = () => {
    if (process.platform !== 'win32' && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        // The child already exited.
      }
    }
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}

function removeHandlers() {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler);
}

child.on('error', (error) => {
  removeHandlers();
  let hint = '';
  if (error.code === 'EACCES') hint = `\nMake sure the file is executable: chmod +x "${bin}"`;
  if (error.code === 'ENOENT') hint = '\nThe binary may be missing; reinstall belieflang.';
  process.stderr.write(`belieflang: failed to start native bel binary at ${bin}: ${error.message}${hint}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  removeHandlers();
  if (signal) {
    // Re-raise the same signal so the caller observes identical termination
    // semantics (for example exit status 130 for SIGINT in a shell).
    try {
      process.kill(process.pid, signal);
    } catch {
      // Fall through to a conventional 128 + n exit status.
    }
    const signum = require('os').constants.signals[signal] || 0;
    setTimeout(() => process.exit(128 + signum), 100);
    return;
  }
  process.exit(code === null ? 1 : code);
});
