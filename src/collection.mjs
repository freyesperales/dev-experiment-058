// @ts-check
/**
 * @file Loading a card collection from CSV.
 *
 * The expected columns are described in the README. Two wrinkles are handled here
 * rather than left to the user, because both silently produce plausible-looking
 * nonsense if they are got wrong:
 *
 *  - **Difficulty scale.** FSRS difficulty lives in [1, 10], but Anki remaps it to
 *    [0, 1] for display and shows it as a percentage. A collection exported from
 *    the user interface therefore arrives on the wrong scale, and 0.3 is a legal
 *    FSRS-scale value so nothing crashes -- the planner just believes every card
 *    is maximally easy. Detection is automatic, overridable, and always reported.
 *
 *  - **Elapsed time.** Either `days_since_review` or a `last_review` date is
 *    accepted; the latter needs a reference "today", which defaults to the system
 *    date and is overridable so runs are reproducible.
 */

import { parseCsv } from './csv.mjs';
import { CrestError } from './errors.mjs';
import { validateCard } from './value.mjs';

/** @type {Readonly<Record<string, readonly string[]>>} */
const ALIASES = Object.freeze({
  id: ['card_id', 'id', 'cid'],
  stability: ['stability', 's', 'fsrs_stability'],
  difficulty: ['difficulty', 'd', 'fsrs_difficulty'],
  daysSinceReview: ['days_since_review', 'elapsed_days', 'days_elapsed', 'age_days'],
  lastReview: ['last_review', 'last_review_date', 'reviewed_at'],
  secondsRecall: ['seconds_recall', 'seconds_per_review', 'avg_seconds', 'seconds'],
  secondsLapse: ['seconds_lapse', 'seconds_again'],
  label: ['label', 'front', 'question', 'note', 'text'],
});

/**
 * @param {readonly string[]} header
 * @param {string} logical
 * @returns {string | undefined}
 */
function findColumn(header, logical) {
  const candidates = ALIASES[logical];
  const lower = header.map((h) => h.toLowerCase());
  for (const candidate of candidates) {
    const index = lower.indexOf(candidate);
    if (index !== -1) return header[index];
  }
  return undefined;
}

/**
 * @param {string} raw
 * @param {string} field
 * @param {number} line
 * @returns {number}
 */
function parseNumber(raw, field, line) {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new CrestError(`data row ${line}: ${field} is empty.`);
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new CrestError(
      `data row ${line}: ${field} = ${JSON.stringify(raw)} is not a number.`,
    );
  }
  return value;
}

/**
 * Days between two ISO dates, floored, interpreting both as UTC midnight so the
 * result does not change with the machine's timezone.
 *
 * @param {string} from ISO date, `YYYY-MM-DD` or a full timestamp
 * @param {string} to
 * @param {number} line
 * @returns {number}
 */
function daysBetween(from, to, line) {
  const parse = (/** @type {string} */ value, /** @type {string} */ what) => {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
    const ms = Date.parse(dateOnly ? `${value.trim()}T00:00:00Z` : value.trim());
    if (Number.isNaN(ms)) {
      throw new CrestError(
        `data row ${line}: ${what} = ${JSON.stringify(value)} is not an ISO date.`,
        { hint: 'Use YYYY-MM-DD.' },
      );
    }
    return ms;
  };
  const diff = parse(to, 'today') - parse(from, 'last_review');
  return Math.max(0, Math.floor(diff / 86_400_000));
}

/**
 * @typedef {object} LoadResult
 * @property {import('./value.mjs').Card[]} cards
 * @property {'fsrs' | 'anki'} difficultyScale The scale actually used.
 * @property {boolean} scaleWasDetected Whether that was auto-detected.
 * @property {string[]} notes Human-facing remarks worth printing.
 */

/**
 * @param {string} text CSV content
 * @param {object} [options]
 * @param {'auto' | 'fsrs' | 'anki'} [options.difficultyScale]
 * @param {number} [options.defaultSecondsRecall]
 * @param {number} [options.defaultSecondsLapse]
 * @param {string} [options.today] ISO date used when the CSV carries `last_review`.
 * @returns {LoadResult}
 */
