#!/usr/bin/env node
/**
 * Removes build and test output from every workspace.
 * Kept dependency-free so `npm run clean` works before `npm install`.
 */
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'coverage',
  'packages/protocol/dist',
  'packages/protocol/tsconfig.tsbuildinfo',
  'packages/core/dist',
  'packages/core/tsconfig.tsbuildinfo',
  'apps/server/dist',
  'apps/server/tsconfig.tsbuildinfo',
  'apps/cli/dist',
  'apps/cli/tsconfig.tsbuildinfo',
  'apps/bridge/dist',
  'apps/bridge/tsconfig.tsbuildinfo',
  'apps/gui/dist',
  'apps/gui/.tsbuild',
  'apps/gui/tsconfig.tsbuildinfo',
];

for (const target of targets) {
  const absolute = path.join(root, target);
  await rm(absolute, { recursive: true, force: true });
  console.log(`removed ${target}`);
}

console.log('clean complete');
