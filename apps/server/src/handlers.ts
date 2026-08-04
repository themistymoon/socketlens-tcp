/**
 * Operation handlers for the SLTP control server.
 *
 * Each handler receives an already-validated request — framing, Request-ID, operation
 * registration, body presence, Session-ID presence, and JSON parsing are all settled
 * before dispatch — and returns the response the connection should write.
 *
 * Handlers never touch the socket. Keeping them pure functions of (request, state)
 * is what lets the integration tests drive them without opening a TCP connection.
 */
import {
  CONTENT_TYPE_JSON,
  SERVER_PRODUCT,
  SLTP_HEADER,
  SLTP_OPERATION,
  SLTP_OPERATION_REGISTRY,
  SLTP_STATUS,
  SLTP_STATUS_REGISTRY,
  SLTP_VERSION,
  SLTP_VERSION_TOKEN,
  DEFAULT_LIMITS,
  statusPhrase,
  type SltpRequest,
  type ValidatedRequest,
} from '@socketlens/protocol';
import {
  runScenario,
  type SessionStore,
  summariseResult,
  validateAddRuleInput,
  validateScenario,
  validateUpdateRuleInput,
  type ProtocolLogger,
  type StoreFailure,
  type StoreResult,
} from '@socketlens/core';

/** What a handler produces. The connection turns this into wire bytes. */
export interface HandlerResponse {
  readonly statusCode: number;
  /** Omitted to use the registry's canonical phrase for the code. */
  readonly statusPhrase?: string;
  readonly headers?: Readonly<Record<string, string | number | undefined>>;
  /** Serialised as a JSON body with the SLTP JSON content type. */
  readonly json?: unknown;
  /** When true, the connection closes cleanly after this response is written. */
  readonly close?: boolean;
}

/** Server state a handler may read or change. */
export interface HandlerContext {
  readonly store: SessionStore;
  readonly logger: ProtocolLogger;
  readonly startedAt: number;
  readonly controlHost: string;
  readonly controlPort: number;
  /** Hosts a scenario may target besides loopback. */
  readonly allowedTargetHosts: readonly string[];
  /** Number of TCP connections currently open to the control server. */
  readonly openConnections: () => number;
}

/** Turns a store failure into the response the client receives. */
function fromFailure(failure: StoreFailure): HandlerResponse {
  return {
    statusCode: failure.statusCode,
    statusPhrase: failure.statusPhrase,
    json: { error: failure.message, status: failure.statusCode },
  };
}

/** Unwraps a store result, or converts its failure into a response. */
function unwrap<T>(
  result: StoreResult<T>,
): { ok: true; value: T } | { ok: false; response: HandlerResponse } {
  if (result.ok) return { ok: true, value: result.value };
  return { ok: false, response: fromFailure(result.failure) };
}

/** A 422 response listing every semantic problem found in the body. */
function invalidScenario(problems: readonly string[]): HandlerResponse {
  return {
    statusCode: SLTP_STATUS.INVALID_SCENARIO,
    json: {
      error: 'The request body is well-formed JSON but is not a valid scenario or rule.',
      problems,
    },
  };
}

/** Reads a required string field from a JSON body. */
function requireString(
  json: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; response: HandlerResponse } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return {
      ok: false,
      response: {
        statusCode: SLTP_STATUS.BAD_REQUEST,
        json: { error: 'The request body must be a JSON object.' },
      },
    };
  }
  const value = (json as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    return {
      ok: false,
      response: {
        statusCode: SLTP_STATUS.BAD_REQUEST,
        json: { error: `The request body must carry a non-empty "${field}" string.` },
      },
    };
  }
  return { ok: true, value };
}

/**
 * Dispatches one validated request.
 *
 * Every branch returns a response; nothing here throws for a client mistake, because
 * reporting a client mistake as a numbered status is the whole point of the protocol.
 */
