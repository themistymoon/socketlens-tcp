/**
 * Validation of client-supplied scenarios and mock rules.
 *
 * These checks run after SLTP framing and JSON parsing have already succeeded, so a
 * failure here is semantic, not syntactic. Every failure maps to 422 INVALID SCENARIO.
 * Validators return a list of problems rather than throwing, so the client sees every
 * mistake at once instead of fixing them one at a time.
 */
import { MAX_RESPONSE_DELAY_MS, isValidHeaderName, isValidHeaderValue } from '@socketlens/protocol';
import type {
  AddRuleInput,
  BodyMatchMode,
  RuleMatch,
  RuleResponse,
  ScenarioExpectation,
  ScenarioRequest,
  TestScenario,
  TransmissionMode,
  UpdateRuleInput,
} from './models.js';

/** Outcome of validating a structure. */
export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly string[] };

const BODY_MATCH_MODES: readonly BodyMatchMode[] = ['exact', 'contains', 'json-subset', 'regex'];
const TRANSMISSION_MODES: readonly TransmissionMode[] = ['single', 'fragmented', 'coalesced'];

/** Largest timeout a scenario may request, so a stuck test cannot hang a demo. */
export const MAX_SCENARIO_TIMEOUT_MS = 120_000;

/** Largest number of fragments a scenario may request. */
export const MAX_FRAGMENT_COUNT = 256;

// ─── helpers ─────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkHeaderMap(
  value: unknown,
  label: string,
  problems: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push(`${label} must be an object mapping header names to string values.`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== 'string') {
      problems.push(`${label}.${name} must be a string.`);
      continue;
    }
    if (!isValidHeaderName(name)) {
      problems.push(`${label}.${name} is not a valid SLTP header name.`);
      continue;
    }
    if (!isValidHeaderValue(headerValue)) {
      problems.push(`${label}.${name} contains characters outside printable US-ASCII.`);
      continue;
    }
    out[name] = headerValue;
  }
  return out;
}

function checkDelay(value: unknown, label: string, problems: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${label} must be a number of milliseconds.`);
    return undefined;
  }
  if (value < 0) {
    problems.push(`${label} must not be negative.`);
    return undefined;
  }
  if (value > MAX_RESPONSE_DELAY_MS) {
    problems.push(`${label} must not exceed ${MAX_RESPONSE_DELAY_MS} ms.`);
    return undefined;
  }
  return value;
}

function checkPositiveIntArray(
  value: unknown,
  label: string,
  problems: string[],
): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    problems.push(`${label} must be an array of byte counts.`);
    return undefined;
  }
  if (value.length === 0) {
    problems.push(`${label} must not be empty.`);
    return undefined;
  }
  if (value.length > MAX_FRAGMENT_COUNT) {
    problems.push(`${label} must not contain more than ${MAX_FRAGMENT_COUNT} entries.`);
    return undefined;
  }
  const out: number[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry <= 0) {
      problems.push(`${label}[${index}] must be a positive integer number of bytes.`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

// ─── mock rules ──────────────────────────────────────────────────────────────

function validateMatch(value: unknown, problems: string[]): RuleMatch | undefined {
  if (!isRecord(value)) {
    problems.push('match must be an object.');
    return undefined;
  }
  const operation = value['operation'];
  if (typeof operation !== 'string' || operation.length === 0) {
    problems.push('match.operation must be an operation token, or "*" to match any operation.');
    return undefined;
  }
  if (operation !== '*' && !/^[A-Z][A-Z0-9_]{0,31}$/.test(operation)) {
    problems.push(`match.operation "${operation}" is not a valid operation token.`);
    return undefined;
  }

  const headers = checkHeaderMap(value['headers'], 'match.headers', problems);

  let body: RuleMatch['body'];
  if (value['body'] !== undefined) {
    if (!isRecord(value['body'])) {
      problems.push('match.body must be an object with "mode" and "value".');
    } else {
      const mode = value['body']['mode'];
      const bodyValue = value['body']['value'];
      if (typeof mode !== 'string' || !BODY_MATCH_MODES.includes(mode as BodyMatchMode)) {
        problems.push(`match.body.mode must be one of: ${BODY_MATCH_MODES.join(', ')}.`);
      } else if (typeof bodyValue !== 'string') {
        problems.push('match.body.value must be a string.');
      } else {
        if (mode === 'regex') {
          try {
            new RegExp(bodyValue);
          } catch (cause) {
            problems.push(
              `match.body.value is not a valid regular expression: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            );
          }
        }
        if (mode === 'json-subset') {
          try {
            JSON.parse(bodyValue);
          } catch {
            problems.push('match.body.value must be valid JSON when mode is "json-subset".');
          }
        }
        body = { mode: mode as BodyMatchMode, value: bodyValue };
      }
    }
  }

  return {
    operation,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body ? { body } : {}),
  };
}

