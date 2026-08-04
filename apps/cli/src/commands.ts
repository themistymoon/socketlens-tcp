/**
 * Command implementations.
 *
 * Every command receives an already-connected {@link SltpClient} and does its work
 * by exchanging SLTP messages. No command reaches into server internals, so the CLI
 * exercises exactly the protocol surface that the specification documents.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  isSuccessStatus,
  SLTP_HEADER,
  SLTP_OPERATION_REGISTRY,
  SLTP_STATUS,
  SLTP_STATUS_REGISTRY,
  getHeader,
  statusPhrase,
  type SltpResponse,
} from '@socketlens/protocol';
import {
  createResultExport,
  parseBundle,
  serialiseResults,
  validateAddRuleInput,
  validateScenario,
  type AddRuleInput,
  type Exchange,
  type MockRule,
  type Session,
  type SltpClient,
  type TestResult,
  type TestResultSummary,
  type TestScenario,
} from '@socketlens/core';
import {
  UsageError,
  headerFlags,
  numberFlag,
  stringFlag,
  type ParsedCommandLine,
} from './options.js';
import { type Renderer } from './render.js';
import { forgetSession, readState, rememberSession } from './state.js';

/** Everything a command needs to run. */
export interface CommandContext {
  readonly client: SltpClient;
  readonly renderer: Renderer;
  readonly parsed: ParsedCommandLine;
  /** Server address in `host:port` form, used when remembering a session. */
  readonly server: string;
}

/** Result of running a command: the process exit code it implies. */
export type CommandResult = 0 | 1;

/** Raised when the server answered with an error status the command cannot continue past. */
export class SltpStatusError extends Error {
  readonly statusCode: number;
  readonly response: SltpResponse;

  constructor(exchange: Exchange) {
    const phrase = exchange.response.statusPhrase || statusPhrase(exchange.response.statusCode);
    super(`${exchange.response.statusCode} ${phrase}${detailOf(exchange.response)}`);
    this.name = 'SltpStatusError';
    this.statusCode = exchange.response.statusCode;
    this.response = exchange.response;
  }
}

