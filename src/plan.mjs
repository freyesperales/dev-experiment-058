// @ts-check
/**
 * @file The one entry point everything else calls: cards + settings -> view model.
 *
 * Kept separate from `cli.mjs` so that the browser app, the tests and the CLI all
 * run the identical pipeline. Nothing here touches the filesystem or the console.
 */

import { Fsrs6, DEFAULT_PARAMETERS } from './fsrs.mjs';
import { Valuer, DEFAULT_GRADE_MIX } from './value.mjs';
import { enumeratePlans } from './plans.mjs';
import { solve } from './solver.mjs';
import { simulateAnkiPolicy, simulateFixedPlans } from './simulate.mjs';
import { buildViewModel } from './viewmodel.mjs';
import { CrestError } from './errors.mjs';

/**
 * Expand a budget specification into one entry per study day.
 *
 * Accepts a single number (same every day) or a list. A list shorter than the
 * horizon repeats, which is what makes a weekly rhythm expressible: seven values
 * cover "weekends are different" for any horizon length.
 *
 * @param {number | readonly number[]} spec Minutes.
 * @param {number} examInDays
 * @returns {number[]} seconds, one per study day
 */
export function expandBudget(spec, examInDays) {
  const list = typeof spec === 'number' ? [spec] : Array.from(spec);
  if (list.length === 0) {
    throw new CrestError('budget must contain at least one value.');
  }
  for (const value of list) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new CrestError(
        `each budget value must be a finite number of minutes >= 0, got ${JSON.stringify(value)}.`,
      );
    }
  }
  const out = new Array(examInDays);
  for (let d = 0; d < examInDays; d += 1) out[d] = list[d % list.length] * 60;
  return out;
}

/**
 * @typedef {object} PlanOptions
 * @property {readonly import('./value.mjs').Card[]} cards
 * @property {number} examInDays
 * @property {number | readonly number[]} budgetMinutes
 * @property {string} [startDate] ISO date of day 0. Defaults to today.
 * @property {readonly number[]} [parameters] FSRS-6 weights.
 * @property {import('./value.mjs').RecallGradeMix} [gradeMix]
 * @property {number} [maxReviews]
 * @property {number} [safeThreshold]
 * @property {number} [relearnSteps]
 * @property {number} [iterations]
 * @property {number} [epsilon]
 * @property {number} [desiredRetention] Only used for the Anki-policy baseline.
 * @property {number} [trials] Monte-Carlo trials; 0 disables both simulations.
 * @property {number} [seed]
 * @property {string[]} [notes]
 * @property {(progress: {phase: string, done: number, total: number}) => void} [onProgress]
 */

/**
 * @param {PlanOptions} options
 * @returns {{viewModel: import('./viewmodel.mjs').ViewModel, result: import('./solver.mjs').SolveResult}}
 */
export function planCollection(options) {
  const {
    cards,
    examInDays,
    budgetMinutes,
    startDate = new Date().toISOString().slice(0, 10),
    parameters = DEFAULT_PARAMETERS,
    gradeMix = DEFAULT_GRADE_MIX,
    maxReviews = 2,
    safeThreshold = 0.98,
    relearnSteps = 1,
    iterations = 60,
    epsilon = 0,
    desiredRetention = 0.9,
    trials = 1500,
    seed = 1,
    notes = [],
    onProgress,
  } = options;

  const model = new Fsrs6(parameters);
  const valuer = new Valuer({ model, examInDays, gradeMix, relearnSteps, epsilon });
  const budgetsSeconds = expandBudget(budgetMinutes, examInDays);
  const plans = enumeratePlans(examInDays, maxReviews);

  const result = solve({
    cards,
    valuer,
    plans,
    budgetsSeconds,
    safeThreshold,
    iterations,
    onProgress,
  });

  /** @type {import('./simulate.mjs').SimulationResult | undefined} */
  let ankiBaseline;
  /** @type {import('./simulate.mjs').SimulationResult | undefined} */
  let planCheck;
  if (trials > 0) {
    if (onProgress) onProgress({ phase: 'simulating', done: 0, total: 2 });
    ankiBaseline = simulateAnkiPolicy({
      cards,
      valuer,
      budgetsSeconds,
      desiredRetention,
      trials,
      seed,
    });
    if (onProgress) onProgress({ phase: 'simulating', done: 1, total: 2 });
    const planByCardId = new Map(
      result.assignments.map((a) => [a.cardId, a.planDays]),
    );
    planCheck = simulateFixedPlans({ cards, planByCardId, valuer, trials, seed: seed + 7919 });
    if (onProgress) onProgress({ phase: 'simulating', done: 2, total: 2 });
  }

  const viewModel = buildViewModel({
    cards,
    result,
    examInDays,
    startDate,
    ankiBaseline,
    planCheck,
    notes,
  });
  return { viewModel, result };
}