function validateRuleResponse(value: unknown, problems: string[]): RuleResponse | undefined {
  if (!isRecord(value)) {
    problems.push('response must be an object.');
    return undefined;
  }

  const statusCode = value['statusCode'];
  if (typeof statusCode !== 'number' || !Number.isInteger(statusCode)) {
    problems.push('response.statusCode must be an integer.');
    return undefined;
  }
  if (statusCode < 100 || statusCode > 599) {
    problems.push('response.statusCode must be between 100 and 599.');
    return undefined;
  }

  const statusPhrase = value['statusPhrase'];
  if (typeof statusPhrase !== 'string' || statusPhrase.length === 0) {
    problems.push('response.statusPhrase must be a non-empty string.');
    return undefined;
  }
  if (!/^[\x20-\x7e]+$/.test(statusPhrase)) {
    problems.push('response.statusPhrase must contain only printable US-ASCII characters.');
    return undefined;
  }

  const headers = checkHeaderMap(value['headers'], 'response.headers', problems);

  let body: string | undefined;
  if (value['body'] !== undefined) {
    if (typeof value['body'] !== 'string') {
      problems.push('response.body must be a string. Encode structured data as JSON text.');
    } else {
      body = value['body'];
    }
  }

  const delayMs = checkDelay(value['delayMs'], 'response.delayMs', problems);

  let fragment: RuleResponse['fragment'];
  if (value['fragment'] !== undefined) {
    if (!isRecord(value['fragment'])) {
      problems.push('response.fragment must be an object with "sizes".');
    } else {
      const sizes = checkPositiveIntArray(
        value['fragment']['sizes'],
        'response.fragment.sizes',
        problems,
      );
      const fragmentDelay = checkDelay(
        value['fragment']['delayMs'],
        'response.fragment.delayMs',
        problems,
      );
      if (sizes && sizes.length > 0) {
        fragment = { sizes, ...(fragmentDelay !== undefined ? { delayMs: fragmentDelay } : {}) };
      }
    }
  }

  let disconnectAfterBytes: number | undefined;
  if (value['disconnectAfterBytes'] !== undefined) {
    const raw = value['disconnectAfterBytes'];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      problems.push('response.disconnectAfterBytes must be a non-negative integer.');
    } else {
      disconnectAfterBytes = raw;
    }
  }

  return {
    statusCode,
    statusPhrase,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
    ...(fragment ? { fragment } : {}),
    ...(disconnectAfterBytes !== undefined ? { disconnectAfterBytes } : {}),
  };
}

