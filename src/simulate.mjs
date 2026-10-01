// @ts-check
/**
 * @file Monte-Carlo simulation, for two purposes.
 *
 * 1. **Cross-validation.** `simulateFixedPlans` samples review outcomes for a
 *    plan that `value.mjs` already valued exactly. The two numbers must agree to
 *    within sampling error. This is the main defence against the exact
 *    enumeration quietly mis-weighting a branch: the simulator shares the
 *    transition function but reaches the answer by a completely different route,
 *    so an error in the tree bookkeeping shows up as a disagreement.
 *
 * 2. **An honest baseline.** `simulateAnkiPolicy` plays out what actually happens
 *    today: review whatever FSRS says is due, oldest first, until the day's time
 *    runs out; anything left over becomes backlog. That policy is *adaptive* --
 *    the next due date depends on how the last review went -- so it is not a
 *    fixed plan and cannot be valued by the exact enumeration. Simulation is the
 *    only fair way to compare, and it is also the only way to account for the
 *    budget coupling between cards.
 *
 * Both estimators accumulate the final recall *probability* rather than sampling
 * a final coin flip. They target the same quantity with strictly lower variance,
 * which matters because the differences being measured are a few percent.
 */

import { Rating } from './fsrs.mjs';
import { CrestError } from './errors.mjs';

/**
 * mulberry32. Chosen for being four lines long, dependency-free and good enough:
 * the quantity being estimated is a mean over thousands of independent draws,
 * not a cryptographic secret.
 *
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function makeRng(seed) {
  if (!Number.isInteger(seed)) {
    throw new CrestError(`seed must be an integer, got ${JSON.stringify(seed)}.`);
  }
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {object} SimulationResult
 * @property {number} mean       Expected cards recalled at exam.
 * @property {number} stderr     Standard error of `mean`.
 * @property {number} trials
 * @property {number[]} meanSecondsPerDay Realised study load, averaged over trials.
 * @property {number} meanReviews Average total reviews performed per trial.
 */

/**
 * Draw a rating from the outcome distribution at retrievability `r`.
 *
 * @param {import('./value.mjs').Valuer} valuer
 * @param {number} r
 * @param {() => number} rng
 * @returns {number}
 */
export function sampleRating(valuer, r, rng) {
  const u = rng();
  let acc = 0;
  const branches = valuer.ratingBranches(r);
  for (const [rating, p] of branches) {
    acc += p;
    if (u < acc) return rating;
  }
  // Floating-point shortfall on the last bucket; the final branch is correct.
  return branches[branches.length - 1][0];
}

/**
 * @param {number[]} samples
 * @returns {{mean: number, stderr: number}}
 */
function summarise(samples) {
  const n = samples.length;
  if (n === 0) return { mean: 0, stderr: 0 };
  let mean = 0;
  for (const s of samples) mean += s;
  mean /= n;
  if (n === 1) return { mean, stderr: 0 };
  let varSum = 0;
  for (const s of samples) varSum += (s - mean) ** 2;
  return { mean, stderr: Math.sqrt(varSum / (n - 1) / n) };
}

/**
 * Simulate a fixed, non-adaptive plan per card.
 *
 * @param {object} options
 * @param {readonly import('./value.mjs').Card[]} options.cards
 * @param {Map<string, number[]>} options.planByCardId Cards absent from the map
 *   are never reviewed.
 * @param {import('./value.mjs').Valuer} options.valuer
 * @param {number} [options.trials]
 * @param {number} [options.seed]
 * @returns {SimulationResult}
 */
export function simulateFixedPlans({ cards, planByCardId, valuer, trials = 2000, seed = 1 }) {
  if (!Number.isInteger(trials) || trials < 1) {
    throw new CrestError(`trials must be a whole number >= 1, got ${trials}.`);
  }
  const rng = makeRng(seed);
  const days = valuer.examInDays;
  /** @type {number[]} */
  const totals = [];
  const secondsPerDay = new Array(days).fill(0);
  let reviewCount = 0;

  for (let trial = 0; trial < trials; trial += 1) {
    let total = 0;
    for (const card of cards) {
      const plan = planByCardId.get(card.id) ?? [];
      let s = card.stability;
      let d = card.difficulty;
      let lastReviewDay = -card.daysSinceReview;
      for (const day of plan) {
        const elapsed = day - lastReviewDay;
        const r = valuer.model.retrievability(s, elapsed);
        const rating = sampleRating(valuer, r, rng);
        secondsPerDay[day] +=
          rating === Rating.Again ? card.secondsLapse : card.secondsRecall;
        reviewCount += 1;
        const next = valuer.transition(s, d, r, rating, elapsed < 1);
        s = next.stability;
        d = next.difficulty;
        lastReviewDay = day;
      }
      total += valuer.model.retrievability(s, days - lastReviewDay);
    }
    totals.push(total);
  }

  const { mean, stderr } = summarise(totals);
  return {
    mean,
    stderr,
    trials,
    meanSecondsPerDay: secondsPerDay.map((v) => v / trials),
    meanReviews: reviewCount / trials,
  };
}

