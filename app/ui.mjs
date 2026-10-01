// @ts-check
/**
 * @file DOM glue for the browser app.
 *
 * Deliberately thin. Every decision -- what to compute, how to classify a card,
 * what a day is worth -- lives in `src/`, which the test suite covers. What is
 * left here is reading form values, calling `planCollection`, and writing strings
 * into elements. That split is why the app can be shipped without browser
 * automation: the part that could be subtly wrong is tested, and the part that is
 * untested is too simple to be subtly wrong (it is either visibly broken or fine).
 */

import { planCollection } from '../src/plan.mjs';
import { loadCollection } from '../src/collection.mjs';
import { synthesiseCollection } from '../src/synth.mjs';
import { DEFAULT_PARAMETERS } from '../src/fsrs.mjs';
import { CrestError } from '../src/errors.mjs';

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function el(id) {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return /** @type {HTMLElement} */ (node);
}

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
function input(id) {
  return /** @type {HTMLInputElement} */ (el(id));
}

/** @type {import('../src/value.mjs').Card[] | null} */
let loadedCards = null;
/** @type {string[]} */
let loadNotes = [];

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {string}
 */
const pct = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;

/**
 * @param {string} message
 * @param {'error' | 'info' | 'ok'} kind
 */
function setStatus(message, kind = 'info') {
  const node = el('status');
  node.textContent = message;
  node.className = `status status--${kind}`;
}

/**
 * Parse the budget field: a single number, or a comma list that repeats weekly.
 * @returns {number | number[]}
 */
function readBudget() {
  const raw = input('budget').value.trim();
  if (raw === '') throw new CrestError('Enter a daily study budget in minutes.');
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p !== '');
  const values = parts.map((p) => {
    const v = Number(p);
    if (!Number.isFinite(v) || v < 0) {
      throw new CrestError(`"${p}" is not a number of minutes.`);
    }
    return v;
  });
  if (values.length === 0) throw new CrestError('Enter a daily study budget in minutes.');
  return values.length === 1 ? values[0] : values;
}

/** @returns {number[]} */
function readParameters() {
  const raw = input('params').value.trim();
  if (raw === '') return Array.from(DEFAULT_PARAMETERS);
  const parts = raw
    .replace(/[[\]]/g, '')
    .split(/[,\s]+/)
    .filter((p) => p !== '');
  return parts.map((p) => {
    const v = Number(p);
    if (!Number.isFinite(v)) throw new CrestError(`"${p}" in the FSRS weights is not a number.`);
    return v;
  });
}

/**
 * Read a whole-number field. Not `Number(x) || fallback`: that turns a deliberate
 * 0 into the fallback, and 0 is meaningful for both of the fields this reads
 * ("review nothing" and "skip the simulations").
 *
 * @param {string} id
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function readWholeNumber(id, fallback, min, max) {
  const raw = input(id).value.trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CrestError(`"${raw}" must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

/**
 * Days between today and the exam date, in whole days.
 * @returns {number}
 */
function readExamInDays() {
  const examDate = input('exam-date').value;
  const startDate = input('start-date').value;
  if (!examDate) throw new CrestError('Pick the date of your exam.');
  if (!startDate) throw new CrestError('Pick the first day you will study.');
  const exam = Date.parse(`${examDate}T00:00:00Z`);
  const start = Date.parse(`${startDate}T00:00:00Z`);
  if (Number.isNaN(exam) || Number.isNaN(start)) throw new CrestError('Those dates are not valid.');
  const days = Math.round((exam - start) / 86_400_000);
  if (days < 1) {
    throw new CrestError('The exam must be at least one day after the first study day.');
  }
  if (days > 180) {
    throw new CrestError(
      `That is ${days} days away. crest is built for exam horizons up to about 180 days.`,
    );
  }
  return days;
}

/**
 * Escape text for interpolation into HTML. Card labels come from the user's own
 * collection, so they are not hostile -- but they are arbitrary text, and an
 * unescaped `<` in a chemistry deck would quietly eat the rest of the row.
 *
 * @param {string} s
 * @returns {string}
 */
function escape(s) {
  return String(s).replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  );
}

/**
 * @param {readonly string[]} header
 * @param {readonly (readonly string[])[]} rows
 * @returns {string} HTML
 */
