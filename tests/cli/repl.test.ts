/**
 * Interactive mode.
 *
 * The prompt is the only part of the CLI that holds one TCP connection across many
 * commands, and the only part with state of its own — the inherited flags that later
 * commands pick up. Both are driven here against a real server over a real socket,
 * with input piped in rather than typed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runRepl, tokenise } from '../../apps/cli/src/repl.js';
import { Renderer } from '../../apps/cli/src/render.js';
import { startHarness, type Harness } from '../helpers/harness.js';

let harness: Harness;
let stateDir: string;

/** Feeds the prompt a fixed script of lines, as a pipe would. */
function input(...lines: string[]): Readable {
  return Readable.from([lines.map((line) => `${line}\n`).join('')]);
}

/** Swallows readline's prompt writes; the assertions read the renderer instead. */
function sink(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** Runs the prompt over a scripted session and returns its output and exit code. */
async function run(
  lines: string[],
  options: { inherited?: string[] } = {},
): Promise<{ code: number; text: string; out: string[] }> {
  const out: string[] = [];
  const renderer = new Renderer((line) => out.push(line), { colour: false });
  const client = await harness.client();

  const code = await runRepl({
    client,
    renderer,
    server: `${harness.host}:${harness.port}`,
    inherited: options.inherited ?? [],
    input: input(...lines),
    output: sink(),
  });

  return { code, text: out.join('\n'), out };
}

beforeEach(async () => {
  harness = await startHarness();
  // The prompt reads remembered state at startup; a developer's real state file must
  // not change what these tests assert.
  stateDir = await mkdtemp(path.join(tmpdir(), 'socketlens-repl-'));
  process.env['SOCKETLENS_STATE_FILE'] = path.join(stateDir, 'cli-state.json');
});

afterEach(async () => {
  delete process.env['SOCKETLENS_STATE_FILE'];
  await rm(stateDir, { recursive: true, force: true });
  await harness.stop();
});

describe('tokenise', () => {
  it('splits on runs of whitespace', () => {
    expect(tokenise('session   create  --name  demo')).toEqual([
      'session',
      'create',
      '--name',
      'demo',
    ]);
  });

  it('returns nothing for an empty or blank line', () => {
    expect(tokenise('')).toEqual([]);
    expect(tokenise('   \t  ')).toEqual([]);
  });

  // Rule and scenario bodies are JSON, which is full of spaces and double quotes. The
  // grammar honours quote pairs but not backslash escapes, so JSON goes inside single
  // quotes — which is also what the help text and every example show.
  it('keeps a single-quoted JSON body as one token', () => {
    expect(tokenise(`rule add --body '{"a": 1}'`)).toEqual(['rule', 'add', '--body', '{"a": 1}']);
  });

  // Documented consequence of the above: a backslash is an ordinary character, so
  // escaping a double quote inside a double-quoted run ends the run instead.
  it('does not treat a backslash as an escape', () => {
    expect(tokenise('rule add --body "{\\"a\\": 1}"')).toEqual([
      'rule',
      'add',
      '--body',
      '{\\a\\: 1}',
    ]);
  });

  it('keeps a single-quoted argument as one token', () => {
    expect(tokenise("raw --text 'SLTP/1.0 PING'")).toEqual(['raw', '--text', 'SLTP/1.0 PING']);
  });

  it('lets one quote style nest inside the other', () => {
    expect(tokenise(`rule add --body '{"name":"demo"}'`)).toEqual([
      'rule',
      'add',
      '--body',
      '{"name":"demo"}',
    ]);
  });

  // An empty quoted string is a real argument, distinct from no argument at all.
  it('preserves an explicitly empty quoted token', () => {
    expect(tokenise('ping --echo ""')).toEqual(['ping', '--echo', '']);
  });

  it('treats an unterminated quote as running to the end of the line', () => {
    expect(tokenise("raw --text 'unclosed")).toEqual(['raw', '--text', 'unclosed']);
  });

  it('splits on tabs as well as spaces', () => {
    expect(tokenise('ping\t--echo\tvalue')).toEqual(['ping', '--echo', 'value']);
  });

  it('joins a quoted segment to the text touching it', () => {
    expect(tokenise('--body="{}"')).toEqual(['--body={}']);
  });
});

describe('session lifecycle', () => {
  it('greets with the server it is connected to and leaves on exit', async () => {
    const { code, text } = await run(['exit']);

    expect(code).toBe(0);
    expect(text).toContain(`connected to ${harness.host}:${harness.port} over raw TCP`);
    expect(text).toContain('Disconnecting.');
  });

  it('accepts quit as well as exit', async () => {
    const { code, text } = await run(['quit']);

    expect(code).toBe(0);
    expect(text).toContain('Disconnecting.');
  });

  it('ends cleanly when the input closes without an exit line', async () => {
    const { code, text } = await run(['ping']);

    expect(code).toBe(0);
    expect(text).toContain('Disconnecting.');
  });

  it('ignores blank lines', async () => {
    const { code, text } = await run(['', '   ', 'exit']);

    expect(code).toBe(0);
    expect(text).not.toContain('Unknown');
  });

  it('mentions a remembered session for this server at startup', async () => {
    await writeFile(
      process.env['SOCKETLENS_STATE_FILE']!,
      JSON.stringify({
        currentSession: 'sess-remembered',
        server: `${harness.host}:${harness.port}`,
      }),
      'utf8',
    );

    const { text } = await run(['exit']);

    expect(text).toContain('Current session: sess-remembered');
  });

  it('stays quiet about a session remembered for a different server', async () => {
    await writeFile(
      process.env['SOCKETLENS_STATE_FILE']!,
      JSON.stringify({ currentSession: 'sess-elsewhere', server: '127.0.0.1:9999' }),
      'utf8',
    );

    const { text } = await run(['exit']);

    expect(text).not.toContain('sess-elsewhere');
  });
});

describe('commands', () => {
  it('runs a command over the held connection', async () => {
    const { text } = await run(['ping', 'exit']);

    expect(text).toContain('200');
  });

  it('runs several commands on one connection', async () => {
    const { text } = await run(['ping', 'info', 'exit']);

    expect(text).toContain('SLTP');
    // Both commands produced output before the prompt was left.
    expect(text).toContain('Disconnecting.');
  });

  it('prints the prompt help without contacting the server', async () => {
    const { text } = await run(['help', 'exit']);

    expect(text).toContain('Prompt controls');
    expect(text).toContain('raw on | raw off');
  });

  it('prints per-command help for a --help flag', async () => {
    const { text } = await run(['ping --help', 'exit']);

    expect(text).toContain('ping');
  });

  it('reports an unknown command without leaving the prompt', async () => {
    const { code, text } = await run(['nonsense', 'ping', 'exit']);

    // The error sets a failing code, but the prompt carries on to the next line.
    expect(text).toContain('200');
    expect(code).toBe(0);
  });

  it('reports a usage error and keeps going', async () => {
    const { text } = await run(['session show --nope', 'exit']);

    expect(text.toLowerCase()).toMatch(/unknown|usage|unrecognis/);
  });

  it('returns a non-zero code when the last command failed', async () => {
    const { code } = await run(['nonsense']);

    expect(code).toBe(1);
  });
});

describe('prompt controls', () => {
  it('acknowledges raw on and raw off', async () => {
    const { text } = await run(['raw on', 'raw off', 'exit']);

    expect(text).toContain('Raw byte output enabled');
    expect(text).toContain('Raw byte output disabled');
  });

  it('shows exact bytes once raw is on', async () => {
    const { text } = await run(['raw on', 'ping', 'exit']);

    // The escaped CRLF is the whole reason the control exists.
    expect(text).toContain('\\r\\n');
  });

  // Regression guard: the renderer holds this setting for the whole prompt session, so
  // an off-switch that only updated the inherited flags would leave bytes printing.
  it('stops showing bytes again after raw off', async () => {
    const { out } = await run(['raw on', 'ping', 'raw off', 'ping', 'exit']);

    const disabledAt = out.findIndex((line) => line.includes('Raw byte output disabled'));
    expect(disabledAt).toBeGreaterThan(-1);
    expect(out.slice(0, disabledAt).join('\n')).toContain('\\r\\n');
    expect(out.slice(disabledAt).join('\n')).not.toContain('\\r\\n');
  });

  it('acknowledges the logging controls', async () => {
    const { text } = await run(['verbose', 'quiet', 'exit']);

    expect(text).toContain('Verbose protocol logging enabled');
    expect(text).toContain('Protocol logging suppressed');
  });

  // The controls are mutually exclusive: turning one on must clear the others rather
  // than accumulate contradictory flags for every later command.
  it('replaces rather than accumulates the verbosity flags', async () => {
    const { code } = await run(['verbose', 'quiet', 'raw on', 'ping', 'exit']);

    expect(code).toBe(0);
  });

  it('reports no session when none is remembered', async () => {
    const { text } = await run(['session', 'exit']);

    expect(text).toContain('No session selected.');
  });

  it('reports the remembered session', async () => {
    await writeFile(
      process.env['SOCKETLENS_STATE_FILE']!,
      JSON.stringify({ currentSession: 'sess-abc', server: `${harness.host}:${harness.port}` }),
      'utf8',
    );

    const { text } = await run(['session', 'exit']);

    expect(text).toContain('Current session: sess-abc');
  });

  it('warns when the remembered session belongs to another server', async () => {
    await writeFile(
      process.env['SOCKETLENS_STATE_FILE']!,
      JSON.stringify({ currentSession: 'sess-xyz', server: '127.0.0.1:9999' }),
      'utf8',
    );

    const { text } = await run(['session', 'exit']);

    expect(text).toContain('belongs to 127.0.0.1:9999');
  });

  it('inherits outer flags into prompt commands', async () => {
    const { text } = await run(['ping', 'exit'], { inherited: ['--raw'] });

    expect(text).toContain('\\r\\n');
  });
});

describe('losing the connection', () => {
  // A prompt that keeps accepting input it can no longer send is worse than one that
  // ends, so a server-side disconnect closes it.
  it('ends the prompt when the server goes away', async () => {
    const out: string[] = [];
    const renderer = new Renderer((line) => out.push(line), { colour: false });
    const client = await harness.client();

    // A slow trickle of lines, so the server can close mid-session.
    const stream = new Readable({ read() {} });
    stream.push('ping\n');

    const finished = runRepl({
      client,
      renderer,
      server: `${harness.host}:${harness.port}`,
      inherited: [],
      input: stream,
      output: sink(),
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    await harness.server.close(50);

    const code = await finished;
    const text = out.join('\n');

    expect(text).toMatch(/Connection lost|connection is closed/i);
    expect(code).toBeTypeOf('number');
  });
});
