// @ts-check
/**
 * @file The planner: choose one plan per card, subject to a time budget on every
 * day, maximising expected recall on exam day.
 *
 * ## The problem
 *
 *   maximise    sum_i  V_i(p_i)
 *   subject to  sum_i  cost_i(p_i, d)  <=  budget_d     for every day d
 *               p_i in P                                 for every card i
 *
 * `V_i` and `cost_i` come from `value.mjs`; `P` is the plan family from
 * `plans.mjs`. This is a multidimensional knapsack -- one capacity per day -- and
 * is NP-hard in general, so `crest` does not pretend to solve it exactly at
 * scale. It does something more useful than a silent heuristic: it returns a
 * feasible plan *and a certificate* bounding how far that plan can possibly be
 * from the best one.
 *
 * ## The certificate
 *
 * Relax the day budgets into the objective with multipliers lambda_d >= 0:
 *
 *   L(lambda) = sum_i max_{p in P} [ V_i(p) - sum_d lambda_d cost_i(p, d) ]
 *               + sum_d lambda_d budget_d
 *
 * For any lambda >= 0, L(lambda) >= OPT. The reason is the usual one: take the
 * optimal assignment, which satisfies every budget; each of its terms is no
 * greater than the corresponding inner maximum, and the slack term
 * sum_d lambda_d (budget_d - used_d) is non-negative. So every lambda we try
 * yields a valid upper bound, and the smallest one we find is the tightest.
 *
 * This is why the inner maximisation has to be exact over the whole family: a
 * heuristic inner solve would *understate* L and produce a bound that is not a
 * bound. The family is enumerated and scanned in full, every iteration.
 *
 * Minimising L over lambda is a convex non-smooth problem; subgradient descent
 * with Polyak steps gets close quickly. The gap it reports is a real guarantee,
 * not a convergence diagnostic: a gap of 0.4% means no scheduler whatsoever,
 * given the same memory model and the same plan family, can beat this plan by
 * more than 0.4% of expected recall.
 */

import { CrestError, invariant } from './errors.mjs';
import { buildCardPlanTable } from './plans.mjs';

/**
 * @typedef {object} Assignment
 * @property {string} cardId
 * @property {number} planIndex
 * @property {number[]} planDays
 * @property {number} value     Expected recall at exam under this plan.
 * @property {number} baseline  Expected recall if never reviewed again.
 * @property {number[]} dayCosts Expected seconds, aligned with planDays.
 */

/**
 * @typedef {object} SolveResult
 * @property {Assignment[]} assignments  One per card that was planned.
 * @property {Assignment[]} skipped      Cards fixed to "no review" by the
 *                                       safe-threshold filter.
 * @property {number} primalValue  Expected number of cards recalled at exam.
 * @property {number} dualBound    Provable ceiling on that number.
 * @property {number} gap          (dual - primal) / max(1, dual), in [0, 1].
 * @property {number} baselineValue Expected recall if nothing is reviewed.
 * @property {number[]} usedSeconds Expected load per day under the chosen plan.
 * @property {number[]} budgets     The per-day budgets, in seconds.
 * @property {number[]} lambda      Multipliers at the tightest bound found; the
 *                                  shadow price of a second on each day.
 * @property {number} iterations
 * @property {number} maxPrunedMass Largest probability mass left unexpanded by
 *                                  any valuation (0 when exact).
 */

/**
 * Solve the planning problem.
 *
 * @param {object} options
 * @param {readonly import('./value.mjs').Card[]} options.cards
 * @param {import('./value.mjs').Valuer} options.valuer
 * @param {readonly number[][]} options.plans
 * @param {readonly number[]} options.budgetsSeconds One entry per study day.
 * @param {number} [options.safeThreshold] Cards whose do-nothing recall
 *   probability already meets this are fixed to "no review". They are the
 *   single biggest source of wasted study time before an exam, and excluding
 *   them also keeps the plan family small. Set 1 to consider every card.
 * @param {number} [options.iterations] Subgradient iterations.
 * @param {number} [options.localPasses] Coordinate-ascent passes in the repair.
 * @param {(progress: {phase: string, done: number, total: number}) => void} [options.onProgress]
 * @returns {SolveResult}
 */