/** Validates the body of an ADD_RULE request. */
export function validateAddRuleInput(input: unknown): Validated<AddRuleInput> {
  const problems: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, problems: ['Request body must be a JSON object.'] };
  }

  const name = input['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    problems.push('name must be a non-empty string.');
  }

  let id: string | undefined;
  if (input['id'] !== undefined) {
    if (typeof input['id'] !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(input['id'])) {
      problems.push('id must match [A-Za-z0-9._:-]{1,64} when supplied.');
    } else {
      id = input['id'];
    }
  }

  let enabled = true;
  if (input['enabled'] !== undefined) {
    if (typeof input['enabled'] !== 'boolean') {
      problems.push('enabled must be a boolean.');
    } else {
      enabled = input['enabled'];
    }
  }

  let priority = 0;
  if (input['priority'] !== undefined) {
    if (typeof input['priority'] !== 'number' || !Number.isInteger(input['priority'])) {
      problems.push('priority must be an integer.');
    } else {
      priority = input['priority'];
    }
  }

  const match = validateMatch(input['match'], problems);
  const response = validateRuleResponse(input['response'], problems);

  if (problems.length > 0 || !match || !response || typeof name !== 'string') {
    return { ok: false, problems };
  }

  return {
    ok: true,
    value: { ...(id ? { id } : {}), name: name.trim(), enabled, priority, match, response },
  };
}

/** Validates the body of an UPDATE_RULE request. */
export function validateUpdateRuleInput(input: unknown): Validated<UpdateRuleInput> {
  const problems: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, problems: ['Request body must be a JSON object.'] };
  }

  const id = input['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, problems: ['id must identify the rule to update.'] };
  }

  const patch: {
    id: string;
    name?: string;
    enabled?: boolean;
    priority?: number;
    match?: RuleMatch;
    response?: RuleResponse;
  } = { id };

  if (input['name'] !== undefined) {
    if (typeof input['name'] !== 'string' || input['name'].trim().length === 0) {
      problems.push('name must be a non-empty string when supplied.');
    } else {
      patch.name = input['name'].trim();
    }
  }
  if (input['enabled'] !== undefined) {
    if (typeof input['enabled'] !== 'boolean') {
      problems.push('enabled must be a boolean when supplied.');
    } else {
      patch.enabled = input['enabled'];
    }
  }
  if (input['priority'] !== undefined) {
    if (typeof input['priority'] !== 'number' || !Number.isInteger(input['priority'])) {
      problems.push('priority must be an integer when supplied.');
    } else {
      patch.priority = input['priority'];
    }
  }
  if (input['match'] !== undefined) {
    const match = validateMatch(input['match'], problems);
    if (match) patch.match = match;
  }
  if (input['response'] !== undefined) {
    const response = validateRuleResponse(input['response'], problems);
    if (response) patch.response = response;
  }

  if (problems.length > 0) return { ok: false, problems };

  const changedFields = Object.keys(patch).filter((key) => key !== 'id');
  if (changedFields.length === 0) {
    return { ok: false, problems: ['UPDATE_RULE must change at least one field.'] };
  }

  return { ok: true, value: patch };
}

// ─── scenarios ───────────────────────────────────────────────────────────────

