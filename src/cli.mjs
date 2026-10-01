#!/usr/bin/env node
// @ts-check
/**
 * @file Command-line interface.
 *
 * Subcommands:
 *   demo    Generate a synthetic collection and plan it. Needs no input at all.
 *   plan    Plan a real collection from CSV.
 *   synth   Write a synthetic collection to CSV.
 *   explain Show, for one card, what reviewing it on each possible day is worth.
 *
 * Exit codes: 0 success, 1 bad input or I/O failure, 2 the optimality gap
 * exceeded --max-gap, 70 an internal invariant failed (a bug in crest).
 */

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { Fsrs6, DEFAULT_PARAMETERS } from './fsrs.mjs';
import { Valuer } from './value.mjs';
import { loadCollection } from './collection.mjs';
import { synthesiseCollection, collectionToCsv } from './synth.mjs';
import { planCollection } from './plan.mjs';
import { countPlans } from './plans.mjs';
import { toCsv } from './csv.mjs';
import { renderReport, renderTable } from './report.mjs';
import { CrestError, InvariantError } from './errors.mjs';

const USAGE = `crest - schedule spaced-repetition reviews so memory crests on exam day

usage:
  crest demo    [options]
  crest plan    --cards <file.csv> --exam-in <days> [options]
  crest synth   --count <n> [--seed <n>] [--out <file.csv>]
  crest explain --cards <file.csv> --card <id> --exam-in <days> [options]

the problem:
  FSRS and Anki schedule reviews to hold retention steady forever. Before an exam
  you want something else: the most cards recallable on one specific day, within
  the hours you actually have. crest solves that, and proves how close to optimal
  its answer is.

core options:
  --exam-in <days>        Whole days until the exam. Day 0 is today. (required for plan)
  --budget <minutes>      Study minutes per day. Accepts a comma list that repeats,
                          so "60,60,60,60,60,120,120" sets a weekly rhythm. [60]
  --start-date <date>     ISO date of day 0, for the printed calendar. [today]
  --cards <file>          Input CSV. Use "-" for stdin.

model options:
  --params <a,b,...>      21 FSRS-6 weights, as Anki exports them. [FSRS-6 defaults]
  --params-file <file>    Read the weights from a file (JSON array or comma list).
  --grade-mix <h,g,e>     Conditional Hard/Good/Easy split given recall. [0.3,0.6,0.1]
  --relearn-steps <n>     Same-day repeats after a lapse. [1]
  --difficulty-scale <s>  auto | fsrs (1-10) | anki (0-1). [auto]
  --seconds-recall <s>    Default seconds per recalled card when the CSV omits it. [12]
  --seconds-lapse <s>     Default seconds per lapsed card when the CSV omits it. [30]
  --retention <r>         Desired retention used by the Anki-policy baseline. [0.9]

solver options:
  --max-reviews <k>       Most reviews one card may get. Widens the family the
                          optimality certificate covers. [2]
  --safe-threshold <p>    Cards already at or above this recall probability on exam
                          day are left alone. 1 considers every card. [0.98]
  --iterations <n>        Dual iterations. More means a tighter certificate. [60]
  --epsilon <p>           Prune outcome branches below this probability. 0 is exact. [0]
  --max-gap <p>           Exit 2 if the proven gap exceeds this. [1]
  --trials <n>            Monte-Carlo trials for the baseline and cross-check.
                          0 skips both. [1500]
  --seed <n>              Seed for every random draw. [1]

output options:
  --json [file]           Emit the full result as JSON (stdout if no file given).
  --csv <file>            Write the per-card schedule as CSV.
  --rows <n>              Card rows to show in the text report; 0 for all. [20]
  --quiet                 Suppress progress on stderr.
  -h, --help              This text.

examples:
  crest demo
  crest demo --exam-in 14 --budget 45 --max-reviews 3
  crest plan --cards collection.csv --exam-in 21 --budget 90,90,90,90,90,180,180
  crest plan --cards collection.csv --exam-in 10 --json plan.json --csv schedule.csv
  crest explain --cards collection.csv --card 1699123456789 --exam-in 14
`;

