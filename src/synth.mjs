// @ts-check
/**
 * @file A synthetic collection generator.
 *
 * `crest` needs a real collection to be useful and a plausible one to be
 * demonstrable. Exporting from Anki takes a few minutes and not everyone reading
 * this has a collection at all, so the repository ships a generator instead of a
 * frozen fixture: seeded, reproducible, and parameterised so the shape of the
 * instance can be varied in tests.
 *
 * The generator is built to produce the mix that makes the problem interesting
 * rather than a uniform cloud. Real collections before an exam contain three
 * populations, and a planner that only ever sees one of them is not being tested:
 *
 *   - cards so well established they will survive the exam untouched (these are
 *     where the status quo wastes most of its time),
 *   - cards sitting near their due date, where the timing of a review decides
 *     whether it buys a large stability gain or a small one,
 *   - cards already well past recall, which need either an early review followed
 *     by a late one, or honest abandonment.
 */

import { Fsrs6 } from './fsrs.mjs';
import { makeRng } from './simulate.mjs';
import { CrestError } from './errors.mjs';
import { toCsv } from './csv.mjs';

/**
 * Box-Muller, reusing one uniform stream.
 * @param {() => number} rng
 * @returns {number} standard normal
 */
function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * @param {object} [options]
 * @param {number} [options.count]
 * @param {number} [options.seed]
 * @param {Fsrs6} [options.model]
 * @param {number} [options.logStabilityMean] Natural log of median stability in days.
 * @param {number} [options.logStabilitySigma]
 * @returns {import('./value.mjs').Card[]}
 */
export function synthesiseCollection(options = {}) {
  const {
    count = 400,
    seed = 42,
    model = new Fsrs6(),
    logStabilityMean = Math.log(18),
    logStabilitySigma = 1.35,
  } = options;

  if (!Number.isInteger(count) || count < 1 || count > 200_000) {
    throw new CrestError(`count must be a whole number in [1, 200000], got ${count}.`);
  }
  const rng = makeRng(seed);
  /** @type {import('./value.mjs').Card[]} */
  const cards = [];

  for (let i = 0; i < count; i += 1) {
    const stability = Math.min(
      Math.max(Math.exp(logStabilityMean + logStabilitySigma * gaussian(rng)), 0.2),
      1500,
    );
    // Difficulty concentrated in the middle of the scale, as observed FSRS
    // difficulty distributions are: extremes are rare.
    const difficulty = Math.min(Math.max(5.4 + 1.6 * gaussian(rng), 1), 10);

    // Place each card somewhere around its own due date. The long right tail is
    // the backlog every real collection carries.
    const interval = model.nextInterval(stability, 0.9);
    const overdueFactor = 0.25 + Math.pow(rng(), 2) * 2.6;
    const daysSinceReview = Math.max(0, Math.round(interval * overdueFactor));

    // Harder cards take longer to answer, which is why time budgets and card
    // counts are not interchangeable.
    const secondsRecall = Math.min(Math.max(5 + difficulty * 1.4 + gaussian(rng) * 2.5, 3), 60);

    cards.push({
      id: `c${String(i + 1).padStart(5, '0')}`,
      stability: Number(stability.toFixed(4)),
      difficulty: Number(difficulty.toFixed(4)),
      daysSinceReview,
      secondsRecall: Number(secondsRecall.toFixed(2)),
      secondsLapse: Number((secondsRecall * 2.5 + 6).toFixed(2)),
      label: `synthetic card ${i + 1}`,
    });
  }
  return cards;
}

/**
 * Render a collection in the CSV shape `loadCollection` reads, so that the demo
 * path and the file path exercise the same loader.
 *
 * @param {readonly import('./value.mjs').Card[]} cards
 * @returns {string}
 */
export function collectionToCsv(cards) {
  /** @type {(string | number)[][]} */
  const rows = [
    ['card_id', 'stability', 'difficulty', 'days_since_review', 'seconds_recall', 'seconds_lapse', 'label'],
  ];
  for (const card of cards) {
    rows.push([
      card.id,
      card.stability,
      card.difficulty,
      card.daysSinceReview,
      card.secondsRecall,
      card.secondsLapse,
      card.label ?? '',
    ]);
  }
  return toCsv(rows);
}