/** Extracts the `error` field a failing SLTP response carries in its JSON body. */
function detailOf(response: SltpResponse): string {
  const body = parseJsonBody<{ error?: unknown; problems?: unknown }>(response);
  const parts: string[] = [];
  if (typeof body?.error === 'string') parts.push(body.error);
  if (Array.isArray(body?.problems)) {
    for (const problem of body.problems) parts.push(`  • ${String(problem)}`);
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
}

/** Parses a response body as JSON, returning `undefined` when it is not JSON. */
export function parseJsonBody<T>(response: SltpResponse): T | undefined {
  if (response.body.length === 0) return undefined;
  try {
    return JSON.parse(response.body) as T;
  } catch {
    return undefined;
  }
}

/** Sends a request and throws when the status is not a success. */
async function require2xx(
  client: SltpClient,
  options: Parameters<SltpClient['send']>[0],
): Promise<Exchange> {
  const exchange = await client.send(options);
  if (!isSuccessStatus(exchange.response.statusCode)) throw new SltpStatusError(exchange);
  return exchange;
}

/** Reads the session identifier a command should act on. */
async function resolveSession(context: CommandContext): Promise<string> {
  const explicit = context.parsed.global.session;
  if (explicit !== undefined) return explicit;

  const state = await readState();
  if (state.currentSession === undefined) {
    throw new UsageError(
      'No session selected. Create one with `socketlens session create`, or pass --session <id>.',
    );
  }
  if (state.server !== undefined && state.server !== context.server) {
    throw new UsageError(
      `The remembered session ${state.currentSession} belongs to ${state.server}, not ${context.server}. ` +
        'Pass --session <id> explicitly, or select one with `socketlens session use <id>`.',
    );
  }
  return state.currentSession;
}

// ─── connectivity ────────────────────────────────────────────────────────────

/** `ping` — liveness probe. */
export async function commandPing(context: CommandContext): Promise<CommandResult> {
  const echo = stringFlag(context.parsed.flags, 'echo');
  const exchange = await context.client.send({
    operation: 'PING',
    ...(echo !== undefined ? { json: { echo } } : {}),
  });

  if (context.parsed.global.json) {
    context.renderer.json(parseJsonBody(exchange.response) ?? {});
    return isSuccessStatus(exchange.response.statusCode) ? 0 : 1;
  }

  context.renderer.response(exchange);
  return isSuccessStatus(exchange.response.statusCode) ? 0 : 1;
}

/** `info` — server capabilities, limits, and registries. */
export async function commandInfo(context: CommandContext): Promise<CommandResult> {
  const exchange = await require2xx(context.client, { operation: 'SERVER_INFO' });
  const body = parseJsonBody<Record<string, unknown>>(exchange.response) ?? {};

  if (context.parsed.global.json) {
    context.renderer.json(body);
    return 0;
  }

  context.renderer.response(exchange);
  return 0;
}

// ─── sessions ────────────────────────────────────────────────────────────────

/** `session create` — creates a session and remembers it for later commands. */
export async function commandSessionCreate(context: CommandContext): Promise<CommandResult> {
  const name = stringFlag(context.parsed.flags, 'name');
  const description = stringFlag(context.parsed.flags, 'description');

  const exchange = await require2xx(context.client, {
    operation: 'CREATE_SESSION',
    json: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    },
  });

  const session = parseJsonBody<{ session: Session }>(exchange.response)?.session;
  if (!session) throw new Error('CREATE_SESSION succeeded but returned no session object.');

  const remembered = await rememberSession(session.id, context.server);

  if (context.parsed.global.json) {
    context.renderer.json(session);
    return 0;
  }

  context.renderer.success(
    `Session ${session.id} created (${exchange.response.statusCode} ${exchange.response.statusPhrase}).`,
  );
  context.renderer.session(session);
  context.renderer.note(
    `Its mock endpoint listens on ${session.mockHost}:${session.mockPort}; scenarios connect there over raw TCP.`,
  );
  if (remembered) {
    context.renderer.note('This session is now the default for subsequent commands.');
  } else {
    context.renderer.warn('Could not write the CLI state file; pass --session on later commands.');
  }
  if (context.parsed.global.raw) context.renderer.response(exchange);
  return 0;
}

/** `session list` — every session on the server. */
export async function commandSessionList(context: CommandContext): Promise<CommandResult> {
  const exchange = await require2xx(context.client, { operation: 'LIST_SESSIONS' });
  const body = parseJsonBody<{ sessions: Session[]; count: number }>(exchange.response);

  if (context.parsed.global.json) {
    context.renderer.json(body ?? {});
    return 0;
  }

  context.renderer.sessionList(body?.sessions ?? []);
  return 0;
}

/** `session show` — one session in full. */
export async function commandSessionShow(context: CommandContext): Promise<CommandResult> {
  const sessionId = context.parsed.positional[0] ?? (await resolveSession(context));
  const exchange = await require2xx(context.client, { operation: 'GET_SESSION', sessionId });
  const session = parseJsonBody<{ session: Session }>(exchange.response)?.session;

  if (context.parsed.global.json) {
    context.renderer.json(session ?? {});
    return 0;
  }

  if (session) context.renderer.session(session);
  return 0;
}

/** `session use <id>` — selects the default session without contacting the server. */
export async function commandSessionUse(context: CommandContext): Promise<CommandResult> {
  const sessionId = context.parsed.positional[0];
  if (sessionId === undefined) {
    throw new UsageError('`session use` needs a session identifier: socketlens session use <id>');
  }

  // Verify it exists before remembering it, so a typo is caught immediately.
  await require2xx(context.client, { operation: 'GET_SESSION', sessionId });
  const remembered = await rememberSession(sessionId, context.server);

  if (remembered) context.renderer.success(`Session ${sessionId} is now the default.`);
  else
    context.renderer.warn('Could not write the CLI state file; pass --session on later commands.');
  return remembered ? 0 : 1;
}

