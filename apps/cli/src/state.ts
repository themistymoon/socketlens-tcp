/**
 * Remembered CLI state.
 *
 * Each CLI invocation is a separate process with a separate TCP connection, but a
 * session lives on the server across invocations. Storing the last used session
 * identifier locally is what lets `socketlens rule add` follow `socketlens session
 * create` without the user copying an identifier by hand.
 *
 * The file holds no credentials — SLTP has no authentication — so it is plain JSON
 * under the user's state directory.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Shape of the state file on disk. */
export interface CliState {
  /** Session identifier used when a command does not pass `--session`. */
  readonly currentSession?: string;
  /** Server the session belongs to, so a stale identifier is not reused elsewhere. */
  readonly server?: string;
  readonly updatedAt?: string;
}

/** Resolves the state file path, honouring an override used by the tests. */
export function stateFilePath(): string {
  const override = process.env['SOCKETLENS_STATE_FILE'];
  if (override !== undefined && override.length > 0) return override;
  return path.join(os.homedir(), '.socketlens', 'cli-state.json');
}

/**
 * Reads the remembered state.
 *
 * A missing or corrupt file is not an error: the CLI must remain usable, so the
 * state simply reverts to empty.
 */
export async function readState(): Promise<CliState> {
  try {
    const text = await fs.readFile(stateFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record['currentSession'] === 'string'
        ? { currentSession: record['currentSession'] }
        : {}),
      ...(typeof record['server'] === 'string' ? { server: record['server'] } : {}),
      ...(typeof record['updatedAt'] === 'string' ? { updatedAt: record['updatedAt'] } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Writes the remembered state, creating the directory if needed.
 *
 * A write failure is reported to the caller as `false` rather than thrown: failing
 * to remember a session must not fail the command that already succeeded.
 */
export async function writeState(state: CliState): Promise<boolean> {
  const target = stateFilePath();
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(
      target,
      `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/** Records the session a subsequent command should default to. */
export async function rememberSession(sessionId: string, server: string): Promise<boolean> {
  return writeState({ currentSession: sessionId, server });
}

/** Forgets the remembered session, used after CLOSE_SESSION. */
export async function forgetSession(): Promise<boolean> {
  const state = await readState();
  if (state.currentSession === undefined) return true;
  const { currentSession: _removed, ...rest } = state;
  return writeState(rest);
}
