// @ts-check
/**
 * @file A small, strict RFC 4180 CSV reader.
 *
 * Written rather than depended on because this project has no dependencies, and
 * because the error messages matter more than the feature set here: the input is
 * hand-exported by a student from Anki, so "unterminated quoted field starting at
 * line 41" is worth more than silently producing a shorter table.
 *
 * Supported: quoted fields, embedded commas, embedded newlines, doubled quotes to
 * escape a quote, CRLF or LF line endings, a UTF-8 BOM, `#` comment lines, blank
 * lines. Not supported: alternative delimiters, multi-character quotes.
 */

import { CrestError } from './errors.mjs';

/**
 * Parse CSV into rows of strings. Does not interpret a header.
 *
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsvRows(text) {
  if (typeof text !== 'string') {
    throw new CrestError('CSV input must be a string.');
  }
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let inQuotes = false;
  let fieldHasContent = false;
  let line = 1;
  let quoteStartLine = 1;

  /** Finish the current field. */
  const endField = () => {
    row.push(field);
    field = '';
    fieldHasContent = false;
  };

  /** Finish the current row, dropping blank and comment rows. */
  const endRow = () => {
    endField();
    const isBlank = row.length === 1 && row[0].trim() === '';
    const isComment = row.length > 0 && row[0].trimStart().startsWith('#');
    if (!isBlank && !isComment) rows.push(row);
    row = [];
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      if (fieldHasContent) {
        throw new CrestError(
          `line ${line}: a quote may only open a field, not appear inside an unquoted one.`,
          { hint: 'Wrap the whole field in quotes and double any internal quote: "a ""b"" c".' },
        );
      }
      inQuotes = true;
      quoteStartLine = line;
      fieldHasContent = true;
      continue;
    }
    if (ch === ',') {
      endField();
      continue;
    }
    if (ch === '\r') {
      if (input[i + 1] === '\n') i += 1;
      endRow();
      line += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      line += 1;
      continue;
    }
    field += ch;
    fieldHasContent = true;
  }

  if (inQuotes) {
    throw new CrestError(
      `unterminated quoted field: the quote opened on line ${quoteStartLine} is never closed.`,
    );
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Parse CSV with a header row into records keyed by column name.
 *
 * @param {string} text
 * @returns {{header: string[], records: Array<Record<string, string>>, lineOf: number[]}}
 *   `lineOf[i]` is the 1-based data-row number of `records[i]`, for error messages.
 */
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new CrestError('CSV is empty: no header row found.');
  }
  const header = rows[0].map((h) => h.trim());
  const seen = new Set();
  for (const name of header) {
    if (name === '') {
      throw new CrestError('CSV header contains an empty column name.');
    }
    if (seen.has(name)) {
      throw new CrestError(`CSV header repeats the column "${name}".`);
    }
    seen.add(name);
  }

  /** @type {Array<Record<string, string>>} */
  const records = [];
  /** @type {number[]} */
  const lineOf = [];
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (row.length !== header.length) {
      throw new CrestError(
        `CSV data row ${r} has ${row.length} field(s) but the header declares ${header.length}.`,
        { hint: `Row content: ${JSON.stringify(row.slice(0, 6))}` },
      );
    }
    /** @type {Record<string, string>} */
    const record = {};
    for (let c = 0; c < header.length; c += 1) record[header[c]] = row[c];
    records.push(record);
    lineOf.push(r);
  }
  return { header, records, lineOf };
}

/**
 * Serialise rows to CSV, quoting only where required.
 *
 * @param {readonly (readonly (string | number)[])[]} rows
 * @returns {string}
 */
export function toCsv(rows) {
  return (
    rows
      .map((row) =>
        row
          .map((cell) => {
            const s = String(cell);
            return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(','),
      )
      .join('\n') + '\n'
  );
}
