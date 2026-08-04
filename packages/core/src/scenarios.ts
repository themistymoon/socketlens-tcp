/**
 * Scenario and result export.
 *
 * Scenarios are plain JSON so that they can be committed to a repository, shared,
 * reviewed in a pull request, and replayed from the CLI or the graphical interface.
 * A scenario file is either one scenario object or a bundle with a `scenarios` array.
 *
 * Writing files is the caller's responsibility; this module only converts between
 * JSON text and validated domain objects, which keeps it usable in the browser.
 */
import { SLTP_VERSION_TOKEN } from '@socketlens/protocol';
import type { AddRuleInput, TestResult, TestScenario } from './models.js';
import { validateAddRuleInput, validateScenario, type Validated } from './validation.js';

/** The on-disk shape of a scenario bundle. */
export interface ScenarioBundle {
  /** Format marker, so a future version can be detected rather than guessed at. */
  readonly format: 'socketlens-scenario-bundle/1';
  readonly protocol: string;
  readonly name: string;
  readonly description?: string;
  /** Rules to install into the session before the scenarios run. */
  readonly rules?: readonly AddRuleInput[];
  readonly scenarios: readonly TestScenario[];
}

const BUNDLE_FORMAT = 'socketlens-scenario-bundle/1' as const;

/** Builds a bundle from validated parts. */
export function createBundle(input: {
  readonly name: string;
  readonly description?: string;
  readonly rules?: readonly AddRuleInput[];
  readonly scenarios: readonly TestScenario[];
}): ScenarioBundle {
  return {
    format: BUNDLE_FORMAT,
    protocol: SLTP_VERSION_TOKEN,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.rules && input.rules.length > 0 ? { rules: input.rules } : {}),
    scenarios: input.scenarios,
  };
}

/** Serialises a bundle to the exact JSON text written to disk. */
export function serialiseBundle(bundle: ScenarioBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/**
 * Parses scenario JSON, accepting either a bundle or a single bare scenario.
 *
 * Every scenario and rule inside is validated, and every problem across the whole
 * file is reported at once so that fixing a scenario file is a single pass.
 */
export function parseBundle(text: string, sourceName = 'scenario file'): Validated<ScenarioBundle> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      problems: [
        `${sourceName} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      ],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: [`${sourceName} must contain a JSON object at the top level.`] };
  }

  const record = parsed as Record<string, unknown>;

  // A bare scenario is a convenience for hand-written one-off files.
  if (record['scenarios'] === undefined) {
    const single = validateScenario(record);
    if (!single.ok) {
      return {
        ok: false,
        problems: single.problems.map((problem) => `${sourceName}: ${problem}`),
      };
    }
    return {
      ok: true,
      value: createBundle({ name: single.value.name, scenarios: [single.value] }),
    };
  }

  const problems: string[] = [];

  if (record['format'] !== undefined && record['format'] !== BUNDLE_FORMAT) {
    problems.push(
      `${sourceName} declares format "${String(record['format'])}", but this build understands "${BUNDLE_FORMAT}".`,
    );
  }

  const name = typeof record['name'] === 'string' ? record['name'] : sourceName;
  const description = typeof record['description'] === 'string' ? record['description'] : undefined;

  const rules: AddRuleInput[] = [];
  if (record['rules'] !== undefined) {
    if (!Array.isArray(record['rules'])) {
      problems.push(`${sourceName}: rules must be an array.`);
    } else {
      for (const [index, entry] of record['rules'].entries()) {
        const validated = validateAddRuleInput(entry);
        if (validated.ok) rules.push(validated.value);
        else
          problems.push(...validated.problems.map((p) => `${sourceName}: rules[${index}]: ${p}`));
      }
    }
  }

  const scenarios: TestScenario[] = [];
  if (!Array.isArray(record['scenarios'])) {
    problems.push(`${sourceName}: scenarios must be an array.`);
  } else if (record['scenarios'].length === 0) {
    problems.push(`${sourceName}: scenarios must contain at least one scenario.`);
  } else {
    for (const [index, entry] of record['scenarios'].entries()) {
      const validated = validateScenario(entry);
      if (validated.ok) scenarios.push(validated.value);
      else {
        problems.push(...validated.problems.map((p) => `${sourceName}: scenarios[${index}]: ${p}`));
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    value: createBundle({
      name,
      ...(description !== undefined ? { description } : {}),
      rules,
      scenarios,
    }),
  };
}

/** The on-disk shape of an exported result set. */
export interface ResultExport {
  readonly format: 'socketlens-results/1';
  readonly protocol: string;
  readonly exportedAt: string;
  readonly sessionId: string;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly results: readonly TestResult[];
}

/**
 * Builds an exportable result set.
 *
 * `exportedAt` is passed in rather than read from the clock so that the caller
 * controls it and a test can assert on a stable value.
 */
export function createResultExport(
  sessionId: string,
  results: readonly TestResult[],
  exportedAt: string,
): ResultExport {
  return {
    format: 'socketlens-results/1',
    protocol: SLTP_VERSION_TOKEN,
    exportedAt,
    sessionId,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
    },
    results,
  };
}

/** Serialises an exported result set to JSON text. */
export function serialiseResults(exported: ResultExport): string {
  return `${JSON.stringify(exported, null, 2)}\n`;
}