/** `session close` — closes a session and stops its mock endpoint. */
export async function commandSessionClose(context: CommandContext): Promise<CommandResult> {
  const sessionId = context.parsed.positional[0] ?? (await resolveSession(context));
  const exchange = await require2xx(context.client, { operation: 'CLOSE_SESSION', sessionId });

  const state = await readState();
  if (state.currentSession === sessionId) await forgetSession();

  if (context.parsed.global.json) {
    context.renderer.json(parseJsonBody(exchange.response) ?? {});
    return 0;
  }

  context.renderer.success(
    `Session ${sessionId} closed (${exchange.response.statusCode} ${exchange.response.statusPhrase}). ` +
      'Its mock endpoint has stopped listening; stored results remain readable.',
  );
  return 0;
}

// ─── rules ───────────────────────────────────────────────────────────────────

/**
 * Builds a rule from either a JSON source or the convenience flags.
 *
 * The flag form exists because a live demonstration should not require writing a
 * JSON file to show a mock responding.
 */
async function ruleFromArguments(context: CommandContext): Promise<AddRuleInput> {
  const file = stringFlag(context.parsed.flags, 'file');
  const inline = stringFlag(context.parsed.flags, 'json-body');

  if (file !== undefined || inline !== undefined) {
    const text = file !== undefined ? await readTextFile(file) : inline!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new UsageError(
        `${file ?? '--json-body'} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const validated = validateAddRuleInput(parsed);
    if (!validated.ok)
      throw new UsageError(`Invalid rule:\n  • ${validated.problems.join('\n  • ')}`);
    return validated.value;
  }

  const name = stringFlag(context.parsed.flags, 'name');
  if (name === undefined) {
    throw new UsageError(
      'Describe the rule with --file <path>, --json-body <json>, or the flags ' +
        '--name --operation --status [--phrase] [--body] [--priority] [--delay].',
    );
  }

  const statusCode = numberFlag(context.parsed.flags, 'status') ?? SLTP_STATUS.OK;
  const candidate: AddRuleInput = {
    name,
    priority: numberFlag(context.parsed.flags, 'priority') ?? 0,
    match: {
      operation: stringFlag(context.parsed.flags, 'operation') ?? '*',
      ...(Object.keys(headerFlags(context.parsed.flags)).length > 0
        ? { headers: headerFlags(context.parsed.flags) }
        : {}),
    },
    response: {
      statusCode,
      statusPhrase: stringFlag(context.parsed.flags, 'phrase') ?? statusPhrase(statusCode),
      ...(stringFlag(context.parsed.flags, 'body') !== undefined
        ? { body: stringFlag(context.parsed.flags, 'body')! }
        : {}),
      ...(numberFlag(context.parsed.flags, 'delay') !== undefined
        ? { delayMs: numberFlag(context.parsed.flags, 'delay')! }
        : {}),
      ...(stringFlag(context.parsed.flags, 'fragment') !== undefined
        ? { fragment: { sizes: parseSizes(stringFlag(context.parsed.flags, 'fragment')!) } }
        : {}),
    },
  };

  const validated = validateAddRuleInput(candidate);
  if (!validated.ok)
    throw new UsageError(`Invalid rule:\n  • ${validated.problems.join('\n  • ')}`);
  return validated.value;
}

/** Parses `10,20,30` into fragment sizes. */
function parseSizes(value: string): number[] {
  return value.split(',').map((part) => {
    const size = Number(part.trim());
    if (!Number.isInteger(size) || size <= 0) {
      throw new UsageError(
        `--fragment expects positive integers, for example 12,8,20 (got "${part.trim()}").`,
      );
    }
    return size;
  });
}

/** `rule add` — installs a mock rule into the session. */
export async function commandRuleAdd(context: CommandContext): Promise<CommandResult> {
  const sessionId = await resolveSession(context);
  const rule = await ruleFromArguments(context);

  const exchange = await require2xx(context.client, {
    operation: 'ADD_RULE',
    sessionId,
    json: rule,
  });
  const stored = parseJsonBody<{ rule: MockRule }>(exchange.response)?.rule;

  if (context.parsed.global.json) {
    context.renderer.json(stored ?? {});
    return 0;
  }

  context.renderer.success(
    `${exchange.response.statusCode} ${exchange.response.statusPhrase}: rule "${rule.name}" installed.`,
  );
  if (stored) context.renderer.rule(stored);
  return 0;
}

/** `rule list` — rules in matcher evaluation order. */
export async function commandRuleList(context: CommandContext): Promise<CommandResult> {
  const sessionId = await resolveSession(context);
  const exchange = await require2xx(context.client, { operation: 'LIST_RULES', sessionId });
  const body = parseJsonBody<{ rules: MockRule[]; evaluationOrder: string }>(exchange.response);

  if (context.parsed.global.json) {
    context.renderer.json(body ?? {});
    return 0;
  }

  context.renderer.ruleList(body?.rules ?? []);
  return 0;
}

/** `rule update` — changes fields on an existing rule. */
export async function commandRuleUpdate(context: CommandContext): Promise<CommandResult> {
  const sessionId = await resolveSession(context);
  const id = context.parsed.positional[0] ?? stringFlag(context.parsed.flags, 'id');
  if (id === undefined) {
    throw new UsageError(
      '`rule update` needs a rule identifier: socketlens rule update <ruleId> …',
    );
  }

  const file = stringFlag(context.parsed.flags, 'file');
  const inline = stringFlag(context.parsed.flags, 'json-body');
  const patch: Record<string, unknown> = { id };

  if (file !== undefined || inline !== undefined) {
    const text = file !== undefined ? await readTextFile(file) : inline!;
    try {
      Object.assign(patch, JSON.parse(text) as Record<string, unknown>, { id });
    } catch (cause) {
      throw new UsageError(
        `Rule patch is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  } else {
    const name = stringFlag(context.parsed.flags, 'name');
    const priority = numberFlag(context.parsed.flags, 'priority');
    if (name !== undefined) patch['name'] = name;
    if (priority !== undefined) patch['priority'] = priority;
    if (context.parsed.flags['enable'] === true) patch['enabled'] = true;
    if (context.parsed.flags['disable'] === true) patch['enabled'] = false;
    if (Object.keys(patch).length === 1) {
      throw new UsageError(
        'Nothing to change. Use --name, --priority, --enable, --disable, --file, or --json-body.',
      );
    }
  }

  const exchange = await require2xx(context.client, {
    operation: 'UPDATE_RULE',
    sessionId,
    json: patch,
  });
  const stored = parseJsonBody<{ rule: MockRule }>(exchange.response)?.rule;

  if (context.parsed.global.json) {
    context.renderer.json(stored ?? {});
    return 0;
  }

  context.renderer.success(
    `${exchange.response.statusCode} ${exchange.response.statusPhrase}: rule ${id} updated.`,
  );
  if (stored) context.renderer.rule(stored);
  return 0;
}

/** `rule delete` — removes a rule. */
export async function commandRuleDelete(context: CommandContext): Promise<CommandResult> {
  const sessionId = await resolveSession(context);
  const id = context.parsed.positional[0] ?? stringFlag(context.parsed.flags, 'id');
  if (id === undefined) {
    throw new UsageError('`rule delete` needs a rule identifier: socketlens rule delete <ruleId>');
  }

  const exchange = await require2xx(context.client, {
    operation: 'DELETE_RULE',
    sessionId,
    json: { id },
  });

  context.renderer.success(
    `${exchange.response.statusCode} ${exchange.response.statusPhrase}: rule ${id} deleted.`,
  );
  return 0;
}

// ─── running tests ───────────────────────────────────────────────────────────

/** Sends one scenario and prints its result. Returns true when the test passed. */
async function runScenario(
  context: CommandContext,
  sessionId: string,
  scenario: TestScenario,
): Promise<{ passed: boolean; result: TestResult | undefined; statusCode: number }> {
  // The server runs the scenario over a real socket, so the control request must
  // outlast the scenario's own timeout rather than racing it.
  const controlTimeout = Math.max(
    context.parsed.global.timeoutMs,
    (scenario.timeoutMs ?? 0) + 5_000,
  );

  const exchange = await context.client.send({
    operation: 'RUN_TEST',
    sessionId,
    timeoutMs: controlTimeout,
    json: { scenario },
  });

  const result = parseJsonBody<{ result: TestResult }>(exchange.response)?.result;

  if (exchange.response.statusCode === SLTP_STATUS.INVALID_SCENARIO) {
    throw new SltpStatusError(exchange);
  }

  if (context.parsed.global.json) {
    context.renderer.json(result ?? parseJsonBody(exchange.response) ?? {});
  } else {
    context.renderer.blank();
    if (result) context.renderer.result(result);
    else context.renderer.response(exchange);
    context.renderer.note(
      `  control response: ${exchange.response.statusCode} ${exchange.response.statusPhrase}`,
    );
  }

  return {
    passed: result?.passed ?? false,
    result,
    statusCode: exchange.response.statusCode,
  };
}

/**
 * `run` — executes scenarios against the session's mock endpoint.
 *
 * Accepts a scenario file (`--file`), an inline scenario (`--json-body`), or a bare
 * operation (`--operation`) for the simplest possible demonstration.
 */
export async function commandRun(context: CommandContext): Promise<CommandResult> {
  const sessionId = await resolveSession(context);
  const { scenarios, rules, sourceName } = await loadScenarios(context);

  if (rules.length > 0 && context.parsed.flags['no-install-rules'] !== true) {
    for (const rule of rules) {
      const exchange = await context.client.send({ operation: 'ADD_RULE', sessionId, json: rule });
      if (isSuccessStatus(exchange.response.statusCode)) {
        if (!context.parsed.global.json) {
          context.renderer.note(`installed rule "${rule.name}" from ${sourceName}`);
        }
      } else if (exchange.response.statusCode === SLTP_STATUS.RULE_CONFLICT) {
        // Re-running a bundle against the same session is expected during a demo.
        if (!context.parsed.global.json) {
          context.renderer.note(`rule "${rule.name}" already present, keeping the existing one`);
        }
      } else {
        throw new SltpStatusError(exchange);
      }
    }
  }

  const only = stringFlag(context.parsed.flags, 'scenario');
  const selected = only === undefined ? scenarios : scenarios.filter((s) => s.name === only);
  if (selected.length === 0) {
    throw new UsageError(
      only === undefined
        ? `${sourceName} contains no scenarios.`
        : `${sourceName} has no scenario named "${only}". Available: ${scenarios.map((s) => s.name).join(', ')}`,
    );
  }

  let failures = 0;
  for (const scenario of selected) {
    const outcome = await runScenario(context, sessionId, scenario);
    if (!outcome.passed) failures += 1;
  }

  if (!context.parsed.global.json && selected.length > 1) {
    context.renderer.blank();
    const passed = selected.length - failures;
    context.renderer.heading(`${passed}/${selected.length} scenario(s) passed`);
  }

  return failures === 0 ? 0 : 1;
}

/** Collects the scenarios a `run` invocation should execute. */
async function loadScenarios(
  context: CommandContext,
): Promise<{ scenarios: TestScenario[]; rules: AddRuleInput[]; sourceName: string }> {
  const file = stringFlag(context.parsed.flags, 'file') ?? context.parsed.positional[0];
  const inline = stringFlag(context.parsed.flags, 'json-body');

  if (file !== undefined) {
    const text = await readTextFile(file);
    const bundle = parseBundle(text, path.basename(file));
    if (!bundle.ok)
      throw new UsageError(`Invalid scenario file:\n  • ${bundle.problems.join('\n  • ')}`);
    return {
      scenarios: [...bundle.value.scenarios],
      rules: [...(bundle.value.rules ?? [])],
      sourceName: path.basename(file),
    };
  }

  if (inline !== undefined) {
    const bundle = parseBundle(inline, 'the --json-body value');
    if (!bundle.ok)
      throw new UsageError(`Invalid scenario:\n  • ${bundle.problems.join('\n  • ')}`);
    return {
      scenarios: [...bundle.value.scenarios],
      rules: [...(bundle.value.rules ?? [])],
      sourceName: 'the --json-body value',
    };
  }

  const operation = stringFlag(context.parsed.flags, 'operation');
  if (operation === undefined) {
    throw new UsageError(
      'Nothing to run. Pass a scenario file, --json-body <json>, or --operation <OPERATION>.',
    );
  }

  const expectStatus = numberFlag(context.parsed.flags, 'expect-status');
  const candidate = {
    name: stringFlag(context.parsed.flags, 'name') ?? `ad-hoc ${operation}`,
    request: {
      operation,
      ...(stringFlag(context.parsed.flags, 'body') !== undefined
        ? { body: stringFlag(context.parsed.flags, 'body') }
        : {}),
      ...(Object.keys(headerFlags(context.parsed.flags)).length > 0
        ? { headers: headerFlags(context.parsed.flags) }
        : {}),
    },
    ...(stringFlag(context.parsed.flags, 'fragment') !== undefined
      ? {
          transmission: {
            mode: 'fragmented',
            fragmentSizes: parseSizes(stringFlag(context.parsed.flags, 'fragment')!),
            ...(numberFlag(context.parsed.flags, 'delay') !== undefined
              ? { interFragmentDelayMs: numberFlag(context.parsed.flags, 'delay')! }
              : {}),
          },
        }
      : {}),
    ...(numberFlag(context.parsed.flags, 'timeout') !== undefined
      ? { timeoutMs: numberFlag(context.parsed.flags, 'timeout')! }
      : {}),
    ...(expectStatus !== undefined ? { expect: { statusCode: expectStatus } } : {}),
  };

  const validated = validateScenario(candidate);
  if (!validated.ok)
    throw new UsageError(`Invalid scenario:\n  • ${validated.problems.join('\n  • ')}`);
  return { scenarios: [validated.value], rules: [], sourceName: 'the command line' };
}

/** `scenario show` — validates and prints a scenario file without running it. */
export async function commandScenarioShow(context: CommandContext): Promise<CommandResult> {
  const file = stringFlag(context.parsed.flags, 'file') ?? context.parsed.positional[0];
  if (file === undefined) {
    throw new UsageError('`scenario show` needs a file: socketlens scenario show <file.json>');
  }

  const bundle = parseBundle(await readTextFile(file), path.basename(file));
  if (!bundle.ok) {
    context.renderer.error(`${file} is not a usable scenario file:`);
    for (const problem of bundle.problems) context.renderer.line(`  • ${problem}`);
    return 1;
  }

  if (context.parsed.global.json) {
    context.renderer.json(bundle.value);
    return 0;
  }

  context.renderer.heading(bundle.value.name);
  if (bundle.value.description) context.renderer.note(bundle.value.description);
  context.renderer.fields([
    ['format', bundle.value.format],
    ['protocol', bundle.value.protocol],
    ['rules', bundle.value.rules?.length ?? 0],
    ['scenarios', bundle.value.scenarios.length],
  ]);
  context.renderer.blank();
  for (const scenario of bundle.value.scenarios) {
    context.renderer.line(
      `  • ${scenario.name} — ${scenario.transmission?.mode ?? 'single'} transmission, ` +
        `timeout ${scenario.timeoutMs ?? 'default'}`,
    );
  }
  return 0;
}

// ─── results ─────────────────────────────────────────────────────────────────

/** `result list` — every stored result for the session. */
export async function commandResultList(context: CommandContext): Promise<CommandResult> {
  const sessionId = await resolveSession(context);
  const exchange = await require2xx(context.client, { operation: 'LIST_RESULTS', sessionId });
  const body = parseJsonBody<{ results: TestResultSummary[]; passed: number; failed: number }>(
    exchange.response,
  );

  if (context.parsed.global.json) {
    context.renderer.json(body ?? {});
    return 0;
  }

  context.renderer.resultList(body?.results ?? []);
  if (body) context.renderer.note(`${body.passed} passed, ${body.failed} failed.`);
  return 0;
}

/** `result show <id>` — one result in full, including its wire segments. */
export async function commandResultShow(context: CommandContext): Promise<CommandResult> {
  const sessionId = await resolveSession(context);
  const id = context.parsed.positional[0] ?? stringFlag(context.parsed.flags, 'id');
  if (id === undefined) {
    throw new UsageError(
      '`result show` needs a result identifier: socketlens result show <resultId>',
    );
  }

  const exchange = await require2xx(context.client, {
    operation: 'GET_RESULT',
    sessionId,
    json: { id },
  });
  const result = parseJsonBody<{ result: TestResult }>(exchange.response)?.result;

  if (context.parsed.global.json) {
    context.renderer.json(result ?? {});
    return 0;
  }

  if (result) context.renderer.result(result);
  return result?.passed === true ? 0 : 1;
}

/** `result export` — writes every stored result to a JSON file. */
export async function commandResultExport(context: CommandContext): Promise<CommandResult> {
  const sessionId = await resolveSession(context);
  const out = stringFlag(context.parsed.flags, 'out') ?? context.parsed.positional[0];
  if (out === undefined) {
    throw new UsageError(
      '`result export` needs a destination: socketlens result export --out results.json',
    );
  }

  const listed = await require2xx(context.client, { operation: 'LIST_RESULTS', sessionId });
  const summaries = parseJsonBody<{ results: TestResultSummary[] }>(listed.response)?.results ?? [];

  const results: TestResult[] = [];
  for (const summary of summaries) {
    const exchange = await require2xx(context.client, {
      operation: 'GET_RESULT',
      sessionId,
      json: { id: summary.id },
    });
    const result = parseJsonBody<{ result: TestResult }>(exchange.response)?.result;
    if (result) results.push(result);
  }

  const text = serialiseResults(createResultExport(sessionId, results, new Date().toISOString()));
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, text, 'utf8');

  context.renderer.success(`Wrote ${results.length} result(s) to ${out}.`);
  return 0;
}

