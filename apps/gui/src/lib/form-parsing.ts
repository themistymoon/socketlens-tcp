/**
 * Text-field parsers shared by the rule and scenario editors.
 *
 * Both editors take protocol values from free-text inputs, so both need the same
 * conversions: `Name: value` lines into a header record, a loose list of numbers into
 * fragment sizes, and a possibly-empty field into an optional count. Keeping one copy
 * means the two forms cannot drift into accepting subtly different input, and it lets
 * the parsing be tested directly rather than through a rendered form.
 *
 * Every parser returns `undefined` rather than an empty value when the field holds
 * nothing usable, because the protocol layer distinguishes "absent" from "empty": an
 * omitted header block is not the same as a header block with no entries.
 */

/**
 * Parses `Name: value` lines into a header record, ignoring blank lines.
 *
 * Lines without a colon, and lines whose colon is the first character, are skipped
 * rather than treated as errors — the field is edited live, so a half-typed line must
 * not destroy the entries already parsed. Returns `undefined` when nothing parsed.
 */
export function parseHeaderLines(text: string): Record<string, string> | undefined {
  const entries: Record<string, string> = {};
  let found = false;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    entries[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
    found = true;
  }

  return found ? entries : undefined;
}

/** Renders a header record back into editable `Name: value` lines. */
export function formatHeaderLines(headers: Readonly<Record<string, string>> | undefined): string {
  if (!headers) return '';
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

/**
 * Parses a comma or space separated list of positive byte counts.
 *
 * Non-numeric and non-positive entries are dropped: a fragment of zero bytes is not a
 * fragment, and a negative one cannot be written. Returns `undefined` when no valid
 * size remains, which the caller reads as "no explicit fragmentation".
 */
export function parseSizes(text: string): number[] | undefined {
  const sizes = text
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part))
    .filter((value) => Number.isInteger(value) && value > 0);
  return sizes.length > 0 ? sizes : undefined;
}

/**
 * Reads an optional non-negative integer from a text field.
 *
 * Zero is valid — a delay of `0` is meaningfully different from no delay at all — so
 * only blank, non-integer, and negative input yields `undefined`.
 */
export function optionalCount(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}