export function loadCollection(text, options = {}) {
  const {
    difficultyScale = 'auto',
    defaultSecondsRecall = 12,
    defaultSecondsLapse = 30,
    today = new Date().toISOString().slice(0, 10),
  } = options;

  const { header, records, lineOf } = parseCsv(text);
  if (records.length === 0) {
    throw new CrestError('CSV has a header but no data rows.');
  }

  const colStability = findColumn(header, 'stability');
  const colDifficulty = findColumn(header, 'difficulty');
  if (!colStability || !colDifficulty) {
    throw new CrestError(
      `CSV must have a stability column and a difficulty column. Found: ${header.join(', ')}.`,
      {
        hint:
          'Accepted names: stability|s|fsrs_stability and difficulty|d|fsrs_difficulty. ' +
          'See examples/anki-export.py for a script that produces the right shape.',
      },
    );
  }
  const colId = findColumn(header, 'id');
  const colDays = findColumn(header, 'daysSinceReview');
  const colLast = findColumn(header, 'lastReview');
  if (!colDays && !colLast) {
    throw new CrestError(
      'CSV must say how long ago each card was reviewed: add days_since_review or last_review.',
      { hint: `Found columns: ${header.join(', ')}` },
    );
  }
  const colSecondsRecall = findColumn(header, 'secondsRecall');
  const colSecondsLapse = findColumn(header, 'secondsLapse');
  const colLabel = findColumn(header, 'label');

  // Raw difficulties first, so the scale can be decided from all of them at once.
  const rawDifficulty = records.map((record, i) =>
    parseNumber(record[colDifficulty], 'difficulty', lineOf[i]),
  );
  /** @type {string[]} */
  const notes = [];
  /** @type {'fsrs' | 'anki'} */
  let scale;
  let scaleWasDetected = false;
  if (difficultyScale === 'auto') {
    // A loop rather than Math.max(...array): spreading a 200k-element array
    // overflows the argument limit and throws RangeError.
    let max = -Infinity;
    let min = Infinity;
    for (const d of rawDifficulty) {
      if (d > max) max = d;
      if (d < min) min = d;
    }
    const looksAnki = max <= 1.0 && min >= 0 && rawDifficulty.some((d) => d < 1.0);
    scale = looksAnki ? 'anki' : 'fsrs';
    scaleWasDetected = true;
    if (looksAnki) {
      notes.push(
        `Difficulty values all fall in [${min}, ${max}], so they were read as Anki's ` +
          '0-1 display scale and mapped to the FSRS 1-10 scale. ' +
          'Pass --difficulty-scale fsrs if that is wrong.',
      );
    }
  } else {
    scale = difficultyScale;
  }

  /** @type {import('./value.mjs').Card[]} */
  const cards = [];
  const seenIds = new Set();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const line = lineOf[i];
    const id = colId ? record[colId].trim() : `card-${i + 1}`;
    if (id === '') {
      throw new CrestError(`data row ${line}: card id is empty.`);
    }
    if (seenIds.has(id)) {
      throw new CrestError(
        `data row ${line}: duplicate card id ${JSON.stringify(id)}.`,
        { hint: 'Card ids must be unique; the planner assigns one plan per id.' },
      );
    }
    seenIds.add(id);

    const difficulty = scale === 'anki' ? 1 + 9 * rawDifficulty[i] : rawDifficulty[i];
    const daysSinceReview = colDays
      ? parseNumber(record[colDays], 'days_since_review', line)
      : daysBetween(record[/** @type {string} */ (colLast)], today, line);

    cards.push(
      validateCard(
        {
          id,
          stability: parseNumber(record[colStability], 'stability', line),
          difficulty,
          daysSinceReview: Math.round(daysSinceReview),
          secondsRecall:
            colSecondsRecall && record[colSecondsRecall].trim() !== ''
              ? parseNumber(record[colSecondsRecall], 'seconds_recall', line)
              : defaultSecondsRecall,
          secondsLapse:
            colSecondsLapse && record[colSecondsLapse].trim() !== ''
              ? parseNumber(record[colSecondsLapse], 'seconds_lapse', line)
              : colSecondsRecall && record[colSecondsRecall].trim() !== ''
                ? // No explicit lapse cost: a lapse plus its relearning step costs
                  // appreciably more than a clean recall. 2.5x is a rough stand-in,
                  // capped so it cannot leave the validator's range.
                  Math.min(
                    parseNumber(record[colSecondsRecall], 'seconds_recall', line) * 2.5,
                    3600,
                  )
                : defaultSecondsLapse,
          label: colLabel ? record[colLabel] : undefined,
        },
        `data row ${line}`,
      ),
    );
  }

  return { cards, difficultyScale: scale, scaleWasDetected, notes };
}
