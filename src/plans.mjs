// @ts-check
/**
 * @file The plan family, and the per-card value/cost tables built over it.
 *
 * The plan family is every subset of the available study days of size at most
 * `maxReviews`, including the empty plan. It is shared by every card, so it is
 * enumerated once and indexed by integer thereafter.
 *
 * Capping reviews-per-card at a small K is a *declared part of the problem*, not
 * an approximation that gets glossed over: every bound `crest` reports is a
 * bound on the best achievable plan within this family. That distinction is what
 * lets the optimality certificate in `solver.mjs` be honest. Three reviews of
 * one card inside a typical exam horizon is already generous -- the fourth
 * review of a card is almost always worth less than the first review of some
 * other card -- but the cap is a flag, and raising it widens the family that the
 * certificate covers.
 */

import { CrestError, invariant } from './errors.mjs';

/**
 * Hard ceiling on the number of plans, to turn a combinatorial blow-up into an
 * immediate, explained refusal rather than an out-of-memory kill 40 seconds in.
 */
export const MAX_PLANS = 200000;

/**
 * Enumerate every plan: all subsets of {0, ..., examInDays - 1} with size in
 * [0, maxReviews]. Ordered by size, then lexicographically, so that index 0 is
 * always the empty plan.
 *
 * @param {number} examInDays
 * @param {number} maxReviews
 * @returns {number[][]}
 */
export function enumeratePlans(examInDays, maxReviews) {
  if (!Number.isInteger(examInDays) || examInDays < 1) {
    throw new CrestError(`examInDays must be a whole number >= 1, got ${examInDays}.`);
  }
  if (!Number.isInteger(maxReviews) || maxReviews < 0) {
    throw new CrestError(`maxReviews must be a whole number >= 0, got ${maxReviews}.`);
  }
  const k = Math.min(maxReviews, examInDays);
  const total = countPlans(examInDays, k);
  if (total > MAX_PLANS) {
    throw new CrestError(
      `plan family would hold ${total.toLocaleString('en-US')} plans ` +
        `(${examInDays} study days, up to ${maxReviews} reviews per card), ` +
        `above the ${MAX_PLANS.toLocaleString('en-US')} ceiling.`,
      {
        hint:
          'Lower --max-reviews (2 is usually enough for horizons under a month), ' +
          'or shorten the horizon. The family grows as C(days, maxReviews).',
      },
    );
  }

  /** @type {number[][]} */
  const plans = [[]];
  /** @type {number[]} */
  const current = [];
  /**
   * @param {number} start
   * @param {number} remaining
   */
  const recurse = (start, remaining) => {
    if (remaining === 0) return;
    for (let day = start; day < examInDays; day += 1) {
      current.push(day);
      plans.push(current.slice());
      recurse(day + 1, remaining - 1);
      current.pop();
    }
  };
  recurse(0, k);

  invariant(plans.length === total, 'plan enumeration disagreed with its own count', {
    enumerated: plans.length,
    counted: total,
  });
  return plans;
}

/**
 * sum_{j=0..k} C(n, j), computed without factorials so it stays exact for the
 * sizes we allow.
 *
 * @param {number} n
 * @param {number} k
 * @returns {number}
 */
export function countPlans(n, k) {
  let total = 0;
  let binomial = 1;
  for (let j = 0; j <= Math.min(k, n); j += 1) {
    total += binomial;
    binomial = (binomial * (n - j)) / (j + 1);
    if (total > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
  }
  return Math.round(total);
}

/**
 * Per-card tables over the shared plan family.
 *
 * `dayCosts` is flattened: the cost of plan `p` on its `j`-th day lives at
 * `p * stride + j`, where `stride` is the largest plan length. Plans shorter
 * than `stride` leave the tail unused. A flat Float64Array rather than nested
 * arrays because the solver's inner loop touches this once per card per plan per
 * iteration, and the array-of-arrays version spent more time chasing pointers
 * than doing arithmetic.
 *
 * @typedef {object} CardPlanTable
 * @property {import('./value.mjs').Card} card
 * @property {Float64Array} values    Expected recall at exam, per plan index.
 * @property {Float64Array} dayCosts  Expected seconds, flattened as above.
 * @property {number} stride
 * @property {number} baseline        Value of the empty plan (do nothing).
 * @property {number} prunedMass      Largest pruned mass over all this card's plans.
 */

/**
 * Value every plan for one card.
 *
 * @param {import('./value.mjs').Valuer} valuer
 * @param {import('./value.mjs').Card} card
 * @param {readonly number[][]} plans
 * @returns {CardPlanTable}
 */
export function buildCardPlanTable(valuer, card, plans) {
  let stride = 0;
  for (const plan of plans) stride = Math.max(stride, plan.length);
  const values = new Float64Array(plans.length);
  const dayCosts = new Float64Array(plans.length * Math.max(stride, 1));
  let prunedMass = 0;

  for (let p = 0; p < plans.length; p += 1) {
    const { value, dayCosts: costs, prunedMass: pruned } = valuer.valuePlan(card, plans[p]);
    values[p] = value;
    prunedMass = Math.max(prunedMass, pruned);
    const base = p * Math.max(stride, 1);
    for (let j = 0; j < costs.length; j += 1) {
      dayCosts[base + j] = costs[j];
    }
  }

  invariant(plans.length > 0 && plans[0].length === 0, 'plan index 0 must be the empty plan');
  return {
    card,
    values,
    dayCosts,
    stride: Math.max(stride, 1),
    baseline: values[0],
    prunedMass,
  };
}
