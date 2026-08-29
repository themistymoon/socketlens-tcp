/**
 * Guards the documented registries against drift from the source registries (NFR-28).
 *
 * `packages/protocol/src/operations.ts`, `status.ts`, and `errors.ts` are normative.
 * Several documents restate them as tables, and nothing but this file stops the two
 * from diverging. Each check compares a documented table against the registry it
 * claims to describe, in order, so a missing entry, an extra entry, a reordered
 * entry, or a wrong canonical phrase fails the suite.
 *
 * Deliberately **not** checked: the free-text "Purpose", "Meaning", "Sent when",
 * "Why the stream is unrecoverable", and "Detected by" columns. Those are prose
 * written for a reader, they carry document cross-references and markup the
 * registries have no field for, and asserting they match a `summary` string
 * character for character would only invite someone to weaken the assertion. What
 * is checked is everything the wire depends on: which entries exist, their order,
 * their canonical phrases, and every machine-derivable attribute.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isFatalReason,
  statusForReason,
  SLTP_OPERATION_REGISTRY,
  SLTP_REASON,
  SLTP_STATUS_REGISTRY,
  type SltpOperationDefinition,
  type SltpReason,
} from '@socketlens/protocol';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads a document relative to the repository root and splits it into lines. */
function readDoc(relative: string): string[] {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8').split(/\r?\n/);
}

/** The cells of one markdown table row, trimmed, without the outer pipes. */
function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Body rows of the first markdown table whose header row contains every one of
 * `columns`. Throws when no such table exists, so a renamed column fails loudly
 * rather than silently checking nothing.
 */
function table(lines: readonly string[], columns: readonly string[]): string[][] {
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i];
    if (header === undefined || !header.startsWith('|')) continue;
    const names = cells(header);
    if (!columns.every((column) => names.includes(column))) continue;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j += 1) {
      const row = lines[j];
      if (row === undefined || !row.startsWith('|')) break;
      rows.push(cells(row));
    }
    if (rows.length === 0) throw new Error(`table [${columns.join(', ')}] has no rows`);
    return rows;
  }
  throw new Error(`no table with columns [${columns.join(', ')}]`);
}

