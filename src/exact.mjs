// @ts-check
/**
 * @file Brute-force optimal solver, for verification only.
 *
 * Enumerates every combination of per-card plans, keeps the feasible ones and
 * returns the best. The search is exponential in the number of cards, so this is
 * not a production path -- it exists so that `test/solver.test.mjs` can check the
 * Lagrangian solver against ground truth on instances small enough to settle
 * exactly.
 *
 * Without this, the optimality gap would be self-reported by the same code that
 * produces the plan, which is no check at all. Here the gap is verified against
 * an answer derived independently: on every tested instance the true optimum must
 * lie inside [primal, dual].
 */

import { CrestError, invariant } from './errors.mjs';
import { buildCardPlanTable } from './plans.mjs';

/**
 * @param {object} options
 * @param {readonly import('./value.mjs').Card[]} options.cards
 * @param {import('./value.mjs').Valuer} options.valuer
 * @param {readonly number[][]} options.plans
 * @param {readonly number[]} options.budgetsSeconds
 * @param {number} [options.nodeLimit] Refuse rather than hang.
 * @returns {{value: number, choice: number[], nodes: number}}
 */
export function solveExact({ cards, valuer, plans, budgetsSeconds, nodeLimit = 5_000_000 }) {
  const estimate = Math.pow(plans.length, cards.length);
  if (!Number.isFinite(estimate) || estimate > nodeLimit * 50) {
    throw new CrestError(
      `brute force would explore about ${plans.length}^${cards.length} combinations. ` +
        'This solver is for verification on small instances only.',
      { hint: 'Use solve() from solver.mjs, which returns a bound instead of an exact answer.' },
    );
  }

  const tables = cards.map((card) => buildCardPlanTable(valuer, card, plans));
  const n = tables.length;
  const days = budgetsSeconds.length;
  const numPlans = plans.length;

  // Optimistic completion: the best any suffix of cards could contribute if
  // budgets were infinite. Used to prune branches that cannot catch up.
  const suffixBest = new Float64Array(n + 1);
  for (let i = n - 1; i >= 0; i -= 1) {
    let m = -Infinity;
    for (let p = 0; p < numPlans; p += 1) m = Math.max(m, tables[i].values[p]);
    suffixBest[i] = suffixBest[i + 1] + m;
  }

  const used = new Float64Array(days);
  const choice = new Int32Array(n);
  /** @type {number[]} */
  let bestChoice = new Array(n).fill(0);
  let bestValue = -Infinity;
  let nodes = 0;

  /**
   * @param {number} i
   * @param {number} accumulated
   */
  const recurse = (i, accumulated) => {
    nodes += 1;
    if (nodes > nodeLimit) {
      throw new CrestError(`brute force exceeded its node limit of ${nodeLimit}.`);
    }
    if (i === n) {
      if (accumulated > bestValue) {
        bestValue = accumulated;
        bestChoice = Array.from(choice);
      }
      return;
    }
    if (accumulated + suffixBest[i] <= bestValue) return;

    const t = tables[i];
    for (let p = 0; p < numPlans; p += 1) {
      const plan = plans[p];
      const base = p * t.stride;
      let feasible = true;
      for (let j = 0; j < plan.length; j += 1) {
        if (used[plan[j]] + t.dayCosts[base + j] > budgetsSeconds[plan[j]] + 1e-9) {
          feasible = false;
          break;
        }
      }
      if (!feasible) continue;
      for (let j = 0; j < plan.length; j += 1) used[plan[j]] += t.dayCosts[base + j];
      choice[i] = p;
      recurse(i + 1, accumulated + t.values[p]);
      for (let j = 0; j < plan.length; j += 1) used[plan[j]] -= t.dayCosts[base + j];
    }
  };

  recurse(0, 0);
  invariant(bestValue > -Infinity, 'brute force found no feasible assignment', {
    note: 'the all-empty assignment is always feasible, so this is a bug',
  });
  return { value: bestValue, choice: bestChoice, nodes };
}
