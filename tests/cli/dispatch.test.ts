/**
 * Command routing.
 *
 * The dispatcher is the layer both the one-shot CLI and the interactive prompt go
 * through, so what matters here is that a command path reaches the right handler
 * and that an unrecognised one is refused loudly. The handlers themselves are
 * driven with a stub client: no socket is opened, and the assertion is on the SLTP
 * request the command chose to send.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { SLTP_VERSION_TOKEN } from '@socketlens/protocol';
import type { Exchange, SltpClient } from '@socketlens/core';
import { dispatch, isKnownCommand } from '../../apps/cli/src/dispatch.js';
import { parseCommandLine, UsageError } from '../../apps/cli/src/options.js';
import { Renderer } from '../../apps/cli/src/render.js';
import type { CommandContext } from '../../apps/cli/src/commands.js';
import { response, testResult } from '../helpers/fixtures.js';

/** One request a command asked the client to send. */
type Sent = Parameters<SltpClient['send']>[0];

/**
 * A client that answers every request from a queue instead of from a socket.
 *
 * Only `send` is implemented; a command that reached for anything else would fail
 * loudly rather than quietly appear to work.
 */
function stubClient(bodies: readonly string[] = []) {
  const sent: Sent[] = [];
  let index = 0;

  const client = {
    send: (options: Sent): Promise<Exchange> => {
      sent.push(options);
      const body = bodies[index] ?? '{}';
      index += 1;
      return Promise.resolve({
        requestId: `req-${index}`,
        request: Buffer.from(`${SLTP_VERSION_TOKEN} ${options.operation}\r\n\r\n`),
        response: response({ statusCode: 200, statusPhrase: 'OK', body }),
        rawResponse: Buffer.from('SLTP/1.0 200 OK\r\n\r\n'),
        durationMs: 1,
      });
    },
  } as unknown as SltpClient;

  return { client, sent };
}

/** Builds a dispatch context around a parsed command line. */
function context(argv: readonly string[], bodies: readonly string[] = []) {
  const lines: string[] = [];
  const stub = stubClient(bodies);
  const ctx: CommandContext = {
    client: stub.client,
    renderer: new Renderer((line) => lines.push(line), { colour: false }),
    parsed: parseCommandLine(argv),
    server: '127.0.0.1:7420',
  };
  return { ctx, sent: stub.sent, lines, text: () => lines.join('\n') };
}

