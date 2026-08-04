/**
 * Help text.
 *
 * The help output is part of the deliverable: a reader who has never seen SLTP
 * should be able to run a full demonstration from it. These tests assert that every
 * documented command and every registry entry is actually reachable from the text,
 * without pinning the wording or the layout, which are free to change.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTROL_PORT,
  DEFAULT_HOST,
  DEFAULT_TIMEOUT_MS,
  SLTP_OPERATION_REGISTRY,
  SLTP_STATUS_REGISTRY,
} from '@socketlens/protocol';
import { helpFor, REPL_HELP, USAGE } from '../../apps/cli/src/help.js';
import { Renderer } from '../../apps/cli/src/render.js';
import { printRegistries } from '../../apps/cli/src/commands.js';
import { isKnownCommand } from '../../apps/cli/src/dispatch.js';

/** Every command path the dispatcher can route, plus the two that bypass it. */
const DOCUMENTED_COMMANDS = [
  ['ping'],
  ['info'],
  ['raw'],
  ['session', 'create'],
  ['session', 'list'],
  ['session', 'show'],
  ['session', 'use'],
  ['session', 'close'],
  ['rule', 'add'],
  ['rule', 'list'],
  ['rule', 'update'],
  ['rule', 'delete'],
  ['run'],
  ['scenario', 'show'],
  ['result', 'list'],
  ['result', 'show'],
  ['result', 'export'],
] as const;

describe('USAGE', () => {
  it('is substantial rather than a stub', () => {
    expect(USAGE.trim().length).toBeGreaterThan(500);
    expect(USAGE).toContain('USAGE');
  });

  it('lists every command the dispatcher can route', () => {
    for (const command of DOCUMENTED_COMMANDS) {
      expect(USAGE, command.join(' ')).toContain(command.join(' '));
    }
  });

  it('documents the interactive prompt and the reference topics', () => {
    expect(USAGE).toContain('repl');
    expect(USAGE).toContain('help operations');
    expect(USAGE).toContain('help status');
  });

  it('lists every global flag the parser accepts', () => {
    for (const flag of [
      '--host',
      '--port',
      '--timeout',
      '--session',
      '--raw',
      '--verbose',
      '--quiet',
      '--json',
      '--no-color',
      '--help',
      '--version',
    ]) {
      expect(USAGE, flag).toContain(flag);
    }
  });

  it('quotes the real defaults rather than hard-coded numbers', () => {
    expect(USAGE).toContain(DEFAULT_HOST);
    expect(USAGE).toContain(String(DEFAULT_CONTROL_PORT));
    expect(USAGE).toContain(String(DEFAULT_TIMEOUT_MS));
  });

  it('names the environment variables the CLI reads', () => {
    expect(USAGE).toContain('SOCKETLENS_HOST');
    expect(USAGE).toContain('SOCKETLENS_PORT');
    expect(USAGE).toContain('SOCKETLENS_STATE_FILE');
    expect(USAGE).toContain('NO_COLOR');
  });
});

describe('helpFor', () => {
  it('returns the top-level usage for an empty command path', () => {
    expect(helpFor([])).toBe(USAGE);
  });

  it('returns command-specific help that names the command', () => {
    for (const command of [...DOCUMENTED_COMMANDS, ['repl'] as const]) {
      const key = command.join(' ');
      const text = helpFor(command);

      expect(text, key).not.toBe(USAGE);
      expect(text, key).toContain(`socketlens ${key}`);
      expect(text.trim().length, key).toBeGreaterThan(0);
    }
  });

  it('covers every routable command, so no command lacks its own help', () => {
    for (const command of DOCUMENTED_COMMANDS) {
      // `run` is routable under both spellings; the help is keyed on the short one.
      if (!isKnownCommand(command)) continue;
      expect(helpFor(command), command.join(' ')).not.toBe(USAGE);
    }
  });

  it('falls back to the top-level usage for a command with no dedicated page', () => {
    expect(helpFor(['frobnicate'])).toBe(USAGE);
    expect(helpFor(['session'])).toBe(USAGE);
  });

  it('documents the flags each command actually reads', () => {
    expect(helpFor(['rule', 'add'])).toContain('--operation');
    expect(helpFor(['rule', 'add'])).toContain('--priority');
    expect(helpFor(['run'])).toContain('--expect-status');
    expect(helpFor(['run'])).toContain('--fragment');
    expect(helpFor(['raw'])).toContain('--text');
    expect(helpFor(['result', 'export'])).toContain('--out');
  });
});

describe('REPL_HELP', () => {
  it('lists the prompt commands and the prompt-only controls', () => {
    for (const entry of ['ping', 'session create', 'rule list', 'run', 'result show', 'raw']) {
      expect(REPL_HELP, entry).toContain(entry);
    }
    for (const control of ['raw on', 'raw off', 'verbose', 'quiet', 'help', 'exit']) {
      expect(REPL_HELP, control).toContain(control);
    }
  });
});

describe('printRegistries', () => {
  /** Captures the registry listing as a single block of text. */
  function render(): string {
    const lines: string[] = [];
    printRegistries(new Renderer((line) => lines.push(line), { colour: false }));
    return lines.join('\n');
  }

  it('prints every registered operation with its summary', () => {
    const text = render();

    expect(SLTP_OPERATION_REGISTRY.length).toBeGreaterThan(0);
    for (const operation of SLTP_OPERATION_REGISTRY) {
      expect(text, operation.name).toContain(operation.name);
      expect(text, operation.name).toContain(operation.summary);
    }
  });

  it('prints every registered status with its code, phrase, and meaning', () => {
    const text = render();

    expect(SLTP_STATUS_REGISTRY.length).toBeGreaterThan(0);
    for (const status of SLTP_STATUS_REGISTRY) {
      expect(text, String(status.code)).toContain(String(status.code));
      expect(text, status.phrase).toContain(status.phrase);
      expect(text, status.phrase).toContain(status.meaning);
    }
  });

  it('separates the two registries under their own headings', () => {
    const text = render();

    expect(text).toContain('SLTP/1.0 operations');
    expect(text).toContain('SLTP/1.0 status codes');
    expect(text.indexOf('SLTP/1.0 operations')).toBeLessThan(text.indexOf('SLTP/1.0 status codes'));
  });
});