export function solve({
  cards,
  valuer,
  plans,
  budgetsSeconds,
  safeThreshold = 0.98,
  iterations = 60,
  localPasses = 8,
  onProgress,
}) {
  if (!Array.isArray(cards)) throw new CrestError('cards must be an array.');
  if (cards.length === 0) {
    throw new CrestError('no cards to plan.', {
      hint: 'Check the CSV actually parsed, or run `crest demo` to see the expected shape.',
    });
  }
  const days = valuer.examInDays;
  if (budgetsSeconds.length !== days) {
    throw new CrestError(
      `expected ${days} daily budgets (one per study day before the exam), got ${budgetsSeconds.length}.`,
    );
  }
  for (let d = 0; d < days; d += 1) {
    const b = budgetsSeconds[d];
    if (typeof b !== 'number' || !Number.isFinite(b) || b < 0) {
      throw new CrestError(`budget for day ${d} must be a finite number >= 0, got ${b}.`);
    }
  }
  if (!(safeThreshold > 0 && safeThreshold <= 1)) {
    throw new CrestError(`safeThreshold must be in (0, 1], got ${safeThreshold}.`);
  }

  // ---- Partition: cards that are already safe get no reviews, by construction.
  /** @type {import('./value.mjs').Card[]} */
  const active = [];
  /** @type {Assignment[]} */
  const skipped = [];
  let fixedValue = 0;
  let baselineTotal = 0;
  for (const card of cards) {
    const baseline = valuer.baselineValue(card);
    baselineTotal += baseline;
    if (baseline >= safeThreshold) {
      fixedValue += baseline;
      skipped.push({
        cardId: card.id,
        planIndex: 0,
        planDays: [],
        value: baseline,
        baseline,
        dayCosts: [],
      });
    } else {
      active.push(card);
    }
  }

  if (active.length === 0) {
    // Everything is already safe. This is a legitimate answer, not an error:
    // the correct plan is to study nothing.
    return {
      assignments: [],
      skipped,
      primalValue: fixedValue,
      dualBound: fixedValue,
      gap: 0,
      baselineValue: baselineTotal,
      usedSeconds: new Array(days).fill(0),
      budgets: Array.from(budgetsSeconds),
      lambda: new Array(days).fill(0),
      iterations: 0,
      maxPrunedMass: 0,
    };
  }

  // ---- Value every plan for every active card. This dominates the runtime.
  /** @type {import('./plans.mjs').CardPlanTable[]} */
  const tables = [];
  let maxPrunedMass = 0;
  for (let i = 0; i < active.length; i += 1) {
    const table = buildCardPlanTable(valuer, active[i], plans);
    tables.push(table);
    maxPrunedMass = Math.max(maxPrunedMass, table.prunedMass);
    if (onProgress && (i % 25 === 0 || i === active.length - 1)) {
      onProgress({ phase: 'valuing', done: i + 1, total: active.length });
    }
  }

  const n = tables.length;
  const numPlans = plans.length;
  /** Total seconds a plan costs, summed over its days -- used by the density seed. */
  const totalCost = tables.map((t) => {
    const out = new Float64Array(numPlans);
    for (let p = 0; p < numPlans; p += 1) {
      let sum = 0;
      for (let j = 0; j < plans[p].length; j += 1) sum += t.dayCosts[p * t.stride + j];
      out[p] = sum;
    }
    return out;
  });

  // ---- Primal seed 1: greedy by value density, ignoring lambda.
  const densityPreferred = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    let bestP = 0;
    let bestDensity = -Infinity;
    for (let p = 1; p < numPlans; p += 1) {
      const gain = tables[i].values[p] - tables[i].baseline;
      if (gain <= 0) continue;
      const density = gain / (totalCost[i][p] + 1e-9);
      if (density > bestDensity) {
        bestDensity = density;
        bestP = p;
      }
    }
    densityPreferred[i] = bestP;
  }
  let best = repair({ tables, plans, budgetsSeconds, preferred: densityPreferred, localPasses });

  // ---- Lagrangian subgradient descent.
  const lambda = new Float64Array(days);
  let bestLambda = Float64Array.from(lambda);
  let dualBound = Infinity;
  const preferred = new Int32Array(n);
  const used = new Float64Array(days);
  let beta = 2.0;
  let sinceImprovement = 0;
  let performed = 0;

  for (let it = 0; it < iterations; it += 1) {
    performed = it + 1;
    used.fill(0);
    let innerTotal = 0;

    for (let i = 0; i < n; i += 1) {
      const t = tables[i];
      let bestScore = -Infinity;
      let bestP = 0;
      for (let p = 0; p < numPlans; p += 1) {
        const plan = plans[p];
        let penalty = 0;
        const base = p * t.stride;
        for (let j = 0; j < plan.length; j += 1) {
          penalty += lambda[plan[j]] * t.dayCosts[base + j];
        }
        const score = t.values[p] - penalty;
        if (score > bestScore) {
          bestScore = score;
          bestP = p;
        }
      }
      preferred[i] = bestP;
      innerTotal += bestScore;
      const plan = plans[bestP];
      const base = bestP * t.stride;
      for (let j = 0; j < plan.length; j += 1) {
        used[plan[j]] += t.dayCosts[base + j];
      }
    }

    let budgetTerm = 0;
    for (let d = 0; d < days; d += 1) budgetTerm += lambda[d] * budgetsSeconds[d];
    const L = innerTotal + budgetTerm + fixedValue;

    if (L < dualBound - 1e-12) {
      dualBound = L;
      bestLambda = Float64Array.from(lambda);
      sinceImprovement = 0;
    } else {
      sinceImprovement += 1;
      if (sinceImprovement >= 5) {
        beta = Math.max(beta / 2, 0.02);
        sinceImprovement = 0;
      }
    }

    // The lambda-preferred assignment is usually infeasible; repairing it into a
    // feasible plan is what produces the primal side of the gap. Repair is the
    // more expensive of the two halves, and consecutive iterations propose nearly
    // identical assignments, so it runs periodically rather than every iteration.
    // The last iteration always repairs, since that is where lambda best reflects
    // which days are actually scarce.
    const shouldRepair = it % 5 === 0 || it === iterations - 1;
    if (shouldRepair) {
      const candidate = repair({ tables, plans, budgetsSeconds, preferred, localPasses });
      if (candidate.primalValue > best.primalValue) best = candidate;
    }

    // Subgradient of L in lambda_d, and a Polyak step towards the known primal.
    let normSq = 0;
    for (let d = 0; d < days; d += 1) {
      const g = budgetsSeconds[d] - used[d];
      normSq += g * g;
    }
    if (normSq <= 1e-18) {
      // The lambda-solution saturates every budget exactly, so there is no
      // subgradient to follow. Take one last repair from this lambda before
      // leaving, since it is the best-informed one available.
      if (!shouldRepair) {
        const candidate = repair({ tables, plans, budgetsSeconds, preferred, localPasses });
        if (candidate.primalValue > best.primalValue) best = candidate;
      }
      break;
    }
    const target = best.primalValue + fixedValue;
    const step = (beta * Math.max(L - target, 1e-9)) / normSq;
    for (let d = 0; d < days; d += 1) {
      const g = budgetsSeconds[d] - used[d];
      lambda[d] = Math.max(0, lambda[d] - step * g);
    }

    if (onProgress) onProgress({ phase: 'optimising', done: it + 1, total: iterations });
  }

  const primalValue = best.primalValue + fixedValue;

  // A relaxation bound that came out below an achieved value would mean the
  // bound derivation or the feasibility check is wrong. Either way the numbers
  // must not be reported.
  invariant(
    dualBound >= primalValue - 1e-6,
    'dual bound fell below an achieved feasible value',
    { dualBound, primalValue },
  );

  /** @type {Assignment[]} */
  const assignments = [];
  for (let i = 0; i < n; i += 1) {
    const p = best.choice[i];
    const plan = plans[p];
    const t = tables[i];
    const base = p * t.stride;
    assignments.push({
      cardId: t.card.id,
      planIndex: p,
      planDays: plan.slice(),
      value: t.values[p],
      baseline: t.baseline,
      dayCosts: plan.map((_, j) => t.dayCosts[base + j]),
    });
  }

  const cappedDual = Math.min(dualBound, cards.length);
  return {
    assignments,
    skipped,
    primalValue,
    dualBound: cappedDual,
    gap: Math.max(0, (cappedDual - primalValue) / Math.max(1, cappedDual)),
    baselineValue: baselineTotal,
    usedSeconds: Array.from(best.used),
    budgets: Array.from(budgetsSeconds),
    lambda: Array.from(bestLambda),
    iterations: performed,
    maxPrunedMass,
  };
}

