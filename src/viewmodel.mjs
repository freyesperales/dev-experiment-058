// @ts-check
/**
 * @file Turn a solver result into the structure every output format renders.
 *
 * This module is pure: data in, data out, no I/O and no DOM. The CLI's text and
 * JSON writers and the browser app all consume it, which is what lets the browser
 * app be covered by the test suite -- everything except `document` calls lives
 * here and is tested directly.
 *
 * It also derives the three facts a student actually wants, none of which the
 * solver states directly:
 *
 *   - which cards are already safe and should be left alone,
 *   - which cards the budget cannot save, so they can be dropped deliberately
 *     rather than discovered unlearned during the exam,
 *   - what a day is worth at the margin: `lambda` is the shadow price of a second,
 *     so `lambda * 60` answers "if I could find one more hour, which day should it
 *     go to, and how many extra cards would it buy".
 */

import { CrestError } from './errors.mjs';

/**
 * @param {string} isoDate `YYYY-MM-DD`
 * @param {number} offsetDays
 * @returns {string}
 */
export function addDays(isoDate, offsetDays) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    throw new CrestError(`not an ISO date: ${JSON.stringify(isoDate)}.`, {
      hint: 'Use YYYY-MM-DD.',
    });
  }
  return new Date(ms + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** @type {readonly string[]} */
const WEEKDAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

/**
 * @param {string} isoDate
 * @returns {string}
 */
export function weekdayOf(isoDate) {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new CrestError(`not an ISO date: ${JSON.stringify(isoDate)}.`);
  return WEEKDAYS[new Date(ms).getUTCDay()];
}

/**
 * @typedef {object} ViewModel
 * @property {object} summary
 * @property {object[]} days
 * @property {object[]} perCard
 * @property {object[]} abandoned
 * @property {object[]} safe
 * @property {string[]} notes
 */

/**
 * @param {object} options
 * @param {readonly import('./value.mjs').Card[]} options.cards
 * @param {import('./solver.mjs').SolveResult} options.result
 * @param {number} options.examInDays
 * @param {string} options.startDate ISO date of day 0.
 * @param {import('./simulate.mjs').SimulationResult} [options.ankiBaseline]
 * @param {import('./simulate.mjs').SimulationResult} [options.planCheck]
 * @param {string[]} [options.notes]
 * @returns {ViewModel}
 */
export function buildViewModel({
  cards,
  result,
  examInDays,
  startDate,
  ankiBaseline,
  planCheck,
  notes = [],
}) {
  const byId = new Map(cards.map((c) => [c.id, c]));

  // ---- Per-day aggregation.
  const perDayCards = new Array(examInDays).fill(0);
  const perDaySeconds = new Array(examInDays).fill(0);
  let reviewsScheduled = 0;
  for (const assignment of result.assignments) {
    for (let j = 0; j < assignment.planDays.length; j += 1) {
      const day = assignment.planDays[j];
      perDayCards[day] += 1;
      perDaySeconds[day] += assignment.dayCosts[j];
      reviewsScheduled += 1;
    }
  }

  const days = [];
  for (let d = 0; d < examInDays; d += 1) {
    const date = addDays(startDate, d);
    const budget = result.budgets[d];
    days.push({
      day: d,
      date,
      weekday: weekdayOf(date),
      cards: perDayCards[d],
      minutes: perDaySeconds[d] / 60,
      budgetMinutes: budget / 60,
      utilisation: budget > 0 ? perDaySeconds[d] / budget : 0,
      // lambda is per second; a student thinks in minutes and in cards.
      extraCardsPerHour: result.lambda[d] * 3600,
    });
  }

  // ---- Per-card classification.
  /** @type {object[]} */
  const perCard = [];
  /** @type {object[]} */
  const abandoned = [];
  for (const assignment of result.assignments) {
    const card = byId.get(assignment.cardId);
    const row = {
      cardId: assignment.cardId,
      label: card?.label ?? '',
      days: assignment.planDays.slice(),
      dates: assignment.planDays.map((d) => addDays(startDate, d)),
      baseline: assignment.baseline,
      value: assignment.value,
      gain: assignment.value - assignment.baseline,
      stability: card?.stability ?? Number.NaN,
      difficulty: card?.difficulty ?? Number.NaN,
      daysSinceReview: card?.daysSinceReview ?? Number.NaN,
      minutes: assignment.dayCosts.reduce((a, b) => a + b, 0) / 60,
    };
    if (assignment.planDays.length === 0) {
      abandoned.push(row);
    } else {
      perCard.push(row);
    }
  }
  perCard.sort((a, b) => b.gain - a.gain);
  abandoned.sort((a, b) => a.baseline - b.baseline);

  const safe = result.skipped.map((s) => ({
    cardId: s.cardId,
    label: byId.get(s.cardId)?.label ?? '',
    baseline: s.baseline,
  }));

  const totalBudgetSeconds = result.budgets.reduce((a, b) => a + b, 0);
  const totalPlannedSeconds = perDaySeconds.reduce((a, b) => a + b, 0);
  const n = cards.length;

  const summary = {
    cards: n,
    examInDays,
    startDate,
    examDate: addDays(startDate, examInDays),
    cardsSafe: safe.length,
    cardsPlanned: perCard.length,
    cardsAbandoned: abandoned.length,
    reviewsScheduled,
    expectedRecall: {
      doNothing: result.baselineValue,
      planned: result.primalValue,
      upperBound: result.dualBound,
      ankiPolicy: ankiBaseline ? ankiBaseline.mean : null,
      ankiPolicyStderr: ankiBaseline ? ankiBaseline.stderr : null,
      planSimulated: planCheck ? planCheck.mean : null,
      planSimulatedStderr: planCheck ? planCheck.stderr : null,
    },
    expectedRecallShare: {
      doNothing: n > 0 ? result.baselineValue / n : 0,
      planned: n > 0 ? result.primalValue / n : 0,
      upperBound: n > 0 ? result.dualBound / n : 0,
      ankiPolicy: ankiBaseline && n > 0 ? ankiBaseline.mean / n : null,
    },
    gainOverDoNothing: result.primalValue - result.baselineValue,
    gainOverAnkiPolicy: ankiBaseline ? result.primalValue - ankiBaseline.mean : null,
    optimalityGap: result.gap,
    totalBudgetMinutes: totalBudgetSeconds / 60,
    plannedMinutes: totalPlannedSeconds / 60,
    utilisation: totalBudgetSeconds > 0 ? totalPlannedSeconds / totalBudgetSeconds : 0,
    ankiPolicyMinutes: ankiBaseline
      ? ankiBaseline.meanSecondsPerDay.reduce((a, b) => a + b, 0) / 60
      : null,
    solverIterations: result.iterations,
    maxPrunedMass: result.maxPrunedMass,
    // The single most actionable derived number: where an extra hour goes.
    bestDayForAnExtraHour: pickBestMarginalDay(days),
  };

  return { summary, days, perCard, abandoned, safe, notes };
}

/**
 * The day whose budget has the highest marginal value, among days that are
 * actually saturated. An unsaturated day has slack, so extra time there is worth
 * nothing and reporting it would be actively misleading.
 *
 * @param {Array<{day: number, date: string, utilisation: number, extraCardsPerHour: number}>} days
 * @returns {{day: number, date: string, extraCardsPerHour: number} | null}
 */
function pickBestMarginalDay(days) {
  let best = null;
  for (const d of days) {
    if (d.utilisation < 0.995) continue;
    if (d.extraCardsPerHour <= 1e-6) continue;
    if (best === null || d.extraCardsPerHour > best.extraCardsPerHour) {
      best = { day: d.day, date: d.date, extraCardsPerHour: d.extraCardsPerHour };
    }
  }
  return best;
}