function table(header, rows) {
  const head = header.map((h) => `<th>${escape(h)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((c) => `<td>${escape(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * @param {import('../src/viewmodel.mjs').ViewModel} vm
 */
function render(vm) {
  const s = /** @type {any} */ (vm.summary);
  const r = s.expectedRecall;

  el('headline').innerHTML =
    `<strong>${s.expectedRecall.planned.toFixed(1)}</strong> of ${s.cards} cards expected on ` +
    `<strong>${s.examDate}</strong> &mdash; up from ${r.doNothing.toFixed(1)} if you study nothing` +
    (r.ankiPolicy !== null
      ? `, and ${r.ankiPolicy.toFixed(1)} if you just clear what Anki says is due`
      : '');

  /** @type {string[][]} */
  const outcome = [['Study nothing', r.doNothing.toFixed(2), pct(s.expectedRecallShare.doNothing)]];
  if (r.ankiPolicy !== null) {
    outcome.push([
      'Clear what is due (FSRS order)',
      r.ankiPolicy.toFixed(2),
      pct(s.expectedRecallShare.ankiPolicy),
    ]);
  }
  outcome.push(['This plan', r.planned.toFixed(2), pct(s.expectedRecallShare.planned)]);
  outcome.push([
    `Proven ceiling (gap ${pct(s.optimalityGap, 2)})`,
    r.upperBound.toFixed(2),
    pct(s.expectedRecallShare.upperBound),
  ]);
  el('outcome').innerHTML = table(['Policy', 'Cards recalled', 'Share'], outcome);

  el('disposition').innerHTML = table(
    ['Group', 'Cards', 'What it means'],
    [
      ['Already safe', String(s.cardsSafe), 'High enough recall on exam day without review'],
      ['Scheduled', String(s.cardsPlanned), `${s.reviewsScheduled} reviews planned`],
      ['Not worth saving', String(s.cardsAbandoned), 'Your time buys more recall elsewhere'],
    ],
  );

  el('days').innerHTML = table(
    ['Date', 'Day', 'Cards', 'Minutes', 'Budget', 'Used'],
    /** @type {any[]} */ (vm.days).map((d) => [
      d.date,
      d.weekday,
      String(d.cards),
      d.minutes.toFixed(0),
      d.budgetMinutes.toFixed(0),
      pct(d.utilisation, 0),
    ]),
  );

  const advice = s.bestDayForAnExtraHour;
  el('advice').textContent = advice
    ? `An extra hour is worth most on ${advice.date}: about ` +
      `${advice.extraCardsPerHour.toFixed(2)} more cards recalled.`
    : 'No day is full. More study time would not raise your expected recall.';

  el('cards').innerHTML = table(
    ['Card', 'Review on', 'Stability', 'Last seen', 'Now', 'Planned'],
    /** @type {any[]} */ (vm.perCard).slice(0, 200).map((c) => [
      c.label || c.cardId,
      c.dates.join(', '),
      `${c.stability.toFixed(1)} d`,
      `${c.daysSinceReview} d ago`,
      pct(c.baseline, 0),
      pct(c.value, 0),
    ]),
  );

  el('abandoned').innerHTML =
    vm.abandoned.length === 0
      ? '<p>Nothing was dropped: the budget covers every card worth reviewing.</p>'
      : table(
          ['Card', 'Stability', 'Last seen', 'Recall on exam day'],
          /** @type {any[]} */ (vm.abandoned).slice(0, 100).map((c) => [
            c.label || c.cardId,
            `${c.stability.toFixed(1)} d`,
            `${c.daysSinceReview} d ago`,
            pct(c.baseline, 1),
          ]),
        );

  const notes = [...vm.notes];
  if (r.planSimulated !== null) {
    notes.push(
      'Cross-check: sampling review outcomes for this plan gives ' +
        `${r.planSimulated.toFixed(3)} ± ${r.planSimulatedStderr.toFixed(3)}, against the exact ` +
        `value ${r.planned.toFixed(3)}.`,
    );
  }
  el('notes').innerHTML = notes.length
    ? `<ul>${notes.map((n) => `<li>${escape(n)}</li>`).join('')}</ul>`
    : '';

  el('results').hidden = false;
}

/**
 * @param {File} file
 */
async function handleFile(file) {
  try {
    const text = await file.text();
    const loaded = loadCollection(text);
    loadedCards = loaded.cards;
    loadNotes = loaded.notes;
    setStatus(`Loaded ${loaded.cards.length} cards from ${file.name}.`, 'ok');
  } catch (error) {
    loadedCards = null;
    loadNotes = [];
    reportError(error);
  }
}

/** @param {unknown} error */
function reportError(error) {
  if (error instanceof CrestError) {
    setStatus(error.hint ? `${error.message} — ${error.hint}` : error.message, 'error');
  } else {
    setStatus(`Something went wrong: ${/** @type {Error} */ (error).message}`, 'error');
  }
}

function run() {
  try {
    const examInDays = readExamInDays();
    const cards =
      loadedCards ?? synthesiseCollection({ count: 400, seed: 42 });
    const notes = [...loadNotes];
    if (loadedCards === null) {
      notes.push(
        'No file loaded, so this is a synthetic 400-card collection for demonstration. ' +
          'Drop your own CSV above to plan a real one.',
      );
    }
    setStatus(`Planning ${cards.length} cards over ${examInDays} days…`, 'info');

    // Yield once so the status text paints before the solver blocks the thread.
    // A worker would be tidier, but would mean a second file and a message
    // protocol for a computation that takes a couple of seconds.
    window.setTimeout(() => {
      try {
        const { viewModel } = planCollection({
          cards,
          examInDays,
          budgetMinutes: readBudget(),
          startDate: input('start-date').value,
          parameters: readParameters(),
          maxReviews: readWholeNumber('max-reviews', 2, 0, 4),
          trials: readWholeNumber('trials', 800, 0, 20000),
          notes,
        });
        render(viewModel);
        setStatus(
          `Done. Proven to be within ${pct(
            /** @type {any} */ (viewModel.summary).optimalityGap, 2,
          )} of the best possible plan.`,
          'ok',
        );
      } catch (error) {
        reportError(error);
      }
    }, 0);
  } catch (error) {
    reportError(error);
  }
}

export function attach() {
  const today = new Date().toISOString().slice(0, 10);
  input('start-date').value = today;
  input('exam-date').value = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

  el('plan-button').addEventListener('click', run);

  const drop = el('drop');
  const picker = input('file');
  drop.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (file) void handleFile(file);
  });
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('drop--active');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.remove('drop--active');
    });
  }
  drop.addEventListener('drop', (event) => {
    const file = /** @type {DragEvent} */ (event).dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  setStatus('Ready. Plan the built-in demo collection, or drop your own CSV.', 'info');
}

if (typeof document !== 'undefined') attach();