/**
 * Parse `--flag value` and `--flag=value`, plus bare `-h`.
 *
 * Hand-rolled rather than using `node:util.parseArgs` because this needs
 * `--json` to work both as a boolean and with an optional value, and because an
 * unknown flag must be a hard error -- a mistyped `--budgett` that is silently
 * ignored produces a confident plan for the wrong budget.
 *
 * @param {readonly string[]} argv
 * @returns {{command: string, flags: Map<string, string | true>}}
 */
export function parseArgs(argv) {
  /** @type {Map<string, string | true>} */
  const flags = new Map();
  let command = '';
  const valueless = new Set(['quiet', 'help', 'h']);
  const optionalValue = new Set(['json']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      if (command === '') {
        command = token;
      } else {
        throw new CrestError(`unexpected argument ${JSON.stringify(token)}.`, {
          hint: 'Only one subcommand is accepted. Run crest --help.',
        });
      }
      continue;
    }
    const stripped = token.replace(/^--?/, '');
    const eq = stripped.indexOf('=');
    if (eq !== -1) {
      flags.set(stripped.slice(0, eq), stripped.slice(eq + 1));
      continue;
    }
    if (valueless.has(stripped)) {
      flags.set(stripped, true);
      continue;
    }
    const next = argv[i + 1];
    const hasValue = next !== undefined && (!next.startsWith('-') || /^-\d/.test(next));
    if (!hasValue) {
      if (optionalValue.has(stripped)) {
        flags.set(stripped, true);
        continue;
      }
      throw new CrestError(`flag --${stripped} needs a value.`);
    }
    flags.set(stripped, next);
    i += 1;
  }
  return { command, flags };
}

/**
 * @param {Map<string, string | true>} flags
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numFlag(flags, name, fallback) {
  if (!flags.has(name)) return fallback;
  const raw = flags.get(name);
  if (raw === true) throw new CrestError(`flag --${name} needs a value.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new CrestError(`--${name} must be a number, got ${JSON.stringify(raw)}.`);
  }
  return value;
}

/**
 * @param {Map<string, string | true>} flags
 * @param {string} name
 * @returns {string | undefined}
 */
function strFlag(flags, name) {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  if (raw === true) throw new CrestError(`flag --${name} needs a value.`);
  return raw;
}

/**
 * @param {string} raw
 * @param {string} name
 * @returns {number[]}
 */
function numberList(raw, name) {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length === 0) {
    throw new CrestError(`--${name} is empty.`);
  }
  return parts.map((p) => {
    const v = Number(p);
    if (!Number.isFinite(v)) {
      throw new CrestError(`--${name}: ${JSON.stringify(p)} is not a number.`);
    }
    return v;
  });
}

/** Flags accepted by each subcommand, so typos are caught rather than ignored. */
const KNOWN_FLAGS = new Set([
  'exam-in', 'budget', 'start-date', 'cards', 'params', 'params-file', 'grade-mix',
  'relearn-steps', 'difficulty-scale', 'seconds-recall', 'seconds-lapse', 'retention',
  'max-reviews', 'safe-threshold', 'iterations', 'epsilon', 'max-gap', 'trials', 'seed',
  'json', 'csv', 'rows', 'quiet', 'help', 'h', 'count', 'out', 'card',
]);

/**
 * @param {Map<string, string | true>} flags
 */
function rejectUnknownFlags(flags) {
  const unknown = [...flags.keys()].filter((k) => !KNOWN_FLAGS.has(k));
  if (unknown.length > 0) {
    throw new CrestError(
      `unknown flag(s): ${unknown.map((u) => `--${u}`).join(', ')}.`,
      { hint: 'Run crest --help for the accepted list.' },
    );
  }
}

/**
 * @param {string} path
 * @returns {Promise<string>}
 */
async function readInput(path) {
  if (path === '-') {
    /** @type {Buffer[]} */
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new CrestError(`cannot read ${path}: ${/** @type {Error} */ (error).message}`, {
      cause: error,
    });
  }
}

/**
 * @param {Map<string, string | true>} flags
 * @returns {Promise<number[]>}
 */
