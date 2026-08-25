#!/usr/bin/env node
/**
 * SocketLens TCP command-line client.
 *
 * The CLI is the primary SLTP client and is fully functional without the graphical
 * interface. It opens one raw TCP connection to the control server, exchanges SLTP
 * messages, and prints them. No HTTP is involved at any point.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { ProtocolLogger, SltpClient, SltpClientError, type LogLevel } from '@socketlens/core';
import { dispatch } from './dispatch.js';
import { SltpStatusError } from './commands.js';
import { USAGE, helpFor } from './help.js';
import { UsageError, parseCommandLine, type GlobalOptions } from './options.js';
import { Renderer, stdoutWriter } from './render.js';
import { runRepl } from './repl.js';

export { parseCommandLine, UsageError } from './options.js';
export { Renderer } from './render.js';
export { dispatch, isKnownCommand } from './dispatch.js';
export { tokenise } from './repl.js';
export { unescapeCrlf, parseJsonBody } from './commands.js';
export { USAGE, helpFor } from './help.js';
export type { GlobalOptions, ParsedCommandLine } from './options.js';
export type { CommandContext, CommandResult } from './commands.js';

/** Version reported by `--version`. Kept in step with the workspace manifests. */
export const CLI_VERSION = '0.1.2';

/** Chooses the protocol log level implied by the global flags. */
function logLevelFor(global: GlobalOptions): LogLevel {
  if (global.quiet) return 'silent';
  if (global.verbose) return 'verbose';
  // The default prints one summary line per message, which keeps a demonstration
  // readable while still proving that traffic crossed the socket.
  return 'summary';
}

/**
 * Runs the CLI and returns the process exit code.
 *
 * Exit codes: 0 success, 1 a command or test failed, 2 a usage problem, 3 the
 * server could not be reached.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseCommandLine(argv);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.stderr.write('Run `socketlens --help` for usage.\n');
    return 2;
  }

  const renderer = new Renderer(stdoutWriter, {
    raw: parsed.global.raw,
    ...(parsed.global.noColour ? { colour: false } : {}),
  });

  if (parsed.version) {
    renderer.line(`socketlens ${CLI_VERSION} (SLTP/1.0)`);
    return 0;
  }

  if (parsed.help && parsed.command.length === 0) {
    renderer.line(USAGE);
    return 0;
  }

  if (parsed.command.length === 0) {
    renderer.line(USAGE);
    return 0;
  }

  // The registry listings are reference output and need no server.
  if (parsed.command[0] === 'help') {
    const topic = parsed.positional[0];
    if (topic === 'operations' || topic === 'status') {
      const { printRegistries } = await import('./commands.js');
      printRegistries(renderer);
      return 0;
    }
    renderer.line(USAGE);
    return 0;
  }

  if (parsed.help) {
    renderer.line(helpFor(parsed.command));
    return 0;
  }

  const logger = new ProtocolLogger({
    role: 'CLIENT',
    level: logLevelFor(parsed.global),
    ...(parsed.global.noColour ? { colour: false } : {}),
  });

  const client = new SltpClient({
    host: parsed.global.host,
    port: parsed.global.port,
    timeoutMs: parsed.global.timeoutMs,
    logger,
  });

  const server = `${parsed.global.host}:${parsed.global.port}`;

  try {
    await client.connect();
  } catch (cause) {
    renderer.error(cause instanceof Error ? cause.message : String(cause));
    renderer.note('Start it in another terminal with `npm run dev:server`.');
    return 3;
  }

  try {
    if (parsed.command[0] === 'repl') {
      return await runRepl({
        client,
        renderer,
        server,
        inherited: inheritedFlags(parsed.global),
      });
    }

    return await dispatch({ client, renderer, parsed, server });
  } catch (cause) {
    return report(renderer, cause);
  } finally {
    await client.close();
  }
}

/** Rebuilds the global flags a prompt command should inherit from the outer invocation. */
function inheritedFlags(global: GlobalOptions): string[] {
  const flags: string[] = [];
  if (global.raw) flags.push('--raw');
  if (global.verbose) flags.push('--verbose');
  if (global.quiet) flags.push('--quiet');
  if (global.json) flags.push('--json');
  if (global.noColour) flags.push('--no-color');
  // Host and port are already bound to the open connection, so they are not repeated.
  return flags;
}

/** Turns a thrown value into a printed message and an exit code. */
function report(renderer: Renderer, cause: unknown): number {
  if (cause instanceof UsageError) {
    renderer.error(cause.message);
    return 2;
  }
  if (cause instanceof SltpStatusError) {
    // A non-2xx status is a legitimate protocol outcome, so it is reported in full
    // rather than treated as a crash.
    renderer.error(cause.message);
    return 1;
  }
  if (cause instanceof SltpClientError) {
    renderer.error(cause.message);
    if (cause.code === 'timeout') {
      renderer.note('Raise the limit with --timeout <ms> if the operation is genuinely slow.');
    }
    return cause.code === 'connect-failed' ? 3 : 1;
  }
  renderer.error(cause instanceof Error ? cause.message : String(cause));
  return 1;
}

// `pathToFileURL` is required rather than string concatenation: on Windows the argv
// path is `C:\...`, which is not a valid URL on its own.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((cause: unknown) => {
      process.stderr.write(
        `${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
      );
      process.exitCode = 1;
    });
}