export async function handleOperation(
  request: SltpRequest,
  validated: ValidatedRequest,
  context: HandlerContext,
): Promise<HandlerResponse> {
  const { store } = context;
  const sessionId = validated.sessionId;

  switch (validated.operation) {
    case SLTP_OPERATION.PING: {
      const echo =
        typeof validated.json === 'object' &&
        validated.json !== null &&
        !Array.isArray(validated.json)
          ? (validated.json as Record<string, unknown>)['echo']
          : undefined;
      return {
        statusCode: SLTP_STATUS.OK,
        json: {
          message: 'pong',
          protocol: SLTP_VERSION_TOKEN,
          serverTime: new Date().toISOString(),
          uptimeMs: Date.now() - context.startedAt,
          ...(echo !== undefined ? { echo } : {}),
        },
      };
    }

    case SLTP_OPERATION.SERVER_INFO: {
      const stats = store.stats();
      return {
        statusCode: SLTP_STATUS.OK,
        json: {
          product: SERVER_PRODUCT,
          protocol: { name: 'SLTP', version: SLTP_VERSION, token: SLTP_VERSION_TOKEN },
          control: { host: context.controlHost, port: context.controlPort },
          uptimeMs: Date.now() - context.startedAt,
          limits: DEFAULT_LIMITS,
          operations: SLTP_OPERATION_REGISTRY.map((entry) => ({
            name: entry.name,
            requiresSession: entry.requiresSession,
            requiresBody: entry.requiresBody,
            target: entry.target,
            successStatuses: entry.successStatuses,
            summary: entry.summary,
          })),
          statuses: SLTP_STATUS_REGISTRY.map((entry) => ({
            code: entry.code,
            phrase: entry.phrase,
            category: entry.category,
          })),
          counts: { ...stats, controlConnections: context.openConnections() },
          capabilities: [
            'fragmented-transmission',
            'coalesced-transmission',
            'response-delay',
            'inter-fragment-delay',
            'mid-message-disconnect',
            'raw-message-injection',
            'per-session-mock-endpoint',
          ],
        },
      };
    }

    case SLTP_OPERATION.CREATE_SESSION: {
      const input =
        typeof validated.json === 'object' &&
        validated.json !== null &&
        !Array.isArray(validated.json)
          ? (validated.json as Record<string, unknown>)
          : {};
      const created = unwrap(
        await store.createSession({
          ...(typeof input['name'] === 'string' ? { name: input['name'] } : {}),
          ...(typeof input['description'] === 'string'
            ? { description: input['description'] }
            : {}),
        }),
      );
      if (!created.ok) return created.response;

      return {
        statusCode: SLTP_STATUS.SESSION_CREATED,
        headers: { [SLTP_HEADER.sessionId]: created.value.id },
        json: { session: created.value },
      };
    }

    case SLTP_OPERATION.GET_SESSION: {
      const found = unwrap(store.getSession(sessionId!));
      if (!found.ok) return found.response;
      return { statusCode: SLTP_STATUS.OK, json: { session: found.value } };
    }

    case SLTP_OPERATION.LIST_SESSIONS: {
      const sessions = store.listSessions();
      return { statusCode: SLTP_STATUS.OK, json: { count: sessions.length, sessions } };
    }

    case SLTP_OPERATION.ADD_RULE: {
      const input = validateAddRuleInput(validated.json);
      if (!input.ok) return invalidScenario(input.problems);

      const added = unwrap(store.addRule(sessionId!, input.value));
      if (!added.ok) return added.response;

      return {
        statusCode: SLTP_STATUS.RULE_ADDED,
        headers: { [SLTP_HEADER.matchedRuleId]: added.value.id },
        json: { rule: added.value },
      };
    }

    case SLTP_OPERATION.UPDATE_RULE: {
      const input = validateUpdateRuleInput(validated.json);
      if (!input.ok) return invalidScenario(input.problems);

      const updated = unwrap(store.updateRule(sessionId!, input.value));
      if (!updated.ok) return updated.response;

      return {
        statusCode: SLTP_STATUS.RULE_UPDATED,
        headers: { [SLTP_HEADER.matchedRuleId]: updated.value.id },
        json: { rule: updated.value },
      };
    }

    case SLTP_OPERATION.DELETE_RULE: {
      const ruleId = requireString(validated.json, 'id');
      if (!ruleId.ok) return ruleId.response;

      const deleted = unwrap(store.deleteRule(sessionId!, ruleId.value));
      if (!deleted.ok) return deleted.response;

      return {
        statusCode: SLTP_STATUS.RULE_DELETED,
        json: { deleted: deleted.value.id, name: deleted.value.name },
      };
    }

    case SLTP_OPERATION.LIST_RULES: {
      const rules = unwrap(store.listRules(sessionId!));
      if (!rules.ok) return rules.response;
      return {
        statusCode: SLTP_STATUS.OK,
        json: {
          count: rules.value.length,
          // The array order is the exact order the matcher evaluates.
          evaluationOrder: 'priority descending, then insertion sequence ascending',
          rules: rules.value,
        },
      };
    }

    case SLTP_OPERATION.RUN_TEST: {
      const scenarioInput =
        typeof validated.json === 'object' &&
        validated.json !== null &&
        !Array.isArray(validated.json) &&
        'scenario' in (validated.json as Record<string, unknown>)
          ? (validated.json as Record<string, unknown>)['scenario']
          : validated.json;

      const scenario = validateScenario(scenarioInput);
      if (!scenario.ok) return invalidScenario(scenario.problems);

      const endpoint = unwrap(store.endpointOf(sessionId!));
      if (!endpoint.ok) return endpoint.response;

      const result = await runScenario(scenario.value, {
        sessionId: sessionId!,
        host: endpoint.value.host,
        port: endpoint.value.port,
        logger: context.logger,
        allowedHosts: context.allowedTargetHosts,
      });

      const stored = unwrap(store.addResult(sessionId!, result));
      if (!stored.ok) return stored.response;

      // 210/211 both report a completed exchange; only an unexpected timeout is 408.
      const statusCode = result.passed
        ? SLTP_STATUS.TEST_PASSED
        : result.outcome === 'timeout'
          ? SLTP_STATUS.TEST_TIMEOUT
          : SLTP_STATUS.TEST_FAILED;

      return {
        statusCode,
        headers: {
          [SLTP_HEADER.resultId]: result.id,
          ...(result.matchedRuleId ? { [SLTP_HEADER.matchedRuleId]: result.matchedRuleId } : {}),
        },
        json: { result },
      };
    }

    case SLTP_OPERATION.GET_RESULT: {
      const resultId = requireString(validated.json, 'id');
      if (!resultId.ok) return resultId.response;

      const found = unwrap(store.getResult(sessionId!, resultId.value));
      if (!found.ok) return found.response;

      return {
        statusCode: SLTP_STATUS.OK,
        headers: { [SLTP_HEADER.resultId]: found.value.id },
        json: { result: found.value },
      };
    }

    case SLTP_OPERATION.LIST_RESULTS: {
      const results = unwrap(store.listResults(sessionId!));
      if (!results.ok) return results.response;

      const summaries = results.value.map(summariseResult);
      return {
        statusCode: SLTP_STATUS.OK,
        json: {
          count: summaries.length,
          passed: summaries.filter((entry) => entry.passed).length,
          failed: summaries.filter((entry) => !entry.passed).length,
          results: summaries,
        },
      };
    }

    case SLTP_OPERATION.CLOSE_SESSION: {
      const closed = unwrap(await store.closeSession(sessionId!));
      if (!closed.ok) return closed.response;
      return { statusCode: SLTP_STATUS.SESSION_CLOSED, json: { session: closed.value } };
    }

    default:
      // Unreachable: validateRequest already rejected unregistered operations.
      return {
        statusCode: SLTP_STATUS.OPERATION_NOT_SUPPORTED,
        json: {
          error: `Operation ${request.operation} is registered but this server has no handler for it.`,
        },
      };
  }
}

/** Content type used for every response body this server produces. */
export const RESPONSE_CONTENT_TYPE = CONTENT_TYPE_JSON;

/** Resolves the phrase to send with a handler response. */
export function phraseFor(response: HandlerResponse): string {
  return response.statusPhrase ?? statusPhrase(response.statusCode);
}