/**
 * Turn a (probably infeasible) preferred-plan vector into a feasible assignment,
 * then improve it by coordinate ascent.
 *
 * Coordinate ascent here means: take one card's plan out of the schedule, pick
 * the best plan that fits in the budget that is now free, put it back. Repeat
 * over all cards until a pass changes nothing. Every accepted move strictly
 * increases the objective and the objective is bounded above by the card count,
 * so this terminates; `localPasses` caps the wall-clock cost rather than
 * guaranteeing termination.
 *
 * @param {object} options
 * @param {import('./plans.mjs').CardPlanTable[]} options.tables
 * @param {readonly number[][]} options.plans
 * @param {readonly number[]} options.budgetsSeconds
 * @param {Int32Array} options.preferred
 * @param {number} options.localPasses
 * @returns {{choice: Int32Array, used: Float64Array, primalValue: number}}
 */
function repair({ tables, plans, budgetsSeconds, preferred, localPasses }) {
  const n = tables.length;
  const days = budgetsSeconds.length;
  const numPlans = plans.length;
  const choice = new Int32Array(n);
  const used = new Float64Array(days);
  // Epsilon absorbs float drift in the accumulated expected costs so that a plan
  // whose cost equals the remaining budget to within rounding is not rejected.
  const EPS = 1e-9;

  /**
   * @param {number} i
   * @param {number} p
   * @returns {boolean}
   */
  const fits = (i, p) => {
    const t = tables[i];
    const plan = plans[p];
    const base = p * t.stride;
    for (let j = 0; j < plan.length; j += 1) {
      const d = plan[j];
      if (used[d] + t.dayCosts[base + j] > budgetsSeconds[d] + EPS) return false;
    }
    return true;
  };

  /**
   * @param {number} i
   * @param {number} p
   * @param {1 | -1} sign
   */
  const apply = (i, p, sign) => {
    const t = tables[i];
    const plan = plans[p];
    const base = p * t.stride;
    for (let j = 0; j < plan.length; j += 1) {
      used[plan[j]] += sign * t.dayCosts[base + j];
    }
  };

  // Biggest potential gain first: a card that stands to gain 0.5 expected recall
  // should get its preferred slot before one that stands to gain 0.01.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const ga = tables[a].values[preferred[a]] - tables[a].baseline;
    const gb = tables[b].values[preferred[b]] - tables[b].baseline;
    return gb - ga;
  });

  for (const i of order) {
    const want = preferred[i];
    if (want !== 0 && fits(i, want)) {
      choice[i] = want;
      apply(i, want, 1);
      continue;
    }
    let bestP = 0;
    let bestValue = tables[i].values[0];
    for (let p = 1; p < numPlans; p += 1) {
      if (tables[i].values[p] <= bestValue) continue;
      if (!fits(i, p)) continue;
      bestValue = tables[i].values[p];
      bestP = p;
    }
    choice[i] = bestP;
    if (bestP !== 0) apply(i, bestP, 1);
  }

  for (let pass = 0; pass < localPasses; pass += 1) {
    let improved = false;
    for (let i = 0; i < n; i += 1) {
      const currentP = choice[i];
      apply(i, currentP, -1);
      let bestP = currentP;
      let bestValue = tables[i].values[currentP];
      for (let p = 0; p < numPlans; p += 1) {
        if (p === currentP) continue;
        if (tables[i].values[p] <= bestValue + 1e-12) continue;
        if (!fits(i, p)) continue;
        bestValue = tables[i].values[p];
        bestP = p;
      }
      apply(i, bestP, 1);
      choice[i] = bestP;
      if (bestP !== currentP) improved = true;
    }
    if (!improved) break;
  }

  let primalValue = 0;
  for (let i = 0; i < n; i += 1) primalValue += tables[i].values[choice[i]];

  for (let d = 0; d < days; d += 1) {
    invariant(
      used[d] <= budgetsSeconds[d] + 1e-6,
      'repaired assignment exceeded a daily budget',
      { day: d, used: used[d], budget: budgetsSeconds[d] },
    );
  }
  return { choice, used, primalValue };
}