/** Strips the markdown code ticks a document wraps wire tokens in. */
function unticked(cell: string): string {
  return cell.replace(/`/g, '').trim();
}

/** The cell at `index`, or a marker that fails the comparison rather than throwing. */
function cell(row: readonly string[], index: number): string {
  return row[index] ?? '<missing cell>';
}

/** The body of the `status-codes.md` §4 subsection describing one status code. */
function section(lines: readonly string[], code: number): string {
  const start = lines.findIndex((line) => new RegExp(`^### 4\\.\\d+ · ${code} `).test(line.trim()));
  if (start === -1) throw new Error(`no §4 section for ${code}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('### '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const SPEC = readDoc('docs/protocol-specification.md');
const STATUS_DOC = readDoc('docs/status-codes.md');

const OPERATION_TABLE = table(SPEC, ['Operation', 'Session-ID', 'Body', 'Target']);
const SPEC_STATUS_TABLE = table(SPEC, ['Code', 'Phrase', 'Class']);
const SUMMARY_TABLE = table(STATUS_DOC, ['Code', 'Phrase', 'Category']);
const FATAL_TABLE = table(STATUS_DOC, ['Reason', 'Status', 'Why the stream is unrecoverable']);
const RECOVERABLE_TABLE = table(STATUS_DOC, ['Reason', 'Status', 'Detected by']);

/** How the specification renders `requiresSession`. */
function documentedSession(entry: SltpOperationDefinition): string {
  return entry.requiresSession ? '**required**' : 'not required';
}

/** How the specification renders the body rule, which spans two registry fields. */
function documentedBody(entry: SltpOperationDefinition): string {
  if (entry.requiresBody) return 'required';
  return entry.allowsBody ? 'optional' : 'forbidden';
}

/** How the specification renders `target`. */
function documentedTarget(entry: SltpOperationDefinition): string {
  if (entry.target === 'both') return 'control, mock endpoint';
  return entry.target === 'mock-endpoint' ? 'mock endpoint' : 'control';
}

/**
 * Status codes named in a "Success statuses" cell. Parentheses mark a code that is
 * registered but unreachable in v0.1, and are not part of the comparison.
 */
function parseStatusList(value: string): number[] {
  return value
    .replace(/[()]/g, '')
    .split(',')
    .map((part) => Number(part.trim()));
}

describe('docs/protocol-specification.md §11 versus the operation registry', () => {
  it('lists every registered operation exactly once, in registry order', () => {
    expect(OPERATION_TABLE.map((row) => unticked(cell(row, 0)))).toEqual(
      SLTP_OPERATION_REGISTRY.map((entry) => entry.name),
    );
  });

  it('documents the session, body, and target rules the registry declares', () => {
    const documented = OPERATION_TABLE.map((row) => ({
      name: unticked(cell(row, 0)),
      session: cell(row, 1),
      body: cell(row, 2),
      target: cell(row, 3),
    }));
    expect(documented).toEqual(
      SLTP_OPERATION_REGISTRY.map((entry) => ({
        name: entry.name,
        session: documentedSession(entry),
        body: documentedBody(entry),
        target: documentedTarget(entry),
      })),
    );
  });

  it('documents each operation’s success statuses', () => {
    const documented = OPERATION_TABLE.map((row) => ({
      name: unticked(cell(row, 0)),
      statuses: parseStatusList(cell(row, 4)),
    }));
    expect(documented).toEqual(
      SLTP_OPERATION_REGISTRY.map((entry) => ({
        name: entry.name,
        statuses: [...entry.successStatuses],
      })),
    );
  });

  it('states the registry size the registry actually has', () => {
    const claims = SPEC.join('\n').match(/(\d+) operations/g) ?? [];
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(Number(claim.split(' ')[0])).toBe(SLTP_OPERATION_REGISTRY.length);
    }
  });
});

describe('the documented status tables versus the status registry', () => {
  const expected = SLTP_STATUS_REGISTRY.map((entry) => ({
    code: entry.code,
    phrase: entry.phrase,
    category: entry.category.replace('-', ' '),
  }));

  it('matches the specification §12 index, in registry order', () => {
    const documented = SPEC_STATUS_TABLE.map((row) => ({
      code: Number(cell(row, 0)),
      phrase: unticked(cell(row, 1)),
      category: cell(row, 2),
    }));
    expect(documented).toEqual(expected);
  });

  it('matches the status-codes.md §2 summary, in registry order', () => {
    const documented = SUMMARY_TABLE.map((row) => ({
      code: Number(cell(row, 0)),
      phrase: unticked(cell(row, 1)),
      category: cell(row, 2),
    }));
    expect(documented).toEqual(expected);
  });

  it('gives every code its own status-codes.md §4 section, numbered in order', () => {
    const headings = STATUS_DOC.map((line) => /^### 4\.(\d+) · (\d{3}) (.+)$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        index: Number(match[1]),
        code: Number(match[2]),
        phrase: (match[3] ?? '').trim(),
      }));
    expect(headings).toEqual(
      SLTP_STATUS_REGISTRY.map((entry, i) => ({
        index: i + 1,
        code: entry.code,
        phrase: entry.phrase,
      })),
    );
  });

  it('states the registry size the registry actually has', () => {
    const claims =
      SPEC.concat(STATUS_DOC)
        .join('\n')
        .match(/(\d+) status codes/g) ?? [];
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      expect(Number(claim.split(' ')[0])).toBe(SLTP_STATUS_REGISTRY.length);
    }
  });

  it('accounts for every code in the connection-outcome quick reference', () => {
    const rows = table(STATUS_DOC, ['Code', 'Connection after the response']);
    const listed = rows.flatMap((row) => parseStatusList(cell(row, 0)));
    expect([...listed].sort((a, b) => a - b)).toEqual(
      SLTP_STATUS_REGISTRY.map((entry) => entry.code).sort((a, b) => a - b),
    );
    const alwaysClosed = rows
      .filter((row) => cell(row, 1).includes('always closed'))
      .flatMap((row) => parseStatusList(cell(row, 0)));
    expect(alwaysClosed).toEqual(
      SLTP_STATUS_REGISTRY.filter((entry) => entry.closesConnection).map((entry) => entry.code),
    );
  });

  it('describes a registered but unreachable code as a reservation, not a capability', () => {
    // §11 parenthesises a success status that is registered while no v0.1 code path
    // emits it. `parseStatusList` strips those parentheses, so this is the one check
    // that reads them, and it is what stops a reservation from drifting back into
    // reading like a working feature — the `202` case.
    const reserved = OPERATION_TABLE.flatMap((row) =>
      [...cell(row, 4).matchAll(/\((\d{3})\)/g)].map((match) => Number(match[1])),
    );
    expect(reserved.length).toBeGreaterThan(0);

    for (const code of reserved) {
      const entry = SLTP_STATUS_REGISTRY.find((candidate) => candidate.code === code);
      expect(entry, `${code} is parenthesised in §11 but is not registered`).toBeDefined();
      const metadata = `${entry?.meaning} ${entry?.context}`;
      expect(metadata, `${code} registry metadata must say it is reserved`).toMatch(/reserved/i);
      expect(metadata, `${code} registry metadata must name the version`).toMatch(/v0\.1/);
      expect(section(STATUS_DOC, code), `status-codes.md §4 for ${code}`).toMatch(
        /not reachable in v0\.1/i,
      );
    }
  });
});

describe('the documented reason tables versus the reason taxonomy', () => {
  const allReasons = Object.values(SLTP_REASON) as SltpReason[];
  const documentedFatal = FATAL_TABLE.map((row) => unticked(cell(row, 0)));
  const documentedRecoverable = RECOVERABLE_TABLE.map((row) => unticked(cell(row, 0)));

  it('lists every fatal reason exactly once, in registry order', () => {
    expect(documentedFatal).toEqual(allReasons.filter((reason) => isFatalReason(reason)));
  });

  it('lists every recoverable reason exactly once', () => {
    // Order is not asserted: this table is deliberately ordered by the sequence
    // `validateRequest` applies its checks in, which §3 documents as normative and
    // which is not the declaration order in `SLTP_REASON`.
    expect([...documentedRecoverable].sort()).toEqual(
      allReasons.filter((reason) => !isFatalReason(reason)).sort(),
    );
  });

  it('documents no reason as both fatal and recoverable, and leaves none undocumented', () => {
    const documented = [...documentedFatal, ...documentedRecoverable];
    expect(new Set(documented).size).toBe(documented.length);
    expect([...documented].sort()).toEqual([...allReasons].sort());
  });

  it('documents the status each reason maps to', () => {
    for (const row of [...FATAL_TABLE, ...RECOVERABLE_TABLE]) {
      const reason = unticked(cell(row, 0)) as SltpReason;
      expect({ reason, status: Number(cell(row, 1)) }).toEqual({
        reason,
        status: statusForReason(reason),
      });
    }
  });
});
