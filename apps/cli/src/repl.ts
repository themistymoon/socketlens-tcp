/**
 * Interactive mode.
 *
 * The value of a prompt over one-shot commands is that a single TCP connection is
 * held open across many requests. That makes the protocol's correlation model
 * visible: responses are matched by Request-ID, not by arrival order, so a slow
 * RUN_TEST does not block a PING issued after it.
 */
import readline from 'node:readline';
import { type SltpClient } from '@socketlens/core';
import { dispatch } from './dispatch.js';
import { REPL_HELP, helpFor } from './help.js';
import { parseCommandLine, UsageError } from './options.js';
import { type Renderer } from './render.js';
import { readState } from './state.js';

/** What the prompt needs to run. */
export interface ReplOptions {
  readonly client: SltpClient;
  readonly renderer: Renderer;
  readonly server: string;
  /** Global flags from the outer command line, inherited by every prompt command. */
  readonly inherited: readonly string[];
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

/** Runs the interactive prompt until the user exits or the connection drops. */
export async function runRepl(options: ReplOptions): Promise<number> {
  const { client, renderer, server } = options;

  renderer.heading(`SocketLens TCP — connected to ${server} over raw TCP`);
  renderer.note('Type "help" for commands, "exit" to leave.');

  const state = await readState();
  if (state.currentSession !== undefined && state.server === server) {
    renderer.note(`Current session: ${state.currentSession}`);
  }
  renderer.blank();

  const rl = readline.createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    prompt: 'socketlens> ',
  });

  let exitCode = 0;
  let inherited = [...options.inherited];

  // Piped input closes the interface as soon as the last line is read, while the
  // loop below is still working through the queued lines. Prompting a closed
  // interface throws, so the state is tracked and prompting is skipped.
  let readlineClosed = false;
  rl.on('close', () => {
    readlineClosed = true;
  });

  const prompt = (): void => {
    if (!readlineClosed) rl.prompt();
  };

  // A server-side disconnect must end the prompt rather than leave it accepting
  // input it can no longer send.
  const stopWatching = client.onClose((reason) => {
    renderer.blank();
    renderer.error(`Connection lost: ${reason}`);
    rl.close();
  });

  prompt();

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line.length === 0) {
      prompt();
      continue;
    }

    if (line === 'exit' || line === 'quit') break;

    if (line === 'help') {
      renderer.line(REPL_HELP);
      prompt();
      continue;
    }

    // Prompt-only controls, handled before command parsing because they change the
    // settings that later commands inherit.
    const control = await handleControl(line, { renderer, server, inherited });
    if (control !== undefined) {
      inherited = control;
      prompt();
      continue;
    }

    try {
      const words = tokenise(line);
      const parsed = parseCommandLine([...words, ...inherited]);

      if (parsed.help) {
        renderer.line(helpFor(parsed.command));
      } else {
        const code = await dispatch({ client, renderer, parsed, server });
        exitCode = code;
      }
    } catch (cause) {
      if (cause instanceof UsageError) renderer.error(cause.message);
      else renderer.error(cause instanceof Error ? cause.message : String(cause));
      exitCode = 1;
    }

    if (!client.connected) {
      renderer.error('The connection is closed; leaving interactive mode.');
      break;
    }
    prompt();
  }

  stopWatching();
  rl.close();
  renderer.note('Disconnecting.');
  return exitCode;
}

/**
 * Handles a prompt-only control line.
 *
 * Returns the new inherited flag list when the line was a control, or `undefined`
 * when the line should be parsed as a command instead.
 */
async function handleControl(
  line: string,
  context: { renderer: Renderer; server: string; inherited: readonly string[] },
): Promise<string[] | undefined> {
  const flags = context.inherited.filter(
    (flag) => flag !== '--raw' && flag !== '--verbose' && flag !== '--quiet',
  );

  switch (line) {
    case 'raw on':
      context.renderer.note('Raw byte output enabled. Recreate the prompt to change colouring.');
      return [...flags, '--raw'];
    case 'raw off':
      context.renderer.note('Raw byte output disabled.');
      return flags;
    case 'verbose':
      context.renderer.note('Verbose protocol logging enabled for subsequent commands.');
      return [...flags, '--verbose'];
    case 'quiet':
      context.renderer.note('Protocol logging suppressed for subsequent commands.');
      return [...flags, '--quiet'];
    case 'session': {
      const state = await readState();
      if (state.currentSession === undefined) context.renderer.note('No session selected.');
      else if (state.server !== undefined && state.server !== context.server) {
        context.renderer.warn(
          `Remembered session ${state.currentSession} belongs to ${state.server}, not ${context.server}.`,
        );
      } else context.renderer.note(`Current session: ${state.currentSession}`);
      return [...context.inherited];
    }
    default:
      return undefined;
  }
}

/**
 * Splits a prompt line into arguments, honouring single and double quotes.
 *
 * Quoting matters because rule and scenario bodies are JSON, which contains spaces
 * and double quotes of its own.
 */
export function tokenise(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]!;

    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started || current.length > 0) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
  }

  if (started || current.length > 0) tokens.push(current);
  return tokens;
}