function validateScenarioRequest(
  value: unknown,
  label: string,
  problems: string[],
): ScenarioRequest | undefined {
  if (!isRecord(value)) {
    problems.push(`${label} must be an object.`);
    return undefined;
  }

  const raw = value['raw'];
  if (raw !== undefined) {
    if (typeof raw !== 'string' || raw.length === 0) {
      problems.push(`${label}.raw must be a non-empty string when supplied.`);
      return undefined;
    }
    // A raw request bypasses the encoder entirely; nothing else is required.
    return { raw };
  }

  const operation = value['operation'];
  if (typeof operation !== 'string' || operation.length === 0) {
    problems.push(`${label} must supply either "operation" or "raw".`);
    return undefined;
  }
  if (!/^[A-Z][A-Z0-9_]{0,31}$/.test(operation)) {
    problems.push(`${label}.operation "${operation}" is not a valid operation token.`);
    return undefined;
  }

  const headers = checkHeaderMap(value['headers'], `${label}.headers`, problems);

  let body: string | undefined;
  if (value['body'] !== undefined) {
    if (typeof value['body'] !== 'string') {
      problems.push(`${label}.body must be a string.`);
    } else {
      body = value['body'];
    }
  }

  return {
    operation,
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

function validateExpectation(value: unknown, problems: string[]): ScenarioExpectation | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    problems.push('expect must be an object.');
    return undefined;
  }

  const expectation: {
    statusCode?: number;
    statusPhrase?: string;
    headers?: Record<string, string>;
    body?: string;
    bodyContains?: string;
    jsonSubset?: Record<string, unknown>;
    timeout?: boolean;
    disconnect?: boolean;
  } = {};

  if (value['statusCode'] !== undefined) {
    const code = value['statusCode'];
    if (typeof code !== 'number' || !Number.isInteger(code) || code < 100 || code > 599) {
      problems.push('expect.statusCode must be an integer between 100 and 599.');
    } else {
      expectation.statusCode = code;
    }
  }
  if (value['statusPhrase'] !== undefined) {
    if (typeof value['statusPhrase'] !== 'string') {
      problems.push('expect.statusPhrase must be a string.');
    } else {
      expectation.statusPhrase = value['statusPhrase'];
    }
  }
  const headers = checkHeaderMap(value['headers'], 'expect.headers', problems);
  if (headers && Object.keys(headers).length > 0) expectation.headers = headers;

  if (value['body'] !== undefined) {
    if (typeof value['body'] !== 'string') problems.push('expect.body must be a string.');
    else expectation.body = value['body'];
  }
  if (value['bodyContains'] !== undefined) {
    if (typeof value['bodyContains'] !== 'string') {
      problems.push('expect.bodyContains must be a string.');
    } else {
      expectation.bodyContains = value['bodyContains'];
    }
  }
  if (value['jsonSubset'] !== undefined) {
    if (!isRecord(value['jsonSubset'])) problems.push('expect.jsonSubset must be an object.');
    else expectation.jsonSubset = value['jsonSubset'];
  }
  if (value['timeout'] !== undefined) {
    if (typeof value['timeout'] !== 'boolean') problems.push('expect.timeout must be a boolean.');
    else expectation.timeout = value['timeout'];
  }
  if (value['disconnect'] !== undefined) {
    if (typeof value['disconnect'] !== 'boolean') {
      problems.push('expect.disconnect must be a boolean.');
    } else {
      expectation.disconnect = value['disconnect'];
    }
  }

  // Contradictory expectations are rejected rather than silently resolved.
  if (expectation.timeout === true && expectation.statusCode !== undefined) {
    problems.push(
      'expect.timeout and expect.statusCode are contradictory: a timeout means no response arrived.',
    );
  }
  if (expectation.timeout === true && expectation.disconnect === true) {
    problems.push('expect.timeout and expect.disconnect are contradictory outcomes.');
  }
  if (expectation.disconnect === true && expectation.statusCode !== undefined) {
    problems.push(
      'expect.disconnect and expect.statusCode are contradictory: a disconnect means no complete response arrived.',
    );
  }
  if (expectation.body !== undefined && expectation.bodyContains !== undefined) {
    problems.push('Use either expect.body or expect.bodyContains, not both.');
  }

  return expectation;
}