async function resolveParameters(flags) {
  const inline = strFlag(flags, 'params');
  const file = strFlag(flags, 'params-file');
  if (inline && file) {
    throw new CrestError('pass either --params or --params-file, not both.');
  }
  if (inline) return numberList(inline, 'params');
  if (file) {
    const text = await readInput(file);
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        return parsed.map(Number);
      } catch (error) {
        throw new CrestError(`${file} is not a JSON array of numbers.`, { cause: error });
      }
    }
    return numberList(trimmed.replace(/\s+/g, ','), 'params-file');
  }
  return Array.from(DEFAULT_PARAMETERS);
}

/**
 * @param {Map<string, string | true>} flags
 * @returns {{budget: number | number[], examInDays: number, options: Record<string, unknown>}}
 */
function commonPlanSettings(flags) {
  const examInDays = numFlag(flags, 'exam-in', 14);
  if (!Number.isInteger(examInDays) || examInDays < 1) {
    throw new CrestError(
      `--exam-in must be a whole number of days >= 1, got ${examInDays}.`,
      { hint: 'Use 1 if the exam is tomorrow.' },
    );
  }
  const budgetRaw = strFlag(flags, 'budget');
  const budget = budgetRaw === undefined ? 60 : numberList(budgetRaw, 'budget');
  const gradeMixRaw = strFlag(flags, 'grade-mix');
  let gradeMix;
  if (gradeMixRaw !== undefined) {
    const parts = numberList(gradeMixRaw, 'grade-mix');
    if (parts.length !== 3) {
      throw new CrestError(
        `--grade-mix needs exactly three values (hard,good,easy), got ${parts.length}.`,
      );
    }
    gradeMix = { hard: parts[0], good: parts[1], easy: parts[2] };
  }
  return {
    budget: budget.length === 1 ? budget[0] : budget,
    examInDays,
    options: {
      gradeMix,
      maxReviews: numFlag(flags, 'max-reviews', 2),
      safeThreshold: numFlag(flags, 'safe-threshold', 0.98),
      relearnSteps: numFlag(flags, 'relearn-steps', 1),
      iterations: numFlag(flags, 'iterations', 60),
      epsilon: numFlag(flags, 'epsilon', 0),
      desiredRetention: numFlag(flags, 'retention', 0.9),
      trials: numFlag(flags, 'trials', 1500),
      seed: numFlag(flags, 'seed', 1),
      startDate: strFlag(flags, 'start-date'),
    },
  };
}

/**
 * @param {boolean} quiet
 * @returns {undefined | ((p: {phase: string, done: number, total: number}) => void)}
 */
function makeProgress(quiet) {
  if (quiet || !process.stderr.isTTY) return undefined;
  let lastPhase = '';
  return ({ phase, done, total }) => {
    const label = phase.padEnd(11);
    const bar = total > 0 ? `${done}/${total}` : '';
    process.stderr.write(`\r${label} ${bar}            `);
    if (phase !== lastPhase) lastPhase = phase;
    if (done === total) process.stderr.write('\r' + ' '.repeat(40) + '\r');
  };
}

/**
 * @param {import('./viewmodel.mjs').ViewModel} viewModel
 * @returns {string}
 */
function scheduleCsv(viewModel) {
  /** @type {(string | number)[][]} */
  const rows = [['card_id', 'review_dates', 'review_days', 'p_recall_now', 'p_recall_planned', 'gain', 'minutes', 'status']];
  for (const c of /** @type {any[]} */ (viewModel.perCard)) {
    rows.push([
      c.cardId, c.dates.join(' '), c.days.join(' '),
      c.baseline.toFixed(6), c.value.toFixed(6), c.gain.toFixed(6),
      c.minutes.toFixed(2), 'scheduled',
    ]);
  }
  for (const c of /** @type {any[]} */ (viewModel.abandoned)) {
    rows.push([c.cardId, '', '', c.baseline.toFixed(6), c.value.toFixed(6), '0', '0', 'not-worth-saving']);
  }
  for (const c of /** @type {any[]} */ (viewModel.safe)) {
    rows.push([c.cardId, '', '', c.baseline.toFixed(6), c.baseline.toFixed(6), '0', '0', 'already-safe']);
  }
  return toCsv(rows);
}

/**
 * @param {readonly string[]} argv
 * @returns {Promise<number>} exit code
 */
