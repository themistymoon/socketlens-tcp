#!/usr/bin/env node
/**
 * Development launcher for the graphical client.
 *
 * Starts, in order:
 *   1. (optional, with --with-server) the SLTP TCP server
 *   2. the loopback bridge, which speaks raw SLTP over TCP on behalf of the browser
 *   3. the Vite dev server that serves the React interface
 *
 * Ctrl+C stops every child process.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const withServer = process.argv.includes('--with-server');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];
let shuttingDown = false;

function start(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n[dev] ${name} exited (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
    shutdown(code ?? 1);
  });
  child.on('error', (error) => {
    console.error(`[dev] failed to start ${name}: ${error.message}`);
    shutdown(1);
  });
  children.push({ name, child });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 250);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (withServer) {
  console.log('[dev] starting SLTP server on tcp://127.0.0.1:7420');
  start('server', npmCommand, ['run', 'dev:server']);
}

console.log('[dev] starting SLTP loopback bridge on http://127.0.0.1:7801');
start('bridge', npmCommand, ['run', 'dev:bridge']);

console.log('[dev] starting Vite dev server for the React interface');
start('gui', npmCommand, ['run', 'dev', '--workspace', '@socketlens/gui']);