/** Validates a test scenario, normalising optional fields. */
export function validateScenario(input: unknown): Validated<TestScenario> {
  const problems: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, problems: ['Scenario must be a JSON object.'] };
  }

  const name = input['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    problems.push('name must be a non-empty string.');
  }

  let description: string | undefined;
  if (input['description'] !== undefined) {
    if (typeof input['description'] !== 'string') problems.push('description must be a string.');
    else description = input['description'];
  }

  let target: TestScenario['target'];
  if (input['target'] !== undefined) {
    if (!isRecord(input['target'])) {
      problems.push('target must be an object with "host" and "port".');
    } else {
      const host = input['target']['host'];
      const port = input['target']['port'];
      if (typeof host !== 'string' || host.length === 0) {
        problems.push('target.host must be a non-empty string.');
      } else if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        problems.push('target.port must be an integer between 1 and 65535.');
      } else {
        target = { host, port };
      }
    }
  }

  const request = validateScenarioRequest(input['request'], 'request', problems);

  let timeoutMs: number | undefined;
  if (input['timeoutMs'] !== undefined) {
    const raw = input['timeoutMs'];
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
      problems.push('timeoutMs must be a positive integer.');
    } else if (raw > MAX_SCENARIO_TIMEOUT_MS) {
      problems.push(`timeoutMs must not exceed ${MAX_SCENARIO_TIMEOUT_MS} ms.`);
    } else {
      timeoutMs = raw;
    }
  }

  let transmission: TestScenario['transmission'];
  if (input['transmission'] !== undefined) {
    if (!isRecord(input['transmission'])) {
      problems.push('transmission must be an object.');
    } else {
      const t = input['transmission'];
      const mode = t['mode'];
      if (typeof mode !== 'string' || !TRANSMISSION_MODES.includes(mode as TransmissionMode)) {
        problems.push(`transmission.mode must be one of: ${TRANSMISSION_MODES.join(', ')}.`);
      } else {
        const fragmentSizes = checkPositiveIntArray(
          t['fragmentSizes'],
          'transmission.fragmentSizes',
          problems,
        );

        let fragmentCount: number | undefined;
        if (t['fragmentCount'] !== undefined) {
          const raw = t['fragmentCount'];
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 2) {
            problems.push('transmission.fragmentCount must be an integer of at least 2.');
          } else if (raw > MAX_FRAGMENT_COUNT) {
            problems.push(`transmission.fragmentCount must not exceed ${MAX_FRAGMENT_COUNT}.`);
          } else {
            fragmentCount = raw;
          }
        }

        const interFragmentDelayMs = checkDelay(
          t['interFragmentDelayMs'],
          'transmission.interFragmentDelayMs',
          problems,
        );

        let coalesceWith: ScenarioRequest | undefined;
        if (t['coalesceWith'] !== undefined) {
          coalesceWith = validateScenarioRequest(
            t['coalesceWith'],
            'transmission.coalesceWith',
            problems,
          );
        }

        let disconnectAfterBytes: number | undefined;
        if (t['disconnectAfterBytes'] !== undefined) {
          const raw = t['disconnectAfterBytes'];
          if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
            problems.push('transmission.disconnectAfterBytes must be a non-negative integer.');
          } else {
            disconnectAfterBytes = raw;
          }
        }

        if (mode === 'fragmented' && !fragmentSizes && fragmentCount === undefined) {
          problems.push(
            'transmission.mode "fragmented" requires either fragmentSizes or fragmentCount.',
          );
        }
        if (mode === 'coalesced' && !coalesceWith) {
          problems.push('transmission.mode "coalesced" requires transmission.coalesceWith.');
        }

        transmission = {
          mode: mode as TransmissionMode,
          ...(fragmentSizes ? { fragmentSizes } : {}),
          ...(fragmentCount !== undefined ? { fragmentCount } : {}),
          ...(interFragmentDelayMs !== undefined ? { interFragmentDelayMs } : {}),
          ...(coalesceWith ? { coalesceWith } : {}),
          ...(disconnectAfterBytes !== undefined ? { disconnectAfterBytes } : {}),
        };
      }
    }
  }

  const expectation = validateExpectation(input['expect'], problems);

  if (problems.length > 0 || !request || typeof name !== 'string') {
    return { ok: false, problems };
  }

  return {
    ok: true,
    value: {
      name: name.trim(),
      ...(description !== undefined ? { description } : {}),
      ...(target ? { target } : {}),
      request,
      ...(transmission ? { transmission } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(expectation ? { expect: expectation } : {}),
    },
  };
}