export async function main(argv) {
  const { command, flags } = parseArgs(argv);
  if (flags.has('help') || flags.has('h') || command === '' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  rejectUnknownFlags(flags);
  const quiet = flags.get('quiet') === true;

  if (command === 'synth') {
    const count = numFlag(flags, 'count', 400);
    const seed = numFlag(flags, 'seed', 42);
    const csv = collectionToCsv(synthesiseCollection({ count, seed }));
    const out = strFlag(flags, 'out');
    if (out) {
      await writeFile(out, csv, 'utf8');
      process.stderr.write(`wrote ${count} cards to ${out}\n`);
    } else {
      process.stdout.write(csv);
    }
    return 0;
  }

  if (command !== 'demo' && command !== 'plan' && command !== 'explain') {
    throw new CrestError(`unknown command ${JSON.stringify(command)}.`, {
      hint: 'Expected demo, plan, synth or explain. Run crest --help.',
    });
  }

  const settings = commonPlanSettings(flags);
  const parameters = await resolveParameters(flags);
  /** @type {string[]} */
  const notes = [];
  /** @type {import('./value.mjs').Card[]} */
  let cards;

  if (command === 'demo') {
    const count = numFlag(flags, 'count', 400);
    cards = synthesiseCollection({ count, seed: numFlag(flags, 'seed', 42) });
    notes.push(
      `This is a synthetic collection of ${count} cards (seed ` +
        `${numFlag(flags, 'seed', 42)}), not real review history. ` +
        'Run `crest synth --out cards.csv` to inspect it, or see examples/anki-export.py ' +
        'to export your own.',
    );
  } else {
    const path = strFlag(flags, 'cards');
    if (!path) {
      throw new CrestError('--cards <file.csv> is required.', {
        hint: 'Use `crest demo` to try crest without a collection, or "-" to read stdin.',
      });
    }
    const scaleRaw = strFlag(flags, 'difficulty-scale') ?? 'auto';
    if (scaleRaw !== 'auto' && scaleRaw !== 'fsrs' && scaleRaw !== 'anki') {
      throw new CrestError(
        `--difficulty-scale must be auto, fsrs or anki, got ${JSON.stringify(scaleRaw)}.`,
      );
    }
    const loaded = loadCollection(await readInput(path), {
      difficultyScale: scaleRaw,
      defaultSecondsRecall: numFlag(flags, 'seconds-recall', 12),
      defaultSecondsLapse: numFlag(flags, 'seconds-lapse', 30),
      today: /** @type {string | undefined} */ (settings.options.startDate),
    });
    cards = loaded.cards;
    notes.push(...loaded.notes);
  }

  if (command === 'explain') {
    return explainCard({ cards, flags, parameters, settings });
  }

  // Warn before a long run rather than after it.
  const planCount = countPlans(settings.examInDays, /** @type {number} */ (settings.options.maxReviews));
  if (!quiet) {
    process.stderr.write(
      `planning ${cards.length} cards over ${settings.examInDays} days ` +
        `(${planCount} candidate plans per card)\n`,
    );
  }

  const { viewModel } = planCollection({
    cards,
    examInDays: settings.examInDays,
    budgetMinutes: settings.budget,
    parameters,
    notes,
    onProgress: makeProgress(quiet),
    .../** @type {any} */ (settings.options),
  });

  const jsonFlag = flags.get('json');
  if (jsonFlag !== undefined) {
    const payload = JSON.stringify(viewModel, null, 2) + '\n';
    if (jsonFlag === true) {
      process.stdout.write(payload);
    } else {
      await writeFile(jsonFlag, payload, 'utf8');
      process.stderr.write(`wrote ${jsonFlag}\n`);
    }
  }
  const csvOut = strFlag(flags, 'csv');
  if (csvOut) {
    await writeFile(csvOut, scheduleCsv(viewModel), 'utf8');
    process.stderr.write(`wrote ${csvOut}\n`);
  }
  if (jsonFlag === undefined) {
    process.stdout.write(
      renderReport(viewModel, { maxCardRows: numFlag(flags, 'rows', 20) }) + '\n',
    );
  }

  const maxGap = numFlag(flags, 'max-gap', 1);
  const gap = /** @type {any} */ (viewModel.summary).optimalityGap;
  if (gap > maxGap) {
    process.stderr.write(
      `proven optimality gap ${(gap * 100).toFixed(2)}% exceeds --max-gap ` +
        `${(maxGap * 100).toFixed(2)}%; raise --iterations or --max-gap.\n`,
    );
    return 2;
  }
  return 0;
}

/**
 * `explain` answers the question the aggregate report cannot: for this one card,
 * what is each possible review day worth? The shape of that curve is the whole
 * argument -- it rises as the review moves later (bigger spacing gain) and then
 * falls (lapse risk, and less time to re-consolidate before the exam).
 *
 * @param {object} args
 * @param {import('./value.mjs').Card[]} args.cards
 * @param {Map<string, string | true>} args.flags
 * @param {number[]} args.parameters
 * @param {{examInDays: number, options: any}} args.settings
 * @returns {number}
 */
function explainCard({ cards, flags, parameters, settings }) {
  const id = strFlag(flags, 'card');
  if (!id) {
    throw new CrestError('--card <id> is required for `explain`.');
  }
  const card = cards.find((c) => c.id === id);
  if (!card) {
    throw new CrestError(`no card with id ${JSON.stringify(id)} in the collection.`, {
      hint: `First few ids: ${cards.slice(0, 5).map((c) => c.id).join(', ')}`,
    });
  }
  const model = new Fsrs6(parameters);
  const valuer = new Valuer({
    model,
    examInDays: settings.examInDays,
    gradeMix: settings.options.gradeMix,
    relearnSteps: settings.options.relearnSteps,
  });
  const baseline = valuer.baselineValue(card);

  /** @type {string[][]} */
  const rows = [];
  let bestDay = -1;
  let bestValue = baseline;
  for (let day = 0; day < settings.examInDays; day += 1) {
    const { value, dayCosts } = valuer.valuePlan(card, [day]);
    if (value > bestValue) {
      bestValue = value;
      bestDay = day;
    }
    const r = model.retrievability(card.stability, card.daysSinceReview + day);
    rows.push([
      String(day),
      `${(r * 100).toFixed(1)}%`,
      `${(value * 100).toFixed(1)}%`,
      `${value - baseline >= 0 ? '+' : ''}${(value - baseline).toFixed(4)}`,
      `${(dayCosts[0] / 60).toFixed(2)}`,
    ]);
  }

  const out = [
    `card ${card.id}${card.label ? ` (${card.label})` : ''}`,
    `  stability ${card.stability.toFixed(2)} d, difficulty ${card.difficulty.toFixed(2)}, ` +
      `last reviewed ${card.daysSinceReview} d ago`,
    `  exam in ${settings.examInDays} days; recall probability then, with no review: ` +
      `${(baseline * 100).toFixed(1)}%`,
    '',
    'VALUE OF A SINGLE REVIEW, BY DAY',
    renderTable(
      ['day', 'R at review', 'P(recall) on exam day', 'gain', 'expected min'],
      rows,
      ['right', 'right', 'right', 'right', 'right'],
    ),
    '',
  ];
  if (bestDay >= 0) {
    out.push(
      `Best single day: day ${bestDay} (+${(bestValue - baseline).toFixed(4)}). ` +
        'Earlier is wasted on a card you can still recall; later risks a lapse and ' +
        'leaves less time to re-consolidate.',
    );
  } else {
    out.push('No single review improves this card: it is already safe for exam day.');
  }
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

// Entry point. Errors are classified so that a bug in crest never masquerades as
// bad user input. `pathToFileURL` rather than string concatenation because on
// Windows `process.argv[1]` is `C:\...`, which never equals `file://C:\...`.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      if (error instanceof CrestError) {
        process.stderr.write(`error: ${error.message}\n`);
        if (error.hint) process.stderr.write(`hint: ${error.hint}\n`);
        process.exitCode = 1;
      } else if (error instanceof InvariantError) {
        process.stderr.write(
          `internal error: ${error.message}\n` +
            'This is a bug in crest. The result would not be trustworthy, so nothing was printed.\n',
        );
        process.exitCode = 70;
      } else {
        process.stderr.write(`unexpected error: ${/** @type {Error} */ (error).stack}\n`);
        process.exitCode = 70;
      }
    });
}