/**
 * Simulate the policy a student follows today: study what FSRS says is due,
 * most-overdue first, until the day's time is gone.
 *
 * This is deliberately charitable to the status quo. It respects the same daily
 * budgets `crest` is given, it carries a backlog forward rather than dropping it,
 * and it uses the same memory model and the same behavioural prior. The only
 * difference is the decision rule -- which is the thing under test.
 *
 * @param {object} options
 * @param {readonly import('./value.mjs').Card[]} options.cards
 * @param {import('./value.mjs').Valuer} options.valuer
 * @param {readonly number[]} options.budgetsSeconds
 * @param {number} [options.desiredRetention] The FSRS setting that decides when
 *   a card is "due". 0.9 is Anki's default.
 * @param {number} [options.trials]
 * @param {number} [options.seed]
 * @returns {SimulationResult}
 */
export function simulateAnkiPolicy({
  cards,
  valuer,
  budgetsSeconds,
  desiredRetention = 0.9,
  trials = 2000,
  seed = 1,
}) {
  const days = valuer.examInDays;
  if (budgetsSeconds.length !== days) {
    throw new CrestError(
      `expected ${days} daily budgets, got ${budgetsSeconds.length}.`,
    );
  }
  if (!Number.isInteger(trials) || trials < 1) {
    throw new CrestError(`trials must be a whole number >= 1, got ${trials}.`);
  }
  const rng = makeRng(seed);
  const model = valuer.model;
  /** @type {number[]} */
  const totals = [];
  const secondsPerDay = new Array(days).fill(0);
  let reviewCount = 0;

  for (let trial = 0; trial < trials; trial += 1) {
    const state = cards.map((card) => {
      const lastReviewDay = -card.daysSinceReview;
      return {
        card,
        stability: card.stability,
        difficulty: card.difficulty,
        lastReviewDay,
        dueDay: lastReviewDay + model.nextInterval(card.stability, desiredRetention),
      };
    });

    for (let day = 0; day < days; day += 1) {
      const budget = budgetsSeconds[day];
      if (budget <= 0) continue;
      // Anki's default review order is by due date. Index breaks ties so a run
      // is reproducible from the seed alone.
      const queue = state
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.dueDay <= day)
        .sort((a, b) => a.entry.dueDay - b.entry.dueDay || a.index - b.index);

      let spent = 0;
      for (const { entry } of queue) {
        const elapsed = day - entry.lastReviewDay;
        const r = model.retrievability(entry.stability, elapsed);
        // A student with a timer decides whether to start a card from its typical
        // cost, not from the outcome they cannot yet know.
        const expected =
          r * entry.card.secondsRecall + (1 - r) * entry.card.secondsLapse;
        if (spent + expected > budget) break;

        const rating = sampleRating(valuer, r, rng);
        const actual =
          rating === Rating.Again ? entry.card.secondsLapse : entry.card.secondsRecall;
        spent += actual;
        secondsPerDay[day] += actual;
        reviewCount += 1;

        const next = valuer.transition(
          entry.stability, entry.difficulty, r, rating, elapsed < 1,
        );
        entry.stability = next.stability;
        entry.difficulty = next.difficulty;
        entry.lastReviewDay = day;
        entry.dueDay = day + model.nextInterval(entry.stability, desiredRetention);
      }
    }

    let total = 0;
    for (const entry of state) {
      total += model.retrievability(entry.stability, days - entry.lastReviewDay);
    }
    totals.push(total);
  }

  const { mean, stderr } = summarise(totals);
  return {
    mean,
    stderr,
    trials,
    meanSecondsPerDay: secondsPerDay.map((v) => v / trials),
    meanReviews: reviewCount / trials,
  };
}