// The remembered-session file is process-wide state, so every test points at a
// path that does not exist: `readState` treats that as "nothing remembered".
beforeEach(() => {
  vi.stubEnv(
    'SOCKETLENS_STATE_FILE',
    path.join(os.tmpdir(), 'socketlens-dispatch-test-absent.json'),
  );
  vi.stubEnv('SOCKETLENS_HOST', undefined);
  vi.stubEnv('SOCKETLENS_PORT', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isKnownCommand', () => {
  it('recognises every dispatchable path, including the two spellings of run', () => {
    for (const command of [
      ['ping'],
      ['info'],
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
      ['scenario', 'run'],
      ['scenario', 'show'],
      ['result', 'list'],
      ['result', 'show'],
      ['result', 'export'],
      ['raw'],
    ]) {
      expect(isKnownCommand(command), command.join(' ')).toBe(true);
    }
  });

  it('rejects an unknown path, an empty path, and a partial one', () => {
    expect(isKnownCommand(['frobnicate'])).toBe(false);
    expect(isKnownCommand([])).toBe(false);
    expect(isKnownCommand(['session'])).toBe(false);
  });

  it('is not fooled by inherited object properties', () => {
    expect(isKnownCommand(['constructor'])).toBe(false);
    expect(isKnownCommand(['toString'])).toBe(false);
  });
});

describe('routing', () => {
  it('sends PING for `ping` and returns success', async () => {
    const { ctx, sent } = context(['ping']);

    await expect(dispatch(ctx)).resolves.toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ operation: 'PING' });
  });

  it('passes --echo through as the PING body', async () => {
    const { ctx, sent } = context(['ping', '--echo', 'hello']);

    await dispatch(ctx);

    expect(sent[0]).toMatchObject({ operation: 'PING', json: { echo: 'hello' } });
  });

  it('sends SERVER_INFO for `info`', async () => {
    const { ctx, sent } = context(['info']);

    await expect(dispatch(ctx)).resolves.toBe(0);
    expect(sent[0]).toMatchObject({ operation: 'SERVER_INFO' });
  });

  it('routes `session list` to LIST_SESSIONS and renders the sessions', async () => {
    const { ctx, sent, text } = context(
      ['session', 'list'],
      [
        JSON.stringify({
          count: 1,
          sessions: [
            {
              id: 'ses-1',
              name: 'demo',
              description: '',
              state: 'active',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              mockHost: '127.0.0.1',
              mockPort: 5000,
              ruleCount: 0,
              resultCount: 0,
            },
          ],
        }),
      ],
    );

    await dispatch(ctx);

    expect(sent[0]).toMatchObject({ operation: 'LIST_SESSIONS' });
    expect(text()).toContain('ses-1');
  });

  it('scopes a session command to the identifier given by --session', async () => {
    const { ctx, sent } = context(['rule', 'list', '--session', 'ses-9']);

    await dispatch(ctx);

    expect(sent[0]).toMatchObject({ operation: 'LIST_RULES', sessionId: 'ses-9' });
  });

  it('prefers a positional session identifier over the remembered one', async () => {
    const { ctx, sent } = context(['session', 'show', 'ses-3']);

    await dispatch(ctx);

    expect(sent[0]).toMatchObject({ operation: 'GET_SESSION', sessionId: 'ses-3' });
  });

  it('routes `rule delete <id>` to DELETE_RULE with the identifier in the body', async () => {
    const { ctx, sent } = context(['rule', 'delete', 'rule-7', '--session', 'ses-1']);

    await dispatch(ctx);

    expect(sent[0]).toMatchObject({
      operation: 'DELETE_RULE',
      sessionId: 'ses-1',
      json: { id: 'rule-7' },
    });
  });

  it('routes `result show <id>` to GET_RESULT', async () => {
    const { ctx, sent } = context(['result', 'show', 'res-2', '--session', 'ses-1']);

    await dispatch(ctx);

    expect(sent[0]).toMatchObject({
      operation: 'GET_RESULT',
      sessionId: 'ses-1',
      json: { id: 'res-2' },
    });
  });

  it('routes both `run` and `scenario run` to the same handler', async () => {
    const bare = context(['run', '--operation', 'PING', '--session', 'ses-1']);
    const prefixed = context(['scenario', 'run', '--operation', 'PING', '--session', 'ses-1']);

    await dispatch(bare.ctx);
    await dispatch(prefixed.ctx);

    expect(bare.sent[0]).toMatchObject({ operation: 'RUN_TEST', sessionId: 'ses-1' });
    expect(prefixed.sent[0]).toMatchObject({ operation: 'RUN_TEST', sessionId: 'ses-1' });
  });

  it('builds an ad-hoc scenario from the run flags', async () => {
    const { ctx, sent } = context([
      'run',
      '--session',
      'ses-1',
      '--operation',
      'PING',
      '--name',
      'from flags',
      '--fragment',
      '12,8',
      '--expect-status',
      '200',
    ]);

    await dispatch(ctx);

    expect(sent[0]?.json).toMatchObject({
      scenario: {
        name: 'from flags',
        request: { operation: 'PING' },
        transmission: { mode: 'fragmented', fragmentSizes: [12, 8] },
        expect: { statusCode: 200 },
      },
    });
  });

  it('reports a failing scenario with exit code 1 without treating it as a crash', async () => {
    const failed = context(
      ['run', '--operation', 'PING', '--session', 'ses-1'],
      [JSON.stringify({ result: testResult({ passed: false, outcome: 'failed' }) })],
    );
    const passed = context(
      ['run', '--operation', 'PING', '--session', 'ses-1'],
      [JSON.stringify({ result: testResult({ passed: true }) })],
    );

    await expect(dispatch(failed.ctx)).resolves.toBe(1);
    await expect(dispatch(passed.ctx)).resolves.toBe(0);
    expect(failed.text()).toContain('FAILED');
  });
});

describe('the help path', () => {
  it('prints the operation and status registries without contacting the server', async () => {
    const operations = context(['help', 'operations']);
    const statuses = context(['help', 'status']);

    await expect(dispatch(operations.ctx)).resolves.toBe(0);
    await expect(dispatch(statuses.ctx)).resolves.toBe(0);

    expect(operations.sent).toHaveLength(0);
    expect(operations.text()).toContain('SLTP/1.0 operations');
    expect(operations.text()).toContain('RUN_TEST');
    expect(statuses.text()).toContain('SLTP/1.0 status codes');
  });

  it('refuses a bare `help` with a pointer to --help', async () => {
    const { ctx } = context(['help']);

    await expect(dispatch(ctx)).rejects.toThrow(/Nothing to do/);
  });

  it('refuses an empty command line', async () => {
    const { ctx } = context([]);

    await expect(dispatch(ctx)).rejects.toBeInstanceOf(UsageError);
  });
});