// ─── raw bytes ───────────────────────────────────────────────────────────────

/**
 * `raw` — writes bytes onto the socket with no encoding and no correlation.
 *
 * This is how a demonstration shows what the server does with a malformed message.
 * `\r\n` and `\n` escape sequences in `--text` are converted to real CRLF, because a
 * shell cannot easily produce a carriage return.
 */
export async function commandRaw(context: CommandContext): Promise<CommandResult> {
  const file = stringFlag(context.parsed.flags, 'file');
  const text = stringFlag(context.parsed.flags, 'text') ?? context.parsed.positional[0];

  if (file === undefined && text === undefined) {
    throw new UsageError(
      'Nothing to send. Use --text "SLTP/1.0 PING\\r\\nRequest-ID: r1\\r\\n\\r\\n" or --file <path>.',
    );
  }

  const payload =
    file !== undefined
      ? Buffer.from(await readTextFile(file), 'utf8')
      : Buffer.from(unescapeCrlf(text!), 'utf8');

  const received: Buffer[] = [];
  const waitMs = numberFlag(context.parsed.flags, 'timeout') ?? 1_000;

  // `sendRaw` bypasses correlation, so the reply is collected by watching the
  // connection for a fixed window rather than by matching a Request-ID.
  const collected = context.client.collectRaw(waitMs, (chunk) => received.push(chunk));
  await context.client.sendRaw(payload);
  await collected;

  const reply = Buffer.concat(received);
  context.renderer.heading(`Wrote ${payload.length} raw byte(s), received ${reply.length}`);
  if (reply.length === 0) {
    context.renderer.note(`Nothing arrived within ${waitMs} ms.`);
    return 1;
  }
  context.renderer.line(reply.toString('utf8').replace(/\r\n/g, '\\r\\n\n'));
  return 0;
}

/** Turns literal `\r`, `\n`, and `\t` escapes into the characters they denote. */
export function unescapeCrlf(value: string): string {
  return value.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

// ─── reference output ────────────────────────────────────────────────────────

/** Prints the operation and status registries, so the CLI documents the protocol. */
export function printRegistries(renderer: Renderer): void {
  renderer.heading('SLTP/1.0 operations');
  for (const operation of SLTP_OPERATION_REGISTRY) {
    renderer.line(`  ${operation.name.padEnd(16)} ${operation.summary}`);
  }
  renderer.blank();
  renderer.heading('SLTP/1.0 status codes');
  for (const status of SLTP_STATUS_REGISTRY) {
    renderer.line(
      `  ${String(status.code).padEnd(5)} ${status.phrase.padEnd(24)} ${status.meaning}`,
    );
  }
}

// ─── file access ─────────────────────────────────────────────────────────────

/** Reads a UTF-8 text file, reporting a missing file as a usage problem. */
export async function readTextFile(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new UsageError(`File not found: ${file}`);
    throw new UsageError(
      `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Reads the `Reason` header a failing SLTP response carries, when present. */
export function reasonOf(response: SltpResponse): string | undefined {
  return getHeader(response.headers, SLTP_HEADER.reason);
}
