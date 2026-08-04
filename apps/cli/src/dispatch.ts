/**
 * Command routing.
 *
 * Kept separate from the entry point so that both one-shot invocations and the
 * interactive prompt dispatch through exactly the same table.
 */
import {
  commandInfo,
  commandPing,
  commandRaw,
  commandResultExport,
  commandResultList,
  commandResultShow,
  commandRuleAdd,
  commandRuleDelete,
  commandRuleList,
  commandRuleUpdate,
  commandRun,
  commandScenarioShow,
  commandSessionClose,
  commandSessionCreate,
  commandSessionList,
  commandSessionShow,
  commandSessionUse,
  printRegistries,
  type CommandContext,
  type CommandResult,
} from './commands.js';
import { UsageError } from './options.js';

/** Every dispatchable command, keyed by its joined path. */
const TABLE: Readonly<Record<string, (context: CommandContext) => Promise<CommandResult>>> = {
  ping: commandPing,
  info: commandInfo,
  'session create': commandSessionCreate,
  'session list': commandSessionList,
  'session show': commandSessionShow,
  'session use': commandSessionUse,
  'session close': commandSessionClose,
  'rule add': commandRuleAdd,
  'rule list': commandRuleList,
  'rule update': commandRuleUpdate,
  'rule delete': commandRuleDelete,
  run: commandRun,
  'scenario run': commandRun,
  'scenario show': commandScenarioShow,
  'result list': commandResultList,
  'result show': commandResultShow,
  'result export': commandResultExport,
  raw: commandRaw,
};

/** Runs the command named on the parsed command line. */
export async function dispatch(context: CommandContext): Promise<CommandResult> {
  const key = context.parsed.command.join(' ');

  if (key === 'help' || key === '') {
    const topic = context.parsed.positional[0];
    if (topic === 'operations' || topic === 'status') {
      printRegistries(context.renderer);
      return 0;
    }
    throw new UsageError('Nothing to do. Run `socketlens --help` for the command list.');
  }

  const command = TABLE[key];
  if (!command) {
    const attempted = key.length > 0 ? key : (context.parsed.command[0] ?? '');
    throw new UsageError(
      `Unknown command "${attempted}". Run \`socketlens --help\` for the command list.`,
    );
  }

  return command(context);
}

/** True when the command path is one the dispatcher knows. */
export function isKnownCommand(command: readonly string[]): boolean {
  return Object.hasOwn(TABLE, command.join(' '));
}