describe('rejecting an unknown command', () => {
  it('names the command it could not route and sends nothing', async () => {
    const { ctx, sent } = context(['frobnicate']);

    await expect(dispatch(ctx)).rejects.toThrow(
      /Unknown command "frobnicate"\. Run `socketlens --help`/,
    );
    expect(sent).toHaveLength(0);
  });

  it('refuses a partial command path rather than guessing the rest', async () => {
    const { ctx } = context(['session']);

    await expect(dispatch(ctx)).rejects.toThrow(/Unknown command "session"/);
  });
});

describe('argument validation before any request is sent', () => {
  it('requires a rule identifier for `rule update`', async () => {
    const missing = context(['rule', 'update', '--session', 'ses-1', '--priority', '5']);
    const supplied = context(['rule', 'update', 'rule-1', '--session', 'ses-1', '--priority', '5']);

    await expect(dispatch(missing.ctx)).rejects.toThrow(/needs a rule identifier/);
    expect(missing.sent).toHaveLength(0);

    // The same flags go through once an identifier is present, so the rejection is
    // about the missing identifier rather than about the patch.
    await expect(dispatch(supplied.ctx)).resolves.toBe(0);
    expect(supplied.sent[0]).toMatchObject({
      operation: 'UPDATE_RULE',
      sessionId: 'ses-1',
      json: { id: 'rule-1', priority: 5 },
    });
  });

  it('requires something to change on `rule update`', async () => {
    const { ctx, sent } = context(['rule', 'update', 'rule-1', '--session', 'ses-1']);

    await expect(dispatch(ctx)).rejects.toThrow(/Nothing to change/);
    expect(sent).toHaveLength(0);
  });

  it('requires a rule description on `rule add`', async () => {
    const { ctx, sent } = context(['rule', 'add', '--session', 'ses-1']);

    await expect(dispatch(ctx)).rejects.toThrow(/--file <path>, --json-body <json>, or the flags/);
    expect(sent).toHaveLength(0);
  });

  it('rejects a rule the validator refuses, quoting the problems', async () => {
    const { ctx, sent } = context([
      'rule',
      'add',
      '--session',
      'ses-1',
      '--json-body',
      JSON.stringify({ name: '', match: {}, response: {} }),
    ]);

    await expect(dispatch(ctx)).rejects.toThrow(/Invalid rule:/);
    expect(sent).toHaveLength(0);
  });

  it('rejects a non-integer fragment size', async () => {
    const { ctx } = context([
      'rule',
      'add',
      '--session',
      'ses-1',
      '--name',
      'r',
      '--fragment',
      '12,zero',
    ]);

    await expect(dispatch(ctx)).rejects.toThrow(/--fragment expects positive integers/);
  });

  it('requires something to run on `run`', async () => {
    const { ctx, sent } = context(['run', '--session', 'ses-1']);

    await expect(dispatch(ctx)).rejects.toThrow(/Nothing to run/);
    expect(sent).toHaveLength(0);
  });

  it('requires a payload on `raw`', async () => {
    const { ctx, sent } = context(['raw']);

    await expect(dispatch(ctx)).rejects.toThrow(/Nothing to send/);
    expect(sent).toHaveLength(0);
  });

  it('requires a destination on `result export`', async () => {
    const { ctx, sent } = context(['result', 'export', '--session', 'ses-1']);

    await expect(dispatch(ctx)).rejects.toThrow(/needs a destination/);
    expect(sent).toHaveLength(0);
  });

  it('requires a session identifier on `session use`', async () => {
    const { ctx, sent } = context(['session', 'use']);

    await expect(dispatch(ctx)).rejects.toThrow(/needs a session identifier/);
    expect(sent).toHaveLength(0);
  });

  it('explains how to select a session when none is remembered', async () => {
    const { ctx, sent } = context(['rule', 'list']);

    await expect(dispatch(ctx)).rejects.toThrow(/No session selected/);
    expect(sent).toHaveLength(0);
  });
});
